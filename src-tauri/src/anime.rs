//! 动漫播放：复刻参考 App（com.sdmnfowa.soad.p1 / com.yy.myuko）的网络链路。
//!
//! 参考包的 API 走 v3 加密封包（`anime_crypto` 仿真层），流程：
//! 1. `ensure_session`：设备协商（deviceId 固定 + masterSecret 派生密钥）
//! 2. 请求体 JSON → v3 信封加密 → POST octet-stream → 解密响应
//!
//! 头部按抓包实锤：X-App-Id / X-Platform / X-Device-Id；首次协商无会话。
//! 域名仍由用户在弹层配置（参考包运行时解密下发，静态拿不到）。

use crate::anime_crypto::AnimeCrypto;
use tauri::Emitter;
use tauri::Manager;
use tauri_plugin_dialog::DialogExt;

/// 参考 App 的应用 id。
const APP_ID: &str = "315891530526580736";
/// 参考 App 的请求签名密钥（X-Signature = MD5(ts+nonce+appId+signSecret)）。
/// ⚠️ ponytail: 未用——服务端当前不强制签名头，4xx 时再接 md5。
#[allow(dead_code)]
const SIGN_SECRET: &str = "b7a599975b90ac560466466fa8a3021f";
/// 协商标识头。
const X_PLATFORM: &str = "android";
/// 参考 App 的 Ktor UA。
const USER_AGENT: &str = "Myuko Ktor Client";

/// 协商端点（设备注册，明文 JSON 响应里带算法清单与 deviceSecret）。
const NEGOTIATE_PATH: &str = "/api/v1/app/client/auth/negotiate";

/// 单次请求上限：目录/详情类响应都在 MB 级以内，防御异常源撑爆内存。
const MAX_BODY_BYTES: usize = 8 * 1024 * 1024;

/// 总超时：目录与解析接口都是短请求，20 秒足够。
const REQUEST_TIMEOUT: std::time::Duration =
	std::time::Duration::from_secs(20);

/// 把一次 reqwest 发送错误摊成「分类 + 完整 source 链」。
///
/// reqwest 的 `Display` 只有一句 `error sending request for url (…)`，
/// 真正的原因（DNS 解析失败 / 连接被拒 / 超时 / TLS 握手失败 / 对端收下
/// 连接却一个字节都不回）全在 `source()` 链里。前端红字只显示顶层文本，
/// 用户看到的就是「失败但不知道为什么」，所以这里把链路拍平带出去。
fn describe_reqwest(error: &reqwest::Error) -> String {
	let kind = if error.is_timeout() {
		"请求超时"
	} else if error.is_connect() {
		"连接失败"
	} else if error.is_builder() {
		"请求构造失败"
	} else if error.is_decode() || error.is_body() {
		"响应读取失败"
	} else {
		"请求发送失败"
	};
	let mut chain = String::new();
	let mut cursor: Option<&(dyn std::error::Error + 'static)> =
		std::error::Error::source(error);
	while let Some(inner) = cursor {
		if !chain.is_empty() {
			chain.push_str(" ← ");
		}
		chain.push_str(&inner.to_string());
		cursor = std::error::Error::source(inner);
	}
	if chain.is_empty() {
		format!("{kind}：{error}")
	} else {
		format!("{kind}：{chain}")
	}
}

// ── 进程内单例 ──────────────────────────────────────────────

/// 仿真加密器（unicorn 引擎 + 参考算法表），进程内一次加载。
static CRYPTO: std::sync::OnceLock<AnimeCrypto> = std::sync::OnceLock::new();
/// 会话：协商成功后的设备身份。重启后重新协商（一次往返，不值得持久化密钥）。
static SESSION: std::sync::Mutex<Option<Session>> = std::sync::Mutex::new(None);
/// 聚站 WAF Cookie 缓存：第一次两连发后所有请求单发携带（搜索接口有 6 秒
/// 频控，两连发会把配额烧在第一发上）；Cookie 失效时自动两连发重取。
static JUZ_COOKIE: std::sync::Mutex<Option<String>> = std::sync::Mutex::new(None);

/// 已协商的会话身份。
#[derive(Clone)]
struct Session {
	device_id: String,
	/// deviceSecret 的 ASCII64 hex 字符串字节（加密/解密统一用这个形态）。
	secret_ascii: Vec<u8>,
	/// 服务端回传的会话 id（响应头 X-Session-Id）。
	session_id: String,
}

/// 代理响应：状态码 + 解密后的 JSON 文本（前端按 App 的包装结构解析）。
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AnimeResponse {
	pub status: u16,
	pub body: String,
}

// ── 加密器与设备身份 ────────────────────────────────────────

/// 取（或初始化）仿真加密器。DLL 与 .so 打包在资源目录 resources/anime/ 下。
fn ensure_crypto(
	app: &tauri::AppHandle,
) -> Result<&'static AnimeCrypto, String> {
	if let Some(crypto) = CRYPTO.get() {
		return Ok(crypto);
	}
	let dir = app
		.path()
		.resource_dir()
		.map_err(|e| format!("资源目录解析失败：{e}"))?
		.join("resources/anime");
	let crypto = AnimeCrypto::new(
		&dir.join("libunicorn.dll"),
		&dir.join("libmagic_cipher.so"),
	)?;
	let _ = CRYPTO.set(crypto);
	Ok(CRYPTO.get().unwrap())
}

/// 设备身份：手机参考 App 的真实注册身份。
///
/// 逆向结论（2026-11-01）：deviceSecret 不是随机存的，而是
///   `deviceSecret = hex( HMAC-SHA256( masterSecret, "device:" + deviceId ) )`
/// `masterSecret` 是手机 App bootstrap 配置里的字段（逆向期从运行期日志取得）。
/// 这两个值来自手机 App 的 `no_backup/device_id_v3` 与运行期日志，
/// 是**活的**：只要服务器没吊销这台设备，就无需走首次引导协议。
const DEVICE_ID: &str =
	"bf29a99b520e5530ce3fe76bf9e443a615d155f1f92b79a24aec6a8be3dde1b8";
/// masterSecret（bootstrap 配置字段，来自手机运行期日志 MAGICPWN）。
const DEVICE_MASTER_SECRET: &str = "7b94a2ab809388c89cdee6751701e638";

/// 由 masterSecret + deviceId 派生 deviceSecret（64 位 hex 字符串）。
fn derive_device_secret(device_id: &str) -> String {
	use hmac::{Hmac, Mac};
	use sha2::Sha256;
	type HmacSha256 = Hmac<Sha256>;
	let mut mac =
		HmacSha256::new_from_slice(DEVICE_MASTER_SECRET.as_bytes())
			.expect("masterSecret 长度合法");
	mac.update(format!("device:{device_id}").as_bytes());
	let digest = mac.finalize().into_bytes();
	let mut out = String::with_capacity(digest.len() * 2);
	for byte in &digest {
		out.push_str(&format!("{byte:02x}"));
	}
	out
}

// ── 会话协商 ────────────────────────────────────────────────

/// 确保会话可用：无会话则自动协商。返回会话快照。
async fn ensure_session(
	app: &tauri::AppHandle,
	client: &reqwest::Client,
	base_url: &str,
) -> Result<Session, String> {
	if let Ok(guard) = SESSION.lock() {
		if let Some(session) = guard.as_ref() {
			return Ok(session.clone());
		}
	}
	let device_id = DEVICE_ID.to_string();
	let secret_ascii = derive_device_secret(&device_id).into_bytes();
	let crypto = ensure_crypto(app)?;

	// 加密协商请求体
	let now_s = std::time::SystemTime::now()
		.duration_since(std::time::UNIX_EPOCH)
		.map(|d| d.as_secs())
		.unwrap_or(0);
	let body = serde_json::json!({ "deviceId": device_id }).to_string();
	let envelope = crypto
		.encrypt(&secret_ascii, body.as_bytes(), now_s)
		.map_err(|e| format!("协商请求加密失败：{e}"))?;

	let url = format!("{base_url}{NEGOTIATE_PATH}");
	tracing::info!(url = %url, device_id = %device_id, "动漫协商");
	let response = client
		.post(&url)
		.header("Content-Type", "application/octet-stream")
		.header("User-Agent", USER_AGENT)
		.header("X-App-Id", APP_ID)
		.header("X-Platform", X_PLATFORM)
		.header("X-Device-Id", &device_id)
		.header("X-Session-Id", "") // 首次协商无会话，留空即可
		.body(envelope)
		.send()
		.await
		.map_err(|e| {
			// 连不上是配置错误（地址/端口/代理）里最常见的一类，留 error 级现场
			tracing::error!(url = %url, error = %e, "动漫协商请求发送失败");
			format!("协商请求失败：{}", describe_reqwest(&e))
		})?;
	let status = response.status().as_u16();
	let session_id = response
		.headers()
		.get("X-Session-Id")
		.and_then(|v| v.to_str().ok())
		.unwrap_or_default()
		.to_string();
	let cipher = response
		.bytes()
		.await
		.map_err(|e| format!("读取协商响应失败：{e}"))?;
	if cipher.len() > MAX_BODY_BYTES {
		return Err("协商响应过大".into());
	}

	// 解密协商响应
	// 解密失败要分清两种情况：服务器回了**明文 JSON 错误**（限流/会话过期），
	// 还是真的密文解不开（引擎状态问题）。早期一律报"引擎无输出"，看不出根因。
	let plain = match crypto.decrypt(&secret_ascii, &cipher) {
		Ok(plain) => plain,
		Err(error) => {
			let as_text = String::from_utf8_lossy(&cipher).into_owned();
			if as_text.trim_start().starts_with('{') {
				tracing::warn!(
					status,
					len = cipher.len(),
					body = %as_text,
					"协商响应是明文（未加密）"
				);
				return Err(format!("协商被拒（HTTP {status}）：{as_text}"));
			}
			let head: String = cipher
				.iter()
				.take(24)
				.map(|b| format!("{b:02x}"))
				.collect::<Vec<_>>()
				.join(" ");
			tracing::error!(
				status,
				len = cipher.len(),
				%head,
				%error,
				"协商响应解密失败"
			);
			// 引擎状态可能已坏，清会话让下次重新协商
			if let Ok(mut guard) = SESSION.lock() {
				*guard = None;
			}
			return Err(format!(
				"协商响应解密失败：{error}（HTTP {status}，密文 {} 字节，头部 {head}）",
				cipher.len()
			));
		}
	};
	let value: serde_json::Value = serde_json::from_slice(&plain)
		.map_err(|e| format!("协商响应不是 JSON：{e}"))?;
	if value.get("success").and_then(|v| v.as_bool()) != Some(true) {
		let message = value
			.get("message")
			.and_then(|v| v.as_str())
			.unwrap_or("未知错误");
		return Err(format!("协商被拒（HTTP {status}）：{message}"));
	}
	tracing::info!(status, session_id = %session_id, "动漫协商成功");

	let session = Session {
		device_id,
		secret_ascii,
		session_id,
	};
	if let Ok(mut guard) = SESSION.lock() {
		*guard = Some(session.clone());
	}
	Ok(session)
}

