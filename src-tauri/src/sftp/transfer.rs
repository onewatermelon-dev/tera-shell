//! 文件传输：上传 / 下载 / 远程删除共用的进度上下文与任务控制。
//!
//! `TransferContext` 做分块拷贝 + 节流上报 + 暂停 / 取消；同名冲突
//! 策略（覆盖 / 跳过 / 重命名 / 续传）在 `prepare_target` 汇总。

use serde::{Deserialize, Serialize};
use ssh2::Sftp;
use std::{
	collections::HashMap,
	io::{Read, Seek, Write},
	path::{Path, PathBuf},
	sync::{
		Arc, Mutex,
		atomic::{AtomicBool, Ordering},
	},
	thread,
	time::{Duration, Instant},
};
use tauri::State;
use tracing::info;

use crate::ssh::{JumpHop, SshTarget};

use super::pool::{SftpPool, obtain};

/// 传输 / 远程操作的通用任务参数（连接信息 + 本地路径 + 远程路径）。
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TransferJob {
	pub(super) host: String,
	pub(super) port: Option<u16>,
	pub(super) username: Option<String>,
	pub(super) password: Option<String>,
	/// 跳板链（离客户端最近的一跳在前，前端已解开密码）。
	#[serde(default)]
	pub(super) jump: Vec<JumpHop>,
	/// 设置里的默认私钥路径（与终端 `-i` 一致）。
	#[serde(default)]
	pub(super) key_path: Option<String>,
	/// 本地文件路径（上传时为源文件，下载时为目标文件）
	pub(super) local: String,
	/// 远程文件路径（上传时为目标文件，下载时为源文件）
	pub(super) remote: String,
	/// 传输任务 id：前端生成，用于把进度事件对回任务面板。
	/// 非传输类操作（新建 / 删除 / 权限）不传。
	#[serde(default)]
	pub(super) id: String,
	/// 同名冲突策略：overwrite（默认）/ skip / rename / resume。
	/// 旧调用方不传此字段，按覆盖处理保持既有行为。
	#[serde(default)]
	pub(super) policy: String,
}

/// 文件落点同名冲突时的处理策略。
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub(super) enum TransferPolicy {
	Overwrite,
	Skip,
	Rename,
	Resume,
}

impl TransferPolicy {
	fn from_job(value: &str) -> Self {
		match value {
			"skip" => Self::Skip,
			"rename" => Self::Rename,
			"resume" => Self::Resume,
			_ => Self::Overwrite,
		}
	}
}

/// 同名冲突时生成不冲突的相邻路径：`a.txt → a (1).txt → a (2).txt`。
///
/// `exists` 是落点侧的存在性探测（远程用 stat，本地用 metadata）。
/// 尝试上限 1000：正常情况第一个候选就命中，到上限兜底返回原路径
/// 按覆盖处理，避免理论上的死循环。
fn renamed_target(
	target: &Path,
	mut exists: impl FnMut(&Path) -> bool,
) -> PathBuf {
	if !exists(target) {
		return target.to_path_buf();
	}
	let stem = target
		.file_stem()
		.map(|name| name.to_string_lossy().into_owned())
		.unwrap_or_default();
	let extension = target
		.extension()
		.map(|ext| ext.to_string_lossy().into_owned());
	for index in 1..1000 {
		let candidate = match &extension {
			Some(ext) => target.with_file_name(format!(
				"{stem} ({index}).{ext}"
			)),
			None => target.with_file_name(format!(
				"{stem} ({index})"
			)),
		};
		if !exists(&candidate) {
			return candidate;
		}
	}
	target.to_path_buf()
}

