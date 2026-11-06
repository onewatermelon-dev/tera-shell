//! Bangumi（bgm.tv）开放 API 的取数通道。
//!
//! 只做一层薄代理：前端拼相对路径，这里统一补 `https://api.bgm.tv` 前缀、
//! 设置可识别的 User-Agent（官方 API 规范要求）与可选的 Bearer 个人令牌，
//! 把状态码和原始 JSON 文本原样带回。路径做白名单式校验（只收本站相对路径），
//! 防止被当成任意 URL 代理。
//!
//! ## 为什么走后端而不是 WebView 直接 fetch
//!
//! WebView 里页面的源是 tauri 自定义源，api.bgm.tv 是否返回 CORS 头不受我们
//! 控制；而且浏览器侧根本改不了 User-Agent 这个头。统一走 Rust 客户端
//! （复用全局代理设置），两个问题一起消失。

use serde::Serialize;

/// 与 anime.rs 一致的请求超时。
const REQUEST_TIMEOUT: std::time::Duration =
	std::time::Duration::from_secs(20);

/// 响应体上限：放送日历全量约 200KB，2MB 已经很宽裕。
const MAX_BODY_BYTES: usize = 2 * 1024 * 1024;

/// API 规范要求的可识别 UA：项目名/版本 + 用途。
const USER_AGENT: &str = concat!(
	"tera-shell/",
	env!("CARGO_PKG_VERSION"),
	" (anime calendar & progress sync)"
);

/// 状态码 + 原始响应文本；JSON 解析交给前端（错误体也常是 JSON）。
#[derive(Serialize)]
pub struct BgmResponse {
	pub status: u16,
	pub body: String,
}

/// 取一个 Bangumi 开放 API 资源。
///
/// `path` 必须以 `/` 开头、无协议前缀与空白；`token` 是用户在
/// next.bgm.tv/demo/access-token 生成的个人令牌（公开接口可不带）；
/// `body` 非 null 时作为 JSON 请求体发送（POST/PUT 由调用方通过 method 声明）。
#[tauri::command(rename = "bgm_fetch")]
pub async fn bgm_fetch(
	app: tauri::AppHandle,
	method: String,
	path: String,
	token: Option<String>,
	body: Option<serde_json::Value>,
) -> Result<BgmResponse, String> {
	if !path.starts_with('/')
		|| path.contains("://")
		|| path.contains(char::is_whitespace)
	{
		return Err("path 必须是 api.bgm.tv 的相对路径".into());
	}
	let method = match method.to_ascii_uppercase().as_str() {
		"GET" => reqwest::Method::GET,
		"POST" => reqwest::Method::POST,
		"PUT" => reqwest::Method::PUT,
		_ => return Err("method 只支持 GET/POST/PUT".into()),
	};
	let client = crate::infra::proxy::client_for(&app, Some(REQUEST_TIMEOUT))?;
	let mut request = client
		.request(method, format!("https://api.bgm.tv{path}"))
		.header("User-Agent", USER_AGENT)
		.header("Accept", "application/json");
	if let Some(token) = token.as_deref().map(str::trim).filter(|t| !t.is_empty()) {
		request = request.bearer_auth(token);
	}
	if let Some(body) = body {
		request = request.json(&body);
	}
	let response = request.send().await.map_err(|error| {
		tracing::error!(%path, %error, "Bangumi 请求发送失败");
		format!("Bangumi 请求失败：{error}")
	})?;
	let status = response.status().as_u16();
	let text = response
		.text()
		.await
		.map_err(|error| format!("读取 Bangumi 响应失败：{error}"))?;
	if text.len() > MAX_BODY_BYTES {
		return Err("Bangumi 响应过大（超过 2MB）".into());
	}
	Ok(BgmResponse { status, body: text })
}
