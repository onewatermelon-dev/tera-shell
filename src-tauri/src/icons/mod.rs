//! 系统原生文件图标。
//!
//! 列表里的图标要和资源管理器一致，只能问 Windows Shell 要：`SHGetFileInfoW`
//! 按「文件名 + 属性」取图标（`SHGFI_USEFILEATTRIBUTES`），再用 `DrawIconEx`
//! 画到 32 位 DIB 上取出 BGRA 像素，最后编码成带 alpha 的 PNG data URL。
//!
//! 走「按属性取图标」这条路径是有意为之：它**只依赖文件名和属性、不要求文件存在**，
//! 所以远程 SFTP 目录里的文件（本地根本没有）也能拿到正确的类型图标。
//! 前端只要把列表项的 `iconKey`（`dir` 或小写扩展名）映射到对应图片即可。

use std::{
	collections::HashMap,
	sync::{Mutex, OnceLock},
};

/// 进程内图标缓存：同一个键只在首次向 Shell 取一次，之后直接复用。
///
/// 每进一个目录都要取一次图标，没有缓存会反复调用 Shell API；
/// 键的取值空间很小（一个 `dir` 加若干扩展名），常驻内存完全可接受。
static CACHE: OnceLock<Mutex<HashMap<String, String>>> =
	OnceLock::new();

/// 批量取系统图标：对去重后的键各取一次，返回「键 → PNG data URL」。
///
/// 某些键取不到图标时就不出现在结果里，前端会退回内置的线性图标。
pub fn icons_for(keys: &[String]) -> HashMap<String, String> {
	let cache = CACHE.get_or_init(|| Mutex::new(HashMap::new()));
	let mut found = HashMap::new();
	{
		let cached = cache
			.lock()
			.unwrap_or_else(|error| error.into_inner());
		for key in keys {
			if let Some(data) = cached.get(key) {
				found.insert(key.clone(), data.clone());
			}
		}
	}
	for key in keys {
		if found.contains_key(key) {
			continue;
		}
		let is_dir = key == "dir";
		// SHGFI_USEFILEATTRIBUTES 只按名字与属性判断类型，
		// 所以这里给个"像那么回事"的文件名即可（扩展名决定图标）。
		let name = if is_dir {
			"folder".to_string()
		} else if key.is_empty() {
			"file".to_string()
		} else {
			format!("file.{key}")
		};
		if let Some(data) = platform::icon_data_url(&name, is_dir) {
			found.insert(key.clone(), data.clone());
			cache
				.lock()
				.unwrap_or_else(|error| error.into_inner())
				.insert(key.clone(), data);
		}
	}
	found
}

/// 取本地真实文件夹的专属图标，如"音乐""视频"这类在 Windows 里各有图标的目录。
///
/// 与 `icons_for` 的关键区别：**不**带 `SHGFI_USEFILEATTRIBUTES`——
/// 那个模式只按名字和属性猜类型、拿到的是统一的普通文件夹图标；
/// 这里让 Shell 真正去读该文件夹（desktop.ini / 已知文件夹类型），
/// 才能拿到它独有的那个图标。入参因此必须是本地真实存在的路径。
pub fn folder_icons(paths: &[String]) -> HashMap<String, String> {
	let cache = CACHE.get_or_init(|| Mutex::new(HashMap::new()));
	let mut found = HashMap::new();
	{
		let cached = cache
			.lock()
			.unwrap_or_else(|error| error.into_inner());
		for path in paths {
			if let Some(data) = cached.get(path) {
				found.insert(path.clone(), data.clone());
			}
		}
	}
	for path in paths {
		if found.contains_key(path) {
			continue;
		}
		if let Some(data) =
			platform::folder_icon_data_url(path)
		{
			found.insert(path.clone(), data.clone());
			cache
				.lock()
				.unwrap_or_else(|error| error.into_inner())
				.insert(path.clone(), data);
		}
	}
	found
}

/// 列表项的图标键：目录固定为 `dir`，文件取小写扩展名（无扩展名为空串）。
///
/// 同一目录里同类型文件共用一张图，因此按这个键去重即可大幅减少取图标次数。
pub fn icon_key(name: &str, is_dir: bool) -> String {
	if is_dir {
		return "dir".to_string();
	}
	match name.rsplit_once('.') {
		Some((stem, extension))
			if !stem.is_empty() && !extension.is_empty() =>
		{
			extension.to_lowercase()
		}
		_ => String::new(),
	}
}

