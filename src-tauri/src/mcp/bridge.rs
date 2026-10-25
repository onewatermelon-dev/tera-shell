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
use tauri::Emitter;
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

/// bridge 服务的共享状态：token + 已打开会话表 + 执行/审批所需资源。
pub(crate) struct BridgeState {
	token: String,
	open: OpenSessions,
	/// AI exec 会话池（执行命令）。
	exec: crate::ai::ExecPool,
	/// 审批等待表（阻塞式往返）。
	approvals: super::approval::Approvals,
	/// SFTP 连接池（列目录 / 读文件）。
	sftp: crate::sftp::SftpPool,
	/// Tauri AppHandle：发审批事件给前端。
	app: tauri::AppHandle,
	/// 数据目录：构造 ExecTarget、落审计。
	data_dir: std::path::PathBuf,
}

/// 构造 bridge 的共享状态（供 mod.rs 在 spawn 前组装）。
pub(crate) fn serve_state(
	token: String,
	open: OpenSessions,
	exec: crate::ai::ExecPool,
	approvals: super::approval::Approvals,
	sftp: crate::sftp::SftpPool,
	app: tauri::AppHandle,
	data_dir: std::path::PathBuf,
) -> BridgeState {
	BridgeState {
		token,
		open,
		exec,
		approvals,
		sftp,
		app,
		data_dir,
	}
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

/// 列目录 / 读文件共用的请求体（session_id + 远程路径）。
#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct SftpPathRequest {
	session_id: String,
	path: String,
}

/// 把 session_id 解析成 SshTarget（错误统一转 HTTP 400）。
fn resolve_ssh_target(
	state: &BridgeState,
	session_id: &str,
) -> Result<crate::ssh::SshTarget, (StatusCode, String)> {
	super::target::build_ssh_target(&state.data_dir, session_id)
		.map_err(|error| (StatusCode::BAD_REQUEST, error.to_string()))
}

/// `POST /api/list_dir`：列一个远程目录（只读，不审批）。
async fn list_dir(
	State(state): State<Arc<BridgeState>>,
	headers: HeaderMap,
	Json(req): Json<SftpPathRequest>,
) -> Result<Json<serde_json::Value>, (StatusCode, String)> {
	check_auth(&headers, &state.token)
		.map_err(|status| (status, "unauthorized".into()))?;
	let target = resolve_ssh_target(&state, &req.session_id)?;
	let path = if req.path.trim().is_empty() {
		".".to_string()
	} else {
		req.path.trim().to_string()
	};
	// SFTP 是阻塞实现，放 blocking 线程
	let pool = state.sftp.clone();
	let joined = tauri::async_runtime::spawn_blocking(move || {
		crate::sftp::list_remote_dir(&pool, &target, &path)
	})
	.await
	.map_err(|error| (StatusCode::INTERNAL_SERVER_ERROR, error.to_string()))?;
	let entries = joined
		.map_err(|error| (StatusCode::INTERNAL_SERVER_ERROR, error.to_string()))?;
	Ok(Json(serde_json::json!({
		"entries": entries,
	})))
}

/// `POST /api/read_file`：读一个远程文件的文本内容（只读，不审批）。
async fn read_file(
	State(state): State<Arc<BridgeState>>,
	headers: HeaderMap,
	Json(req): Json<SftpPathRequest>,
) -> Result<Json<serde_json::Value>, (StatusCode, String)> {
	check_auth(&headers, &state.token)
		.map_err(|status| (status, "unauthorized".into()))?;
	let target = resolve_ssh_target(&state, &req.session_id)?;
	let path = req.path.trim().to_string();
	if path.is_empty() {
		return Err((StatusCode::BAD_REQUEST, "缺少 path".into()));
	}
	let pool = state.sftp.clone();
	let joined = tauri::async_runtime::spawn_blocking(move || {
		crate::sftp::read_remote_file(&pool, &target, &path)
	})
	.await
	.map_err(|error| (StatusCode::INTERNAL_SERVER_ERROR, error.to_string()))?;
	let content = joined
		.map_err(|error| (StatusCode::INTERNAL_SERVER_ERROR, error.to_string()))?;
	Ok(Json(serde_json::json!({
		"content": content,
	})))
}

/// `POST /api/run_command` 的请求体。
#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct RunCommandRequest {
	session_id: String,
	command: String,
	#[serde(default)]
	is_read_only: bool,
	#[serde(default)]
	client: String,
}

