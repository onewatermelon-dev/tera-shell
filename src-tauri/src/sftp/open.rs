//! 远程文件的本地编辑与自动回传。
//!
//! 远程文件本地程序够不着，所以"编辑"是三步：
//!   1. 把它拉到 `<主目录>/.tera-shell/tmp/`；
//!   2. 把本地路径交给前端，走 `fs_open_path` / `fs_open_notepad` 打开；
//!   3. 后台盯着这个临时文件，一旦被保存（mtime 变化）就自动写回远端。
//!
//! 这样用户在记事本或 VS Code 里改完按保存，远程文件就跟着更新了。
//! 打开动作留给前端，后端不重复实现系统关联逻辑。

use std::{
	collections::HashMap,
	io::copy,
	path::{Path, PathBuf},
	sync::{
		Arc, Mutex,
		atomic::{AtomicBool, Ordering},
	},
	thread,
	time::Duration,
};
use tauri::State;
use tracing::{info, warn};

use super::{Connection, SftpPool, TransferJob, obtain, transfer_target};

/// 监视线程的心跳间隔：手工保存是低频动作，1.5 秒足够跟得上。
const POLL_INTERVAL: Duration = Duration::from_millis(1500);

/// 正在被编辑的远端文件：远程路径 → 该监视线程的停止标志。
#[derive(Default)]
pub struct EditWatchers {
	stops: Arc<Mutex<HashMap<String, Arc<AtomicBool>>>>,
}

impl EditWatchers {
	/// 停掉并移除某个远程路径的监视。
	fn stop(&self, remote: &str) {
		let stop = self
			.stops
			.lock()
			.unwrap_or_else(|error| error.into_inner())
			.remove(remote);
		if let Some(stop) = stop {
			stop.store(true, Ordering::Relaxed);
		}
	}

	/// 停掉全部监视（关闭 SFTP 窗口时调用，避免线程一直留着）。
	fn stop_all(&self) {
		let mut map = self
			.stops
			.lock()
			.unwrap_or_else(|error| error.into_inner());
		for (_, stop) in map.drain() {
			stop.store(true, Ordering::Relaxed);
		}
	}
}

/// 取本地文件的修改时间；读不到（还没写或已被删除）时为 None。
fn modified(path: &Path) -> Option<std::time::SystemTime> {
	std::fs::metadata(path)
		.ok()
		.and_then(|meta| meta.modified().ok())
}

/// 远端文件落到本地。
fn download_to(
	connection: &Connection,
	remote: &Path,
	local: &Path,
) -> Result<(), String> {
	let mut source =
		connection.sftp.open(remote).map_err(|error| {
			format!("打开远程文件失败：{error}")
		})?;
	let mut target = std::fs::File::create(local)
		.map_err(|error| format!("写入临时文件失败：{error}"))?;
	copy(&mut source, &mut target)
		.map_err(|error| format!("下载失败：{error}"))?;
	Ok(())
}

/// 把本地改动写回远端。
fn upload_back(
	connection: &Connection,
	local: &Path,
	remote: &Path,
) -> Result<(), String> {
	let mut source = std::fs::File::open(local)
		.map_err(|error| format!("读取临时文件失败：{error}"))?;
	let mut target =
		connection.sftp.create(remote).map_err(|error| {
			format!("写入远程文件失败：{error}")
		})?;
	copy(&mut source, &mut target)
		.map_err(|error| format!("回传失败：{error}"))?;
	Ok(())
}