/// 策略决策核心：返回实际落点与起始偏移，`None` = 按策略跳过该文件。
///
/// 前置：落点不存在时一律正常传输（四种策略在此汇合）。落点已存在时：
/// 覆盖 → 原路径从头写；跳过 → None；重命名 → 换相邻路径；
/// 续传 → 目标不比源小时无事可做（None），比源小则从目标大小处接续。
fn prepare_target(
	policy: TransferPolicy,
	target: &Path,
	mut exists: impl FnMut(&Path) -> bool,
	mut size_of: impl FnMut(&Path) -> Option<u64>,
	source_len: u64,
) -> Option<(PathBuf, u64)> {
	if !exists(target) {
		return Some((target.to_path_buf(), 0));
	}
	match policy {
		TransferPolicy::Overwrite => {
			Some((target.to_path_buf(), 0))
		}
		TransferPolicy::Skip => None,
		TransferPolicy::Rename => Some((
			renamed_target(target, &mut exists),
			0,
		)),
		TransferPolicy::Resume => {
			let done = size_of(target).unwrap_or(0);
			if done >= source_len {
				None
			} else {
				Some((target.to_path_buf(), done))
			}
		}
	}
}

/// 传输进度事件名：前端 listen 这个频道更新任务面板。
const TRANSFER_EVENT: &str = "sftp-transfer";

/// 分块大小：一次读写 64KB，既能上报细粒度进度又不至于系统调用过密。
const CHUNK_SIZE: usize = 64 * 1024;

/// 进度上报的最小间隔，避免大文件把事件刷爆。
const PROGRESS_INTERVAL: Duration =
	Duration::from_millis(100);

/// 传输进度事件负载。
#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct TransferEvent {
	id: String,
	bytes: u64,
	total: u64,
	done: bool,
}

/// 向 WebView 发一次进度事件；发失败不影响传输本身。
fn emit_transfer(
	app: &tauri::AppHandle,
	event: TransferEvent,
) {
	use tauri::Emitter;
	let _ = app.emit(TRANSFER_EVENT, event);
}

/// 解析传输任务里的连接信息，得到与 SFTP / AI 共用的连接目标。
pub(crate) fn transfer_target(
	job: &TransferJob,
) -> Result<SshTarget, String> {
	SshTarget::new(
		&job.host,
		job.port,
		job.username.as_deref(),
		job.password.as_deref(),
		job.key_path.as_deref(),
		job.jump.clone(),
	)
}

/// 单个传输任务的控制开关：前端通过命令翻转，传输循环每块检查一次。
#[derive(Default)]
pub struct TransferControl {
	paused: AtomicBool,
	cancelled: AtomicBool,
}

/// 进行中的传输任务表（Tauri State）：任务 id → 控制开关。
#[derive(Default)]
pub struct Transfers {
	controls: Mutex<HashMap<String, Arc<TransferControl>>>,
}

impl Transfers {
	pub(super) fn lock(
		&self,
	) -> std::sync::MutexGuard<
		'_,
		HashMap<String, Arc<TransferControl>>,
	> {
		self.controls
			.lock()
			.unwrap_or_else(|error| error.into_inner())
	}

	/// 登记任务并返回它的控制开关。
	pub(super) fn register(&self, id: &str) -> Arc<TransferControl> {
		let control = Arc::new(TransferControl::default());
		self.lock().insert(id.to_string(), control.clone());
		control
	}

	/// 任务结束后摘除，避免表无限增长。
	pub(super) fn unregister(&self, id: &str) {
		self.lock().remove(id);
	}

	/// 取任务的控制开关；任务不存在（已结束）时为 None。
	pub(super) fn find(&self, id: &str) -> Option<Arc<TransferControl>> {
		self.lock().get(id).cloned()
	}
}

/// 暂停传输：循环会在当前分块结束后停下来等待。
#[tauri::command(rename = "sftp_pause_transfer")]
pub fn pause_transfer(
	transfers: State<'_, Transfers>,
	id: String,
) -> Result<(), String> {
	let control = transfers
		.find(&id)
		.ok_or_else(|| "任务不存在或已结束".to_string())?;
	control.paused.store(true, Ordering::Relaxed);
	Ok(())
}

/// 恢复传输。
#[tauri::command(rename = "sftp_resume_transfer")]
pub fn resume_transfer(
	transfers: State<'_, Transfers>,
	id: String,
) -> Result<(), String> {
	let control = transfers
		.find(&id)
		.ok_or_else(|| "任务不存在或已结束".to_string())?;
	control.paused.store(false, Ordering::Relaxed);
	Ok(())
}

