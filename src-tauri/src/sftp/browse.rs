//! 远程目录浏览：`sftp_list` 命令、目录缓存与后台预取。
//!
//! ssh2 是阻塞实现，全部逻辑跑在 blocking 线程里；命中缓存时
//! 一个 RTT 都不用花，未命中才走网络并顺带预热子目录。

use crate::icons;
use crate::ssh::{JumpHop, SshTarget};
use serde::{Deserialize, Serialize};
use std::{
	collections::HashMap,
	path::{Path, PathBuf},
	sync::{
		Arc, Mutex,
		atomic::{AtomicU64, Ordering},
	},
	thread,
	time::Instant,
};
use tauri::State;
use tracing::{info, warn};

use super::pool::{
	CACHE_LIMIT, CACHE_TTL, PREFETCH_LIMIT, CacheEntry, Connection, SftpPool,
	connect, discard, name_of, obtain, remember,
};

/// 前端传入的 SFTP 连接参数。
///
/// 密码由前端用后端 `decrypt` 解开后明文传入，只在内存中使用，不写日志。
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SftpRequest {
	host: String,
	port: Option<u16>,
	username: Option<String>,
	password: Option<String>,
	/// 跳板链（离客户端最近的一跳在前，前端已解开密码）。
	#[serde(default)]
	jump: Vec<JumpHop>,
	/// 设置里的默认私钥路径（与终端 `-i` 一致）。
	#[serde(default)]
	key_path: Option<String>,
	/// 要列出的远程目录；留空表示会话默认目录。
	path: Option<String>,
	/// 手动刷新：跳过目录缓存，强制重新读取。
	#[serde(default)]
	refresh: bool,
}

/// 远程目录条目。字段与本地 `fs_list_dir` 同构，前端可共用同一套渲染。
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteEntry {
	name: String,
	path: String,
	is_dir: bool,
	size: u64,
	/// 修改时间（Unix 秒）
	modified: Option<u64>,
	/// Unix 权限位（含文件类型位）
	perm: Option<u32>,
	/// 所有者名称（查不到时退回 uid 数字）
	owner: Option<String>,
	/// 所属组名称（查不到时退回 gid 数字）
	group: Option<String>,
	/// 图标键：`dir` 或小写扩展名，前端据此在 `icons` 里查系统图标
	icon_key: String,
}

/// 远程目录浏览结果。
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SftpListing {
	path: String,
	parent: Option<String>,
	entries: Vec<RemoteEntry>,
	/// 本次列表用到的系统图标（键 → BMP data URL，同类型只带一张）
	icons: HashMap<String, String>,
}

/// 列出 SFTP 远程目录。
///
/// ssh2 是阻塞实现，放到 blocking 线程里执行，避免卡住 IPC 线程。
#[tauri::command(rename = "sftp_list")]
pub async fn list(
	pool: State<'_, SftpPool>,
	request: SftpRequest,
) -> Result<SftpListing, String> {
	// 池内部是 Arc，clone 一份就能移进 blocking 线程
	let connections = pool.connections.clone();
	let directories = pool.directories.clone();
	let generation = pool.generation.clone();
	tauri::async_runtime::spawn_blocking(move || {
		browse(
			&connections,
			&directories,
			&generation,
			request,
		)
	})
	.await
	.map_err(|error| error.to_string())?
}

