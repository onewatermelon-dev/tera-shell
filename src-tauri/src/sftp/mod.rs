pub mod open;
pub mod rename;
pub mod window;

use crate::icons;
use serde::{Deserialize, Serialize};
use ssh2::{KeyboardInteractivePrompt, Prompt, Session, Sftp};
use std::{
	collections::HashMap,
	io::{Read, Write},
	net::{TcpStream, ToSocketAddrs},
	path::{Path, PathBuf},
	sync::{
		Arc, Mutex,
		atomic::{AtomicBool, AtomicU64, Ordering},
	},
	thread,
	time::{Duration, Instant},
};
use tauri::State;
use tracing::{info, warn};

/// 建立 TCP 连接的超时，避免网络不可达时长时间无响应。
const CONNECT_TIMEOUT: Duration = Duration::from_secs(10);

/// 单次会话操作（握手 / 认证 / 读目录）的超时，防止界面一直等。
const SESSION_TIMEOUT_MS: u32 = 20_000;

/// 目录缓存有效期。跨公网的 readdir 一次就要一个 RTT（几百毫秒起），
/// 短时间内重复访问（返回上级、来回切换）直接命中缓存。
const CACHE_TTL: Duration = Duration::from_secs(30);

/// 目录缓存条目上限，防止长时间浏览后内存无限增长。
const CACHE_LIMIT: usize = 256;

/// 每次进入目录后，后台预热多少个子目录。
///
/// 预取会占用连接（同一条 SSH 连接上的请求是串行的），所以数量要小；
/// 用户一旦有新操作就会立刻让路（见 `spawn_prefetch`）。
const PREFETCH_LIMIT: usize = 8;

/// 一条已建立的连接。
///
/// `Sftp` 之外还缓存了 uid/gid → 名称的映射：SFTP 的 `readdir` 只给数字 id，
/// 名字要从 `/etc/passwd`、`/etc/group` 查，连上后读一次即可长期复用。
struct Connection {
	sftp: Arc<Sftp>,
	users: HashMap<u32, String>,
	groups: HashMap<u32, String>,
}

/// 缓存的目录内容。
struct CacheEntry {
	listing: SftpListing,
	at: Instant,
}

/// SFTP 连接池 + 目录缓存，key 为 `username@host:port`。
///
/// 缓存的是**已经打开的 `Sftp` 通道**而不是裸 `Session`：ssh2 0.9 起 `Sftp`
/// 不带生命周期参数，内部持有 `Arc<Mutex<SessionInner>>`，可以脱离局部
/// `Session` 变量长期存活（库已 `unsafe impl Send + Sync for Sftp`）。
#[derive(Default)]
pub struct SftpPool {
	/// 每个目标一条长连接（含已打开的 SFTP 通道与 id 映射）。
	connections: Arc<Mutex<HashMap<String, Arc<Connection>>>>,
	/// 目录缓存，key 为 `username@host:port|远程路径`。
	directories: Arc<Mutex<HashMap<String, CacheEntry>>>,
	/// 用户操作序号：自增即代表"用户又有新动作"，后台预取据此让路。
	generation: Arc<AtomicU64>,
}

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

/// keyboard-interactive 认证的答题器：把保存的密码填给每一个提问。
///
/// 服务器通常只问一次 "Password:"，但某些配置（如带二步验证）会问多次；
/// 这里对每个提问都回答同一个密码，认证失败时由上层给出错误提示。
struct PasswordPrompter {
	password: String,
}

impl KeyboardInteractivePrompt for PasswordPrompter {
	fn prompt<'a>(
		&mut self,
		_username: &str,
		_instructions: &str,
		prompts: &[Prompt<'a>],
	) -> Vec<String> {
		prompts
			.iter()
			.map(|_| self.password.clone())
			.collect()
	}
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
	let host = request.host.trim().to_string();
	if host.is_empty() {
		return Err("会话缺少主机地址".into());
	}
	let port = request.port.unwrap_or(22);
	let username = request
		.username
		.as_deref()
		.map(str::trim)
		.filter(|value| !value.is_empty())
		.unwrap_or("root")
		.to_string();
	let remote = request
		.path
		.as_deref()
		.map(str::trim)
		.filter(|value| !value.is_empty())
		.unwrap_or(".")
		.to_string();
	let password = request
		.password
		.as_deref()
		.map(str::trim)
		.filter(|value| !value.is_empty())
		.map(str::to_string);