/// 取消传输：循环在下一个分块边界退出。
#[tauri::command(rename = "sftp_cancel_transfer")]
pub fn cancel_transfer(
	transfers: State<'_, Transfers>,
	id: String,
) -> Result<(), String> {
	let control = transfers
		.find(&id)
		.ok_or_else(|| "任务不存在或已结束".to_string())?;
	control.cancelled.store(true, Ordering::Relaxed);
	// 处于暂停等待时也要能立刻退出
	control.paused.store(false, Ordering::Relaxed);
	Ok(())
}

/// 递归统计本地路径的总字节数：目录求和，文件取长度。
fn measure_local(path: &Path) -> u64 {
	let Ok(metadata) = std::fs::metadata(path) else {
		return 0;
	};
	if !metadata.is_dir() {
		return metadata.len();
	}
	let Ok(entries) = std::fs::read_dir(path) else {
		return 0;
	};
	entries
		.filter_map(Result::ok)
		.map(|entry| measure_local(&entry.path()))
		.sum()
}

/// 远程路径是否为 `.` / `..`（递归时要跳过）。
pub(super) fn is_dot_entry(path: &Path) -> bool {
	matches!(
		path.file_name().map(|name| name.to_string_lossy().into_owned()),
		Some(name) if name == "." || name == ".."
	)
}

/// 拼远程子路径：强制 `/` 分隔 —— `PathBuf::join` 在 Windows 宿主上
/// 会拼出 `\`，远端 Linux 收到的是带反斜杠的字面量文件名。
fn remote_join(parent: &Path, name: &std::ffi::OsStr) -> PathBuf {
	let mut text = parent.to_string_lossy().into_owned();
	if !text.ends_with('/') {
		text.push('/');
	}
	PathBuf::from(text + &name.to_string_lossy())
}

/// 递归统计远程路径的总字节数。
pub(super) fn measure_remote(sftp: &Sftp, path: &Path) -> u64 {
	match sftp.stat(path) {
		Ok(stat) if stat.is_dir() => sftp
			.readdir(path)
			.map(|entries| {
				entries
					.iter()
					.filter(|(child, _)| !is_dot_entry(child))
					.map(|(child, _)| measure_remote(sftp, child))
					.sum()
			})
			.unwrap_or(0),
		Ok(stat) => stat.size.unwrap_or(0),
		Err(_) => 0,
	}
}

/// 一次传输的进度上下文：累计字节、节流上报、响应暂停 / 取消。
///
/// 上传下载共用；目录传输时 `moved` 跨文件累计，因此进度条是整体进度。
pub(super) struct TransferContext<'a> {
	app: &'a tauri::AppHandle,
	control: &'a TransferControl,
	id: &'a str,
	/// 同名冲突策略（目录递归里的每个文件都要过一遍）
	policy: TransferPolicy,
	/// 总字节数（目录为递归求和结果）
	total: u64,
	/// 已传输字节数
	pub(super) moved: u64,
	/// 上次上报时间，用于节流
	reported: Instant,
	/// 复用的分块缓冲，避免每个文件都重新分配
	buffer: Vec<u8>,
}

impl<'a> TransferContext<'a> {
	pub(super) fn new(
		app: &'a tauri::AppHandle,
		control: &'a TransferControl,
		id: &'a str,
		policy: TransferPolicy,
		total: u64,
	) -> Self {
		Self {
			app,
			control,
			id,
			policy,
			total,
			moved: 0,
			reported: Instant::now(),
			buffer: vec![0u8; CHUNK_SIZE],
		}
	}

