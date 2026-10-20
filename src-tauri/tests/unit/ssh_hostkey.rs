//! ssh::hostkey 单元测试：策略、known_hosts 解析与匹配、指纹行与文件追加。
//!
//! 由 `src/ssh/hostkey.rs` 以 `#[path]` 编回，测试可以访问私有项。
//!
//! 之所以能离线覆盖绝大部分逻辑：解析与比对都是纯函数，不依赖 SSH 会话
//! （这也是放弃 libssh2 的 `KnownHosts` 的收益之一）。真实握手那条放在
//! `#[ignore]` 里，手动跑。

use super::*;
use ssh2::HostKeyType;
use std::fs;
use uuid::Uuid;

/// 每个用例独占的临时目录，避免并行跑测试时互相踩。
fn temp_dir() -> PathBuf {
	std::env::temp_dir().join(format!(
		"tera-shell-hostkey-{}",
		Uuid::new_v4()
	))
}

/// 构造一个带算法名前缀的公钥 blob（SSH wire format）。
fn blob(algorithm: &str) -> Vec<u8> {
	let mut out =
		(algorithm.len() as u32).to_be_bytes().to_vec();
	out.extend_from_slice(algorithm.as_bytes());
	out
}

/// 造一条 base64 编码的假公钥。
fn encoded(seed: u8) -> String {
	use base64::Engine;
	base64::engine::general_purpose::STANDARD
		.encode([seed, seed, seed])
}

#[test]
fn policy_parses_known_values() {
	assert_eq!(
		HostKeyPolicy::parse(Some("accept-new")),
		HostKeyPolicy::AcceptNew
	);
	assert_eq!(
		HostKeyPolicy::parse(Some("ask")),
		HostKeyPolicy::Ask
	);
	assert_eq!(
		HostKeyPolicy::parse(Some("strict")),
		HostKeyPolicy::Strict
	);
}

#[test]
fn policy_falls_back_to_accept_new() {
	// 缺省、空串、未知值一律 accept-new：旧后端遇到新档位不能变成
	// 「全部拒绝」，否则升级瞬间所有 SFTP 都会连不上
	assert_eq!(
		HostKeyPolicy::parse(None),
		HostKeyPolicy::AcceptNew
	);
	assert_eq!(
		HostKeyPolicy::parse(Some("  ")),
		HostKeyPolicy::AcceptNew
	);
	assert_eq!(
		HostKeyPolicy::parse(Some("whatever")),
		HostKeyPolicy::AcceptNew
	);
	assert_eq!(
		HostKeyPolicy::default(),
		HostKeyPolicy::AcceptNew
	);
}

#[test]
fn policy_trims_whitespace() {
	assert_eq!(
		HostKeyPolicy::parse(Some(" strict ")),
		HostKeyPolicy::Strict
	);
}

#[test]
fn host_field_uses_port_brackets_only_for_non_default() {
	assert_eq!(host_field("web-01", 22), "web-01");
	assert_eq!(
		host_field("web-01", 2222),
		"[web-01]:2222"
	);
	// IPv6 字面量也必须带方括号，否则冒号会被当成端口分隔
	assert_eq!(
		host_field("::1", 2200),
		"[::1]:2200"
	);
}

#[test]
fn known_host_line_matches_openssh_format() {
	// b"hello" 的 base64 是 aGVsbG8=
	assert_eq!(
		known_host_line(
			"example.com",
			22,
			"ssh-ed25519",
			b"hello"
		),
		"example.com ssh-ed25519 aGVsbG8=\n"
	);
	assert_eq!(
		known_host_line(
			"example.com",
			2222,
			"ssh-rsa",
			b"hello"
		),
		"[example.com]:2222 ssh-rsa aGVsbG8=\n"
	);
}

