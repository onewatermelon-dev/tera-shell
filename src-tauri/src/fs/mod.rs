pub mod rename;

use crate::icons;
use serde::Serialize;
use std::{
	collections::HashMap,
	path::{Path, PathBuf},
};

/// 目录条目。字段与远程 `sftp_list` 保持同构，前端可共用同一套渲染；
/// Windows 本地文件没有 Unix 权限位与 uid/gid，对应字段为 `None`。
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileEntry {
	name: String,
	path: String,
	is_dir: bool,
	size: u64,
	/// 修改时间（Unix 秒）
	modified: Option<u64>,
	/// Unix 权限位；Windows 本地文件恒为 None
	perm: Option<u32>,
	/// 所有者名称；Windows 本地文件恒为 None
	owner: Option<String>,
	/// 所属组名称；Windows 本地文件恒为 None
	group: Option<String>,
	/// 图标键：`dir` 或小写扩展名，前端据此在 `icons` 里查系统图标
	icon_key: String,
}

/// 目录浏览结果：规范化后的当前路径、上级目录、该目录下的条目，
/// 以及本次用到的系统图标（键 → BMP data URL，同类型只带一张）。
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DirListing {
	path: String,
	parent: Option<String>,
	entries: Vec<FileEntry>,
	icons: HashMap<String, String>,
}

/// 读取本地目录内容，供 SFTP 窗口左栏展示。
///
/// 未传路径或传空串时回退到用户主目录。读取失败（路径不存在、无权限等）
/// 返回错误文本交给前端提示，这里不 panic。
#[tauri::command(rename = "fs_list_dir")]
pub fn list_dir(path: Option<String>) -> Result<DirListing, String> {
	let target = match path
		.as_deref()
		.map(str::trim)
		.filter(|value| !value.is_empty())
	{
		Some(value) => PathBuf::from(value),
		None => home_dir(),
	};
	let canonical = target
		.canonicalize()
		.map_err(|error| error.to_string())?;
	let mut entries = Vec::new();
	for entry in std::fs::read_dir(&canonical)
		.map_err(|error| error.to_string())?
	{
		let entry = entry.map_err(|error| error.to_string())?;
		// 元数据读不到的条目（如失效的符号链接）直接跳过，不影响整列表
		let metadata = match entry.metadata() {
			Ok(metadata) => metadata,
			Err(_) => continue,
		};
		let name =
			entry.file_name().to_string_lossy().into_owned();
		let is_dir = metadata.is_dir();
		entries.push(FileEntry {
			icon_key: icons::icon_key(&name, is_dir),
			name,
			path: display_path(&entry.path()),
			is_dir,
			size: metadata.len(),
			modified: metadata
				.modified()
				.ok()
				.and_then(|time| {
					time.duration_since(std::time::UNIX_EPOCH)
						.ok()
				})
				.map(|duration| duration.as_secs()),
			perm: None,
			owner: None,
			group: None,
		});
	}
	// 目录排在前面，同类型按名称排序（忽略大小写，符合文件管理器习惯）
	entries.sort_by(|a, b| {
		b.is_dir
			.cmp(&a.is_dir)
			.then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase()))
	});
	let parent = canonical
		.parent()
		// 根目录的 parent 是空路径，没有上级可回
		.filter(|parent| !parent.as_os_str().is_empty())
		.map(display_path);
	// 图标按 key 去重后一次取好，同类文件共用一张图。
	// 固定带上 dir：列表顶部的 ".." 也要显示文件夹图标，
	// 而某些目录里可能一个子目录都没有。
	let mut keys = vec!["dir".to_string()];
	for entry in &entries {
		keys.push(entry.icon_key.clone());
	}
	Ok(DirListing {
		path: display_path(&canonical),
		parent,
		entries,
		icons: icons::icons_for(&keys),
	})
}

/// 用系统关联程序打开本地文件（如双击资源管理器里的文件）。
#[tauri::command(rename = "fs_open_path")]
pub fn open_path(
	app: tauri::AppHandle,
	path: String,
) -> Result<(), String> {
	use tauri_plugin_opener::OpenerExt;
	app.opener()
		.open_path(&path, None::<&str>)
		.map_err(|error| {
			format!("打开 {path} 失败：{error}")
		})
}

/// 用记事本打开本地文件。
///
/// 直接起进程，不走 Tauri 的 shell 插件，省掉一条命令白名单配置。
#[tauri::command(rename = "fs_open_notepad")]
pub fn open_notepad(path: String) -> Result<(), String> {
	std::process::Command::new("notepad")
		.arg(&path)
		.spawn()
		.map(|_| ())
		.map_err(|error| {
			format!("启动记事本失败：{error}")
		})
}

/// 在当前目录下新建一个文件夹。
#[tauri::command(rename = "fs_make_dir")]
pub fn make_dir(path: String) -> Result<(), String> {
	std::fs::create_dir(&path).map_err(|error| {
		format!("新建文件夹失败：{error}")
	})
}

/// 新建空文件；已存在时报错，不覆盖。
#[tauri::command(rename = "fs_create_file")]
pub fn create_file(path: String) -> Result<(), String> {
	std::fs::OpenOptions::new()
		.create_new(true)
		.write(true)
		.open(&path)
		.map(|_| ())
		.map_err(|error| {
			format!("新建文件 {path} 失败：{error}")
		})
}

/// 删除文件或目录（目录按递归删除）。
#[tauri::command(rename = "fs_remove_path")]
pub fn remove_path(path: String) -> Result<(), String> {
	let metadata = std::fs::metadata(&path).map_err(|error| {
		format!("读取 {path} 失败：{error}")
	})?;
	if metadata.is_dir() {
		std::fs::remove_dir_all(&path)
	} else {
		std::fs::remove_file(&path)
	}
	.map_err(|error| format!("删除 {path} 失败：{error}"))
}

