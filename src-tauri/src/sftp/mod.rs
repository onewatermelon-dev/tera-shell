pub mod open;
pub mod rename;
pub mod window;

use crate::icons;
use serde::{Deserialize, Serialize};
use ssh2::{KeyboardInteractivePrompt, Prompt, Session, Sftp};
use std::{
	collections::HashMap,
	io::{Read, Seek, Write},
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
pub(crate) const CONNECT_TIMEOUT: Duration = Duration::from_secs(10);

/// 单次会话操作（握手 / 认证 / 读目录）的超时，防止界面一直等。
pub(crate) const SESSION_TIMEOUT_MS: u32 = 20_000;

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
	/// 同一条会话的句柄：SFTP 之外还要跑 shell 命令（磁盘用量 df/du）。
	/// ssh2 的 Session 非 Sync，用互斥锁串行化 exec。
	session: Arc<Mutex<Session>>,
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
pub(crate) struct PasswordPrompter {
	pub(crate) password: String,
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
	let session =
		establish_session(host, port, username, password)?;
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
		session: Arc::new(Mutex::new(session)),
		users,
		groups,
	}))
}

/// 建立一条**已认证**的 SSH 会话（TCP + 握手 + 认证），不打开任何通道。
///
/// SFTP 与 AI 命令执行共用：认证策略一致 —— 有保存密码时先走 password
/// 方法，被拒后用 keyboard-interactive 重试（不少服务器只开后者）；没有
/// 密码则回退 ssh-agent。密码只在内存中使用，不进日志。
pub(crate) fn establish_session(
	host: &str,
	port: u16,
	username: &str,
	password: Option<&str>,
) -> Result<Session, String> {
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
	// 小包往返为主的交互，关掉 Nagle 降低延迟
	let _ = tcp.set_nodelay(true);

	let mut session = Session::new().map_err(|error| error.to_string())?;
	session.set_tcp_stream(tcp);
	session.set_timeout(SESSION_TIMEOUT_MS);
	session
		.handshake()
		.map_err(|error| format!("SSH 握手失败：{error}"))?;

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
	Ok(session)
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
	/// 同名冲突策略：overwrite（默认）/ skip / rename / resume。
	/// 旧调用方不传此字段，按覆盖处理保持既有行为。
	#[serde(default)]
	policy: String,
}

/// 文件落点同名冲突时的处理策略。
#[derive(Clone, Copy, PartialEq, Eq)]
enum TransferPolicy {
	Overwrite,
	Skip,
	Rename,
	Resume,
}

impl TransferPolicy {
	fn from_job(value: &str) -> Self {
		match value {
			"skip" => Self::Skip,
			"rename" => Self::Rename,
			"resume" => Self::Resume,
			_ => Self::Overwrite,
		}
	}
}

/// 同名冲突时生成不冲突的相邻路径：`a.txt → a (1).txt → a (2).txt`。
///
/// `exists` 是落点侧的存在性探测（远程用 stat，本地用 metadata）。
/// 尝试上限 1000：正常情况第一个候选就命中，到上限兜底返回原路径
/// 按覆盖处理，避免理论上的死循环。
fn renamed_target(
	target: &Path,
	mut exists: impl FnMut(&Path) -> bool,
) -> PathBuf {
	if !exists(target) {
		return target.to_path_buf();
	}
	let stem = target
		.file_stem()
		.map(|name| name.to_string_lossy().into_owned())
		.unwrap_or_default();
	let extension = target
		.extension()
		.map(|ext| ext.to_string_lossy().into_owned());
	for index in 1..1000 {
		let candidate = match &extension {
			Some(ext) => target.with_file_name(format!(
				"{stem} ({index}).{ext}"
			)),
			None => target.with_file_name(format!(
				"{stem} ({index})"
			)),
		};
		if !exists(&candidate) {
			return candidate;
		}
	}
	target.to_path_buf()
}

