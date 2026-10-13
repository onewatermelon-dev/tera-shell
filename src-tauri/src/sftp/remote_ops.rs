//! 远程文件操作：新建 / 删除 / 权限 / 归档 / 磁盘用量 / 同服务器拷贝。
//!
//! SFTP 协议没有的能力（服务端拷贝、tar/unzip、df/du）走同一条 SSH
//! 会话的 exec 通道让服务器自己做；协议内的操作（mkdir / unlink /
//! setstat）直接下发。

use serde::Serialize;
use ssh2::{Sftp, Session};
use std::{
	io::Read,
	path::Path,
	sync::{Arc, Mutex},
};
use tauri::State;
use tracing::info;

use super::pool::{SftpPool, obtain};
use super::transfer::{
	TransferContext, TransferJob, TransferPolicy, Transfers, is_dot_entry,
	measure_remote, transfer_target,
};

/// 远程新建目录（`job.local` 不使用，传空串即可）。
// 函数名不能与 fs.rs 的 make_dir / remove_path 同名：
// tauri::command 宏按函数名生成内部符号，重名会导致重复定义。
#[tauri::command(rename = "sftp_make_dir")]
pub async fn make_remote_dir(
	pool: State<'_, SftpPool>,
	job: TransferJob,
) -> Result<(), String> {
	let connections = pool.connections.clone();
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
		connection
			.sftp
			.mkdir(Path::new(&job.remote), 0o755)
			.map_err(|error| {
				format!(
					"新建远程目录 {} 失败：{error}",
					job.remote
				)
			})
	})
	.await
	.map_err(|error| error.to_string())?
}

/// 递归删除远程路径：目录先清空子项再删自身。
///
/// `rmdir` 只能删空目录，带内容的文件夹必须先递归进去。
/// 每删掉一个文件就把它的字节数记进进度，复用传输面板展示。
fn remove_remote_recursive(
	sftp: &Sftp,
	path: &Path,
	context: &mut TransferContext<'_>,
) -> Result<(), String> {
	let stat = sftp.stat(path).map_err(|error| {
		format!("读取远程 {} 失败：{error}", path.display())
	})?;
	if !stat.is_dir() {
		let size = stat.size.unwrap_or(0);
		sftp.unlink(path).map_err(|error| {
			format!("删除远程文件 {} 失败：{error}", path.display())
		})?;
		return context.advance(size);
	}
	let entries = sftp.readdir(path).map_err(|error| {
		format!("读取远程目录 {} 失败：{error}", path.display())
	})?;
	for (child, _) in entries {
		if is_dot_entry(&child) {
			continue;
		}
		remove_remote_recursive(sftp, &child, context)?;
	}
	sftp.rmdir(path).map_err(|error| {
		format!("删除远程目录 {} 失败：{error}", path.display())
	})
}

/// 远程删除文件或目录（目录按递归删除；`job.local` 不使用，传空串即可）。
///
/// 与上传 / 下载共用进度事件，所以在底部面板里也是一条普通任务。
#[tauri::command(rename = "sftp_remove_path")]
pub async fn remove_remote_path(
	app: tauri::AppHandle,
	pool: State<'_, SftpPool>,
	transfers: State<'_, Transfers>,
	job: TransferJob,
) -> Result<(), String> {
	let connections = pool.connections.clone();
	let control = transfers.register(&job.id);
	let id = job.id.clone();
	let cleanup_id = id.clone();
	let result = tauri::async_runtime::spawn_blocking(
		move || {
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
			let remote = Path::new(&job.remote);
			// 先算总量，删除进度才有分母
			let total = measure_remote(&connection.sftp, remote);
			let mut context = TransferContext::new(
				&app,
				&control,
				&id,
				// 删除没有"落点冲突"概念，策略占位
				TransferPolicy::Overwrite,
				total,
			);
			remove_remote_recursive(
				&connection.sftp,
				remote,
				&mut context,
			)?;
			context.report(true);
			info!(bytes = context.moved, "已删除 {}", job.remote);
			Ok(())
		},
	)
	.await
	.map_err(|error| error.to_string())?;
	transfers.unregister(&cleanup_id);
	result
}

