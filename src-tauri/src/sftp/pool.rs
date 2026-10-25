//! SFTP 连接池：每条 `username@host:port` 维护一条长连接。
//!
//! 缓存的是已打开的 `Sftp` 通道与 uid/gid → 名称映射；网络 IO 一律在
//! 不持有池锁的情况下进行，避免一个慢连接阻塞其它会话。
//! 连接目标（含跳板链 / 私钥）与认证在 `crate::ssh`，与 AI 命令执行共用。

use ssh2::{Session, Sftp};
use std::{
	collections::HashMap,
	io::Read,
	path::Path,
	sync::{
		Arc, Mutex,
		atomic::AtomicU64,
	},
	time::{Duration, Instant},
};
use tracing::info;

use crate::ssh::{SshTarget, establish_session};

use super::browse::SftpListing;

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
#[derive(Default, Clone)]
pub struct SftpPool {
	/// 每个目标一条长连接（含已打开的 SFTP 通道与 id 映射）。
	pub(super) connections: Arc<Mutex<HashMap<String, Arc<Connection>>>>,
	/// 目录缓存，key 为 `username@host:port|远程路径`。
	pub(super) directories: Arc<Mutex<HashMap<String, CacheEntry>>>,
	/// 用户操作序号：自增即代表"用户又有新动作"，后台预取据此让路。
	pub(super) generation: Arc<AtomicU64>,
}

/// 取缓存连接；没有缓存时新建并登记。
///
/// 网络 IO 一律在**不持有 connections 锁**的情况下进行，避免一个慢连接
/// 阻塞其它会话。`target.key()` 已包含跳板链与私钥路径，直连与经跳板的
/// 同名目标不会互相命中。
pub(crate) fn obtain(
	connections: &Arc<Mutex<HashMap<String, Arc<Connection>>>>,
	target: &SshTarget,
) -> Result<Arc<Connection>, String> {
	let key = target.key();
	if let Some(connection) = cached(connections, &key) {
		info!(%key, "复用缓存的 SFTP 连接");
		return Ok(connection);
	}
	info!(%key, "新建 SFTP 连接");
	let connection = connect(target)?;
	remember(connections, &key, connection.clone());
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
/// 经跳板时，泵线程持有通道、通道持有跳板会话，生命周期同样跟着这条
/// 连接走。
pub(super) fn connect(
	target: &SshTarget,
) -> Result<Arc<Connection>, String> {
	let session = establish_session(target)?;
	// 通道只开一次并随连接缓存下来，后续浏览不再重复协商
	let sftp = session
		.sftp()
		.map_err(|error| format!("打开 SFTP 通道失败：{error}"))?;
	// uid/gid 名字映射（读不到就退化成显示数字，不影响浏览）
	let users = read_id_map(&sftp, "/etc/passwd");
	let groups = read_id_map(&sftp, "/etc/group");
	info!(
		target = %target.describe(),
		jumps = target.jump.len(),
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
