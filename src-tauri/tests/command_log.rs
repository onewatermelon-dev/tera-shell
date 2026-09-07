use tera_shell_lib::terminal::{normalize_command_line, resolve_command_line, strip_ansi};

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
