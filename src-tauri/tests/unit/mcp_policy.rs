//! mcp/policy.rs 的单元测试（经 `#[path]` 编回源模块）。

use super::*;
use std::fs;

fn policy(
	auto_execute: bool,
	auto_apply: bool,
	blacklist: &[&str],
) -> McpPolicy {
	McpPolicy {
		auto_execute,
		auto_apply,
		blacklist: blacklist
			.iter()
			.map(|s| s.to_string())
			.collect(),
	}
}

#[test]
fn default_policy_is_conservative() {
	let policy = McpPolicy::default();
	assert!(!policy.auto_execute);
	assert!(!policy.auto_apply);
	assert!(policy.blacklist.is_empty());
	// 全关时任何命令都不自动执行
	assert!(!should_auto_run("ls", true, &policy));
	assert!(!should_auto_run("rm -rf /", false, &policy));
}

#[test]
fn readonly_respects_auto_execute() {
	let on = policy(true, false, &[]);
	assert!(should_auto_run("df -h", true, &on));
	// 读写命令仍不自动执行（auto_apply 关）
	assert!(!should_auto_run("rm -f x", false, &on));
}

#[test]
fn write_respects_auto_apply() {
	let on = policy(false, true, &[]);
	assert!(should_auto_run("rm -f x", false, &on));
	assert!(!should_auto_run("df -h", true, &on));
}

#[test]
fn blacklist_vetoes_even_when_auto_on() {
	let on = policy(true, true, &["rm"]);
	// 即使两个开关都开，黑名单命中也不自动执行
	assert!(!should_auto_run("rm -rf /tmp/x", false, &on));
	assert!(!should_auto_run("sudo rm -f x", false, &on));
	// 非黑名单命令照常自动执行
	assert!(should_auto_run("ls -la", true, &on));
}

#[test]
fn blacklist_matches_compound_commands() {
	let on = policy(true, true, &["rm"]);
	// 复合命令：&& 后面的 rm 也要命中
	assert!(!should_auto_run("cd /tmp && rm -rf x", false, &on));
	// sh -c 里包的 rm 也要命中
	assert!(!should_auto_run("sh -c \"rm -rf /\"", false, &on));
}

#[test]
fn blacklist_skips_sudo_env_prefixes() {
	let on = policy(true, true, &["rm"]);
	assert!(!should_auto_run("sudo rm -f x", false, &on));
	assert!(!should_auto_run("env rm -f x", false, &on));
}

#[test]
fn blacklist_is_case_insensitive() {
	let on = policy(true, true, &["rm"]);
	assert!(!should_auto_run("RM -rf /", false, &on));
}

#[test]
fn is_blacklisted_plain() {
	let list = vec!["rm".to_string(), "kill".to_string()];
	assert!(is_blacklisted("rm -rf /", &list));
	assert!(is_blacklisted("kill -9 123", &list));
	assert!(!is_blacklisted("ls -la", &list));
	assert!(!is_blacklisted("curl example.com", &list));
}

#[test]
fn is_blacklisted_empty_list_never_matches() {
	let list: Vec<String> = vec![];
	assert!(!is_blacklisted("rm -rf /", &list));
}

#[test]
fn load_policy_reads_settings() {
	let dir = std::env::temp_dir().join(format!(
		"tera-mcp-policy-{}",
		std::process::id()
	));
	let _ = fs::remove_dir_all(&dir);
	fs::create_dir_all(&dir).unwrap();
	fs::write(
		dir.join("settings.json"),
		r#"{"mcpAutoExecute":true,"mcpAutoApply":false,"mcpBlacklist":["rm","mkfs"]}"#,
	)
	.unwrap();
	let policy = load_policy(&dir);
	assert!(policy.auto_execute);
	assert!(!policy.auto_apply);
	assert_eq!(policy.blacklist, vec!["rm", "mkfs"]);
	let _ = fs::remove_dir_all(&dir);
}

#[test]
fn load_policy_missing_file_defaults() {
	let dir = std::env::temp_dir().join(format!(
		"tera-mcp-policy-missing-{}",
		std::process::id()
	));
	let _ = fs::remove_dir_all(&dir);
	let policy = load_policy(&dir);
	assert!(!policy.auto_execute);
	assert!(!policy.auto_apply);
	assert!(policy.blacklist.is_empty());
}
