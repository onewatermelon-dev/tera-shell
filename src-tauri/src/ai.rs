//! AI 面板的命令执行通道。
//!
//! 终端是用户正在敲字的 PTY（系统 ssh 进程）：AI 的命令若写进去会污染
//! 屏幕、命令历史和进行中的任务。这里走 ssh2 的 **exec 通道**独立执行 ——
//! 输出直接返回给前端，不经过终端、不进服务器命令历史。
//!
//! 连接按目标缓存复用（`username@host:port` → 已认证的 `Session`），
//! 同一台服务器上的 AI 命令在会话锁上天然串行；被服务器掐断的空闲连接
//! 由执行失败后的「丢弃重连一次再试」兜底。

use serde::{Deserialize, Serialize};
use ssh2::Session;
use std::{
	time::{Duration, Instant},
	collections::HashMap,
	io::{self, Read},
	sync::{
		Arc, Mutex,
		atomic::{AtomicBool, Ordering},
	},
};
use tauri::State;
use tokio::sync::oneshot;
use tracing::{info, warn};
use uuid::Uuid;

use crate::ssh::{JumpHop, SshTarget, establish_session};

/// 单条 AI 命令的超时：诊断类命令几秒内结束，长命令以 60 秒为限。
/// ponytail: 超时后通道作废（连接随之丢弃重连），不支持长时间驻留任务。
const EXEC_TIMEOUT_MS: u32 = 60_000;

/// 读循环的轮询粒度：取消标志只在每轮读取之间检查，而读调用本身是
/// 阻塞的 —— 把读超时压到 1 秒，「停止」指令才能至多 1 秒内生效。
const CANCEL_POLL_MS: u32 = 1_000;

/// exec 会话池：key 为 `username@host:port`。
///
/// ssh2 的 `Session` 不可克隆，池里存的是互斥锁包住的会话本体 ——
/// 同一台服务器上的命令在锁上排队，恰好符合"逐条执行"的语义。
#[derive(Default)]
pub struct ExecPool {
	sessions:
		Arc<Mutex<HashMap<String, Arc<Mutex<Session>>>>>,
	/// 进行中的命令取消标志：`exec_id` → 标志位。
	///
	/// 前端点「停止」时调 `ai_exec_cancel` 置位；run_once 的读循环
	/// 每轮检查它，置位即关通道返回。没有它的话，前端停了界面，
	/// 后端还在 read_to_end 上堵到命令结束或超时 —— 用户看到的就是
	/// 「点了暂停，命令还在执行中」。
	cancels:
		Arc<Mutex<HashMap<String, Arc<AtomicBool>>>>,
}

impl ExecPool {
	/// 登记一条命令，返回它的取消标志；调用方负责在结束时摘除。
	fn register(&self, exec_id: &str) -> Arc<AtomicBool> {
		let flag = Arc::new(AtomicBool::new(false));
		self.cancels
			.lock()
			.unwrap_or_else(|error| error.into_inner())
			.insert(exec_id.to_string(), flag.clone());
		flag
	}

	fn unregister(&self, exec_id: &str) {
		self.cancels
			.lock()
			.unwrap_or_else(|error| error.into_inner())
			.remove(exec_id);
	}

	/// 置取消标志。返回是否命中（未命中 = 命令已结束或 id 不对）。
	pub fn cancel(&self, exec_id: &str) -> bool {
		let map = self
			.cancels
			.lock()
			.unwrap_or_else(|error| error.into_inner());
		match map.get(exec_id) {
			Some(flag) => {
				flag.store(true, Ordering::Relaxed);
				info!(
					exec_id = %exec_id,
					"已请求中断 AI 命令"
				);
				true
			}
			None => {
				warn!(
					exec_id = %exec_id,
					"中断请求未命中（命令已结束）"
				);
				false
			}
		}
	}
}

/// AI 命令的执行目标与命令本身。
///
/// 密码由前端用后端 `decrypt` 解开后明文传入，只在内存中使用，不写日志。
/// `jump` 是前端解析好的跳板链（离客户端最近的一跳在前），`key_path`
/// 是设置里的默认私钥 —— 与终端 `ssh -J` / `-i` 的行为对齐。
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExecTarget {
	host: String,
	port: Option<u16>,
	username: Option<String>,
	password: Option<String>,
	#[serde(default)]
	jump: Vec<JumpHop>,
	#[serde(default)]
	key_path: Option<String>,
	/// 要执行的命令，在远端登录 shell 下运行（等价 `shell -c "命令"`）。
	command: String,
	/// 可选：喂给命令 stdin 的内容（exec 通道数据流，不受 channel request
	/// 的 ~16KB 包上限约束）。用于把大段文本（如 cat 高亮结果）注入
	/// `cat > /dev/pts/N`，不占用命令字符串。
	stdin: Option<String>,
	/// 前端生成的执行 id：「停止」时靠它定位这条命令。缺省由内部补一个，
	/// 只是前端取消不了。
	exec_id: Option<String>,
}

