//! 应用日志：开发时输出到控制台，运行时落盘日志文件，方便定位问题。
//!
//! 日志文件按天归档、限量滚动：
//! - 目录：`<应用日志目录>/<yyyy-MM-dd>/`，跨天自动切换到新日期目录。
//! - 文件：单个日志文件最多存 `MAX_RECORDS_PER_FILE`（9999）条日志事件；
//!   写满后新建文件，文件名取创建时刻的 `HHmmss`，同秒冲突时追加 `-2`/`-3` 递增。

use std::{
    fs::{self, OpenOptions},
    io::{self, Write},
    path::PathBuf,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
};

use chrono::Local;
use tracing_subscriber::{
    EnvFilter,
    fmt::MakeWriter,
    layer::{Layer, SubscriberExt},
    util::SubscriberInitExt,
};

/// 单个日志文件最多容纳的记录条数，超出后滚动到新文件。
const MAX_RECORDS_PER_FILE: u64 = 9999;

/// 默认日志级别。
///
/// `frontend=debug` 是刻意加的：前端 `console.debug` 里有大量排查用的现场
/// （心跳、通知判定、粘贴拦截），它们平时不进文件，出事时恰恰最有用。
/// 只放宽 `frontend` 这一个 target，Rust 侧的 debug 仍然按需用 `RUST_LOG`
/// 打开 —— 否则 xterm/ssh 的逐包日志会把文件刷爆。
const DEFAULT_FILTER: &str = "info,frontend=debug";

/// 初始化日志：stdout + 按天滚动的文件日志双输出。
///
/// 日志级别由环境变量 `RUST_LOG` 控制，缺省为 [`DEFAULT_FILTER`]；
/// 排查问题时用 `RUST_LOG=debug` 启动可获取更详细的日志。
pub fn init(app: &tauri::App) {
    let dir = log_dir(app);
    let filter = EnvFilter::try_from_default_env()
        .unwrap_or_else(|_| EnvFilter::new(DEFAULT_FILTER));
    // 根目录建不出来时退回仅 stdout，不阻塞应用启动（日期子目录在首条日志时创建）。
    if let Err(error) = fs::create_dir_all(&dir) {
        eprintln!("日志目录创建失败 {}：{error}", dir.display());
        tracing_subscriber::registry()
            .with(tracing_subscriber::fmt::layer().with_filter(filter))
            .init();
        return;
    }
    let writer = RotatingWriter::new(dir.clone());
    tracing_subscriber::registry()
        .with(
            tracing_subscriber::fmt::layer()
                .with_ansi(false)
                .with_writer(writer.clone())
                .with_filter(filter.clone()),
        )
        // stdout 层不指定 writer，fmt::layer 默认输出到 stdout。
        .with(tracing_subscriber::fmt::layer().with_filter(filter))
        .init();
    // 必须晚于 subscriber 初始化（hook 自己也走那条 writer），但要早于
    // 任何可能 panic 的业务代码 —— setup 里接着就是建窗口。
    install_panic_hook(writer);
    tracing::info!(
        dir = %dir.display(),
        filter = DEFAULT_FILTER,
        "日志初始化完成"
    );
}