// ── 账号态 ──────────────────────────────────────────────────

/// 账号数据文件名（与 `data::ALLOWED` / 前端 DataName 白名单同步）。
const ACCOUNT_DATA: &str = "anime_account";

/// 登录态：只存 token（DPAPI 密文），**密码从不落盘**。
#[derive(Clone, Default, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AnimeAccount {
	/// 登录账号（手机号/邮箱），仅用于界面展示
	#[serde(default)]
	pub account: String,
	/// token 的 DPAPI 密文（`infra::secret::encrypt` 产物）
	#[serde(default)]
	pub token_cipher: String,
	/// 过期时间（秒级时间戳，0 = 未知）
	#[serde(default)]
	pub expire_at: i64,
}

/// 读账号态；文件缺失/损坏都当未登录。
fn load_account(app: &tauri::AppHandle) -> AnimeAccount {
	let Some(text) = crate::data::read_setting_text(app, ACCOUNT_DATA) else {
		return AnimeAccount::default();
	};
	serde_json::from_str(&text).unwrap_or_default()
}

/// 写账号态（整体覆盖）。
async fn save_account(
	app: &tauri::AppHandle,
	account: &AnimeAccount,
) -> Result<(), String> {
	let payload = serde_json::to_string(account).map_err(|e| e.to_string())?;
	crate::data::save_one(app.clone(), ACCOUNT_DATA.to_string(), payload).await
}

/// 取当前可用 token：解密 DPAPI 密文 + 过期判断。
fn account_token(app: &tauri::AppHandle) -> Option<String> {
	let account = load_account(app);
	if account.token_cipher.is_empty() {
		return None;
	}
	if account.expire_at > 0 {
		let now = std::time::SystemTime::now()
			.duration_since(std::time::UNIX_EPOCH)
			.map(|d| d.as_secs() as i64)
			.unwrap_or(0);
		// 留 60 秒余量，避免正好卡在过期瞬间
		if account.expire_at - 60 <= now {
			tracing::warn!(expire_at = account.expire_at, "动漫账号 token 已过期");
			return None;
		}
	}
	match crate::infra::secret::decrypt(account.token_cipher.clone()) {
		Ok(token) if !token.is_empty() => Some(token),
		Ok(_) => None,
		Err(error) => {
			tracing::error!(%error, "动漫账号 token 解密失败");
			None
		}
	}
}

/// 有 token 就带上 `Authorization: Bearer`（参考 App 用 Ktor BearerAuthProvider）。
fn with_auth(
	builder: reqwest::RequestBuilder,
	token: &Option<String>,
) -> reqwest::RequestBuilder {
	match token {
		Some(value) if !value.is_empty() => {
			builder.header("Authorization", format!("Bearer {value}"))
		}
		_ => builder,
	}
}

// ── 命令 ────────────────────────────────────────────────────

/// 取 v3 响应的业务字段层。
///
/// 解密出来的 JSON 是 `{timestamp, code, success, msg, data:{…}}`，业务字段
/// （qualities / exchangeToken / originalUrl / sign …）全在 `data` 里面。
/// 早期 `play()` 直接从根上 `get()`，于是所有字段都读成 `None`，被误判成
/// 「非解析源」——症状是明明 qualities/exchange 都 200，点播放却报
/// 「非解析源未返回播放地址」。前端 `client.ts` 早就展开过一层，后端漏了。
fn payload(value: &serde_json::Value) -> &serde_json::Value {
	match value.get("data") {
		Some(inner) if inner.is_object() => inner,
		_ => value,
	}
}

/// 单次 v3 加密 API 调用：加密 → POST → 解密 → 返回 JSON。
/// 会话过期（4020）时自动重协商一次。
async fn enc_call(
	app: &tauri::AppHandle,
	client: &reqwest::Client,
	base_url: &str,
	path: &str,
	body: &serde_json::Value,
	session: &Session,
	crypto: &AnimeCrypto,
) -> Result<serde_json::Value, String> {
	let now_s = std::time::SystemTime::now()
		.duration_since(std::time::UNIX_EPOCH)
		.map(|d| d.as_secs())
		.unwrap_or(0);
	let plain = serde_json::to_vec(body).map_err(|e| e.to_string())?;
	let http_body = crypto
		.encrypt(&session.secret_ascii, &plain, now_s)
		.map_err(|e| format!("加密失败：{e}"))?;
	let url = format!("{base_url}{path}");
	// 登录后带 Authorization：服务端按账号判定 VIP（会员档清晰度靠它放行）
	let token = account_token(app);
	let request = with_auth(
		client
			.post(&url)
			.header("User-Agent", USER_AGENT)
			.header("X-App-Id", APP_ID)
			.header("X-Platform", X_PLATFORM)
			.header("X-Session-Id", &session.session_id)
			.header("X-Device-Id", &session.device_id)
			.header("Content-Type", "application/octet-stream")
			.body(http_body),
		&token,
	);
	let response = request
		.send()
		.await
		.map_err(|e| {
			tracing::error!(url = %url, error = %e, "动漫 API 请求发送失败");
			format!("请求失败：{}", describe_reqwest(&e))
		})?;
	let status = response.status().as_u16();
	let cipher = response.bytes().await.map_err(|e| e.to_string())?;
	let text = match crypto.decrypt(&session.secret_ascii, &cipher) {
		Ok(plain) => String::from_utf8_lossy(&plain).into_owned(),
		Err(e) => {
			let as_text = String::from_utf8_lossy(&cipher).into_owned();
			if as_text.trim_start().starts_with('{') {
				if as_text.contains("\"code\":4020") {
					// 会话过期 → 清除会话让上层重试
					if let Ok(mut guard) = SESSION.lock() {
						*guard = None;
					}
					return Err("__SESSION_EXPIRED__".into());
				}
				tracing::warn!(status, "明文错误响应");
				return Ok(serde_json::from_str(&as_text)
					.unwrap_or(serde_json::json!({"raw": as_text})));
			}
			return Err(format!("解密失败：{e}"));
		}
	};
	tracing::info!(status, url = %url, len = text.len(), "API 响应");
	serde_json::from_str(&text)
		.map_err(|e| format!("响应不是 JSON：{e}"))
}

/// 带自动重协商的加密调用（4020 时清会话重试一次）。
async fn enc_call_retry(
	app: &tauri::AppHandle,
	client: &reqwest::Client,
	base_url: &str,
	path: &str,
	body: &serde_json::Value,
) -> Result<serde_json::Value, String> {
	let session = ensure_session(app, client, base_url).await?;
	let crypto = ensure_crypto(app)?;
	match enc_call(app, client, base_url, path, body, &session, crypto).await {
		Err(e) if e == "__SESSION_EXPIRED__" => {
			tracing::warn!("会话过期，重协商后重试");
			let session = ensure_session(app, client, base_url).await?;
			enc_call(app, client, base_url, path, body, &session, crypto).await
		}
		other => other,
	}
}

