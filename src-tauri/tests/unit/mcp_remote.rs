//! mcp/remote.rs 的单元测试（经 `#[path]` 编回源模块）。

use super::*;
use std::fs;

fn temp_dir(tag: &str) -> std::path::PathBuf {
	let dir = std::env::temp_dir().join(format!(
		"tera-mcp-remote-{tag}-{}",
		std::process::id()
	));
	let _ = fs::remove_dir_all(&dir);
	fs::create_dir_all(&dir).unwrap();
	dir
}

#[test]
fn read_config_parses_valid_file() {
	let dir = temp_dir("valid");
	fs::write(
		dir.join(super::super::bridge::BRIDGE_FILE),
		r#"{"port":12345,"token":"abc"}"#,
	)
	.unwrap();
	let config = read_config(&dir).expect("应能解析有效配置");
	assert_eq!(config.port, 12345);
	assert_eq!(config.token, "abc");
	let _ = fs::remove_dir_all(&dir);
}

#[test]
fn read_config_missing_file_is_not_running() {
	let dir = temp_dir("missing");
	match read_config(&dir) {
		Err(BridgeError::NotRunning) => {}
		Err(other) => panic!("期望 NotRunning，得到 {other}"),
		Ok(_) => panic!("期望 NotRunning，得到 Ok"),
	}
	let _ = fs::remove_dir_all(&dir);
}

#[test]
fn read_config_corrupt_is_other() {
	let dir = temp_dir("corrupt");
	fs::write(
		dir.join(super::super::bridge::BRIDGE_FILE),
		"not json",
	)
	.unwrap();
	match read_config(&dir) {
		Err(BridgeError::Other(_)) => {}
		Err(other) => panic!("期望 Other，得到 {other}"),
		Ok(_) => panic!("期望 Other，得到 Ok"),
	}
	let _ = fs::remove_dir_all(&dir);
}

#[test]
fn not_running_error_has_readable_message() {
	let message = BridgeError::NotRunning.to_string();
	assert!(
		message.contains("主程序未运行"),
		"错误信息应提示用户先打开主程序：{message}"
	);
}
