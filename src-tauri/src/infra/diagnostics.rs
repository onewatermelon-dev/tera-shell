//! 一键诊断包：把日志、脱敏设置、版本与系统信息打成一个 zip。
//!
//! 用户提 issue 时最常卡在「日志在哪、怎么给」—— 设置 · 关于 与错误提示
//! 里都能一键导出，生成在桌面，直接拖进 issue 即可。
//!
//! 脱敏原则：**宁可多抹，不漏一个**。键名里出现 key / token / secret /
//! password / credential 的一律替换成占位符（误伤一条快捷键注释无所谓，
//! 泄露一个密钥是事故）。

use std::fs::{self, File};
use std::io::Write;
use std::path::{Path, PathBuf};

use serde_json::Value;
use tauri::{AppHandle, Manager};

/// 打包结果：前端据此提示「存到哪了、装了几个文件」。
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BundleInfo {
	pub path: String,
	pub files: usize,
}

/// 日志根目录（与 `infra::logging` 的落盘位置一致）。
fn log_root(app: &AppHandle) -> PathBuf {
	crate::data::home_anchor(app).join("logs")
}

/// 输出目录：优先桌面，取不到退回主目录。
fn output_dir(app: &AppHandle) -> PathBuf {
	let paths = app.path();
	paths
		.desktop_dir()
		.or_else(|_| paths.home_dir())
		.unwrap_or_else(|_| PathBuf::from("."))
}

/// Unix 秒 → UTC 的 (年, 月, 日, 时, 分, 秒)。
///
/// 只用在文件名和 info.txt 上，不引时间库（项目没有 chrono）；
/// 算法是 Howard Hinnant 的 civil_from_days，纯整数运算。
fn to_utc(secs: u64) -> (i64, u32, u32, u32, u32, u32) {
	let days = (secs / 86_400) as i64;
	let rem = secs % 86_400;
	let hh = (rem / 3_600) as u32;
	let mm = ((rem % 3_600) / 60) as u32;
	let ss = (rem % 60) as u32;
	let z = days + 719_468;
	let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
	let doe = z - era * 146_097;
	let yoe = (doe - doe / 1_460 + doe / 36_524 - doe / 146_096) / 365;
	let y = yoe + era * 400;
	let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
	let mp = (5 * doy + 2) / 153;
	let day = (doy - (153 * mp + 2) / 5 + 1) as u32;
	let month = if mp < 10 { mp + 3 } else { mp - 9 } as u32;
	let year = if month <= 2 { y + 1 } else { y };
	(year, month, day, hh, mm, ss)
}

/// 文件名用的时间戳：`20261022-225630`。
fn stamp() -> String {
	let secs = std::time::SystemTime::now()
		.duration_since(std::time::UNIX_EPOCH)
		.map(|value| value.as_secs())
		.unwrap_or_default();
	let (y, m, d, hh, mm, ss) = to_utc(secs);
	format!("{y}{m:02}{d:02}-{hh:02}{mm:02}{ss:02}")
}

/// 极简 ZIP 写入器：只做 STORE（不压缩）。
///
/// 为什么不引 `zip` crate：它要连带下载 zip / zopfli / zlib-rs 等包，
/// 构建机（离线 / 代理不稳）会直接失败；诊断包里主要是文本日志，压缩
/// 收益有限，STORE 完全够用，实现也就一百来行。
///
/// 结构：`[本地头 + 名称 + 数据] × N` → `[中央目录项 × N]` → EOCD。
struct StoredZip<W: Write> {
	out: W,
	/// 中央目录先缓存在内存（每项几十字节，跟文件数成正比）
	central: Vec<u8>,
	count: u16,
	/// 已写出的字节数（= 下一个本地头的偏移）
	offset: u32,
}

impl<W: Write> StoredZip<W> {
	fn new(out: W) -> Self {
		Self {
			out,
			central: Vec::new(),
			count: 0,
			offset: 0,
		}
	}

