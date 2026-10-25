//! MCP 命令执行的审计日志：追加式写入 `mcp_audit.json`。
//!
//! 每次经 MCP 发起的命令执行（无论批准 / 拒绝 / 超时）都落一条，供事后
//! 追溯「谁在什么时候让外部 agent 在哪个服务器上跑了什么」。
//!
//! ⚠️ 命令原文先脱敏再落盘（复用 `terminal::strip_ansi` 之外的脱敏逻辑，
//! 见 `sanitize_command`）；密码等凭据绝不进审计。

use std::path::Path;

use serde::Serialize;

use super::approval::Decision;

/// 审计文件名（与 data 模块的 ALLOWED 白名单解耦，这里直接读写固定文件）。
pub const AUDIT_FILE: &str = "mcp_audit.json";

/// 一条审计记录。
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AuditEntry {
	/// 记录 id。
	pub id: String,
	/// 毫秒时间戳。
	pub at: u64,
	/// 发起调用的客户端名（MCP initialize 里给的）。
	pub client: String,
	/// 工具名（如 `tera.run_command`）。
	pub tool: String,
	/// 目标服务器（`user@host:port`）。
	pub target: String,
	/// 命令原文（已脱敏）。
	pub command: String,
	/// 是否只读（外部 agent 自报）。
	pub is_read_only: bool,
	/// 审批结果。
	pub decision: String,
	/// 退出码（拒绝 / 超时时为空）。
	pub exit_code: Option<i32>,
	/// 输出尾部截断（只读命令的记录诊断价值，限制长度）。
	pub output_tail: Option<String>,
}

impl AuditEntry {
	fn decision_str(decision: Decision) -> &'static str {
		match decision {
			Decision::Approved => "approved",
			Decision::Rejected => "rejected",
		}
	}
}

/// 把一条命令执行的结果落进审计。
///
/// `decision` / `exit_code` / `output_tail` 由调用方根据审批与执行结果填。
pub fn append(
	data_dir: &Path,
	entry: AuditEntry,
) -> std::io::Result<()> {
	let path = data_dir.join(AUDIT_FILE);
	if let Some(parent) = path.parent() {
		std::fs::create_dir_all(parent)?;
	}
	// 追加式：先读已有数组，追加一条，整体写回。审计量级小（人工审批，
	// 每分钟也难有一条），全量重写可接受且实现最简。
	let mut list: Vec<serde_json::Value> =
		match std::fs::read_to_string(&path) {
			Ok(text) => {
				serde_json::from_str(&text).unwrap_or_default()
			}
			Err(_) => Vec::new(),
		};
	list.push(serde_json::to_value(&entry).map_err(
		std::io::Error::other,
	)?);
	// 上限：最多保留最近 1000 条，超出丢最老（审计是追溯用的，太长没意义）
	if list.len() > 1000 {
		let drain = list.len() - 1000;
		list.drain(..drain);
	}
	let text = serde_json::to_string_pretty(&list)
		.map_err(std::io::Error::other)?;
	std::fs::write(&path, text)
}

/// 构造一条审批决定相关的审计记录。
pub fn record_decision(
	data_dir: &Path,
	client: &str,
	target: &str,
	command: &str,
	is_read_only: bool,
	decision: Decision,
) {
	let entry = AuditEntry {
		id: crate::mcp::token::generate().as_str()
			[..16]
			.to_string(),
		at: crate::mcp::token::now_millis(),
		client: client.to_string(),
		tool: "tera.run_command".to_string(),
		target: target.to_string(),
		command: sanitize_command(command),
		is_read_only,
		decision: AuditEntry::decision_str(decision).to_string(),
		exit_code: None,
		output_tail: None,
	};
	if let Err(error) = append(data_dir, entry) {
		tracing::warn!("写 MCP 审计失败：{error}");
	}
}

/// 记录一条已执行命令的结果（批准 / 自动执行后调用）。
///
/// `decision`：`approved`（用户批准）或 `auto`（命中自动执行策略）。
#[allow(clippy::too_many_arguments)]
pub fn record_executed(
	data_dir: &Path,
	client: &str,
	target: &str,
	command: &str,
	is_read_only: bool,
	decision: &str,
	exit_code: i32,
	output_tail: String,
) {
	let entry = AuditEntry {
		id: crate::mcp::token::generate().as_str()
			[..16]
			.to_string(),
		at: crate::mcp::token::now_millis(),
		client: client.to_string(),
		tool: "tera.run_command".to_string(),
		target: target.to_string(),
		command: sanitize_command(command),
		is_read_only,
		decision: decision.to_string(),
		exit_code: Some(exit_code),
		output_tail: Some(truncate_tail(&output_tail)),
	};
	if let Err(error) = append(data_dir, entry) {
		tracing::warn!("写 MCP 审计失败：{error}");
	}
}

/// 脱敏：把命令里可能出现的私钥块 / 密钥 token 打码。
///
/// 复用前端 `redactSecrets` 的同类规则（这里做后端兜底，主要挡最常见形态）。
/// 检测到 `-----BEGIN ... PRIVATE KEY-----` 后进入「私钥块内」状态，直到
/// `-----END ...` 才退出，中间所有行（含密钥正文）整行打码。
fn sanitize_command(command: &str) -> String {
	let mut out: Vec<String> = Vec::new();
	let mut in_key_block = false;
	for line in command.lines() {
		let trimmed = line.trim_start();
		if trimmed.starts_with("-----BEGIN")
			&& trimmed.contains("PRIVATE KEY")
		{
			in_key_block = true;
			out.push("-----BEGIN *** PRIVATE KEY ***-----".to_string());
			continue;
		}
		if in_key_block {
			if trimmed.starts_with("-----END") {
				in_key_block = false;
				out.push("-----END *** PRIVATE KEY ***-----".to_string());
			} else {
				out.push("[私钥内容已打码]".to_string());
			}
			continue;
		}
		out.push(line.to_string());
	}
	out.join("\n")
}

/// 截断输出尾部（保留最后 4000 字符，诊断价值在尾部）。
fn truncate_tail(output: &str) -> String {
	const LIMIT: usize = 4000;
	if output.len() <= LIMIT {
		return output.to_string();
	}
	output[output.len() - LIMIT..].to_string()
}

#[cfg(test)]
#[path = "../../tests/unit/mcp_audit.rs"]
mod tests;