	// 用户发起了新浏览：序号自增会让正在跑的预取立刻让路
	let current = generation.fetch_add(1, Ordering::SeqCst) + 1;
	let key = format!("{username}@{host}:{port}");
	let cache_key = format!("{key}|{remote}");
	// 只记录连接目标与路径，密码绝不进日志
	info!(
		host = %host,
		port,
		username = %username,
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
	let connection = obtain(
		connections,
		&key,
		&host,
		port,
		&username,
		password.as_deref(),
	)?;
	// 取连接耗时：命中缓存时接近 0；需要新建时 = TCP + 握手 + 认证 + 开通道
	let obtain_ms = started.elapsed().as_millis();

	let listing = match read_dir(&connection, &remote) {
		Ok(listing) => listing,
		Err(error) => {
			// 缓存连接可能已被服务器断开：丢弃后重连一次再试
			warn!(host = %host, "SFTP 浏览失败，重连后重试：{error}");
			discard(connections, &key);
			let connection = connect(
				&host,
				port,
				&username,
				password.as_deref(),
			)?;
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
		host = %host,
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

/// 取缓存连接；没有缓存时新建并登记。
///
/// 网络 IO 一律在**不持有 connections 锁**的情况下进行，避免一个慢连接
/// 阻塞其它会话。
fn obtain(
	connections: &Arc<Mutex<HashMap<String, Arc<Connection>>>>,
	key: &str,
	host: &str,
	port: u16,
	username: &str,
	password: Option<&str>,
) -> Result<Arc<Connection>, String> {
	if let Some(connection) = cached(connections, key) {
		info!(key, "复用缓存的 SFTP 连接");
		return Ok(connection);
	}
	info!(key, "新建 SFTP 连接");
	let connection = connect(host, port, username, password)?;
	remember(connections, key, connection.clone());
	Ok(connection)
}

/// 读取连接池中的某个连接。
fn cached(
	connections: &Arc<Mutex<HashMap<String, Arc<Connection>>>>,
	key: &str,
) -> Option<Arc<Connection>> {
	connections
		.lock()
		.unwrap_or_else(|error| error.into_inner())
		.get(key)
		.cloned()
}

/// 登记连接；并发情况下已有同 key 连接则保留已有的那条。
fn remember(
	connections: &Arc<Mutex<HashMap<String, Arc<Connection>>>>,
	key: &str,
	connection: Arc<Connection>,
) {
	connections
		.lock()
		.unwrap_or_else(|error| error.into_inner())
		.entry(key.to_string())
		.or_insert(connection);
}

/// 丢弃某个连接（连接失效或需要重新认证时）。
fn discard(
	connections: &Arc<Mutex<HashMap<String, Arc<Connection>>>>,
	key: &str,
) {
	connections
		.lock()
		.unwrap_or_else(|error| error.into_inner())
		.remove(key);
}

/// 建立 SSH 连接、完成认证、打开 SFTP 通道，并解析 uid/gid → 名称映射。
///
/// 局部 `Session` 在函数返回时被丢弃，但 `Sftp` 持有其内部
/// `Arc<Mutex<SessionInner>>`，连接会一直存活到该 `Sftp` 被丢弃。
fn connect(
	host: &str,
	port: u16,
	username: &str,
	password: Option<&str>,
) -> Result<Arc<Connection>, String> {
	let address = (host, port)
		.to_socket_addrs()
		.map_err(|error| {
			format!("解析 {host}:{port} 失败：{error}")
		})?
		.next()
		.ok_or_else(|| format!("无法解析主机 {host}"))?;
	let tcp = TcpStream::connect_timeout(
		&address,
		CONNECT_TIMEOUT,
	)
	.map_err(|error| {
		format!("连接 {host}:{port} 失败：{error}")
	})?;
	// 目录浏览是小包往返，关掉 Nagle 降低延迟
	let _ = tcp.set_nodelay(true);

	let mut session = Session::new().map_err(|error| error.to_string())?;
	session.set_tcp_stream(tcp);
	session.set_timeout(SESSION_TIMEOUT_MS);
	session
		.handshake()
		.map_err(|error| format!("SSH 握手失败：{error}"))?;

	// 认证：有保存密码时先走 password 方法。不少服务器禁用了该方法、只开
	// keyboard-interactive（系统 ssh 默认会走后者，所以终端能登录而这里失败），
	// 因此密码被拒时再用 keyboard-interactive 重试一次。没有密码则回退 ssh-agent。
	let authenticated = match password {
		Some(password) => {
			let mut ok = session
				.userauth_password(username, password)
				.is_ok()
				&& session.authenticated();
			if !ok {
				warn!(
					host = %host,
					"password 认证被拒，改用 keyboard-interactive 重试"
				);
				let mut prompter = PasswordPrompter {
					password: password.to_string(),
				};
				ok = session
					.userauth_keyboard_interactive(
						username,
						&mut prompter,
					)
					.is_ok()
					&& session.authenticated();
			}
			ok
		}
		None => {
			session.userauth_agent(username).is_ok()
				&& session.authenticated()
		}
	};
	if !authenticated {
		return Err(match password {
			Some(_) => format!(
				"SSH 认证失败（{username}@{host}:{port}）：密码被拒绝（已尝试 password 与 keyboard-interactive）"
			),
			None => format!(
				"SSH 认证失败（{username}@{host}:{port}）：该会话没有保存密码，ssh-agent 也未能通过认证。请在会话设置里填写并保存密码后重试"
			),
		});
	}
	// 通道只开一次并随连接缓存下来，后续浏览不再重复协商
	let sftp = session
		.sftp()
		.map_err(|error| format!("打开 SFTP 通道失败：{error}"))?;
	// uid/gid 名字映射（读不到就退化成显示数字，不影响浏览）
	let users = read_id_map(&sftp, "/etc/passwd");
	let groups = read_id_map(&sftp, "/etc/group");
	info!(
		host = %host,
		port,
		username = %username,
		users = users.len(),
		groups = groups.len(),
		"SFTP 认证通过并已打开通道"
	);
	Ok(Arc::new(Connection {
		sftp: Arc::new(sftp),
		users,
		groups,
	}))
}

/// 读取 `/etc/passwd` 或 `/etc/group`，解析出「数字 id → 名称」映射。
///
/// 两者的数字字段都在第 3 列（名称:密码:id:…），格式一致所以共用一个函数。
/// 读不到（无权限、路径不存在、非 Unix 服务器）时返回空表即可。
fn read_id_map(sftp: &Sftp, path: &str) -> HashMap<u32, String> {
	let Ok(mut file) = sftp.open(Path::new(path)) else {
		return HashMap::new();
	};
	let mut content = String::new();
	if file.read_to_string(&mut content).is_err() {
		return HashMap::new();
	}
	content
		.lines()
		.filter_map(|line| {
			let mut parts = line.split(':');
			let name = parts.next()?;
			// 跳过密码字段，取第 3 列的 id
			let id = parts.nth(1)?.parse::<u32>().ok()?;
			Some((id, name.to_string()))
		})
		.collect()
}

/// 数字 id 转名称，查不到就退回数字本身。
fn name_of(map: &HashMap<u32, String>, id: u32) -> String {
	map.get(&id).cloned().unwrap_or_else(|| id.to_string())
}

/// 传输 / 远程操作的通用任务参数（连接信息 + 本地路径 + 远程路径）。
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TransferJob {
	host: String,
	port: Option<u16>,
	username: Option<String>,
	password: Option<String>,
	/// 本地文件路径（上传时为源文件，下载时为目标文件）
	local: String,
	/// 远程文件路径（上传时为目标文件，下载时为源文件）
	remote: String,
	/// 传输任务 id：前端生成，用于把进度事件对回任务面板。
	/// 非传输类操作（新建 / 删除 / 权限）不传。
	#[serde(default)]
	id: String,
}

/// 传输进度事件名：前端 listen 这个频道更新任务面板。
const TRANSFER_EVENT: &str = "sftp-transfer";

/// 分块大小：一次读写 64KB，既能上报细粒度进度又不至于系统调用过密。
const CHUNK_SIZE: usize = 64 * 1024;

/// 进度上报的最小间隔，避免大文件把事件刷爆。
const PROGRESS_INTERVAL: Duration =
	Duration::from_millis(100);

/// 传输进度事件负载。
#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct TransferEvent {
	id: String,
	bytes: u64,
	total: u64,
	done: bool,
}

/// 向 WebView 发一次进度事件；发失败不影响传输本身。
fn emit_transfer(
	app: &tauri::AppHandle,
	event: TransferEvent,
) {
	use tauri::Emitter;
	let _ = app.emit(TRANSFER_EVENT, event);
}

/// 解析传输任务里的连接信息，得到连接池的 key 与认证参数。
fn transfer_target(
	job: &TransferJob,
) -> (String, String, u16, String, Option<String>) {
	let host = job.host.trim().to_string();
	let port = job.port.unwrap_or(22);
	let username = job
		.username
		.as_deref()
		.map(str::trim)
		.filter(|value| !value.is_empty())
		.unwrap_or("root")
		.to_string();
	let password = job
		.password
		.as_deref()
		.map(str::trim)
		.filter(|value| !value.is_empty())
		.map(str::to_string);
	let key = format!("{username}@{host}:{port}");
	(key, host, port, username, password)
}

/// 远程新建目录（`job.local` 不使用，传空串即可）。
// 函数名不能与 fs.rs 的 make_dir / remove_path 同名：
// tauri::command 宏按函数名生成内部符号，重名会导致重复定义。
#[tauri::command(rename = "sftp_make_dir")]
pub async fn make_remote_dir(
	pool: State<'_, SftpPool>,
	job: TransferJob,
) -> Result<(), String> {
	let connections = pool.connections.clone();
	tauri::async_runtime::spawn_blocking(move || {
		let (key, host, port, username, password) =
			transfer_target(&job);
		let connection = obtain(
			&connections,
			&key,
			&host,
			port,
			&username,
			password.as_deref(),
		)?;
		connection
			.sftp
			.mkdir(Path::new(&job.remote), 0o755)
			.map_err(|error| {
				format!(
					"新建远程目录 {} 失败：{error}",
					job.remote
				)
			})
	})
	.await
	.map_err(|error| error.to_string())?
}

/// 递归删除远程路径：目录先清空子项再删自身。
///
/// `rmdir` 只能删空目录，带内容的文件夹必须先递归进去。
/// 每删掉一个文件就把它的字节数记进进度，复用传输面板展示。
fn remove_remote_recursive(
	sftp: &Sftp,
	path: &Path,
	context: &mut TransferContext<'_>,
) -> Result<(), String> {
	let stat = sftp.stat(path).map_err(|error| {
		format!("读取远程 {} 失败：{error}", path.display())
	})?;
	if !stat.is_dir() {
		let size = stat.size.unwrap_or(0);
		sftp.unlink(path).map_err(|error| {
			format!("删除远程文件 {} 失败：{error}", path.display())
		})?;
		return context.advance(size);
	}
	let entries = sftp.readdir(path).map_err(|error| {
		format!("读取远程目录 {} 失败：{error}", path.display())
	})?;
	for (child, _) in entries {
		if is_dot_entry(&child) {
			continue;
		}
		remove_remote_recursive(sftp, &child, context)?;
	}
	sftp.rmdir(path).map_err(|error| {
		format!("删除远程目录 {} 失败：{error}", path.display())
	})
}

/// 远程删除文件或目录（目录按递归删除；`job.local` 不使用，传空串即可）。
///
/// 与上传 / 下载共用进度事件，所以在底部面板里也是一条普通任务。
#[tauri::command(rename = "sftp_remove_path")]
pub async fn remove_remote_path(
	app: tauri::AppHandle,
	pool: State<'_, SftpPool>,
	transfers: State<'_, Transfers>,
	job: TransferJob,
) -> Result<(), String> {
	let connections = pool.connections.clone();
	let control = transfers.register(&job.id);
	let id = job.id.clone();
	let cleanup_id = id.clone();
	let result = tauri::async_runtime::spawn_blocking(
		move || {
			let (key, host, port, username, password) =
				transfer_target(&job);
			let connection = obtain(
				&connections,
				&key,
				&host,
				port,
				&username,
				password.as_deref(),
			)?;
			let remote = Path::new(&job.remote);
			// 先算总量，删除进度才有分母
			let total = measure_remote(&connection.sftp, remote);
			let mut context =
				TransferContext::new(&app, &control, &id, total);
			remove_remote_recursive(
				&connection.sftp,
				remote,
				&mut context,
			)?;
			context.report(true);
			info!(bytes = context.moved, "已删除 {}", job.remote);
			Ok(())
		},
	)
	.await
	.map_err(|error| error.to_string())?;
	transfers.unregister(&cleanup_id);
	result
}

/// 远程新建空文件（`job.local` 不使用，传空串即可）。
#[tauri::command(rename = "sftp_create_file")]
pub async fn create_remote_file(
	pool: State<'_, SftpPool>,
	job: TransferJob,
) -> Result<(), String> {
	let connections = pool.connections.clone();
	tauri::async_runtime::spawn_blocking(move || {
		let (key, host, port, username, password) =
			transfer_target(&job);
		let connection = obtain(
			&connections,
			&key,
			&host,
			port,
			&username,
			password.as_deref(),
		)?;
		// sftp.create 会按 O_WRONLY|O_CREAT|O_TRUNC 打开，立即关闭即为空文件
		connection
			.sftp
			.create(Path::new(&job.remote))
			.map(|_| ())
			.map_err(|error| {
				format!(
					"新建远程文件 {} 失败：{error}",
					job.remote
				)
			})
	})
	.await
	.map_err(|error| error.to_string())?
}

/// 修改远程文件 / 目录的权限位（`job.local` 不使用，传空串即可）。
///
/// `mode` 是 Unix 权限的八进制值（例如 0o755），只取低 9 位。
#[tauri::command(rename = "sftp_chmod")]
pub async fn chmod(
	pool: State<'_, SftpPool>,
	job: TransferJob,
	mode: u32,
) -> Result<(), String> {
	let connections = pool.connections.clone();
	tauri::async_runtime::spawn_blocking(move || {
		let (key, host, port, username, password) =
			transfer_target(&job);
		let connection = obtain(
			&connections,
			&key,
			&host,
			port,
			&username,
			password.as_deref(),
		)?;
		// ssh2 没有单独的 chmod：构造一份只带 perm 的 FileStat，
		// 交给 setstat 下发（其余字段留 None，不会被改动）
		let stat = ssh2::FileStat {
			size: None,
			uid: None,
			gid: None,
			perm: Some(mode & 0o777),
			atime: None,
			mtime: None,
		};
		connection
			.sftp
			.setstat(Path::new(&job.remote), stat)
			.map_err(|error| {
				format!(
					"修改 {} 的权限失败：{error}",
					job.remote
				)
			})
	})
	.await
	.map_err(|error| error.to_string())?
}

/// 单个传输任务的控制开关：前端通过命令翻转，传输循环每块检查一次。
#[derive(Default)]
pub struct TransferControl {
	paused: AtomicBool,
	cancelled: AtomicBool,
}

/// 进行中的传输任务表（Tauri State）：任务 id → 控制开关。
#[derive(Default)]
pub struct Transfers {
	controls: Mutex<HashMap<String, Arc<TransferControl>>>,
}

impl Transfers {
	fn lock(
		&self,
	) -> std::sync::MutexGuard<
		'_,
		HashMap<String, Arc<TransferControl>>,
	> {
		self.controls
			.lock()
			.unwrap_or_else(|error| error.into_inner())
	}

	/// 登记任务并返回它的控制开关。
	fn register(&self, id: &str) -> Arc<TransferControl> {
		let control = Arc::new(TransferControl::default());
		self.lock().insert(id.to_string(), control.clone());
		control
	}

	/// 任务结束后摘除，避免表无限增长。
	fn unregister(&self, id: &str) {
		self.lock().remove(id);
	}

	/// 取任务的控制开关；任务不存在（已结束）时为 None。
	fn find(&self, id: &str) -> Option<Arc<TransferControl>> {
		self.lock().get(id).cloned()
	}
}

/// 暂停传输：循环会在当前分块结束后停下来等待。
#[tauri::command(rename = "sftp_pause_transfer")]
pub fn pause_transfer(
	transfers: State<'_, Transfers>,
	id: String,
) -> Result<(), String> {
	let control = transfers
		.find(&id)
		.ok_or_else(|| "任务不存在或已结束".to_string())?;
	control.paused.store(true, Ordering::Relaxed);
	Ok(())
}

/// 恢复传输。
#[tauri::command(rename = "sftp_resume_transfer")]
pub fn resume_transfer(
	transfers: State<'_, Transfers>,
	id: String,
) -> Result<(), String> {
	let control = transfers
		.find(&id)
		.ok_or_else(|| "任务不存在或已结束".to_string())?;
	control.paused.store(false, Ordering::Relaxed);
	Ok(())
}

/// 取消传输：循环在下一个分块边界退出。
#[tauri::command(rename = "sftp_cancel_transfer")]
pub fn cancel_transfer(
	transfers: State<'_, Transfers>,
	id: String,
) -> Result<(), String> {
	let control = transfers
		.find(&id)
		.ok_or_else(|| "任务不存在或已结束".to_string())?;
	control.cancelled.store(true, Ordering::Relaxed);
	// 处于暂停等待时也要能立刻退出
	control.paused.store(false, Ordering::Relaxed);
	Ok(())
}

/// 递归统计本地路径的总字节数：目录求和，文件取长度。
fn measure_local(path: &Path) -> u64 {
	let Ok(metadata) = std::fs::metadata(path) else {
		return 0;
	};
	if !metadata.is_dir() {
		return metadata.len();
	}
	let Ok(entries) = std::fs::read_dir(path) else {
		return 0;
	};
	entries
		.filter_map(Result::ok)
		.map(|entry| measure_local(&entry.path()))
		.sum()
}

/// 远程路径是否为 `.` / `..`（递归时要跳过）。
fn is_dot_entry(path: &Path) -> bool {
	matches!(
		path.file_name().map(|name| name.to_string_lossy().into_owned()),
		Some(name) if name == "." || name == ".."
	)
}

/// 递归统计远程路径的总字节数。
fn measure_remote(sftp: &Sftp, path: &Path) -> u64 {
	match sftp.stat(path) {
		Ok(stat) if stat.is_dir() => sftp
			.readdir(path)
			.map(|entries| {
				entries
					.iter()
					.filter(|(child, _)| !is_dot_entry(child))
					.map(|(child, _)| measure_remote(sftp, child))
					.sum()
			})
			.unwrap_or(0),
		Ok(stat) => stat.size.unwrap_or(0),
		Err(_) => 0,
	}
}

/// 一次传输的进度上下文：累计字节、节流上报、响应暂停 / 取消。
///
/// 上传下载共用；目录传输时 `moved` 跨文件累计，因此进度条是整体进度。
struct TransferContext<'a> {
	app: &'a tauri::AppHandle,
	control: &'a TransferControl,
	id: &'a str,
	/// 总字节数（目录为递归求和结果）
	total: u64,
	/// 已传输字节数
	moved: u64,
	/// 上次上报时间，用于节流
	reported: Instant,
	/// 复用的分块缓冲，避免每个文件都重新分配
	buffer: Vec<u8>,
}

impl<'a> TransferContext<'a> {
	fn new(
		app: &'a tauri::AppHandle,
		control: &'a TransferControl,
		id: &'a str,
		total: u64,
	) -> Self {
		Self {
			app,
			control,
			id,
			total,
			moved: 0,
			reported: Instant::now(),
			buffer: vec![0u8; CHUNK_SIZE],
		}
	}

	/// 上报一次进度。
	fn report(&self, done: bool) {
		emit_transfer(
			self.app,
			TransferEvent {
				id: self.id.to_string(),
				bytes: self.moved,
				total: self.total,
				done,
			},
		);
	}

	/// 响应取消与暂停；每个操作边界调用一次。
	fn gate(&self) -> Result<(), String> {
		if self.control.cancelled.load(Ordering::Relaxed) {
			return Err("传输已取消".to_string());
		}
		// 暂停时原地等待，但期间仍要能取消
		while self.control.paused.load(Ordering::Relaxed) {
			if self.control.cancelled.load(Ordering::Relaxed)
			{
				return Err("传输已取消".to_string());
			}
			thread::sleep(Duration::from_millis(120));
		}
		Ok(())
	}

	/// 记录一笔已完成的量（删除等非拷贝操作也用得上），并按节流上报。
	fn advance(&mut self, bytes: u64) -> Result<(), String> {
		self.gate()?;
		self.moved += bytes;
		if self.reported.elapsed() >= PROGRESS_INTERVAL {
			self.report(false);
			self.reported = Instant::now();
		}
		Ok(())
	}

	/// 搬运一个分块；返回 `false` 表示当前源已读完。
	///
	/// 每个分块边界都检查取消与暂停，所以暂停 / 取消的响应粒度是 64KB。
	fn pump(
		&mut self,
		reader: &mut dyn Read,
		writer: &mut dyn Write,
	) -> Result<bool, String> {
		self.gate()?;
		let read = reader
			.read(&mut self.buffer)
			.map_err(|error| format!("读取失败：{error}"))?;
		if read == 0 {
			return Ok(false);
		}
		writer
			.write_all(&self.buffer[..read])
			.map_err(|error| format!("写入失败：{error}"))?;
		self.moved += read as u64;
		if self.reported.elapsed() >= PROGRESS_INTERVAL {
			self.report(false);
			self.reported = Instant::now();
		}
		Ok(true)
	}

	/// 递归上传一个本地路径：目录先建再逐项处理，文件则分块拷贝。
	fn upload(
		&mut self,
		sftp: &Sftp,
		local: &Path,
		remote: &Path,
	) -> Result<(), String> {
		let metadata =
			std::fs::metadata(local).map_err(|error| {
				format!("读取 {} 失败：{error}", local.display())
			})?;
		if metadata.is_dir() {
			// 目标目录可能已存在（合并上传），忽略 mkdir 的报错
			let _ = sftp.mkdir(remote, 0o755);
			let entries =
				std::fs::read_dir(local).map_err(|error| {
					format!(
						"读取目录 {} 失败：{error}",
						local.display()
					)
				})?;
			for entry in entries {
				let entry = entry.map_err(|error| {
					format!("读取目录项失败：{error}")
				})?;
				self.upload(
					sftp,
					&entry.path(),
					&remote.join(entry.file_name()),
				)?;
			}
			return Ok(());
		}
		let mut source =
			std::fs::File::open(local).map_err(|error| {
				format!("读取 {} 失败：{error}", local.display())
			})?;
		let mut target = sftp.create(remote).map_err(|error| {
			format!(
				"创建远程文件 {} 失败：{error}",
				remote.display()
			)
		})?;
		while self.pump(&mut source, &mut target)? {}
		Ok(())
	}

	/// 递归下载一个远程路径：目录先建再逐项处理，文件则分块拷贝。
	fn download(
		&mut self,
		sftp: &Sftp,
		remote: &Path,
		local: &Path,
	) -> Result<(), String> {
		let stat = sftp.stat(remote).map_err(|error| {
			format!("读取远程 {} 失败：{error}", remote.display())
		})?;
		if stat.is_dir() {
			std::fs::create_dir_all(local).map_err(|error| {
				format!(
					"创建目录 {} 失败：{error}",
					local.display()
				)
			})?;
			let entries =
				sftp.readdir(remote).map_err(|error| {
					format!(
						"读取远程目录 {} 失败：{error}",
						remote.display()
					)
				})?;
			for (child, _) in entries {
				if is_dot_entry(&child) {
					continue;
				}
				let Some(name) = child.file_name() else {
					continue;
				};
				self.download(
					sftp,
					&child,
					&local.join(name),
				)?;
			}
			return Ok(());
		}
		let mut source = sftp.open(remote).map_err(|error| {
			format!(
				"打开远程文件 {} 失败：{error}",
				remote.display()
			)
		})?;
		let mut target =
			std::fs::File::create(local).map_err(|error| {
				format!(
					"写入 {} 失败：{error}",
					local.display()
				)
			})?;
		while self.pump(&mut source, &mut target)? {}
		Ok(())
	}
}

/// 上传本地文件到远程路径（分块传输并按 100ms 节流上报进度）。
#[tauri::command(rename = "sftp_upload")]
pub async fn upload(
	app: tauri::AppHandle,
	pool: State<'_, SftpPool>,
	transfers: State<'_, Transfers>,
	job: TransferJob,
) -> Result<(), String> {
	let connections = pool.connections.clone();
	// 控制开关要先取出来：State 借不出 'static 生命周期，Arc 可以
	let control = transfers.register(&job.id);
	let id = job.id.clone();
	// 闭包要拿走 id 上报进度，另留一份用于收尾注销
	let cleanup_id = id.clone();
	let result = tauri::async_runtime::spawn_blocking(
		move || {
			let (key, host, port, username, password) =
				transfer_target(&job);
			let connection = obtain(
				&connections,
				&key,
				&host,
				port,
				&username,
				password.as_deref(),
			)?;
			let local = PathBuf::from(&job.local);
			let remote = PathBuf::from(&job.remote);
			// 先递归统计总量，目录也能给出准确的整体进度
			let total = measure_local(&local);
			let mut context =
				TransferContext::new(&app, &control, &id, total);
			context.upload(&connection.sftp, &local, &remote)?;
			context.report(true);
			info!(
				bytes = context.moved,
				"已上传 {} -> {}", job.local, job.remote
			);
			Ok(())
		},
	)
	.await
	.map_err(|error| error.to_string())?;
	transfers.unregister(&cleanup_id);
	result
}

/// 下载远程文件到本地路径（分块传输并按 100ms 节流上报进度）。
#[tauri::command(rename = "sftp_download")]
pub async fn download(
	app: tauri::AppHandle,
	pool: State<'_, SftpPool>,
	transfers: State<'_, Transfers>,
	job: TransferJob,
) -> Result<(), String> {
	let connections = pool.connections.clone();
	let control = transfers.register(&job.id);
	let id = job.id.clone();
	// 闭包要拿走 id 上报进度，另留一份用于收尾注销
	let cleanup_id = id.clone();
	let result = tauri::async_runtime::spawn_blocking(
		move || {
			let (key, host, port, username, password) =
				transfer_target(&job);
			let connection = obtain(
				&connections,
				&key,
				&host,
				port,
				&username,
				password.as_deref(),
			)?;
			let local = PathBuf::from(&job.local);
			let remote = PathBuf::from(&job.remote);
			// 先递归统计总量，目录也能给出准确的整体进度
			let total = measure_remote(&connection.sftp, &remote);
			let mut context =
				TransferContext::new(&app, &control, &id, total);
			context.download(&connection.sftp, &remote, &local)?;
			context.report(true);
			info!(
				bytes = context.moved,
				"已下载 {} -> {}", job.remote, job.local
			);
			Ok(())
		},
	)
	.await
	.map_err(|error| error.to_string())?;
	transfers.unregister(&cleanup_id);
	result
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
			path: entry_path.to_string_lossy().into_owned(),
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
			.map(|parent| parent.to_string_lossy().into_owned())
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
		path: canonical.to_string_lossy().into_owned(),
		parent,
		entries,
		icons: icons::icons_for(&keys),
	})
}
