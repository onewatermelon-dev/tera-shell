//! 弹弹play（dandanplay）开放 API：按文件名匹配剧集 → 拉外部弹幕库。
//!
//! 只做两条命令：`danmu_match`（标题/集号 → 弹幕库 episodeId）与
//! `danmu_comments`（episodeId → 弹幕列表）。AppId/AppSecret 由用户在
//! api.dandanplay.net 申请后配置，前端从 anime.json 读出随调用传入；
//! X-Signature = base64(HMAC-SHA256(secret, appId + timestamp + fileName))
//! 在后端用现成的 hmac/sha2/base64 计算，WebView 里拿不到也不需要拿到。

use hmac::Mac;
use serde::Serialize;

/// 与 anime.rs 一致的请求超时。
const REQUEST_TIMEOUT: std::time::Duration =
	std::time::Duration::from_secs(20);

/// 响应体上限：整集弹幕 JSON 常见 1~5MB，8MB 兜底。
const MAX_BODY_BYTES: usize = 8 * 1024 * 1024;

/// 单集弹幕条数上限：超长（重复刷屏的剧集）截断，防内存与渲染双爆。
const MAX_COMMENTS: usize = 12_000;

/// 一条弹幕：t 秒、mode（1-3 滚动 4 底部 5 顶部）、color ARGB、文本。
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DanmuComment {
	pub t: f64,
	pub mode: u8,
	pub color: u32,
	pub text: String,
}

/// 匹配结果（前端只关心 episodeId 与展示标题）。
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DanmuMatch {
	pub episode_id: i64,
	pub anime_title: String,
	pub episode_title: String,
}

/// 计算 X-Timestamp 与 X-Signature。`timestamp` 由调用方生成，独立成参数好测。
fn danmu_sign(
	secret: &str,
	app_id: &str,
	file_name: &str,
	timestamp: &str,
) -> String {
	type HmacSha256 = hmac::Hmac<sha2::Sha256>;
	let mut mac = HmacSha256::new_from_slice(secret.as_bytes())
		.expect("HMAC-SHA256 接受任意长度密钥");
	mac.update(format!("{app_id}{timestamp}{file_name}").as_bytes());
	use base64::Engine;
	base64::engine::general_purpose::STANDARD.encode(mac.finalize().into_bytes())
}

/// 带弹弹play 鉴权头发一个请求，返回原始 JSON 文本。
async fn danmu_request(
	app: &tauri::AppHandle,
	app_id: &str,
	app_secret: &str,
	file_name: &str,
	method: reqwest::Method,
	path: &str,
	body: Option<serde_json::Value>,
) -> Result<serde_json::Value, String> {
	let timestamp = std::time::SystemTime::now()
		.duration_since(std::time::UNIX_EPOCH)
		.map(|d| d.as_secs().to_string())
		.unwrap_or_else(|_| "0".into());
	let signature = danmu_sign(app_secret, app_id, file_name, &timestamp);
	let client = crate::infra::proxy::client_for(app, Some(REQUEST_TIMEOUT))?;
	let mut request = client
		.request(method, format!("https://api.dandanplay.net{path}"))
		.header("User-Agent", concat!("tera-shell/", env!("CARGO_PKG_VERSION")))
		.header("Accept", "application/json")
		.header("X-AppId", app_id)
		.header("X-Timestamp", timestamp)
		.header("X-Signature", signature);
	if let Some(body) = body {
		request = request.json(&body);
	}
	let response = request.send().await.map_err(|error| {
		tracing::error!(%path, %error, "弹弹play 请求发送失败");
		format!("弹弹play 请求失败：{error}")
	})?;
	let status = response.status().as_u16();
	let text = response
		.text()
		.await
		.map_err(|error| format!("读取弹弹play 响应失败：{error}"))?;
	if text.len() > MAX_BODY_BYTES {
		return Err("弹弹play 响应过大（超过 8MB）".into());
	}
	if !(200..300).contains(&status) {
		return Err(format!("弹弹play 返回 HTTP {status}"));
	}
	serde_json::from_str(&text)
		.map_err(|error| format!("弹弹play 响应不是合法 JSON：{error}"))
}