	/// 追加一个文件。文件名按 UTF-8 写入（通用标志位第 11 位）。
	fn add(&mut self, name: &str, data: &[u8]) -> std::io::Result<()> {
		if self.count == u16::MAX {
			return Err(std::io::Error::new(
				std::io::ErrorKind::InvalidInput,
				"诊断包条目过多",
			));
		}
		let crc = crc32fast::hash(data);
		let name_bytes = name.as_bytes();
		let size = data.len() as u32;
		let local_offset = self.offset;
		// DOS 日期固定成 2020-01-01（用户不看 zip 内部时间，合法即可）
		const DOS_DATE: u16 = 0x5021;
		const DOS_TIME: u16 = 0;

		let mut local = Vec::with_capacity(30);
		local.extend_from_slice(&0x0403_4b50u32.to_le_bytes());
		local.extend_from_slice(&20u16.to_le_bytes());
		local.extend_from_slice(&0x0800u16.to_le_bytes());
		local.extend_from_slice(&0u16.to_le_bytes());
		local.extend_from_slice(&DOS_TIME.to_le_bytes());
		local.extend_from_slice(&DOS_DATE.to_le_bytes());
		local.extend_from_slice(&crc.to_le_bytes());
		local.extend_from_slice(&size.to_le_bytes());
		local.extend_from_slice(&size.to_le_bytes());
		local.extend_from_slice(&(name_bytes.len() as u16).to_le_bytes());
		local.extend_from_slice(&0u16.to_le_bytes());
		self.out.write_all(&local)?;
		self.out.write_all(name_bytes)?;
		self.out.write_all(data)?;
		self.offset += (local.len() + name_bytes.len() + data.len()) as u32;

		self.central
			.extend_from_slice(&0x0201_4b50u32.to_le_bytes());
		self.central
			.extend_from_slice(&20u16.to_le_bytes());
		self.central
			.extend_from_slice(&20u16.to_le_bytes());
		self.central
			.extend_from_slice(&0x0800u16.to_le_bytes());
		self.central
			.extend_from_slice(&0u16.to_le_bytes());
		self.central
			.extend_from_slice(&DOS_TIME.to_le_bytes());
		self.central
			.extend_from_slice(&DOS_DATE.to_le_bytes());
		self.central
			.extend_from_slice(&crc.to_le_bytes());
		self.central
			.extend_from_slice(&size.to_le_bytes());
		self.central
			.extend_from_slice(&size.to_le_bytes());
		self.central
			.extend_from_slice(&(name_bytes.len() as u16).to_le_bytes());
		self.central
			.extend_from_slice(&0u16.to_le_bytes());
		self.central
			.extend_from_slice(&0u16.to_le_bytes());
		self.central
			.extend_from_slice(&0u16.to_le_bytes());
		self.central
			.extend_from_slice(&0u16.to_le_bytes());
		self.central
			.extend_from_slice(&0u32.to_le_bytes());
		self.central
			.extend_from_slice(&local_offset.to_le_bytes());
		self.central.extend_from_slice(name_bytes);
		self.count += 1;
		Ok(())
	}

	/// 写完中央目录与 EOCD。
	fn finish(mut self) -> std::io::Result<W> {
		let central_offset = self.offset;
		let central_len = self.central.len() as u32;
		self.out.write_all(&self.central)?;
		let mut end = Vec::with_capacity(22);
		end.extend_from_slice(&0x0605_4b50u32.to_le_bytes());
		end.extend_from_slice(&0u16.to_le_bytes());
		end.extend_from_slice(&0u16.to_le_bytes());
		end.extend_from_slice(&self.count.to_le_bytes());
		end.extend_from_slice(&self.count.to_le_bytes());
		end.extend_from_slice(&central_len.to_le_bytes());
		end.extend_from_slice(&central_offset.to_le_bytes());
		end.extend_from_slice(&0u16.to_le_bytes());
		self.out.write_all(&end)?;
		self.out.flush()?;
		Ok(self.out)
	}
}

fn is_secret_key(key: &str) -> bool {
	let lower = key.to_ascii_lowercase();
	[
		"key",
		"token",
		"secret",
		"password",
		"passwd",
		"credential",
		"cookie",
		"auth",
	]
	.iter()
	.any(|needle| lower.contains(needle))
}

/// 递归把敏感字段的值替换成占位符。
fn redact(value: &mut Value) {
	match value {
		Value::Object(map) => {
			for (key, child) in map.iter_mut() {
				if is_secret_key(key) {
					*child = Value::String("***（已脱敏）".to_string());
				} else {
					redact(child);
				}
			}
		}
		Value::Array(items) => {
			for item in items.iter_mut() {
				redact(item);
			}
		}
		_ => {}
	}
}

