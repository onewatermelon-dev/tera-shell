//! SFTP 连接池：每条 `username@host:port` 维护一条长连接。
//!
//! 缓存的是已打开的 `Sftp` 通道与 uid/gid → 名称映射；网络 IO 一律在
//! 不持有池锁的情况下进行，避免一个慢连接阻塞其它会话。
//! `establish_session` 与 AI 命令执行共用（认证策略一致）。

use ssh2::{KeyboardInteractivePrompt, Prompt, Session, Sftp};
use std::{
	collections::HashMap,
	io::Read,
	net::{TcpStream, ToSocketAddrs},
	path::Path,
	sync::{
		Arc, Mutex,
		atomic::AtomicU64,
	},
	time::{Duration, Instant},
};
use tracing::{info, warn};

use super::browse::SftpListing;

/// 建立 TCP 连接的超时，避免网络不可达时长时间无响应。
pub(crate) const CONNECT_TIMEOUT: Duration = Duration::from_secs(10);

/// 单次会话操作（握手 / 认证 / 读目录）的超时，防止界面一直等。
pub(crate) const SESSION_TIMEOUT_MS: u32 = 20_000;

/// 目录缓存有效期。跨公网的 readdir 一次就要一个 RTT（几百毫秒起），
/// 短时间内重复访问（返回上级、来回切换）直接命中缓存。
pub(super) const CACHE_TTL: Duration = Duration::from_secs(30);

/// 目录缓存条目上限，防止长时间浏览后内存无限增长。
pub(super) const CACHE_LIMIT: usize = 256;

/// 每次进入目录后，后台预热多少个子目录。
///
/// 预取会占用连接（同一条 SSH 连接上的请求是串行的），所以数量要小；
/// 用户一旦有新操作就会立刻让路（见 `spawn_prefetch`）。
pub(super) const PREFETCH_LIMIT: usize = 8;

/// 一条已建立的连接。
///
/// `Sftp` 之外还缓存了 uid/gid → 名称的映射：SFTP 的 `readdir` 只给数字 id，
/// 名字要从 `/etc/passwd`、`/etc/group` 查，连上后读一次即可长期复用。
pub(crate) struct Connection {
	pub(super) sftp: Arc<Sftp>,
	/// 同一条会话的句柄：SFTP 之外还要跑 shell 命令（磁盘用量 df/du）。
	/// ssh2 的 Session 非 Sync，用互斥锁串行化 exec。
	pub(super) session: Arc<Mutex<Session>>,
	pub(super) users: HashMap<u32, String>,
	pub(super) groups: HashMap<u32, String>,
}

/// 缓存的目录内容。
pub(super) struct CacheEntry {
	pub(super) listing: SftpListing,
	pub(super) at: Instant,
}

/// SFTP 连接池 + 目录缓存，key 为 `username@host:port`。
///
/// 缓存的是**已经打开的 `Sftp` 通道**而不是裸 `Session`：ssh2 0.9 起 `Sftp`
/// 不带生命周期参数，内部持有 `Arc<Mutex<SessionInner>>`，可以脱离局部
/// `Session` 变量长期存活（库已 `unsafe impl Send + Sync for Sftp`）。
#[derive(Default)]
pub struct SftpPool {
	/// 每个目标一条长连接（含已打开的 SFTP 通道与 id 映射）。
	pub(super) connections: Arc<Mutex<HashMap<String, Arc<Connection>>>>,
	/// 目录缓存，key 为 `username@host:port|远程路径`。
	pub(super) directories: Arc<Mutex<HashMap<String, CacheEntry>>>,
	/// 用户操作序号：自增即代表"用户又有新动作"，后台预取据此让路。
	pub(super) generation: Arc<AtomicU64>,
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

/// 取缓存连接；没有缓存时新建并登记。
///
/// 网络 IO 一律在**不持有 connections 锁**的情况下进行，避免一个慢连接
/// 阻塞其它会话。
pub(crate) fn obtain(
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
pub(super) fn remember(
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
pub(super) fn discard(
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
pub(super) fn connect(
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
pub(super) fn name_of(map: &HashMap<u32, String>, id: u32) -> String {
	map.get(&id).cloned().unwrap_or_else(|| id.to_string())
}