/// 读远程目录：先查缓存，未命中才走网络；命中后后台预热子目录。
fn browse(
	connections: &Arc<Mutex<HashMap<String, Arc<Connection>>>>,
	directories: &Arc<Mutex<HashMap<String, CacheEntry>>>,
	generation: &Arc<AtomicU64>,
	request: SftpRequest,
) -> Result<SftpListing, String> {
	let target = SshTarget::new(
		&request.host,
		request.port,
		request.username.as_deref(),
		request.password.as_deref(),
		request.key_path.as_deref(),
		request.jump.clone(),
	)?;
	let remote = request
		.path
		.as_deref()
		.map(str::trim)
		.filter(|value| !value.is_empty())
		.unwrap_or(".")
		.to_string();

	// 用户发起了新浏览：序号自增会让正在跑的预取立刻让路
	let current = generation.fetch_add(1, Ordering::SeqCst) + 1;
	let key = target.key();
	let cache_key = format!("{key}|{remote}");
	// 只记录连接目标与路径，密码绝不进日志
	info!(
		target = %target.describe(),
		jumps = target.jump.len(),
		path = %remote,
		refresh = request.refresh,
		"SFTP 目录请求"
	);

	if !request.refresh {
		if let Some(listing) =
			cached_dir(directories, &cache_key)
		{
			info!(path = %remote, "命中目录缓存");
			return Ok(listing);
		}
	}

	let started = Instant::now();
	let connection = obtain(connections, &target)?;
	// 取连接耗时：命中缓存时接近 0；需要新建时 = TCP + 握手 + 认证 + 开通道
	let obtain_ms = started.elapsed().as_millis();

	let listing = match read_dir(&connection, &remote) {
		Ok(listing) => listing,
		Err(error) => {
			// 缓存连接可能已被服务器断开：丢弃后重连一次再试
			warn!(target = %target.describe(), "SFTP 浏览失败，重连后重试：{error}");
			discard(connections, &key);
			let connection = connect(&target)?;
			let listing = read_dir(&connection, &remote)?;
			remember(connections, &key, connection.clone());
			store_dir(directories, &cache_key, listing.clone());
			spawn_prefetch(
				directories,
				generation,
				connection,
				&key,
				&listing,
				current,
			);
			return Ok(listing);
		}
	};
	info!(
		target = %target.describe(),
		obtain_ms,
		total_ms = started.elapsed().as_millis(),
		entries = listing.entries.len(),
		"SFTP 目录读取完成"
	);
	store_dir(directories, &cache_key, listing.clone());
	spawn_prefetch(
		directories,
		generation,
		connection,
		&key,
		&listing,
		current,
	);
	Ok(listing)
}

/// 后台串行预热当前目录的子目录。
///
/// 跨公网每次 readdir 都是一个 RTT，等用户真双击进去再读就必然要等；
/// 这里趁用户浏览当前目录的空档提前读好。同一条 SSH 连接上的请求是串行的，
/// 所以一旦用户有新操作（`generation` 变化）就立即停止，把连接让回去。
fn spawn_prefetch(
	directories: &Arc<Mutex<HashMap<String, CacheEntry>>>,
	generation: &Arc<AtomicU64>,
	connection: Arc<Connection>,
	connection_key: &str,
	listing: &SftpListing,
	started_at: u64,
) {
	let children: Vec<String> = listing
		.entries
		.iter()
		.filter(|entry| entry.is_dir)
		.take(PREFETCH_LIMIT)
		.map(|entry| entry.path.clone())
		.collect();
	if children.is_empty() {
		return;
	}
	let directories = directories.clone();
	let generation = generation.clone();
	let connection_key = connection_key.to_string();
	thread::spawn(move || {
		for path in children {
			if generation.load(Ordering::SeqCst) != started_at {
				break;
			}
			let cache_key =
				format!("{connection_key}|{path}");
			if cached_dir(&directories, &cache_key)
				.is_some()
			{
				continue;
			}
			match read_dir(&connection, &path) {
				Ok(listing) => store_dir(
					&directories,
					&cache_key,
					listing,
				),
				// 连接可能已断，预取直接放弃，等用户请求时再走重连逻辑
				Err(_) => break,
			}
		}
	});
}

/// 读缓存；过期视为未命中。
fn cached_dir(
	directories: &Arc<Mutex<HashMap<String, CacheEntry>>>,
	key: &str,
) -> Option<SftpListing> {
	let cache = directories
		.lock()
		.unwrap_or_else(|error| error.into_inner());
	let entry = cache.get(key)?;
	if entry.at.elapsed() > CACHE_TTL {
		return None;
	}
	Some(entry.listing.clone())
}

