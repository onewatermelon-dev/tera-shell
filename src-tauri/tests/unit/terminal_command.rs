//! `command()` 的 ssh 参数拼装：默认私钥（-i）与 ~/.ssh/config 开关（-F）。
//!
//! 这两组参数直接决定认证与配置读取行为，拼错的表现是「能连上但用错
//! 了身份」或「用户配好的 ProxyJump 突然不生效」——都很难从界面上看出来，
//! 必须钉在 argv 层。

use super::*;

/// 造一个 ssh 用的 Config；其余字段由 command() 忽略。
fn ssh_config(key_path: Option<&str>, use_ssh_config: Option<bool>) -> Config {
	Config {
		id: "test".into(),
		kind: "ssh".into(),
		host: Some("example.com".into()),
		port: Some(22),
		username: Some("root".into()),
		password: None,
		rows: None,
		cols: None,
		key_path: key_path.map(Into::into),
		use_ssh_config,
	}
}

/// argv 里找 `-i` / `-F` 后面跟着的值。
fn arg_value(argv: &[std::ffi::OsString], flag: &str) -> Option<String> {
	argv.windows(2)
		.find(|pair| pair[0] == flag)
		.and_then(|pair| pair[1].to_str().map(Into::into))
}

#[test]
fn 有私钥路径时拼_i() {
	let command = command(&ssh_config(Some("/keys/id_ed25519"), None)).unwrap();
	let argv = command.get_argv();
	assert_eq!(argv[0], "ssh");
	assert_eq!(arg_value(argv, "-i").as_deref(), Some("/keys/id_ed25519"));
}

#[test]
fn 空白私钥路径不拼_i() {
	// 前端已 trim，这里兜住手改配置/直接调命令的场景：全空格等于没填
	for key in [None, Some(""), Some("   ")] {
		let command = command(&ssh_config(key, None)).unwrap();
		assert!(
			!command.get_argv().iter().any(|arg| arg == "-i"),
			"key_path={key:?} 时不应出现 -i"
		);
	}
}

#[test]
fn 显式关闭配置读取时拼空设备参数() {
	let command = command(&ssh_config(None, Some(false))).unwrap();
	// Windows 与 unix 的空设备名不同，按当前平台断言（cfg 与实现同源）
	let expected = if cfg!(windows) { "NUL" } else { "/dev/null" };
	assert_eq!(arg_value(command.get_argv(), "-F").as_deref(), Some(expected));
}

#[test]
fn 缺省与开启时不拼空设备参数() {
	// 缺省 = 旧前端 / 本地会话，必须与 ssh 默认行为（读 ~/.ssh/config）一致
	for use_ssh_config in [None, Some(true)] {
		let command = command(&ssh_config(None, use_ssh_config)).unwrap();
		assert!(
			!command.get_argv().iter().any(|arg| arg == "-F"),
			"use_ssh_config={use_ssh_config:?} 时不应出现 -F"
		);
	}
}

#[test]
fn 目标与端口仍在argv里() {
	// 加参数不能把既有的 target / -p 挤掉：端口错一位就连到别的机器
	let command = command(&ssh_config(Some("/k"), Some(false))).unwrap();
	let argv = command.get_argv();
	let joined: Vec<&str> = argv.iter().filter_map(|arg| arg.to_str()).collect();
	assert!(joined.contains(&"root@example.com"));
	assert_eq!(joined[joined.iter().position(|a| *a == "-p").unwrap() + 1], "22");
}
