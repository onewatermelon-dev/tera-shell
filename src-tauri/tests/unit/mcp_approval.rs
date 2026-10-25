//! mcp/approval.rs 的单元测试（经 `#[path]` 编回源模块）。

use super::*;

#[tokio::test]
async fn register_then_respond_wakes_receiver() {
	let approvals = Approvals::default();
	let rx = approvals.register("r1".into());
	// 异步响应
	tokio::spawn(async move {
		approvals.respond("r1", Decision::Approved);
	});
	let decision = rx.await.expect("应收到决定");
	assert!(matches!(decision, Decision::Approved));
}

#[tokio::test]
async fn respond_missing_returns_false() {
	let approvals = Approvals::default();
	assert!(!approvals.respond("nope", Decision::Approved));
}

#[tokio::test]
async fn dismiss_wakes_receiver_with_rejected() {
	let approvals = Approvals::default();
	let rx = approvals.register("r1".into());
	approvals.dismiss("r1");
	let decision = rx.await.expect("应收到决定");
	assert!(matches!(decision, Decision::Rejected));
}

#[tokio::test]
async fn receiver_dropped_then_respond_returns_true_without_panic() {
	let approvals = Approvals::default();
	let rx = approvals.register("r1".into());
	drop(rx); // 模拟超时后接收端被 drop
	assert!(approvals.respond("r1", Decision::Approved));
}
