//! 应用数据的文件存储。
//!
//! 数据（会话、设置、快捷宏）以 JSON 文件形式存放在**数据根目录**下：
//!
//! ```text
//! <根目录>/.tera-shell/
//!   ├── sessions.json
//!   ├── groups.json
//!   ├── settings.json
//!   ├── macros.json
//!   ├── models.json
//!   ├── ai_history.json
//!   ├── command_history.json
//!   └── ai_prefs.json
//!   └── sftp_bookmarks.json
//! ```
//!
//! 根目录本身记在 `<用户主目录>/.tera-shell/location.json` —— 配置不能和
//! 数据放在一起（否则"数据在哪"这件事就无处可查），所以固定存主目录。
//!
//! 前端在启动时一次性读走全部数据放进内存，之后的读写都走内存 + 异步回写：
//! localStorage 那种同步语义得以保留，组件侧无需改动。

use std::path::{Path, PathBuf};
use tauri::{AppHandle, Manager};
use tauri_plugin_dialog::DialogExt;
use tracing::{debug, error, info};

/// 应用自有的子目录名，数据与配置都放在它下面。
const SUBDIR: &str = ".tera-shell";

/// 记录数据根目录的配置文件名（固定存在主目录下）。
const LOCATION_FILE: &str = "location.json";

/// 允许被读写的逻辑数据名。限定白名单，避免前端传任意文件名。
const ALLOWED: [&str; 9] = [
	"sessions",
	"groups",
	"settings",
	"macros",
	"models",
	"ai_history",
	"command_history",
	"ai_prefs",
	"sftp_bookmarks",
];

fn ensure_name(name: &str) -> Result<(), String> {
	if ALLOWED.contains(&name) {
		Ok(())
	} else {
		Err(format!("不支持的数据名：{name}"))
	}
}

/// 用户主目录；取不到时退回当前工作目录，保证总有可写位置。
fn home_dir(app: &AppHandle) -> PathBuf {
	app.path()
		.home_dir()
		.unwrap_or_else(|_| PathBuf::from("."))
}

/// 应用自有的家目录据点：`<主目录>/.tera-shell`。
///
/// location.json 固定在这里（数据目录可以搬走，「数据在哪」的指针不能跟着
/// 搬）；日志与 SFTP 编辑临时文件也锚在这里 —— 它们是本机运行产物，
/// 刻意不跟着可迁移的数据目录走。
pub(crate) fn home_anchor(app: &AppHandle) -> PathBuf {
	home_dir(app).join(SUBDIR)
}

/// 配置文件的完整路径：`<主目录>/.tera-shell/location.json`。
fn location_path(app: &AppHandle) -> PathBuf {
	home_anchor(app).join(LOCATION_FILE)
}

/// 读配置里的数据根目录；没有配置或解析失败时返回 `None`（表示用主目录）。
fn configured_root(app: &AppHandle) -> Option<String> {
	let text = std::fs::read_to_string(location_path(app)).ok()?;
	let value: serde_json::Value = serde_json::from_str(&text).ok()?;
	let dir = value.get("dataDir")?.as_str()?.trim().to_string();
	if dir.is_empty() {
		None
	} else {
		Some(dir)
	}
}

/// 数据实际所在目录（已带 `.tera-shell` 后缀）。
fn data_dir(app: &AppHandle) -> PathBuf {
	let base = configured_root(app)
		.map(PathBuf::from)
		.unwrap_or_else(|| home_dir(app));
	base.join(SUBDIR)
}

/// 某个逻辑数据名对应的文件路径。
fn data_file(app: &AppHandle, name: &str) -> PathBuf {
	data_dir(app).join(format!("{name}.json"))
}

/// 读取全部数据，返回 `{ 逻辑名: 文件内容 }`。
///
/// 缺失的文件直接跳过 —— 首次启动时一个文件都没有，是正常情况。
#[tauri::command]
pub async fn load_all(
	app: AppHandle,
) -> Result<std::collections::HashMap<String, String>, String> {
	tauri::async_runtime::spawn_blocking(move || {
		let mut out = std::collections::HashMap::new();
		for name in ALLOWED {
			let path = data_file(&app, name);
			if let Ok(text) = std::fs::read_to_string(&path) {
				out.insert(name.to_string(), text);
			} else {
				// 首次启动时文件不存在属正常路径，debug 级即可
				debug!(name, path = %path.display(), "数据文件不存在，跳过");
			}
		}
		debug!(
			count = out.len(),
			dir = %data_dir(&app).display(),
			"启动读取应用数据完成"
		);
		out
	})
	.await
	.map_err(|error| format!("读取数据失败：{error}"))
}

