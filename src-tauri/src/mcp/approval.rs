//! MCP 命令执行的审批：主进程侧 pending 表 + 阻塞式往返。
//!
//! 外部 agent 经 MCP 发起 `run_command` 时，不能直接执行 —— 必须弹审批卡
//! 让用户点「执行 / 拒绝」。MCP 的 `tools/call` 是同步请求/响应，所以这里用
//! `oneshot` 把「等审批」变成阻塞：
//!
//! ```text
//! bridge 收到 run_command → 生成 request_id → 登记 pending
//!   → emit "mcp-approval-request"（前端弹审批卡）
//!   → await oneshot（超时自动拒绝）
//! 前端点执行/拒绝 → invoke mcp_approval_respond → 唤醒 oneshot
//! ```
//!
//! 审批表挂在 `.manage` 上，供 bridge 与 respond 命令共用。

use std::{
	collections::HashMap,
	sync::{Arc, Mutex},
	time::Duration,
};

use serde::Serialize;
use tokio::sync::oneshot;

/// 审批等待上限：超过自动拒绝，避免外部 agent 一直挂着。
pub const APPROVAL_TIMEOUT: Duration =
	Duration::from_secs(300);

/// 用户的审批决定。
#[derive(Clone, Copy, Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Decision {
	/// 批准执行。
	Approved,
	/// 拒绝。
	Rejected,
}

/// 一次待审批的命令请求（发给前端审批卡的内容）。
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ApprovalRequest {
	/// 审批请求 id：前端回传决定时用它定位。
	pub request_id: String,
	/// 命令将执行在哪台服务器（`user@host:port`）。
	pub target: String,
	/// 要执行的命令原文。
	pub command: String,
	/// 是否只读（外部 agent 自报；展示用，执行时仍可能改状态）。
	pub is_read_only: bool,
	/// 发起调用的客户端名（MCP initialize 里给的）。
	pub client: String,
}

/// 审批等待表的条目。
struct Pending {
	/// 唤醒 bridge 的发送端。
	tx: oneshot::Sender<Decision>,
}

/// 审批等待表：`request_id → Pending`。
///
/// 内部用 `Arc` 共享同一份 map（`.manage` 给 respond 命令用，bridge 用
/// 克隆的同一实例）。
#[derive(Default, Clone)]
pub struct Approvals(Arc<Mutex<HashMap<String, Pending>>>);

impl Approvals {
	/// 登记一条待审批请求，返回接收端（bridge await 它）。
	pub fn register(
		&self,
		request_id: String,
	) -> oneshot::Receiver<Decision> {
		let (tx, rx) = oneshot::channel();
		let mut map = self
			.0
			.lock()
			.unwrap_or_else(|error| error.into_inner());
		map.insert(request_id, Pending { tx });
		rx
	}

	/// 用户回传决定：唤醒对应的 pending。返回是否命中。
	pub fn respond(
		&self,
		request_id: &str,
		decision: Decision,
	) -> bool {
		let mut map = self
			.0
			.lock()
			.unwrap_or_else(|error| error.into_inner());
		match map.remove(request_id) {
			Some(pending) => {
				// 接收端已超时 drop 时发送会失败，不算错误
				let _ = pending.tx.send(decision);
				true
			}
			None => false,
		}
	}

	/// 移除并唤醒一条 pending（超时 / 主窗口关闭时用「拒绝」兜底）。
	pub fn dismiss(&self, request_id: &str) {
		let _ = self.respond(request_id, Decision::Rejected);
	}
}

#[cfg(test)]
#[path = "../../tests/unit/mcp_approval.rs"]
mod tests;