#[test]
fn key_type_name_covers_all_known_types() {
	assert_eq!(
		key_type_name(HostKeyType::Rsa, &[]),
		"ssh-rsa"
	);
	assert_eq!(
		key_type_name(HostKeyType::Dss, &[]),
		"ssh-dss"
	);
	assert_eq!(
		key_type_name(HostKeyType::Ecdsa256, &[]),
		"ecdsa-sha2-nistp256"
	);
	assert_eq!(
		key_type_name(HostKeyType::Ecdsa384, &[]),
		"ecdsa-sha2-nistp384"
	);
	assert_eq!(
		key_type_name(HostKeyType::Ecdsa521, &[]),
		"ecdsa-sha2-nistp521"
	);
	assert_eq!(
		key_type_name(HostKeyType::Ed25519, &[]),
		"ssh-ed25519"
	);
}

#[test]
fn key_type_name_falls_back_to_blob_algorithm() {
	// 类型未知时从公钥 blob 里读算法名，避免写进 known_hosts 的行
	// 第二列是 "unknown"（ssh 会整行判为非法）
	let ed = blob("ssh-ed25519");
	assert_eq!(
		key_type_name(HostKeyType::Unknown, &ed),
		"ssh-ed25519"
	);
	assert_eq!(
		key_type_name(HostKeyType::Unknown, b""),
		"unknown"
	);
	// 长度声明超出实际内容时也不能 panic
	assert_eq!(
		key_type_name(HostKeyType::Unknown, &[0, 0, 0, 99]),
		"unknown"
	);
}

#[test]
fn parse_skips_comments_blanks_and_bad_lines() {
	let text = format!(
		"# comment\n\n   \n\
		 host-a ssh-ed25519 {}\n\
		 host-b ssh-ed25519 not-base64!!\n\
		 broken-line\n",
		encoded(1)
	);
	let entries = parse_known_hosts(&text);
	assert_eq!(entries.len(), 1);
	assert_eq!(entries[0].patterns, vec!["host-a"]);
	assert_eq!(entries[0].key_type, "ssh-ed25519");
	assert!(!entries[0].revoked);
}

#[test]
fn parse_handles_multiple_aliases_and_ports() {
	let text = format!(
		"a.example,b.example ssh-ed25519 {}\n\
		 [c.example]:2222 ssh-rsa {}\n",
		encoded(2),
		encoded(3)
	);
	let entries = parse_known_hosts(&text);
	assert_eq!(entries.len(), 2);
	assert_eq!(
		entries[0].patterns,
		vec!["a.example", "b.example"]
	);
	assert_eq!(entries[1].patterns, vec!["[c.example]:2222"]);
	// `[h]:p` 不能污染主机名本身
	assert!(pattern_matches(
		&entries[1].patterns[0],
		"c.example",
		2222
	));
}

#[test]
fn parse_recognizes_revoked_and_skips_cert_authority() {
	let text = format!(
		"@revoked bad.example ssh-ed25519 {}\n\
		 @cert-authority *.example ssh-ed25519 {}\n",
		encoded(4),
		encoded(5)
	);
	let entries = parse_known_hosts(&text);
	// CA 行不支持（需要证书链），跳过；revoked 保留下来用于拒绝
	assert_eq!(entries.len(), 1);
	assert!(entries[0].revoked);
	assert_eq!(entries[0].patterns, vec!["bad.example"]);
}

#[test]
fn parse_skips_hashed_hostnames() {
	// hashed 条目要 HMAC-SHA1 才能反推，只能跳过 —— 不能当成匹配
	let text = format!(
		"|1|abc=|def= ssh-ed25519 {}\n\
		 plain.example ssh-ed25519 {}\n",
		encoded(6),
		encoded(7)
	);
	let entries = parse_known_hosts(&text);
	assert_eq!(entries.len(), 1);
	assert_eq!(entries[0].patterns, vec!["plain.example"]);
}

#[test]
fn parse_strips_utf8_bom() {
	// Windows 编辑器可能写 BOM：不清掉第一行主机名永远对不上
	let text = format!(
		"\u{feff}first.example ssh-ed25519 {}\n",
		encoded(8)
	);
	let entries = parse_known_hosts(&text);
	assert_eq!(entries.len(), 1);
	assert_eq!(entries[0].patterns, vec!["first.example"]);
}

