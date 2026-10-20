//! SSH 连接底座：SFTP 与 AI exec 通道共用。
//!
//! ## 为什么单独成模块
//!
//! 终端会话走系统 `ssh.exe`，天然支持 `-J` 跳板、`-i` 私钥与
//! `~/.ssh/config`；SFTP / AI 命令走内置 `ssh2`（libssh2）。过去两条路
//! 的连接能力不对齐：配了跳板机或只用私钥登录的会话，终端能连，SFTP 与
//! AI 却连不上。这里把跳板链与私钥认证补进 libssh2 一侧，两条路共用同一
//! 套目标描述（`SshTarget`）。
//!
//! ## 跳板是怎么实现的
//!
//! libssh2 没有「在一条 SSH 通道上再跑一个 SSH 会话」的现成 API。这里用
//! `direct-tcpip` 开一条到下一跳 22 端口的通道，再在本地建一对回环 TCP
//! （listener + connect）做字节泵：libssh2 的目标会话连回环的一端，泵把
//! 字节搬进通道。多跳就是把这个过程按「离客户端最近的一跳在前」的顺序
//! 重复一遍。
//!
//! 泵线程用**非阻塞** libssh2 会话（`set_blocking(false)`）单线程轮询：
//! libssh2 的同一个 `Session` 不能让两个线程同时阻塞读写 —— 一个线程堵在
//! `channel_read` 上会一直占着会话锁，另一个方向的写就永远发不出去。
//!
//! ⚠️ 本轮没有做 known_hosts 校验：与既有 SFTP / AI 通道一致，先保持
//! 行为不变；主机密钥校验应作为独立改动补上。

use ssh2::{Channel, KeyboardInteractivePrompt, Prompt, Session};
use std::{
	io::{self, Read, Write},
	net::{TcpListener, TcpStream, ToSocketAddrs},
	path::{Path, PathBuf},
	thread,
	time::Duration,
};
use tracing::{info, warn};

/// 建立 TCP 连接的超时，避免网络不可达时长时间无响应。
pub const CONNECT_TIMEOUT: Duration = Duration::from_secs(10);

/// 单次会话操作（握手 / 认证 / 读目录）的超时，防止界面一直等。
pub const SESSION_TIMEOUT_MS: u32 = 20_000;

/// 字节泵单个方向允许积压的上限：超过就暂停读另一侧，形成背压。
/// 256 KiB 对 SFTP 的大块读写足够，又不会让内存无界增长。
const PUMP_BUFFER_LIMIT: usize = 256 * 1024;

/// 字节泵没有数据可搬时的休眠间隔。2ms 对交互与文件传输都足够细腻，
/// 又不会把 CPU 跑满。
const PUMP_IDLE_SLEEP: Duration = Duration::from_millis(2);

/// 一跳跳板机的连接信息（离客户端最近的跳板在前）。
///
/// 字段全部可选是为了兼容旧调用方与手写请求；`SshTarget::new` 会统一
/// 归一化（默认 22 端口、root 用户）。
// 不派生 Debug：结构里含密码，避免将来 `{:?}` 意外把凭据写进日志。
#[derive(Clone, Default, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct JumpHop {
	pub host: String,
	pub port: Option<u16>,
	pub username: Option<String>,
	pub password: Option<String>,
}

impl JumpHop {
	/// 归一化后的主机名（去掉首尾空白）。
	pub fn host(&self) -> &str {
		self.host.trim()
	}

	/// 归一化后的端口：缺省 22。
	pub fn port(&self) -> u16 {
		self.port.unwrap_or(22)
	}

	/// 归一化后的用户名：缺省 root（与既有直连行为保持一致）。
	pub fn username(&self) -> &str {
		self
			.username
			.as_deref()
			.map(str::trim)
			.filter(|value| !value.is_empty())
			.unwrap_or("root")
	}

	/// 密码：空串按「没保存密码」处理。
	pub fn password(&self) -> Option<&str> {
		self
			.password
			.as_deref()
			.map(str::trim)
			.filter(|value| !value.is_empty())
	}
}

