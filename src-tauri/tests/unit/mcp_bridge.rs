//! mcp/bridge.rs 的单元测试（经 `#[path]` 编回源模块）。

use super::*;

#[test]
fn register_and_snapshot() {
	let open = OpenSessions::default();
	open.register(OpenSessionMeta {
		id: "a".into(),
		kind: "ssh".into(),
		host: "10.0.0.1".into(),
		port: 22,
		username: "root".into(),
	});
	open.register(OpenSessionMeta {
		id: "b".into(),
		kind: "local".into(),
		host: "localhost".into(),
		port: 0,
		username: String::new(),
	});
	let list = open.snapshot();
	assert_eq!(list.len(), 2);
	// snapshot 按 id 排序
	assert_eq!(list[0].id, "a");
	assert_eq!(list[1].id, "b");
}

#[test]
fn register_same_id_overwrites() {
	let open = OpenSessions::default();
	open.register(OpenSessionMeta {
		id: "x".into(),
		kind: "ssh".into(),
		host: "old".into(),
		port: 22,
		username: "root".into(),
	});
	open.register(OpenSessionMeta {
		id: "x".into(),
		kind: "ssh".into(),
		host: "new".into(),
		port: 2222,
		username: "admin".into(),
	});
	let list = open.snapshot();
	assert_eq!(list.len(), 1);
	assert_eq!(list[0].host, "new");
	assert_eq!(list[0].port, 2222);
}

#[test]
fn remove_deletes_entry() {
	let open = OpenSessions::default();
	open.register(OpenSessionMeta {
		id: "a".into(),
		kind: "ssh".into(),
		host: "10.0.0.1".into(),
		port: 22,
		username: "root".into(),
	});
	open.remove("a");
	assert!(open.snapshot().is_empty());
}

#[test]
fn remove_missing_is_noop() {
	let open = OpenSessions::default();
	open.remove("nonexistent");
	assert!(open.snapshot().is_empty());
}
