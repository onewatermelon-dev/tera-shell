//! 主机密钥校验（known_hosts）：SFTP 与 AI exec 通道的中间人防护。
//!
//! ## 为什么需要这一层
//!
//! 终端会话走系统 `ssh.exe`，主机密钥由 OpenSSH 自己按 `known_hosts`
//! 校验；内置 `ssh2`（libssh2）**默认完全不校验** —— 握手接受任何公钥，
//! 也就是说配了中间人的网络可以静默接管 SFTP 与 AI 命令通道，而终端那
//! 条路会正常报错。这里在握手之后、认证之前补一道检查，认证材料（密码、
//! 私钥签名）绝不会发给一个未经确认的主机。
//!
//! ## 为什么自己解析 known_hosts
//!
//! 不用 libssh2 的 `KnownHosts::read_file`：它内部用 `fopen` 打开文件，
//! Windows 上**中文用户名路径**（如 `C:\Users\黄志强\.ssh\known_hosts`）
//! 直接报 `Failed to open file` —— 真机上实测到的，表现为所有主机都判成
//! 「未记录」，strict 档全部误拒、accept-new 反复追加重复条目。
//! `std::fs` 走宽字符 API 没这个问题。自己解析还顺带拿到两件事：
//! 可以离线单测（不依赖真实 SSH 会话），以及支持 `@revoked` 标记。
//!
//! ## 三档策略（与设置页 `hostKeyPolicy` 一一对应）
//!
//! - `accept-new`：新主机记录指纹后继续（TOFU，与 `ssh` 的
//!   `StrictHostKeyChecking=accept-new` 一致，也是缺省值）；
//! - `ask`：新主机**拒绝**。终端里 ssh 会当场问 yes/no，但这条通道没有
//!   交互，所以提示用户先在终端连一次完成确认；
//! - `strict`：新主机拒绝，已记录主机必须匹配。
//!
//! 指纹**变更**在任何策略下都拒绝，不提供自动覆盖 —— 服务器重装时应该
//! 人工核对后删掉旧条目，否则「中间人换台机器」也会被当成正常重装放过去。
//!
//! ## 支持的 known_hosts 语法
//!
//! 明文主机名、逗号分隔的多别名、`[host]:port`、通配符 `*` / `?`、
//! `@revoked`。**不支持** `@cert-authority`（CA 签名校验）与 `|1|...`
//! hashed 主机名（需要 HMAC-SHA1 反推）；这两类行会被跳过并记 debug 日志，
//! 效果等同于「没有记录」→ 按策略处理（accept-new 会补一条明文条目）。

use ssh2::{HashType, HostKeyType, Session};
use std::{
	fs::{self, OpenOptions},
	io::{self, Write},
	path::{Path, PathBuf},
	sync::Mutex,
};
use tracing::{debug, info, warn};

/// 主机密钥校验策略。
///
/// 与前端 `settings.ts` 的 `HostKeyPolicy` 字面量一一对应，`parse` 是两边
/// 唯一的翻译点。
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum HostKeyPolicy {
	/// 新主机记录指纹后继续（TOFU，与 ssh 的 accept-new 一致）。
	#[default]
	AcceptNew,
	/// 新主机直接拒绝 —— 这条通道没有交互，提示用户先在终端确认。
	Ask,
	/// 新主机拒绝，已记录的主机必须完全匹配。
	Strict,
}

impl HostKeyPolicy {
	/// 把设置里的字符串解析成策略。
	///
	/// 缺省与**未知值**都回落到 `accept-new`：前端将来新增档位时，旧
	/// 后端不应该因为读不懂就退化成「全部拒绝」；同时也与终端 ssh 的
	/// 缺省行为保持一致。
	pub fn parse(
		value: Option<&str>
	) -> Self {
		match value
			.map(str::trim)
			.filter(|text| !text.is_empty())
		{
			Some("strict") => Self::Strict,
			Some("ask") => Self::Ask,
			_ => Self::AcceptNew,
		}
	}
}

/// known_hosts 里的一条记录。
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct KnownHost {
	/// 主机名模式（已拆开逗号；可能含 `*` / `?` / `[host]:port`）。
	pub patterns: Vec<String>,
	/// 公钥算法名。
	pub key_type: String,
	/// 解码后的公钥（SSH wire format）。
	pub blob: Vec<u8>,
	/// `@revoked` 行：同一把钥匙在此标记时视为已被吊销。
	pub revoked: bool,
}

