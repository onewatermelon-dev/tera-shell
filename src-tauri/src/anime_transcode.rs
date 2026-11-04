//! 动漫片源转码：把 H.265(HEVC) 转成 H.264，绕开 WebView2 缺 HEVC 解码器。
//!
//! ## 为什么用外部 ffmpeg
//!
//! 解码器（libavcodec）只在 ffmpeg 里成熟；进程内绑定要引 20MB+ 且维护成本高。
//! 实测单集 1080p HEVC→H.264 ultrafast 有 **4.8× 实时**，足够边转边播。
//!
//! ## 数据通路
//!
//! ```text
//! ffmpeg stdout(fragmented MP4) → 64KB 分块 → base64 → Tauri 事件 → 前端 MSE
//! ```
//!
//! `-re` 让 ffmpeg 按 1× 速度吐数据，避免 4.8× 产能把前端缓冲撑爆。
//! 前端拿到的是 fMP4 分片，用 MediaSource 追加播放，所以能边转边看。

use std::collections::HashMap;
use std::path::PathBuf;
use std::process::Stdio;
use std::sync::Mutex;
use tauri::Emitter;
use tokio::io::AsyncReadExt;
use tokio::process::{Child, Command};

/// 分片事件名（前端按它监听）。
pub const CHUNK_EVENT: &str = "anime://transcode-chunk";
/// 结束事件名（进程退出/出错时通知前端收尾）。
pub const END_EVENT: &str = "anime://transcode-end";

/// 正在跑的转码进程，key = 前端生成的会话 id。
static RUNNING: Mutex<Option<HashMap<String, Child>>> = Mutex::new(None);

/// 片源 URL → 探测到的总时长（秒）。同一集拖动重开时复用，省掉重复探测。
/// （用 Vec 而非 HashMap：static 里 HashMap::new 非 const。）
static DURATION_CACHE: Mutex<Vec<(String, f64)>> =
	Mutex::new(Vec::new());

fn duration_cached(url: &str) -> Option<f64> {
	DURATION_CACHE
		.lock()
		.ok()
		.and_then(|m| {
			m.iter()
				.find(|(u, _)| u == url)
				.map(|(_, d)| *d)
		})
}

fn cache_duration(url: &str, d: f64) {
	if let Ok(mut m) = DURATION_CACHE.lock() {
		if !m.iter().any(|(u, _)| u == url) {
			if m.len() >= 64 {
				m.clear();
			}
			m.push((url.to_string(), d));
		}
	}
}

/// 事件负载：一块 fMP4 数据（base64）与序号。
#[derive(Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct ChunkPayload {
	id: String,
	seq: u64,
	chunk: String,
}

/// 结束负载。
#[derive(Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct EndPayload {
	id: String,
	error: String,
}

/// 找 ffmpeg 可执行文件：先看随包资源，再走 PATH。
///
/// 不把 75MB 的二进制塞进仓库，用户装了 ffmpeg（或系统自带）就能用；
/// 将来要随包分发，把 `ffmpeg.exe` 放进 `resources/anime/` 即可自动命中。
fn find_ffmpeg(app: &tauri::AppHandle) -> Option<PathBuf> {
	use tauri::Manager;
	if let Ok(dir) = app.path().resource_dir() {
		let bundled = dir.join("resources/anime/ffmpeg.exe");
		if bundled.is_file() {
			return Some(bundled);
		}
	}
	let path = std::env::var_os("PATH")?;
	for dir in std::env::split_paths(&path) {
		let candidate = dir.join("ffmpeg.exe");
		if candidate.is_file() {
			return Some(candidate);
		}
	}
	None
}

