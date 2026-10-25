//! MCP Client：让内置 AI 面板连接外部 MCP server，调用外部工具。
//!
//! 与 Server 侧（对外暴露）相反，这里 tera-shell 是 **MCP 客户端**：连接
//! 用户配置的外部 MCP server（stdio 子进程 或 streamable HTTP），`list_tools`
//! 拿工具清单注入 AI 面板的 tool schema，模型调用时经 `call_tool` 转发。
//!
//! 连接必须在 Rust 侧（前端 WebView2 不能 spawn stdio 子进程、不能自由发
//! HTTP），所以这里提供两个 tauri command：`mcp_client_list_tools` /
//! `mcp_client_call_tool`，前端经 invoke 调用。
//!
//! 外部 server 配置存 `mcp_servers.json`（数据目录），数组，每项：
//! ```json
//! { "name": "filesystem", "command": "npx", "args": ["-y", "@modelcontextprotocol/server-filesystem", "/tmp"] }
//! ```
//! 或远程：
//! ```json
//! { "name": "remote", "url": "http://localhost:3000/mcp" }
//! ```
//!
//! 第一版采用「每次调用连接、用完关闭」的简单策略（不缓存连接）：MCP 工具
//! 调用是低频操作，spawn 子进程的代价可接受，且避免了连接生命周期管理。

use std::path::Path;

use serde::{Deserialize, Serialize};

/// 外部 MCP server 配置。
#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct McpServerConfig {
	/// server 名。Claude Desktop 风格里名字在 mcpServers 的**键**上、
	/// 条目本身没有该字段 —— 必须 default，摊平后由代码赋值
	#[serde(default)]
	pub name: String,
	/// stdio 模式的启动命令（如 `npx` / `node` / 绝对路径）。
	#[serde(default)]
	pub command: Option<String>,
	/// stdio 模式的命令参数。
	#[serde(default)]
	pub args: Vec<String>,
	/// streamable HTTP 模式的端点 URL。
	#[serde(default)]
	pub url: Option<String>,
}

/// 读取外部 MCP server 配置列表；缺失 / 损坏返回空。
///
/// 兼容两种写法：
/// A. 裸数组 `[{ "name": "fs", "command": "npx", ... }, ...]`（自有格式）；
/// B. Claude Desktop 风格 `[{"mcpServers": {"名": {command, args}}}, ...]`
///    （用户从别的工具粘贴过来最常见）—— 摊平包裹层，键名即 server 名。
pub fn load_servers(data_dir: &Path) -> Vec<McpServerConfig> {
	let path = data_dir.join("mcp_servers.json");
	let Ok(text) = std::fs::read_to_string(&path) else {
		return Vec::new();
	};
	let value: serde_json::Value =
		match serde_json::from_str(&text) {
			Ok(value) => value,
			Err(_) => return Vec::new(),
		};
	let items = match value {
		serde_json::Value::Array(items) => items,
		serde_json::Value::Object(_) => vec![value],
		_ => return Vec::new(),
	};
	let mut out = Vec::new();
	for item in items {
		let serde_json::Value::Object(map) = item else {
			continue;
		};
		if map.contains_key("mcpServers") {
			// B：摊平包裹层
			if let Some(serde_json::Value::Object(servers)) =
				map.get("mcpServers")
			{
				for (name, config) in servers {
					if let Ok(mut parsed) =
						serde_json::from_value::<
							McpServerConfig,
						>(config.clone())
					{
						parsed.name = name.clone();
						out.push(parsed);
					}
				}
			}
			continue;
		}
		// A：直接一项一 server
		if let Ok(config) = serde_json::from_value::<
			McpServerConfig,
		>(serde_json::Value::Object(map))
		{
			out.push(config);
		}
	}
	out
}

/// 一个工具在 AI 面板侧的描述（name 已加 `mcp__<server>__` 前缀）。
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExternalTool {
	pub name: String,
	pub description: String,
	pub input_schema: serde_json::Value,
}

/// 工具名的 `mcp__` 前缀：外部工具与内置工具（run_command 等）区分开，
/// 也避免多个外部 server 之间重名。
pub const TOOL_PREFIX: &str = "mcp__";

/// 给工具名加 `mcp__<server>__` 前缀。
pub fn qualify(server: &str, tool: &str) -> String {
	format!("{TOOL_PREFIX}{server}__{tool}")
}