/// 策略决策核心：返回实际落点与起始偏移，`None` = 按策略跳过该文件。
///
/// 前置：落点不存在时一律正常传输（四种策略在此汇合）。落点已存在时：
/// 覆盖 → 原路径从头写；跳过 → None；重命名 → 换相邻路径；
/// 续传 → 目标不比源小时无事可做（None），比源小则从目标大小处接续。
fn prepare_target(
	policy: TransferPolicy,
	target: &Path,
	mut exists: impl FnMut(&Path) -> bool,
	mut size_of: impl FnMut(&Path) -> Option<u64>,
	source_len: u64,
) -> Option<(PathBuf, u64)> {
	if !exists(target) {
		return Some((target.to_path_buf(), 0));
	}
	match policy {
		TransferPolicy::Overwrite => {
			Some((target.to_path_buf(), 0))
		}
		TransferPolicy::Skip => None,
		TransferPolicy::Rename => Some((
			renamed_target(target, &mut exists),
			0,
		)),
		TransferPolicy::Resume => {
			let done = size_of(target).unwrap_or(0);
			if done >= source_len {
				None
			} else {
				Some((target.to_path_buf(), done))
			}
		}
	}
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
			let mut context = TransferContext::new(
				&app,
				&control,
				&id,
				// 删除没有"落点冲突"概念，策略占位
				TransferPolicy::Overwrite,
				total,
			);
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

/// 拼远程子路径：强制 `/` 分隔 —— `PathBuf::join` 在 Windows 宿主上
/// 会拼出 `\`，远端 Linux 收到的是带反斜杠的字面量文件名。
fn remote_join(parent: &Path, name: &std::ffi::OsStr) -> PathBuf {
	let mut text = parent.to_string_lossy().into_owned();
	if !text.ends_with('/') {
		text.push('/');
	}
	PathBuf::from(text + &name.to_string_lossy())
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
	/// 同名冲突策略（目录递归里的每个文件都要过一遍）
	policy: TransferPolicy,
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
		policy: TransferPolicy,
		total: u64,
	) -> Self {
		Self {
			app,
			control,
			id,
			policy,
			total,
			moved: 0,
			reported: Instant::now(),
			buffer: vec![0u8; CHUNK_SIZE],
		}
	}

	/// 上传侧的策略决策：远程落点 + 起始偏移；None = 跳过该文件。
	fn prepare_upload(
		&self,
		sftp: &Sftp,
		source_len: u64,
		target: &Path,
	) -> Option<(PathBuf, u64)> {
		prepare_target(
			self.policy,
			target,
			|path| sftp.stat(path).is_ok(),
			|path| sftp.stat(path).ok().and_then(|s| s.size),
			source_len,
		)
	}

	/// 下载侧的策略决策：本地落点 + 起始偏移；None = 跳过该文件。
	fn prepare_download(
		&self,
		source_len: u64,
		target: &Path,
	) -> Option<(PathBuf, u64)> {
		prepare_target(
			self.policy,
			target,
			|path| path.exists(),
			|path| {
				std::fs::metadata(path)
					.ok()
					.map(|meta| meta.len())
			},
			source_len,
		)
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
					&remote_join(remote, &entry.file_name()),
				)?;
			}
			return Ok(());
		}
		// 同名冲突按策略处理：覆盖 / 跳过 / 重命名 / 断点续传
		let Some((target_path, offset)) =
			self.prepare_upload(sftp, metadata.len(), remote)
		else {
			return Ok(());
		};
		let mut source =
			std::fs::File::open(local).map_err(|error| {
				format!("读取 {} 失败：{error}", local.display())
			})?;
		let mut target = if offset > 0 {
			// 续传：不带 TRUNCATE 打开已有文件，两侧都 seek 到断点；
			// 已传过的部分计入进度，进度条才能到达 100%
			let mut file = sftp
				.open_mode(
					&target_path,
					ssh2::OpenFlags::WRITE
						| ssh2::OpenFlags::CREATE,
					0o644,
					ssh2::OpenType::File,
				)
				.map_err(|error| {
					format!(
						"打开远程文件 {} 失败：{error}",
						target_path.display()
					)
				})?;
			file.seek(std::io::SeekFrom::Start(offset))
				.map_err(|error| {
					format!("定位续传偏移失败：{error}")
				})?;
			source
				.seek(std::io::SeekFrom::Start(offset))
				.map_err(|error| {
					format!("定位续传偏移失败：{error}")
				})?;
			self.moved += offset;
			file
		} else {
			sftp.create(&target_path).map_err(|error| {
				format!(
					"创建远程文件 {} 失败：{error}",
					target_path.display()
				)
			})?
		};
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
		// 同名冲突按策略处理：覆盖 / 跳过 / 重命名 / 断点续传
		let Some((target_path, offset)) =
			self.prepare_download(stat.size.unwrap_or(0), local)
		else {
			return Ok(());
		};
		let mut source = sftp.open(remote).map_err(|error| {
			format!(
				"打开远程文件 {} 失败：{error}",
				remote.display()
			)
		})?;
		if offset > 0 {
			// 续传：远程源与本地目标都 seek 到断点，已传部分计入进度
			source
				.seek(std::io::SeekFrom::Start(offset))
				.map_err(|error| {
					format!("定位续传偏移失败：{error}")
				})?;
			self.moved += offset;
		}
		let mut target = if offset > 0 {
			let mut file = std::fs::OpenOptions::new()
				.write(true)
				.open(&target_path)
				.map_err(|error| {
					format!(
						"打开 {} 失败：{error}",
						target_path.display()
					)
				})?;
			file.seek(std::io::SeekFrom::Start(offset))
				.map_err(|error| {
					format!("定位续传偏移失败：{error}")
				})?;
			file
		} else {
			std::fs::File::create(&target_path).map_err(
				|error| {
					format!(
						"写入 {} 失败：{error}",
						target_path.display()
					)
				},
			)?
		};
		while self.pump(&mut source, &mut target)? {}
		Ok(())
	}
}

