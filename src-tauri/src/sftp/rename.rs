//! 远程文件 / 目录重命名。

use std::path::Path;
use serde::Deserialize;
use tauri::State;
use tracing::info;

use crate::ssh::{JumpHop, SshTarget};

use super::{SftpPool, obtain};

/// 前端传入的重命名请求。
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RenameJob {
	host: String,
	port: Option<u16>,
	username: Option<String>,
	password: Option<String>,
	/// 跳板链（离客户端最近的一跳在前，前端已解开密码）。
	#[serde(default)]
	jump: Vec<JumpHop>,
	/// 设置里的默认私钥路径（与终端 `-i` 一致）。
	#[serde(default)]
	key_path: Option<String>,
	/// 原路径
	from: String,
	/// 新路径
	to: String,
}

/// 重命名远程文件或目录。
///
/// 连接参数的解析与 `transfer_target` 一致（默认 22 端口 / root 用户，
/// 支持跳板链与私钥），这里独立写一遍是为了让请求体语义清楚
/// （from / to），不用传输的 local / remote 字段硬套。
#[tauri::command(rename = "sftp_rename_path")]
pub async fn rename_remote(
	pool: State<'_, SftpPool>,
	request: RenameJob,
) -> Result<(), String> {
	let connections = pool.connections.clone();
	tauri::async_runtime::spawn_blocking(move || {
		let target = SshTarget::new(
			&request.host,
			request.port,
			request.username.as_deref(),
			request.password.as_deref(),
			request.key_path.as_deref(),
			request.jump.clone(),
		)?;
		let connection = obtain(&connections, &target)?;
		// None = 不覆盖同名目标，让"已存在"变成一条明确的错误
		connection
			.sftp
			.rename(
				Path::new(&request.from),
				Path::new(&request.to),
				None,
			)
			.map_err(|error| {
				format!("重命名远程文件失败：{error}")
			})?;
		info!(
			from = %request.from,
			to = %request.to,
			"已重命名远程文件"
		);
		Ok(())
	})
	.await
	.map_err(|error| error.to_string())?
}