/// 播放一集：完整链路 qualities → exchange → sign(get_api_url) →
/// httpGet 第三方 → sign(process_url) → 返回 m3u8/MP4 播放地址。
///
/// `quality` 为空时用接口给的默认清晰度；传了就按传的走（前端切换清晰度
/// 就是带着这个值再调一次，因为每一步都签了 exchangeToken，不能只换最后一段）。
#[tauri::command(rename = "anime_play")]
pub async fn play(
	app: tauri::AppHandle,
	base_url: String,
	video_id: String,
	code: String,
	episode_num: i64,
	quality: Option<String>,
) -> Result<serde_json::Value, String> {
	if !base_url.starts_with("http://") && !base_url.starts_with("https://") {
		return Err("动漫 API 地址必须以 http:// 或 https:// 开头".into());
	}
	let client = crate::infra::proxy::client_for(&app, Some(REQUEST_TIMEOUT))?;

	// 1) qualities → exchangeToken + isClientParse + 清晰度列表
	//
	// ⚠️ `episodeNum` 必须带：exchangeToken 是按「视频 + 线路 + 集数」签发的，
	// 不带集数时服务器默认按第 1 集签，后续 exchange 换任何其它集都会回
	// 4204「播放凭证校验失败」。这一条踩了很久——第 1 集能播、其它集全挂。
	let q = enc_call_retry(
		&app,
		&client,
		&base_url,
		"/api/v1/app/client/resolve/qualities",
		&serde_json::json!({
			"videoId": video_id,
			"code": code,
			"episodeNum": episode_num
		}),
	)
	.await?;
	let q_data = payload(&q);
	let exchange_token = q_data
		.get("exchangeToken")
		.and_then(|v| v.as_str())
		.unwrap_or("")
		.to_string();
	let is_client_parse =
		q_data.get("isClientParse").and_then(|v| v.as_bool()).unwrap_or(false);
	// 原样给前端一份（切清晰度用），同时挑出默认值
	let quality_list: Vec<serde_json::Value> = q_data
		.get("qualities")
		.and_then(|v| v.as_array())
		.map(|arr| {
			arr.iter()
				.map(|item| {
					serde_json::json!({
						"quality": item.get("quality").and_then(|v| v.as_str()).unwrap_or(""),
						"label": item.get("label").and_then(|v| v.as_str()).unwrap_or(""),
						"isDefault": item
							.get("isDefault")
							.and_then(|v| v.as_bool())
							.unwrap_or(false),
						// 会员专享档（服务端 exchange 会直接拒绝：该清晰度需要开通会员）
						"isVipOnly": item
							.get("isVipOnly")
							.and_then(|v| v.as_bool())
							.unwrap_or(false),
					})
				})
				.collect()
		})
		.unwrap_or_default();
	let default_quality = q_data
		.get("qualities")
		.and_then(|v| v.as_array())
		.and_then(|arr| {
			arr.iter()
				.find(|x| x.get("isDefault").and_then(|v| v.as_bool()).unwrap_or(false))
				.or_else(|| arr.first())
		})
		.and_then(|x| x.get("quality"))
		.and_then(|v| v.as_str())
		.unwrap_or("1080p")
		.to_string();
	// 用户指定的优先，但必须落在这个源真有的列表里，否则退回默认
	let quality = quality
		.filter(|want| {
			quality_list
				.iter()
				.any(|item| item.get("quality").and_then(|v| v.as_str()) == Some(want.as_str()))
		})
		.unwrap_or(default_quality);
	// qualities 自己失败时（会话过期、无版权、参数不对）不会给 exchangeToken，
	// 后面 exchange 只会回一个 4203「参数不完整」，把真实原因先抛出去
	let q_success = q_data.get("success").and_then(|v| v.as_bool()).unwrap_or(true);
	if !q_success {
		let msg = q_data
			.get("msg")
			.and_then(|v| v.as_str())
			.unwrap_or("接口返回失败");
		return Err(format!(
			"取清晰度失败：{msg}（videoId={video_id}, code={code}）"
		));
	}
	if exchange_token.is_empty() {
		tracing::warn!(%quality, "qualities 未返回 exchangeToken，继续尝试");
	}
	tracing::info!(
		is_client_parse,
		%quality,
		options = quality_list.len(),
		token_len = exchange_token.len(),
		"qualities 完成"
	);

	// 2) exchange → originalUrl + luaScript
	let ex = enc_call_retry(
		&app,
		&client,
		&base_url,
		"/api/v1/app/client/resolve/exchange",
		&serde_json::json!({
			"videoId": video_id, "code": code, "episodeNum": episode_num,
			"action": "play", "params": null, "adToken": "",
			"quality": quality, "exchangeToken": exchange_token
		}),
	)
	.await?;
	let ex_data = payload(&ex);
	// 服务端把原因放在 success/msg 里，早期只读 originalUrl 会把
	// 「4203 参数不完整」这类错误吞掉，误报成「线路不支持」
	let ex_success = ex_data
		.get("success")
		.and_then(|v| v.as_bool())
		.unwrap_or(true);
	let ex_msg = ex_data
		.get("msg")
		.or_else(|| ex.get("msg"))
		.and_then(|v| v.as_str())
		.unwrap_or("")
		.to_string();
	let original_url = ex_data
		.get("originalUrl")
		.and_then(|v| v.as_str())
		.unwrap_or("")
		.to_string();
	// 少数源不走客户端解析，exchange 直接给直链
	let ex_play_url = ex_data
		.get("playUrl")
		.and_then(|v| v.as_str())
		.unwrap_or("")
		.to_string();
	let lua_len = ex_data
		.get("luaScript")
		.and_then(|v| v.as_str())
		.map(|s| s.len())
		.unwrap_or(0);
	tracing::info!(
		%original_url,
		lua_len,
		ex_success,
		%ex_msg,
		code = %code,
		episode_num,
		"exchange 完成"
	);

	// exchange 已经给了直链就直接用，不用再问服务器
	if !ex_play_url.is_empty() {
		return Ok(serde_json::json!({
			"playUrl": ex_play_url,
			"quality": quality,
			"qualities": quality_list
		}));
	}
	if !ex_success {
		return Err(format!(
			"解析失败：{}（videoId={video_id}, code={code}, 第 {episode_num} 集）",
			if ex_msg.is_empty() { "服务端未说明原因" } else { &ex_msg }
		));
	}

	if original_url.is_empty() {
		// 非 client-parse 源：sign 直接返回 playUrl
		let sign_result = enc_call_retry(
			&app, &client, &base_url,
			"/api/v1/app/client/resolve/sign",
			&serde_json::json!({
				"videoId": video_id, "code": code, "episodeNum": episode_num,
				"action": "play", "params": null, "adToken": "", "quality": quality
			}),
		)
		.await?;
		let play_url = payload(&sign_result)
			.get("playUrl")
			.and_then(|v| v.as_str())
			.unwrap_or("")
			.to_string();
		if !play_url.is_empty() {
			return Ok(serde_json::json!({
				"playUrl": play_url,
				"quality": quality,
				"qualities": quality_list
			}));
		}
		let message = payload(&sign_result)
			.get("msg")
			.and_then(|v| v.as_str())
			.unwrap_or("服务端未说明原因");
		return Err(format!(
			"该线路没有直接播放地址（{message}）——exchange 未给 originalUrl，\
			 大概率只支持 App 内置 Lua 解析"
		));
	}

	// 3) sign(get_api_url) → 签名 api_url
	let sign_result = enc_call_retry(
		&app, &client, &base_url,
		"/api/v1/app/client/resolve/sign",
		&serde_json::json!({
			"videoId": video_id, "code": code, "episodeNum": episode_num,
			"action": "get_api_url", "params": original_url,
			"adToken": "", "quality": quality, "exchangeToken": exchange_token
		}),
	)
	.await?;
	let api_url = sign_result
		.pointer("/data/sign/api_url")
		.or_else(|| sign_result.pointer("/sign/api_url"))
		.and_then(|v| v.as_str())
		.unwrap_or("")
		.replace("\\u0026", "\u{0026}");
	if api_url.is_empty() {
		return Err("get_api_url 未返回 api_url".into());
	}
	tracing::info!(%api_url, "get_api_url 完成");

	// 4) GET 第三方解析 API
	// 认证头由 sign 下发（X-Goepp-Client-Auth / Check / Probe / Proof），
	// 缺了它们第三方只回空 playAddr —— 光带 UA 是不够的
	let sign_headers = sign_result
		.pointer("/data/sign/headers")
		.or_else(|| sign_result.pointer("/sign/headers"))
		.cloned()
		.unwrap_or(serde_json::json!({}));
	let mut third_req = client
		.get(&api_url)
		.header("User-Agent", "okhttp/3.12.1")
		.header("Accept", "*/*")
		.header("Connection", "keep-alive");
	if let Some(map) = sign_headers.as_object() {
		tracing::info!(count = map.len(), "第三方请求头来自 sign");
		for (key, value) in map {
			if let Some(text) = value.as_str() {
				third_req = third_req.header(key.as_str(), text);
			}
		}
	}
	let third = third_req
		.send()
		.await
		.map_err(|e| {
			tracing::error!(%api_url, error = %e, "第三方解析 API 请求发送失败");
			format!("第三方 API 请求失败：{}", describe_reqwest(&e))
		})?;
	let third_status = third.status().as_u16();
	let third_body = third.bytes().await.map_err(|e| e.to_string())?;
	let third_text = String::from_utf8_lossy(&third_body).into_owned();
	tracing::info!(third_status, len = third_body.len(), "第三方 API 响应");

	// 5) sign(process_url, params=playAddr) → 解密播放地址
	let third_json: serde_json::Value = serde_json::from_str(&third_text)
		.unwrap_or(serde_json::json!({}));
	let play_addr = third_json
		.pointer("/data/playAddr")
		.cloned()
		.unwrap_or(serde_json::json!([]));
	let addr_count = play_addr.as_array().map(|a| a.len()).unwrap_or(0);
	if addr_count == 0 {
		tracing::warn!(%third_text, "第三方解析未返回 playAddr");
		return Err(format!(
			"第三方解析没给播放地址（playAddr 为空）：{}",
			third_text.chars().take(160).collect::<String>()
		));
	}
	tracing::info!(addr_count, "第三方解析成功");
	// 同一条线路常同时给「4K / H265」与「1080P / H264」两条。WebView2 默认
	// 不带 HEVC 解码器，选到 H265 就是「有声音没画面」，所以优先挑 H264。
	let mut addr_list = play_addr.as_array().cloned().unwrap_or_default();
	addr_list.sort_by_key(|item| {
		let codec = item.get("vcodec").and_then(|v| v.as_str()).unwrap_or("");
		if codec.eq_ignore_ascii_case("H264") {
			0
		} else {
			1
		}
	});

	// 5) sign(process_url) → 解密后的播放地址
	//
	// ## 请求体必须"最小"
	//
	// 实测（对照手机端抓包，App 这条请求 424 字节、明文约 306）：
	// 只带 videoId / code / episodeNum / action / params 时返回 200 与真实
	// 地址；一旦多塞 adToken、quality、exchangeToken，服务器就回
	// 500「生成签名失败: generate_sign 返回为空」。
	// 另外 `params.playAddr` 必须是**单条对象**，传数组同样 500。
	let mut last_message = String::new();
	for (index, entry) in addr_list.iter().enumerate() {
		let params = serde_json::json!({
			"playAddr": entry,
			"is_new_api": is_client_parse
		});
		let proc_result = enc_call_retry(
			&app, &client, &base_url,
			"/api/v1/app/client/resolve/sign",
			&serde_json::json!({
				"videoId": video_id,
				"code": code,
				"episodeNum": episode_num,
				"action": "process_url",
				"params": params
			}),
		)
		.await?;
		// 结果形状：{data:{sign:{type, url}}}，也兼容平铺
		let play_url = proc_result
			.pointer("/data/sign/url")
			.or_else(|| proc_result.pointer("/sign/url"))
			.or_else(|| proc_result.pointer("/data/url"))
			.or_else(|| proc_result.pointer("/url"))
			.or_else(|| proc_result.pointer("/data/sign/playUrl"))
			.or_else(|| proc_result.pointer("/data/playUrl"))
			.or_else(|| proc_result.pointer("/playUrl"))
			.and_then(|v| v.as_str())
			.unwrap_or("")
			.to_string();
		if !play_url.is_empty() {
			let vcodec = entry
				.get("vcodec")
				.and_then(|v| v.as_str())
				.unwrap_or("")
				.to_string();
			tracing::info!(index, %play_url, %vcodec, "process_url 解出播放地址");
			return Ok(serde_json::json!({
				"playUrl": play_url,
				"quality": quality,
				"qualities": quality_list,
				"vcodec": vcodec
			}));
		}
		last_message = payload(&proc_result)
			.get("msg")
			.and_then(|v| v.as_str())
			.unwrap_or("未返回 url")
			.to_string();
		tracing::warn!(index, %last_message, "process_url 该条未解出");
	}
	Err(format!(
		"播放地址解密失败（{last_message}）——服务器没给 url"
	))
}

