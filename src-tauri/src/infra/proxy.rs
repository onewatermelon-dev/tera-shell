//! 网络代理：把设置里的代理配置应用到所有出站 HTTP 请求。
//!
//! ## 为什么需要它
//!
//! 应用有三处出站请求：模型连通性测试、模型聊天/流式对话、检查更新。
//! 前两处走这里的 reqwest，**必须**支持代理 —— 否则用户挂上梯子后 AI
//! 照样连不上；后一处原先走前端 `fetch`，但 WebView2 的 fetch 既不认
//! 系统代理也不认本设置（那是浏览器沙箱的网络栈），因此改由
//! [`http_get_json`] 代发。
//!
//! ## 为什么每次请求都重建 Client
//!
//! `reqwest::Client` 内部持有连接池，构造开销不大但复用能省掉重复的
//! TLS 握手。这里选择**每次重建**，理由是设置随时可能改：用户正在
//! 流式输出时改代理，重建后的下一次请求立刻走新代理，而复用一个
//! 旧 Client 会让改动看起来「没生效」，排查起来很费时间。
//! AI 请求频率相对低（人的打字与思考时间远长于握手耗时），这个取舍划算。
//!
//! ## 凭据不进日志
//!
//! 代理地址形如 `http://user:pass@host:port`，带用户名密码是常见写法。
//! 日志里只记录**协议与主机**，凭据部分一律剔除（见 [`describe`]）——
//! 本项目约定日志不得出现敏感明文。

use std::time::Duration;

// ⚠️ reqwest 0.13 把 `proxy` 子模块收成了私有，`Proxy` 改从 crate 根
// 重导出（`reqwest::Proxy`）。写 `reqwest::proxy::Proxy` 会报
// E0603「module proxy is private」
use reqwest::Client;
use reqwest::Proxy;
use tauri::AppHandle;
use tracing::{debug, error, info, warn};

/// 从设置文件里读到的代理配置。
///
/// 字段与前端 `AppSettings` 的 `proxyEnabled` / `proxyUrl` 一一对应。
/// 反序列化用 serde 默认行为：缺字段就是 `None`/`false`，旧设置文件
/// 无需迁移。
#[derive(Debug, Default, serde::Deserialize)]
pub struct ProxySettings {
	/// 用户是否启用代理。
	#[serde(default)]
	pub enabled: bool,
	/// 代理地址，支持 `http://` / `socks5://` / `socks5h://`。
	#[serde(default)]
	pub url: String,
}

/// 直接从设置文件读代理配置。
///
/// ## 为什么后端自己读，而不是让前端传进来
///
/// 前端若要传，就得给 `streamChatCompletion` → `aiChat` → `AiPanel`
/// 一路加参数，四五个文件的签名全要动，而且每加一个调用点就多一处
/// 漏传的机会（漏传的表现是「AI 突然不走代理了」，极难排查）。
/// 设置文件本来就在后端能读到的数据目录里，自己读一份最省事。
///
/// ## 为什么直接读磁盘而不是问前端要内存里的值
///
/// 前端的设置是「内存立即生效、磁盘异步跟上」。理论上存在一个窗口：
/// 用户刚改完代理就发消息，此刻磁盘上还是旧值。但写盘是一次 invoke，
/// 且人从点开关到发消息至少隔一次输入动作，这个窗口实际不可达；
/// 换来的是不需要给每个命令都塞一个参数。
pub fn load(app: &AppHandle) -> ProxySettings {
	let text = match crate::data::read_setting_text(app, "settings")
	{
		Some(text) => text,
		None => {
			// 首次启动还没落盘属正常路径
			debug!("读不到 settings.json，按未启用代理处理");
			return ProxySettings::default();
		}
	};
	// settings.json 是整个应用设置（比代理多很多字段），整体反序列化时
	// 未知的键会被忽略；这里只关心代理那两项
	match serde_json::from_str::<ProxySettings>(&text) {
		Ok(settings) => settings,
		Err(error) => {
			warn!(%error, "settings.json 解析失败，按未启用代理处理");
			ProxySettings::default()
		}
	}
}