/// 一次主机密钥比对的结果。
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum KeyCheck {
	/// 主机已记录，且公钥一致。
	Matched,
	/// 主机已记录，但同算法的公钥不同。
	Changed,
	/// 主机完全没有记录。
	Unknown,
	/// 主机有记录，但记录的是**别的算法**。
	///
	/// 真实场景：终端 ssh 协商 ed25519 并写入 known_hosts，而 libssh2
	/// 用 rsa 握手 —— 同一个主机，两种算法各自有独立记录。这不是篡改，
	/// 但也不该静默当成「新主机」，否则降级到弱算法会被无声接受。
	UnknownAlgorithm,
	/// 命中 `@revoked`：这把钥匙被显式吊销。
	Revoked,
}

/// `known_hosts` 的默认路径：`<主目录>/.ssh/known_hosts`。
///
/// 与系统 `ssh` 同一个文件 —— 用户在终端里确认过的主机，这里直接命中。
/// 拿不到主目录时返回 `None`（策略处理见 `verify_host_key`）。
pub fn known_hosts_path() -> Option<PathBuf> {
	let home = std::env::var_os(if cfg!(windows) {
		"USERPROFILE"
	} else {
		"HOME"
	})
	.or_else(|| std::env::var_os("HOME"))?;
	Some(
		PathBuf::from(home)
			.join(".ssh")
			.join("known_hosts"),
	)
}

/// 读并解析一份 known_hosts。
///
/// 文件不存在 → 空列表（首次使用是正常情况）；其它读错误 → `Err`，
/// 由 `verify_host_key` 按策略决定是否放行 —— 不能把「读不到」当成
/// 「没有记录」悄悄放过。
pub fn load_known_hosts(
	path: Option<&Path>
) -> Result<Vec<KnownHost>, String> {
	let Some(path) = path else {
		return Ok(Vec::new());
	};
	match fs::read_to_string(path) {
		Ok(text) => Ok(parse_known_hosts(&text)),
		Err(error)
			if error.kind() == io::ErrorKind::NotFound =>
		{
			Ok(Vec::new())
		}
		Err(error) => Err(format!(
			"读取 {} 失败：{error}",
			path.display()
		)),
	}
}

/// 解析 known_hosts 文本。
///
/// 宽容策略：单行看不懂就跳过，不让一行坏数据废掉整份文件（OpenSSH
/// 本身也是逐行处理）。跳过 hashed 与 CA 行时记 debug。
pub fn parse_known_hosts(
	text: &str
) -> Vec<KnownHost> {
	let mut out = Vec::new();
	// Windows 编辑器可能写入 UTF-8 BOM，不清掉会让第一行的主机名永远对不上
	let text = text.trim_start_matches('\u{feff}');
	for raw in text.lines() {
		let line = raw.trim();
		if line.is_empty() || line.starts_with('#') {
			continue;
		}
		let mut revoked = false;
		let mut body = line;
		if let Some(rest) = line.strip_prefix('@') {
			let mut parts =
				rest.splitn(2, char::is_whitespace);
			let marker = parts.next().unwrap_or_default();
			body = parts.next().unwrap_or_default().trim();
			match marker {
				"revoked" => revoked = true,
				// CA 签名校验需要完整的证书链支持，这里不做；
				// 当成「没有这条记录」比假装通过安全
				"cert-authority" => {
					debug!("跳过 @cert-authority 行（不支持 CA 校验）");
					continue;
				}
				_ => continue,
			}
		}
		let mut parts = body.split_whitespace();
		let (Some(hosts), Some(key_type), Some(encoded)) =
			(parts.next(), parts.next(), parts.next())
		else {
			continue;
		};
		let patterns: Vec<String> = hosts
			.split(',')
			.map(str::trim)
			.filter(|pattern| !pattern.is_empty())
			.filter(|pattern| {
				if pattern.starts_with("|1|") {
					// hashed：需要 HMAC-SHA1 才能反推，跳过
					debug!("跳过 hashed 主机名条目");
					false
				} else {
					true
				}
			})
			.map(str::to_string)
			.collect();
		if patterns.is_empty() {
			continue;
		}
		let Some(blob) = decode_base64(encoded) else {
			debug!(key_type, "跳过公钥解码失败的条目");
			continue;
		};
		out.push(KnownHost {
			patterns,
			key_type: key_type.to_string(),
			blob,
			revoked,
		});
	}
	out
}

/// base64 解码：known_hosts 里的公钥一般都带 padding，缺了也容忍。
fn decode_base64(
	value: &str
) -> Option<Vec<u8>> {
	use base64::Engine;
	base64::engine::general_purpose::STANDARD
		.decode(value)
		.ok()
		.or_else(|| {
			base64::engine::general_purpose::STANDARD_NO_PAD
				.decode(value)
				.ok()
		})
}