/// 远程新建空文件（`job.local` 不使用，传空串即可）。
#[tauri::command(rename = "sftp_create_file")]
pub async fn create_remote_file(
	pool: State<'_, SftpPool>,
	job: TransferJob,
) -> Result<(), String> {
	let connections = pool.connections.clone();
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
		// sftp.create 会按 O_WRONLY|O_CREAT|O_TRUNC 打开，立即关闭即为空文件
		connection
			.sftp
			.create(Path::new(&job.remote))
			.map(|_| ())
			.map_err(|error| {
				format!(
					"新建远程文件 {} 失败：{error}",
					job.remote
				)
			})
	})
	.await
	.map_err(|error| error.to_string())?
}

/// 修改远程文件 / 目录的权限位（`job.local` 不使用，传空串即可）。
///
/// `mode` 是 Unix 权限的八进制值（例如 0o755），只取低 9 位。
#[tauri::command(rename = "sftp_chmod")]
pub async fn chmod(
	pool: State<'_, SftpPool>,
	job: TransferJob,
	mode: u32,
) -> Result<(), String> {
	let connections = pool.connections.clone();
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
		// ssh2 没有单独的 chmod：构造一份只带 perm 的 FileStat，
		// 交给 setstat 下发（其余字段留 None，不会被改动）
		let stat = ssh2::FileStat {
			size: None,
			uid: None,
			gid: None,
			perm: Some(mode & 0o777),
			atime: None,
			mtime: None,
		};
		connection
			.sftp
			.setstat(Path::new(&job.remote), stat)
			.map_err(|error| {
				format!(
					"修改 {} 的权限失败：{error}",
					job.remote
				)
			})
	})
	.await
	.map_err(|error| error.to_string())?
}

/// 单引号包裹的 shell 字面量：路径可能带空格与引号。
fn shell_quote(value: &str) -> String {
	format!("'{}'", value.replace('\'', "'\\''"))
}

/// 在连接的会话上执行一条 shell 命令。
///
/// 返回 (stdout, stderr, 退出码)：archive 这类操作要靠退出码与
/// stderr 报错，df/du 那类只看 stdout。
fn exec_output(
	session: &Arc<Mutex<Session>>,
	command: &str,
) -> Result<(String, String, i32), String> {
	let mut channel = session
		.lock()
		.unwrap_or_else(|error| error.into_inner())
		.channel_session()
		.map_err(|error| {
			format!("打开命令通道失败：{error}")
		})?;
	channel
		.exec(command)
		.map_err(|error| format!("执行命令失败：{error}"))?;
	let mut stdout = String::new();
	channel
		.read_to_string(&mut stdout)
		.map_err(|error| format!("读取命令输出失败：{error}"))?;
	let mut stderr = String::new();
	channel
		.stderr()
		.read_to_string(&mut stderr)
		.map_err(|error| format!("读取命令错误输出失败：{error}"))?;
	let _ = channel.wait_close();
	let status = channel.exit_status().unwrap_or(-1);
	Ok((stdout, stderr, status))
}

/// 解析 `df -P -k` 最后一条数据行：返回 (总容量, 可用) 字节数。
///
/// -P 是 POSIX 定宽格式：Filesystem 1024-blocks Used Available Capacity Mounted。
/// 挂载点带空格也不影响 —— 取的是前面几列。
fn parse_df(output: &str) -> Option<(u64, u64)> {
	let last = output
		.lines()
		.filter(|line| !line.trim().is_empty())
		.last()?;
	let mut fields = last.split_whitespace();
	let _filesystem = fields.next()?;
	let blocks: u64 = fields.next()?.parse().ok()?;
	let _used: u64 = fields.next()?.parse().ok()?;
	let available: u64 = fields.next()?.parse().ok()?;
	Some((blocks * 1024, available * 1024))
}