/// 把 rmcp 的 `Tool` 转成 AI 面板侧的外部工具描述（加前缀）。
fn externalize(server: &str, tool: rmcp::model::Tool) -> ExternalTool {
	ExternalTool {
		name: qualify(server, &tool.name),
		description: tool
			.description
			.as_deref()
			.unwrap_or("")
			.to_string(),
		// input_schema 是 Arc<JsonObject>，转成 Value
		input_schema: serde_json::Value::Object(
			tool.input_schema.as_ref().clone(),
		),
	}
}

/// 连接一个 stdio server（`command + args`），返回可调用的客户端。
///
/// 返回的 `RunningService` 必须**保持 alive**（drop 会断开连接），所以
/// 用 `tokio::spawn` 让它后台常驻，只把 `Peer` 句柄交出去。
async fn connect_stdio(
	command: &str,
	args: &[String],
) -> Result<rmcp::service::Peer<rmcp::RoleClient>, String> {
	use rmcp::ServiceExt;
	let mut cmd = tokio::process::Command::new(command);
	for arg in args {
		cmd.arg(arg);
	}
	#[cfg(target_os = "windows")]
	{
		// Windows 上 `npx` / `npm` 是 .cmd 脚本，`Command::new` 直接 spawn
		// 会报 program not found（GUI 进程的 PATH 里也没有 workbuddy 的
		// node 目录）。用 `cmd /c` 包装，走 shell 解析，与终端里手敲一致。
		let mut wrapped = tokio::process::Command::new("cmd");
		wrapped.arg("/c").arg(command);
		for arg in args {
			wrapped.arg(arg);
		}
		cmd = wrapped;
	}
	let transport =
		rmcp::transport::TokioChildProcess::new(cmd)
			.map_err(|error| format!("启动外部 MCP 进程失败：{error}"))?;
	let client = ()
		.serve(transport)
		.await
		.map_err(|error| format!("连接外部 MCP server 失败：{error}"))?;
	let peer = client.peer().clone();
	// 后台常驻：drop RunningService 会断开，这里 spawn 一个 task 等它结束
	tokio::spawn(async move {
		let _ = client.waiting().await;
	});
	Ok(peer)
}

/// 列出某个外部 server 的全部工具（name 已加前缀）。
pub async fn list_tools(
	data_dir: &Path,
	server_name: &str,
) -> Result<Vec<ExternalTool>, String> {
	let servers = load_servers(data_dir);
	let server = servers
		.iter()
		.find(|server| server.name == server_name)
		.ok_or_else(|| format!("未找到外部 MCP server：{server_name}"))?;

	let peer = connect(&server).await?;
	let tools = peer
		.list_all_tools()
		.await
		.map_err(|error| format!("列工具失败：{error}"))?;
	Ok(tools
		.into_iter()
		.map(|tool| externalize(server_name, tool))
		.collect())
}

/// 列出**所有**外部 server 的全部工具（合并，name 各带前缀）。
///
/// 供 AI 面板发送前一次性拉取全部外部工具。单个 server 连接失败时跳过
/// （记日志），不因一个坏 server 拖垮整批。
pub async fn list_all_tools(
	data_dir: &Path,
) -> Vec<ExternalTool> {
	let servers = load_servers(data_dir);
	let mut all = Vec::new();
	for server in &servers {
		match connect(server).await {
			Ok(peer) => match peer.list_all_tools().await {
				Ok(tools) => {
					all.extend(
						tools
							.into_iter()
							.map(|tool| {
								externalize(&server.name, tool)
							}),
					);
				}
				Err(error) => {
					tracing::warn!(
						server = %server.name,
						"列外部工具失败：{error}"
					);
				}
			},
			Err(error) => {
				tracing::warn!(
					server = %server.name,
					"连接外部 server 失败：{error}"
				);
			}
		}
	}
	all
}

/// 一次连通性检测的结果。
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConnectionTest {
	/// server 名。
	pub name: String,
	/// 是否连接成功。
	pub ok: bool,
	/// 失败原因（ok=false 时）。
	pub error: Option<String>,
	/// 连接成功后列出的工具数。
	pub tool_count: usize,
}

/// 检测单个外部 server 的连通性：连接 + 列工具。
///
/// 直接接收解析好的配置（前端从接入文本框摊平而来）—— 不查落盘文件，
/// 未保存的草稿也能测，也不存在「先写盘再读」的落盘竞态。
///
/// 返回结构化结果（不抛错），供设置页「检测」按钮展示。
pub async fn test_connection(
	server: &McpServerConfig,
) -> ConnectionTest {
	match connect(server).await {
		Ok(peer) => match peer.list_all_tools().await {
			Ok(tools) => ConnectionTest {
				name: server.name.clone(),
				ok: true,
				error: None,
				tool_count: tools.len(),
			},
			Err(error) => ConnectionTest {
				name: server.name.clone(),
				ok: false,
				error: Some(format!("列工具失败：{error}")),
				tool_count: 0,
			},
		},
		Err(error) => ConnectionTest {
			name: server.name.clone(),
			ok: false,
			error: Some(error),
			tool_count: 0,
		},
	}
}