/// 调一个加密 API 端点：自动协商 → 加密请求 → 解密响应 → 返回 JSON。
///
/// `path` 为逆向端点（/api/v1/app/client/…），`body` 为业务 JSON（会被
/// 序列化进 v3 信封）。非 200 仍返回状态码交给前端按 App 语义处理。
#[tauri::command(rename = "anime_api")]
pub async fn api(
	app: tauri::AppHandle,
	base_url: String,
	path: String,
	body: serde_json::Value,
) -> Result<AnimeResponse, String> {
	if !base_url.starts_with("http://") && !base_url.starts_with("https://") {
		return Err("动漫 API 地址必须以 http:// 或 https:// 开头".into());
	}
	let client = crate::infra::proxy::client_for(&app, Some(REQUEST_TIMEOUT))?;
	let mut retried = false;
	loop {
	let session = ensure_session(&app, &client, &base_url).await?;
	let crypto = ensure_crypto(&app)?;

	// 加密请求体；resolve/sign 是例外——Ktor JSON 明文端点（逆向实锤 p197n9/h）
	let now_ms = std::time::SystemTime::now()
		.duration_since(std::time::UNIX_EPOCH)
		.map(|d| d.as_millis() as u64)
		.unwrap_or(0);
	let now_s = now_ms / 1000;
	let plain = serde_json::to_vec(&body).map_err(|e| e.to_string())?;
	// 所有端点统一 v3 加密（包括 resolve/sign——实测 4106 报"请求未加密"）
	let http_body = crypto
		.encrypt(&session.secret_ascii, &plain, now_s)
		.map_err(|e| format!("请求加密失败：{e}"))?;

	let url = format!("{base_url}{path}");
	tracing::info!(url = %url, "动漫 API 请求");
	// 同上：登录态靠这个头，会员档清晰度才放行
	let token = account_token(&app);
	let request = with_auth(
		client
			.post(&url)
			.header("User-Agent", USER_AGENT)
			.header("X-App-Id", APP_ID)
			.header("X-Platform", X_PLATFORM)
			.header("X-Session-Id", &session.session_id)
			.header("X-Device-Id", &session.device_id)
			.header("Content-Type", "application/octet-stream")
			.body(http_body),
		&token,
	);
	let response = request
		.send()
		.await
		.map_err(|e| {
			tracing::error!(url = %url, error = %e, "动漫 API 请求发送失败");
			format!("请求失败：{}", describe_reqwest(&e))
		})?;
	let status = response.status().as_u16();
	let cipher = response
		.bytes()
		.await
		.map_err(|e| format!("读取响应失败：{e}"))?;
	if cipher.len() > MAX_BODY_BYTES {
		return Err("响应过大（超过 8MB），疑似异常源".into());
	}

	// 响应处理：统一 v3 解密，失败时若密文本身是明文 JSON（code=4020 会话过期等）触发重协商重试
	let text = match crypto.decrypt(&session.secret_ascii, &cipher) {
		Ok(plain) => String::from_utf8_lossy(&plain).into_owned(),
		Err(e) => {
			let as_text = String::from_utf8_lossy(&cipher).into_owned();
			if as_text.trim_start().starts_with('{') {
				if as_text.contains("\"code\":4020") || as_text.contains("重新协商") {
					tracing::warn!("会话过期，重新协商后重试");
					if let Ok(mut guard) = SESSION.lock() {
						*guard = None;
					}
					if retried {
						return Err("会话过期且重协商后仍失败".into());
					}
					retried = true;
					continue;
				}
				tracing::warn!(status, "动漫 API 明文错误响应（解密跳过）");
				return Ok(AnimeResponse { status, body: as_text });
			}
			return Err(format!("响应解密失败：{e}"));
		}
	};
	tracing::info!(status, url = %url, len = text.len(), "动漫 API 响应");
	return Ok(AnimeResponse { status, body: text });
	}
}

/// 取回一个外部文本资源（HLS 播放列表）。
///
/// ## 为什么需要绕过后端
///
/// 播放列表常放在对象存储上（实测是 tencent-cos），响应**不带**
/// `Access-Control-Allow-Origin`，WebView 里 hls.js 的 fetch 会被 CORS 直接
/// 掐掉，表现为「视频加载失败」而看不出原因。由 Rust 侧取回来、前端转成
/// blob URL 交给 hls.js 即可绕开——片段本身在 CDN 上带 `*`，照常直连。
#[tauri::command(rename = "anime_fetch_text")]
pub async fn fetch_text(
	app: tauri::AppHandle,
	url: String,
) -> Result<String, String> {
	if !url.starts_with("http://") && !url.starts_with("https://") {
		return Err("只支持 http(s) 地址".into());
	}
	let client = crate::infra::proxy::client_for(&app, Some(REQUEST_TIMEOUT))?;
	let response = client
		.get(&url)
		.header("User-Agent", "okhttp/3.12.1")
		.header("Accept", "*/*")
		.send()
		.await
		.map_err(|e| {
			tracing::error!(%url, error = %e, "播放列表请求发送失败");
			format!("播放列表请求失败：{}", describe_reqwest(&e))
		})?;
	let status = response.status().as_u16();
	let body = response
		.bytes()
		.await
		.map_err(|e| format!("读取播放列表失败：{e}"))?;
	if body.len() > MAX_BODY_BYTES {
		return Err("播放列表过大（超过 8MB）".into());
	}
	if status != 200 {
		return Err(format!("播放列表返回 HTTP {status}"));
	}
	tracing::info!(%url, len = body.len(), "播放列表已取回");
	Ok(String::from_utf8_lossy(&body).into_owned())
}

/// 旧命令保留：直发明文 JSON（域名探测/兜底用，不走出封协议）。
#[tauri::command(rename = "anime_request")]
pub async fn request(
	app: tauri::AppHandle,
	url: String,
	body: serde_json::Value,
) -> Result<AnimeResponse, String> {
	if !url.starts_with("http://") && !url.starts_with("https://") {
		return Err("动漫 API 地址必须以 http:// 或 https:// 开头".into());
	}
	let client = crate::infra::proxy::client_for(&app, Some(REQUEST_TIMEOUT))?;
	tracing::info!(url = %url, "动漫 API 明文请求");
	let response = client
		.post(&url)
		.header("Content-Type", "application/json")
		.header("User-Agent", USER_AGENT)
		.json(&body)
		.send()
		.await
		.map_err(|error| {
			tracing::error!(url = %url, %error, "动漫 API 明文请求发送失败");
			format!("请求失败：{}", describe_reqwest(&error))
		})?;
	let status = response.status().as_u16();
	let text = response
		.text()
		.await
		.map_err(|error| format!("读取响应失败：{error}"))?;
	if text.len() > MAX_BODY_BYTES {
		return Err("响应过大（超过 8MB），疑似异常源".into());
	}
	Ok(AnimeResponse { status, body: text })
}

