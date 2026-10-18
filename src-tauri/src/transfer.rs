//! 会话导入 / 导出。
//!
//! 导出走系统「另存为」框把 JSON 写到磁盘，导入走「打开」框读回来。
//! 框本身由 `tauri-plugin-dialog` 提供（已在 lib.rs 注册），这里只包一层
//! 异步调用与文件读写 —— 对前端而言就是两个普通命令。
//!
//! ⚠️ 本模块**只负责搬运文本**，不理解里面的结构。格式的生成与解析都在
//! 前端 `sessions/lib/sessionTransfer.ts`，那边才能复用会话/分组的类型
//! 与 id 生成逻辑。

use tauri::AppHandle;
use tauri_plugin_dialog::DialogExt;
use tracing::{error, info};

/// 导出文件名建议值（不含路径）。
///
/// 刻意不带日期：那需要引入 `time` 宏 crate 只为拼一个文件名，不划算。
/// 系统保存框本来就会把默认名显示出来，真要区分多次导出用户可以自己改。
const DEFAULT_FILE_NAME: &str = "tera-shell-sessions.json";

/// 把给定文本写到用户选定的位置。
///
/// 返回实际写成的路径；用户取消选择则返回 `Ok(None)` —— 这不是错误，
/// 前端据此静默收手即可，不必弹提示。
#[tauri::command]
pub async fn export_to_file(
	app: AppHandle,
	content: String,
) -> Result<Option<String>, String> {
	let picked = tauri::async_runtime::spawn_blocking(move || {
		app.dialog()
			.file()
			.set_file_name(DEFAULT_FILE_NAME)
			.add_filter("Tera Shell 会话", &["json"])
			.blocking_save_file()
	})
	.await
	.map_err(|error| format!("打开保存对话框失败：{error}"))?;

	let Some(path) = picked else {
		info!("用户取消了会话导出");
		return Ok(None);
	};

	let path = path.to_string();
	// 用 `&content` 而不是 `content` —— 下面记日志还要用它的长度，
	// 按值传入会在写盘时把它移走，后续使用就编译不过
	if let Err(error) = std::fs::write(&path, &content) {
		error!(path = %path, "写入会话导出文件失败：{error}");
		return Err(format!("写入 {path} 失败：{error}"));
	}
	// 只记路径与字节数，不记内容：导出内容含主机与账号
	info!(path = %path, bytes = content.len(), "会话已导出到文件");
	Ok(Some(path))
}

/// 从用户选定的文件读回文本内容。
///
/// 返回 `Ok(None)` 表示用户取消。读文件失败会带路径报错，方便用户确认
/// 是不是选错了文件类型。
#[tauri::command]
pub async fn import_from_file(
	app: AppHandle,
) -> Result<Option<String>, String> {
	let picked = tauri::async_runtime::spawn_blocking(move || {
		app.dialog()
			.file()
			.add_filter("Tera Shell 会话", &["json"])
			.blocking_pick_file()
	})
	.await
	.map_err(|error| format!("打开文件选择框失败：{error}"))?;

	let Some(path) = picked else {
		info!("用户取消了会话导入");
		return Ok(None);
	};

	let path = path.to_string();
	match std::fs::read_to_string(&path) {
		Ok(content) => {
			info!(path = %path, bytes = content.len(), "会话文件已读取");
			Ok(Some(content))
		}
		Err(error) => {
			error!(path = %path, "读取会话文件失败：{error}");
			Err(format!("读取 {path} 失败：{error}"))
		}
	}
}