/// 一次命令执行的产物。
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExecOutcome {
	stdout: String,
	stderr: String,
	/// 退出码；通道异常拿不到时为 -1。
	exit_code: i32,
}

/// 执行失败的原因。区分「可重试」（连接失效）与「已取消」（用户点了
/// 停止）—— 后者重试只会把用户刚停掉的命令再跑一遍。
enum ExecError {
	Failed(String),
	Cancelled,
}

impl ExecError {
	fn message(self) -> String {
		match self {
			ExecError::Failed(message) => message,
			ExecError::Cancelled => {
				"[已取消] 用户中断了命令执行".to_string()
			}
		}
	}
}

impl std::fmt::Display for ExecError {
	fn fmt(
		&self,
		f: &mut std::fmt::Formatter<'_>,
	) -> std::fmt::Result {
		match self {
			ExecError::Failed(message) => {
				f.write_str(message)
			}
			ExecError::Cancelled => f.write_str("已取消"),
		}
	}
}

/// 通过独立 exec 通道在目标服务器上执行一条命令。
///
/// ssh2 是阻塞实现，放到 blocking 线程里执行，避免卡住 IPC 线程。
/// `exec_id` 登记取消标志，命令结束（或取消）时摘除 —— 前端「停止」
/// 经 `ai_exec_cancel` 置位，读循环据此关通道。
#[tauri::command(rename = "ai_run_command")]
pub async fn run_command(
	pool: State<'_, ExecPool>,
	target: ExecTarget,
) -> Result<ExecOutcome, String> {
	let sessions = pool.sessions.clone();
	// 没带 id 也补一个：取消表按 id 索引，空 id 会让多条命令共用一个标志位
	let exec_id = target
		.exec_id
		.clone()
		.filter(|value| !value.trim().is_empty())
		.unwrap_or_else(|| format!("exec-{}", Uuid::new_v4()));
	let flag = pool.register(&exec_id);
	let joined = tauri::async_runtime::spawn_blocking(
		move || execute(&sessions, &flag, target),
	)
	.await;
	// 无论成败都摘除：join 出错（任务 panic）时也不能把标志留在表里，
	// 否则下次同 id 的取消会误命中
	pool.unregister(&exec_id);
	let outcome =
		joined.map_err(|error| error.to_string())?;
	outcome.map_err(|error| error.message())
}

/// 中断一条进行中的 AI 命令（前端「停止」按钮）。
///
/// 只置取消标志：真正停下来在 run_once 的读循环里（关 exec 通道，
/// sshd 随即给命令进程组发 SIGHUP）。返回是否命中。
#[tauri::command(rename = "ai_exec_cancel")]
pub fn exec_cancel(
	pool: State<'_, ExecPool>,
	exec_id: String,
) -> Result<bool, String> {
	Ok(pool.cancel(&exec_id))
}

