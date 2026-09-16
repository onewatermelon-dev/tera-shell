use tera_shell_lib::terminal::{
	normalize_command_line, resolve_command_line, strip_ansi, tail_bytes,
};

#[test]
fn strips_ansi_sequences() {
	assert_eq!(strip_ansi("\x1b[O           ls"), "           ls");
	assert_eq!(strip_ansi("git\x1b[A status"), "git status");
	assert_eq!(strip_ansi("echo\x1b]0;title\x07!"), "echo!");
	assert_eq!(strip_ansi("ls -la"), "ls -la");
}

#[test]
fn normalizes_completion_and_backspace() {
	// Tab 补全：制表符归一化为单个空格
	assert_eq!(
		normalize_command_line("cd cat /lo\tsy\trun\t.l\t| gr\tep SMU"),
		"cd cat /lo sy run .l | gr ep SMU"
	);
	// 退格：回删前一字符（这里删掉错打的 a 再补打 o），删除痕迹不计入命令
	assert_eq!(normalize_command_line("echo hella\x7fo"), "echo hello");
	// 正常空格原样保留
	assert_eq!(normalize_command_line("ls -la /tmp"), "ls -la /tmp")
}

#[test]
fn prefers_frontend_command() {
	//前端抓到的完整命令行（含 Tab 补全展开）优先于输入流重建
	let raw = "cat /lo\tsy\trun\t.l";
	let commands=vec![
		"cat /log/sys_log/run_log.log | grep SMU=",
		"cd /opt/app && ls"
	];
	for command in commands {
		assert_eq!(
			resolve_command_line(Some(command),raw),
			command
		)
	}
}

#[test]
fn falls_back_to_input_stream_reconstruction(){
	// 没有前端命令：剥 ANSI，去边缘空白，归一化编辑键
	assert_eq!(
		resolve_command_line(None,"\x1b[0             cat /lo\tsy\trun\t.l\r"),
		"cat /lo sy run .l"
	);
	// 前端送来的空白视为未提供，回退重建
	assert_eq!(
		resolve_command_line(Some("   "),"cd /tmp\r"),
		"cd /tmp"
	)
}

#[test]
fn empty_line_is_not_recorded(){
	assert_eq!(resolve_command_line(None,"\r"), "");
	assert_eq!(resolve_command_line(Some("   "),"  \r"), "");
}

#[test]
fn tail_bytes_never_splits_multibyte_char(){
	// 回归：本地会话提示符含中文用户名（C:\Users\黄志强），按字节截尾时曾 panic：
	// "start byte index 35 is not a char boundary; it is inside '志' (bytes 34..37)"
	let line = "PS C:\\Users\\黄志强> 一段足够长的中文输出用于撑过缓冲区上限";
	let text = line.repeat(4);
	assert!(text.len() > 256);
	let tail = tail_bytes(&text, 256);
	assert!(tail.len() <= 256);
	assert!(text.ends_with(&tail));

	// 起点恰好落在多字节字符内部时向后对齐到字符边界（宁可少留几个字节）
	let tricky = "a".repeat(34) + "志";
	assert_eq!(tail_bytes(&tricky, 3), "志");
	assert!(tail_bytes(&tricky, 1).is_empty());
	// 未超上限时原样返回
	assert_eq!(tail_bytes("短", 256), "短");
	assert_eq!(tail_bytes("abc", 3), "abc");
}