impl ProxySettings {
	/// 真正要用的 `reqwest::Proxy`；未启用或地址非法时返回 `None`。
	///
	/// 地址非法**不报错**：设置页的校验是宽松的（用户可能正打着字），
	/// 这里静默退回直连，让 AI 请求按老路走通 —— 一个填错的代理不该
	/// 让整个应用连不上模型。
	pub fn to_proxy(&self) -> Option<Proxy> {
		if !self.enabled {
			return None;
		}
		let url = self.url.trim();
		if url.is_empty() {
			return None;
		}
		match Proxy::all(url) {
			Ok(proxy) => {
				info!(
					proxy = %describe(url),
					"已启用代理"
				);
				Some(proxy)
			}
			Err(error) => {
				// 地址写错是用户手误，不是致命问题：退回直连并说清楚
				warn!(
					proxy = %describe(url),
					%error,
					"代理地址无效，本次请求改用直连"
				);
				None
			}
		}
	}
}

/// 把代理地址里的凭据与路径剔除，只留「协议://主机:端口」用于日志。
///
/// `http://user:pass@1.2.3.4:7890` → `http://1.2.3.4:7890`。
/// 不做这个处理的话，用户在公网环境打出的日志就等于泄露了代理密码。
fn describe(url: &str) -> String {
	// 先剥 scheme，再看 @ 之前有没有凭据
	let (scheme, rest) = match url.split_once("://") {
		Some((scheme, rest)) => {
			(format!("{scheme}://"), rest)
		}
		None => (String::new(), url),
	};
	match rest.rsplit_once('@') {
		// @ 之后才是主机部分
		Some((_, host)) => format!("{scheme}{host}"),
		None => url.to_string(),
	}
}

/// 按代理配置构建一个 reqwest 客户端。
///
/// `timeout` 是**总超时**；流式对话要传 `None`（长回答可能跑几分钟，
/// 中断由前端负责），其余传具体值。`connect_timeout` 单独给 15 秒：
/// 代理地址写错时连接会一直挂着，没有连接超时的表现是「转圈到天荒地老」。
///
/// # Errors
///
/// 客户端构建失败（例如系统 TLS 后端初始化不了）时返回错误文本。
pub fn build_client(
	settings: &ProxySettings,
	timeout: Option<Duration>,
) -> Result<Client, String> {
	let mut builder = Client::builder()
		.connect_timeout(Duration::from_secs(15));
	if let Some(timeout) = timeout {
		builder = builder.timeout(timeout);
	}
	if let Some(proxy) = settings.to_proxy() {
		builder = builder.proxy(proxy);
	} else {
		debug!("未启用代理，使用直连");
	}
	builder
		.build()
		.map_err(|error| error.to_string())
}

/// 便捷入口：从设置文件读代理并构建客户端。
pub fn client_for(
	app: &AppHandle,
	timeout: Option<Duration>,
) -> Result<Client, String> {
	build_client(&load(app), timeout)
}

/// 用代理发一次 GET，返回响应正文（供检查更新等只读场景使用）。
///
/// # Errors
///
/// 网络错误返回 `Err`，非 2xx 返回 `Err` 且带上状态码与正文片段。
#[tauri::command(rename = "app_http_get_json")]
pub async fn http_get_json(
	app: AppHandle,
	url: String,
) -> Result<String, String> {
	let client = client_for(&app, Some(Duration::from_secs(15)))?;
	info!(url = %url, "发起 HTTP GET");
	match client.get(&url).send().await {
		Ok(response) => {
			let status = response.status();
			let text = response.text().await.unwrap_or_default();
			if status.is_success() {
				info!(url = %url, status = %status, "HTTP GET 收到响应");
				Ok(text)
			} else {
				let snippet: String =
					text.chars().take(300).collect();
				error!(
					url = %url,
					status = %status,
					body = %snippet,
					"HTTP GET 非 2xx 响应"
				);
				Err(format!(
					"HTTP {}: {}",
					status.as_u16(),
					snippet
				))
			}
		}
		Err(error) => {
			error!(url = %url, %error, "HTTP GET 失败");
			Err(error.to_string())
		}
	}
}

