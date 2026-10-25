//! tera-shell 的 MCP Server 独立二进制（方案 A：与 GUI 主程序分离）。
//!
//! 供 Claude Code / Cursor / Claude Desktop 等外部 agent 以 stdio 方式拉起：
//!
//! ```json
//! {
//!   "mcpServers": {
//!     "tera-shell": {
//!       "command": "tera-shell-mcp",
//!       "args": []
//!     }
//!   }
//! }
//! ```
//!
//! 与 GUI 主程序分离的原因：主程序 `main.rs` 有
//! `#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]`，
//! 会隐藏控制台导致 stdio 不可用；独立 bin 天然带 stdio。
//!
//! ⚠️ 此 bin 只做**只读**（列会话等）；命令执行 / SFTP 需 GUI 主进程在线，
//! 经本地 HTTP + token 转发并审批（后续阶段实现）。

#[tokio::main]
async fn main() -> anyhow::Result<()> {
	// MCP 子进程不依赖 Tauri，用环境变量开日志（默认 info，够定位握手问题）
	init_logging();
	tera_shell_lib::mcp::serve_stdio().await
}

/// 给 MCP 子进程装一个极简 tracing 订阅器（不依赖 Tauri 的日志初始化）。
///
/// 子进程没有 `infra::logging::init` 所需的 AppHandle，这里用
/// `tracing_subscriber` 直接初始化到 stderr —— 外部 agent 通常把子进程
/// 的 stderr 当日志看，这也符合「协议走 stdio、日志走 stderr」的惯例。
fn init_logging() {
	let _ = tracing_subscriber::fmt()
		.with_env_filter(
			tracing_subscriber::EnvFilter::try_from_default_env()
				.unwrap_or_else(|_| {
					tracing_subscriber::EnvFilter::new("info")
				}),
		)
		.with_writer(std::io::stderr)
		.try_init();
}