/// 比对一条主机模式是否命中 `host:port`。
///
/// OpenSSH 语义：不带端口的条目只匹配 22；`[host]:port` 只匹配该端口。
/// 少了这条，同一 IP 上不同端口的服务器会共用一个指纹（安全上不可接受）。
pub fn pattern_matches(
	pattern: &str,
	host: &str,
	port: u16
) -> bool {
	if let Some(rest) = pattern.strip_prefix('[') {
		let Some((inner, port_part)) = rest.split_once("]:")
		else {
			// `[host]` 缺端口：OpenSSH 视为非法条目
			return false;
		};
		let Ok(pattern_port) = port_part.parse::<u16>()
		else {
			return false;
		};
		return pattern_port == port
			&& wildcard_match(inner, host);
	}
	port == 22 && wildcard_match(pattern, host)
}

/// 通配符匹配：支持 `*`（任意串）与 `?`（单字符），大小写不敏感。
///
/// 双指针 + 回溯，避免为一个匹配引正则。OpenSSH 还支持 `[...]` 字符类，
/// 实际几乎没人用在主机名上，这里不支持（会当成字面量，导致不匹配）。
pub fn wildcard_match(
	pattern: &str,
	text: &str
) -> bool {
	let p: Vec<char> = pattern
		.chars()
		.flat_map(char::to_lowercase)
		.collect();
	let t: Vec<char> = text
		.chars()
		.flat_map(char::to_lowercase)
		.collect();
	let (mut pi, mut ti) = (0usize, 0usize);
	// 最近一个 `*` 的位置，以及它当时匹配到的文本位置（回溯用）
	let mut star: Option<usize> = None;
	let mut mark = 0usize;
	while ti < t.len() {
		if pi < p.len()
			&& (p[pi] == '?' || p[pi] == t[ti])
		{
			pi += 1;
			ti += 1;
		} else if pi < p.len() && p[pi] == '*' {
			star = Some(pi);
			mark = ti;
			pi += 1;
		} else if let Some(position) = star {
			// 回溯：让 `*` 多吃一个字符再试
			pi = position + 1;
			mark += 1;
			ti = mark;
		} else {
			return false;
		}
	}
	while pi < p.len() && p[pi] == '*' {
		pi += 1;
	}
	pi == p.len()
}

/// 拿当前主机的公钥去比对已记录条目。
///
/// 只按**同算法**比对：服务器新增一种算法（例如从 rsa 到 ed25519）时，
/// 旧条目不该被误判成「指纹变了」—— 与 OpenSSH 的按算法查找一致。
/// 但「主机有记录、只是没这个算法」要与「完全没记录」分开报，否则用户
/// 会看到「这台明明连过却被拒」且无从理解。
pub fn check_host_key(
	entries: &[KnownHost],
	host: &str,
	port: u16,
	key_type: &str,
	blob: &[u8]
) -> KeyCheck {
	let mut host_seen = false;
	let mut same_type_seen = false;
	for entry in entries {
		if !entry
			.patterns
			.iter()
			.any(|pattern| {
				pattern_matches(pattern, host, port)
			})
		{
			continue;
		}
		host_seen = true;
		if !entry.key_type.eq_ignore_ascii_case(key_type) {
			continue;
		}
		same_type_seen = true;
		if entry.blob == blob {
			return if entry.revoked {
				KeyCheck::Revoked
			} else {
				KeyCheck::Matched
			};
		}
	}
	if same_type_seen {
		KeyCheck::Changed
	} else if host_seen {
		KeyCheck::UnknownAlgorithm
	} else {
		KeyCheck::Unknown
	}
}

/// `known_hosts` 第一列的主机字段。
///
/// 22 端口写裸主机名；非 22 端口按 OpenSSH 约定写成 `[host]:port`，
/// 否则不同端口的服务器会共用一个指纹条目。
pub fn host_field(
	host: &str,
	port: u16
) -> String {
	if port == 22 {
		host.to_string()
	} else {
		format!("[{host}]:{port}")
	}
}

/// 当前会话主机公钥的 SHA256 指纹（`SHA256:xxxx`，无 base64 padding）。
///
/// 与 `ssh-keyscan` / `ssh` 首次连接时打印的格式一致，用户可以直接
/// 拿它和服务器管理员给的指纹逐字比对。
pub fn fingerprint(
	session: &Session
) -> Option<String> {
	use base64::Engine;
	let digest = session
		.host_key_hash(HashType::Sha256)?;
	Some(format!(
		"SHA256:{}",
		base64::engine::general_purpose::STANDARD_NO_PAD
			.encode(digest)
	))
}