/// 调用某个外部工具，返回文本结果。
///
/// `name` 是**带前缀的完整工具名**（如 `mcp__filesystem__read_file`），
/// `arguments` 是 JSON 对象。
pub async fn call_tool(
	data_dir: &Path,
	name: &str,
	arguments: serde_json::Map<String, serde_json::Value>,
) -> Result<String, String> {
	// 从带前缀的名字里拆出 server 名与原始工具名
	let (server_name, tool_name) = split_name(name)?;
	let servers = load_servers(data_dir);
	let server = servers
		.iter()
		.find(|server| server.name == server_name)
		.ok_or_else(|| format!("未找到外部 MCP server：{server_name}"))?;

	let peer = connect(&server).await?;
	let params = rmcp::model::CallToolRequestParams::new(tool_name.to_string())
		.with_arguments(arguments);
	// 超时上限：长任务工具（everything 的 trigger-long-running-operation）
	// 会持续发 progress 通知，个别 server/工具组合下最终响应迟迟不落；
	// 没有上限时前端永远「执行中」。120 秒足够任何合理长任务。
	// ponytail: 固定 120s，出现按工具配置时长的需求再引入 per-tool 超时
	let result = tokio::time::timeout(
		std::time::Duration::from_secs(120),
		peer.call_tool(params),
	)
	.await
	.map_err(|_| {
		format!("外部工具调用超时（120 秒）：{tool_name}")
	})?
	.map_err(|error| format!("调用工具失败：{error}"))?;

	// 提取文本内容
	let mut text = String::new();
	for block in &result.content {
		if let Some(value) = block.as_text() {
			if !text.is_empty() {
				text.push('\n');
			}
			text.push_str(&value.text);
		}
	}
	if result.is_error == Some(true) {
		return Err(if text.is_empty() {
			"外部工具返回错误".to_string()
		} else {
			text
		});
	}
	// 没有文本内容时，退回结构化内容
	if text.is_empty() {
		if let Some(structured) = &result.structured_content {
			text = structured.to_string();
		}
	}
	if text.is_empty() {
		text = "（工具无文本输出）".to_string();
	}
	Ok(text)
}

/// 从带前缀的名字拆出 `(server, tool)`。
fn split_name(name: &str) -> Result<(&str, &str), String> {
	let rest = name
		.strip_prefix(TOOL_PREFIX)
		.ok_or_else(|| format!("工具名缺少 {TOOL_PREFIX} 前缀：{name}"))?;
	let (server, tool) = rest
		.split_once("__")
		.ok_or_else(|| format!("工具名格式错误（缺 server__tool 分隔）：{name}"))?;
	if server.is_empty() || tool.is_empty() {
		return Err(format!("工具名格式错误：{name}"));
	}
	Ok((server, tool))
}

/// 按配置连接 server（stdio 或 streamable HTTP）。
async fn connect(
	server: &McpServerConfig,
) -> Result<rmcp::service::Peer<rmcp::RoleClient>, String> {
	if let Some(url) = server.url.as_deref().filter(|url| !url.trim().is_empty()) {
		return connect_http(url).await;
	}
	let command = server
		.command
		.as_deref()
		.filter(|command| !command.trim().is_empty())
		.ok_or_else(|| format!("server「{}」缺少 command 或 url", server.name))?;
	connect_stdio(command, &server.args).await
}

/// 连接一个 streamable HTTP server。
async fn connect_http(
	url: &str,
) -> Result<rmcp::service::Peer<rmcp::RoleClient>, String> {
	use rmcp::ServiceExt;
	let transport = rmcp::transport::StreamableHttpClientTransport::from_uri(
		url.to_string(),
	);
	let client = ()
		.serve(transport)
		.await
		.map_err(|error| format!("连接外部 MCP server 失败：{error}"))?;
	let peer = client.peer().clone();
	tokio::spawn(async move {
		let _ = client.waiting().await;
	});
	Ok(peer)
}

#[cfg(test)]
#[path = "../../tests/unit/mcp_client.rs"]
mod tests;
