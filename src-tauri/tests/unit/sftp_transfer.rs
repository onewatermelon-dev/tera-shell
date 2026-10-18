//! sftp::transfer 单元测试：同名冲突策略（renamed_target / prepare_target）。
//!
//! 由源文件以 `#[path]` 编回对应模块：单元测试要访问私有项，不能放进
//! cargo 自动发现的集成测试目录根部（tests/*.rs）。

use super::*;

#[test]
fn renamed_target_skips_existing() {
	let target = Path::new("/r/a.txt");
	let taken = |path: &Path| {
		path == Path::new("/r/a.txt")
	};
	assert_eq!(
		renamed_target(target, taken),
		PathBuf::from("/r/a (1).txt")
	);
}

#[test]
fn renamed_target_first_free_wins() {
	let target = Path::new("/r/a.txt");
	let taken = |path: &Path| {
		path == Path::new("/r/a.txt")
			|| path == Path::new("/r/a (1).txt")
	};
	assert_eq!(
		renamed_target(target, taken),
		PathBuf::from("/r/a (2).txt")
	);
}

#[test]
fn prepare_target_decisions() {
	let target = Path::new("/r/a.bin");
	let exists = |_: &Path| true;
	// 目标比源小 → 续传从目标大小处接续
	assert_eq!(
		prepare_target(
			TransferPolicy::Resume,
			target,
			exists,
			|_| Some(100),
			300
		),
		Some((target.to_path_buf(), 100))
	);
	// 目标不比源小 → 无事可做
	assert_eq!(
		prepare_target(
			TransferPolicy::Resume,
			target,
			exists,
			|_| Some(300),
			300
		),
		None
	);
	// 跳过已存在的目标
	assert_eq!(
		prepare_target(
			TransferPolicy::Skip,
			target,
			exists,
			|_| Some(100),
			300
		),
		None
	);
	// 重命名换相邻路径（只有原路径被占用）
	let taken_original = |path: &Path| {
		path == Path::new("/r/a.bin")
	};
	assert_eq!(
		prepare_target(
			TransferPolicy::Rename,
			target,
			taken_original,
			|_| Some(100),
			300
		),
		Some((PathBuf::from("/r/a (1).bin"), 0))
	);
	// 落点不存在：任何策略都正常传输
	assert_eq!(
		prepare_target(
			TransferPolicy::Skip,
			Path::new("/r/new.bin"),
			|_: &Path| false,
			|_| None,
			300
		),
		Some((PathBuf::from("/r/new.bin"), 0))
	);
}
