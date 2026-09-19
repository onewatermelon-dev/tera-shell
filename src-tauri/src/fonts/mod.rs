//! 本地字体枚举（设置页「终端字体」的下拉候选）。
//!
//! 走 GDI 的 `EnumFontFamiliesExW` —— WebView 侧的 `queryLocalFonts()` 需要
//! 额外的权限处理，桌面端直接问系统最省事。
//!
//! ⚠️ windows 0.61 的 `FONTENUMPROCW` 回调只给 `LOGFONTW`（face 名，32 个
//! UTF-16 单元），拿不到 `ENUMLOGFONTEXW` 的全名字段 —— 超长字体名会截断，
//! 实际使用中极少碰到。
//!
//! GDI 枚举的粒度是 **face** 而不是 family：同一个「Arial」会回调出
//! `Arial`、`Arial Bold`、`Arial Italic` 等多个名字。这里不做后缀裁剪，
//! 原样去重后返回 —— 用户想选某个变体（比如 Light）也是合理需求。

use std::collections::BTreeSet;
use tracing::debug;
use windows::Win32::Foundation::LPARAM;
use windows::Win32::Graphics::Gdi::{
	EnumFontFamiliesExW, GetDC, ReleaseDC, DEFAULT_CHARSET,
	HDC, LOGFONTW, TEXTMETRICW,
};

/// GDI 回调：把每个 face 名塞进集合。返回非 0 表示继续枚举。
unsafe extern "system" fn enum_proc(
	logfont: *const LOGFONTW,
	_textmetric: *const TEXTMETRICW,
	_font_type: u32,
	lparam: LPARAM,
) -> i32 {
	let families = unsafe {
		&mut *(lparam.0 as *mut BTreeSet<String>)
	};
	let wide = unsafe { &(*logfont).lfFaceName };
	let end = wide
		.iter()
		.position(|&unit| unit == 0)
		.unwrap_or(wide.len());
	if end > 0 {
		families.insert(String::from_utf16_lossy(
			&wide[..end],
		));
	}
	1
}

/// 枚举本机全部字体名（按字母序，已去重）。
#[tauri::command]
pub fn list_fonts() -> Vec<String> {
	unsafe {
		let hdc: HDC = GetDC(None);
		let mut families = BTreeSet::new();
		let mut pattern = LOGFONTW::default();
		// DEFAULT_CHARSET：列出所有字符集的字体，不局限于某个语言
		pattern.lfCharSet = DEFAULT_CHARSET;
		let _ = EnumFontFamiliesExW(
			hdc,
			&pattern,
			Some(enum_proc),
			LPARAM(
				&mut families as *mut _ as isize,
			),
			0,
		);
		let _ = ReleaseDC(None, hdc);
		debug!(count = families.len(), "枚举本机字体完成");
		families.into_iter().collect()
	}
}
