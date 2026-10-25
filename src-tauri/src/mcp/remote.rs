//! MCP 子进程侧：经本地 HTTP bridge 调用 GUI 主进程。
//!
//! 子进程（`tera-shell-mcp`）不做业务，只把请求转发给主进程：
//!
//! 1. 读数据目录里的 `mcp_bridge.json` 拿到 `{ port, token }`；
//! 2. 用 reqwest 调 `http://127.0.0.1:{port}/api/...`，带 `Bearer <token>`；
//! 3. 把结果转成文本返回给 MCP 工具。
//!
//! 主进程没在线时（bridge 配置缺失 / 连接被拒），给出可读错误，让外部
//! agent 明白「先打开 tera-shell 主程序」。

use std::path::Path;

use serde::Deserialize;

use super::bridge::{BridgeConfig, OpenSessionMeta};

/// 读 bridge 配置失败的原因（主进程未运行 / 配置损坏）。
#[derive(Debug)]
pub enum BridgeError {
	/// 主进程未运行（没有 bridge 配置，或端口连不上）。
	NotRunning,
	/// 其它 IO / 序列化错误。
	Other(String),
}

impl std::fmt::Display for BridgeError {
	fn fmt(
		&self,
		f: &mut std::fmt::Formatter<'_>,
	) -> std::fmt::Result {
		match self {
			BridgeError::NotRunning => write!(
				f,
				"tera-shell 主程序未运行：请先打开 tera-shell 再重试"
			),
			BridgeError::Other(message) => {
				write!(f, "调用 tera-shell 失败：{message}")
			}
		}
	}
}

/// 从数据目录读 bridge 配置；缺失 / 损坏返回 `NotRunning`。
fn read_config(data_dir: &Path) -> Result<BridgeConfig, BridgeError> {
	let path = data_dir.join(super::bridge::BRIDGE_FILE);
	let text = std::fs::read_to_string(&path)
		.map_err(|_| BridgeError::NotRunning)?;
	serde_json::from_str(&text)
		.map_err(|_| BridgeError::Other("bridge 配置损坏".into()))
}

/// 构造带鉴权头的 reqwest client。
fn http_client() -> reqwest::Client {
	reqwest::Client::builder()
		// 本地桥只在 127.0.0.1，超时短一点，主进程没响应别让 agent 干等
		.timeout(std::time::Duration::from_secs(5))
		.build()
		.expect("构造 MCP bridge 客户端失败")
}

/// 调用主进程的 `GET /api/open_sessions`，返回已打开会话列表。
///
/// 主进程未运行 / 鉴权失败时返回 `Err`（工具据此把错误文本回给 agent）。
pub async fn open_sessions(
	data_dir: &Path,
) -> Result<Vec<OpenSessionMeta>, BridgeError> {
	let config = read_config(data_dir)?;
	let url = format!(
		"http://127.0.0.1:{}/api/open_sessions",
		config.port
	);
	let response = http_client()
		.get(&url)
		.header("Authorization", format!("Bearer {}", config.token))
		.send()
		.await
		.map_err(|_| BridgeError::NotRunning)?;
	if !response.status().is_success() {
		return Err(BridgeError::Other(format!(
			"主进程返回 HTTP {}",
			response.status()
		)));
	}
	let list: Vec<OpenSessionMeta> = response
		.json()
		.await
		.map_err(|error| BridgeError::Other(error.to_string()))?;
	Ok(list)
}

/// 探测主进程是否在线（`GET /api/health`）。
pub async fn healthy(data_dir: &Path) -> bool {
	let config = match read_config(data_dir) {
		Ok(config) => config,
		Err(_) => return false,
	};
	let url = format!("http://127.0.0.1:{}/api/health", config.port);
	match http_client().get(&url).send().await {
		Ok(response) => response.status().is_success(),
		Err(_) => false,
	}
}

/// 供测试注入的 `OpenSessionMeta` 反序列化（确认与主进程字段对齐）。
#[allow(dead_code)]
fn _assert_deserialize() {
	// OpenSessionMeta 在主进程侧 Serialize、子进程侧 Deserialize，
	// 两边字段名必须一致（camelCase）。这里不实际运行，仅让编译器
	// 确认类型可反序列化。
	fn check<T: for<'de> Deserialize<'de>>() {}
	check::<OpenSessionMeta>();
}

#[cfg(test)]
#[path = "../../tests/unit/mcp_remote.rs"]
mod tests;