/// 解析 `du -s -k` 输出：目录累计大小（字节）。
fn parse_du(output: &str) -> Option<u64> {
	output
		.lines()
		.next()?
		.split_whitespace()
		.next()?
		.parse::<u64>()
		.ok()
		.map(|blocks| blocks * 1024)
}

/// 远程磁盘用量（状态栏展示用）。
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteDiskUsage {
	/// 落点所在文件系统的总容量
	total_bytes: u64,
	/// 可用空间
	free_bytes: u64,
	/// 当前目录累计大小（du 拿不到时为 0）
	dir_bytes: u64,
}

/// 查询远程磁盘用量：df 给容量与可用空间，du 给当前目录累计大小。
///
/// 用 SFTP 所在的同一条会话开 exec 通道跑 shell（ssh2 协议本身拿不到
/// statvfs）。du 是非致命项 —— 超大目录会跑满会话超时，失败时置 0，
/// 容量与可用空间照常显示。
#[tauri::command(rename = "sftp_disk_usage")]
pub async fn disk_usage(
	pool: State<'_, SftpPool>,
	job: TransferJob,
) -> Result<RemoteDiskUsage, String> {
	let connections = pool.connections.clone();
	let (key, host, port, username, password) =
		transfer_target(&job);
	let remote = job.remote.clone();
	tauri::async_runtime::spawn_blocking(move || {
		let connection = obtain(
			&connections,
			&key,
			&host,
			port,
			&username,
			password.as_deref(),
		)?;
		let quoted = shell_quote(&remote);
		let (df_output, _, _) = exec_output(
			&connection.session,
			&format!("df -P -k {quoted}"),
		)?;
		let (total_bytes, free_bytes) =
			parse_df(&df_output)
				.ok_or_else(|| {
					"无法解析 df 输出".to_string()
				})?;
		let dir_bytes = exec_output(
			&connection.session,
			&format!("du -s -k {quoted}"),
		)
		.ok()
		.and_then(|(output, _, _)| parse_du(&output))
		.unwrap_or(0);
		Ok(RemoteDiskUsage {
			total_bytes,
			free_bytes,
			dir_bytes,
		})
	})
	.await
	.map_err(|error| error.to_string())?
}

