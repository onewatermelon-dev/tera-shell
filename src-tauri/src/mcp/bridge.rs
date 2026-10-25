//! MCP Server 的本地 HTTP 桥：主进程侧。
//!
//! GUI 主进程启动一个只监听 `127.0.0.1` 的 axum 服务，供 `tera-shell-mcp`
//! 子进程调用。子进程是**协议层**（stdio MCP），它需要执行命令 / 查已打开
//! 会话 / 列目录时，经这个桥把请求转发给主进程 —— 因为 SSH 会话、审批 UI、
//! 凭据都在主进程里，子进程一概不碰。
//!
//! ## 信任边界
//!
//! - 只绑 127.0.0.1，端口随机；
//! - 每个请求必须带 `Authorization: Bearer <token>`，token 由主进程生成、
//!   经数据目录 `mcp_bridge.json` 传给子进程；
//! - 所有写操作（命令执行）在主窗口审批后才放行（S3 起）。
//!
//! ## 端口 / token 的传递
//!
//! 主进程启动时生成随机端口 + token，写到数据目录 `mcp_bridge.json`；
//! 子进程启动时读它拿到地址与 token。不依赖环境变量 —— 外部 agent 拉起
//! 子进程时无需手动配 env。

use std::{
	collections::HashMap,
	sync::{Arc, Mutex},
};

use axum::{
	Json, Router,
	extract::State,
	http::{HeaderMap, StatusCode},
	routing::get,
};
use serde::Serialize;
use tracing::warn;

use super::token;

/// bridge 配置文件在数据目录里的文件名。
pub const BRIDGE_FILE: &str = "mcp_bridge.json";

/// 主进程写入的 bridge 配置：子进程据此连过来。
#[derive(Serialize, serde::Deserialize)]
pub struct BridgeConfig {
	/// 监听端口（127.0.0.1）。
	pub port: u16,
	/// 访问令牌。
	pub token: String,
}

/// 一条「已打开会话」的元数据（登记在终端启动时，不含密码）。
///
/// 主进程侧 Serialize 返回给 HTTP bridge，子进程侧 Deserialize 解析，
/// 两边字段名必须一致（camelCase）。
#[derive(Clone, Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OpenSessionMeta {
	pub id: String,
	pub kind: String,
	pub host: String,
	pub port: u16,
	pub username: String,
}

/// 已打开会话登记表：`session_id → 元数据`。
///
/// 由 `terminal::start` 登记、`terminal::close` 移除。独立于 `Terminals`
/// （那里只存 PTY），这里只存「MCP 需要知道的连接信息」。
///
/// 内部用 `Arc` 共享同一份 map：`.manage` 一个实例供 `State` 提取，同时
/// `start_bridge` 拿到同一个实例的克隆塞进 HTTP handler。
#[derive(Default, Clone)]
pub struct OpenSessions(Arc<Mutex<HashMap<String, OpenSessionMeta>>>);

impl OpenSessions {
	/// 登记一条打开的会话。
	pub fn register(&self, meta: OpenSessionMeta) {
		let mut map = self
			.0
			.lock()
			.unwrap_or_else(|error| error.into_inner());
		map.insert(meta.id.clone(), meta);
	}

	/// 移除一条会话（终端关闭时）。
	pub fn remove(&self, id: &str) {
		let mut map = self
			.0
			.lock()
			.unwrap_or_else(|error| error.into_inner());
		map.remove(id);
	}

	/// 快照当前所有已打开会话。
	pub fn snapshot(&self) -> Vec<OpenSessionMeta> {
		let map = self
			.0
			.lock()
			.unwrap_or_else(|error| error.into_inner());
		let mut list: Vec<OpenSessionMeta> =
			map.values().cloned().collect();
		list.sort_by(|a, b| a.id.cmp(&b.id));
		list
	}
}

/// bridge 服务的共享状态：token + 已打开会话表。
pub(crate) struct BridgeState {
	token: String,
	open: OpenSessions,
}

/// 构造 bridge 的共享状态（供 mod.rs 在 spawn 前组装）。
pub(crate) fn serve_state(
	token: String,
	open: OpenSessions,
) -> BridgeState {
	BridgeState { token, open }
}

/// 校验 `Authorization: Bearer <token>`；通过返回 None，失败返回 401 错误。
fn check_auth(
	headers: &HeaderMap,
	token: &str,
) -> Result<(), StatusCode> {
	let value = headers
		.get("authorization")
		.and_then(|header| header.to_str().ok())
		.unwrap_or("");
	let candidate = value
		.strip_prefix("Bearer ")
		.map(str::trim)
		.unwrap_or("");
	if token::verify(token, candidate) {
		Ok(())
	} else {
		warn!("MCP bridge 收到未授权请求（token 不匹配）");
		Err(StatusCode::UNAUTHORIZED)
	}
}

/// `GET /api/open_sessions`：返回当前已打开的会话列表。
async fn open_sessions(
	State(state): State<Arc<BridgeState>>,
	headers: HeaderMap,
) -> Result<Json<Vec<OpenSessionMeta>>, StatusCode> {
	check_auth(&headers, &state.token)?;
	Ok(Json(state.open.snapshot()))
}

/// `GET /api/health`：供子进程探测主进程是否在线。
async fn health() -> &'static str {
	"ok"
}

/// 构建路由（供 mod.rs 组装 axum server）。
pub(crate) fn router(state: Arc<BridgeState>) -> Router {
	Router::new()
		.route("/api/health", get(health))
		.route("/api/open_sessions", get(open_sessions))
		.with_state(state)
}

#[cfg(test)]
#[path = "../../tests/unit/mcp_bridge.rs"]
mod tests;