	/// 上传侧的策略决策：远程落点 + 起始偏移；None = 跳过该文件。
	fn prepare_upload(
		&self,
		sftp: &Sftp,
		source_len: u64,
		target: &Path,
	) -> Option<(PathBuf, u64)> {
		let resolved = prepare_target(
			self.policy,
			target,
			|path| sftp.stat(path).is_ok(),
			|path| sftp.stat(path).ok().and_then(|s| s.size),
			source_len,
		);
		tracing::info!(
			policy = ?self.policy,
			target = %target.display(),
			resolved = resolved
				.as_ref()
				.map(|(path, offset)| format!(
					"{} @+{}",
					path.display(),
					offset
				))
				.as_deref()
				.unwrap_or("skip"),
			"上传落点策略"
		);
		resolved
	}

	/// 下载侧的策略决策：本地落点 + 起始偏移；None = 跳过该文件。
	fn prepare_download(
		&self,
		source_len: u64,
		target: &Path,
	) -> Option<(PathBuf, u64)> {
		let resolved = prepare_target(
			self.policy,
			target,
			|path| path.exists(),
			|path| {
				std::fs::metadata(path)
					.ok()
					.map(|meta| meta.len())
			},
			source_len,
		);
		tracing::info!(
			policy = ?self.policy,
			target = %target.display(),
			resolved = resolved
				.as_ref()
				.map(|(path, offset)| format!(
					"{} @+{}",
					path.display(),
					offset
				))
				.as_deref()
				.unwrap_or("skip"),
			"下载落点策略"
		);
		resolved
	}

	/// 上报一次进度。
	pub(super) fn report(&self, done: bool) {
		emit_transfer(
			self.app,
			TransferEvent {
				id: self.id.to_string(),
				bytes: self.moved,
				total: self.total,
				done,
			},
		);
	}

	/// 响应取消与暂停；每个操作边界调用一次。
	fn gate(&self) -> Result<(), String> {
		if self.control.cancelled.load(Ordering::Relaxed) {
			return Err("传输已取消".to_string());
		}
		// 暂停时原地等待，但期间仍要能取消
		while self.control.paused.load(Ordering::Relaxed) {
			if self.control.cancelled.load(Ordering::Relaxed)
			{
				return Err("传输已取消".to_string());
			}
			thread::sleep(Duration::from_millis(120));
		}
		Ok(())
	}

	/// 记录一笔已完成的量（删除等非拷贝操作也用得上），并按节流上报。
	pub(super) fn advance(&mut self, bytes: u64) -> Result<(), String> {
		self.gate()?;
		self.moved += bytes;
		if self.reported.elapsed() >= PROGRESS_INTERVAL {
			self.report(false);
			self.reported = Instant::now();
		}
		Ok(())
	}

	/// 搬运一个分块；返回 `false` 表示当前源已读完。
	///
	/// 每个分块边界都检查取消与暂停，所以暂停 / 取消的响应粒度是 64KB。
	fn pump(
		&mut self,
		reader: &mut dyn Read,
		writer: &mut dyn Write,
	) -> Result<bool, String> {
		self.gate()?;
		let read = reader
			.read(&mut self.buffer)
			.map_err(|error| format!("读取失败：{error}"))?;
		if read == 0 {
			return Ok(false);
		}
		writer
			.write_all(&self.buffer[..read])
			.map_err(|error| format!("写入失败：{error}"))?;
		self.moved += read as u64;
		if self.reported.elapsed() >= PROGRESS_INTERVAL {
			self.report(false);
			self.reported = Instant::now();
		}
		Ok(true)
	}