/// 取池中会话执行命令；失败视为连接失效，丢弃后重连一次再试。
/// 用户取消不重试。
fn execute(
	sessions: &Arc<Mutex<HashMap<String, Arc<Mutex<Session>>>>>,
	cancel: &Arc<AtomicBool>,
	target: ExecTarget,
) -> Result<ExecOutcome, ExecError> {
	// 归一化、跳板链与私钥统一收口在 SshTarget（与 SFTP 共用）；
	// 连接池 key 也由它生成，直连 / 跳板 / 不同私钥不会互相命中
	let ssh = SshTarget::new(
		&target.host,
		target.port,
		target.username.as_deref(),
		target.password.as_deref(),
		target.key_path.as_deref(),
		target.jump.clone(),
	)
	.map_err(ExecError::Failed)?;
	let command = target.command;
	if command.trim().is_empty() {
		return Err(ExecError::Failed("命令为空".into()));
	}
	// 只记目标与命令文本，密码绝不进日志
	info!(
		target = %ssh.describe(),
		jumps = ssh.jump.len(),
		command = %command,
		"AI 命令执行请求"
	);
	let key = ssh.key();

	let session = obtain(sessions, &ssh)
		.map_err(ExecError::Failed)?;
	match run_once(
		&session,
		&command,
		target.stdin.as_deref(),
		cancel,
	) {
		Ok(outcome) => {
			info!(
				key = %key,
				exit = outcome.exit_code,
				"AI 命令执行完成"
			);
			Ok(outcome)
		}
		// 取消是用户意图，原路返回不重试
		Err(ExecError::Cancelled) => {
			info!(key = %key, "AI 命令被用户中断");
			Err(ExecError::Cancelled)
		}
		Err(error) => {
			warn!(
				key = %key,
				"AI 命令执行失败，重连后重试：{error}"
			);
			sessions
				.lock()
				.unwrap_or_else(|error| error.into_inner())
				.remove(&key);
			// 连接被服务器掐断：丢弃后重连一次（跳板链会整条重建）
			let session = obtain(sessions, &ssh)
				.map_err(ExecError::Failed)?;
			run_once(
				&session,
				&command,
				target.stdin.as_deref(),
				cancel,
			)
		}
	}
}

/// 取缓存会话；没有缓存时新建并登记。
fn obtain(
	sessions: &Arc<Mutex<HashMap<String, Arc<Mutex<Session>>>>>,
	target: &SshTarget,
) -> Result<Arc<Mutex<Session>>, String> {
	let key = target.key();
	if let Some(session) = sessions
		.lock()
		.unwrap_or_else(|error| error.into_inner())
		.get(&key)
		.cloned()
	{
		info!(%key, "复用缓存的 AI exec 连接");
		return Ok(session);
	}
	info!(%key, "新建 AI exec 连接");
	let session = Arc::new(Mutex::new(establish_session(
		target,
	)?));
	sessions
		.lock()
		.unwrap_or_else(|error| error.into_inner())
		.entry(key)
		.or_insert(session.clone());
	Ok(session)
}

/// 在一条会话上开 exec 通道执行命令并收集输出。
///
/// 整个过程占住会话锁：同服务器的下一条命令在锁上排队，输出不会交错。
/// `cancel` 置位时立刻关通道返回（见 `ExecPool::cancel`）。
fn run_once(
	session: &Arc<Mutex<Session>>,
	command: &str,
	stdin: Option<&str>,
	cancel: &Arc<AtomicBool>,
) -> Result<ExecOutcome, ExecError> {
	// 开通道前就查一次：命令可能还没下发就被取消
	if cancel.load(Ordering::Relaxed) {
		return Err(ExecError::Cancelled);
	}
	let session = session
		.lock()
		.unwrap_or_else(|error| error.into_inner());
	session.set_timeout(EXEC_TIMEOUT_MS);
	let mut channel = session
		.channel_session()
		.map_err(|error| {
			ExecError::Failed(format!(
				"打开 exec 通道失败：{error}"
			))
		})?;
	channel.exec(command).map_err(|error| {
		ExecError::Failed(format!("下发命令失败：{error}"))
	})?;
	// stdin 内容随数据流分包发送，写完即 EOF（否则命令会挂等输入）
	if let Some(text) = stdin {
		use std::io::Write;
		channel
			.write_all(text.as_bytes())
			.map_err(|error| {
				ExecError::Failed(format!(
					"写入 stdin 失败：{error}"
				))
			})?;
	}
	// 无论是否喂了 stdin 都要发 EOF：否则 stdin 永远开着，等待输入的
	// 交互式命令（rm -i 的 y/n 确认、apt 安装确认等）会一直挂到超时，
	// 卡片长时间停在「执行中」。EOF 让它们立即读到输入结束并退出
	channel.send_eof().map_err(|error| {
		ExecError::Failed(format!(
			"关闭 stdin 失败：{error}"
		))
	})?;

	// stdout 分块读到 EOF。与 read_to_end 的差别只有两点，且都为
	// 「可取消」服务，不取消时行为与原来完全一致：
	// ① 每轮先查取消标志，置位即关通道返回 —— 停止至多 1 秒生效；
	// ② 读超时压到 1 秒轮询，静默超过 EXEC_TIMEOUT_MS 才算超时 ——
	//    等价于原来「每次读各自 60 秒」：有输出就续命，彻底没输出
	//    60 秒才失败。
	session.set_timeout(CANCEL_POLL_MS);
	let mut stdout = Vec::new();
	let mut buf = [0u8; 8192];
	let mut last_output = Instant::now();
	loop {
		if cancel.load(Ordering::Relaxed) {
			// 关通道：sshd 收到 CHANNEL_CLOSE 会给 exec 命令的进程组
			// 发 SIGHUP，多数命令随即死亡
			let _ = channel.close();
			return Err(ExecError::Cancelled);
		}
		if last_output.elapsed()
			>= Duration::from_millis(
				EXEC_TIMEOUT_MS as u64
			) {
			return Err(ExecError::Failed(
				"读取输出失败：命令超时".to_string()
			));
		}
		match channel.read(&mut buf) {
			Ok(0) => break,
			Ok(bytes) => {
				stdout.extend_from_slice(&buf[..bytes]);
				last_output = Instant::now();
			}
			// 1 秒轮询窗口到了：没数据不算错，回去查取消 / 截止
			Err(ref error)
				if error.kind()
					== io::ErrorKind::TimedOut =>
			{
				continue;
			}
			Err(ref error)
				if error.kind()
					== io::ErrorKind::Interrupted =>
			{
				continue;
			}
			Err(error) => {
				return Err(ExecError::Failed(
					format!("读取输出失败：{error}")
				));
			}
		}
	}
	// stderr 是独立流，在其后读取；stdout 已 EOF，这两步本该立即返回，
	// 恢复全超时以防慢网络误伤
	session.set_timeout(EXEC_TIMEOUT_MS);
	let mut stderr = Vec::new();
	channel
		.stderr()
		.read_to_end(&mut stderr)
		.map_err(|error| {
			ExecError::Failed(format!(
				"读取错误输出失败：{error}"
			))
		})?;
	channel.wait_eof().map_err(|error| {
		ExecError::Failed(format!(
			"等待命令结束失败：{error}"
		))
	})?;
	let _ = channel.wait_close();
	let exit_code = channel.exit_status().unwrap_or(-1);

	Ok(ExecOutcome {
		stdout: String::from_utf8_lossy(&stdout)
			.into_owned(),
		stderr: String::from_utf8_lossy(&stderr)
			.into_owned(),
		exit_code,
	})
}

