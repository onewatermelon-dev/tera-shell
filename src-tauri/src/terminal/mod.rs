use portable_pty::{CommandBuilder, MasterPty, PtySize, native_pty_system};
use serde::{Deserialize, Serialize};
use std::{
	collections::HashMap,
	io::Write,
	fs::{File, OpenOptions},
	path::PathBuf,
	sync::{
		Arc, Mutex,
		atomic::{AtomicBool, Ordering},
	},
	thread,
	time::Duration,
};
use tauri::{AppHandle, Emitter, State};
use tauri_plugin_dialog::DialogExt;
use tracing::{debug, error, info, warn};

struct Session {
	log: Arc<Mutex<Log>>,
	writer: Arc<Mutex<Box<dyn Write + Send>>>,
	master: Box<dyn MasterPty + Send>,
	/// 受 Mutex 保护：读取线程用 try_wait 轮询，close 用 kill/wait，二者不会同时持锁
	child: Arc<Mutex<Box<dyn portable_pty::Child + Send + Sync>>>,
	/// 会话被新会话取代（同 id 重复 start）时置位：读取/watch 线程收尾时
	/// 据此静默退出，不再发 terminal-exit —— 否则旧会话的死亡事件会被
	/// 前端算到刚建立的新会话头上，表现为"会话总是断连"。
	exited: Arc<AtomicBool>,
	/// 当前累积但未回车结束的输入字节，用于按行记录命令。
	input_buf: Arc<Mutex<Vec<u8>>>,
	/// reader 线程检测到密码提示时置位；该提示后的输入行只跳过、不记录内容。
	expecting_password: Arc<AtomicBool>,
	/// 当前 PTY 尺寸：resize 收到同尺寸直接跳过 —— ConPTY 对 resize（哪怕
	/// 等尺寸）可能整屏重绘，会抹掉前端画的欢迎横幅。
	size: Mutex<(u16, u16)>,
}

#[derive(Default)]
struct Log {
	file: Option<File>,
	path: Option<PathBuf>,
	paused: bool,
	include_codes: bool,
	escape: u8,
	csi_params: String,
	utf8_tail: Vec<u8>,
	line: Vec<char>,
	cursor: usize,
	alt_screen: bool,
	replaying: bool,
}

/// 按 UTF-8 字符边界解码 PTY 数据，未收齐的字节留给下一块。
fn decode_log_chunk(chunk: &[u8], tail: &mut Vec<u8>) -> String {
	tail.extend_from_slice(chunk);
	let mut text = String::new();
	loop {
		match std::str::from_utf8(tail) {
			Ok(valid) => { text.push_str(valid); tail.clear(); break; },
			Err(error) => {
				let end = error.valid_up_to();
				text.push_str(std::str::from_utf8(&tail[..end]).unwrap_or_default());
				if let Some(len) = error.error_len() {
					text.push('�');
					tail.drain(..end + len);
				} else { tail.drain(..end); break; }
			}
		}
	}
	text
}

