//! 值守心跳的单元测试。
//!
//! 由源文件以 `#[path]` 编回对应模块，因此用 `super::` 取被测项。
//! 重点钉住两件事：
//! - 间隔夹取：`tokio::time::interval(0)` 会 panic，而这个值来自界面输入；
//! - 事件名：前端 `listen` 的字符串必须逐字一致，写错的表现是「心跳在跑，
//!   但巡检永远不触发」，两边都看不出问题。

use super::{
    clamp_interval, MAX_INTERVAL_SEC, MIN_INTERVAL_SEC, TICK_EVENT,
};

/// 0 / 过小 → 夹到下限。
#[test]
fn 间隔小于下限时夹到下限() {
    assert_eq!(clamp_interval(0), MIN_INTERVAL_SEC);
    assert_eq!(clamp_interval(1), MIN_INTERVAL_SEC);
    assert_eq!(clamp_interval(4), MIN_INTERVAL_SEC);
}

/// 过大 → 夹到上限。
#[test]
fn 间隔大于上限时夹到上限() {
    assert_eq!(clamp_interval(u64::MAX), MAX_INTERVAL_SEC);
    assert_eq!(clamp_interval(999_999), MAX_INTERVAL_SEC);
}

/// 合法区间原样保留 —— 不能把用户配的 60 秒悄悄改成别的值。
#[test]
fn 合法间隔原样保留() {
    assert_eq!(clamp_interval(5), 5);
    assert_eq!(clamp_interval(60), 60);
    assert_eq!(clamp_interval(3600), 3600);
}

/// 事件名与前端约定一致（`watch://tick`）。
#[test]
fn 心跳事件名固定() {
    assert_eq!(TICK_EVENT, "watch://tick");
}