/// 单引号包裹的 shell 字面量：路径可能带空格与引号。
fn shell_quote(value: &str) -> String {
	format!("'{}'", value.replace('\'', "'\\''"))
}

/// 在连接的会话上执行一条 shell 命令。
///
/// 返回 (stdout, stderr, 退出码)：archive 这类操作要靠退出码与
/// stderr 报错，df/du 那类只看 stdout。
fn exec_output(
	session: &Arc<Mutex<Session>>,
	command: &str,
) -> Result<(String, String, i32), String> {
	let mut channel = session
		.lock()
		.unwrap_or_else(|error| error.into_inner())
		.channel_session()
		.map_err(|error| {
			format!("打开命令通道失败：{error}")
		})?;
	channel
		.exec(command)
		.map_err(|error| format!("执行命令失败：{error}"))?;
	let mut stdout = String::new();
	channel
		.read_to_string(&mut stdout)
		.map_err(|error| format!("读取命令输出失败：{error}"))?;
	let mut stderr = String::new();
	channel
		.stderr()
		.read_to_string(&mut stderr)
		.map_err(|error| format!("读取命令错误输出失败：{error}"))?;
	let _ = channel.wait_close();
	let status = channel.exit_status().unwrap_or(-1);
	Ok((stdout, stderr, status))
}

/// 解析 `df -P -k` 最后一条数据行：返回 (总容量, 可用) 字节数。
///
/// -P 是 POSIX 定宽格式：Filesystem 1024-blocks Used Available Capacity Mounted。
/// 挂载点带空格也不影响 —— 取的是前面几列。
fn parse_df(output: &str) -> Option<(u64, u64)> {
	let last = output
		.lines()
		.filter(|line| !line.trim().is_empty())
		.last()?;
	let mut fields = last.split_whitespace();
	let _filesystem = fields.next()?;
	let blocks: u64 = fields.next()?.parse().ok()?;
	let _used: u64 = fields.next()?.parse().ok()?;
	let available: u64 = fields.next()?.parse().ok()?;
	Some((blocks * 1024, available * 1024))
}

/// 解析 `du -s -k` 输出：目录累计大小（字节）。
fn parse_du(output: &str) -> Option<u64> {
	output
		.lines()
		.next()?
		.split_whitespace()
		.next()?
		.parse::<u64>()
		.ok()
		.map(|blocks| blocks * 1024)
}

/// 远程磁盘用量（状态栏展示用）。
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteDiskUsage {
	/// 落点所在文件系统的总容量
	total_bytes: u64,
	/// 可用空间
	free_bytes: u64,
	/// 当前目录累计大小（du 拿不到时为 0）
	dir_bytes: u64,
}