/// 用 ffmpeg 探一次总时长（秒）。
///
/// 只读容器头，不下整个文件；解析 `Duration: HH:MM:SS.ss` 那行。
/// 拿不到就返回 0（前端据此退化成不可拖动的直播语义）。
fn probe_duration(ffmpeg: &std::path::Path, url: &str) -> f64 {
	// 只给 `-i`、不给输出：ffmpeg 打印完输入信息就自己退出（不下载、不解码）。
	// 这里用标准库的阻塞 Command——本函数跑在 spawn_blocking 里，
	// tokio 的 Command::output 是 async，不能直接 await 在这里。
	let Ok(output) = std::process::Command::new(ffmpeg)
		.args(["-hide_banner", "-i", url])
		.stdin(Stdio::null())
		.stdout(Stdio::null())
		.stderr(Stdio::piped())
		.output()
	else {
		return 0.0;
	};
	let text = String::from_utf8_lossy(&output.stderr);
	let Some(pos) = text.find("Duration: ") else {
		tracing::warn!(%url, "没探到时长");
		return 0.0;
	};
	let rest = &text[pos + 10..];
	let stamp = rest.split(',').next().unwrap_or("").trim();
	let mut parts = stamp.split(':');
	let (h, m, sec) = (
		parts.next().and_then(|v| v.parse::<f64>().ok()).unwrap_or(0.0),
		parts.next().and_then(|v| v.parse::<f64>().ok()).unwrap_or(0.0),
		parts.next().and_then(|v| v.parse::<f64>().ok()).unwrap_or(0.0),
	);
	let total = h * 3600.0 + m * 60.0 + sec;
	if total > 0.0 {
		tracing::info!(%url, total, "探测到片源时长");
	}
	total
}

/// 极简 base64（只给事件负载用，不引依赖）。
fn base64(data: &[u8]) -> String {
	const TABLE: &[u8; 64] =
		b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
	let mut out = String::with_capacity(data.len().div_ceil(3) * 4);
	for chunk in data.chunks(3) {
		let b = [
			chunk[0],
			*chunk.get(1).unwrap_or(&0),
			*chunk.get(2).unwrap_or(&0),
		];
		let n = ((b[0] as u32) << 16) | ((b[1] as u32) << 8) | b[2] as u32;
		out.push(TABLE[(n >> 18) as usize & 63] as char);
		out.push(TABLE[(n >> 12) as usize & 63] as char);
		out.push(if chunk.len() > 1 {
			TABLE[(n >> 6) as usize & 63] as char
		} else {
			'='
		});
		out.push(if chunk.len() > 2 {
			TABLE[n as usize & 63] as char
		} else {
			'='
		});
	}
	out
}

/// 杀掉同 id 的旧进程（重新起播/切位置时用）。
fn kill_session(id: &str) {
	if let Ok(mut guard) = RUNNING.lock() {
		if let Some(map) = guard.as_mut() {
			if let Some(mut child) = map.remove(id) {
				let _ = child.start_kill();
			}
		}
	}
}