// ---- AI 聊天的流式桥接 ----
//
// 模型网关普遍不带 CORS 头，前端 fetch 发不了；流式请求也必须走 Rust。
// 这里不做任何格式解析（三种 API 格式的 delta 结构不同，全部由前端处理），
// 只把 SSE 的 `data:` 行原样广播给前端，前端按供应商格式自行累积。

use futures::StreamExt;
use tauri::Emitter;

/// 流式事件：前端按 stream_id 对号，data 是一条原始 SSE 载荷（已剥掉
/// `data:` 前缀），done=true 表示流结束。
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct StreamEvent<'a> {
	stream_id: &'a str,
	#[serde(skip_serializing_if = "Option::is_none")]
	data: Option<&'a str>,
	done: bool,
}

/// 进行中的流式请求表：`stream_id` → 取消信号发送端。
///
/// 前端点「停止」时调 `ai_chat_cancel` 把对应的那条流掐掉。没有这张表的话，
/// 界面上的生成会停，但 reqwest 仍在向模型网关拉数据 —— 既白烧 token，
/// 又让后端直到流结束才释放连接。
#[derive(Default)]
pub struct AiStreams {
	cancels:
		Arc<Mutex<HashMap<String, oneshot::Sender<()>>>>,
}

impl AiStreams {
	/// 登记一条流，返回接收端；流结束（或被取消）时前端会把它移除。
	fn register(
		&self,
		stream_id: &str,
	) -> oneshot::Receiver<()> {
		let (tx, rx) = oneshot::channel();
		self.cancels
			.lock()
			.unwrap()
			.insert(stream_id.to_string(), tx);
		rx
	}

	fn unregister(&self, stream_id: &str) {
		self.cancels.lock().unwrap().remove(stream_id);
	}

	/// 掐掉一条流。返回是否真的命中（未命中 = 已结束或 id 不对）。
	pub fn cancel(&self, stream_id: &str) -> bool {
		let mut map = self.cancels.lock().unwrap();
		match map.remove(stream_id) {
			Some(tx) => {
				// 接收端已被 drop 时发送会失败，但那时流已经结束了，
				// 不算错误
				let _ = tx.send(());
				info!(
					stream_id = %stream_id,
					"已请求中断 AI 流"
				);
				true
			}
			None => {
				warn!(
					stream_id = %stream_id,
					"中断请求未命中（流已结束）"
				);
				false
			}
		}
	}
}

