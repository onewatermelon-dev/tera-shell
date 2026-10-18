//! terminal 模块单元测试：终端日志的 ANSI 剥离与分块中文解码。
//!
//! 由源文件以 `#[path]` 编回对应模块：单元测试要访问私有项，不能放进
//! cargo 自动发现的集成测试目录根部（tests/*.rs）。

use super::{decode_log_chunk, log_text, Log};

#[test]
fn strips_split_ansi_sequences() {
	let mut log = Log::default();
	assert_eq!(log_text("hello\u{1b}[31", &mut log), "");
	assert_eq!(log_text("m世界\u{1b}[0m\r\n", &mut log), "hello世界\n");
	assert_eq!(log_text("NF\u{1b}[16", &mut log), "");
	assert_eq!(log_text("C ntfsinfo\n", &mut log), "NF                 ntfsinfo\n");
	assert_eq!(log_text("root# cat app.rs\rroot# cat app.rs\n", &mut log), "root# cat app.rs\n");
	assert_eq!(log_text("root#\u{1b}[K\u{1b}[1Ccat app.rs \u{1b}[35;7H\u{1b}[Kcat app.rs\n", &mut log), "root# cat app.rs\n");
	assert_eq!(log_text("root# cd /abc/bin\u{1b}[7D\u{1b}[4P\n", &mut log), "root# cd /bin\n");
	assert_eq!(log_text("root# cd /abc\u{8} \u{8}\u{8} \u{8}\u{8} \u{8}\n", &mut log), "root# cd /\n");
	assert_eq!(log_text("root# vim app.rs\u{1b}[?1049h\u{1b}[1;1HVim screen\n", &mut log), "root# vim app.rs\n");
	assert_eq!(log_text("more Vim\u{1b}[?1049lWelcome back\r\nroot# ", &mut log), "");
	assert!(log.replaying);
	log.replaying = false;
	assert_eq!(log_text("ls\r\n", &mut log), "root# ls\n");
}

#[test]
fn decodes_split_chinese_character() {
	let mut tail = Vec::new();
	assert_eq!(decode_log_chunk(&[0xe5, 0x8f], &mut tail), "");
	assert_eq!(decode_log_chunk(&[0x91], &mut tail), "发");
}