/// 按终端光标位置生成纯文本行，避免回车重绘把命令追加两遍。
fn log_text(chunk: &str, log: &mut Log) -> String {
	let mut text = String::new();
	for ch in chunk.chars() {
		match log.escape {
			0 if ch == '\u{1b}' => log.escape = 1,
			0 if log.alt_screen => {},
			0 if ch == '\u{8}' || ch == '\u{7f}' => log.cursor = log.cursor.saturating_sub(1),
			0 if ch == '\r' => log.cursor = 0,
			0 if ch == '\n' => {
				if log.replaying { log.line.clear(); }
				else {
					text.extend(log.line.iter().collect::<String>().trim_end_matches(' ').chars());
					text.push('\n');
					log.line.clear();
				}
				log.cursor = 0;
			},
			0 if !ch.is_control() || ch == '\t' => {
				if log.cursor >= log.line.len() { log.line.resize(log.cursor + 1, ' '); }
				log.line[log.cursor] = ch;
				log.cursor += 1;
			},
			1 => {
				log.escape = if ch == '[' { 2 } else if ch == ']' { 3 } else { 0 };
				if log.escape == 2 { log.csi_params.clear(); }
			},
			2 if ('@'..='~').contains(&ch) => {
				if matches!(log.csi_params.as_str(), "?47" | "?1047" | "?1049") && matches!(ch, 'h' | 'l') {
					if ch == 'h' && !log.line.is_empty() {
						text.extend(log.line.drain(..));
						text.push('\n');
					}
					log.alt_screen = ch == 'h';
					if ch == 'l' { log.replaying = true; }
					log.line.clear();
					log.cursor = 0;
					log.escape = 0;
					continue;
				}
				if log.alt_screen { log.escape = 0; continue; }
				let count = log.csi_params.parse::<usize>().unwrap_or(1).min(1000);
				match ch {
					'C' => log.cursor = (log.cursor + count).min(10000),
					'D' => log.cursor = log.cursor.saturating_sub(count),
					'G' => log.cursor = count.saturating_sub(1),
					'P' => {
						let start = log.cursor.min(log.line.len());
						log.line.drain(start..(start + count).min(log.line.len()));
					},
					'@' => {
						let start = log.cursor.min(log.line.len());
						log.line.splice(start..start, std::iter::repeat_n(' ', count));
					},
					'H' | 'f' => {
						// CSI 行;列 H 用于回到命令起点重绘；日志只需取列坐标。
						let column = log.csi_params.split(';').nth(1).and_then(|value| value.parse::<usize>().ok()).unwrap_or(1);
						log.cursor = column.saturating_sub(1).min(10000);
					},
					'K' if log.csi_params == "2" => { log.line.clear(); log.cursor = 0; },
					'K' => log.line.truncate(log.cursor),
					'X' => {
						for index in log.cursor..(log.cursor + count).min(log.line.len()) { log.line[index] = ' '; }
					},
					_ => {},
				}
				log.escape = 0;
			},
			2 => { if log.csi_params.len() < 16 { log.csi_params.push(ch); } },
			3 if ch == '\u{7}' => log.escape = 0,
			3 if ch == '\u{1b}' => log.escape = 4,
			4 => log.escape = if ch == '\\' { 0 } else { 3 },
			_ => {},
		}
	}
	text
}

#[cfg(test)]
mod log_tests {
	use super::{decode_log_chunk, log_text, Log};

	#[test]
	fn strips_split_ansi_sequences() {
		let mut log = Log::default();
		assert_eq!(log_text("hello\u{1b}[31", &mut log), "");
		assert_eq!(log_text("m世界\u{1b}[0m\r\n", &mut log), "hello世界\n");
		assert_eq!(log_text("NF\u{1b}[16", &mut log), "");
		assert_eq!(log_text("C ntfsinfo\n", &mut log), "NF                 ntfsinfo\n");
		assert_eq!(log_text("root# cat app.rs\rroot# cat app.rs\n", &mut log), "root# cat app.rs\n");
		assert_eq!(log_text("root#\u{1b}[K\u{1b}[1Ccat app.rs \u{1b}[35;7H\u{1b}[Kcat app.rs\n", &mut log), "root# cat app.rs\n");
		assert_eq!(log_text("root# cd /abc/bin\u{1b}[7D\u{1b}[4P\n", &mut log), "root# cd /bin\n");
		assert_eq!(log_text("root# cd /abc\u{8} \u{8}\u{8} \u{8}\u{8} \u{8}\n", &mut log), "root# cd /\n");
		assert_eq!(log_text("root# vim app.rs\u{1b}[?1049h\u{1b}[1;1HVim screen\n", &mut log), "root# vim app.rs\n");
		assert_eq!(log_text("more Vim\u{1b}[?1049lWelcome back\r\nroot# ", &mut log), "");
		assert!(log.replaying);
		log.replaying = false;
		assert_eq!(log_text("ls\r\n", &mut log), "root# ls\n");
	}

