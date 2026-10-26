//! MCP 用的 SFTP 只读能力：列目录 / 读文件。
//!
//! 与 `browse`（带目录缓存 / 预取 / 图标，给前端文件树用）不同，这里只做
//! MCP 外部 agent 需要的**轻量只读**：按 session 连接目标连上 SFTP，列一个
//! 目录或读一个文件的文本内容。不做缓存、不预取、不生成图标。
//!
//! 只在主进程执行（经 bridge 调用）；子进程经 HTTP 转发，不碰凭据。

use std::io::Read;

use crate::ssh::SshTarget;

use super::pool::{SftpPool, obtain};

/// 读文件的最大字节数：外部 agent 一次读太多会把结果撑爆，且诊断价值
/// 通常在前几 KB。
const MAX_READ_BYTES: u64 = 256 * 1024;

/// 列一个远程目录，返回条目名列表（目录在前，同类按名称排序）。
///
/// 复用 `SftpPool` 的连接池（按目标缓存，与文件树共用同一条连接）。
pub(crate) fn list_remote_dir(
	pool: &SftpPool,
	target: &SshTarget,
	path: &str,
) -> Result<Vec<String>, String> {
	let connection = obtain(&pool.connections, target)?;
	let sftp = &connection.sftp;
	let entries = sftp
		.readdir(std::path::Path::new(path))
		.map_err(|error| format!("读取目录 {path} 失败：{error}"))?;
	let mut dirs = Vec::new();
	let mut files = Vec::new();
	for (entry_path, stat) in entries {
		let name = entry_path
			.file_name()
			.map(|value| value.to_string_lossy().into_owned())
			.unwrap_or_default();
		if name.is_empty() || name == "." || name == ".." {
			continue;
		}
		// 目录后带 `/`，文件带大小，方便外部 agent 一眼区分
		let rendered = if stat.is_dir() {
			format!("{name}/")
		} else {
			format!("{name}\t{}", stat.size.unwrap_or(0))
		};
		if stat.is_dir() {
			dirs.push(rendered);
		} else {
			files.push(rendered);
		}
	}
	dirs.sort();
	files.sort();
	dirs.extend(files);
	Ok(dirs)
}

/// 读一个远程文件的文本内容（UTF-8，超上限截断并注明）。
pub(crate) fn read_remote_file(
	pool: &SftpPool,
	target: &SshTarget,
	path: &str,
) -> Result<String, String> {
	let connection = obtain(&pool.connections, target)?;
	let sftp = &connection.sftp;
	let mut file = sftp
		.open(std::path::Path::new(path))
		.map_err(|error| format!("打开文件 {path} 失败：{error}"))?;
	// 限制读取量：先按上限读，超了就截断注明
	let mut buffer = Vec::new();
	let mut chunk = [0u8; 8192];
	let mut total: u64 = 0;
	loop {
		let read = file
			.read(&mut chunk)
			.map_err(|error| format!("读取 {path} 失败：{error}"))?;
		if read == 0 {
			break;
		}
		if total + read as u64 > MAX_READ_BYTES {
			// 只读满上限的那部分
			let room = (MAX_READ_BYTES - total) as usize;
			buffer.extend_from_slice(&chunk[..room]);
			total = MAX_READ_BYTES;
			break;
		}
		buffer.extend_from_slice(&chunk[..read]);
		total += read as u64;
	}
	let text = String::from_utf8_lossy(&buffer).into_owned();
	if total >= MAX_READ_BYTES {
		Ok(format!(
			"[文件过大，仅显示前 {} 字节]\n{text}",
			MAX_READ_BYTES
		))
	} else {
		Ok(text)
	}
}

/// 预览读取的上限：图片与文本预览都够用，再大该走下载。
const PREVIEW_MAX_BYTES: u64 = 2 * 1024 * 1024;

/// 内置预览的读取结果（base64 字节 + 截断标记）。
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PreviewContent {
	pub base64: String,
	/// 超过上限被截断（前端提示「仅显示前 2MB」）
	pub truncated: bool,
}

/// 读一个远程文件的字节（base64，限 2MB）——SFTP 双击内置预览用。
///
/// 与 `read_remote_file`（文本、给 MCP）分开：预览要原始字节（图片
/// data URL 直拼 base64），且上限不同。
pub(crate) fn read_remote_base64(
	pool: &SftpPool,
	target: &SshTarget,
	path: &str,
) -> Result<PreviewContent, String> {
	let connection = obtain(&pool.connections, target)?;
	let sftp = &connection.sftp;
	let mut file = sftp
		.open(std::path::Path::new(path))
		.map_err(|error| format!("打开文件 {path} 失败：{error}"))?;
	let mut buffer = Vec::new();
	let mut chunk = [0u8; 65536];
	let mut truncated = false;
	loop {
		let read = file
			.read(&mut chunk)
			.map_err(|error| format!("读取 {path} 失败：{error}"))?;
		if read == 0 {
			break;
		}
		if buffer.len() as u64 + read as u64 > PREVIEW_MAX_BYTES {
			let room =
				(PREVIEW_MAX_BYTES - buffer.len() as u64) as usize;
			buffer.extend_from_slice(&chunk[..room]);
			truncated = true;
			break;
		}
		buffer.extend_from_slice(&chunk[..read]);
	}
	Ok(PreviewContent {
		base64: base64_encode(&buffer),
		truncated,
	})
}

/// 标准库没有 base64：手写查表编码（预览量级 2MB，性能足够）。
fn base64_encode(data: &[u8]) -> String {
	const TABLE: &[u8; 64] =
		b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
	let mut out = String::with_capacity(data.len().div_ceil(3) * 4);
	for block in data.chunks(3) {
		let b0 = block[0] as u32;
		let b1 = *block.get(1).unwrap_or(&0) as u32;
		let b2 = *block.get(2).unwrap_or(&0) as u32;
		let triple = (b0 << 16) | (b1 << 8) | b2;
		out.push(TABLE[(triple >> 18) as usize & 63] as char);
		out.push(TABLE[(triple >> 12) as usize & 63] as char);
		out.push(if block.len() > 1 {
			TABLE[(triple >> 6) as usize & 63] as char
		} else {
			'='
		});
		out.push(if block.len() > 2 {
			TABLE[triple as usize & 63] as char
		} else {
			'='
		});
	}
	out
}

/// 读远程文件内容做内置预览（图片/文本双击直接看，不落临时文件）。
///
/// 签名与 remote_ops 同模式（收 TransferJob，`local` 留空）：
/// SshTarget 含非 serde 的策略枚举，命令参数层用裸字段。
#[tauri::command(rename = "sftp_read_preview")]
pub fn read_preview(
	pool: tauri::State<SftpPool>,
	job: super::transfer::TransferJob,
) -> Result<PreviewContent, String> {
	let target = super::transfer::transfer_target(&job)?;
	read_remote_base64(&pool, &target, &job.remote)
}
