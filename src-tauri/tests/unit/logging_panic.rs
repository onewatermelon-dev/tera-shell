//! 日志模块的单元测试：panic 记录的拼装。
//!
//! 由源文件以 `#[path]` 编回对应模块，因此用 `super::` 取被测项。
//!
//! 为什么要单独钉这个纯函数：panic 钩子里能跑的逻辑极少（再 panic 就
//! abort），拼装是唯一能测的部分；而它一旦丢掉 location 或消息，写进
//! 文件的就是一坨没有信息量的分隔线 —— 那和不记录没区别。

use super::{format_panic, RotatingWriter};
use std::io::Write;
use tracing_subscriber::fmt::MakeWriter;

/// 有位置、有消息：三段都要在。
#[test]
fn 记录包含线程位置与消息() {
    let text = format_panic(
        "main",
        Some("src/watch/mod.rs:105:18"),
        "there is no reactor running",
        None,
    );
    assert!(text.contains("PANIC"));
    assert!(text.contains("thread 'main'"));
    assert!(text.contains("src/watch/mod.rs:105:18"));
    assert!(text.contains("there is no reactor running"));
}

/// 没有 backtrace 时给出「怎么打开」的提示，而不是留白。
#[test]
fn 缺backtrace时注明如何打开() {
    let text = format_panic("main", None, "boom", None);
    assert!(text.contains("RUST_BACKTRACE"));
    assert!(!text.contains("--- backtrace ---"));
}

/// 有 backtrace 时原样附上，并且结尾补换行（否则下一条日志会黏在一行）。
#[test]
fn 有backtrace时附上且补齐换行() {
    let text = format_panic(
        "worker",
        Some("src/a.rs:1:1"),
        "boom",
        Some("   0: backtrace::trace"),
    );
    assert!(text.contains("--- backtrace ---"));
    assert!(text.contains("backtrace::trace"));
    assert!(text.ends_with("=\n"));
}

/// 消息本身带换行（多行 panic）也要完整保留，别被截成一行。
#[test]
fn 多行消息完整保留() {
    let text = format_panic("main", None, "第一行\n第二行", None);
    assert!(text.contains("第一行\n第二行"));
}

/// 分隔线包裹：日志文件里几十万行混排时靠它扫读定位。
#[test]
fn 前后都有分隔线() {
    let text = format_panic("main", None, "boom", None);
    assert!(text.starts_with("\n===== PANIC ====="));
    assert!(text.trim_end().ends_with("================="));
}

/// 端到端：panic 文本经过 `RotatingWriter` 真的落到磁盘上。
///
/// 这一条比格式断言更重要 —— 钩子里唯一可能的失败是「写不进去」，
/// 而写不进去时界面上看不出任何异常（panic 照旧打到 stderr），
/// 只有下次翻日志才会发现现场又是空的。
#[test]
fn panic记录经滚动写入器落盘() {
    let dir = std::env::temp_dir().join(format!(
        "tera-log-panic-{}-{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|value| value.as_nanos())
            .unwrap_or(0)
    ));
    let writer = RotatingWriter::new(dir.clone());
    let text = format_panic(
        "main",
        Some("src/watch/mod.rs:105:18"),
        "there is no reactor running",
        None,
    );
    let mut handle = writer.make_writer();
    handle
        .write_all(text.as_bytes())
        .expect("写 panic 记录失败");
    drop(handle);

    // 日期子目录 → 文件，逐层读出来拼成一份
    let mut written = String::new();
    for day in std::fs::read_dir(&dir).expect("日志目录未创建") {
        let day = day.expect("目录项不可读").path();
        for file in std::fs::read_dir(&day).expect("日期目录不可读") {
            written.push_str(
                &std::fs::read_to_string(file.expect("文件项不可读").path())
                    .expect("日志文件不可读"),
            );
        }
    }
    assert!(written.contains("===== PANIC ====="));
    assert!(written.contains("src/watch/mod.rs:105:18"));
    assert!(written.contains("there is no reactor running"));
    let _ = std::fs::remove_dir_all(&dir);
}