/// 把远程文件拉到临时目录并开始监视，返回可直接打开的本地路径。
///
/// 同一个远程路径重复打开时，旧的监视线程会被停掉再起新的，
/// 避免一个文件对应多个线程。
#[tauri::command(rename = "sftp_edit_remote")]
pub async fn edit_remote(
	app: tauri::AppHandle,
	pool: State<'_, SftpPool>,
	watchers: State<'_, EditWatchers>,
	job: TransferJob,
) -> Result<String, String> {
	let connections = pool.connections.clone();
	let stops = watchers.stops.clone();
	let remote = job.remote.clone();
	tauri::async_runtime::spawn_blocking(move || {
		let (key, host, port, username, password) =
			transfer_target(&job);
		let connection = obtain(
			&connections,
			&key,
			&host,
			port,
			&username,
			password.as_deref(),
		)?;

		// 1. 落到应用家目录据点的 tmp/：与日志同为本机运行产物，锚在
		//    ~/.tera-shell 下（副本含远端文件内容，不该散落在系统 TEMP）
		let name = Path::new(&remote)
			.file_name()
			.map(|value| value.to_string_lossy().into_owned())
			.unwrap_or_else(|| "remote-file".to_string());
		let directory = crate::data::home_anchor(&app).join("tmp");
		std::fs::create_dir_all(&directory).map_err(|error| {
			format!("创建临时目录失败：{error}")
		})?;
		// 顺手清一周前的旧编辑副本：目录进了家目录后系统不会再帮着清，
		// 越攒越多还留存着远端文件内容；正被外部程序占用的删不掉就随它去
		if let Ok(entries) = std::fs::read_dir(&directory) {
			for entry in entries.flatten() {
				let stale = entry
					.metadata()
					.ok()
					.and_then(|meta| meta.modified().ok())
					.and_then(|modified| {
						std::time::SystemTime::now()
							.duration_since(modified)
							.ok()
					})
					.is_some_and(|age| age.as_secs() > 7 * 24 * 3600);
				if stale {
					let _ = std::fs::remove_file(entry.path());
				}
			}
		}
		let local = directory.join(name);
		download_to(
			&connection,
			Path::new(&remote),
			&local,
		)?;
		info!(
			path = %local.display(),
			"已把远程文件拉到临时目录"
		);

		// 2. 同一远程路径只留一个监视线程
		let stop = Arc::new(AtomicBool::new(false));
		{
			let mut map = stops
				.lock()
				.unwrap_or_else(|error| error.into_inner());
			if let Some(previous) =
				map.insert(remote.clone(), stop.clone())
			{
				previous.store(true, Ordering::Relaxed);
			}
		}

		// 3. 后台盯着临时文件，保存即回传
		let watch_remote = remote.clone();
		let watch_connections = connections.clone();
		let local_path: PathBuf = local.clone();
		thread::spawn(move || {
			let mut last = modified(&local_path);
			loop {
				thread::sleep(POLL_INTERVAL);
				if stop.load(Ordering::Relaxed) {
					break;
				}
				let current = modified(&local_path);
				if current == last {
					continue;
				}
				last = current;
				// 编辑器可能中途重写文件，每次都重新取一次连接
				match obtain(
					&watch_connections,
					&key,
					&host,
					port,
					&username,
					password.as_deref(),
				) {
					Ok(connection) => {
						match upload_back(
							&connection,
							&local_path,
							Path::new(&watch_remote),
						) {
							Ok(()) => info!(
								path = %watch_remote,
								"本地改动已回传到远程"
							),
							Err(error) => warn!(
								"回传 {} 失败：{error}",
								watch_remote
							),
						}
					}
					Err(error) => warn!(
						"回传 {} 失败，连不上远程：{error}",
						watch_remote
					),
				}
			}
		});

		Ok(local.to_string_lossy().into_owned())
	})
	.await
	.map_err(|error| error.to_string())?
}

/// 停止监视某个远程文件的本地副本。
#[tauri::command(rename = "sftp_stop_edit")]
pub fn stop_edit(
	watchers: State<'_, EditWatchers>,
	remote: String,
) -> Result<(), String> {
	watchers.stop(&remote);
	Ok(())
}

/// 停止全部监视：关闭 SFTP 窗口时调用，避免后台线程一直留着。
#[tauri::command(rename = "sftp_stop_all_edits")]
pub fn stop_all_edits(
	watchers: State<'_, EditWatchers>,
) -> Result<(), String> {
	watchers.stop_all();
	Ok(())
}