/// 把 panic 也写进日志文件。
///
/// ## 为什么非要有这一步
///
/// `tracing` 只收「主动打的日志」。panic 是标准库直接写 stderr 的，
/// 落不到文件里 —— 2026-10-25 就因此吃过亏：应用启动即 abort，终端里
/// 明明有一大段 backtrace，导出的诊断包里却一个字都没有，等于现场全丢。
///
/// ## 两个细节
///
/// - **先落盘、再交给默认钩子**：默认钩子仍会往 stderr 打一份，开发时
///   照旧能看见；这里只是在它之前把同样的内容抄进文件。
/// - **递归保护**：panic 钩子里再 panic 会直接 abort，所以用原子标志拦住
///   第二次进入（此时连"钩子挂了"这条都写不进去，只能放弃）。
fn install_panic_hook(writer: RotatingWriter) {
    static IN_HOOK: AtomicBool = AtomicBool::new(false);
    let default_hook = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |info| {
        if !IN_HOOK.swap(true, Ordering::SeqCst) {
            let thread = std::thread::current()
                .name()
                .unwrap_or("unnamed")
                .to_string();
            let location = info.location().map(|place| {
                format!(
                    "{}:{}:{}",
                    place.file(),
                    place.line(),
                    place.column()
                )
            });
            // backtrace 只在用户显式要求时抓：默认抓一次要几百微秒并占
            // 几十 KB，而绝大多数 panic 看位置就够定位了
            let backtrace = std::env::var_os("RUST_BACKTRACE")
                .is_some()
                .then(|| {
                    std::backtrace::Backtrace::force_capture()
                        .to_string()
                });
            let text = format_panic(
                &thread,
                location.as_deref(),
                &payload_text(&info),
                backtrace.as_deref(),
            );
            let mut handle = writer.make_writer();
            // 写失败（磁盘满等）也没别的办法了：默认钩子仍会打 stderr
            let _ = handle.write_all(text.as_bytes());
            drop(handle);
            IN_HOOK.store(false, Ordering::SeqCst);
        }
        default_hook(info);
    }));
}

/// panic 载荷转文本。
///
/// 载荷一般就是 `panic!("...")` 的内容；`&str` 与 `String` 两种形态都要认，
/// 认不出来时给一句占位，别让整条记录变成空白。
fn payload_text(
    info: &std::panic::PanicHookInfo<'_>,
) -> String {
    if let Some(text) = info.payload().downcast_ref::<&str>() {
        (*text).to_string()
    } else if let Some(text) =
        info.payload().downcast_ref::<String>()
    {
        text.clone()
    } else {
        "（panic 载荷不是字符串）".to_string()
    }
}

/// 拼一条 panic 记录（纯函数，便于单测）。
///
/// 分隔线的刻意加的：日志文件和几十万行业务日志混在一起，一段带
/// `===== PANIC =====` 的块扫读时一眼就能看见。
pub fn format_panic(
    thread: &str,
    location: Option<&str>,
    message: &str,
    backtrace: Option<&str>,
) -> String {
    let mut out = String::from("\n===== PANIC =====\n");
    out.push_str(&format!("thread '{thread}' panicked"));
    if let Some(place) = location {
        out.push_str(&format!(" at {place}"));
    }
    out.push_str(":\n");
    out.push_str(message.trim_end());
    out.push('\n');
    match backtrace {
        Some(trace) => {
            out.push_str("--- backtrace ---\n");
            out.push_str(trace);
            if !trace.ends_with('\n') {
                out.push('\n');
            }
        }
        None => out.push_str(
            "（未记录 backtrace：设 RUST_BACKTRACE=1 重启可带上堆栈）\n",
        ),
    }
    out.push_str("=================\n");
    out
}


/// 日志根目录：固定在 `<主目录>/.tera-shell/logs`（本机运行产物，不跟
/// 可迁移的数据目录走）；目录本身由 init 里的 create_dir_all 创建。
fn log_dir(app: &tauri::App) -> PathBuf {
    crate::data::home_anchor(app.handle()).join("logs")
}

/// 按天归档、限量滚动的日志写入器。
///
/// 每次日志事件由 tracing 的 fmt layer 调用一次 [`MakeWriter::make_writer`]，
/// 用一个 writer 实例写完该事件后丢弃；因此在 writer 的 `Drop` 里递增计数，
/// 恰好等于已落盘的日志事件条数。
#[derive(Clone)]
pub struct RotatingWriter(Arc<Mutex<RotatingState>>);

struct RotatingState {
    /// 日志根目录，其下按 `yyyy-MM-dd` 建日期子目录。
    base: PathBuf,
    /// 当前活跃文件；`None` 表示尚未创建或已写满待滚动。
    file: Option<fs::File>,
    /// 当前文件已写入的日志事件条数。
    written: u64,
    /// 当前文件所属的日期目录名；日期变化时滚动。
    day: String,
    /// 落盘曾失败（目录/文件打不开、写入出错），停止重试避免刷屏与死循环。
    broken: bool,
}

