//! mcp/sessions.rs 的单元测试（经 `#[path]` 编回源模块）。

use super::*;
use std::fs;

/// 在临时目录写一份 sessions.json，返回目录路径。
fn write_sessions(dir: &Path, content: &str) {
	fs::create_dir_all(dir).unwrap();
	fs::write(dir.join("sessions.json"), content).unwrap();
}

fn temp_dir(tag: &str) -> PathBuf {
	let dir = std::env::temp_dir().join(format!(
		"tera-mcp-sessions-{tag}-{}",
		std::process::id()
	));
	let _ = fs::remove_dir_all(&dir);
	dir
}

#[test]
fn lists_sessions_without_password() {
	let dir = temp_dir("basic");
	write_sessions(
		&dir,
		r#"[{"id":"a1","name":"prod","kind":"ssh","host":"10.0.0.1","port":22,"username":"root","password":"SECRET_CIPHER"}]"#,
	);
	let sessions = sessions_from(&dir);
	assert_eq!(sessions.len(), 1);
	let s = &sessions[0];
	assert_eq!(s.id, "a1");
	assert_eq!(s.name, "prod");
	assert_eq!(s.kind, "ssh");
	assert_eq!(s.host, "10.0.0.1");
	assert_eq!(s.port, 22);
	assert_eq!(s.username, "root");
	// SessionMeta 没有 password 字段，天然不含凭据
	let _ = fs::remove_dir_all(&dir);
}

#[test]
fn missing_file_yields_empty() {
	let dir = temp_dir("missing");
	let sessions = sessions_from(&dir);
	assert!(sessions.is_empty());
	let _ = fs::remove_dir_all(&dir);
}

#[test]
fn invalid_json_yields_empty() {
	let dir = temp_dir("invalid");
	write_sessions(&dir, "not json at all");
	assert!(sessions_from(&dir).is_empty());
	let _ = fs::remove_dir_all(&dir);
}

#[test]
fn skips_records_with_empty_id() {
	let dir = temp_dir("empty-id");
	write_sessions(
		&dir,
		r#"[
			{"id":"","name":"bad","kind":"ssh","host":"x","port":22,"username":"root"},
			{"id":"ok","name":"good","kind":"ssh","host":"y","port":22,"username":"root"}
		]"#,
	);
	let sessions = sessions_from(&dir);
	assert_eq!(sessions.len(), 1);
	assert_eq!(sessions[0].id, "ok");
	let _ = fs::remove_dir_all(&dir);
}

#[test]
fn empty_name_falls_back_to_host() {
	let dir = temp_dir("no-name");
	write_sessions(
		&dir,
		r#"[{"id":"a1","name":"","kind":"ssh","host":"10.0.0.9","port":22,"username":"root"}]"#,
	);
	let sessions = sessions_from(&dir);
	assert_eq!(sessions[0].name, "10.0.0.9");
	let _ = fs::remove_dir_all(&dir);
}

#[test]
fn local_kind_normalized() {
	let dir = temp_dir("local");
	write_sessions(
		&dir,
		r#"[{"id":"local","name":"本地","kind":"local","host":"localhost","port":0,"username":""}]"#,
	);
	let sessions = sessions_from(&dir);
	assert_eq!(sessions[0].kind, "local");
	let _ = fs::remove_dir_all(&dir);
}
