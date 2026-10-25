//! MCP / 外部 agent 双向接入的门面。
//!
//! 两个方向：
//! - **Server（对外暴露）**：`tera-shell-mcp` 独立二进制，stdio MCP server，
//!   让 Claude Code / Cursor 等外部 agent 调用本应用的会话查询 / 命令执行 /
//!   SFTP 能力。协议层（本 crate 的 `serve_stdio`）与业务层（GUI 主进程）
//!   分离，业务经本地 HTTP + token 转发，命令执行在主窗口交互式审批。
//! - **Client（调用外部）**：`client` 子模块，让内置 AI 面板连接外部 MCP
//!   server（S6 起实现）。
//!
//! 子进程只做**只读**（列会话 / 读元数据）；任何命令执行与 SFTP 都经
//! 主进程审批后放行。

pub mod approval;
pub mod audit;
pub mod bridge;
pub mod policy;
pub mod remote;
pub mod sessions;
pub mod target;
pub mod token;

use std::sync::Arc;

/// 启动 stdio MCP server（`tera-shell-mcp` 二进制的入口）。
///
/// 独立 bin 与 GUI 主进程分离（方案 A）：GUI 保持 `windows_subsystem =
/// "windows"` 不隐藏控制台，MCP 走独立二进制、天然带 stdio。此函数被
/// `src/bin/tera-shell-mcp.rs` 调用，在 `#[tokio::main]` 里跑。
pub async fn serve_stdio() -> anyhow::Result<()> {
	tracing::info!("tera-shell MCP server 启动（stdio）");
	server::serve_stdio().await
}

/// 在 GUI 主进程里启动 MCP bridge：生成 token、起本地 HTTP 服务、写
/// bridge 配置（端口 + token）供子进程读取。
///
/// 由 `lib.rs` 的 `run()` 在 `.setup` 里调用。`open` 是已 `.manage` 的
/// `OpenSessions` 状态（与 `terminal::start` 共享同一实例）。
pub fn start_bridge(app: &tauri::AppHandle, open: bridge::OpenSessions) {
	use tauri::Manager;
	let data_dir = crate::data::resolve_data_dir_from(
		&app.path().home_dir().unwrap_or_default(),
	);

	// 从 Tauri 状态取执行池与审批表（与 ai::run_command 共用同一实例）。
	let exec = app
		.state::<crate::ai::ExecPool>()
		.inner()
		.clone();
	let approvals = app
		.state::<approval::Approvals>()
		.inner()
		.clone();
	let app_handle = app.clone();

	// 生成 token：优先复用磁盘上已有的（GUI 重启后子进程里缓存的旧 token
	// 还能用），没有才新生成并持久化。
	let token = token::load(&data_dir).unwrap_or_else(|| {
		let fresh = token::generate();
		if let Err(error) = token::persist(&data_dir, &fresh) {
			tracing::warn!(
				"持久化 MCP token 失败（改用内存态）：{error}"
			);
		}
		fresh
	});

	// 绑定随机端口（0 = 由 OS 分配），拿到实际端口后写 bridge 配置。
	let token_clone = token.clone();
	let data_dir_clone = data_dir.clone();
	tauri::async_runtime::spawn(async move {
		// 先 bind 0 拿端口，再把端口写进 bridge 文件，最后跑 server。
		let listener =
			match tokio::net::TcpListener::bind(
				std::net::SocketAddr::from(([127, 0, 0, 1], 0u16)),
			)
			.await
			{
				Ok(listener) => listener,
				Err(error) => {
					tracing::error!("MCP bridge 绑定端口失败：{error}");
					return;
				}
			};
		let port = match listener.local_addr() {
			Ok(addr) => addr.port(),
			Err(_) => {
				tracing::error!("MCP bridge 获取端口失败");
				return;
			}
		};

		let config = bridge::BridgeConfig {
			port,
			token: token_clone.clone(),
		};
		if let Err(error) =
			write_bridge_config(&data_dir_clone, &config)
		{
			tracing::error!("写 MCP bridge 配置失败：{error}");
			return;
		}

		tracing::info!(port, "MCP bridge 端口已写入配置");

		// 用已经 bind 好的 listener 直接 serve。
		let state = Arc::new(bridge::serve_state(
			token_clone,
			open,
			exec,
			approvals,
			app_handle,
			data_dir_clone,
		));
		let app = bridge::router(state);
		if let Err(error) = axum::serve(listener, app).await {
			tracing::error!("MCP bridge 运行失败：{error}");
		}
	});
}

