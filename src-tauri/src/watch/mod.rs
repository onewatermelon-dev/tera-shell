//! 值守巡检的**心跳调度器**。
//!
//! ## 为什么调度器必须住在这里，而不是前端 `setInterval`
//!
//! 值守要解决的正是「我不在电脑前」的场景，而此时窗口通常最小化 ——
//! WebView2 会把后台页面的定时器节流到分钟级、进入省电模式后甚至暂停。
//! 前端 `setInterval` 写 60 秒，实际可能几十分钟才醒一次，「准点巡检」
//! 就成了碰运气。
//!
//! ## 为什么只做心跳，不做判定
//!
//! 这里只按间隔发一个 `watch://tick` 事件，**跑哪些检查、判定阈值、发通知
//! 全在前端**。理由有三条：
//!
//! 1. 配置改了立即生效 —— 阈值不必下发到后端再重启调度器；
//! 2. 后端不持有任何凭据 —— 密码解密、跳板链解析仍走前端那条唯一的
//!    通路（`buildSshTarget`），不新增一处「凭据经过的地方」；
//! 3. 执行通道、解析、通知链全是现成的（`ai_run_command` + `notifySend`），
//!    在这里重写一遍是纯重复劳动。
//!
//! 代价是「窗口被彻底销毁时不巡检」—— 但那种情况下应用本身已退出，
//! 与路线图里「这不是服务端监控的替代品」的边界一致。

use std::sync::Mutex;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use serde::Serialize;
use tauri::async_runtime::JoinHandle;
use tauri::{AppHandle, Emitter, State};
use tracing::{debug, info, warn};

/// 心跳事件名。前端 `listen("watch://tick")`。
pub const TICK_EVENT: &str = "watch://tick";

/// 心跳间隔下限（秒）。
///
/// 5 秒是「不把远端打爆」的下限：巡检脚本本身含一次 `sleep 1` 采样，
/// 再密就不是巡检而是压测了。
pub const MIN_INTERVAL_SEC: u64 = 5;

/// 心跳间隔上限（秒）：一小时。再长的心跳等于没有心跳。
pub const MAX_INTERVAL_SEC: u64 = 3600;

/// 一次心跳的载荷。
#[derive(Clone, Serialize)]
struct Tick {
    /// 发出时刻（毫秒时间戳），让前端不必自己读钟
    at: u64,
}

/// 心跳任务句柄。
///
/// ⚠️ 必须自己管住旧任务：重复 start 而不 abort，会留下两个心跳线程，
/// 前端每次 tick 都跑两遍（表现为巡检频率翻倍、通知重复）——这与终端
/// 「同 id 重复 start 覆盖旧 Session」是同一类坑。
#[derive(Default)]
pub struct Heartbeat {
    current: Mutex<Option<JoinHandle<()>>>,
}

impl Heartbeat {
    /// 停掉当前心跳；返回是否真的停了一个。
    fn stop(&self) -> bool {
        let mut slot = self
            .current
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        match slot.take() {
            Some(handle) => {
                handle.abort();
                true
            }
            None => false,
        }
    }
}

/// 把外部传入的间隔夹到合法范围。
///
/// 单独抽成纯函数是为了能单测：`tokio::time::interval` 收到 0 会 **panic**，
/// 而这个参数最终来自界面输入框（用户能填 0、负数、留空）。
pub fn clamp_interval(seconds: u64) -> u64 {
    seconds.clamp(MIN_INTERVAL_SEC, MAX_INTERVAL_SEC)
}

/// 当前毫秒时间戳；取不到系统时间时退 0（只用于日志与载荷，不影响调度）。
fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|elapsed| elapsed.as_millis() as u64)
        .unwrap_or(0)
}

/// 启动（或重启）值守心跳，返回实际生效的间隔秒数。
///
/// 重复调用是安全的：先停旧的再起新的，不会出现两个心跳并行。
#[tauri::command]
pub fn watch_heartbeat_start(
    app: AppHandle,
    state: State<'_, Heartbeat>,
    seconds: u64,
) -> Result<u64, String> {
    let interval = clamp_interval(seconds);
    let replaced = state.stop();
    // ⚠️ 必须用 `tauri::async_runtime::spawn`，**不能**直接 `tokio::spawn`：
    // 这是个同步 command，Tauri 在没有 reactor 的线程上调用它，
    // `tokio::spawn` 会当场 panic（「there is no reactor running」，
    // 2026-10-25 实测：应用一启动就 abort）。tauri 的那个版本会先
    // `handle.enter()` 再 spawn，从任何线程调都安全。
    let handle = tauri::async_runtime::spawn(async move {
        let mut ticker =
            tokio::time::interval(Duration::from_secs(interval));
        // ⚠️ `interval` 的第一拍是**立即完成**的。这里显式消费掉，
        // 让第一轮巡检落在 interval 之后 —— 否则「刚打开应用」和
        // 「第一拍」会连着跑两次，远端看到两条几乎同时的 exec。
        ticker.tick().await;
        loop {
            ticker.tick().await;
            let at = now_ms();
            if let Err(error) = app.emit(TICK_EVENT, Tick { at }) {
                // 发不出去通常意味着所有窗口都没了（托盘驻留场景下不该发生），
                // 记一条 warn 继续跑：窗口回来时下一拍就能恢复
                warn!("值守心跳发送失败：{error}");
                continue;
            }
            debug!(at, interval, "值守心跳");
        }
    });
    let mut slot = state
        .current
        .lock()
        .unwrap_or_else(|error| error.into_inner());
    *slot = Some(handle);
    info!(
        interval,
        replaced, "值守心跳已启动（间隔 {interval} 秒）"
    );
    Ok(interval)
}

/// 停止值守心跳；返回是否真的停了一个（未启动时返回 `false`）。
#[tauri::command]
pub fn watch_heartbeat_stop(
    state: State<'_, Heartbeat>,
) -> bool {
    let stopped = state.stop();
    if stopped {
        info!("值守心跳已停止");
    }
    stopped
}

#[cfg(test)]
#[path = "../../tests/unit/watch.rs"]
mod tests;