#[cfg(target_os = "windows")]
mod platform {
	use base64::Engine;
	use image::{ImageBuffer, ImageFormat, RgbaImage};
	use std::{
		ffi::{OsStr, c_void},
		io::Cursor,
		os::windows::ffi::OsStrExt,
		ptr::null_mut,
	};
	use windows::{
		Win32::{
			Graphics::Gdi::{
				BI_RGB, BITMAPINFO, BITMAPINFOHEADER,
				CreateCompatibleDC, CreateDIBSection, DIB_RGB_COLORS,
				DeleteDC, DeleteObject, GetDC, HGDIOBJ, ReleaseDC,
				SelectObject,
			},
			Storage::FileSystem::{
				FILE_ATTRIBUTE_DIRECTORY, FILE_ATTRIBUTE_NORMAL,
				FILE_FLAGS_AND_ATTRIBUTES,
			},
			System::Com::CoTaskMemFree,
			UI::{
				Shell::{
					CSIDL_DRIVES, SHFILEINFOW,
					SHGFI_FLAGS, SHGFI_ICON, SHGFI_LARGEICON,
					SHGFI_PIDL, SHGFI_USEFILEATTRIBUTES,
					SHGetFileInfoW, SHGetSpecialFolderLocation,
				},
				WindowsAndMessaging::{
					DI_NORMAL, DestroyIcon, DrawIconEx, HICON,
				},
			},
		},
		core::PCWSTR,
	};

	/// 图标边长。取 32×32，缩到 16px 显示在高分屏上也不糊。
	const ICON_SIZE: i32 = 32;

	/// 取本地真实文件夹自己的图标（不去 `SHGFI_USEFILEATTRIBUTES`，
	/// 让 Shell 真正读取该文件夹，从而拿到它的专属图标）。
	pub fn folder_icon_data_url(
		path: &str,
	) -> Option<String> {
		let wide: Vec<u16> = OsStr::new(path)
			.encode_wide()
			.chain(std::iter::once(0))
			.collect();
		query_icon(
			PCWSTR(wide.as_ptr()),
			FILE_ATTRIBUTE_DIRECTORY,
			SHGFI_ICON | SHGFI_LARGEICON,
		)
	}

	/// 取单个文件的系统图标并渲染成 PNG data URL；失败返回 None，
	/// 前端会退回内置的线性图标，不会出现空白。
	pub fn icon_data_url(
		name: &str,
		is_dir: bool,
	) -> Option<String> {
		let wide: Vec<u16> = OsStr::new(name)
			.encode_wide()
			.chain(std::iter::once(0))
			.collect();
		let attributes = if is_dir {
			FILE_ATTRIBUTE_DIRECTORY
		} else {
			FILE_ATTRIBUTE_NORMAL
		};
		query_icon(
			PCWSTR(wide.as_ptr()),
			attributes,
			SHGFI_ICON
				| SHGFI_LARGEICON
				| SHGFI_USEFILEATTRIBUTES,
		)
	}

	/// 取"此电脑"的系统图标。
	///
	/// "此电脑"是 Shell 虚拟对象，**没有文件系统路径**，因此要：
	///   1. `SHGetSpecialFolderLocation(CSIDL_DRIVES)` 拿到它的 PIDL；
	///   2. `SHGetFileInfoW` 带 `SHGFI_PIDL`、把 PIDL 当路径传入取图标。
	///
	/// 不能按普通文件名取（`SHGFI_USEFILEATTRIBUTES` 模式只认文件名），
	/// `::{CLSID}` 这种解析名字符串同样不被识别。
	pub fn computer_icon_data_url() -> Option<String> {
		// 不需要 owner window，PIDL 取回后必须自己释放
		let pidl = unsafe {
			SHGetSpecialFolderLocation(
				None,
				CSIDL_DRIVES as i32,
			)
		}
		.ok()?;
		let encoded = query_icon(
			PCWSTR(pidl as *const u16),
			FILE_FLAGS_AND_ATTRIBUTES(0),
			SHGFI_PIDL | SHGFI_ICON | SHGFI_LARGEICON,
		);
		unsafe {
			CoTaskMemFree(Some(pidl.cast::<c_void>()));
		}
		encoded
	}

	/// `SHGetFileInfoW` 的公共封装：按给定标志取图标并渲染。
	///
	/// `path` 可以是文件路径字符串，也可以是 PIDL（配合 `SHGFI_PIDL`）；
	/// 后者用于"此电脑"这类没有文件系统路径的 Shell 对象。
	fn query_icon(
		path: PCWSTR,
		attributes: FILE_FLAGS_AND_ATTRIBUTES,
		flags: SHGFI_FLAGS,
	) -> Option<String> {
		let mut info = SHFILEINFOW::default();
		let result = unsafe {
			SHGetFileInfoW(
				path,
				attributes,
				Some(&mut info),
				std::mem::size_of::<SHFILEINFOW>() as u32,
				flags,
			)
		};
		if result == 0 || info.hIcon.is_invalid() {
			return None;
		}
		let encoded = unsafe { render_icon(info.hIcon) };
		unsafe {
			let _ = DestroyIcon(info.hIcon);
		}
		encoded
	}

