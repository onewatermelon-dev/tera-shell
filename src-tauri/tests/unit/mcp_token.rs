//! mcp/token.rs 的单元测试（经 `#[path]` 编回源模块）。

use super::*;

#[test]
fn generate_returns_64_hex_chars() {
	let token = generate();
	assert_eq!(token.len(), 64);
	assert!(token.chars().all(|c| c.is_ascii_hexdigit()));
}

#[test]
fn generate_is_unique_each_time() {
	let a = generate();
	let b = generate();
	assert_ne!(a, b, "两次生成的令牌不应相同");
}

#[test]
fn verify_matches_exact_token() {
	let token = generate();
	assert!(verify(&token, &token));
}

#[test]
fn verify_rejects_different_token() {
	let token = generate();
	let other = generate();
	assert!(!verify(&token, &other));
}

#[test]
fn verify_rejects_empty_either_side() {
	let token = generate();
	assert!(!verify("", ""));
	assert!(!verify(&token, ""));
	assert!(!verify("", &token));
}

#[test]
fn verify_rejects_length_mismatch() {
	let token = generate();
	// 长度不同直接返回 false，不会 panic
	assert!(!verify(&token, "short"));
}

#[test]
fn verify_constant_time_style_does_not_panic_on_prefix() {
	let token = generate();
	let prefix = &token[..32];
	assert!(!verify(&token, prefix));
}

#[test]
fn persist_and_load_roundtrip() {
	let dir = std::env::temp_dir().join(format!(
		"tera-mcp-token-test-{}",
		std::process::id()
	));
	let _ = std::fs::remove_dir_all(&dir);
	let token = generate();
	persist(&dir, &token).expect("写入令牌失败");
	let loaded = load(&dir).expect("读取令牌失败");
	assert_eq!(loaded, token);
	let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn load_returns_none_when_file_missing() {
	let dir = std::env::temp_dir().join(format!(
		"tera-mcp-token-missing-{}",
		std::process::id()
	));
	let _ = std::fs::remove_dir_all(&dir);
	assert!(load(&dir).is_none());
}

#[test]
fn from_env_reads_and_trims() {
	// 环境变量在测试里可能残留，用独立的、极不可能撞名的键
	unsafe { std::env::set_var("TERA_MCP_TOKEN", "  abc123  ") };
	// from_env 读的是固定键 TERA_MCP_TOKEN，这里无法在测试里换键，
	// 但验证 trim 与空值过滤逻辑可通过直接断言行为
	assert_eq!(
		from_env().as_deref(),
		Some("abc123"),
		"应去除首尾空白"
	);
	unsafe { std::env::remove_var("TERA_MCP_TOKEN") };
}
