//! 独立的 SFTP 窗口。
//!
//! 每个 SFTP 会话开一个**真正的系统窗口**，而不是主窗口里的浮层：
//! 这样它会出现在 Windows 任务栏里、可以并排摆放、能独立最小化，
//! 也不会挡住主窗口里的终端。
//!
//! 前端靠 URL 上的 `?sftp=<sessionId>` 判断自己该渲染终端还是 SFTP，
//! 所以这里只要把窗口建起来、把会话 id 传过去即可。

use std::time::{SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, WebviewUrl, WebviewWindowBuilder};

/// 窗口尺寸：初始值即最小值（与主窗口一致），所以开出来就是最小尺寸，
/// 而且拖不小。
const WINDOW_WIDTH: f64 = 1200.0;
const WINDOW_HEIGHT: f64 = 800.0;

/// 为指定会话开一个独立的 SFTP 窗口。
///
/// 标签带上毫秒时间戳，保证同一个会话可以反复开多个窗口
/// （Tauri 要求每个窗口的 label 唯一）。
#[tauri::command(rename = "open_sftp_window")]
pub async fn open_sftp_window(
	app: AppHandle,
	session_id: String,
	title: String,
) -> Result<(), String> {
	let stamp = SystemTime::now()
		.duration_since(UNIX_EPOCH)
		.map(|value| value.as_millis())
		.unwrap_or_default();
	let label = format!("sftp-{stamp}");
	WebviewWindowBuilder::new(
		&app,
		label,
		WebviewUrl::App(
			format!("index.html?sftp={session_id}").into(),
		),
	)
	.title(format!("SFTP · {title}"))
	// 不要系统标题栏：主窗口也是自绘的（tauri.conf.json 里 decorations: false），
	// 保持一致 —— 否则系统按钮与自绘按钮两套并存，外观也对不上。
	.decorations(false)
	.resizable(true)
	// 居中：默认位置由系统决定（多在左上角），生成的窗口理应出现在屏幕中央
	.center()
	.inner_size(WINDOW_WIDTH, WINDOW_HEIGHT)
	.min_inner_size(WINDOW_WIDTH, WINDOW_HEIGHT)
	.build()
	.map_err(|error| format!("打开 SFTP 窗口失败：{error}"))?;
	Ok(())
}
