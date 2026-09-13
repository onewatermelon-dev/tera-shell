//! 验证 portable-pty (Windows ConPTY) 在子进程退出后，master 读取是否返回 EOF
//!
//! 本测试默认 ignore: 在Windows ConPTY 上它必然失败（子进程退出后读取永久挂起）
//! 这正是“会话连接断开“检测必须额外监听子进程退出的原因），手动运行
//! 'cargo test --test pty_eof -- --ignore' 可随时复验平台行为

use std::sync::mpsc;
use std::thread;
use std::time::Duration;
use portable_pty::{native_pty_system, PtySize, CommandBuilder};

#[test]
#[ignore = "Windows ConPTY 读取在子进程退出后挂起（已知平台限制，见文件头注释）"]
fn master_read_reaches_eof_after_child_exits() {
	let pty = native_pty_system()
		.openpty(PtySize {
			rows: 30,
			cols: 100,
			pixel_width:0,
			pixel_height: 0,
		})
		.unwrap();
	let mut command = CommandBuilder::new("powershell.exe");
	command.arg("-NoLogo");
	let mut child = pty.slave.spawn_command(command).unwrap();
	drop(pty.slave);
	let mut reader = pty.master.try_clone_reader().unwrap();

	// 让子进程立即退出，然后带超时观察 master read 是否退出
	child.kill().unwrap();
	let _ = child.wait();

	let (tx, rx) = mpsc::channel();
	thread::spawn(move || {
		let mut buf = [0_u8; 64];
		let result = reader.read(&mut buf).map(|n| buf[..n].to_vec());

		let _ = tx.send(result);
	});

	match rx.recv_timeout(Duration::from_secs(5)) {
		Err(_) => panic!(
			"子进程已退出但 5 秒内 master read 未返回（ConPTY 读取挂起，断连检测失效）"
		),
		Ok(Ok(bytes)) if bytes.is_empty() => {
			println!("EOF via Ok(0)")
		}
		Ok(Ok(bytes)) => {
			panic!("读取 {} 字节但未到达 EOF", bytes.len())
		}
		Ok(Err(e)) => {
			panic!("read 返回错误：{e} (非正常 EOF 路径)")
		}
	}
}