	/// 把一个 HICON 画进 32 位 DIB，取出 BGRA 像素后封装成 BMP。
	unsafe fn render_icon(icon: HICON) -> Option<String> {
		let screen = unsafe { GetDC(None) };
		if screen.is_invalid() {
			return None;
		}
		let memory = unsafe { CreateCompatibleDC(Some(screen)) };
		if memory.is_invalid() {
			unsafe { ReleaseDC(None, screen) };
			return None;
		}

		let header = BITMAPINFO {
			bmiHeader: BITMAPINFOHEADER {
				biSize: std::mem::size_of::<BITMAPINFOHEADER>()
					as u32,
				biWidth: ICON_SIZE,
				// 负高度 = top-down，省掉逐行翻转
				biHeight: -ICON_SIZE,
				biPlanes: 1,
				biBitCount: 32,
				biCompression: BI_RGB.0 as u32,
				..Default::default()
			},
			..Default::default()
		};
		let mut bits: *mut c_void = null_mut();
		let Ok(dib) = (unsafe {
			CreateDIBSection(
				Some(memory),
				&header,
				DIB_RGB_COLORS,
				&mut bits,
				None,
				0,
			)
		}) else {
			unsafe {
				let _ = DeleteDC(memory);
				ReleaseDC(None, screen);
			}
			return None;
		};
		if bits.is_null() {
			unsafe {
				let _ = DeleteObject(HGDIOBJ(dib.0));
				let _ = DeleteDC(memory);
				ReleaseDC(None, screen);
			}
			return None;
		}

		// CreateDIBSection 分配的内存是**未初始化**的，必须先清零：
		// 图标没覆盖到的像素若不归零，会残留随机数据而显示成黑块/噪点边框。
		unsafe {
			std::ptr::write_bytes(
				bits,
				0,
				(ICON_SIZE * ICON_SIZE * 4) as usize,
			);
		}

		let previous =
			unsafe { SelectObject(memory, HGDIOBJ(dib.0)) };
		let drawn = unsafe {
			DrawIconEx(
				memory,
				0,
				0,
				icon,
				ICON_SIZE,
				ICON_SIZE,
				0,
				None,
				DI_NORMAL,
			)
		};
		unsafe {
			SelectObject(memory, previous);
		}

		let output = if drawn.is_ok() {
			let pixels = unsafe {
				std::slice::from_raw_parts(
					bits as *const u8,
					(ICON_SIZE * ICON_SIZE * 4) as usize,
				)
			};
			Some(png_data_url(
				pixels,
				ICON_SIZE as u32,
				ICON_SIZE as u32,
			)?)
		} else {
			None
		};

		unsafe {
			let _ = DeleteObject(HGDIOBJ(dib.0));
			let _ = DeleteDC(memory);
			ReleaseDC(None, screen);
		}
		output
	}

	/// 把 32 位 BGRA 像素（top-down）编码成 PNG data URL。
	///
	/// **必须输出带 alpha 的格式**：BMP 的 32bpp `BI_RGB` 不解释 alpha 字节，
	/// 浏览器会把它当不透明位图，图标周围的透明区域就会显示成黑色方块。
	/// PNG 保留 alpha，缩放到列表里显示时也不会有黑边。
	fn png_data_url(
		pixels: &[u8],
		width: u32,
		height: u32,
	) -> Option<String> {
		// DIB 里是 BGRA，PNG 要 RGBA
		let mut rgba = Vec::with_capacity(pixels.len());
		for pixel in pixels.chunks_exact(4) {
			rgba.extend_from_slice(&[
				pixel[2], pixel[1], pixel[0], pixel[3],
			]);
		}
		let image: RgbaImage =
			ImageBuffer::from_raw(width, height, rgba)?;
		let mut encoded = Vec::new();
		image
			.write_to(
				&mut Cursor::new(&mut encoded),
				ImageFormat::Png,
			)
			.ok()?;
		Some(format!(
			"data:image/png;base64,{}",
			base64::engine::general_purpose::STANDARD
				.encode(&encoded)
		))
	}
}

#[cfg(not(target_os = "windows"))]
mod platform {
	/// 非 Windows 平台没有 Shell 图标，恒为 None，由前端使用内置图标。
	pub fn icon_data_url(
		_name: &str,
		_is_dir: bool,
	) -> Option<String> {
		None
	}

	/// 非 Windows 平台没有 Shell 图标，恒为 None。
	pub fn computer_icon_data_url() -> Option<String> {
		None
	}

	/// 非 Windows 平台没有 Shell 图标，恒为 None。
	pub fn folder_icon_data_url(
		_path: &str,
	) -> Option<String> {
		None
	}
}

pub use platform::{
	computer_icon_data_url, folder_icon_data_url, icon_data_url,
};