/// 写 bridge 配置到数据目录 `mcp_bridge.json`。
fn write_bridge_config(
	data_dir: &std::path::Path,
	config: &bridge::BridgeConfig,
) -> std::io::Result<()> {
	let path = data_dir.join(bridge::BRIDGE_FILE);
	if let Some(parent) = path.parent() {
		std::fs::create_dir_all(parent)?;
	}
	let text = serde_json::to_string_pretty(config)
		.map_err(std::io::Error::other)?;
	std::fs::write(&path, text)
}

/// 读 settings.json 的 `mcpEnabled`：是否启用 MCP Server（缺省开）。
///
/// 在 `.setup` 里据此决定要不要启动 bridge。设置是前端管理的，这里直接
/// 读盘判断（与 proxy 读取同一份 settings.json）。
pub fn enabled_in_settings(app: &tauri::AppHandle) -> bool {
	use tauri::Manager;
	let data_dir = crate::data::resolve_data_dir_from(
		&app.path().home_dir().unwrap_or_default(),
	);
	let path = data_dir.join("settings.json");
	let Ok(text) = std::fs::read_to_string(&path) else {
		// 读不到（首次启动）按缺省开处理
		return true;
	};
	let Ok(value) = serde_json::from_str::<serde_json::Value>(&text) else {
		return true;
	};
	match value.get("mcpEnabled") {
		Some(serde_json::Value::Bool(enabled)) => *enabled,
		// 字段缺失 / 类型不对：缺省开
		_ => true,
	}
}

mod server;

/// 前端回传 MCP 审批决定（审批卡上点「执行 / 拒绝」）。
///
/// `request_id` 来自 `mcp-approval-request` 事件，`decision` 为
/// `approved` / `rejected`。返回是否命中 pending（未命中 = 已超时或 id 错）。
#[tauri::command(rename = "mcp_approval_respond")]
pub fn approval_respond(
	approvals: tauri::State<'_, approval::Approvals>,
	request_id: String,
	decision: String,
) -> Result<bool, String> {
	let decision = match decision.as_str() {
		"approved" => approval::Decision::Approved,
		"rejected" => approval::Decision::Rejected,
		other => {
			return Err(format!("未知的审批决定：{other}"));
		}
	};
	Ok(approvals.respond(&request_id, decision))
}

/// 重置 MCP 访问令牌：生成新 token 并持久化。
///
/// ⚠️ 正在运行的 bridge 仍持旧 token，**重启应用后新 token 才生效** ——
/// 重置本身就是为了作废旧凭据，重启保证干净。返回新 token（供 UI 展示
/// 「已重置」提示，不返回也行，这里给调用方留痕）。
#[tauri::command(rename = "mcp_reset_token")]
pub fn reset_token(app: tauri::AppHandle) -> Result<String, String> {
	use tauri::Manager;
	let data_dir = crate::data::resolve_data_dir_from(
		&app.path().home_dir().unwrap_or_default(),
	);
	let fresh = token::generate();
	token::persist(&data_dir, &fresh)
		.map_err(|error| format!("写入新令牌失败：{error}"))?;
	// 同时清掉 bridge 配置里的旧 token，避免重启前子进程用旧 token 连旧端口
	let bridge_path = data_dir.join(bridge::BRIDGE_FILE);
	let _ = std::fs::remove_file(&bridge_path);
	tracing::info!("MCP 令牌已重置（重启应用后生效）");
	Ok(fresh)
}
