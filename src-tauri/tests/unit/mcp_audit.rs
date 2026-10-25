//! mcp/audit.rs 的单元测试（经 `#[path]` 编回源模块）。

use super::*;
use std::fs;

fn temp_dir(tag: &str) -> std::path::PathBuf {
	let dir = std::env::temp_dir().join(format!(
		"tera-mcp-audit-{tag}-{}",
		std::process::id()
	));
	let _ = fs::remove_dir_all(&dir);
	fs::create_dir_all(&dir).unwrap();
	dir
}

#[test]
fn sanitize_masks_private_key_blocks() {
	let command = "cat ~/.ssh/id_rsa\n-----BEGIN OPENSSH PRIVATE KEY-----\nsecret\n-----END OPENSSH PRIVATE KEY-----";
	let out = sanitize_command(command);
	assert!(!out.contains("secret"), "私钥内容不应进审计");
	assert!(out.contains("*** PRIVATE KEY ***"));
	// 普通命令行保留
	assert!(out.contains("cat ~/.ssh/id_rsa"));
}

#[test]
fn truncate_tail_keeps_last_chars() {
	let long = "a".repeat(5000);
	let out = truncate_tail(&long);
	assert_eq!(out.len(), 4000);
	assert!(out.chars().all(|c| c == 'a'));
}

#[test]
fn truncate_tail_short_passthrough() {
	let short = "hello";
	assert_eq!(truncate_tail(short), "hello");
}

#[test]
fn append_writes_json_array() {
	let dir = temp_dir("append");
	let entry = AuditEntry {
		id: "1".into(),
		at: 123,
		client: "test".into(),
		tool: "tera.run_command".into(),
		target: "root@h".into(),
		command: "ls".into(),
		is_read_only: true,
		decision: "approved".into(),
		exit_code: Some(0),
		output_tail: Some("out".into()),
	};
	append(&dir, entry).expect("应能追加");
	let text = fs::read_to_string(dir.join(AUDIT_FILE)).unwrap();
	let list: Vec<serde_json::Value> =
		serde_json::from_str(&text).unwrap();
	assert_eq!(list.len(), 1);
	assert_eq!(list[0]["command"], "ls");
	let _ = fs::remove_dir_all(&dir);
}