	/// 递归上传一个本地路径：目录先建再逐项处理，文件则分块拷贝。
	fn upload(
		&mut self,
		sftp: &Sftp,
		local: &Path,
		remote: &Path,
	) -> Result<(), String> {
		let metadata =
			std::fs::metadata(local).map_err(|error| {
				format!("读取 {} 失败：{error}", local.display())
			})?;
		if metadata.is_dir() {
			// 目录级冲突也按策略处理（同下载侧）：重命名整个目录或整树跳过
			let target = match self.policy {
				TransferPolicy::Rename if sftp.stat(remote).is_ok() => {
					renamed_target(remote, |path| {
						sftp.stat(path).is_ok()
					})
				}
				TransferPolicy::Skip if sftp.stat(remote).is_ok() => {
					return Ok(());
				}
				_ => remote.to_path_buf(),
			};
			// 目标目录可能已存在（合并上传），忽略 mkdir 的报错
			let _ = sftp.mkdir(&target, 0o755);
			let entries =
				std::fs::read_dir(local).map_err(|error| {
					format!(
						"读取目录 {} 失败：{error}",
						local.display()
					)
				})?;
			for entry in entries {
				let entry = entry.map_err(|error| {
					format!("读取目录项失败：{error}")
				})?;
				self.upload(
					sftp,
					&entry.path(),
					&remote_join(&target, &entry.file_name()),
				)?;
			}
			return Ok(());
		}
		// 同名冲突按策略处理：覆盖 / 跳过 / 重命名 / 断点续传
		let Some((target_path, offset)) =
			self.prepare_upload(sftp, metadata.len(), remote)
		else {
			return Ok(());
		};
		let mut source =
			std::fs::File::open(local).map_err(|error| {
				format!("读取 {} 失败：{error}", local.display())
			})?;
		let mut target = if offset > 0 {
			// 续传：不带 TRUNCATE 打开已有文件，两侧都 seek 到断点；
			// 已传过的部分计入进度，进度条才能到达 100%
			let mut file = sftp
				.open_mode(
					&target_path,
					ssh2::OpenFlags::WRITE
						| ssh2::OpenFlags::CREATE,
					0o644,
					ssh2::OpenType::File,
				)
				.map_err(|error| {
					format!(
						"打开远程文件 {} 失败：{error}",
						target_path.display()
					)
				})?;
			file.seek(std::io::SeekFrom::Start(offset))
				.map_err(|error| {
					format!("定位续传偏移失败：{error}")
				})?;
			source
				.seek(std::io::SeekFrom::Start(offset))
				.map_err(|error| {
					format!("定位续传偏移失败：{error}")
				})?;
			self.moved += offset;
			file
		} else {
			sftp.create(&target_path).map_err(|error| {
				format!(
					"创建远程文件 {} 失败：{error}",
					target_path.display()
				)
			})?
		};
		while self.pump(&mut source, &mut target)? {}
		Ok(())
	}

	/// 递归下载一个远程路径：目录先建再逐项处理，文件则分块拷贝。
	fn download(
		&mut self,
		sftp: &Sftp,
		remote: &Path,
		local: &Path,
	) -> Result<(), String> {
		let stat = sftp.stat(remote).map_err(|error| {
			format!("读取远程 {} 失败：{error}", remote.display())
		})?;
		if stat.is_dir() {
			// 目录级冲突也按策略处理：重命名 = 整个目录改名（落回新
			// 目录，不与既有目录合并），跳过 = 整树略过，其余照旧合并。
			let target = match self.policy {
				TransferPolicy::Rename if local.exists() => {
					renamed_target(local, |path| path.exists())
				}
				TransferPolicy::Skip if local.exists() => {
					return Ok(());
				}
				_ => local.to_path_buf(),
			};
			std::fs::create_dir_all(&target).map_err(|error| {
				format!(
					"创建目录 {} 失败：{error}",
					target.display()
				)
			})?;
			let entries =
				sftp.readdir(remote).map_err(|error| {
					format!(
						"读取远程目录 {} 失败：{error}",
						remote.display()
					)
				})?;
			for (child, _) in entries {
				if is_dot_entry(&child) {
					continue;
				}
				let Some(name) = child.file_name() else {
					continue;
				};
				self.download(
					sftp,
					&child,
					&target.join(name),
				)?;
			}
			return Ok(());
		}
		// 同名冲突按策略处理：覆盖 / 跳过 / 重命名 / 断点续传
		let Some((target_path, offset)) =
			self.prepare_download(stat.size.unwrap_or(0), local)
		else {
			return Ok(());
		};
		let mut source = sftp.open(remote).map_err(|error| {
			format!(
				"打开远程文件 {} 失败：{error}",
				remote.display()
			)
		})?;
		if offset > 0 {
			// 续传：远程源与本地目标都 seek 到断点，已传部分计入进度
			source
				.seek(std::io::SeekFrom::Start(offset))
				.map_err(|error| {
					format!("定位续传偏移失败：{error}")
				})?;
			self.moved += offset;
		}
		let mut target = if offset > 0 {
			let mut file = std::fs::OpenOptions::new()
				.write(true)
				.open(&target_path)
				.map_err(|error| {
					format!(
						"打开 {} 失败：{error}",
						target_path.display()
					)
				})?;
			file.seek(std::io::SeekFrom::Start(offset))
				.map_err(|error| {
					format!("定位续传偏移失败：{error}")
				})?;
			file
		} else {
			std::fs::File::create(&target_path).map_err(
				|error| {
					format!(
						"写入 {} 失败：{error}",
						target_path.display()
					)
				},
			)?
		};
		while self.pump(&mut source, &mut target)? {}
		Ok(())
	}
}