/// 取最近 `days` 天的日志文件：(zip 内路径, 磁盘路径)。
///
/// 日期目录名是 `yyyy-MM-dd`，按字符串排序就是按时间排序，不用解析日期；
/// 取不到任何日志也不算失败（首次运行就是这样），只是包里没有 logs/。
fn collect_logs(root: &Path, days: u32) -> Vec<(String, PathBuf)> {
	let mut dirs: Vec<(String, PathBuf)> = match fs::read_dir(root) {
		Ok(entries) => entries
			.filter_map(|entry| entry.ok())
			.filter(|entry| entry.path().is_dir())
			.map(|entry| {
				(entry.file_name().to_string_lossy().into_owned(), entry.path())
			})
			.collect(),
		Err(_) => return Vec::new(),
	};
	dirs.sort_by(|a, b| a.0.cmp(&b.0));
	let keep = days.max(1) as usize;
	if dirs.len() > keep {
		dirs.drain(0..dirs.len() - keep);
	}
	let mut out = Vec::new();
	for (name, dir) in dirs {
		if let Ok(entries) = fs::read_dir(&dir) {
			for entry in entries.filter_map(|item| item.ok()) {
				let path = entry.path();
				if path.is_file() {
					let file = entry.file_name().to_string_lossy().into_owned();
					out.push((format!("logs/{name}/{file}"), path));
				}
			}
		}
	}
	out
}

/// 生成一个诊断包，返回它的路径。
fn write_bundle(app: &AppHandle, days: u32) -> Result<BundleInfo, String> {
	let logs = collect_logs(&log_root(app), days);
	let target = output_dir(app).join(format!("tera-shell-diagnostics-{}.zip", stamp()));
	let file = File::create(&target)
		.map_err(|error| format!("创建诊断包失败：{error}"))?;
	let mut zip = StoredZip::new(file);
	let mut files = 0usize;

	for (name, path) in &logs {
		let Ok(bytes) = fs::read(path) else {
			// 单个日志读不出来不该让整包失败（可能正好在滚动）
			continue;
		};
		zip.add(name, &bytes)
			.map_err(|error| format!("写入日志条目失败：{error}"))?;
		files += 1;
	}

	// 设置：读不到就跳过（首次运行可能还没保存过）
	if let Some(text) = crate::data::read_setting_text(app, "settings") {
		let mut value: Value = serde_json::from_str(&text).unwrap_or(Value::Null);
		redact(&mut value);
		let pretty = serde_json::to_string_pretty(&value).unwrap_or_else(|_| "{}".into());
		zip.add("settings.redacted.json", pretty.as_bytes())
			.map_err(|error| format!("写入设置失败：{error}"))?;
		files += 1;
	}

	let secs = std::time::SystemTime::now()
		.duration_since(std::time::UNIX_EPOCH)
		.map(|value| value.as_secs())
		.unwrap_or_default();
	let (y, m, d, hh, mm, ss) = to_utc(secs);
	let info = format!(
		"应用版本: {}\n构建目标: {} {}\n导出时间(UTC): {y}-{m:02}-{d:02} {hh:02}:{mm:02}:{ss:02}\n日志目录: {}\n数据目录: {}\n包含日志天数: {days}\n日志文件数: {}\n",
		app.package_info().version,
		std::env::consts::OS,
		std::env::consts::ARCH,
		log_root(app).display(),
		crate::data::current_root(app.clone()),
		logs.len(),
	)
	.trim_end()
	.to_string();
	zip.add("info.txt", info.as_bytes())
		.map_err(|error| format!("写入信息失败：{error}"))?;
	files += 1;

	zip.finish()
		.map_err(|error| format!("收尾失败：{error}"))?;
	Ok(BundleInfo {
		path: target.to_string_lossy().into_owned(),
		files,
	})
}

/// 导出诊断包（默认近 3 天日志）。桌面写不进去时退回主目录。
#[tauri::command(rename = "diagnostics_export")]
pub async fn export_bundle(
	app: AppHandle,
	days: Option<u32>,
) -> Result<BundleInfo, String> {
	tauri::async_runtime::spawn_blocking(move || write_bundle(&app, days.unwrap_or(3)))
		.await
		.map_err(|error| format!("导出诊断包失败：{error}"))?
}

/// 在文件管理器里打开日志目录（不存在就先建）。
#[tauri::command(rename = "diagnostics_open_logs")]
pub fn open_logs(app: AppHandle) -> Result<String, String> {
	use tauri_plugin_opener::OpenerExt;
	let dir = log_root(&app);
	fs::create_dir_all(&dir)
		.map_err(|error| format!("创建日志目录失败：{error}"))?;
	app.opener()
		.open_path(dir.to_string_lossy().as_ref(), None::<&str>)
		.map_err(|error| format!("打开日志目录失败：{error}"))?;
	Ok(dir.to_string_lossy().into_owned())
}

#[cfg(test)]
#[path = "../../tests/unit/diagnostics.rs"]
mod tests;