impl RotatingWriter {
    pub fn new(base: PathBuf) -> Self {
        RotatingWriter(Arc::new(Mutex::new(RotatingState {
            base,
            file: None,
            written: 0,
            day: String::new(),
            broken: false,
        })))
    }
}

impl RotatingState {
    /// 确保当前文件可写：无文件、已写满或日期变化时滚动到新文件。
    fn ensure_file(&mut self) {
        if self.broken {
            return;
        }
        let needs_roll = match &self.file {
            Some(_) => self.day != today() || self.written >= MAX_RECORDS_PER_FILE,
            None => true,
        };
        if needs_roll {
            self.roll();
        }
    }

    /// 关闭旧文件并打开新的日期目录文件；失败则进入 broken 状态并提示一次。
    fn roll(&mut self) {
        self.file = None;
        self.written = 0;
        self.day = today();
        let dir = self.base.join(&self.day);
        if let Err(error) = fs::create_dir_all(&dir) {
            self.broken = true;
            eprintln!("日志目录创建失败 {}：{error}", dir.display());
            return;
        }
        // 文件名取创建时刻 HHmmss；同一秒内可能多次滚动（快速重启、写满轮转），
        // 用 create_new 探测并追加 -2/-3 递增避开重名。
        let stamp = Local::now().format("%H%M%S").to_string();
        let mut seq = 0_u32;
        let file = loop {
            let name = if seq == 0 {
                format!("{stamp}.log")
            } else {
                format!("{stamp}-{seq}.log")
            };
            let path = dir.join(name);
            match OpenOptions::new().create_new(true).write(true).open(&path) {
                Ok(file) => break file,
                Err(error) if error.kind() == io::ErrorKind::AlreadyExists => {
                    seq += 1;
                }
                Err(error) => {
                    self.broken = true;
                    eprintln!("日志文件创建失败 {}：{error}", path.display());
                    return;
                }
            }
        };
        self.file = Some(file);
    }
}

/// 单次日志事件的写入句柄：写入由 fmt layer 一条事件内连续调用完成，句柄丢弃时计数。
pub struct EventWriter {
    state: Arc<Mutex<RotatingState>>,
    /// 本次事件是否实际写入了字节（空事件不计条数）。
    wrote: bool,
}

impl io::Write for EventWriter {
    fn write(&mut self, buf: &[u8]) -> io::Result<usize> {
        let mut state = self.state.lock().unwrap_or_else(|e| e.into_inner());
        state.ensure_file();
        if state.broken {
            // 落盘已失效：丢弃日志内容，避免 fmt layer 因错误重复重试。
            return Ok(buf.len());
        }
        match state.file.as_mut() {
            Some(file) => {
                // 磁盘写满等错误只提示一次并停用文件层，日志降级为不落盘。
                if let Err(error) = file.write(buf) {
                    state.broken = true;
                    eprintln!("日志写入失败，已停止落盘：{error}");
                    return Ok(buf.len());
                }
                self.wrote = true;
                Ok(buf.len())
            }
            None => Ok(buf.len()),
        }
    }

    fn flush(&mut self) -> io::Result<()> {
        let mut state = self.state.lock().unwrap_or_else(|e| e.into_inner());
        match state.file.as_mut() {
            Some(file) => file.flush(),
            None => Ok(()),
        }
    }
}

impl Drop for EventWriter {
    fn drop(&mut self) {
        let mut state = self.state.lock().unwrap_or_else(|e| e.into_inner());
        // 每条日志事件对应一个 EventWriter，丢弃时计数一次；文件落盘即时 flush。
        if self.wrote {
            state.written += 1;
        }
        if let Some(file) = &mut state.file {
            let _ = file.flush();
        }
    }
}

impl<'a> MakeWriter<'a> for RotatingWriter {
    type Writer = EventWriter;

    fn make_writer(&'a self) -> Self::Writer {
        EventWriter {
            state: self.0.clone(),
            wrote: false,
        }
    }
}

/// 本地日期，格式 `yyyy-MM-dd`，用作日志归档目录名。
pub fn today() -> String {
    Local::now().format("%Y-%m-%d").to_string()
}

#[cfg(test)]
#[path = "../../tests/unit/logging_panic.rs"]
mod tests;