/// 查询远程磁盘用量：df 给容量与可用空间，du 给当前目录累计大小。
///
/// 用 SFTP 所在的同一条会话开 exec 通道跑 shell（ssh2 协议本身拿不到
/// statvfs）。du 是非致命项 —— 超大目录会跑满会话超时，失败时置 0，
/// 容量与可用空间照常显示。
#[tauri::command(rename = "sftp_disk_usage")]
pub async fn disk_usage(
	pool: State<'_, SftpPool>,
	job: TransferJob,
) -> Result<RemoteDiskUsage, String> {
	let connections = pool.connections.clone();
	let (key, host, port, username, password) =
		transfer_target(&job);
	let remote = job.remote.clone();
	tauri::async_runtime::spawn_blocking(move || {
		let connection = obtain(
			&connections,
			&key,
			&host,
			port,
			&username,
			password.as_deref(),
		)?;
		let quoted = shell_quote(&remote);
		let (df_output, _, _) = exec_output(
			&connection.session,
			&format!("df -P -k {quoted}"),
		)?;
		let (total_bytes, free_bytes) =
			parse_df(&df_output)
				.ok_or_else(|| {
					"无法解析 df 输出".to_string()
				})?;
		let dir_bytes = exec_output(
			&connection.session,
			&format!("du -s -k {quoted}"),
		)
		.ok()
		.and_then(|(output, _, _)| parse_du(&output))
		.unwrap_or(0);
		Ok(RemoteDiskUsage {
			total_bytes,
			free_bytes,
			dir_bytes,
		})
	})
	.await
	.map_err(|error| error.to_string())?
}