/// 代理连通性测试的结果。
///
/// `connected` 与 `ok` 分开，是因为「连上了但目标返回了非 2xx」和
/// 「压根没连上」是两件事：前者说明**代理是通的**，只是探测端点不给
/// 友好响应，判成失败会误导用户去查代理配置（2026-10-18 实际踩到：
/// 探测目标是 GitHub API，未认证请求被限流返回 403，用户看到「连接
/// 失败」而代理其实完全正常）。
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProxyTestResult {
	/// 是否成功拿到一次 HTTP 响应。
	pub ok: bool,
	/// 是否连上了目标（false = 连代理都没连上）。
	pub connected: bool,
	/// 状态码：只有 connected 为 true 时有值。
	#[serde(skip_serializing_if = "Option::is_none")]
	pub status: Option<u16>,
	/// 耗时（毫秒）。
	pub elapsed_ms: u128,
	/// 网络层失败时的原因；connected 为 false 时有值。
	#[serde(skip_serializing_if = "Option::is_none")]
	pub error: Option<String>,
}

/// 代理连通性测试：请求一个固定的轻量地址，返回耗时与分类结果。
///
/// ## 为什么强制使用传入的地址，不看设置里的开关
///
/// 测试按钮的语义是「**这个代理地址能不能用**」，不是「我当前的设置
/// 能不能用」。若跟着开关走，用户关着代理点测试必然失败（国内直连
/// 国外地址本来就通不了），得到的结论毫无意义 —— 而这恰恰是最需要
/// 知道「代理不可用」的场合。
///
/// ## 为什么探测端点不用 GitHub API
///
/// `api.github.com` 对未认证请求有速率限制，返回 403 是**正常现象**，
/// 与代理通不通无关。换成 Cloudflare 的 `generate_204`：固定返回
/// 204 空响应、不限流、无需鉴权，唯一的失败原因就是网络本身。
const PROBE_URL: &str = "https://cp.cloudflare.com/generate_204";

/// 代理连通性测试。
///
/// 网络层失败不返回 `Err` 而是用 `connected: false` 表达：前端要区分
/// 「连不上」和「连上了但状态码不对」，靠一个结构体比靠解析错误文本稳。
///
/// # Errors
///
/// 客户端构建失败时返回错误文本。
#[tauri::command(rename = "app_proxy_test")]
pub async fn proxy_test(
	proxy: ProxySettings,
) -> Result<ProxyTestResult, String> {
	// 忽略 enabled：只要给了地址就测它（见函数注释）
	let forced = ProxySettings {
		enabled: true,
		url: proxy.url,
	};
	let client =
		build_client(&forced, Some(Duration::from_secs(10)))?;
	let started = std::time::Instant::now();
	info!("开始代理连通性测试");
	match client.get(PROBE_URL).send().await {
		Ok(response) => {
			let status = response.status();
			let elapsed = started.elapsed();
			let ok = status.is_success();
			if ok {
				info!(
					status = %status,
					ms = elapsed.as_millis(),
					"代理连通性测试通过"
				);
			} else {
				warn!(
					status = %status,
					ms = elapsed.as_millis(),
					"已连上代理但探测端点返回非 2xx（不影响代理可用性判断）"
				);
			}
			Ok(ProxyTestResult {
				ok,
				connected: true,
				status: Some(status.as_u16()),
				elapsed_ms: elapsed.as_millis(),
				error: None,
			})
		}
		Err(error) => {
			let elapsed = started.elapsed();
			error!(%error, ms = elapsed.as_millis(), "代理连通性测试失败");
			Ok(ProxyTestResult {
				ok: false,
				connected: false,
				status: None,
				elapsed_ms: elapsed.as_millis(),
				error: Some(error.to_string()),
			})
		}
	}
}

// 单元测试集中在 src-tauri/tests/unit/：#[path] 把模块编回本处，私有项仍可
// 访问；tests/ 下的直接子文件才是 cargo 的集成测试目标，子目录不自动发现。
#[cfg(test)]
#[path = "../../tests/unit/proxy.rs"]
mod tests;