/// 把文件/目录复制到目标目录下（保留原名）。
#[tauri::command(rename = "fs_copy_path")]
pub fn copy_path(
	from: String,
	to: String,
) -> Result<(), String> {
	let name = Path::new(&from)
		.file_name()
		.ok_or_else(|| "源路径无效".to_string())?;
	copy_recursive(
		Path::new(&from),
		&Path::new(&to).join(name),
	)
}

/// 递归复制：文件直接 copy，目录先建再逐个拷贝子项。
fn copy_recursive(
	from: &Path,
	to: &Path,
) -> Result<(), String> {
	let metadata = std::fs::metadata(from).map_err(|error| {
		format!("读取 {} 失败：{error}", from.display())
	})?;
	if !metadata.is_dir() {
		return std::fs::copy(from, to)
			.map(|_| ())
			.map_err(|error| {
				format!("复制 {} 失败：{error}", from.display())
			});
	}
	std::fs::create_dir_all(to).map_err(|error| {
		format!("创建 {} 失败：{error}", to.display())
	})?;
	for entry in std::fs::read_dir(from).map_err(|error| {
		format!("读取 {} 失败：{error}", from.display())
	})? {
		let entry = entry
			.map_err(|error| format!("读取目录项失败：{error}"))?;
		copy_recursive(
			&entry.path(),
			&to.join(entry.file_name()),
		)?;
	}
	Ok(())
}

/// 用户主目录；取不到时回退到当前工作目录。
fn home_dir() -> PathBuf {
	std::env::var_os(if cfg!(windows) { "USERPROFILE" } else { "HOME" })
		.map(PathBuf::from)
		.unwrap_or_else(|| PathBuf::from("."))
}

/// 去掉 Windows `canonicalize` 产生的 `\\?\` 前缀，让路径可直接展示。
fn display_path(path: &Path) -> String {
	let text = path.to_string_lossy().into_owned();
	text.strip_prefix(r"\\?\")
		.map(str::to_string)
		.unwrap_or(text)
}

/// 路径选择器里的一个入口节点。
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PlaceNode {
	name: String,
	path: String,
	/// `dir` 普通目录；`computer` 表示"此电脑"，展开后列出盘符
	kind: String,
	/// 图标键，用于在 `icons` 里查系统图标；无图标为空串
	icon_key: String,
}

/// 路径选择器的入口列表 + 对应的系统图标。
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PlaceListing {
	places: Vec<PlaceNode>,
	icons: HashMap<String, String>,
}

/// 列出路径选择器的根入口：常用用户文件夹 + 此电脑。
///
/// 用户文件夹从 `USERPROFILE` 下的固定子目录推导（桌面/文档/下载等），
/// 不存在的自动跳过。不用 `SHGetKnownFolderPath` 是为了少动一组
/// Windows API 依赖；固定子目录名覆盖绝大多数机器。
#[tauri::command(rename = "fs_places")]
pub fn places() -> PlaceListing {
	let mut nodes = Vec::new();
	if let Some(home) = std::env::var_os("USERPROFILE")
		.map(PathBuf::from)
		.filter(|home| home.is_dir())
	{
		for (name, folder) in [
			("桌面", "Desktop"),
			("下载", "Downloads"),
			("文档", "Documents"),
			("图片", "Pictures"),
			("音乐", "Music"),
			("视频", "Videos"),
		] {
			let path = home.join(folder);
			if path.is_dir() {
				let path = display_path(&path);
				nodes.push(PlaceNode {
					name: name.to_string(),
					// 用真实路径当图标键，才能取到这个文件夹自己的图标
					icon_key: path.clone(),
					path,
					// 固定入口：点了就选中，不提供逐级展开
					kind: "place".into(),
				});
			}
		}
	}
	nodes.push(PlaceNode {
		name: "此电脑".into(),
		// 此电脑本身没有路径，展开时改走 fs_drives
		path: String::new(),
		kind: "computer".into(),
		icon_key: "computer".into(),
	});
	// 常用文件夹按真实路径取各自的系统图标（桌面/音乐/视频各不相同）
	let paths: Vec<String> = nodes
		.iter()
		.filter(|node| node.kind == "place")
		.map(|node| node.path.clone())
		.collect();
	let mut icons = icons::folder_icons(&paths);
	// "此电脑"用系统自带的"此电脑"图标（Shell 虚拟对象，走 PIDL 取）
	if let Some(data) = icons::computer_icon_data_url() {
		icons.insert("computer".to_string(), data);
	}
	PlaceListing {
		places: nodes,
		icons,
	}
}

/// 枚举本机盘符（"此电脑"展开时使用），返回 C:\、D:\ … 这样的根目录。
///
/// 盘符图标按根路径向 Shell 取（本地磁盘是专属图标，不是文件夹图标），
/// 因此以盘符路径本身作为图标键。
#[tauri::command(rename = "fs_drives")]
pub fn drives() -> PlaceListing {
	let mut nodes = Vec::new();
	let mut icons = HashMap::new();
	for letter in b'A'..=b'Z' {
		let root = format!("{}:\\", letter as char);
		if Path::new(&root).is_dir() {
			if let Some(data) = icons::icon_data_url(&root, true)
			{
				icons.insert(root.clone(), data);
			}
			nodes.push(PlaceNode {
				name: root.clone(),
				path: root.clone(),
				kind: "dir".into(),
				icon_key: root,
			});
		}
	}
	PlaceListing {
		places: nodes,
		icons,
	}
}