	#[test]
	fn decodes_split_chinese_character() {
		let mut tail = Vec::new();
		assert_eq!(decode_log_chunk(&[0xe5, 0x8f], &mut tail), "");
		assert_eq!(decode_log_chunk(&[0x91], &mut tail), "发");
	}
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LogStatus {
	recording: bool,
	paused: bool,
	path: Option<String>,
	include_codes: bool,
}

/// 读取指定终端的日志状态，供右键菜单决定可用项。
#[tauri::command(rename = "terminal_log_status")]
pub fn log_status(id: String, terminals: State<Terminals>) -> Result<LogStatus, String> {
	let sessions = terminals.0.lock().map_err(|_| "终端状态不可用")?;
	let session = sessions.get(&id).ok_or("终端会话不存在")?;
	let log = session.log.lock().map_err(|_| "日志状态不可用")?;
	Ok(LogStatus {
		recording: log.file.is_some(),
		paused: log.paused,
		path: log.path.as_ref().map(|p| p.to_string_lossy().into_owned()),
		include_codes: log.include_codes,
	})
}

/// 选择保存位置并开始记录；取消对话框时保持原状态。
#[tauri::command(rename = "terminal_log_start")]
pub async fn log_start(app: AppHandle, id: String, terminals: State<'_, Terminals>) -> Result<(), String> {
	let picked = tauri::async_runtime::spawn_blocking(move || {
		app.dialog().file().set_file_name("terminal.log").blocking_save_file()
	}).await.map_err(|e| e.to_string())?;
	let Some(picked) = picked else { return Ok(()); };
	let path = PathBuf::from(picked.to_string());
	let mut file = OpenOptions::new().create(true).append(true).open(&path).map_err(|e| e.to_string())?;
	// Windows 记事本等查看器需要 BOM 才能稳定地按 UTF-8 显示中文。
	if file.metadata().map_err(|e| e.to_string())?.len() == 0 {
		file.write_all(b"\xef\xbb\xbf").map_err(|e| e.to_string())?;
	}
	let sessions = terminals.0.lock().map_err(|_| "终端状态不可用")?;
	let session = sessions.get(&id).ok_or("终端会话不存在")?;
	let mut log = session.log.lock().map_err(|_| "日志状态不可用")?;
	log.file = Some(file);
	log.path = Some(path);
	log.paused = false;
	log.escape = 0;
	log.csi_params.clear();
	log.line.clear();
	log.cursor = 0;
	log.alt_screen = false;
	log.replaying = false;
	log.utf8_tail.clear();
	Ok(())
}

/// 停止、暂停、继续或切换终端控制码记录。
#[tauri::command(rename = "terminal_log_action")]
pub fn log_action(id: String, action: String, terminals: State<Terminals>) -> Result<(), String> {
	let sessions = terminals.0.lock().map_err(|_| "终端状态不可用")?;
	let session = sessions.get(&id).ok_or("终端会话不存在")?;
	let mut log = session.log.lock().map_err(|_| "日志状态不可用")?;
	match action.as_str() {
		"stop" => {
			let pending: String = if log.replaying { log.line.clear(); String::new() } else { log.line.drain(..).collect() };
			if let Some(file) = log.file.as_mut() { file.write_all(pending.as_bytes()).map_err(|e| e.to_string())?; }
			log.file = None; log.paused = false; log.cursor = 0;
		},
		"pause" if log.file.is_some() => log.paused = true,
		"resume" if log.file.is_some() => log.paused = false,
		"codes" => { log.include_codes = !log.include_codes; log.utf8_tail.clear(); log.escape = 0; log.csi_params.clear(); log.line.clear(); log.cursor = 0; log.alt_screen = false; log.replaying = false; },
		_ => return Err("日志操作不可用".into()),
	}
	Ok(())
}

#[derive(Default)]
pub struct Terminals(Mutex<HashMap<String, Session>>);

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Config {
	id: String,
	kind: String,
	host: Option<String>,
	port: Option<u16>,
	username: Option<String>,
	/// 已保存的明文密码；由前端解密后传入，用于 SSH 登录时自动应答。
	password: Option<String>,
	/// 前端挂载后实测的终端尺寸：PTY 按最终尺寸出生，避免首帧 resize
	/// 触发 ConPTY 整屏重绘抹掉前端欢迎横幅。缺省退回 30x100。
	rows: Option<u16>,
	cols: Option<u16>,
}

#[derive(Clone, Serialize)]
struct Output {
	id: String,
	data: String,
}

/// 密码提示检测缓冲区保留的尾部字节数：够覆盖 "xxx@host's password:" 这类提示即可。
const PASSWORD_HINT_TAIL: usize = 256;

#[tauri::command(rename = "terminal_start")]
pub fn start(app: AppHandle, config: Config, terminals: State<Terminals>) -> Result<(), String> {
	// 只记录连接目标，密码和终端输入内容一律不进日志。
	if config.kind == "ssh" {
		info!(
            session = %config.id,
            target = %config
                .username
                .as_deref()
                .filter(|v| !v.trim().is_empty())
                .map_or_else(|| config.host.clone().unwrap_or_default(), |u| format!("{u}@{}", config.host.as_deref().unwrap_or_default())),
            port = config.port.unwrap_or(22),
            "SSH 会话启动"
        );
	} else {
		info!(session = %config.id, "本地会话启动");
	}
	let rows = config.rows.unwrap_or(30);
	let cols = config.cols.unwrap_or(100);
	let pty = native_pty_system()
		.openpty(PtySize {
			rows,
			cols,
			pixel_width: 0,
			pixel_height: 0,
		})
		.map_err(|error| error.to_string())?;
	let mut command = command(&config)?;
	if let Some(home) = std::env::var_os(if cfg!(windows) { "USERPROFILE" } else { "HOME" }) {
		command.cwd(home);
	}
	let child = Arc::new(Mutex::new(
		pty.slave
			.spawn_command(command)
			.map_err(|error| error.to_string())?,
	));
	let mut reader = pty
		.master
		.try_clone_reader()
		.map_err(|error| error.to_string())?;
	let writer = pty
		.master
		.take_writer()
		.map_err(|error| error.to_string())?;
	let writer = Arc::new(Mutex::new(writer));
	let id = config.id;
	let password = config.password.clone();
	let input_buf = Arc::new(Mutex::new(Vec::new()));
	let expecting_password = Arc::new(AtomicBool::new(false));
	let exited = Arc::new(AtomicBool::new(false));
	let log = Arc::new(Mutex::new(Log::default()));
	// 同 id 重复 start 时 HashMap.insert 会静默覆盖旧 Session：旧 master 一被
	// drop，旧 ConPTY 关闭、旧子进程退出，旧读取线程随即 EOF 并发出
	// terminal-exit —— 前端把这次退出算到刚建立的新会话头上，表现为
	// "会话总是断连"。因此取代旧会话前先置位其 exited 标记，让旧会话的
	// 两条收尾路径（watch 轮询、读线程 EOF）都静默退出，不再向外发事件。
	if let Some(old) = terminals
		.0
		.lock()
		.map_err(|_| "终端状态不可用")?
		.insert(
			id.clone(),
			Session {
				log: log.clone(),
				writer: writer.clone(),
				master: pty.master,
				child: child.clone(),
				exited: exited.clone(),
				input_buf,
				expecting_password: expecting_password.clone(),
				size: Mutex::new((rows, cols)),
			},
		)
	{
		old.exited.store(true, Ordering::Relaxed);
		let _ = old
			.child
			.lock()
			.unwrap_or_else(|e| e.into_inner())
			.kill();
	}
	// 子进程退出检测：Windows ConPTY 在进程退出后 master read 可能一直挂起而
	// 不返回 EOF (tests/pty_eof.rs 已复现），因此不能只依赖读取 EOF 判定断开，
	// 这里轮询 try_wait: 谁先确认退出谁负责收尾（读取线程到 EOF 时间样收尾）
	let watch_id = id.clone();
	let watch_app = app.clone();
	let watch_exited = exited.clone();
	let watch_child = child.clone();
	thread::spawn(move || loop {
		let finished = {
			let mut child = watch_child
				.lock()
				.unwrap_or_else(|e| e.into_inner());
			child.try_wait().unwrap_or(None).is_some()
		};
		if finished {
			finalize_session(&watch_app, &watch_id, &watch_exited);
			break;
		} 
		thread::sleep(Duration::from_millis(200));
	});
	let read_exited = exited.clone();
	thread::spawn(move || {
		let mut buffer = [0_u8; 8192];
		// 保存的密码自动应答：累积输出尾部，识别 ssh 登录提示后一次性写入密码。
		// 只应答一次；密码错误时 ssh 会再次提示，后续由用户手动输入。
		let mut answer_buf = String::new();
		let mut answered = false;
		let mut warned_password = false;
		while let Ok(size) = std::io::Read::read(&mut reader, &mut buffer) {
			if size == 0 {
				break;
			}
			let chunk = &buffer[..size];
			if let Ok(mut state) = log.lock() {
				if !state.paused {
					let output = if state.include_codes {
						chunk.to_vec()
					} else {
						let data = decode_log_chunk(chunk, &mut state.utf8_tail);
						log_text(&data, &mut state).into_bytes()
					};
					if let Some(file) = state.file.as_mut() {
						if let Err(error) = file.write_all(&output) {
							error!(session = %id, "终端日志写入失败：{error}");
							state.file = None;
						}
					}
				}
			}
			if !answered {
				let lossy = String::from_utf8_lossy(chunk).to_lowercase();
				answer_buf.push_str(&lossy);
				// 只保留尾部若干字节即可覆盖提示串，避免缓冲无限增长。
				// 必须按字符边界切分：提示串里常带用户名/路径（如 C:\Users\中文名），
				// 直接按字节下标切会落在多字节字符中间导致 panic。
				if answer_buf.len() > PASSWORD_HINT_TAIL {
					answer_buf = tail_bytes(&answer_buf, PASSWORD_HINT_TAIL);
				}
				if answer_buf.contains("password:")
					|| answer_buf.contains("password for")
					|| answer_buf.contains("passphrase for")
				{
					// 标记密码提示之后的输入行为密码输入，记录命令时跳过。
					expecting_password.store(true, Ordering::Relaxed);
					if let Some(password) = password.as_ref() {
						if let Ok(mut writer) = writer.lock() {
							let _ = writer.write_all(password.as_bytes());
							let _ = writer.write_all(b"\r");
							let _ = writer.flush();
							answered = true;
							// 自动应答已完成，解除标记，后续命令正常记录。
							expecting_password.store(false, Ordering::Relaxed);
							info!(session = %id, "已自动应答密码提示");
						}
					} else if !warned_password {
						warned_password = true;
						warn!(session = %id, "检测到密码提示但会话未保存密码，等待手动输入");
					}
				}
			}
			if let Err(error) = app.emit(
				"terminal-output",
				Output {
					id: id.clone(),
					data: String::from_utf8_lossy(chunk).into_owned(),
				},
			) {
				error!(session = %id, "终端输出事件发送失败：{error}");
			}
		}
		debug!(session = %id, "终端输出线程退出");
		finalize_session(&app,&id,&read_exited)
	});
	Ok(())
}

/// 会话断开收尾：打印日志并通知前端（红点、停止光标闪烁、[会话已结束] 提示
/// 读取线程 EOF 与子进程退出检查线程都可能触发，用 exited 标记保证只处理一次
fn finalize_session(app: &AppHandle, id: &str, exited: &AtomicBool) {
	if exited.swap(true, Ordering::Relaxed) {
		return;
	}
	info!(session = %id,"会话连接断开");
	if let Err(error) = app.emit("terminal-exit", id) {
		error!(session = %id,"终端退出事件发送失败：{error}");
	}
}

fn command(config: &Config) -> Result<CommandBuilder, String> {
	if config.kind != "ssh" {
		return Ok(if cfg!(windows) {
			let mut command = CommandBuilder::new("powershell.exe");
			command.arg("-NoLogo");
			command
		} else {
			CommandBuilder::new(std::env::var("SHELL").unwrap_or_else(|_| "/bin/sh".into()))
		});
	}
	let host = config
		.host
		.as_ref()
		.filter(|value| !value.trim().is_empty())
		.ok_or("请输入主机地址")?;
	let target = config
		.username
		.as_ref()
		.filter(|value| !value.trim().is_empty())
		.map_or_else(|| host.clone(), |username| format!("{username}@{host}"));
	let mut command = CommandBuilder::new("ssh");
	// ssh 向远端申请 PTY 时 TERM 取自本机环境变量，ConPTY 环境里没有
	// 这个变量 → 远端拿到 dumb → ls --color、彩色提示符全部自动关闭，
	// 终端里只剩白字。显式声明 256 色，前端 xterm 按配色方案渲染
	command.env("TERM", "xterm-256color");
	command.args([
		"-tt",
		"-o",
		"StrictHostKeyChecking=accept-new",
		"-p",
		&config.port.unwrap_or(22).to_string(),
		&target,
	]);
	Ok(command)
}

#[tauri::command(rename = "terminal_write")]
pub fn write(
	id: String,
	data: String,
	command: Option<String>,
	terminals: State<Terminals>,
) -> Result<(), String> {
	let mut sessions = terminals.0.lock().map_err(|_| "终端状态不可用")?;
	let session = sessions.get_mut(&id).ok_or("终端会话不存在")?;
	if let Ok(mut log) = session.log.lock() {
		// ponytail: 以首次用户输入作为重绘结束边界；若输入与迟到的重绘同一时刻交错，需改为完整屏幕状态追踪。
		if log.replaying && !log.alt_screen { log.replaying = false; }
	}
	record_input(&id, session, &data, command.as_deref());
	let mut writer = session.writer.lock().map_err(|_| "终端写入通道不可用")?;
	writer
		.write_all(data.as_bytes())
		.map_err(|error| error.to_string())?;
	writer.flush().map_err(|error| error.to_string())
}

/// 归一化行内编辑键：Tab 补全留下的制表符变单个字符，退格（DEL）回删前一字符
pub fn normalize_command_line(text: &str) -> String {
	text.chars().fold(String::new(), |mut acc, c| {
		match c {
			'\t' => acc.push(' '),
			'\x7f' => {
				acc.pop();
			}
			_ => acc.push(c),
		}
		acc
	})
}

/// 从第一次回车里得出要记录的文本：优先前端抓到的完整命令行
/// （含 Tab 补全展开），否则用输入流重建（剥 ANSI，去边缘空白，归一化编辑键
pub fn resolve_command_line(command: Option<&str>, raw: &str) -> String {
	match command.filter(|c| !c.trim().is_empty()) {
		Some(text) => normalize_command_line(text.trim()),
		None => normalize_command_line(
			&strip_ansi(raw).trim_matches(|c: char| c.is_whitespace() || c.is_control()),
		),
	}
}
/// 按回车切分终端输入并按行记录命令；密码提示后的输入行只记一条"跳过"。
///
/// 回车时前端会连同缓存区内的完整命令行（含 Tab 补全展开）一并送来，
/// 优先使用它：否则用输入流重建,输入缓冲过长（如全屏应用刷新）时放弃积累
fn record_input(id: &str, session: &mut Session, data: &str, command: Option<&str>) {
	let mut buf = match session.input_buf.lock() {
		Ok(buf) => buf,
		Err(_) => return,
	};
	buf.extend_from_slice(data.as_bytes());
	if buf.len() > 4096 {
		buf.clear();
		return;
	}
	while let Some(pos) = buf.iter().position(|&b| b == b'\r' || b == b'\n') {
		let line: Vec<u8> = buf.drain(..=pos).collect();
		// 先剥掉 ANSI 转义序列（方向键/F 键残留），再去行首行尾空白与控制字符。
		// 最后归一化行内编辑键（Tab/退格），日志才接近实际执行单独命令
		let text = resolve_command_line(command, &String::from_utf8_lossy(&line));
		if text.is_empty() {
			continue;
		}
		// 密码提示后的首个输入行按密码处理：只记跳过，不落内容。
		if session.expecting_password.swap(false, Ordering::Relaxed) {
			info!(session = %id, "检测到密码输入，已跳过记录");
		} else {
			info!(session = %id, command = %text, "终端命令");
		}
	}
}

#[tauri::command(rename = "terminal_resize")]
pub fn resize(id: String, rows: u16, cols: u16, terminals: State<Terminals>) -> Result<(), String> {
	debug!(session = %id, rows, cols, "终端缩放");
	let mut terminals = terminals
		.0
		.lock()
		.map_err(|_| "终端状态不可用")?;
	let session = terminals
		.get_mut(&id)
		.ok_or("终端会话不存在")?;
	// 同尺寸直接跳过：ConPTY 对 resize（哪怕等尺寸）可能整屏重绘，
	// 会抹掉前端画的欢迎横幅
	if *session.size.lock().map_err(|_| "尺寸状态不可用")? == (rows, cols) {
		return Ok(());
	}
	session.master.resize(PtySize {
		rows,
		cols,
		pixel_width: 0,
		pixel_height: 0,
	})
	.map_err(|error| error.to_string())?;
	*session.size.lock().map_err(|_| "尺寸状态不可用")? = (rows, cols);
	Ok(())
}

#[tauri::command(rename = "terminal_close")]
pub fn close(id: String, terminals: State<Terminals>) -> Result<(), String> {
	info!(session = %id, "终端会话关闭");
	match terminals
		.0
		.lock()
		.map_err(|_| "终端状态不可用")?
		.remove(&id)
	{
		Some(session) => {
			let mut child = session
				.child
				.lock()
				.unwrap_or_else(|e| e.into_inner());
			child
				.kill()
				.map_err(|error| error.to_string())?;
			let _ = child.wait();
		}
		// 会话已自然退出（如用户手动 exit）时前端仍会调 close，属正常路径。
		None => debug!(session = %id, "关闭不存在的会话（可能已退出）"),
	}
	Ok(())
}

/// 取字符串尾部至多 `max_bytes` 字节。
///
/// 起点会向后对齐到字符边界（多字节字符可能被让出），保证结果是合法 UTF-8
/// 片段；因此实际返回长度可能略小于 `max_bytes`，但绝不会切在多字节字符中间。
pub fn tail_bytes(text: &str, max_bytes: usize) -> String {
	if text.len() <= max_bytes {
		return text.to_string();
	}
	let mut start = text.len() - max_bytes;
	while !text.is_char_boundary(start) {
		start += 1;
	}
	text[start..].to_string()
}

/// 去除 ANSI 转义序列（CSI/OSC/SS3 等），返回只含可见字符的文本。
pub fn strip_ansi(input: &str) -> String {
	let mut out = String::with_capacity(input.len());
	let mut rest = input;
	while let Some(pos) = rest.find('\x1b') {
		out.push_str(&rest[..pos]);
		rest = skip_escape(&rest[pos..]);
	}
	out.push_str(rest);
	out
}

/// 输入必须以 ESC 开头；跳过整个控制序列，返回其后内容。
fn skip_escape(seq: &str) -> &str {
	let tail = &seq[1..];
	if let Some(csi) = tail.strip_prefix('[') {
		// CSI：ESC [ 参数区(0x30-0x3f) 终结字节(0x40-0x7e)
		// 参数区只认数字、`;`、`?` 等 0x30-0x3f 字节；紧随其后若不是终结字节，
		// 说明这是残留的半截序列（如 ConPTY 输出的 `ESC [0` 后跟空格与命令行），
		// 就此截断。若按 0x40-0x7e 一路找下去，会把后面命令的首字母当成
		// 终结字节一并吃掉（`cat` 变成 `at`）。
		let bytes = csi.as_bytes();
		let mut i = 0;
		while i < bytes.len() && (0x30..=0x3f).contains(&bytes[i]) {
			i += 1;
		}
		if i < bytes.len() && (0x40..=0x7e).contains(&bytes[i]) {
			i += 1; // 终结字节
		}
		&csi[i..]
	} else if let Some(osc) = tail.strip_prefix(']') {
		// OSC：ESC ] ... 以 BEL(0x07) 或 ESC \ 结束
		let bytes = osc.as_bytes();
		let mut i = 0;
		while i < bytes.len() {
			match bytes[i] {
				0x07 => {
					i += 1;
					break;
				}
				0x1b if bytes.get(i + 1) == Some(&b'\\') => {
					i += 2;
					break;
				}
				_ => i += 1,
			}
		}
		&osc[i..]
	} else if let Some(first) = tail.chars().next() {
		// SS3 / 单字符序列（如 ESC O A）：跳过首字符与终结字节。
		let bytes = tail.as_bytes();
		let mut i = first.len_utf8();
		while i < bytes.len() && !(0x40..=0x7e).contains(&bytes[i]) {
			i += 1;
		}
		if i < bytes.len() {
			i += 1;
		}
		&tail[i..]
	} else {
		tail
	}
}