/// 远程归档：compress = tar.gz 打包，extract = 按扩展名解压到所在目录。
///
/// 走同一条会话的 exec 通道跑 tar / unzip（远程解压没有协议级支持）。
/// tar 几乎每台服务器都有所以压缩只出 tar.gz；解压按扩展名分流，
/// zip 交给 unzip（最小化安装经常没有，失败会带 stderr 报出来）。
#[tauri::command(rename = "sftp_archive")]
pub async fn archive(
	pool: State<'_, SftpPool>,
	job: TransferJob,
	mode: String,
	paths: Vec<String>,
	target: String,
) -> Result<(), String> {
	let connections = pool.connections.clone();
	let (key, host, port, username, password) =
		transfer_target(&job);
	tauri::async_runtime::spawn_blocking(move || {
		let connection = obtain(
			&connections,
			&key,
			&host,
			port,
			&username,
			password.as_deref(),
		)?;
		let command = match mode.as_str() {
			"compress" => {
				if paths.is_empty() {
					return Err("没有要压缩的条目".into());
				}
				// 逐条 `-C 父目录 相对名`：成员路径不带绝对前缀。
				// 绝对路径会被 tar 剥掉首斜杠（成员变成 root/...），
				// 解包时 -C 指定的目录下会多出一层宿主路径。
				let mut parts: Vec<String> = Vec::new();
				for path in &paths {
					let file = Path::new(path);
					let dir = file
						.parent()
						.unwrap_or(Path::new("."))
						.to_string_lossy()
						.into_owned();
					let name = file
						.file_name()
						.map(|value| {
							value.to_string_lossy().into_owned()
						})
						.ok_or("路径没有文件名")?;
					parts.push(format!(
						"-C {} {}",
						shell_quote(&dir),
						shell_quote(&name)
					));
				}
				format!(
					"tar -czf {} {}",
					shell_quote(&target),
					parts.join(" ")
				)
			}
			"extract" => {
				let archive = paths
					.first()
					.ok_or("没有要解压的文件")?;
				// 解到压缩包所在目录（= 触发操作时的当前目录）
				let dir = Path::new(archive)
					.parent()
					.unwrap_or(Path::new("."))
					.to_string_lossy()
					.into_owned();
				if archive.to_lowercase().ends_with(".zip") {
					format!(
						"unzip -o {} -d {}",
						shell_quote(archive),
						shell_quote(&dir)
					)
				} else {
					// tar -f 自动识别 gz/bz2/xz 压缩
					format!(
						"tar -xf {} -C {}",
						shell_quote(archive),
						shell_quote(&dir)
					)
				}
			}
			_ => {
				return Err(format!(
					"未知归档操作：{mode}"
				))
			}
		};
		let (stdout, stderr, status) =
			exec_output(&connection.session, &command)?;
		info!(
			mode = %mode,
			status,
			stdout = %stdout.trim(),
			stderr = %stderr.trim(),
			command = %command,
			"远程归档执行结束"
		);
		if status != 0 {
			let reason = if stderr.trim().is_empty() {
				stdout.trim()
			} else {
				stderr.trim()
			};
			return Err(format!(
				"命令失败（退出码 {status}）：{reason}"
			));
		}
		Ok(())
	})
	.await
	.map_err(|error| error.to_string())?
}

/// 远程同服务器文件操作：copy = `cp -a`，move = `mv`。
///
/// SFTP 协议没有服务端复制，走同一条会话的 exec 通道让服务器自己做 ——
/// 数据不过本机中转，目录递归与权限保留都交给 `cp -a`。
#[tauri::command(rename = "sftp_remote_fs")]
pub async fn remote_fs(
	pool: State<'_, SftpPool>,
	job: TransferJob,
	mode: String,
	paths: Vec<String>,
	target_dir: String,
) -> Result<(), String> {
	let connections = pool.connections.clone();
	let (key, host, port, username, password) =
		transfer_target(&job);
	tauri::async_runtime::spawn_blocking(move || {
		let connection = obtain(
			&connections,
			&key,
			&host,
			port,
			&username,
			password.as_deref(),
		)?;
		let operation = match mode.as_str() {
			"copy" => "cp -a",
			"move" => "mv",
			_ => {
				return Err(format!(
					"未知文件操作：{mode}"
				))
			}
		};
		// 源在前、目标目录最后；目录递归与权限保留由 cp -a / mv 自理
		let mut quoted: Vec<String> = paths
			.iter()
			.map(|path| shell_quote(path))
			.collect();
		quoted.push(shell_quote(&target_dir));
		let command =
			format!("{operation} {}", quoted.join(" "));
		let (stdout, stderr, status) =
			exec_output(&connection.session, &command)?;
		info!(
			mode = %mode,
			status,
			count = paths.len(),
			command = %command,
			stderr = %stderr.trim(),
			"远程文件操作执行结束"
		);
		if status != 0 {
			let reason = if stderr.trim().is_empty() {
				stdout.trim()
			} else {
				stderr.trim()
			};
			return Err(format!(
				"命令失败（退出码 {status}）：{reason}"
			));
		}
		Ok(())
	})
	.await
	.map_err(|error| error.to_string())?
}

// 单元测试集中在 src-tauri/tests/unit/：#[path] 把模块编回本处，私有项仍可
// 访问；tests/ 下的直接子文件才是 cargo 的集成测试目标，子目录不自动发现。
#[cfg(test)]
#[path = "../../tests/unit/sftp_remote_ops.rs"]
mod disk_usage_tests;