/// 掐断一条进行中的 AI 流（前端「停止生成」按钮）。
#[tauri::command(rename = "ai_chat_cancel")]
pub fn chat_cancel(
	streams: State<'_, AiStreams>,
	stream_id: String,
) -> Result<bool, String> {
	Ok(streams.cancel(&stream_id))
}

/// 发起一次流式对话补全：请求体由前端按供应商格式构造好（含 stream:true），
/// SSE 载荷逐条经 `ai-chat-stream` 事件广播，命令在流结束后返回。
#[tauri::command(rename = "ai_chat_stream")]
pub async fn chat_stream(
	app: tauri::AppHandle,
	streams: State<'_, AiStreams>,
	stream_id: String,
	url: String,
	headers: HashMap<String, String>,
	body: serde_json::Value,
) -> Result<(), String> {
	// 不设总超时：长回答的流可能持续几分钟，中断由前端按 Esc / 错误处理。
	// 连接超时仍由 client_for 统一给 15 秒
	let client = crate::infra::proxy::client_for(&app, None)?;
	let mut request = client.post(&url).json(&body);
	for (name, value) in &headers {
		request = request.header(name.as_str(), value.as_str());
	}
	let response = request
		.send()
		.await
		.map_err(|error| format!("连接模型失败：{error}"))?;
	let status = response.status();
	if !status.is_success() {
		let text = response.text().await.unwrap_or_default();
		let snippet: String = text.chars().take(300).collect();
		return Err(format!("HTTP {}: {}", status.as_u16(), snippet));
	}

	// 登记取消通道：`cancel_rx` 有值 = 用户点了停止。
	// 用它 select 住 `stream.next()`，取消时立刻跳出循环并释放连接。
	let mut cancel_rx = streams.register(&stream_id);
	let mut stream = response.bytes_stream();
	// SSE 跨 chunk 的缓冲：按行切，残行留到下一个 chunk
	let mut buffer: Vec<u8> = Vec::new();
	let emit = |stream_id: &str, data: &str, done: bool| {
		let _ = app.emit(
			"ai-chat-stream",
			StreamEvent {
				stream_id,
				data: Some(data),
				done,
			},
		);
	};

	// 逐块读取 SSE。每轮都 select 一下取消信号：用户点「停止」时立刻
	// 跳出循环，连接随之释放，不会继续向网关拉数据。
	let mut cancelled = false;
	loop {
		let next = tokio::select! {
			signal = &mut cancel_rx => {
				// 发送端被 drop（= 前端窗口关了/组件卸载）也算取消
				let _ = signal;
				cancelled = true;
				break;
			}
			chunk = stream.next() => chunk,
		};
		let Some(chunk) = next else {
			break;
		};
		let bytes = match chunk {
			Ok(bytes) => bytes,
			Err(error) => {
				streams.unregister(&stream_id);
				return Err(error.to_string());
			}
		};
		buffer.extend_from_slice(&bytes);
		// 按换行切分；兼容 \r\n
		while let Some(pos) =
			buffer.iter().position(|&b| b == b'\n')
		{
			let line =
				String::from_utf8_lossy(&buffer[..pos])
					.trim_end()
					.to_string();
			buffer.drain(..=pos);
			if let Some(payload) =
				line.strip_prefix("data:")
			{
				let payload = payload.trim_start();
				if payload.is_empty() {
					continue;
				}
				emit(&stream_id, payload, false);
			}
		}
	}
	streams.unregister(&stream_id);
	if cancelled {
		info!(
			stream_id = %stream_id,
			"AI 流提前结束（已取消）"
		);
		// 取消时不补发buffer 里的残行：那是半条 SSE，
		// 累积器解不出结构，白送一次解析异常
		//
		// 但**仍要广播 done**：取消也是一种结束，前端
		// streamChatCompletion 里的 donePromise 否则会一直等到
		// 1.5s 兜底超时才返回，白等一趟
		emit(&stream_id, "", true);
		return Ok(());
	}
	if let Ok(line) = String::from_utf8(buffer.clone()) {
		if let Some(payload) = line.strip_prefix("data:") {
			let payload = payload.trim_start();
			if !payload.is_empty() {
				emit(&stream_id, payload, false);
			}
		}
	}
	info!(stream_id = %stream_id, "AI 聊天流结束");
	emit(&stream_id, "", true);
	Ok(())
}
