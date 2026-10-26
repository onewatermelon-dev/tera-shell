//! 临时端口隧道：「网络抽屉 → 在本地打开」的支撑。
//!
//! 每次开一条隐藏的 `ssh -N -L` 进程（portable-pty 产 PTY，密码提示
//! 自动应答），不接前端终端 —— 它不是会话，只是条转发管道。生命周期：
//! 手动关闭，或 ssh 进程退出（远端拒绝 / 密码错 / 断网）时自动移除。
//!
//! 复用 `command()` 拼连接参数（`tunnel_mode: true` 时去 `-tt` 加 `-N`、
//! 由 forwards 带上 `-L`），认证、跳板、私钥与交互会话同源。

use std::{
	collections::HashMap,
	io::Write,
	net::TcpListener,
	sync::{
		Arc, Mutex,
		atomic::{AtomicBool, Ordering}
	},
	time::{SystemTime, UNIX_EPOCH}
};

use portable_pty::{native_pty_system, PtySize};
use serde::Serialize;
use tauri::{AppHandle, Manager, State};
use tracing::{info, warn};

use super::{Config, PASSWORD_HINT_TAIL, command, tail_bytes};

/// 一条活跃隧道。
pub struct Tunnel {
	/// ⚠️ 必须随 Tunnel 活着：PTY master 是局部变量的话，open_tunnel
	/// 一返回它就 drop，ConPTY 句柄关闭会连带杀掉 ssh —— 表现为隧道
	/// 「开启成功」后毫秒级退出（日志里两次实锤）。close_tunnel 里从
	/// map 移除后 master drop，进程组随之终止，正好充当清理。
	pub master: Box<dyn portable_pty::MasterPty + Send>,
	pub child: Arc<Mutex<Box<dyn portable_pty::Child + Send + Sync>>>,
	/// ssh 进程退出后由收尾线程置位；列表查询时按它过滤死隧道。
	exited: Arc<AtomicBool>,
	pub local_port: u16,
	pub remote_port: u16,
	/// 发起隧道的目标（user@host:port，展示用；不含密码）
	pub target: String,
}

/// 全部活跃隧道，按 id 索引。
#[derive(Default)]
pub struct Tunnels(pub Mutex<HashMap<String, Tunnel>>);

/// 隧道信息（给前端列表）。
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TunnelInfo {
	id: String,
	local_port: u16,
	remote_port: u16,
	target: String,
}

/// 挑一个空闲的本地端口：bind 127.0.0.1:0 让系统分配，拿到后立刻释放。
///
/// 有竞态（释放到 ssh 绑定之间被别人抢走），窗口极小且 ssh 会以
/// "Address already in use" 失败退出、隧道从列表消失 —— 用户重开一次即可，
/// 不值得为它引入常驻占位复杂度。
fn pick_free_port() -> Result<u16, String> {
	let listener =
		TcpListener::bind("127.0.0.1:0")
			.map_err(|error| error.to_string())?;
	listener
		.local_addr()
		.map(|addr| addr.port())
		.map_err(|error| error.to_string())
}

