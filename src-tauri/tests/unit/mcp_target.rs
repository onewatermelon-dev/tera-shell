//! mcp/target.rs 的单元测试（经 `#[path]` 编回源模块）。

use super::*;
use std::fs;

fn temp_dir(tag: &str) -> std::path::PathBuf {
	let dir = std::env::temp_dir().join(format!(
		"tera-mcp-target-{tag}-{}",
		std::process::id()
	));
	let _ = fs::remove_dir_all(&dir);
	fs::create_dir_all(&dir).unwrap();
	dir
}

fn write_sessions(dir: &std::path::Path, content: &str) {
	fs::write(dir.join("sessions.json"), content).unwrap();
}

fn write_settings(dir: &std::path::Path, content: &str) {
	fs::write(dir.join("settings.json"), content).unwrap();
}

#[test]
fn not_found_when_session_missing() {
	let dir = temp_dir("missing");
	write_sessions(&dir, "[]");
	match build_exec_target(&dir, "nope", "ls".into()) {
		Err(TargetError::NotFound(_)) => {}
		Err(other) => panic!("期望 NotFound，得到 {other}"),
		Ok(_) => panic!("期望 NotFound，得到 Ok"),
	}
	let _ = fs::remove_dir_all(&dir);
}

#[test]
fn local_session_is_not_found() {
	let dir = temp_dir("local");
	write_sessions(
		&dir,
		r#"[{"id":"local","kind":"local","host":"localhost","port":0,"username":""}]"#,
	);
	match build_exec_target(&dir, "local", "ls".into()) {
		Err(TargetError::NotFound(_)) => {}
		Err(other) => panic!("期望 NotFound，得到 {other}"),
		Ok(_) => panic!("期望 NotFound，得到 Ok"),
	}
	let _ = fs::remove_dir_all(&dir);
}

#[test]
fn builds_target_without_password() {
	let dir = temp_dir("nopass");
	write_sessions(
		&dir,
		r#"[{"id":"a","kind":"ssh","host":"10.0.0.1","port":2222,"username":"admin"}]"#,
	);
	write_settings(&dir, r#"{"sshKeyPath":"/key","hostKeyPolicy":"strict"}"#);
	let target = build_exec_target(&dir, "a", "df -h".into())
		.expect("应能构造目标");
	assert_eq!(target.host, "10.0.0.1");
	assert_eq!(target.port, Some(2222));
	assert_eq!(target.username.as_deref(), Some("admin"));
	assert_eq!(target.password, None);
	assert_eq!(target.key_path.as_deref(), Some("/key"));
	assert_eq!(target.host_key_policy.as_deref(), Some("strict"));
	assert_eq!(target.command, "df -h");
	assert!(target.jump.is_empty());
	let _ = fs::remove_dir_all(&dir);
}

#[test]
fn default_port_is_22() {
	let dir = temp_dir("port22");
	write_sessions(
		&dir,
		r#"[{"id":"a","kind":"ssh","host":"10.0.0.1","port":0,"username":"root"}]"#,
	);
	let target = build_exec_target(&dir, "a", "ls".into())
		.expect("应能构造目标");
	assert_eq!(target.port, Some(22));
	let _ = fs::remove_dir_all(&dir);
}

#[test]
fn resolves_jump_chain_in_order() {
	let dir = temp_dir("jump");
	// A(目标) 跳 B，B 跳 C → 物理路径 客户端→C→B→A，连接要求最近的在前
	write_sessions(
		&dir,
		r#"[
			{"id":"a","kind":"ssh","host":"target","port":22,"username":"root","jumpHostId":"b"},
			{"id":"b","kind":"ssh","host":"mid","port":22,"username":"ops","jumpHostId":"c"},
			{"id":"c","kind":"ssh","host":"gate","port":2222,"username":"jump"}
		]"#,
	);
	let target = build_exec_target(&dir, "a", "ls".into())
		.expect("应能构造目标");
	// 跳板链：最近的在前 → [C, B]
	assert_eq!(target.jump.len(), 2);
	assert_eq!(target.jump[0].host, "gate");
	assert_eq!(target.jump[0].port, Some(2222));
	assert_eq!(target.jump[1].host, "mid");
	let _ = fs::remove_dir_all(&dir);
}

#[test]
fn cycle_in_jump_falls_back_to_direct() {
	let dir = temp_dir("cycle");
	// A 跳 B，B 跳 A → 成环，不走跳板
	write_sessions(
		&dir,
		r#"[
			{"id":"a","kind":"ssh","host":"target","port":22,"username":"root","jumpHostId":"b"},
			{"id":"b","kind":"ssh","host":"mid","port":22,"username":"ops","jumpHostId":"a"}
		]"#,
	);
	let target = build_exec_target(&dir, "a", "ls".into())
		.expect("成环应降级为直连而非报错");
	assert!(target.jump.is_empty());
	let _ = fs::remove_dir_all(&dir);
}

#[test]
fn missing_jump_session_falls_back_to_direct() {
	let dir = temp_dir("missing-jump");
	write_sessions(
		&dir,
		r#"[{"id":"a","kind":"ssh","host":"target","port":22,"username":"root","jumpHostId":"deleted"}]"#,
	);
	let target = build_exec_target(&dir, "a", "ls".into())
		.expect("跳板缺失应降级为直连");
	assert!(target.jump.is_empty());
	let _ = fs::remove_dir_all(&dir);
}