// ── 账号：登录 / 会员 / 兑换码 ──────────────────────────────

/// 从登录响应里挑出 token 与过期时间。
///
/// 接口不同版本字段名不一（token / accessToken、expireTime 有秒也有毫秒），
/// 这里逐个试并统一换算成秒级时间戳；拿到就返回，拿不到由调用方报错。
fn extract_token(value: &serde_json::Value) -> (String, i64) {
	let data = payload(value);
	let token = ["token", "accessToken", "access_token"]
		.iter()
		.find_map(|key| data.get(*key).and_then(|v| v.as_str()))
		.unwrap_or("")
		.to_string();
	let now = std::time::SystemTime::now()
		.duration_since(std::time::UNIX_EPOCH)
		.map(|d| d.as_secs() as i64)
		.unwrap_or(0);
	// 优先绝对时间（> 1e12 是毫秒），其次是相对秒数
	let mut expire_at = 0;
	for key in ["expireTime", "expiresAt", "expireAt"] {
		if let Some(raw) = data.get(key).and_then(|v| v.as_i64()) {
			expire_at = if raw > 1_000_000_000_000 { raw / 1000 } else { raw };
			break;
		}
	}
	if expire_at == 0 {
		if let Some(secs) = data.get("expiresIn").and_then(|v| v.as_i64()) {
			expire_at = now + secs;
		}
	}
	// 毫秒级的未来时间也会落在这里，统一兜一下
	if expire_at > 0 && expire_at > 10_000_000_000 {
		expire_at /= 1000;
	}
	(token, expire_at)
}

/// 登录：账号密码 → v3 加密 POST /auth/login → 存 token（DPAPI 密文）。
///
/// 只保存 token，**不保存密码**；未登录时也可调用（此时请求不带 Authorization）。
#[tauri::command(rename = "anime_login")]
pub async fn login(
	app: tauri::AppHandle,
	base_url: String,
	account: String,
	password: String,
) -> Result<serde_json::Value, String> {
	if account.trim().is_empty() || password.is_empty() {
		return Err("账号和密码都要填".into());
	}
	let client = crate::infra::proxy::client_for(&app, Some(REQUEST_TIMEOUT))?;
	let result = enc_call_retry(
		&app,
		&client,
		&base_url,
		"/api/v1/app/client/auth/login",
		&serde_json::json!({
			"account": account.trim(),
			"password": password,
			"deviceId": DEVICE_ID,
			"deviceName": "TeraShell"
		}),
	)
	.await?;
	let (token, expire_at) = extract_token(&result);
	if token.is_empty() {
		let message = payload(&result)
			.get("msg")
			.and_then(|v| v.as_str())
			.unwrap_or("登录响应里没有 token");
		tracing::warn!(%message, "动漫登录失败");
		return Err(format!("登录失败：{message}"));
	}
	let cipher = crate::infra::secret::encrypt(token)?;
	save_account(
		&app,
		&AnimeAccount {
			account: account.trim().to_string(),
			token_cipher: cipher,
			expire_at,
		},
	)
	.await?;
	tracing::info!(account = %account.trim(), expire_at, "动漫账号登录成功");
	Ok(serde_json::json!({
		"account": account.trim(),
		"expireAt": expire_at
	}))
}

/// 当前登录态（不返回 token 本身）。
#[tauri::command(rename = "anime_account_status")]
pub fn account_status(app: tauri::AppHandle) -> serde_json::Value {
	let account = load_account(&app);
	serde_json::json!({
		"account": account.account,
		"loggedIn": account_token(&app).is_some(),
		"expireAt": account.expire_at
	})
}

/// 退出登录：清掉本地 token。
#[tauri::command(rename = "anime_logout")]
pub async fn logout(app: tauri::AppHandle) -> Result<(), String> {
	save_account(&app, &AnimeAccount::default()).await?;
	tracing::info!("动漫账号已退出");
	Ok(())
}

/// 会员信息（`/vip/info`）：原样返回，字段由服务端决定。
#[tauri::command(rename = "anime_vip_info")]
pub async fn vip_info(
	app: tauri::AppHandle,
	base_url: String,
) -> Result<serde_json::Value, String> {
	let client = crate::infra::proxy::client_for(&app, Some(REQUEST_TIMEOUT))?;
	enc_call_retry(&app, &client, &base_url, "/api/v1/app/client/vip/info", &serde_json::json!({}))
		.await
}

/// 兑换码（`/vip/redeem`）。这是官方给的免费领取路径，不涉及支付。
#[tauri::command(rename = "anime_redeem")]
pub async fn redeem(
	app: tauri::AppHandle,
	base_url: String,
	code: String,
) -> Result<serde_json::Value, String> {
	if code.trim().is_empty() {
		return Err("兑换码不能为空".into());
	}
	if account_token(&app).is_none() {
		return Err("请先登录账号再兑换".into());
	}
	let client = crate::infra::proxy::client_for(&app, Some(REQUEST_TIMEOUT))?;
	let result = enc_call_retry(
		&app,
		&client,
		&base_url,
		"/api/v1/app/client/vip/redeem",
		&serde_json::json!({ "code": code.trim() }),
	)
	.await?;
	tracing::info!(code = %code.trim(), "动漫兑换码已提交");
	Ok(result)
}

/// 聚站（juzong01.me，苹果CMS stui 模板）的基址。
const JUZ_BASE: &str = "https://www.juzong01.me";
/// 聚站 dujia* 解析线路的换址服务：播放页把加密 token 原样传给它的播放器
/// 页，由该服务换出真实媒体地址（2026-11-03 抓包实锤，见 juz_resolve_token）。
const JUZ_PARSE_BASE: &str = "https://jzpic.ok1333.cn";
/// 聚站 WAF 只认像样的浏览器 UA（默认 okhttp UA 会被 403）。
const JUZ_UA: &str = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

/// 聚站域名的 GET：用户配置了代理就走代理；代理连接失败（代理软件没开）
/// 自动退直连重试一次——聚站与解析服务直连可达，不该被代理故障拦死。
async fn juz_fetch_url(
	app: &tauri::AppHandle,
	url: &str,
	cookie: Option<&str>,
) -> Result<(u16, String, Vec<u8>), String> {
	// 首选：用户设置（含代理）
	let send_with = |client: &reqwest::Client| {
		let client = client.clone();
		let url = url.to_string();
		let cookie = cookie.map(str::to_string);
		async move {
			let mut request = client
				.get(&url)
				.header("User-Agent", JUZ_UA)
				.header("Accept", "text/html,application/xhtml+xml,*/*;q=0.8")
				.header("Referer", format!("{JUZ_BASE}/"));
			if let Some(value) = &cookie {
				request = request.header("Cookie", value);
			}
			let response = request
				.send()
				.await
				.map_err(|e| format!("{e}#CONNECT#{}", e.is_connect()))?;
			let status = response.status().as_u16();
			// 收集 Set-Cookie 的 name=value 段（属性全丢掉，跨请求只要键值）
			let mut cookies = String::new();
			for value in response.headers().get_all("set-cookie") {
				if let Ok(raw) = value.to_str() {
					if let Some(pair) = raw.split(';').next() {
						if !cookies.is_empty() {
							cookies.push_str("; ");
						}
						cookies.push_str(pair.trim());
					}
				}
			}
			let body = response.bytes().await.map_err(|e| e.to_string())?;
			if body.len() > MAX_BODY_BYTES {
				return Err("聚站响应过大（超过 8MB）".into());
			}
			Ok::<_, String>((status, cookies, body.to_vec()))
		}
	};

	let settings = crate::infra::proxy::load(app);
	let proxy_client = crate::infra::proxy::build_client(&settings, Some(REQUEST_TIMEOUT))?;
	match send_with(&proxy_client).await {
		Ok(result) => Ok(result),
		Err(first_error) => {
			// 仅网络层连接错误才值得直连兜底；HTTP 状态错误原样抛出
			let connect_failure = first_error.contains("#CONNECT#true");
			if !(connect_failure && settings.enabled) {
				return Err(format!(
					"聚站页面请求失败：{}",
					first_error
						.replace("#CONNECT#true", "")
						.replace("#CONNECT#false", "")
				));
			}
			tracing::warn!(%url, "聚站代理连接失败，退直连重试");
			let direct = crate::infra::proxy::build_client(
				&crate::infra::proxy::ProxySettings::default(),
				Some(REQUEST_TIMEOUT),
			)?;
			send_with(&direct)
				.await
				.map_err(|e| {
					format!(
						"聚站页面请求失败（代理与直连均失败）：{}",
						e.replace("#CONNECT#true", "").replace("#CONNECT#false", "")
					)
				})
		}
	}
}

