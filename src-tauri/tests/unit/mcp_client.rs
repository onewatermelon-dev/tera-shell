//! mcp/client.rs 的单元测试（经 `#[path]` 编回源模块）。

use super::*;
use std::fs;

#[test]
fn qualify_adds_prefix() {
	assert_eq!(qualify("filesystem", "read_file"), "mcp__filesystem__read_file");
}

#[test]
fn split_name_roundtrips() {
	let name = qualify("filesystem", "read_file");
	let (server, tool) = split_name(&name).expect("应能拆分");
	assert_eq!(server, "filesystem");
	assert_eq!(tool, "read_file");
}

#[test]
fn split_name_rejects_no_prefix() {
	assert!(split_name("read_file").is_err());
}

#[test]
fn split_name_rejects_bad_format() {
	assert!(split_name("mcp__no_separator").is_err());
	assert!(split_name("mcp____tool").is_err()); // 空 server
	assert!(split_name("mcp__server__").is_err()); // 空 tool
}

#[test]
fn load_servers_reads_file() {
	let dir = std::env::temp_dir().join(format!(
		"tera-mcp-client-{}",
		std::process::id()
	));
	let _ = fs::remove_dir_all(&dir);
	fs::create_dir_all(&dir).unwrap();
	fs::write(
		dir.join("mcp_servers.json"),
		r#"[
			{"name":"filesystem","command":"npx","args":["-y","@modelcontextprotocol/server-filesystem"]},
			{"name":"remote","url":"http://localhost:3000/mcp"}
		]"#,
	)
	.unwrap();
	let servers = load_servers(&dir);
	assert_eq!(servers.len(), 2);
	assert_eq!(servers[0].name, "filesystem");
	assert_eq!(servers[0].command.as_deref(), Some("npx"));
	assert_eq!(servers[0].args.len(), 2);
	assert_eq!(servers[1].url.as_deref(), Some("http://localhost:3000/mcp"));
	let _ = fs::remove_dir_all(&dir);
}

#[test]
fn load_servers_missing_file_empty() {
	let dir = std::env::temp_dir().join(format!(
		"tera-mcp-client-missing-{}",
		std::process::id()
	));
	let _ = fs::remove_dir_all(&dir);
	assert!(load_servers(&dir).is_empty());
}

/// Claude Desktop 风格（名字在 mcpServers 键上、条目无 name 字段）必须
/// 摊平成功 —— name 必填时反序列化会在赋名前静默失败，注入 0 个工具
#[test]
fn load_servers_flattens_claude_desktop_style() {
	let dir = std::env::temp_dir().join(format!(
		"tera-mcp-client-claude-{}",
		std::process::id()
	));
	let _ = fs::remove_dir_all(&dir);
	fs::create_dir_all(&dir).unwrap();
	fs::write(
		dir.join("mcp_servers.json"),
		r#"[{"mcpServers":{"everything":{"command":"npx","args":["-y","@modelcontextprotocol/server-everything"]}}}]"#,
	)
	.unwrap();
	let servers = load_servers(&dir);
	assert_eq!(servers.len(), 1, "Claude 风格要摊平出一台");
	assert_eq!(servers[0].name, "everything", "名字取 mcpServers 的键");
	assert_eq!(servers[0].command.as_deref(), Some("npx"));
	let _ = fs::remove_dir_all(&dir);
}
