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
    sync::{Arc, Mutex},
};

use chrono::Local;
use tauri::Manager;
use tracing_subscriber::{
    EnvFilter,
    fmt::MakeWriter,
    layer::{Layer, SubscriberExt},
    util::SubscriberInitExt,
};

/// 单个日志文件最多容纳的记录条数，超出后滚动到新文件。
const MAX_RECORDS_PER_FILE: u64 = 9999;

/// 初始化日志：stdout + 按天滚动的文件日志双输出。
///
/// 日志级别由环境变量 `RUST_LOG` 控制，默认 `info`；
/// 排查问题时用 `RUST_LOG=debug` 启动可获取更详细的日志。
pub fn init(app: &tauri::App) {
    let dir = log_dir(app);
    let filter = EnvFilter::try_from_default_env().unwrap_or_else(|_| EnvFilter::new("info"));
    // 根目录建不出来时退回仅 stdout，不阻塞应用启动（日期子目录在首条日志时创建）。
    if let Err(error) = fs::create_dir_all(&dir) {
        eprintln!("日志目录创建失败 {}：{error}", dir.display());
        tracing_subscriber::registry()
            .with(tracing_subscriber::fmt::layer().with_filter(filter))
            .init();
        return;
    }
    tracing_subscriber::registry()
        .with(
            tracing_subscriber::fmt::layer()
                .with_ansi(false)
                .with_writer(RotatingWriter::new(dir.clone()))
                .with_filter(filter.clone()),
        )
        // stdout 层不指定 writer，fmt::layer 默认输出到 stdout。
        .with(tracing_subscriber::fmt::layer().with_filter(filter))
        .init();
    tracing::info!("日志初始化完成：{}", dir.display());
}

/// 日志根目录：优先应用日志目录，取不到时退回系统临时目录。
fn log_dir(app: &tauri::App) -> PathBuf {
    app.path()
        .app_log_dir()
        .unwrap_or_else(|_| std::env::temp_dir())
}

/// 按天归档、限量滚动的日志写入器。
///
/// 每次日志事件由 tracing 的 fmt layer 调用一次 [`MakeWriter::make_writer`]，
/// 用一个 writer 实例写完该事件后丢弃；因此在 writer 的 `Drop` 里递增计数，
/// 恰好等于已落盘的日志事件条数。
#[derive(Clone)]
struct RotatingWriter(Arc<Mutex<RotatingState>>);

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
    fn new(base: PathBuf) -> Self {
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
struct EventWriter {
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
fn today() -> String {
    Local::now().format("%Y-%m-%d").to_string()
}

#[cfg(test)]
mod tests {
    use std::io::Write as _;

    use super::*;

    #[test]
    fn rolls_over_when_file_full() {
        let base = std::env::temp_dir().join(format!(
            "tera-shell-log-test-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        let writer = RotatingWriter::new(base.clone());
        // 模拟 10001 条日志事件：每条事件取一次 writer，写完即丢弃。
        for _ in 0..10_001 {
            let mut event = writer.make_writer();
            event.write_all(b"event\n").unwrap();
            event.flush().unwrap();
        }
        drop(writer);

        let dir = base.join(today());
        let mut counts: Vec<u64> = fs::read_dir(&dir)
            .unwrap()
            .map(|entry| {
                let path = entry.unwrap().path();
                fs::read_to_string(&path).unwrap().lines().count() as u64
            })
            .collect();
        // 9999 条写满后应滚动出第二个文件；两个文件按创建先后为 9999 / 2 条。
        counts.sort_unstable();
        assert_eq!(counts.len(), 2, "写满 9999 条后应新建日志文件：{counts:?}");
        assert_eq!(counts, vec![2, 9999], "滚动后新文件从 0 重新计数：{counts:?}");

        fs::remove_dir_all(&base).unwrap();
    }
}
