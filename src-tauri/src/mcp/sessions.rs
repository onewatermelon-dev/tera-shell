//! MCP Server 的只读数据源：定位数据目录、读取会话元数据。
//!
//! MCP 子进程没有 `AppHandle`，用 `dirs::home_dir()` 拿主目录，再经
//! `data::resolve_data_dir_from` 解析出与 GUI 主进程一致的数据目录，
//! 直接读 `sessions.json`。
//!
//! ⚠️ 这里**只做只读**：列会话、读元数据。任何命令执行 / SFTP / 审批都
//! 必须回到 GUI 主进程（经本地 HTTP + token），子进程绝不直接碰连接。

use std::path::{Path, PathBuf};

use serde::Serialize;

/// 一条会话在 MCP 侧暴露的最小元数据 —— **不含密码 / 跳板引用链**。
///
/// 密码是 DPAPI 密文且不该出本机，跳板引用是会话 id（外部 agent 无法
/// 解析），所以这里只给「外部 agent 选会话」需要的字段。
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionMeta {
	pub id: String,
	pub name: String,
	/// `local`（本地 shell）或 `ssh`
	pub kind: String,
	pub host: String,
	pub port: u16,
	pub username: String,
}

/// sessions.json 里的一条原始记录（宽松解析：只取用到的字段，其余忽略）。
#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct RawSession {
	id: String,
	#[serde(default)]
	name: String,
	#[serde(default)]
	kind: String,
	#[serde(default)]
	host: String,
	#[serde(default)]
	port: u16,
	#[serde(default)]
	username: String,
}

/// 定位用户主目录（MCP 子进程用；取不到退回当前目录）。
///
/// 与 Tauri 的 `app.path().home_dir()` 同源：Windows 读 `USERPROFILE`、
/// 其它平台读 `HOME`。用标准库实现，避免给子进程引入额外依赖。
fn home_dir() -> PathBuf {
	if cfg!(windows) {
		if let Some(home) = std::env::var_os("USERPROFILE") {
			return PathBuf::from(home);
		}
	}
	if let Some(home) = std::env::var_os("HOME") {
		return PathBuf::from(home);
	}
	PathBuf::from(".")
}

/// 解析出与 GUI 主进程一致的数据目录（已带 `.tera-shell` 后缀）。
pub fn data_dir() -> PathBuf {
	crate::data::resolve_data_dir_from(&home_dir())
}

/// 读取已保存的会话列表（`sessions.json`），返回不含凭据的元数据。
///
/// 文件缺失 / 解析失败返回空列表（首次启动 / 数据损坏时，列不出会话
/// 比报错更符合 MCP 工具的「尽力而为」语义 —— 外部 agent 会看到空列表
/// 并据此提示用户先配置会话）。
pub fn list_sessions() -> Vec<SessionMeta> {
	sessions_from(&data_dir())
}

/// 按 id 查一条会话元数据；找不到返回 `None`。
pub fn find_session(id: &str) -> Option<SessionMeta> {
	list_sessions()
		.into_iter()
		.find(|session| session.id == id)
}

/// 校验会话 id 是否存在（供 `run_command` 等需要指定会话的工具前置检查）。
pub fn session_exists(id: &str) -> bool {
	!id.is_empty() && find_session(id).is_some()
}

/// 从指定目录读 `sessions.json`（抽成纯函数，测试可注入任意目录）。
fn sessions_from(dir: &Path) -> Vec<SessionMeta> {
	let path = dir.join("sessions.json");
	let Ok(text) = std::fs::read_to_string(&path) else {
		return Vec::new();
	};
	let Ok(raw) = serde_json::from_str::<Vec<RawSession>>(&text) else {
		return Vec::new();
	};
	raw.into_iter()
		.filter(|session| !session.id.is_empty())
		.map(|session| SessionMeta {
			id: session.id,
			name: if session.name.is_empty() {
				session.host.clone()
			} else {
				session.name
			},
			kind: if session.kind == "ssh" {
				"ssh".to_string()
			} else {
				"local".to_string()
			},
			host: session.host,
			port: session.port,
			username: session.username,
		})
		.collect()
}

#[cfg(test)]
#[path = "../../tests/unit/mcp_sessions.rs"]
mod tests;
