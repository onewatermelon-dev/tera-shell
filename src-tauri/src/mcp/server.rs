//! stdio MCP server：把本应用的**只读**能力暴露给外部 agent。
//!
//! 用 rmcp 的 `#[tool_router(server_handler)]` 声明工具，stdio transport
//! 走 `(stdin(), stdout())`。S1 阶段只暴露只读工具（`tera_list_sessions`），
//! 命令执行 / SFTP 在后续阶段经本地 HTTP + token 转发给 GUI 主进程审批。
//!
//! ⚠️ 工具名带 `tera_` 前缀，避免与外部 agent 自身或其它 MCP server 的
//! 工具重名。

use rmcp::{
	handler::server::wrapper::Parameters,
	schemars,
	tool,
	tool_router,
	ServiceExt,
};

use super::sessions::SessionMeta;

/// `tera_list_sessions` 的参数：空对象（列会话无需入参）。
#[derive(Debug, serde::Deserialize, schemars::JsonSchema)]
pub struct ListSessionsParams {}

/// `tera_list_open_sessions` 的参数：空对象。
#[derive(Debug, serde::Deserialize, schemars::JsonSchema)]
pub struct ListOpenSessionsParams {}

/// MCP 工具路由：只读会话能力。
#[derive(Clone, Default)]
pub struct TeraTools;

#[tool_router(server_handler)]
impl TeraTools {
	/// 列出已保存的 SSH / 本地会话（不含密码）。
	#[tool(description = "列出 tera-shell 里已保存的 SSH 会话与本地会话（不含密码等凭据），返回 id、名称、主机、端口、用户名。外部 agent 据此选会话执行后续操作。")]
	async fn tera_list_sessions(
		&self,
		_params: Parameters<ListSessionsParams>,
	) -> Result<String, String> {
		let sessions = super::sessions::list_sessions();
		if sessions.is_empty() {
			return Ok(
				"（没有已保存的会话）请先在 tera-shell 里添加 SSH 会话。"
					.to_string(),
			);
		}
		let rendered = render_sessions(&sessions);
		Ok(rendered)
	}

	/// 列出当前**已连接（打开中）**的会话（经本地 HTTP 桥问主进程）。
	#[tool(description = "列出 tera-shell 当前已连接（正在运行的终端标签）的会话，返回 id、主机、端口、用户名。需 tera-shell 主程序正在运行；用于区分「已保存」与「当前在线」的会话。")]
	async fn tera_list_open_sessions(
		&self,
		_params: Parameters<ListOpenSessionsParams>,
	) -> Result<String, String> {
		let data_dir = super::sessions::data_dir();
		let list = super::remote::open_sessions(&data_dir)
			.await
			.map_err(|error| error.to_string())?;
		if list.is_empty() {
			return Ok(
				"（当前没有已连接的会话）请在 tera-shell 里打开一个终端标签。"
					.to_string(),
			);
		}
		let metas: Vec<super::sessions::SessionMeta> =
			list
				.into_iter()
				.map(|meta| super::sessions::SessionMeta {
					id: meta.id,
					name: String::new(),
					kind: meta.kind,
					host: meta.host,
					port: meta.port,
					username: meta.username,
				})
				.collect();
		Ok(render_sessions(&metas))
	}
}

/// 把会话元数据渲染成给模型看的文本（每行一条，字段用 tab 分隔）。
///
/// 模型读起来比原始 JSON 更省 token，也更容易自行挑 id。
/// `name` 为空时跳过该字段（已打开会话没有持久化名字）。
fn render_sessions(sessions: &[SessionMeta]) -> String {
	let mut out = String::new();
	for session in sessions {
		if session.name.is_empty() {
			out.push_str(&format!(
				"id={}\tkind={}\thost={}\tport={}\tusername={}\n",
				session.id,
				session.kind,
				session.host,
				session.port,
				session.username,
			));
		} else {
			out.push_str(&format!(
				"id={}\tname={}\tkind={}\thost={}\tport={}\tusername={}\n",
				session.id,
				session.name,
				session.kind,
				session.host,
				session.port,
				session.username,
			));
		}
	}
	// 去掉末尾换行，避免多一个空行
	out.trim_end().to_string()
}

/// 启动 stdio MCP server：阻塞直到 stdin 关闭或服务退出。
pub async fn serve_stdio() -> anyhow::Result<()> {
	let transport = rmcp::transport::io::stdio();
	let server = TeraTools.serve(transport).await?;
	tracing::info!("tera-shell MCP server 已连接，等待外部 agent 请求");
	let quit = server.waiting().await?;
	tracing::info!(reason = ?quit, "tera-shell MCP server 退出");
	Ok(())
}