/// 按文件名匹配剧集。`ep_num` 用于在同集号匹配里优先挑选（匹配库里有
/// 剧场版/OVA 混排时避免拿到错的集）；匹配不上返回 null（前端静默无弹幕）。
#[tauri::command(rename = "danmu_match")]
pub async fn danmu_match(
	app: tauri::AppHandle,
	app_id: String,
	app_secret: String,
	file_name: String,
	ep_num: Option<u32>,
) -> Result<Option<DanmuMatch>, String> {
	if app_id.trim().is_empty() || app_secret.trim().is_empty() {
		return Err("请先在设置里填写弹弹play AppId / AppSecret".into());
	}
	let data = danmu_request(
		&app,
		app_id.trim(),
		app_secret.trim(),
		&file_name,
		reqwest::Method::POST,
		"/api/v2/match",
		Some(serde_json::json!({ "fileName": file_name })),
	)
	.await?;
	let matched = data
		.get("isMatched")
		.and_then(serde_json::Value::as_bool)
		.unwrap_or(false);
	if !matched {
		return Ok(None);
	}
	// matches 按置信度排序；同集号命中优先（集号对不上宁可不要）
	let matches = data
		.get("matches")
		.and_then(serde_json::Value::as_array)
		.cloned()
		.unwrap_or_default();
	let picked = matches
		.iter()
		.find(|m| {
			ep_num.is_some_and(|ep| {
				m.get("episodeNumber").and_then(serde_json::Value::as_i64)
					== Some(i64::from(ep))
			})
		})
		.or_else(|| matches.first());
	let Some(matched) = picked else {
		return Ok(None);
	};
	let episode_id = matched
		.get("episodeId")
		.and_then(serde_json::Value::as_i64)
		.unwrap_or(0);
	if episode_id <= 0 {
		return Ok(None);
	}
	Ok(Some(DanmuMatch {
		episode_id,
		anime_title: matched
			.get("animeTitle")
			.and_then(serde_json::Value::as_str)
			.unwrap_or_default()
			.to_string(),
		episode_title: matched
			.get("episodeTitle")
			.and_then(serde_json::Value::as_str)
			.unwrap_or_default()
			.to_string(),
	}))
}

/// 拉一集的弹幕列表（p 字段 = “秒,模式,颜色,来源”，逗号切前三位就够）。
#[tauri::command(rename = "danmu_comments")]
pub async fn danmu_comments(
	app: tauri::AppHandle,
	app_id: String,
	app_secret: String,
	file_name: String,
	episode_id: i64,
) -> Result<Vec<DanmuComment>, String> {
	if app_id.trim().is_empty() || app_secret.trim().is_empty() {
		return Err("请先在设置里填写弹弹play AppId / AppSecret".into());
	}
	let data = danmu_request(
		&app,
		app_id.trim(),
		app_secret.trim(),
		&file_name,
		reqwest::Method::GET,
		&format!("/api/v2/comment/{episode_id}?withRelated=true&chConvert=1"),
		None,
	)
	.await?;
	let raw = data
		.get("comments")
		.and_then(serde_json::Value::as_array)
		.cloned()
		.unwrap_or_default();
	let mut comments = Vec::with_capacity(raw.len().min(MAX_COMMENTS));
	for item in raw {
		let Some(p) = item.get("p").and_then(serde_json::Value::as_str) else {
			continue;
		};
		let Some(text) = item.get("m").and_then(serde_json::Value::as_str) else {
			continue;
		};
		// p = “时间,模式,颜色,…”，前三段必读；缺段/解析不了整条跳过
		let mut parts = p.split(',');
		let (Some(t), Some(mode), Some(color)) = (
			parts.next().and_then(|v| v.parse::<f64>().ok()),
			parts.next().and_then(|v| v.parse::<u8>().ok()),
			parts.next().and_then(|v| v.parse::<u32>().ok()),
		) else {
			continue;
		};
		if text.trim().is_empty() {
			continue;
		}
		comments.push(DanmuComment {
			t,
			mode,
			color,
			text: text.trim().to_string(),
		});
		if comments.len() >= MAX_COMMENTS {
			break;
		}
	}
	// 按时间排序：前端引擎按媒体时间调度，乱序无碍但排好序好截断与排查
	comments.sort_by(|a, b| a.t.total_cmp(&b.t));
	Ok(comments)
}

#[cfg(test)]
#[path = "../tests/unit/danmu.rs"]
mod danmu_tests;
