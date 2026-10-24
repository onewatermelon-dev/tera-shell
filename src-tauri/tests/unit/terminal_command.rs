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
		host_key_policy: None,
		jump: None,
		forwards: None,
		tunnel_mode: None,
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

/// 造一个带密钥策略的 ssh Config。
fn ssh_config_with_policy(policy: Option<&str>) -> Config {
	let mut config = ssh_config(None, None);
	config.host_key_policy = policy.map(Into::into);
	config
}

/// 取 argv 里所有 `-o` 后面跟着的选项值。
fn options(argv: &[std::ffi::OsString]) -> Vec<String> {
	argv.windows(2)
		.filter(|pair| pair[0] == "-o")
		.filter_map(|pair| pair[1].to_str().map(Into::into))
		.collect()
}

#[test]
fn 密钥策略三档拼进严格检查选项() {
	for (policy, expected) in [
		(Some("ask"), "ask"),
		(Some("accept-new"), "accept-new"),
		(Some("strict"), "strict"),
	] {
		let command = command(&ssh_config_with_policy(policy)).unwrap();
		assert!(
			options(command.get_argv())
				.contains(&format!("StrictHostKeyChecking={expected}")),
			"policy={policy:?} 时应拼对应档位"
		);
	}
}

#[test]
fn 密钥策略缺省与非法值退回默认档() {
	// 缺省 = 旧前端，必须与此前硬编码的 accept-new 行为一致；
	// 非法值（手改设置文件）也不能拼出让 ssh 拒启的选项
	for policy in [None, Some(""), Some("banana")] {
		let command = command(&ssh_config_with_policy(policy)).unwrap();
		let joined: Vec<&str> = command
			.get_argv()
			.iter()
			.filter_map(|arg| arg.to_str())
			.collect();
		assert!(
			joined.contains(&"StrictHostKeyChecking=accept-new"),
			"policy={policy:?} 应退回 accept-new"
		);
	}
}

#[test]
fn 跳板链拼跳转参数且在目标之前() {
	let mut config = ssh_config(None, None);
	config.jump = Some("ops@10.0.0.1,root@10.0.0.2:2222".into());
	let command = command(&config).unwrap();
	let joined: Vec<&str> = command
		.get_argv()
		.iter()
		.filter_map(|arg| arg.to_str())
		.collect();
	let jump_at = joined.iter().position(|arg| *arg == "-J").unwrap();
	assert_eq!(joined[jump_at + 1], "ops@10.0.0.1,root@10.0.0.2:2222");
	let target_at = joined.iter().position(|arg| *arg == "root@example.com").unwrap();
	assert!(
		jump_at < target_at,
		"-J 必须在目标之前，否则 ssh 把它当目标后的参数拒绝"
	);
}

#[test]
fn 无跳板或空白规格不拼跳转参数() {
	for jump in [None, Some(""), Some("   ")] {
		let mut config = ssh_config(None, None);
		config.jump = jump.map(Into::into);
		let command = command(&config).unwrap();
		assert!(
			!command.get_argv().iter().any(|arg| arg == "-J"),
			"jump={jump:?} 时不应出现 -J"
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

/// 造转发规则；target 两个字段 L/R 才用。
fn rule(kind: &str, listen: u16, host: Option<&str>, port: Option<u16>) -> ForwardRule {
	ForwardRule {
		kind: kind.into(),
		listen_port: listen,
		target_host: host.map(Into::into),
		target_port: port,
	}
}

#[test]
fn 会话级转发拼进L_R_D参数() {
	let mut config = ssh_config(None, None);
	config.forwards = Some(vec![
		rule("L", 8080, Some("localhost"), Some(80)),
		rule("R", 2222, Some("127.0.0.1"), Some(22)),
		rule("D", 1080, None, None),
	]);
	let command = command(&config).unwrap();
	let argv = command.get_argv();
	assert_eq!(arg_value(argv, "-L").as_deref(), Some("8080:localhost:80"));
	assert_eq!(arg_value(argv, "-R").as_deref(), Some("2222:127.0.0.1:22"));
	assert_eq!(arg_value(argv, "-D").as_deref(), Some("1080"));
	// 转发不改变交互语义：-tt 仍在、-N 不出现
	assert!(argv.iter().any(|arg| arg == "-tt"));
	assert!(!argv.iter().any(|arg| arg == "-N"));
}

#[test]
fn 非法转发规则跳过不让连接失败() {
	let mut config = ssh_config(None, None);
	config.forwards = Some(vec![
		rule("L", 0, Some("localhost"), Some(80)), // 端口 0
		rule("L", 8080, Some(""), Some(80)),       // 空目标主机
		rule("L", 9999, Some("localhost"), Some(0)), // 目标端口 0
		rule("X", 7000, None, None),               // 未知类型
	]);
	let command = command(&config).unwrap();
	let argv = command.get_argv();
	for flag in ["-L", "-R", "-D"] {
		assert!(!argv.iter().any(|arg| arg == flag), "{flag} 不应出现");
	}
	// 非法规则只丢弃自身，ssh 本体参数原样保留
	assert!(argv.iter().any(|arg| arg == "root@example.com"));
}

#[test]
fn 隧道模式去tt加N() {
	let mut config = ssh_config(None, None);
	config.tunnel_mode = Some(true);
	config.forwards = Some(vec![rule("L", 8080, Some("localhost"), Some(80))]);
	let command = command(&config).unwrap();
	let argv = command.get_argv();
	assert!(argv.iter().any(|arg| arg == "-N"), "隧道要 -N");
	assert!(!argv.iter().any(|arg| arg == "-tt"), "隧道不申请 PTY");
	assert_eq!(arg_value(argv, "-L").as_deref(), Some("8080:localhost:80"));
	// 隧道也必须有 destination 与端口：args 块曾被整段挪进非隧道分支，
	// 隧道丢了 target 直接打 usage —— 这里钉死
	assert!(argv.iter().any(|arg| arg == "root@example.com"), "隧道不能丢目标");
	assert_eq!(arg_value(argv, "-p").as_deref(), Some("22"));
}

/// IPv6 目标必须方括号包起来，否则冒号会破坏 -L spec 的端口分隔，
/// ssh 直接打 usage（%接口后缀由隧道的归一化剥掉，到不了 spec）。
#[test]
fn 转发目标_ipv6正确加方括号() {
	let rule = ForwardRule {
		kind: "L".into(),
		listen_port: 8080,
		target_host: Some("::1".into()),
		target_port: Some(80),
	};
	assert_eq!(rule.spec().unwrap(), "8080:[::1]:80");
}

#[test]
fn 隧道模式缺省时保持交互语义() {
	let command = command(&ssh_config(None, None)).unwrap();
	let argv = command.get_argv();
	assert!(!argv.iter().any(|arg| arg == "-N"));
	assert!(argv.iter().any(|arg| arg == "-tt"));
}
