//! ssh 模块单元测试：目标归一化与连接池 key。
//!
//! 由 `src/ssh/mod.rs` 以 `#[path]` 编回，测试可以访问私有项。
//! 真实跳板连接需要 SSH 服务器，不在此处覆盖；这里只钉住纯逻辑：
//! 默认值、跳板顺序、key 的稳定性与「密码绝不进 key」。

use super::*;

fn hop(
	host: &str,
	port: Option<u16>,
	username: Option<&str>,
	password: Option<&str>,
) -> JumpHop {
	JumpHop {
		host: host.to_string(),
		port,
		username: username.map(str::to_string),
		password: password.map(str::to_string),
	}
}

#[test]
fn target_normalizes_defaults() {
	let target = SshTarget::new(
		"  web-01  ",
		None,
		Some("  "),
		Some("  "),
		Some("  "),
		Vec::new(),
	)
	.unwrap();
	assert_eq!(target.host, "web-01");
	assert_eq!(target.port, 22);
	assert_eq!(target.username, "root");
	assert_eq!(target.password, None);
	assert_eq!(target.key_path, None);
}

#[test]
fn target_rejects_empty_host() {
	assert!(SshTarget::new("   ", None, None, None, None, Vec::new()).is_err());
}

#[test]
fn target_rejects_empty_jump_host() {
	let error = SshTarget::new(
		"target",
		None,
		None,
		None,
		None,
		vec![hop("  ", None, None, None)],
	)
	.err()
	.expect("空跳板主机应当报错");
	assert!(error.contains("跳板机缺少主机地址"));
}

#[test]
fn key_is_stable_and_includes_jump_order() {
	let make = || {
		SshTarget::new(
			"web-01",
			Some(2222),
			Some("ops"),
			Some("secret"),
			Some("/home/ops/.ssh/id_ed25519"),
			vec![
				hop("edge", None, Some("jump"), Some("jump-pass")),
				hop("bastion", Some(2200), None, None),
			],
		)
		.unwrap()
	};
	let target = make();
	assert_eq!(
		target.key(),
		"ops@web-01:2222#jump=jump@edge:22,root@bastion:2200#key=/home/ops/.ssh/id_ed25519"
	);
	// 两次构造必须一致：连接池靠它命中缓存
	assert_eq!(target.key(), make().key());
	// 密码不进 key，也不进日志描述
	assert!(!target.key().contains("secret"));
	assert!(!target.key().contains("jump-pass"));
	assert!(!target.describe().contains("secret"));
	assert!(target.describe().contains("2 跳板"));
}

#[test]
fn key_without_jump_or_key_stays_legacy() {
	let target = SshTarget::new(
		"web-01",
		None,
		Some("ops"),
		None,
		None,
		Vec::new(),
	)
	.unwrap();
	assert_eq!(target.key(), "ops@web-01:22");
}

#[test]
fn expand_tilde_only_handles_home_prefix() {
	// 绝对路径原样返回
	assert_eq!(
		expand_tilde("/home/ops/.ssh/id_rsa"),
		"/home/ops/.ssh/id_rsa"
	);
	// `~user/...` 不展开：libssh2 不认这种语法，交给用户显式写路径
	assert_eq!(expand_tilde("~ops/id_rsa"), "~ops/id_rsa");
	// `~` 能展开成主目录（主目录取不到时保持原样，也不该 panic）
	let expanded = expand_tilde("~/id_rsa");
	if std::env::var_os("USERPROFILE").is_some()
		|| std::env::var_os("HOME").is_some()
	{
		assert!(expanded.ends_with("id_rsa"));
		assert_ne!(expanded, "~/id_rsa");
	}
}

#[test]
fn jump_hop_defaults_match_target_defaults() {
	let hop = hop("  bastion  ", None, Some(" "), Some(" "));
	assert_eq!(hop.host(), "bastion");
	assert_eq!(hop.port(), 22);
	assert_eq!(hop.username(), "root");
	assert_eq!(hop.password(), None);
}
