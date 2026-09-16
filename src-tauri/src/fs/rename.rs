//! 本地文件 / 目录重命名。

use std::fs::rename;

/// 重命名本地文件或目录。
///
/// 目标已存在时交给系统给出错误（`std::fs::rename` 在 Windows 上不会覆盖），
/// 这里不做额外处理，直接把原因透传给前端。
#[tauri::command(rename = "fs_rename_path")]
pub fn rename_local(
	from: String,
	to: String,
) -> Result<(), String> {
	rename(&from, &to)
		.map_err(|error| format!("重命名失败：{error}"))
}