/// 写缓存；超上限时先清过期项，仍满则淘汰最旧的一条。
fn store_dir(
	directories: &Arc<Mutex<HashMap<String, CacheEntry>>>,
	key: &str,
	listing: SftpListing,
) {
	let mut cache = directories
		.lock()
		.unwrap_or_else(|error| error.into_inner());
	if cache.len() >= CACHE_LIMIT {
		cache.retain(|_, entry| entry.at.elapsed() <= CACHE_TTL);
		if cache.len() >= CACHE_LIMIT {
			let oldest = cache
				.iter()
				.min_by_key(|(_, entry)| entry.at)
				.map(|(key, _)| key.clone());
			if let Some(oldest) = oldest {
				cache.remove(&oldest);
			}
		}
	}
	cache.insert(
		key.to_string(),
		CacheEntry {
			listing,
			at: Instant::now(),
		},
	);
}

/// 在已打开的 SFTP 通道上读取目录。
fn read_dir(
	connection: &Connection,
	remote: &str,
) -> Result<SftpListing, String> {
	let sftp = &connection.sftp;
	let requested = PathBuf::from(remote);
	// 前端传的绝对路径（双击进入时就是）直接使用，省掉一次 realpath 往返；
	// 只有首次打开（"." 或相对路径）才需要向服务器要绝对路径。
	let canonical = if requested.is_absolute() {
		requested
	} else {
		sftp.realpath(&requested).unwrap_or(requested)
	};

	let read_started = Instant::now();
	let mut entries = Vec::new();
	for (entry_path, stat) in sftp
		.readdir(&canonical)
		.map_err(|error| format!("读取 {remote} 失败：{error}"))?
	{
		let name = entry_path
			.file_name()
			.map(|value| value.to_string_lossy().into_owned())
			.unwrap_or_default();
		// 跳过空名（readdir 会带上 "." 这类条目）
		if name.is_empty() || name == "." || name == ".." {
			continue;
		}
	entries.push(RemoteEntry {
		icon_key: icons::icon_key(&name, stat.is_dir()),
		name,
		// 远程路径统一用 `/`：readdir 的 PathBuf 是 Windows 宿主拼的，
		// 分隔符会是 `\`，不纠正的话前端拿到的 `/root\.vim` 这类
		// 路径在 Linux 上根本不存在
		path: entry_path
			.to_string_lossy()
			.replace('\\', "/"),
		is_dir: stat.is_dir(),
			size: stat.size.unwrap_or(0),
			modified: stat.mtime,
			perm: stat.perm,
			owner: stat
				.uid
				.map(|uid| name_of(&connection.users, uid)),
			group: stat
				.gid
				.map(|gid| name_of(&connection.groups, gid)),
		});
	}
	let read_ms = read_started.elapsed().as_millis();
	// 与本地一致：目录在前，同类型按名称排序
	entries.sort_by(|a, b| {
		b.is_dir
			.cmp(&a.is_dir)
			.then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase()))
	});
	// 只有根目录自己没有上级；`/root` 这类一级目录的上级就是 `/`，
	// 必须保留（点 ".." 要能回到根目录）。
	let root = Path::new("/");
	let parent = if canonical == root {
		None
	} else {
		canonical
			.parent()
			.map(|parent| parent.to_string_lossy().replace('\\', "/"))
	};
	info!(
		read_ms,
		entries = entries.len(),
		"SFTP 读目录耗时"
	);
	// 图标按 key 去重后一次取好，同类文件共用一张图。
	// 固定带上 dir：列表顶部的 ".." 也要显示文件夹图标，
	// 而某些目录里可能一个子目录都没有。
	let mut keys = vec!["dir".to_string()];
	for entry in &entries {
		keys.push(entry.icon_key.clone());
	}
	Ok(SftpListing {
		path: canonical
			.to_string_lossy()
			.replace('\\', "/"),
		parent,
		entries,
		icons: icons::icons_for(&keys),
	})
}