/// 取回聚站的一个 HTML 页面。
///
/// ## 该站的访问门槛
///
/// 前面架了简易 WAF：首次请求返回一个 179 字节的 JS 跳转桩并下发两条
/// Cookie（`server_session_*` + 一条随机名），**带 Cookie 重放同一 URL**
/// 才给真内容（实测二次请求 200、19KB+；不带就是 403）。
/// 流程：有缓存 Cookie 单发直取，失效/没有才「两连发」重取并缓存——
/// 搜索接口还有 6 秒频控，两连发会让第二次必吃频控页。
///
/// 只放行本站域名（SSRF 收口）；m3u8 片段不经过这里，走 `anime_fetch_text`。
#[tauri::command(rename = "juz_get")]
pub async fn juz_get(
	app: tauri::AppHandle,
	url: String,
) -> Result<String, String> {
	if !url.starts_with(JUZ_BASE) {
		return Err(format!("只允许访问 {JUZ_BASE} 下的页面"));
	}
	// 有缓存 Cookie 就单发直取：搜索接口 6 秒频控，两连发会把配额烧在第一发上
	let cached = JUZ_COOKIE.lock().ok().and_then(|slot| slot.clone());
	if let Some(cookie) = cached {
		if let Ok((status, _, body)) = juz_fetch_url(&app, &url, Some(&cookie)).await {
			let text = String::from_utf8_lossy(&body).into_owned();
			// WAF 桩特征：极短 + JS 重定向；命中说明 Cookie 已失效，落回两连发
			if status == 200 && !(text.len() < 1024 && text.contains("window.location.href")) {
				tracing::info!(%url, len = text.len(), "聚站页面已取回");
				return Ok(text);
			}
			tracing::warn!(status, len = text.len(), %url, "聚站缓存 Cookie 失效，重新过 WAF");
		}
	}
	// 第一发：拿 WAF Cookie（桩响应也是 200，别看状态，看 Cookie）
	let (_, cookies, _) = juz_fetch_url(&app, &url, None).await?;
	// 第二发：带 Cookie 取真内容
	let (status, _, body) = juz_fetch_url(&app, &url, Some(&cookies)).await?;
	if let Ok(mut slot) = JUZ_COOKIE.lock() {
		*slot = Some(cookies);
	}
	let text = String::from_utf8_lossy(&body).into_owned();
	// WAF 没放行的特征：还是那个跳转桩（极短 + JS 重定向）；或干脆 403
	if status != 200 || (text.len() < 1024 && text.contains("window.location.href")) {
		tracing::warn!(status, len = text.len(), %url, "聚站返回 WAF 拦截页");
		return Err(format!("聚站拦截了请求（HTTP {status}），稍后重试"));
	}
	tracing::info!(%url, len = text.len(), "聚站页面已取回");
	Ok(text)
}

/// 解析聚站 dujia* 解析线路的加密 token，换出真实媒体直链。
///
/// ## 协议（2026-11-03 抓包逆向）
///
/// 站点把 token 原样塞进自己的播放器页（`{PARSE_BASE}/?url={token}&…`），
/// 页面内嵌一次性 `WGART_PARSE_TOKEN`，再由播放器 JS 调
/// `{PARSE_BASE}/wgart/api.php?action=try_json_api&video_url={token}&parse_token={PT}`
/// 换出 `{success, data:{url}}`。这里复刻同样的两步：
/// 1. GET 播放器页，抠出本次会话的 parse_token；
/// 2. GET api.php 换地址，校验 success 后返回 data.url。
#[tauri::command(rename = "juz_resolve_token")]
pub async fn juz_resolve_token(
	app: tauri::AppHandle,
	token: String,
) -> Result<String, String> {
	let token = token.trim();
	if token.is_empty() {
		return Err("解析 token 为空".into());
	}
	let client = crate::infra::proxy::client_for(&app, Some(REQUEST_TIMEOUT))?;
	let send = |url: String| {
		let client = client.clone();
		async move {
			let response = client
				.get(&url)
				.header("User-Agent", JUZ_UA)
				.header("Referer", format!("{JUZ_BASE}/"))
				.send()
				.await
				.map_err(|e| format!("解析服务请求失败：{}", describe_reqwest(&e)))?;
			let status = response.status().as_u16();
			let body = response.bytes().await.map_err(|e| format!("读取解析服务失败：{e}"))?;
			if body.len() > MAX_BODY_BYTES {
				return Err("解析服务响应过大".into());
			}
			Ok::<_, String>((status, body))
		}
	};

	// 第一步：拿播放器页里的一次性 parse_token
	let player_url = format!(
		"{JUZ_PARSE_BASE}/?url={}&name=&id=&ep=1&source_index=0",
		urlencode_component(token)
	);
	let (status, body) = send(player_url).await?;
	if status != 200 {
		return Err(format!("解析服务不可用（HTTP {status}）"));
	}
	let player_html = String::from_utf8_lossy(&body).into_owned();
	let parse_token = player_html
		.split("WGART_PARSE_TOKEN=\"")
		.nth(1)
		.and_then(|rest| rest.split('"').next())
		.ok_or("解析服务没给会话令牌（页面结构变了）")?
		.to_string();

	// 第二步：换真实地址
	let api_url = format!(
		"{JUZ_PARSE_BASE}/wgart/api.php?action=try_json_api&video_url={}&parse_token={}",
		urlencode_component(token),
		urlencode_component(&parse_token)
	);
	let (status, body) = send(api_url).await?;
	if status != 200 {
		return Err(format!("解析接口返回 HTTP {status}"));
	}
	let text = String::from_utf8_lossy(&body).into_owned();
	let value: serde_json::Value =
		serde_json::from_str(&text).map_err(|e| format!("解析接口响应不是 JSON：{e}"))?;
	if value.get("success").and_then(|v| v.as_bool()) != Some(true) {
		let msg = value
			.get("message")
			.and_then(|v| v.as_str())
			.unwrap_or("该集在这条解析线路上没有可用地址");
		return Err(format!("解析失败：{msg}"));
	}
	let url = value
		.pointer("/data/url")
		.and_then(|v| v.as_str())
		.unwrap_or("")
		.to_string();
	if url.is_empty() {
		return Err("解析成功但没拿到地址".into());
	}
	tracing::info!(len = url.len(), "聚站解析线路已换出真实地址");
	Ok(url)
}

/// 最小 percent-encoding：token/parse_token 都是 URL 安全字符集，只需处理
/// 少数保留字符（serde_urlencoded 为一个参数引整个 crate 不值）。
fn urlencode_component(input: &str) -> String {
	let mut out = String::with_capacity(input.len());
	for byte in input.bytes() {
		match byte {
			b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
				out.push(byte as char)
			}
			_ => out.push_str(&format!("%{byte:02X}")),
		}
	}
	out
}

#[cfg(test)]
mod tests {
	use super::derive_device_secret;

	/// 用手机端实测值锁定派生公式（2026-11-01 逆向验证）。
	#[test]
	fn derive_device_secret_matches_known() {
		// 老设备：masterSecret 派生结果 == 之前硬编码的 secret
		let old = "3aaeaab0df9681170d5f714c058d07c208b1f1c52072bcd94534bc2acd8d1272";
		assert_eq!(
			derive_device_secret(old),
			"9af94e4c81c48cf80599b25bca851264706f8f8bcabe68f14114ecf92154f27e"
		);
		// 手机设备：与运行期日志 MAGICPWN 推导一致
		let phone = "bf29a99b520e5530ce3fe76bf9e443a615d155f1f92b79a24aec6a8be3dde1b8";
		assert_eq!(
			derive_device_secret(phone),
			"519487380f39e745c57ec048c1a4ce866dd50f88c5528608c367c9e221d698a0"
		);
	}
}

// ─── 下载（m3u8 → TS 拼接 → ffmpeg 转封装 mp4） ───────────────────────────

/// 下载进度事件负载（事件名 anime-download-progress）。
#[derive(Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct DownloadProgress {
	/// 前端生成的任务 id（区分并发任务）
	id: String,
	/// 已完成片段数
	done: u64,
	/// 片段总数
	total: u64,
	/// true 表示任务终态（此时 path/error 生效）
	finished: bool,
	/// 成品文件路径（finished 且无 error 时有效）
	path: String,
	/// 失败原因（finished 且非空时有效）
	error: String,
}

/// 相对地址拼接：m3u8 里的片段/子清单常用相对路径。
/// 支持 绝对 URL、//开头、/开头、裸相对路径 四种形态。
fn join_url(base: &str, target: &str) -> String {
	if target.starts_with("http://") || target.starts_with("https://") {
		return target.to_string();
	}
	if let Some(rest) = target.strip_prefix("//") {
		let scheme = base.split("://").next().unwrap_or("https");
		return format!("{scheme}://{rest}");
	}
	if target.starts_with('/') {
		if let Some(pos) = base.find("://") {
			let after = &base[pos + 3..];
			let host = after.split('/').next().unwrap_or("");
			return format!("{}://{}{}", &base[..pos], host, target);
		}
	}
	// 裸相对：去掉 base 最后一段后拼接
	match base.rfind('/') {
		Some(pos) => format!("{}{}", &base[..pos + 1], target),
		None => format!("{base}/{target}"),
	}
}

/// 解析 m3u8 清单，返回下一层地址列表：
/// 主清单（含 #EXT-X-STREAM-INF）→ 只取第一档子清单地址；
/// 媒体清单 → 按序返回全部片段地址。
fn parse_hls_segments(base: &str, text: &str) -> Vec<String> {
	let mut is_master = false;
	let mut urls = Vec::new();
	for line in text.lines() {
		let line = line.trim();
		if line.starts_with("#EXT-X-STREAM-INF") {
			is_master = true;
			continue;
		}
		if line.is_empty() || line.starts_with('#') {
			continue;
		}
		urls.push(join_url(base, line));
		if is_master {
			// 主清单只取第一档：下载场景不挑画质，够用
			break;
		}
	}
	urls
}

/// 单个片段并发数：4 路并行对 CDN 礼貌且够快。
const DOWNLOAD_CONCURRENCY: usize = 4;