/// 开一条临时隧道：经会话的连接参数把远端 remote_port 转到本地随机端口。
///
/// `target_host` 是转发目标：直接用网络抽屉里那一行的监听 IP —— 服务可能
/// 只绑在具体网卡上，硬编码 localhost（127.0.0.1）会「拒绝连接」；
/// `*` / `0.0.0.0`（全部接口）归一成 localhost。前端拿到返回的本地端口后
/// 自行拼 URL（HTTP 服务开浏览器）。
#[tauri::command(rename = "tunnel_open")]
pub fn open_tunnel(
	app: AppHandle,
	config: Config,
	remote_port: u16,
	target_host: Option<String>,
	tunnels: State<Tunnels>,
) -> Result<TunnelInfo, String> {
	if remote_port == 0 {
		return Err("远端端口不能为 0".into());
	}
	// 监听 IP 归一：通配地址才用 localhost，具体 IP 原样透传。
	// ss 的解析产物可能带接口作用域（如 `177.3.41.74%ens3`）：ssh -L 的
	// 目标主机不吃 %，剥掉后缀；IPv6 目标要方括号包起来，否则冒号
	// 会破坏 -L spec 的端口分隔。
	let host = target_host
		.as_deref()
		.map(str::trim)
		.filter(|value| !value.is_empty())
		.map(|value| {
			let base = value.split('%').next().unwrap_or(value);
			match base {
				"*" | "0.0.0.0" | "::" => "localhost".to_string(),
				other if other.contains(':') => {
					format!("[{other}]")
				}
				other => other.to_string(),
			}
		})
		.unwrap_or_else(|| "localhost".into());
	let local_port = pick_free_port()?;
	let stamp = SystemTime::now()
		.duration_since(UNIX_EPOCH)
		.map(|value| value.as_millis())
		.unwrap_or_default();
	let id = format!("tunnel-{stamp}");
	let target = format!(
		"{}@{}:{}",
		config.username.as_deref().unwrap_or(""),
		config.host.as_deref().unwrap_or(""),
		config.port.unwrap_or(22)
	);
	// 隧道配置：复制会话连接参数，转发规则改为单条本地转发
	let tunnel_config = Config {
		id: id.clone(),
		forwards: Some(vec![super::ForwardRule {
			kind: "L".into(),
			listen_port: local_port,
			target_host: Some(host),
			target_port: Some(remote_port),
		}]),
		tunnel_mode: Some(true),
		..config
	};

	let pty = native_pty_system()
		.openpty(PtySize {
			rows: 2,
			cols: 80,
			pixel_width: 0,
			pixel_height: 0,
		})
		.map_err(|error| error.to_string())?;
	let mut ssh = command(&tunnel_config)?;
	// argv 里没有密码，完整记录：ssh 打 usage 时一眼看出哪个参数非法
	info!(
		target = "tunnel",
		argv = ?ssh.get_argv().iter().map(|a| a.to_string_lossy().into_owned()).collect::<Vec<_>>(),
		"隧道 ssh 命令"
	);
	if let Some(home) = std::env::var_os(if cfg!(windows) { "USERPROFILE" } else { "HOME" }) {
		ssh.cwd(home);
	}
	let child = pty
		.slave
		.spawn_command(ssh)
		.map_err(|error| error.to_string())?;
	let child = Arc::new(Mutex::new(child));
	let mut reader = pty
		.master
		.try_clone_reader()
		.map_err(|error| error.to_string())?;
	let writer = Arc::new(Mutex::new(
		pty.master
			.take_writer()
			.map_err(|error| error.to_string())?,
	));
	// slave 句柄可以立刻释放（ssh 自己持有它的副本）；master 必须保持
	// 活着直到隧道关闭，随 Tunnel 存进表里（见 Tunnel::master 的注释）
	drop(pty.slave);
	let master = pty.master;

	// 密码自动应答：与交互会话同一套嗅探口径（尾部缓冲找提示串）。
	// 只答一次：答错 ssh 会再提示，但连错三次就让它自己失败退出。
	// 全部输出同步进共享缓冲：起隧道后短暂观察，秒退就把 ssh 的
	// 真实报错（Permission denied 等）原样返回给前端。
	let password = tunnel_config.password.clone();
	let exited = Arc::new(AtomicBool::new(false));
	let exited_for_reader = exited.clone();
	let output = Arc::new(Mutex::new(String::new()));
	let output_for_reader = output.clone();
	std::thread::spawn(move || {
		let mut buf = String::new();
		let mut answered = false;
		let mut chunk = [0u8; 1024];
		while let Ok(read) = reader.read(&mut chunk) {
			if read == 0 {
				break;
			}
			let data = &chunk[..read];
			if let Ok(mut log) = output_for_reader.lock() {
				// ssh 的报错行（如 Bad forwarding specification）在最前，
				// usage 说明在后面 —— 保头部、限上限，别按尾部截
				let len = log.len();
				if len < 16 * 1024 {
					log.push_str(&String::from_utf8_lossy(data));
				}
			}
			if !answered {
				buf.push_str(
					&String::from_utf8_lossy(data).to_lowercase(),
				);
				if buf.len() > PASSWORD_HINT_TAIL {
					buf = tail_bytes(&buf, PASSWORD_HINT_TAIL);
				}
				if buf.contains("password:")
					|| buf.contains("password for")
					|| buf.contains("passphrase for")
				{
					if let Some(password) = password.as_ref() {
						if let Ok(mut writer) = writer.lock() {
							let _ = writer.write_all(password.as_bytes());
							let _ = writer.write_all(b"\r");
							let _ = writer.flush();
							answered = true;
							info!(target = "tunnel", "隧道已自动应答密码提示");
						}
					} else {
						// 没存密码：ssh 卡在提示上直到超时，隧道起不来，
						// 列表里它会随进程退出消失 —— 这里提前说清楚
						warn!(target = "tunnel", "隧道需要密码但会话未保存密码，无法自动应答");
						break;
					}
				}
			}
		}
		exited_for_reader.store(true, Ordering::Relaxed);
	});

	// 收尾线程：进程退出后从表里移除，列表查询就看不到死隧道。
	// State 借用 app 引用不能跨线程 —— clone 一个 AppHandle 带进去，
	// state() 在线程内取（生命周期随闭包走）。
	let child_for_wait = child.clone();
	let exited_for_wait = exited.clone();
	let app_for_wait = app.clone();
	let id_for_wait = id.clone();
	std::thread::spawn(move || {
		if let Ok(mut guard) = child_for_wait.lock() {
			let _ = guard.wait();
		}
		exited_for_wait.store(true, Ordering::Relaxed);
		if let Ok(mut map) = app_for_wait.state::<Tunnels>().0.lock() {
			map.remove(&id_for_wait);
		}
		info!(target = "tunnel", %id_for_wait, "隧道进程已退出，已从列表移除");
	});

	// 观察窗口：认证失败 / 端口被占这类错误会让 ssh 在几秒内退出。
	// 等到退出就把输出尾部作为错误返回 —— 用户当场看到真实原因，
	// 而不是浏览器里一句「拒绝连接」让他猜。
	for _ in 0..15 {
		if exited.load(Ordering::Relaxed) {
			let tail = output
				.lock()
				.map(|log| log.trim().to_string())
				.unwrap_or_default();
			let reason = if tail.is_empty() {
				format!("ssh 已退出（退出码未知），目标 {target}:{remote_port}")
			} else {
				tail
			};
			return Err(format!("隧道未能建立：{reason}"));
		}
		std::thread::sleep(std::time::Duration::from_millis(150));
	}

	if let Ok(mut map) = tunnels.0.lock() {
		map.insert(
			id.clone(),
			Tunnel {
				master,
				child,
				exited,
				local_port,
				remote_port,
				target: target.clone(),
			},
		);
	}
	info!(target = "tunnel", %id, local_port, remote_port, "临时隧道已开启");
	Ok(TunnelInfo {
		id,
		local_port,
		remote_port,
		target,
	})
}

