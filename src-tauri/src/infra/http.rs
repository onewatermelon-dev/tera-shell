//! 通用 HTTP 出口：目前供模型连通性测试使用。
//!
//! 为什么不走前端 fetch：WebView2 里那是跨域请求，模型网关普遍不带
//! CORS 响应头，请求会被浏览器拦下、原因还被 catch 吞掉。
//! 从 Rust 侧发请求没有这层限制，并且每一步都有日志可查。

use std::collections::HashMap;
use std::time::Duration;

use tracing::{error, info};

/// 以 JSON 体 POST 一次，返回 HTTP 状态码；网络层错误返回 `Err(原因)`。
#[tauri::command]
pub async fn http_post_json(
	url: String,
	headers: HashMap<String, String>,
	body: serde_json::Value,
) -> Result<u16, String> {
	// 请求体一并记录（不含鉴权头）：网关说 model_not_found 而用户确认名字没错时，
	// 唯一能分辨「发出去的名字到底是什么」的就是这一行
	info!(
		url = %url,
		body = %body,
		"发起 HTTP POST（模型连通性测试）"
	);
	let client = reqwest::Client::builder()
		.timeout(Duration::from_secs(15))
		.build()
		.map_err(|error| error.to_string())?;
	let mut request = client.post(&url).json(&body);
	for (name, value) in &headers {
		request = request.header(name.as_str(), value.as_str());
	}
	match request.send().await {
		Ok(response) => {
			let status = response.status();
			info!(url = %url, status = %status, "HTTP POST 收到响应");
			if status.is_success() {
				return Ok(status.as_u16());
			}
			// 非 2xx 把网关的报错正文带回去：光有状态码定位不了
			// （400 可能是参数、格式、模型名等一堆原因）。
			// 正文同时进日志，后端日志里也能直接看到拒绝原因
			let text = response.text().await.unwrap_or_default();
			let snippet: String = text.chars().take(200).collect();
			error!(
				url = %url,
				status = %status,
				body = %snippet,
				"HTTP POST 非 2xx 响应"
			);
			Err(format!("HTTP {}: {}", status.as_u16(), snippet))
		}
		Err(error) => {
			error!(url = %url, error = %error, "HTTP POST 失败");
			Err(error.to_string())
		}
	}
}
