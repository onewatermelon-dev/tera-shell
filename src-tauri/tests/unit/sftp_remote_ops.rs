//! sftp::remote_ops 单元测试：df / du 输出解析。
//!
//! 由源文件以 `#[path]` 编回对应模块：单元测试要访问私有项，不能放进
//! cargo 自动发现的集成测试目录根部（tests/*.rs）。

use super::*;

#[test]
fn parse_df_reads_last_data_line() {
	let output = "Filesystem 1024-blocks Used Available Capacity Mounted on\n\
	              /dev/sda1 1000 400 600 40% /\n";
	assert_eq!(parse_df(output), Some((1000 * 1024, 600 * 1024)));
}

#[test]
fn parse_df_mount_with_spaces() {
	// 挂载点带空格：取的是前几列，不受影响
	let output = "/dev/sda1 2048 1024 1024 50% /mnt/my data\n";
	assert_eq!(parse_df(output), Some((2048 * 1024, 1024 * 1024)));
}

#[test]
fn parse_df_garbage_returns_none() {
	assert_eq!(parse_df("df: invalid option"), None);
	assert_eq!(parse_df(""), None);
}

#[test]
fn parse_du_reads_block_count() {
	assert_eq!(parse_du("1234\t/var/log\n"), Some(1234 * 1024));
	assert_eq!(parse_du("du: cannot access"), None);
}