/// 关闭一条隧道：从表里移除即可。
///
/// ⚠️ 不能碰 child 锁去 kill：收尾线程**持有 child 锁**阻塞在 `wait()`
/// （进程不死不返回），同步命令若去 `child.lock()` 会永远等不到——而同步
/// 命令跑在主线程，整个窗口直接卡死。而其实也不需要 kill：Tunnel 随
/// remove 被 drop → master drop → ConPTY 连带终止 ssh → 收尾线程的
/// wait 自然返回，整条链自己走完。
#[tauri::command(rename = "tunnel_close")]
pub async fn close_tunnel(
	id: String,
	tunnels: State<'_, Tunnels>,
) -> Result<(), String> {
	tunnels
		.0
		.lock()
		.map_err(|_| "隧道状态不可用")?
		.remove(&id)
		.ok_or_else(|| format!("隧道不存在：{id}"))?;
	info!(target = "tunnel", %id, "临时隧道已关闭");
	Ok(())
}

/// 列出活跃隧道（顺带剔除已退出的死条目）。
#[tauri::command(rename = "tunnel_list")]
pub fn list_tunnels(
	tunnels: State<Tunnels>,
) -> Result<Vec<TunnelInfo>, String> {
	let mut map = tunnels.0.lock().map_err(|_| "隧道状态不可用")?;
	let dead: Vec<String> = map
		.iter()
		.filter(|(_, t)| t.exited.load(Ordering::Relaxed))
		.map(|(id, _)| id.clone())
		.collect();
	for id in dead {
		map.remove(&id);
	}
	Ok(map
		.iter()
		.map(
			|(id, t)| TunnelInfo {
				id: id.clone(),
				local_port: t.local_port,
				remote_port: t.remote_port,
				target: t.target.clone(),
			}
		)
		.collect())
}

/// 拉起本机的远程桌面客户端（远程桌面一键入口的最后一步）。
///
/// - rdp：Windows 自带 mstsc，直连本地隧道端口；
/// - vnc：交给系统对 vnc:// 协议的关联程序（用户装的 VNC Viewer），
///   没关联时 start 失败，把原文错误带回让用户去装。
///
/// 两个分支都 spawn 不等待：拉起即成功，客户端自身的连接问题
/// 由它自己弹窗（mstsc 连不上会自己报），不归我们管。
#[tauri::command(rename = "launch_rdp_client")]
pub fn launch_rdp_client(
	kind: String,
	local_port: u16,
) -> Result<(), String> {
	if !cfg!(windows) {
		return Err("远程桌面客户端拉起目前仅支持 Windows".into());
	}
	let spawned = if kind == "vnc" {
		std::process::Command::new("cmd")
			.args([
				"/C",
				"start",
				"",
				&format!("vnc://127.0.0.1:{local_port}"),
			])
			.spawn()
	} else {
		std::process::Command::new("mstsc")
			.arg(format!("/v:127.0.0.1:{local_port}"))
			.spawn()
	};
	match spawned {
		Ok(_) => {
			info!(target = "tunnel", kind = %kind, local_port, "远程桌面客户端已拉起");
			Ok(())
		}
		Err(error) => Err(format!("拉起客户端失败：{error}")),
	}
}