/// 公钥算法名（`known_hosts` 第二列）。
///
/// 优先用 libssh2 给的类型；类型未知时退回解析公钥 blob 自带的算法名
/// —— blob 是 SSH wire format，前 4 字节是大端长度，紧随算法名字符串。
pub fn key_type_name(
	kind: HostKeyType,
	blob: &[u8]
) -> String {
	let known = match kind {
		HostKeyType::Rsa => Some("ssh-rsa"),
		HostKeyType::Dss => Some("ssh-dss"),
		HostKeyType::Ecdsa256 => {
			Some("ecdsa-sha2-nistp256")
		}
		HostKeyType::Ecdsa384 => {
			Some("ecdsa-sha2-nistp384")
		}
		HostKeyType::Ecdsa521 => {
			Some("ecdsa-sha2-nistp521")
		}
		HostKeyType::Ed25519 => Some("ssh-ed25519"),
		HostKeyType::Unknown => None,
	};
	known
		.map(str::to_string)
		.unwrap_or_else(|| {
			blob_algorithm(blob)
				.unwrap_or_else(|| "unknown".to_string())
		})
}

/// 从公钥 blob 里解析算法名（`key_type_name` 的兜底）。
fn blob_algorithm(
	blob: &[u8]
) -> Option<String> {
	let length = u32::from_be_bytes(
		blob.get(..4)?.try_into().ok()?,
	) as usize;
	let name = blob.get(4..4 + length)?;
	std::str::from_utf8(name)
		.ok()
		.map(str::to_string)
}

/// 拼一行 OpenSSH 格式的 `known_hosts` 条目（含行尾换行）。
pub fn known_host_line(
	host: &str,
	port: u16,
	key_type: &str,
	blob: &[u8]
) -> String {
	use base64::Engine;
	format!(
		"{} {} {}\n",
		host_field(host, port),
		key_type,
		base64::engine::general_purpose::STANDARD
			.encode(blob)
	)
}

/// 把一条主机密钥**追加**到 `known_hosts`。
///
/// 刻意不做整文件重写：那会丢掉注释与原始顺序，还会把 hashed 主机名
/// 改回明文。追加一行不碰既有内容，最坏情况只是多一条重复记录。
///
/// 写操作串行化（进程内），避免两条并发连接同时追加时行与行咬在一起；
/// 跨进程（用户同时在用系统 ssh）无法加锁，但单行追加足够短，实际风险
/// 只是极小概率出现半行 —— 那种行会被 ssh 当成格式错误忽略。
fn append_known_host(
	path: &Path,
	host: &str,
	port: u16,
	key_type: &str,
	blob: &[u8]
) -> std::io::Result<()> {
	static WRITE_LOCK: Mutex<()> = Mutex::new(());
	let _guard = WRITE_LOCK
		.lock()
		.unwrap_or_else(|error| error.into_inner());

	if let Some(parent) = path.parent() {
		fs::create_dir_all(parent)?;
	}
	// 上一行结尾没有换行时先补一个，否则新条目会粘在旧行尾变成非法行
	let needs_newline = fs::read(path)
		.map(|bytes| {
			bytes
				.last()
				.is_some_and(|byte| *byte != b'\n')
		})
		.unwrap_or(false);
	let mut file = OpenOptions::new()
		.create(true)
		.append(true)
		.open(path)?;
	if needs_newline {
		file.write_all(b"\n")?;
	}
	file.write_all(
		known_host_line(host, port, key_type, blob).as_bytes(),
	)
}