/// 一条 SSH 连接目标：目标主机 + 可选跳板链 + 可选私钥。
///
/// `key_path` 是全局设置里的默认私钥路径；跳板的每一跳也使用它（系统
/// `ssh -J` 的 `-i` 同样作用于整条链）。
// 不派生 Debug：同上，凭据只应出现在内存里。
#[derive(Clone)]
pub struct SshTarget {
	pub host: String,
	pub port: u16,
	pub username: String,
	pub password: Option<String>,
	pub key_path: Option<String>,
	pub jump: Vec<JumpHop>,
}

impl SshTarget {
	/// 构造并归一化一个连接目标。
	///
	/// 主机为空直接报错 —— 空主机拼出来的连接只会得到一条难懂的
	/// 「解析失败」，不如在这里给出明确原因。
	pub fn new(
		host: &str,
		port: Option<u16>,
		username: Option<&str>,
		password: Option<&str>,
		key_path: Option<&str>,
		jump: Vec<JumpHop>,
	) -> Result<Self, String> {
		let host = host.trim().to_string();
		if host.is_empty() {
			return Err("会话缺少主机地址".into());
		}
		let jump: Vec<JumpHop> = jump
			.into_iter()
			.map(|hop| {
				if hop.host().is_empty() {
					return Err("跳板机缺少主机地址".to_string());
				}
				Ok(hop)
			})
			.collect::<Result<_, _>>()?;
		Ok(Self {
			host,
			port: port.unwrap_or(22),
			username: normalize_username(username),
			password: normalize_password(password),
			key_path: normalize_key_path(key_path),
			jump,
		})
	}

	/// 连接池缓存键：目标 + 跳板链 + 私钥路径。
	///
	/// **不包含密码**：密码变了但目标没变时复用旧连接是既有行为
	/// （重新输密码的场景会先丢弃连接）。跳板链与私钥必须进 key，
	/// 否则「先直连、后配跳板」会错误命中旧连接。
	pub fn key(&self) -> String {
		let mut key = format!(
			"{}@{}:{}",
			self.username, self.host, self.port
		);
		if !self.jump.is_empty() {
			key.push_str("#jump=");
			key.push_str(
				&self
					.jump
					.iter()
					.map(|hop| {
						format!(
							"{}@{}:{}",
							hop.username(),
							hop.host(),
							hop.port()
						)
					})
					.collect::<Vec<_>>()
					.join(","),
			);
		}
		if let Some(key_path) = &self.key_path {
			key.push_str("#key=");
			key.push_str(key_path);
		}
		key
	}

	/// 给日志用的描述：**不含密码**。
	pub fn describe(&self) -> String {
		format!(
			"{}@{}:{}{}",
			self.username,
			self.host,
			self.port,
			if self.jump.is_empty() {
				String::new()
			} else {
				format!(
					"（经 {} 跳板）",
					self.jump.len()
				)
			}
		)
	}
}

/// 用户名归一化：空白按 root 处理（与既有 SFTP / AI 行为一致）。
fn normalize_username(username: Option<&str>) -> String {
	username
		.map(str::trim)
		.filter(|value| !value.is_empty())
		.unwrap_or("root")
		.to_string()
}

/// 密码归一化：空白按「没保存密码」处理。
fn normalize_password(password: Option<&str>) -> Option<String> {
	password
		.map(str::trim)
		.filter(|value| !value.is_empty())
		.map(str::to_string)
}

/// 私钥路径归一化：去空白、展开开头的 `~`。
fn normalize_key_path(key_path: Option<&str>) -> Option<String> {
	key_path
		.map(str::trim)
		.filter(|value| !value.is_empty())
		.map(expand_tilde)
}

