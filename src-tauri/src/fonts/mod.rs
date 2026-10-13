//! 本地字体枚举（设置页「终端字体」的下拉候选）。
//!
//! 走 GDI 的 `EnumFontFamiliesExW` —— WebView 侧的 `queryLocalFonts()` 需要
//! 额外的权限处理，桌面端直接问系统最省事。
//!
//! 只返回**等宽** face：终端字体选择器用不到比例字体，全量枚举在中文
//! 系统上有上千条，自绘下拉会被拖垮（打开卡顿、滚动掉帧）。
//!
//! ⚠️ windows 0.61 的 `FONTENUMPROCW` 回调只给 `LOGFONTW`（face 名，32 个
//! UTF-16 单元），拿不到 `ENUMLOGFONTEXW` 的全名字段 —— 超长字体名会截断，
//! 实际使用中极少碰到。
//!
//! GDI 枚举的粒度是 **face** 而不是 family：同一个「Cascadia Code」会回调出
//! `Cascadia Code`、`Cascadia Code Bold` 等多个名字。等宽过滤后数量已经
//! 不多，不做后缀裁剪，原样去重后返回 —— 用户想选某个变体也是合理需求。

use std::collections::BTreeSet;
use tracing::debug;
use windows::Win32::Foundation::LPARAM;
use windows::Win32::Graphics::Gdi::{
	EnumFontFamiliesExW, GetDC, ReleaseDC, DEFAULT_CHARSET, HDC,
	LOGFONTW, TEXTMETRICW, TMPF_FIXED_PITCH,
};

/// GDI 回调：只收等宽 face。返回非 0 表示继续枚举。
///
/// `TMPF_FIXED_PITCH` 的语义是反的：**置位表示变宽**，清零才是等宽。
/// 部分中日韩等宽字体会被 GDI 误标成变宽（拉丁部分比例设计），
/// 按名字关键词兜底放行（NSimSun、MS Gothic 这类常用终端字体）。
unsafe extern "system" fn enum_proc(
	logfont: *const LOGFONTW,
	textmetric: *const TEXTMETRICW,
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
		let name = String::from_utf16_lossy(
			&wide[..end],
		);
		let metrics = unsafe { &*textmetric };
		let fixed_pitch = (metrics.tmPitchAndFamily
			& TMPF_FIXED_PITCH)
			.0
			== 0;
		// 名字兜底：GDI 对若干等宽 CJK 字体的 pitch 标记不可靠
		let lower = name.to_lowercase();
		let name_hinted = lower.contains("mono")
			|| lower.contains("consol")
			|| lower.contains("gothic")
			|| lower.contains("simsun");
		if fixed_pitch || name_hinted {
			families.insert(name);
		}
	}
	1
}

/// 枚举本机等宽字体名（按字母序，已去重）。
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
		debug!(count = families.len(), "枚举本机等宽字体完成");
		families.into_iter().collect()
	}
}

// 单元测试集中在 src-tauri/tests/unit/：#[path] 把模块编回本处，私有项仍可
// 访问；tests/ 下的直接子文件才是 cargo 的集成测试目标，子目录不自动发现。
#[cfg(test)]
#[path = "../../tests/unit/fonts.rs"]
mod tests;