#[test]
fn pattern_matching_follows_openssh_port_rules() {
	// 不带端口的条目只匹配 22
	assert!(pattern_matches("h.example", "h.example", 22));
	assert!(!pattern_matches(
		"h.example",
		"h.example",
		2222
	));
	// 带端口的条目只匹配该端口
	assert!(pattern_matches(
		"[h.example]:2222",
		"h.example",
		2222
	));
	assert!(!pattern_matches(
		"[h.example]:2222",
		"h.example",
		22
	));
	// 大小写不敏感
	assert!(pattern_matches(
		"H.Example",
		"h.example",
		22
	));
}

#[test]
fn pattern_matching_supports_wildcards() {
	assert!(pattern_matches(
		"*.example",
		"web-01.example",
		22
	));
	assert!(pattern_matches(
		"web-?.example",
		"web-1.example",
		22
	));
	assert!(!pattern_matches(
		"web-?.example",
		"web-12.example",
		22
	));
	// 回溯不能漏掉「星号要多吃几个字符」的情况
	assert!(pattern_matches(
		"*a*b",
		"xxaxxb",
		22
	));
	assert!(pattern_matches("*", "anything", 22));
}

#[test]
fn check_matches_same_key_and_detects_change() {
	let key = encoded(9);
	let text = format!(
		"h.example ssh-ed25519 {key}\n"
	);
	let entries = parse_known_hosts(&text);
	let raw = decode_base64(&key).unwrap();
	assert_eq!(
		check_host_key(
			&entries,
			"h.example",
			22,
			"ssh-ed25519",
			&raw
		),
		KeyCheck::Matched
	);

	// 同一主机、同一算法、不同公钥 → 指纹变了
	let mut tampered = raw.clone();
	tampered[0] ^= 0xff;
	assert_eq!(
		check_host_key(
			&entries,
			"h.example",
			22,
			"ssh-ed25519",
			&tampered
		),
		KeyCheck::Changed
	);
}

#[test]
fn check_reports_unknown_algorithm_separately_from_unknown_host() {
	// 服务器新增 ed25519 而 known_hosts 里只有 rsa：按 OpenSSH 的
	// 按算法查找处理，是「这个算法没记录」而不是「指纹变了」
	let text = format!(
		"h.example ssh-rsa {}\n",
		encoded(10)
	);
	let entries = parse_known_hosts(&text);
	assert_eq!(
		check_host_key(
			&entries,
			"h.example",
			22,
			"ssh-ed25519",
			&blob("ssh-ed25519")
		),
		KeyCheck::UnknownAlgorithm
	);
	// 真正没记录的主机是另一个变体：两者的报错文案要能区分，
	// 否则用户看到「明明连过却被拒」无从理解
	assert_eq!(
		check_host_key(
			&entries,
			"other.example",
			22,
			"ssh-ed25519",
			&blob("ssh-ed25519")
		),
		KeyCheck::Unknown
	);
}

#[test]
fn check_reports_revoked_only_for_the_same_key() {
	let revoked_key = encoded(11);
	let other_key = encoded(12);
	let text = format!(
		"@revoked h.example ssh-ed25519 {revoked_key}\n\
		 h.example ssh-rsa {other_key}\n"
	);
	let entries = parse_known_hosts(&text);
	// 被吊销的那把钥匙 → Revoked
	assert_eq!(
		check_host_key(
			&entries,
			"h.example",
			22,
			"ssh-ed25519",
			&decode_base64(&revoked_key).unwrap()
		),
		KeyCheck::Revoked
	);
	// 同主机的另一把（未被吊销）不受影响
	assert_eq!(
		check_host_key(
			&entries,
			"h.example",
			22,
			"ssh-rsa",
			&decode_base64(&other_key).unwrap()
		),
		KeyCheck::Matched
	);
}