/// 开始转码：H.265 片源 → H.264 fMP4，从 `start` 秒开始。
///
/// 同一个 `id` 再调一次会先把旧进程杀掉（前端切进度就用这个语义）。
#[tauri::command(rename = "anime_transcode_start")]
pub async fn transcode_start(
	app: tauri::AppHandle,
	id: String,
	url: String,
	start: f64,
) -> Result<serde_json::Value, String> {
	if !url.starts_with("http://") && !url.starts_with("https://") {
		return Err("只支持 http(s) 片源".into());
	}
	let ffmpeg = find_ffmpeg(&app).ok_or_else(|| {
		"没找到 ffmpeg：请安装 ffmpeg 并加入 PATH（或把 ffmpeg.exe 放到资源目录）".to_string()
	})?;
	kill_session(&id);

	// 先探总时长：前端要拿它做真实进度条（MSE 默认是 live 语义没有时长）。
	// 同一片源（url）只探一次，拖动重开时直接复用缓存，省掉 2~3s 黑屏。
	let duration = if let Some(cached) = duration_cached(&url) {
		cached
	} else {
		let d = tauri::async_runtime::spawn_blocking({
			let ffmpeg = ffmpeg.clone();
			let url = url.clone();
			move || probe_duration(&ffmpeg, &url)
		})
		.await
		.unwrap_or(0.0);
		if d > 0.0 {
			cache_duration(&url, d);
		}
		d
	};

	// 低延迟参数说明：
	// 不加 -readrate / -re：让 ffmpeg 全速转码攒预缓冲，前端有 queue 上限兜底
	// 防内存暴涨。⚠️ 关键教训：**不要加 scale 滤镜**——本机 scale 是纯 CPU 软
	// 操作，4K→1080p 缩放比直接编码 4K 还慢（实测加 scale 后 0.2~0.58×，
	// 去掉 scale 保持 4K + crf30 反而 1.5×+）。4K HEVC 解码靠硬件/够快，
	// 瓶颈在 scale 而非编码。
	// -ss 放在 -i 前  输入侧定位，起播快（关键帧对齐）
	// -g 48          2 秒一个关键帧，便于前端按需重开
	// frag_keyframe+empty_moov+default_base_moof → 可直接喂 MSE
	let mut command = Command::new(&ffmpeg);
	command.args(["-hide_banner", "-loglevel", "error"]);
	if start > 0.0 {
		// 从中间起播：输入侧定位。输出时间戳从 0 开始（相对本段转码流），
		// 前端用「startAt + currentTime」换算源片绝对位置。
		// ⚠️ 别用 -output_ts_offset / -copyts：这两个在 empty_moov 的 fMP4
		// 下对 mp4 muxer 不生效（实测 start_time 仍是 0），反而误导前端。
		command.arg("-ss").arg(format!("{start:.3}"));
	}
	let mut child = command
		.arg("-i")
		.arg(&url)
		.args([
			"-c:v",
			"libx264",
			"-preset",
			"ultrafast",
			"-tune",
			"zerolatency",
			"-profile:v",
			"main",
			"-level",
			"4.0",
			"-g",
			"48",
			"-keyint_min",
			"48",
			"-sc_threshold",
			"0",
			"-crf",
			"30",
			"-c:a",
			"aac",
			"-b:a",
			"96k",
			"-ac",
			"2",
			"-f",
			"mp4",
			"-movflags",
			"+frag_keyframe+empty_moov+default_base_moof",
			"pipe:1",
		])
		.stdin(Stdio::null())
		.stdout(Stdio::piped())
		.stderr(Stdio::null())
		.kill_on_drop(true)
		.spawn()
		.map_err(|e| format!("启动 ffmpeg 失败：{e}"))?;

	let mut stdout = child
		.stdout
		.take()
		.ok_or_else(|| "拿不到 ffmpeg 输出".to_string())?;

	if let Ok(mut guard) = RUNNING.lock() {
		guard
			.get_or_insert_with(HashMap::new)
			.insert(id.clone(), child);
	}
	tracing::info!(session = %id, %url, start, ffmpeg = %ffmpeg.display(), "转码开始");

	// 读线程：把 stdout 切成 64KB 块发事件；进程退出时发收尾事件。
	let app_handle = app.clone();
	let session = id.clone();
	tauri::async_runtime::spawn(async move {
		let mut buf = vec![0u8; 64 * 1024];
		let mut seq: u64 = 0;
		let mut error = String::new();
		loop {
			match stdout.read(&mut buf).await {
				Ok(0) => break,
				Ok(n) => {
					seq += 1;
					let payload = ChunkPayload {
						id: session.clone(),
						seq,
						chunk: base64(&buf[..n]),
					};
					if app_handle.emit(CHUNK_EVENT, payload).is_err() {
						break;
					}
				}
				Err(e) => {
					error = format!("读取 ffmpeg 输出失败：{e}");
					tracing::error!(session = %session, %error, "转码读取失败");
					break;
				}
			}
		}
		kill_session(&session);
		tracing::info!(session = %session, seq, "转码结束");
		let _ = app_handle.emit(END_EVENT, EndPayload { id: session, error });
	});
	Ok(serde_json::json!({ "duration": duration }))
}

/// 停止转码（用户关闭播放器 / 切集时调用）。
#[tauri::command(rename = "anime_transcode_stop")]
pub fn transcode_stop(id: String) {
	kill_session(&id);
	tracing::info!(session = %id, "转码已停止");
}

/// 当前环境是否具备转码能力（前端据此决定要不要走软解）。
#[tauri::command(rename = "anime_transcode_available")]
pub fn transcode_available(app: tauri::AppHandle) -> bool {
	find_ffmpeg(&app).is_some()
}