/// 上传本地文件到远程路径（分块传输并按 100ms 节流上报进度）。
#[tauri::command(rename = "sftp_upload")]pub async fn upload(
	app: tauri::AppHandle,
	pool: State<'_, SftpPool>,
	transfers: State<'_, Transfers>,
	job: TransferJob,
) -> Result<(), String> {
	let connections = pool.connections.clone();
	// 控制开关要先取出来：State 借不出 'static 生命周期，Arc 可以
	let control = transfers.register(&job.id);
	let id = job.id.clone();
	// 闭包要拿走 id 上报进度，另留一份用于收尾注销
	let cleanup_id = id.clone();
	let result = tauri::async_runtime::spawn_blocking(
		move || {
			let target = transfer_target(&job)?;
			let connection = obtain(&connections, &target)?;
			let local = PathBuf::from(&job.local);
			let remote = PathBuf::from(&job.remote);
			// 先递归统计总量，目录也能给出准确的整体进度
			let total = measure_local(&local);
			let mut context = TransferContext::new(
				&app,
				&control,
				&id,
				TransferPolicy::from_job(&job.policy),
				total,
			);
			context.upload(&connection.sftp, &local, &remote)?;
			context.report(true);
			info!(
				bytes = context.moved,
				"已上传 {} -> {}", job.local, job.remote
			);
			Ok(())
		},
	)
	.await
	.map_err(|error| error.to_string())?;
	transfers.unregister(&cleanup_id);
	result
}

/// 下载远程文件到本地路径（分块传输并按 100ms 节流上报进度）。
#[tauri::command(rename = "sftp_download")]
pub async fn download(
	app: tauri::AppHandle,
	pool: State<'_, SftpPool>,
	transfers: State<'_, Transfers>,
	job: TransferJob,
) -> Result<(), String> {
	let connections = pool.connections.clone();
	let control = transfers.register(&job.id);
	let id = job.id.clone();
	// 闭包要拿走 id 上报进度，另留一份用于收尾注销
	let cleanup_id = id.clone();
	let result = tauri::async_runtime::spawn_blocking(
		move || {
			let target = transfer_target(&job)?;
			let connection = obtain(&connections, &target)?;
			let local = PathBuf::from(&job.local);
			let remote = PathBuf::from(&job.remote);
			// 先递归统计总量，目录也能给出准确的整体进度
			let total = measure_remote(&connection.sftp, &remote);
			let mut context = TransferContext::new(
				&app,
				&control,
				&id,
				TransferPolicy::from_job(&job.policy),
				total,
			);
			context.download(&connection.sftp, &remote, &local)?;
			context.report(true);
			info!(
				bytes = context.moved,
				"已下载 {} -> {}", job.remote, job.local
			);
			Ok(())
		},
	)
	.await
	.map_err(|error| error.to_string())?;
	transfers.unregister(&cleanup_id);
	result
}

// 单元测试集中在 src-tauri/tests/unit/：#[path] 把模块编回本处，私有项仍可
// 访问；tests/ 下的直接子文件才是 cargo 的集成测试目标，子目录不自动发现。
#[cfg(test)]
#[path = "../../tests/unit/sftp_transfer.rs"]
mod tests;