/// `POST /api/run_command`：审批后执行命令（阻塞等用户决定）。
///
/// 若命中了「自动执行」策略（只读 + auto_execute / 读写 + auto_apply 且
/// 不在黑名单），则**不弹审批**直接执行；否则弹审批卡等用户决定。
async fn run_command(
	State(state): State<Arc<BridgeState>>,
	headers: HeaderMap,
	Json(req): Json<RunCommandRequest>,
) -> Result<Json<serde_json::Value>, (StatusCode, String)> {
	check_auth(&headers, &state.token)
		.map_err(|status| (status, "unauthorized".into()))?;

	// 构造 ExecTarget（会话不存在 / 密码解不开在这里就报错）
	let target = super::target::build_exec_target(
		&state.data_dir,
		&req.session_id,
		req.command.clone(),
	)
	.map_err(|error| {
		(StatusCode::BAD_REQUEST, error.to_string())
	})?;

	let client = if req.client.trim().is_empty() {
		"unknown".to_string()
	} else {
		req.client.trim().to_string()
	};

	// 保存目标描述（target 会在执行时被 move，审计要用）
	let target_desc = format!(
		"{}@{}:{}",
		target.username.as_deref().unwrap_or("root"),
		target.host,
		target.port.unwrap_or(22)
	);

	// 审批策略：命中的命令自动执行（不弹审批）
	let policy = super::policy::load_policy(&state.data_dir);
	let auto = super::policy::should_auto_run(
		&target.command,
		req.is_read_only,
		&policy,
	);
	if auto {
		return Ok(execute_and_audit(
			&state,
			&client,
			target_desc,
			target,
			req.is_read_only,
			true,
		)
		.await?);
	}

	// 生成审批请求，登记 pending，emit 给前端
	let request_id = format!("mcp-{}", crate::mcp::token::generate());
	let approval = super::approval::ApprovalRequest {
		request_id: request_id.clone(),
		target: target_desc.clone(),
		command: target.command.clone(),
		is_read_only: req.is_read_only,
		client: client.clone(),
	};
	let rx = state.approvals.register(request_id.clone());
	// 事件名与前端 useMcpApproval 的 listen 一致
	let _ = state
		.app
		.emit("mcp-approval-request", approval);

	// 阻塞等决定（超时自动拒绝）
	let decision = tokio::time::timeout(
		super::approval::APPROVAL_TIMEOUT,
		rx,
	)
	.await
	.map_err(|_| {
		// 超时：解除 pending，落审计，返回错误
		state.approvals.dismiss(&request_id);
		super::audit::record_decision(
			&state.data_dir,
			&client,
			&target_desc,
			&target.command,
			req.is_read_only,
			super::approval::Decision::Rejected,
		);
		(
			StatusCode::REQUEST_TIMEOUT,
			"审批超时，已自动拒绝".to_string(),
		)
	})?
	.map_err(|_| {
		(StatusCode::INTERNAL_SERVER_ERROR, "审批通道已关闭".into())
	})?;

	match decision {
		super::approval::Decision::Rejected => {
			super::audit::record_decision(
				&state.data_dir,
				&client,
				&target_desc,
				&target.command,
				req.is_read_only,
				super::approval::Decision::Rejected,
			);
			Err((
				StatusCode::FORBIDDEN,
				"用户拒绝了这条命令".to_string(),
			))
		}
		super::approval::Decision::Approved => {
			execute_and_audit(
				&state,
				&client,
				target_desc,
				target,
				req.is_read_only,
				false,
			)
			.await
		}
	}
}

/// 执行命令并落审计（自动执行与审批通过两条路径共用）。
///
/// `auto` = true 时审计的 decision 记为 `auto`（自动执行），否则 `approved`。
async fn execute_and_audit(
	state: &Arc<BridgeState>,
	client: &str,
	target_desc: String,
	target: crate::ai::ExecTarget,
	is_read_only: bool,
	auto: bool,
) -> Result<Json<serde_json::Value>, (StatusCode, String)> {
	let command = target.command.clone();
	let outcome = crate::ai::execute_command(&state.exec, target)
		.await
		.map_err(|error| {
			(StatusCode::INTERNAL_SERVER_ERROR, error)
		})?;

	let decision = if auto { "auto" } else { "approved" };
	super::audit::record_executed(
		&state.data_dir,
		client,
		&target_desc,
		&command,
		is_read_only,
		decision,
		outcome.exit_code,
		format!("{}{}", outcome.stdout, outcome.stderr),
	);

	// 返回执行结果给子进程（文本形式）
	let output = format!(
		"exit_code={}\nstdout:\n{}\nstderr:\n{}",
		outcome.exit_code, outcome.stdout, outcome.stderr
	);
	Ok(Json(serde_json::json!({
		"auto": auto,
		"output": output
	})))
}

/// 构建路由（供 mod.rs 组装 axum server）。
pub(crate) fn router(state: Arc<BridgeState>) -> Router {
	Router::new()
		.route("/api/health", get(health))
		.route("/api/open_sessions", get(open_sessions))
		.route("/api/run_command", axum::routing::post(run_command))
		.route("/api/list_dir", axum::routing::post(list_dir))
		.route("/api/read_file", axum::routing::post(read_file))
		.with_state(state)
}

#[cfg(test)]
#[path = "../../tests/unit/mcp_bridge.rs"]
mod tests;
