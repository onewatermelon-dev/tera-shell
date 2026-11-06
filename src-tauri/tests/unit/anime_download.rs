//! 下载模块的纯函数行为锁定：URL 拼接与 m3u8 清单解析。
//! 经 anime.rs 末尾的 `#[path] mod anime_download_tests` 编回（访问私有项）。

use super::*;

#[test]
fn join_url_四种形态() {
	// 绝对 URL 原样
	assert_eq!(
		join_url("https://cdn.example.com/a/b.m3u8", "https://other.com/x.ts"),
		"https://other.com/x.ts"
	);
	// // 开头：沿用 base 的 scheme
	assert_eq!(
		join_url("https://cdn.example.com/a/b.m3u8", "//cdn.example.com/x.ts"),
		"https://cdn.example.com/x.ts"
	);
	// / 开头：拼到源站根
	assert_eq!(
		join_url("https://cdn.example.com/a/b.m3u8", "/live/x.ts"),
		"https://cdn.example.com/live/x.ts"
	);
	// 裸相对：去掉 base 最后一段
	assert_eq!(
		join_url("https://cdn.example.com/a/b.m3u8", "x.ts"),
		"https://cdn.example.com/a/x.ts"
	);
}

#[test]
fn 媒体清单按序返回全部片段() {
	let base = "https://cdn.example.com/a/list.m3u8";
	let text = "#EXTM3U\n#EXT-X-TARGETDURATION:10\n#EXTINF:10,\nseg0.ts\n#EXTINF:10,\nseg1.ts\n";
	assert_eq!(
		parse_hls_segments(base, text),
		vec![
			"https://cdn.example.com/a/seg0.ts".to_string(),
			"https://cdn.example.com/a/seg1.ts".to_string()
		]
	);
}

#[test]
fn 主清单只取第一档子清单() {
	let base = "https://cdn.example.com/master.m3u8";
	let text = concat!(
		"#EXTM3U\n",
		"#EXT-X-STREAM-INF:BANDWIDTH=1280000\n",
		"low/index.m3u8\n",
		"#EXT-X-STREAM-INF:BANDWIDTH=4128000\n",
		"high/index.m3u8\n"
	);
	assert_eq!(
		parse_hls_segments(base, text),
		vec!["https://cdn.example.com/low/index.m3u8".to_string()]
	);
}

#[test]
fn 文件名消毒替换非法字符() {
	assert_eq!(sanitize_filename("凡人修仙传/第1集:a*b"), "凡人修仙传_第1集_a_b");
	assert_eq!(sanitize_filename("   "), "anime-download");
}

#[test]
fn 加密清单识别走_re() {
	// AES 密钥 / 初始化段 / 字节范围都要 RE
	assert!(needs_re_engine("#EXT-X-KEY:METHOD=AES-128,URI=\"k\""));
	assert!(needs_re_engine("#EXT-X-MAP:URI=\"init.mp4\""));
	assert!(needs_re_engine("#EXTINF:10,\nseg.ts\n#EXT-X-BYTERANGE:1000@0"));
	// 普通清单不路由
	assert!(!needs_re_engine("#EXTM3U\n#EXTINF:10,\nseg0.ts\n"));
}

#[test]
fn re_输出行抽取百分比与信息行() {
	let mut pct = 0u64;
	let mut info = String::new();
	// RE 的进度行（zh-CN UI）
	scan_re_line("  00:00:12 34.5% seg-0001.ts", &mut pct, &mut info);
	assert_eq!(pct, 34);
	// 百分比只增不减
	scan_re_line("  00:00:20 12.0%", &mut pct, &mut info);
	assert_eq!(pct, 34);
	scan_re_line("  00:00:30 100%", &mut pct, &mut info);
	assert_eq!(pct, 100);
	// 非进度的较长行记作信息行
	scan_re_line("ERROR: 无法访问密钥地址 https://k.example.com/key", &mut pct, &mut info);
	assert!(info.contains("ERROR"));
	// 空行不覆盖信息行
	scan_re_line("", &mut pct, &mut info);
	assert!(info.contains("ERROR"));
}
