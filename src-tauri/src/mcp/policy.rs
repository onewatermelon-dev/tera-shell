//! MCP 命令执行的审批策略：自动执行开关 + 危险命令黑名单。
//!
//! 与内置 AI 面板的 `autoExecute` / `autoApply` / `blacklist` 同一套语义，
//! 但**独立存一份**（settings.json 的 `mcpAutoExecute` / `mcpAutoApply` /
//! `mcpBlacklist`）：MCP 来自外部进程，信任度低于用户当面与 AI 对话，
//! 默认更保守（全关 = 永远弹审批）。
//!
//! 黑名单判定复刻前端 `tools.rs` 的 `isBlacklisted`：扫描命令里每一个词
//! 的 basename（含 && ; | 拆出的后续命令与 sudo/env 前缀后的真命令），
//! 命中黑名单一票否决。

use serde::Deserialize;

/// settings.json 里 MCP 审批策略相关的字段。
#[derive(Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct RawMcpPolicy {
	/// 只读命令是否自动执行（不经审批）。
	#[serde(default)]
	mcp_auto_execute: bool,
	/// 读写命令是否自动应用（不经审批）。
	#[serde(default)]
	mcp_auto_apply: bool,
	/// 危险命令黑名单（命令名数组）。
	#[serde(default)]
	mcp_blacklist: Vec<String>,
}

/// 从 settings.json 读出 MCP 审批策略（缺失 / 损坏走全关 = 最保守）。
pub fn load_policy(data_dir: &std::path::Path) -> McpPolicy {
	let path = data_dir.join("settings.json");
	let Ok(text) = std::fs::read_to_string(&path) else {
		return McpPolicy::default();
	};
	let parsed: RawMcpPolicy =
		serde_json::from_str(&text).unwrap_or_default();
	McpPolicy {
		auto_execute: parsed.mcp_auto_execute,
		auto_apply: parsed.mcp_auto_apply,
		blacklist: parsed.mcp_blacklist,
	}
}

/// MCP 审批策略（读出的最终值）。
#[derive(Clone)]
pub struct McpPolicy {
	/// 只读命令自动执行。
	pub auto_execute: bool,
	/// 读写命令自动应用。
	pub auto_apply: bool,
	/// 危险命令黑名单（命中永不自动执行）。
	pub blacklist: Vec<String>,
}

impl Default for McpPolicy {
	fn default() -> Self {
		Self {
			// 默认全关：外部 agent 的命令一律弹审批，最保守
			auto_execute: false,
			auto_apply: false,
			blacklist: Vec::new(),
		}
	}
}

/// 命令是否命中黑名单（复刻前端 `isBlacklisted`）。
pub fn is_blacklisted(command: &str, blacklist: &[String]) -> bool {
	if blacklist.is_empty() {
		return false;
	}
	const SKIP: [&str; 7] = [
		"sudo", "doas", "env", "sh", "bash", "nohup", "xargs",
	];
	for token in command.split([' ', '\t', ';', '&', '|']) {
		let name = token
			.trim_matches(['"', '\''])
			.replace('\\', "/")
			.rsplit('/')
			.next()
			.unwrap_or("")
			.to_lowercase();
		if name.is_empty() {
			continue;
		}
		if SKIP.contains(&name.as_str()) {
			continue;
		}
		if blacklist.iter().any(|item| item.eq_ignore_ascii_case(&name)) {
			return true;
		}
	}
	false
}

/// 这条命令是否该**自动执行**（不弹审批）。
///
/// 与前端 `shouldAutoRun` 同一套规则：黑名单一票否决；只读看
/// auto_execute、读写看 auto_apply。
pub fn should_auto_run(
	command: &str,
	is_read_only: bool,
	policy: &McpPolicy,
) -> bool {
	if is_blacklisted(command, &policy.blacklist) {
		return false;
	}
	if is_read_only {
		policy.auto_execute
	} else {
		policy.auto_apply
	}
}

#[cfg(test)]
#[path = "../../tests/unit/mcp_policy.rs"]
mod tests;