/// 写入单个数据文件。
#[tauri::command]
pub async fn save_one(
	app: AppHandle,
	name: String,
	payload: String,
) -> Result<(), String> {
	ensure_name(&name)?;
	tauri::async_runtime::spawn_blocking(move || {
		let path = data_file(&app, &name);
		if let Some(parent) = path.parent() {
			std::fs::create_dir_all(parent).map_err(
				|error| {
					error!(
						name = %name,
						dir = %parent.display(),
						"创建数据目录失败：{error}"
					);
					format!("创建目录失败：{error}")
				},
			)?;
		}
		std::fs::write(&path, &payload).map_err(|error| {
			error!(
				name = %name,
				path = %path.display(),
				"写入应用数据失败：{error}"
			);
			format!("写入失败：{error}")
		})?;
		info!(
			name = %name,
			bytes = payload.len(),
			path = %path.display(),
			"写入应用数据完成"
		);
		Ok(())
	})
	.await
	.map_err(|error| format!("保存任务失败：{error}"))?
}

/// 当前数据实际所在目录（`.tera-shell` 的上一级）。
///
/// 未配置时也返回实际位置 —— 界面上需要展示「数据现在在哪」，
/// 显示成空白会让人以为没有存储。
#[tauri::command]
pub fn current_root(app: AppHandle) -> String {
	data_dir(&app)
		.parent()
		.map(|path| {
			path.to_string_lossy().into_owned()
		})
		.unwrap_or_default()
}

/// 弹出系统“选择文件夹”对话框，返回选中的目录；取消则为 `None`。
///
/// ⚠️ `blocking_pick_folder` 会阻塞线程直到用户操作完，跑在主线程会卡死 UI。
#[tauri::command]
pub async fn pick_data_dir(
	app: AppHandle,
) -> Result<Option<String>, String> {
	let picked = tauri::async_runtime::spawn_blocking(
		move || {
			app.dialog().file().blocking_pick_folder()
		},
	)
	.await
	.map_err(|error| {
		format!("打开文件夹选择框失败：{error}")
	})?;
	Ok(picked.map(|path| {
		info!(picked = %path.to_string(), "用户选择了新的数据目录");
		path.to_string()
	}))
}

/// 切换数据根目录：先把现有数据复制过去，成功后再写配置。
///
/// 顺序很重要 —— 先写配置的话，复制失败就会留下一个指向空目录的配置，
/// 用户下次启动会以为数据丢了。
#[tauri::command]
pub async fn set_data_dir(
	app: AppHandle,
	dir: String,
) -> Result<String, String> {
	// 空目录 = 回到默认位置（主目录）
	let base = {
		let trimmed = dir.trim();
		if trimmed.is_empty() {
			home_dir(&app)
		} else {
			PathBuf::from(trimmed)
		}
	};
	tauri::async_runtime::spawn_blocking(move || {
		let destination = base.join(SUBDIR);
		info!(
			target = %destination.display(),
			"开始迁移应用数据目录"
		);
		std::fs::create_dir_all(&destination).map_err(
			|error| format!("创建目标目录失败：{error}"),
		)?;

		// 把现有数据逐个复制过去（源目录可能是旧位置）
		let source = data_dir(&app);
		let mut copied = 0_u32;
		for name in ALLOWED {
			let from = source.join(format!("{name}.json"));
			if from.is_file() {
				let to = destination.join(format!("{name}.json"));
				std::fs::copy(&from, &to).map_err(
					|error| {
						error!(
							name,
							from = %from.display(),
							"迁移复制数据文件失败：{error}"
						);
						format!("复制 {name} 失败：{error}")
					},
				)?;
				copied += 1;
			}
		}
		info!(copied, "数据文件复制完成");

		// 数据就位后才记配置
		let location = location_path(&app);
		if let Some(parent) = location.parent() {
			std::fs::create_dir_all(parent).map_err(
				|error| format!("创建配置目录失败：{error}"),
			)?;
		}
		// 记配置用的是「根目录」（不含 .tera-shell 后缀）
		let root = destination
			.parent()
			.map(|path| {
				path.to_string_lossy().into_owned()
			})
			.unwrap_or_default();
		let json = serde_json::json!({ "dataDir": root });
		std::fs::write(
			&location,
			serde_json::to_string_pretty(&json)
				.map_err(|error| format!("序列化配置失败：{error}"))?,
		)
		.map_err(|error| format!("写入配置失败：{error}"))?;

		info!(root = %root, "数据目录迁移完成，配置已更新");
		Ok(destination.to_string_lossy().into_owned())
	})
	.await
	.map_err(|error| {
		error!("数据目录迁移任务失败：{error}");
		format!("迁移任务失败：{error}")
	})?
}

/// 便于日志/诊断：数据文件所在目录是否存在。
#[allow(dead_code)]
pub fn exists(app: &AppHandle) -> bool {
	Path::new(&data_dir(app)).is_dir()
}
