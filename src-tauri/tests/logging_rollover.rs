use std::io::Write as _;
use std::fs;
use tracing_subscriber::fmt::MakeWriter as _;
use tera_shell_lib::logging::{today, RotatingWriter};

#[test]
fn rolls_over_when_file_full() {
	let base = std::env::temp_dir().join(format!(
		"tera-shell-log-test-{}-{}",
		std::process::id(),
		std::time::SystemTime::now()
			.duration_since(std::time::UNIX_EPOCH)
			.unwrap()
			.as_nanos()
	));
	let writer = RotatingWriter::new(base.clone());
	// 模拟 10001 条日志事件：每条事件取一次 writer，写完即丢弃。
	for _ in 0..10_001 {
		let mut event = writer.make_writer();
		event.write_all(b"event\n").unwrap();
		event.flush().unwrap();
	}
	drop(writer);

	let dir = base.join(today());
	let mut counts: Vec<u64> = fs::read_dir(&dir)
		.unwrap()
		.map(|entry| {
			let path = entry.unwrap().path();
			fs::read_to_string(&path).unwrap().lines().count() as u64
		})
		.collect();
	// 9999 条写满后应滚动出第二个文件；两个文件按创建先后为 9999 / 2 条。
	counts.sort_unstable();
	assert_eq!(counts.len(), 2, "写满 9999 条后应新建日志文件：{counts:?}");
	assert_eq!(counts, vec![2, 9999], "滚动后新文件从 0 重新计数：{counts:?}");

	fs::remove_dir_all(&base).unwrap();
}