#[test]
fn check_ignores_other_hosts_and_ports() {
	let text =
		format!("h.example ssh-ed25519 {}\n", encoded(13));
	let entries = parse_known_hosts(&text);
	let raw = decode_base64(&encoded(13)).unwrap();
	assert_eq!(
		check_host_key(
			&entries,
			"other.example",
			22,
			"ssh-ed25519",
			&raw
		),
		KeyCheck::Unknown
	);
	// 同主机不同端口是另一条记录
	assert_eq!(
		check_host_key(
			&entries,
			"h.example",
			2222,
			"ssh-ed25519",
			&raw
		),
		KeyCheck::Unknown
	);
}

#[test]
fn load_returns_empty_when_file_missing() {
	let dir = temp_dir();
	let path = dir.join("known_hosts");
	// 文件不存在是首次使用的正常情况，不是错误
	assert_eq!(
		load_known_hosts(Some(&path)).unwrap(),
		Vec::new()
	);
	assert_eq!(load_known_hosts(None).unwrap(), Vec::new());
}

#[test]
fn load_reads_file_with_non_ascii_path() {
	// 回归：libssh2 的 readfile 在中文用户名路径下直接打不开
	// （fopen 走 ANSI 代码页），必须用 std::fs 才读得到
	let root = temp_dir();
	let dir = root.join("黄志强").join(".ssh");
	fs::create_dir_all(&dir).unwrap();
	let path = dir.join("known_hosts");
	let key = encoded(14);
	fs::write(
		&path,
		format!("h.example ssh-ed25519 {key}\n"),
	)
	.unwrap();
	let entries = load_known_hosts(Some(&path)).unwrap();
	assert_eq!(entries.len(), 1);
	assert_eq!(entries[0].patterns, vec!["h.example"]);
	let _ = fs::remove_dir_all(&root);
}

#[test]
fn append_creates_parent_and_appends_lines() {
	let dir = temp_dir();
	let path = dir.join(".ssh").join("known_hosts");
	append_known_host(
		&path,
		"a.example",
		22,
		"ssh-ed25519",
		b"one",
	)
	.unwrap();
	append_known_host(
		&path,
		"b.example",
		2222,
		"ssh-rsa",
		b"two",
	)
	.unwrap();
	assert_eq!(
		fs::read_to_string(&path).unwrap(),
		"a.example ssh-ed25519 b25l\n[b.example]:2222 ssh-rsa dHdv\n"
	);
	let _ = fs::remove_dir_all(&dir);
}

#[test]
fn append_keeps_existing_content_and_fixes_missing_newline() {
	let dir = temp_dir();
	fs::create_dir_all(&dir).unwrap();
	let path = dir.join("known_hosts");
	// 用户文件末尾没有换行（手工编辑过）：直接追加会把两行粘成一行
	// 非法条目，所以必须先补换行
	fs::write(
		&path,
		"# my hosts\nold.example ssh-ed25519 b2xk",
	)
	.unwrap();
	append_known_host(
		&path,
		"new.example",
		22,
		"ssh-ed25519",
		b"new",
	)
	.unwrap();
	assert_eq!(
		fs::read_to_string(&path).unwrap(),
		"# my hosts\nold.example ssh-ed25519 b2xk\nnew.example ssh-ed25519 bmV3\n"
	);
	let _ = fs::remove_dir_all(&dir);
}

#[test]
fn append_leaves_trailing_newline_alone() {
	let dir = temp_dir();
	fs::create_dir_all(&dir).unwrap();
	let path = dir.join("known_hosts");
	fs::write(&path, "old.example ssh-ed25519 b2xk\n")
		.unwrap();
	append_known_host(
		&path,
		"new.example",
		22,
		"ssh-ed25519",
		b"new",
	)
	.unwrap();
	// 不能多出空行
	assert_eq!(
		fs::read_to_string(&path).unwrap(),
		"old.example ssh-ed25519 b2xk\nnew.example ssh-ed25519 bmV3\n"
	);
	let _ = fs::remove_dir_all(&dir);
}