/// 单片段大小上限：高码率 1080P 的 10 秒片段常见 10~20MB，8MB 的接口上限太小。
/// ponytail: 缓冲式读取，4 路并发瞬时最多 4×64MB 内存；再大就得改流式落盘
const DOWNLOAD_SEGMENT_MAX: usize = 64 * 1024 * 1024;

/// 让用户选下载目录；取消返回 Ok(None)（前端静默收手）。
#[tauri::command(rename = "anime_pick_download_dir")]
pub async fn anime_pick_download_dir(
	app: tauri::AppHandle,
) -> Result<Option<String>, String> {
	let picked = tauri::async_runtime::spawn_blocking(move || {
		app.dialog().file().blocking_pick_folder()
	})
	.await
	.map_err(|error| format!("打开目录选择框失败：{error}"))?;
	Ok(picked.map(|path| path.to_string()))
}

/// 下载一集。立即返回，进度走事件 anime-download-progress；
/// finished=true 时 path 为成品路径（ffmpeg 缺失时保留 TS）或 error 为失败原因。
#[tauri::command(rename = "anime_download")]
pub async fn anime_download(
	app: tauri::AppHandle,
	id: String,
	url: String,
	name: String,
	out_dir: Option<String>,
) -> Result<(), String> {
	if !url.starts_with("http://") && !url.starts_with("https://") {
		return Err("只支持 http(s) 地址".into());
	}
	// 下载专用客户端：不设总超时（REQUEST_TIMEOUT 的 20 秒会把几 MB 的片段
	// 掐死在半路，报「片段读取失败：error decoding response body」），
	// 只留 15 秒连接超时 + 单片段重试兜底
	let settings = crate::infra::proxy::load(&app);
	let client = crate::infra::proxy::build_client(&settings, None)?;
	// ffmpeg 路径在带句柄时解析好传进去（转封装用；没有就保留 TS）
	let ffmpeg = crate::anime_transcode::find_ffmpeg(&app);
	tokio::spawn(async move {
		match download_impl(&app, &client, &id, &url, &name, out_dir, ffmpeg).await {
			Ok(path) => {
				tracing::info!(%id, %path, "下载完成");
				let _ = app.emit(
					"anime-download-progress",
					DownloadProgress {
						id,
						done: 0,
						total: 0,
						finished: true,
						path,
						error: String::new(),
					},
				);
			}
			Err(error) => {
				tracing::warn!(%id, %error, "下载失败");
				let _ = app.emit(
					"anime-download-progress",
					DownloadProgress {
						id,
						done: 0,
						total: 0,
						finished: true,
						path: String::new(),
						error,
					},
				);
			}
		}
	});
	Ok(())
}

/// 下载主体：解析清单 → 并发拉片段（临时文件落地）→ 顺序拼接 → ffmpeg 转封装。
async fn download_impl(
	app: &tauri::AppHandle,
	client: &reqwest::Client,
	id: &str,
	url: &str,
	name: &str,
	out_dir: Option<String>,
	ffmpeg: Option<std::path::PathBuf>,
) -> Result<String, String> {
	// 片段清单：直链（mp4 等）就是单片段；m3u8 主清单最多剥两层子清单
	let segments = if url.contains(".m3u8") {
		let mut list_url = url.to_string();
		let mut text = fetch_text_inner(client, &list_url).await?;
		for _depth in 0..2 {
			if !text.contains("#EXT-X-STREAM-INF") {
				break;
			}
			let next = parse_hls_segments(&list_url, &text);
			list_url = next
				.first()
				.ok_or("主清单里没有子清单地址")?
				.clone();
			text = fetch_text_inner(client, &list_url).await?;
		}
		let segments = parse_hls_segments(&list_url, &text);
		if text.contains("#EXT-X-STREAM-INF") || segments.is_empty() {
			return Err("m3u8 嵌套超两层或没有片段，不支持的清单结构".into());
		}
		// 加密（#EXT-X-KEY）/初始化段（#EXT-X-MAP）/字节范围是自研下载器的盲区：
		// 路由给 N_m3u8DL-RE sidecar（它自己拉密钥解密）；没装 sidecar 就按原路
		// 继续——产物可能不可播，与未接 RE 时现状一致
		if needs_re_engine(&text) {
			if let Some(nre) = find_nre() {
				return download_with_re(
					app,
					&nre,
					&list_url,
					id,
					name,
					out_dir.clone(),
					ffmpeg,
				)
				.await;
			}
			tracing::warn!("清单含加密/初始化段但未找到 N_m3u8DL-RE sidecar，按原路下载");
		}
		segments
	} else {
		vec![url.to_string()]
	};

	// 临时目录：片段先落盘（整集内存里放不下）
	let stamp = std::time::SystemTime::now()
		.duration_since(std::time::UNIX_EPOCH)
		.map(|d| d.as_millis())
		.unwrap_or(0);
	let temp_dir = std::env::temp_dir().join(format!("tera-shell-dl-{stamp}"));
	std::fs::create_dir_all(&temp_dir).map_err(|e| format!("建临时目录失败：{e}"))?;

	if let Err(error) =
		download_segments(app, id, client, &segments, &temp_dir).await
	{
		let _ = std::fs::remove_dir_all(&temp_dir);
		return Err(error);
	}

	// 拼输出路径：用户选的目录优先，没有就用系统下载目录；都拿不到留在临时目录
	let file_stem = sanitize_filename(name);
	let out_dir = match out_dir {
		Some(dir) if !dir.trim().is_empty() => std::path::PathBuf::from(dir),
		_ => app
			.path()
			.download_dir()
			.ok()
			.unwrap_or_else(|| temp_dir.clone()),
	};
	let _ = std::fs::create_dir_all(&out_dir);
	let ts_path = out_dir.join(format!("{file_stem}.ts"));
	concat_parts(&temp_dir, &ts_path)?;
	let _ = std::fs::remove_dir_all(&temp_dir);

	// 有 ffmpeg 就转封装成 mp4（流复制，秒级）；没有就交 TS（通用播放器都认）
	Ok(remux_or_keep_ts(
		ffmpeg.as_deref(),
		&ts_path,
		&out_dir,
		&file_stem,
	))
}

/// ffmpeg 流复制转封装 TS → mp4；没 ffmpeg 或转封失败就保留 TS（返回成品路径）。
fn remux_or_keep_ts(
	ffmpeg: Option<&std::path::Path>,
	ts_path: &std::path::Path,
	out_dir: &std::path::Path,
	file_stem: &str,
) -> String {
	let ts = ts_path.to_string_lossy().into_owned();
	let Some(ffmpeg) = ffmpeg else {
		return ts;
	};
	let mp4_path = out_dir.join(format!("{file_stem}.mp4"));
	let output = std::process::Command::new(ffmpeg)
		.args(["-y", "-hide_banner", "-loglevel", "error"])
		.arg("-i")
		.arg(ts_path)
		.args(["-c", "copy", "-bsf:a", "aac_adtstoasc"])
		.arg(&mp4_path)
		.output();
	let Ok(output) = output else {
		return ts;
	};
	if output.status.success() && mp4_path.is_file() {
		let _ = std::fs::remove_file(ts_path);
		return mp4_path.to_string_lossy().into_owned();
	}
	let stderr = String::from_utf8_lossy(&output.stderr);
	tracing::warn!(%stderr, "ffmpeg 转封装失败，保留 TS");
	ts
}

/// N_m3u8DL-RE sidecar（externalBin）路径：dev 在 target/debug/，安装后在主程序同目录。
fn find_nre() -> Option<std::path::PathBuf> {
	let exe = std::env::current_exe().ok()?;
	let dir = exe.parent()?;
	let candidate = dir.join("tera-shell-nre.exe");
	candidate.is_file().then_some(candidate)
}

/// 清单是否带自研下载器接不了的特征：AES 密钥（#EXT-X-KEY）、
/// 初始化段（#EXT-X-MAP）、字节范围（EXT-X-BYTERANGE）。
fn needs_re_engine(text: &str) -> bool {
	text.contains("#EXT-X-KEY")
		|| text.contains("#EXT-X-MAP")
		|| text.contains("EXT-X-BYTERANGE")
}