/// 远程归档：compress = tar.gz 打包，extract = 按扩展名解压到所在目录。
///
/// 走同一条会话的 exec 通道跑 tar / unzip（远程解压没有协议级支持）。
/// tar 几乎每台服务器都有所以压缩只出 tar.gz；解压按扩展名分流，
/// zip 交给 unzip（最小化安装经常没有，失败会带 stderr 报出来）。
#[tauri::command(rename = "sftp_archive")]
pub async fn archive(
	pool: State<'_, SftpPool>,
	job: TransferJob,
	mode: String,
	paths: Vec<String>,
	target: String,
) -> Result<(), String> {
	let connections = pool.connections.clone();
	let (key, host, port, username, password) =
		transfer_target(&job);
	tauri::async_runtime::spawn_blocking(move || {
		let connection = obtain(
			&connections,
			&key,
			&host,
			port,
			&username,
			password.as_deref(),
		)?;
		let command = match mode.as_str() {
			"compress" => {
				if paths.is_empty() {
					return Err("没有要压缩的条目".into());
				}
				// 逐条 `-C 父目录 相对名`：成员路径不带绝对前缀。
				// 绝对路径会被 tar 剥掉首斜杠（成员变成 root/...），
				// 解包时 -C 指定的目录下会多出一层宿主路径。
				let mut parts: Vec<String> = Vec::new();
				for path in &paths {
					let file = Path::new(path);
					let dir = file
						.parent()
						.unwrap_or(Path::new("."))
						.to_string_lossy()
						.into_owned();
					let name = file
						.file_name()
						.map(|value| {
							value.to_string_lossy().into_owned()
						})
						.ok_or("路径没有文件名")?;
					parts.push(format!(
						"-C {} {}",
						shell_quote(&dir),
						shell_quote(&name)
					));
				}
				format!(
					"tar -czf {} {}",
					shell_quote(&target),
					parts.join(" ")
				)
			}
			"extract" => {
				let archive = paths
					.first()
					.ok_or("没有要解压的文件")?;
				// 解到压缩包所在目录（= 触发操作时的当前目录）
				let dir = Path::new(archive)
					.parent()
					.unwrap_or(Path::new("."))
					.to_string_lossy()
					.into_owned();
				if archive.to_lowercase().ends_with(".zip") {
					format!(
						"unzip -o {} -d {}",
						shell_quote(archive),
						shell_quote(&dir)
					)
				} else {
					// tar -f 自动识别 gz/bz2/xz 压缩
					format!(
						"tar -xf {} -C {}",
						shell_quote(archive),
						shell_quote(&dir)
					)
				}
			}
			_ => {
				return Err(format!(
					"未知归档操作：{mode}"
				))
			}
		};
		let (stdout, stderr, status) =
			exec_output(&connection.session, &command)?;
		info!(
			mode = %mode,
			status,
			stdout = %stdout.trim(),
			stderr = %stderr.trim(),
			command = %command,
			"远程归档执行结束"
		);
		if status != 0 {
			let reason = if stderr.trim().is_empty() {
				stdout.trim()
			} else {
				stderr.trim()
			};
			return Err(format!(
				"命令失败（退出码 {status}）：{reason}"
			));
		}
		Ok(())
	})
	.await
	.map_err(|error| error.to_string())?
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
			let mut context = TransferContext::new(
				&app,
				&control,
				&id,
				TransferPolicy::from_job(&job.policy),
				total,
			);
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
			let mut context = TransferContext::new(
				&app,
				&control,
				&id,
				TransferPolicy::from_job(&job.policy),
				total,
			);
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

#[cfg(test)]
mod tests {
	use super::*;

	#[test]
	fn renamed_target_skips_existing() {
		let target = Path::new("/r/a.txt");
		let taken = |path: &Path| {
			path == Path::new("/r/a.txt")
		};
		assert_eq!(
			renamed_target(target, taken),
			PathBuf::from("/r/a (1).txt")
		);
	}

	#[test]
	fn renamed_target_first_free_wins() {
		let target = Path::new("/r/a.txt");
		let taken = |path: &Path| {
			path == Path::new("/r/a.txt")
				|| path == Path::new("/r/a (1).txt")
		};
		assert_eq!(
			renamed_target(target, taken),
			PathBuf::from("/r/a (2).txt")
		);
	}

	#[test]
	fn prepare_target_decisions() {
		let target = Path::new("/r/a.bin");
		let exists = |_: &Path| true;
		// 目标比源小 → 续传从目标大小处接续
		assert_eq!(
			prepare_target(
				TransferPolicy::Resume,
				target,
				exists,
				|_| Some(100),
				300
			),
			Some((target.to_path_buf(), 100))
		);
		// 目标不比源小 → 无事可做
		assert_eq!(
			prepare_target(
				TransferPolicy::Resume,
				target,
				exists,
				|_| Some(300),
				300
			),
			None
		);
		// 跳过已存在的目标
		assert_eq!(
			prepare_target(
				TransferPolicy::Skip,
				target,
				exists,
				|_| Some(100),
				300
			),
			None
		);
		// 重命名换相邻路径（只有原路径被占用）
		let taken_original = |path: &Path| {
			path == Path::new("/r/a.bin")
		};
		assert_eq!(
			prepare_target(
				TransferPolicy::Rename,
				target,
				taken_original,
				|_| Some(100),
				300
			),
			Some((PathBuf::from("/r/a (1).bin"), 0))
		);
		// 落点不存在：任何策略都正常传输
		assert_eq!(
			prepare_target(
				TransferPolicy::Skip,
				Path::new("/r/new.bin"),
				|_: &Path| false,
				|_| None,
				300
			),
			Some((PathBuf::from("/r/new.bin"), 0))
		);
	}
}

#[cfg(test)]
mod disk_usage_tests {
	use super::*;

	#[test]
	fn parse_df_reads_last_data_line() {
		let output = "Filesystem 1024-blocks Used Available Capacity Mounted on\n\
		              /dev/sda1 1000 400 600 40% /\n";
		assert_eq!(parse_df(output), Some((1000 * 1024, 600 * 1024)));
	}

	#[test]
	fn parse_df_mount_with_spaces() {
		// 挂载点带空格：取的是前几列，不受影响
		let output = "/dev/sda1 2048 1024 1024 50% /mnt/my data\n";
		assert_eq!(parse_df(output), Some((2048 * 1024, 1024 * 1024)));
	}

	#[test]
	fn parse_df_garbage_returns_none() {
		assert_eq!(parse_df("df: invalid option"), None);
		assert_eq!(parse_df(""), None);
	}

	#[test]
	fn parse_du_reads_block_count() {
		assert_eq!(parse_du("1234\t/var/log\n"), Some(1234 * 1024));
		assert_eq!(parse_du("du: cannot access"), None);
	}
}
