//! MCP Server 的一次性访问令牌：生成、校验与常量比较。
//!
//! GUI 主进程在启用 MCP Server 时生成一个随机令牌，MCP 子进程经环境变量
//! `TERA_MCP_TOKEN` 拿到它，之后每次通过本地 HTTP 调用主进程时都带上
//! `Authorization: Bearer <token>`。主进程校验通过才放行。
//!
//! 令牌只应出现在内存与数据目录的 `mcp_token.json`，**绝不进日志**。

use std::time::{SystemTime, UNIX_EPOCH};

/// 令牌在数据目录里的文件名（与 `data` 模块的 ALLOWED 白名单解耦，
/// MCP 子进程直接读这个固定文件，不经过 `load_all`）。
pub const TOKEN_FILE: &str = "mcp_token.json";

/// 令牌数据文件里的字段名（`dataDir` 风格，与 location.json 一致）。
const TOKEN_KEY: &str = "token";

/// 生成一个新的随机令牌。
///
/// 用 32 字节加密级随机数（`rand` 的 `RngCore`，复用项目已有的
/// `rand 0.8` 依赖），hex 编码成 64 字符 —— 足够长、不可预测，且只含
/// `[0-9a-f]`，放进 JSON / 环境变量 / HTTP 头都不会有转义问题。
pub fn generate() -> String {
	use rand::RngCore;
	let mut bytes = [0u8; 32];
	rand::rngs::OsRng.fill_bytes(&mut bytes);
	hex_encode(&bytes)
}

/// 校验一个候选令牌是否与给定令牌**完全一致**。
///
/// 用**常量时间比较**（逐字节异或累计），避免时序侧信道泄露令牌前缀。
/// 两边都为空时返回 false —— 空令牌永远不该被放行。
pub fn verify(expected: &str, candidate: &str) -> bool {
	if expected.is_empty() || candidate.is_empty() {
		return false;
	}
	if expected.len() != candidate.len() {
		return false;
	}
	let mut diff = 0u8;
	for (a, b) in expected.bytes().zip(candidate.bytes()) {
		diff |= a ^ b;
	}
	diff == 0
}

/// 从环境变量 `TERA_MCP_TOKEN` 读取令牌；缺失或为空返回 `None`。
pub fn from_env() -> Option<String> {
	std::env::var("TERA_MCP_TOKEN")
		.ok()
		.map(|value| value.trim().to_string())
		.filter(|value| !value.is_empty())
}

/// 把令牌写成数据目录下的 `mcp_token.json`。
///
/// `data_dir` 是已带 `.tera-shell` 后缀的目录。写失败返回错误（调用方
/// 决定是忽略还是让 MCP Server 不可用）。
pub fn persist(data_dir: &std::path::Path, token: &str) -> std::io::Result<()> {
	let path = data_dir.join(TOKEN_FILE);
	if let Some(parent) = path.parent() {
		std::fs::create_dir_all(parent)?;
	}
	let json = serde_json::json!({ TOKEN_KEY: token });
	let text = serde_json::to_string_pretty(&json)
		.map_err(std::io::Error::other)?;
	std::fs::write(&path, text)
}

/// 从数据目录读取令牌；文件缺失 / 解析失败 / 字段为空都返回 `None`。
pub fn load(data_dir: &std::path::Path) -> Option<String> {
	let text = std::fs::read_to_string(data_dir.join(TOKEN_FILE)).ok()?;
	let value: serde_json::Value = serde_json::from_str(&text).ok()?;
	let token = value.get(TOKEN_KEY)?.as_str()?.trim().to_string();
	if token.is_empty() {
		None
	} else {
		Some(token)
	}
}

/// 删除令牌文件（用户点「禁用 / 重置」时用）。
pub fn clear(data_dir: &std::path::Path) {
	let _ = std::fs::remove_file(data_dir.join(TOKEN_FILE));
}

/// 把字节数组编码成小写 hex 字符串。
fn hex_encode(bytes: &[u8]) -> String {
	const HEX: &[u8; 16] = b"0123456789abcdef";
	let mut out = String::with_capacity(bytes.len() * 2);
	for &byte in bytes {
		out.push(HEX[(byte >> 4) as usize] as char);
		out.push(HEX[(byte & 0x0f) as usize] as char);
	}
	out
}

/// 当前毫秒时间戳（审计条目等场合用）。
///
/// ⚠️ 不要在这里手算 —— 时钟以系统为准，取不到时返回 0，由调用方兜底。
pub fn now_millis() -> u64 {
	SystemTime::now()
		.duration_since(UNIX_EPOCH)
		.map(|duration| duration.as_millis() as u64)
		.unwrap_or(0)
}

#[cfg(test)]
#[path = "../../tests/unit/mcp_token.rs"]
mod tests;