/// 走 N_m3u8DL-RE 下载（自研下载器接不了的清单才路由到这里）：
/// RE 自己拉密钥、解密、按分片下载并合并成 TS，之后仍用本机 ffmpeg 转封装。
/// 进度从 RE 的 stdout 文本里抽 `NN%`（RE 会打 ANSI 控制序列，但百分比本身
/// 是连续字节，直接抽得动）；抽不到就一直停在 0%。
async fn download_with_re(
	app: &tauri::AppHandle,
	nre: &std::path::Path,
	url: &str,
	id: &str,
	name: &str,
	out_dir: Option<String>,
	ffmpeg: Option<std::path::PathBuf>,
) -> Result<String, String> {
	use std::process::Stdio;
	use tokio::io::AsyncReadExt;

	let file_stem = sanitize_filename(name);
	let out_path = match out_dir.as_deref() {
		Some(dir) if !dir.trim().is_empty() => std::path::PathBuf::from(dir),
		// 没选目录：系统下载目录，再没有就落临时目录（RE 自己的临时目录也在旁边）
		_ => app
			.path()
			.download_dir()
			.unwrap_or_else(|_| std::env::temp_dir()),
	};
	std::fs::create_dir_all(&out_path).map_err(|e| format!("建输出目录失败：{e}"))?;
	let stamp = std::time::SystemTime::now()
		.duration_since(std::time::UNIX_EPOCH)
		.map(|d| d.as_millis())
		.unwrap_or(0);
	tracing::info!(%id, nre = %nre.display(), "清单含加密/初始化段，改走 N_m3u8DL-RE");
	let mut child = tokio::process::Command::new(nre)
		.arg(url)
		.arg("--save-dir")
		.arg(&out_path)
		.arg("--save-name")
		.arg(&file_stem)
		.arg("--tmp-dir")
		.arg(out_path.join(format!(".nre-tmp-{stamp}")))
		.args(["--ui-language", "zh-CN"])
		.args(["--log-level", "OFF"])
		.stdin(Stdio::null())
		.stderr(Stdio::null())
		.stdout(Stdio::piped())
		.kill_on_drop(true)
		.spawn()
		.map_err(|e| format!("启动 N_m3u8DL-RE 失败：{e}"))?;

	// stdout 逐块扫百分比；攒一条最近的有效信息行（非纯进度），失败时带进错误信息
	let mut stdout = child
		.stdout
		.take()
		.ok_or("N_m3u8DL-RE 没有可读输出")?;
	let mut buffer = [0u8; 4096];
	let mut carry = String::new();
	let mut last_pct: u64 = 0;
	let mut last_info = String::new();
	loop {
		match stdout.read(&mut buffer).await {
			Ok(0) | Err(_) => break,
			Ok(n) => {
				carry.push_str(&String::from_utf8_lossy(&buffer[..n]));
				while let Some(pos) = carry.find(['\n', '\r']) {
					let line = carry[..pos].trim().to_string();
					carry.drain(..=pos);
					let before = last_pct;
					scan_re_line(&line, &mut last_pct, &mut last_info);
					// 百分比有跳变才发事件：RE 每秒刷新一屏，原样转发太吵
					if last_pct > before {
						let _ = app.emit(
							"anime-download-progress",
							DownloadProgress {
								id: id.to_string(),
								done: last_pct,
								total: 100,
								finished: false,
								path: String::new(),
								error: String::new(),
							},
						);
					}
				}
			}
		}
	}

	let status = child
		.wait()
		.await
		.map_err(|e| format!("等待 N_m3u8DL-RE 失败：{e}"))?;
	if !status.success() {
		let reason = if last_info.is_empty() {
			format!("退出码 {:?}", status.code())
		} else {
			last_info
		};
		return Err(format!("N_m3u8DL-RE 下载失败：{reason}"));
	}
	let ts_path = out_path.join(format!("{file_stem}.ts"));
	if !ts_path.is_file() {
		return Err("N_m3u8DL-RE 完成但没有产出文件".into());
	}
	Ok(remux_or_keep_ts(
		ffmpeg.as_deref(),
		&ts_path,
		&out_path,
		&file_stem,
	))
}

/// 从 RE 的一行输出里抽进度百分比与最近的有效信息行（错误说明通常在这）。
fn scan_re_line(line: &str, last_pct: &mut u64, last_info: &mut String) {
	if line.is_empty() {
		return;
	}
	// 行里找最后一个 `%`，往前收连续的 [0-9.] 组成百分数
	// （空格不能进数字串：进度行形如 `00:00:12 34.5%`，会连时间戳一起吞进去）
	if let Some(pos) = line.rfind('%') {
		let head = &line[..pos];
		let start = head
			.char_indices()
			.rev()
			.take_while(|(_, c)| c.is_ascii_digit() || *c == '.')
			.map(|(i, _)| i)
			.last()
			.unwrap_or(head.len());
		if let Ok(value) = head[start..].trim().parse::<f64>() {
			let pct = value.clamp(0.0, 100.0) as u64;
			if pct > *last_pct {
				*last_pct = pct;
			}
		}
	}
	// 不含百分比的较长行记作信息行
	if !line.contains('%') && line.chars().count() > 12 {
		*last_info = line.to_string();
	}
}

/// 并发拉全部片段到临时目录（4 路一批，批内并发、批间按序写盘保证拼接顺序）。
/// 每批完成发一次进度事件。
async fn download_segments(
	app: &tauri::AppHandle,
	id: &str,
	client: &reqwest::Client,
	segments: &[String],
	temp_dir: &std::path::Path,
) -> Result<(), String> {
	let total = segments.len() as u64;
	for (batch_start, batch) in segments.chunks(DOWNLOAD_CONCURRENCY).enumerate() {
		let mut fetched = Vec::with_capacity(batch.len());
		for seg_url in batch {
			let client = client.clone();
			let seg_url = seg_url.clone();
			fetched.push(tokio::spawn(async move {
				// CDN 偶发掐断传输（body 解码错误/连接重置）很常见，单片段重试 3 次
				let mut last_error = String::new();
				for attempt in 0..3 {
					if attempt > 0 {
						tokio::time::sleep(std::time::Duration::from_millis(500 * attempt as u64)).await;
					}
					let result = async {
						// 单请求 90 秒硬上限：客户端没设总超时（怕慢链路掐半路），
						// 但服务端只连不发时请求会永久挂起——必须逐请求兜底
						let response = client
							.get(&seg_url)
							.header("User-Agent", "okhttp/3.12.1")
							.timeout(std::time::Duration::from_secs(90))
							.send()
							.await
							.map_err(|e| format!("片段请求失败：{e}"))?;
						let status = response.status().as_u16();
						if status != 200 {
							return Err(format!("片段返回 HTTP {status}"));
						}
						let bytes = response
							.bytes()
							.await
							.map_err(|e| format!("片段读取失败：{e}"))?;
					if bytes.len() > DOWNLOAD_SEGMENT_MAX {
						return Err(format!(
							"单个片段超过 {}MB，异常源",
							DOWNLOAD_SEGMENT_MAX / 1024 / 1024
						));
					}
						Ok(bytes.to_vec())
					}
					.await;
					match result {
						Ok(bytes) => return Ok::<Vec<u8>, String>(bytes),
						Err(error) => {
							tracing::warn!(%seg_url, attempt, %error, "片段下载失败，准备重试");
							last_error = error;
						}
					}
				}
				Err(last_error)
			}));
		}
		// 缺一个就整体失败（断点续传不做——YAGNI，失败重下整集即可）
		for (offset, handle) in fetched.into_iter().enumerate() {
			let index = batch_start * DOWNLOAD_CONCURRENCY + offset;
			let bytes = handle
				.await
				.map_err(|e| format!("下载任务异常：{e}"))??;
			let part = temp_dir.join(format!("part_{index:05}.ts"));
			std::fs::write(&part, &bytes).map_err(|e| format!("写片段失败：{e}"))?;
		}
		let _ = app.emit(
			"anime-download-progress",
			DownloadProgress {
				id: id.to_string(),
				done: ((batch_start + 1) * DOWNLOAD_CONCURRENCY).min(total as usize) as u64,
				total,
				finished: false,
				path: String::new(),
				error: String::new(),
			},
		);
	}
	Ok(())
}

/// 把临时目录里的 part_* 按序拼成完整 TS。
fn concat_parts(temp_dir: &std::path::Path, out: &std::path::Path) -> Result<(), String> {
	let mut parts: Vec<_> = std::fs::read_dir(temp_dir)
		.map_err(|e| format!("读临时目录失败：{e}"))?
		.filter_map(|entry| entry.ok())
		.filter(|entry| entry.file_name().to_string_lossy().starts_with("part_"))
		.collect();
	parts.sort_by_key(|entry| entry.file_name());
	let mut out_file =
		std::fs::File::create(out).map_err(|e| format!("建输出文件失败：{e}"))?;
	use std::io::Write;
	for part in parts {
		let bytes = std::fs::read(part.path()).map_err(|e| format!("读片段失败：{e}"))?;
		out_file
			.write_all(&bytes)
			.map_err(|e| format!("拼接失败：{e}"))?;
	}
	Ok(())
}

/// 文件名消毒：路径分隔与 Windows 非法字符换下划线，空了给默认名。
fn sanitize_filename(name: &str) -> String {
	let cleaned: String = name
		.chars()
		.map(|c| match c {
			'\\' | '/' | ':' | '*' | '?' | '"' | '<' | '>' | '|' => '_',
			_ => c,
		})
		.collect();
	let trimmed = cleaned.trim();
	if trimmed.is_empty() {
		"anime-download".into()
	} else {
		trimmed.into()
	}
}

/// 取回一个文本资源（下载模块内部复用，与 fetch_text 命令同款请求头）。
async fn fetch_text_inner(client: &reqwest::Client, url: &str) -> Result<String, String> {
	let response = client
		.get(url)
		.header("User-Agent", "okhttp/3.12.1")
		.header("Accept", "*/*")
		// 清单很小，30 秒足够；防挂起
		.timeout(std::time::Duration::from_secs(30))
		.send()
		.await
		.map_err(|e| format!("清单请求失败：{e}"))?;
	let status = response.status().as_u16();
	if status != 200 {
		return Err(format!("清单返回 HTTP {status}"));
	}
	let body = response
		.bytes()
		.await
		.map_err(|e| format!("清单读取失败：{e}"))?;
	if body.len() > MAX_BODY_BYTES {
		return Err("清单过大".into());
	}
	Ok(String::from_utf8_lossy(&body).into_owned())
}

// 单测放 tests/unit/anime_download.rs（join_url / parse_hls_segments 的行为锁定）
#[cfg(test)]
#[path = "../tests/unit/anime_download.rs"]
mod anime_download_tests;
