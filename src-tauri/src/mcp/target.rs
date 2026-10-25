//! MCP 子进程 / 主进程共用：把「会话定义」解析成 AI exec 通道的连接目标。
//!
//! 前端在发起 AI 命令 / SFTP 时，会把会话 + 跳板引用链 + 全局私钥设置拼成
//! `ExecTarget` 传给后端。但 MCP 场景只有 `session_id`，这里在后端复刻同一条
//! 拼装逻辑：读 sessions.json → 解密码 → 摊平跳板链 → 读私钥/主机密钥策略。
//!
//! ⚠️ 只在主进程执行（DPAPI 解密绑定当前 Windows 用户）；子进程只经 HTTP
//! 转发，不自己碰凭据。

use serde::Deserialize;

use crate::ssh::JumpHop;

/// sessions.json 里一条会话的完整字段（含凭据与跳板引用）。
///
/// 与前端 `SavedSession` 对齐。密码是 DPAPI 密文（base64），跳板是另一个
/// 会话的 id 引用。
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct RawSession {
	id: String,
	#[serde(default)]
	kind: String,
	#[serde(default)]
	host: String,
	#[serde(default)]
	port: u16,
	#[serde(default)]
	username: String,
	#[serde(default)]
	password: Option<String>,
	#[serde(default)]
	jump_host_id: Option<String>,
}

/// settings.json 里我们关心的两个字段（私钥路径 + 主机密钥策略）。
#[derive(Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct RawSettings {
	#[serde(default)]
	ssh_key_path: String,
	#[serde(default)]
	host_key_policy: String,
}

/// 从 `sessions.json` 里读全部会话（宽松解析，坏数据跳过）。
fn load_sessions(data_dir: &std::path::Path) -> Vec<RawSession> {
	let path = data_dir.join("sessions.json");
	let Ok(text) = std::fs::read_to_string(&path) else {
		return Vec::new();
	};
	serde_json::from_str(&text).unwrap_or_default()
}

/// 从 `settings.json` 读私钥路径与主机密钥策略（缺失走默认）。
fn load_settings(data_dir: &std::path::Path) -> RawSettings {
	let path = data_dir.join("settings.json");
	let Ok(text) = std::fs::read_to_string(&path) else {
		return RawSettings::default();
	};
	serde_json::from_str(&text).unwrap_or_default()
}

/// 解析失败的原因：会话不存在 / 不是 SSH / 密码解不开等。
#[derive(Debug)]
pub enum TargetError {
	/// 会话 id 不存在（或不是 ssh 会话）。
	NotFound(String),
	/// 其它（如密码解密失败）。
	Other(String),
}

impl std::fmt::Display for TargetError {
	fn fmt(
		&self,
		f: &mut std::fmt::Formatter<'_>,
	) -> std::fmt::Result {
		match self {
			TargetError::NotFound(id) => {
				write!(f, "会话不存在或不是 SSH 会话：{id}")
			}
			TargetError::Other(message) => {
				write!(f, "构造连接目标失败：{message}")
			}
		}
	}
}

/// 解析一条会话的完整跳板链（离客户端最近的一跳在前）。
///
/// 复刻前端 `resolveJumpPath`：沿 `jump_host_id` 引用链追，防环 / 缺失
/// 降级为「不走跳板」。返回 `None` 表示不走跳板。
fn resolve_jump_path<'a>(
	from: &'a RawSession,
	sessions: &'a [RawSession],
) -> Option<Vec<&'a RawSession>> {
	let jump_id = from.jump_host_id.as_deref()?;
	let by_id: std::collections::HashMap<&str, &RawSession> =
		sessions
			.iter()
			.map(|session| (session.id.as_str(), session))
			.collect();
	// 防环：连 from 自己也算「已访问」
	let mut visited =
		std::collections::HashSet::new();
	visited.insert(from.id.as_str());
	let mut hops: Vec<&RawSession> = Vec::new();
	let mut next: Option<&str> = Some(jump_id);
	while let Some(id) = next {
		if visited.contains(id) {
			// 成环：不走跳板
			tracing::warn!(session = %from.id, "跳板链成环，不走跳板");
			return None;
		}
		visited.insert(id);
		let hop = by_id.get(id)?;
		if hop.kind != "ssh" || hop.host.trim().is_empty() {
			tracing::warn!(session = %from.id, "跳板不可用，不走跳板");
			return None;
		}
		hops.push(hop);
		next = hop.jump_host_id.as_deref();
	}
	// 引用链从目标往外追，连接要求最近的在前 —— 反转
	hops.reverse();
	if hops.is_empty() {
		None
	} else {
		Some(hops)
	}
}

/// 解密 DPAPI 密文；解密失败返回 `None`（交给私钥 / agent 认证）。
fn decrypt_password(cipher: Option<&str>) -> Option<String> {
	let cipher = cipher?;
	if cipher.trim().is_empty() {
		return None;
	}
	crate::infra::secret::decrypt(cipher.to_string()).ok()
}

/// 把会话定义解析成 `ai::ExecTarget`（含 command 与连接信息）。
///
/// `command` 由调用方传入；这里只负责填 host/port/username/password/
/// jump/key_path/host_key_policy。
pub fn build_exec_target(
	data_dir: &std::path::Path,
	session_id: &str,
	command: String,
) -> Result<crate::ai::ExecTarget, TargetError> {
	let sessions = load_sessions(data_dir);
	let session = sessions
		.iter()
		.find(|session| session.id == session_id)
		.ok_or_else(|| TargetError::NotFound(session_id.to_string()))?;

	if session.kind != "ssh" {
		return Err(TargetError::NotFound(format!(
			"{session_id}（本地会话不支持远程命令执行）"
		)));
	}

	let settings = load_settings(data_dir);

	// 跳板链：逐跳解密码，构造 JumpHop
	let jump: Vec<JumpHop> = resolve_jump_path(session, &sessions)
		.map(|hops| {
			hops.iter()
				.map(|hop| JumpHop {
					host: hop.host.trim().to_string(),
					port: Some(if hop.port == 0 { 22 } else { hop.port }),
					username: Some(
						hop.username.trim().to_string(),
					),
					password: decrypt_password(
						hop.password.as_deref(),
					),
				})
				.collect()
		})
		.unwrap_or_default();

	Ok(crate::ai::ExecTarget {
		host: session.host.trim().to_string(),
		port: Some(if session.port == 0 { 22 } else { session.port }),
		username: Some(session.username.trim().to_string()),
		password: decrypt_password(session.password.as_deref()),
		jump,
		key_path: if settings.ssh_key_path.trim().is_empty() {
			None
		} else {
			Some(settings.ssh_key_path.trim().to_string())
		},
		host_key_policy: if settings.host_key_policy.is_empty() {
			None
		} else {
			Some(settings.host_key_policy.clone())
		},
		command,
		stdin: None,
		exec_id: None,
		escalate_sudo_password: None,
		escalate_su_password: None,
	})
}

#[cfg(test)]
#[path = "../../tests/unit/mcp_target.rs"]
mod tests;