/// 真实链路验证：真实 `known_hosts` + 真实握手拿到的主机公钥。
///
/// 默认不跑（要外网），手动执行：
/// ```text
/// cargo test --no-default-features --lib real -- --ignored --nocapture
/// ```
///
/// 前提：本机 `~/.ssh/known_hosts` 里有 `github.com` 的明文条目。
/// **不写任何文件** —— 只读真实文件、只做比对。
#[test]
#[ignore = "需要外网：真实握手 github.com:22 验证解析与比对链路"]
fn real_handshake_validates_against_actual_known_hosts() {
	use std::net::{TcpStream, ToSocketAddrs};
	use std::time::Duration;

	let path = known_hosts_path().expect("拿不到主目录");
	let entries =
		load_known_hosts(Some(&path)).expect("读取真实 known_hosts 失败");
	println!(
		"[real] 解析到 {} 条记录（{}）",
		entries.len(),
		path.display()
	);
	// 这条断言就是这个 bug 的回归钉子：以前用 libssh2 读，中文用户名
	// 路径下恒为 0 条
	assert!(
		!entries.is_empty(),
		"真实 known_hosts 应该能解析出条目"
	);

	let address = ("github.com", 22u16)
		.to_socket_addrs()
		.expect("解析 github.com 失败")
		.next()
		.expect("没有可用地址");
	let tcp = TcpStream::connect_timeout(
		&address,
		Duration::from_secs(8),
	)
	.expect("连接 github.com:22 失败（检查网络/代理）");
	let mut session = Session::new().unwrap();
	session.set_tcp_stream(tcp);
	session.set_timeout(15_000);
	session.handshake().expect("SSH 握手失败");

	let (raw, kind) = session.host_key().expect("拿不到主机公钥");
	let key_type = key_type_name(kind, raw);
	println!("[real] 协商算法 = {key_type}");
	println!(
		"[real] 指纹 = {}",
		fingerprint(&session).unwrap_or_default()
	);

	// 真实主机没被篡改，无论如何都不能判成「指纹变了」
	let result =
		check_host_key(&entries, "github.com", 22, &key_type, raw);
	println!("[real] github.com（协商算法）→ {result:?}");
	assert_ne!(result, KeyCheck::Changed);

	// 用真实文件里的 github.com 条目做三件事：自证匹配、自造篡改、
	// 确认端口/主机隔离 —— 全程只读，不改任何文件
	let github = entries
		.iter()
		.find(|entry| {
			entry
				.patterns
				.iter()
				.any(|pattern| pattern == "github.com")
		})
		.expect("known_hosts 里应有 github.com");
	println!(
		"[real] 文件里的 github.com 算法 = {}",
		github.key_type
	);
	assert_eq!(
		check_host_key(
			&entries,
			"github.com",
			22,
			&github.key_type,
			&github.blob
		),
		KeyCheck::Matched
	);
	let mut tampered = github.blob.clone();
	tampered[0] ^= 0xff;
	assert_eq!(
		check_host_key(
			&entries,
			"github.com",
			22,
			&github.key_type,
			&tampered
		),
		KeyCheck::Changed
	);
	// 换成 2222 端口就是另一条记录，不能命中
	assert_eq!(
		check_host_key(
			&entries,
			"github.com",
			2222,
			&github.key_type,
			&github.blob
		),
		KeyCheck::Unknown
	);

	// 同一把钥匙冒充另一台已记录主机 → 必须判成不一致
	let impersonate =
		check_host_key(&entries, "gitee.com", 22, &key_type, raw);
	println!("[real] 冒充 gitee.com → {impersonate:?}");
	assert_ne!(impersonate, KeyCheck::Matched);

	// 未记录主机 + strict / ask → 拒绝，且报错能看出是哪一跳
	let strict = verify_host_key(
		&session,
		"no-such-host.invalid",
		22,
		HostKeyPolicy::Strict,
		"跳板机",
	)
	.expect_err("strict 下未记录主机必须被拒");
	println!("[real] strict → {strict}");
	assert!(strict.contains("不在 known_hosts"));
	assert!(strict.starts_with("跳板机 "));

	let ask = verify_host_key(
		&session,
		"no-such-host.invalid",
		22,
		HostKeyPolicy::Ask,
		"目标主机",
	)
	.expect_err("ask 下未记录主机必须被拒");
	println!("[real] ask → {ask}");
	assert!(ask.contains("尚未记录"));
}
