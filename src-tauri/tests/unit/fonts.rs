//! fonts 模块单元测试：等宽字体过滤（list_fonts 跑系统枚举回调）。
//!
//! 由源文件以 `#[path]` 编回对应模块：单元测试要访问私有项，不能放进
//! cargo 自动发现的集成测试目录根部（tests/*.rs）。

use super::*;

/// 过滤逻辑跑在系统枚举回调里，直接调真机验证：等宽字体必须留下
/// （Consolas 人人都有），比例字体必须滤掉（Arial 人人都有）。
#[test]
fn list_fonts_keeps_only_fixed_pitch() {
	let fonts = list_fonts();
	assert!(!fonts.is_empty(), "一个字体都没枚举到");
	assert!(
		fonts.iter().any(|f| f.contains("Consolas")),
		"等宽字体 Consolas 被误滤掉"
	);
	assert!(
		!fonts.iter().any(|f| f == "Arial"),
		"比例字体 Arial 没被滤掉"
	);
}