/// 展开开头的 `~` / `~/`。
///
/// Windows 上 OpenSSH 的配置也常写 `~/.ssh/id_ed25519`，直接把它交给
/// libssh2 会当成相对路径；这里按当前用户主目录展开。
fn expand_tilde(value: &str) -> String {
	let Some(rest) = value.strip_prefix('~') else {
		return value.to_string();
	};
	// 只有 `~` 与 `~/...` 才算路径展开；`~user/...` 保持原样
	if !(rest.is_empty() || rest.starts_with('/') || rest.starts_with('\\')) {
		return value.to_string();
	}
	let home = std::env::var_os(if cfg!(windows) {
		"USERPROFILE"
	} else {
		"HOME"
	})
	.or_else(|| std::env::var_os("HOME"));
	let Some(home) = home else {
		return value.to_string();
	};
	let home = PathBuf::from(home);
	if rest.is_empty() {
		return home.to_string_lossy().into_owned();
	}
	home
		.join(rest.trim_start_matches(['/', '\\']))
		.to_string_lossy()
		.into_owned()
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

/// 建立一条**已认证**的 SSH 会话（含跳板链），不打开任何通道。
///
/// SFTP 与 AI 命令执行共用：认证策略一致 ——
/// 1. 有私钥路径时先试公钥（无 passphrase，再试一次「用保存的密码当
///    passphrase」，兼容把私钥口令存在会话密码里的用法）；
/// 2. 有密码时先 password、被拒后 keyboard-interactive；
/// 3. 最后回退 ssh-agent。
///
/// 跳板链按 `jump` 顺序连接：第一跳从本机直连，之后每一跳通过上一跳的
/// `direct-tcpip` 通道抵达。密码只在内存中使用，不进日志。
pub fn establish_session(
	target: &SshTarget,
) -> Result<Session, String> {
	let session = match target.jump.split_first() {
		None => {
			let session =
				tcp_session(&target.host, target.port).map_err(
					|error| {
						format!(
							"连接 {}:{} 失败：{error}",
							target.host, target.port
						)
					},
				)?;
			authenticate(
				&session,
				&target.host,
				target.port,
				&target.username,
				target.password.as_deref(),
				target.key_path.as_deref(),
				"目标主机",
			)?;
			return Ok(session);
		}
		Some((first, rest)) => {
			let session = tcp_session(
				first.host(),
				first.port(),
			)
			.map_err(|error| {
				format!(
					"连接跳板机 {}:{} 失败：{error}",
					first.host(),
					first.port()
				)
			})?;
			authenticate(
				&session,
				first.host(),
				first.port(),
				first.username(),
				first.password(),
				target.key_path.as_deref(),
				"跳板机",
			)?;
			let mut session = session;
			for hop in rest {
				let stream = channel_stream(
					&session,
					hop.host(),
					hop.port(),
				)
				.map_err(|error| {
					format!(
						"经上一跳连接跳板机 {}:{} 失败：{error}",
						hop.host(),
						hop.port()
					)
				})?;
				let next = session_over(stream)?;
				authenticate(
					&next,
					hop.host(),
					hop.port(),
					hop.username(),
					hop.password(),
					target.key_path.as_deref(),
					"跳板机",
				)?;
				session = next;
			}
			session
		}
	};
	let stream = channel_stream(
		&session,
		&target.host,
		target.port,
	)
	.map_err(|error| {
		format!(
			"经跳板连接目标 {}:{} 失败：{error}",
			target.host, target.port
		)
	})?;
	let target_session = session_over(stream)?;
	authenticate(
		&target_session,
		&target.host,
		target.port,
		&target.username,
		target.password.as_deref(),
		target.key_path.as_deref(),
		"目标主机",
	)?;
	info!(
		target = %target.describe(),
		jumps = target.jump.len(),
		"SSH 连接建立"
	);
	Ok(target_session)
}

/// 从本机直连 host:port，完成握手，返回未认证的会话。
fn tcp_session(
	host: &str,
	port: u16,
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
	.map_err(|error| error.to_string())?;
	// 小包往返为主的交互，关掉 Nagle 降低延迟
	let _ = tcp.set_nodelay(true);
	session_over(tcp)
}

/// 在一条已有 TCP 流上完成 SSH 握手。
fn session_over(stream: TcpStream) -> Result<Session, String> {
	let mut session =
		Session::new().map_err(|error| error.to_string())?;
	session.set_tcp_stream(stream);
	session.set_timeout(SESSION_TIMEOUT_MS);
	session
		.handshake()
		.map_err(|error| format!("SSH 握手失败：{error}"))?;
	Ok(session)
}

/// 经 `session` 开一条到 host:port 的 `direct-tcpip` 通道，并返回一条
/// 本地回环 TCP 连接作为 libssh2 的传输层。
///
/// 返回的连接另一端由字节泵线程持有；通道关闭时泵会让这条连接读到
/// EOF，目标会话随之失效。
fn channel_stream(
	session: &Session,
	host: &str,
	port: u16,
) -> Result<TcpStream, String> {
	// 本地回环做「通道 ↔ socket」的桥：libssh2 只接受 socket 作为
	// 传输层，通道本身不是 socket。
	let listener = TcpListener::bind(("127.0.0.1", 0))
		.map_err(|error| {
			format!("创建本地转发端口失败：{error}")
		})?;
	let address = listener
		.local_addr()
		.map_err(|error| error.to_string())?;
	let client = TcpStream::connect_timeout(
		&address,
		CONNECT_TIMEOUT,
	)
	.map_err(|error| {
		format!("连接本地转发端口失败：{error}")
	})?;
	let (server, _) = listener.accept().map_err(|error| {
		format!("接受本地转发连接失败：{error}")
	})?;
	let _ = client.set_nodelay(true);
	let _ = server.set_nodelay(true);

	// 通道必须在阻塞模式下建立；建立后再切成非阻塞交给泵线程
	let channel = session
		.channel_direct_tcpip(host, port, None)
		.map_err(|error| {
			format!(
				"跳板机拒绝转发到 {host}:{port}（检查 AllowTcpForwarding）：{error}"
			)
		})?;
	session.set_blocking(false);
	spawn_pump(channel, server);
	Ok(client)
}

/// 启动双向字节泵：本地 socket ↔ SSH 通道。
///
/// 单线程轮询 + 非阻塞读写，原因见模块头注释。两侧都设积压上限，
/// 一侧读得太快时暂停另一侧，避免内存无界增长。
fn spawn_pump(channel: Channel, server: TcpStream) {
	let _ = server.set_nonblocking(true);
	thread::spawn(move || {
		let mut reader = channel.clone();
		let mut writer = channel;
		let Ok(mut server_reader) = server.try_clone() else {
			return;
		};
		let mut server_writer = server;
		let mut to_remote: Vec<u8> = Vec::new();
		let mut to_local: Vec<u8> = Vec::new();
		let mut buffer = vec![0u8; 32 * 1024];
		loop {
			let mut progress = false;
			// 本地 → 跳板通道
			if to_remote.len() < PUMP_BUFFER_LIMIT {
				match server_reader.read(&mut buffer) {
					Ok(0) => break,
					Ok(bytes) => {
						to_remote.extend_from_slice(
							&buffer[..bytes],
						);
						progress = true;
					}
					Err(ref error)
						if error.kind()
							== io::ErrorKind::WouldBlock => {}
					Err(_) => break,
				}
			}
			if !to_remote.is_empty() {
				match writer.write(&to_remote) {
					Ok(bytes) if bytes > 0 => {
						to_remote.drain(..bytes);
						progress = true;
					}
					// 0 字节按「暂时写不动」处理，避免忙转
					Ok(_) => {}
					Err(ref error)
						if error.kind()
							== io::ErrorKind::WouldBlock => {}
					Err(_) => break,
				}
			}
			// 跳板通道 → 本地
			if to_local.len() < PUMP_BUFFER_LIMIT {
				match reader.read(&mut buffer) {
					Ok(0) => break,
					Ok(bytes) => {
						to_local
							.extend_from_slice(&buffer[..bytes]);
						progress = true;
					}
					Err(ref error)
						if error.kind()
							== io::ErrorKind::WouldBlock => {}
					Err(_) => break,
				}
			}
			if !to_local.is_empty() {
				match server_writer.write(&to_local) {
					Ok(bytes) if bytes > 0 => {
						to_local.drain(..bytes);
						progress = true;
					}
					Ok(_) => {}
					Err(ref error)
						if error.kind()
							== io::ErrorKind::WouldBlock => {}
					Err(_) => break,
				}
			}
			if !progress {
				thread::sleep(PUMP_IDLE_SLEEP);
			}
		}
		// 关掉通道，让远端进程组收到 EOF/关闭通知
		let _ = writer.close();
	});
}

/// 认证一条会话；成功返回 Ok，失败给出包含尝试过哪些方式的错误。
///
/// 这里不打印密码与私钥内容，日志只记主机与失败方式。
fn authenticate(
	session: &Session,
	host: &str,
	port: u16,
	username: &str,
	password: Option<&str>,
	key_path: Option<&str>,
	label: &str,
) -> Result<(), String> {
	let mut failures: Vec<String> = Vec::new();

	if let Some(key) = key_path {
		let key_file = Path::new(key);
		if key_file.is_file() {
			let public = PathBuf::from(format!(
				"{}.pub",
				key
			));
			let public = public
				.is_file()
				.then_some(public.as_path());
			// 先试无 passphrase，再把保存的密码当 passphrase 试一次：
			// 有些用户把私钥口令存在会话密码里（终端侧 ssh 提示符
			// 也是用同一个密码应答的）。
			let mut passphrases = vec![None];
			if let Some(password) = password {
				passphrases.push(Some(password));
			}
			let mut key_ok = false;
			for passphrase in passphrases {
				match session.userauth_pubkey_file(
					username,
					public,
					key_file,
					passphrase,
				) {
					Ok(()) if session.authenticated() => {
						key_ok = true;
						break;
					}
					Ok(()) => {}
					Err(error) => {
						// 只记最后一次失败原因，避免把整条链刷满
						warn!(
							host = %host,
							port,
							key = %key,
							"私钥认证未通过：{error}"
						);
					}
				}
			}
			if key_ok {
				info!(
					host = %host,
					port,
					username,
					"SSH 私钥认证通过"
				);
				return Ok(());
			}
			failures.push(format!(
				"私钥 {key} 未通过（可能带 passphrase，或服务器未授权该密钥）"
			));
		} else {
			failures.push(format!("私钥文件不存在：{key}"));
		}
	}

	if let Some(password) = password {
		let password_ok = session
			.userauth_password(username, password)
			.is_ok()
			&& session.authenticated();
		if password_ok {
			return Ok(());
		}
		// 不少服务器只开 keyboard-interactive，password 方法会被拒
		warn!(
			host = %host,
			port,
			"password 认证被拒，改用 keyboard-interactive 重试"
		);
		let mut prompter = PasswordPrompter {
			password: password.to_string(),
		};
		let interactive_ok = session
			.userauth_keyboard_interactive(
				username,
				&mut prompter,
			)
			.is_ok()
			&& session.authenticated();
		if interactive_ok {
			return Ok(());
		}
		failures.push(
			"密码被拒绝（已尝试 password 与 keyboard-interactive）"
				.to_string(),
		);
	}

	if password.is_none() {
		failures.push(
			"该会话没有保存密码".to_string(),
		);
	}
	if session.userauth_agent(username).is_ok()
		&& session.authenticated()
	{
		return Ok(());
	}
	failures.push("ssh-agent 未能通过认证".to_string());

	Err(format!(
		"SSH 认证失败（{label} {username}@{host}:{port}）：{}",
		failures.join("；")
	))
}

#[cfg(test)]
#[path = "../../tests/unit/ssh_target.rs"]
mod tests;