/// 校验一条**已握手**会话的主机密钥；不通过时返回可直接展示的错误。
///
/// 调用位置极其关键：必须在 `handshake()` 之后、`authenticate()` 之前。
/// 握手本身不发送任何凭据，所以「先握手、再验指纹、最后认证」的顺序
/// 意味着中间人拿不到密码，也拿不到私钥签名。
///
/// @param label 出错时用的主语（「目标主机」/「跳板机」），跳板链上
///   每一跳都要能看出是哪一节出的问题。
pub fn verify_host_key(
	session: &Session,
	host: &str,
	port: u16,
	policy: HostKeyPolicy,
	label: &str
) -> Result<(), String> {
	let Some((blob, kind)) = session.host_key() else {
		// 握完手却拿不到主机公钥 = 协议层异常，绝不能当成“没问题”
		return Err(format!(
			"{label} {host}:{port} 的主机公钥读取失败，已中止连接（无法完成指纹校验）"
		));
	};
	let key_type = key_type_name(kind, blob);
	let shown = fingerprint(session).unwrap_or_else(|| {
		"SHA256:（不可用）".to_string()
	});

	let path = known_hosts_path();
	let entries = match load_known_hosts(path.as_deref()) {
		Ok(entries) => entries,
		Err(error) => {
			warn!(host, port, "known_hosts 读取失败：{error}");
			// accept-new 本来就愿意信任新主机，读不到文件不该把连接堵死；
			// ask / strict 要求「已知主机」，读不到就 fail closed
			if policy != HostKeyPolicy::AcceptNew {
				return Err(format!(
					"{label} {host}:{port} 的主机密钥无法校验：{error}"
				));
			}
			Vec::new()
		}
	};

	let check = check_host_key(
		&entries, host, port, &key_type, blob,
	);
	match check {
		KeyCheck::Matched => {
			debug!(
				host,
				port,
				entries = entries.len(),
				fingerprint = %shown,
				"主机密钥匹配"
			);
			Ok(())
		}
		KeyCheck::Revoked => {
			warn!(
				host,
				port,
				fingerprint = %shown,
				"主机密钥已被 @revoked 吊销，拒绝连接"
			);
			Err(format!(
				"{label} {host}:{port} 的主机密钥已被 known_hosts 里的 @revoked 标记吊销，已拒绝连接。本次指纹：{shown}"
			))
		}
		KeyCheck::Changed => {
			warn!(
				host,
				port,
				fingerprint = %shown,
				"主机密钥与 known_hosts 记录不一致，拒绝连接"
			);
			Err(format!(
				"{label} {host}:{port} 的主机密钥与 known_hosts 记录不一致（可能是服务器重装，也可能是中间人攻击）。本次指纹：{shown}。请人工核对服务器指纹后删除 known_hosts 里的旧条目再连接。"
			))
		}
		KeyCheck::Unknown | KeyCheck::UnknownAlgorithm => {
			// 「有记录但没这个算法」在 accept-new 下照样追加（与 ssh
			// 一致），但先留一条 warn：这是排查算法降级的线索
			if check == KeyCheck::UnknownAlgorithm {
				warn!(
					host,
					port,
					key_type = %key_type,
					"该主机已记录其它算法的主机密钥，本次为 {key_type}"
				);
			}
			match policy {
				HostKeyPolicy::AcceptNew => {
					let written =
						path.as_deref().map(|file| {
							append_known_host(
								file,
								host,
								port,
								&key_type,
								blob,
							)
						});
					match written {
						Some(Ok(())) => info!(
							host,
							port,
							key_type = %key_type,
							fingerprint = %shown,
							"首次连接，已记录主机密钥"
						),
						// 记不住不等于不该连：accept-new 的语义就是信任新主机
						Some(Err(error)) => warn!(
							host,
							port,
							"主机密钥写入 known_hosts 失败（本次仍继续）：{error}"
						),
						None => warn!(
							host,
							port,
							"找不到 known_hosts 路径，本次跳过记录"
						),
					}
					Ok(())
				}
				HostKeyPolicy::Ask => Err(
					if check
						== KeyCheck::UnknownAlgorithm
					{
						format!(
							"{label} {host}:{port} 在 known_hosts 里有记录，但没有 {key_type} 的主机密钥（本通道协商到的算法与终端记录的不同）。请核对指纹后改用「新主机自动记住」，或手工把本次指纹加入 known_hosts。本次指纹：{shown}"
						)
					} else {
						format!(
							"{label} {host}:{port} 尚未记录主机密钥（当前策略：每次询问）。这个通道没有交互确认，请先在终端打开该会话连接一次（会自动记住指纹），或把主机密钥策略改为「新主机自动记住」。本次指纹：{shown}"
						)
					},
				),
				HostKeyPolicy::Strict => Err(
					if check
						== KeyCheck::UnknownAlgorithm
					{
						format!(
							"{label} {host}:{port} 在 known_hosts 里有记录，但没有 {key_type} 的主机密钥（本通道协商到的算法与终端记录的不同），当前策略为仅限已知主机，已拒绝连接。本次指纹：{shown}"
						)
					} else {
						format!(
							"{label} {host}:{port} 不在 known_hosts 中（当前策略：仅限已知主机），已拒绝连接。本次指纹：{shown}"
						)
					},
				),
			}
		}
	}
}

#[cfg(test)]
#[path = "../../tests/unit/ssh_hostkey.rs"]
mod tests;
