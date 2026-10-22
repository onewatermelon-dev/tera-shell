//! 诊断包的基础件：时间换算、脱敏、日志收集。
//!
//! 这几个函数错了的后果不对称 —— 时间算错只是文件名难看，**脱敏漏一个
//! 就是泄露密钥**，所以单独钉住。

use super::*;

#[test]
fn to_utc_handles_epoch_and_leap_day() {
    assert_eq!(to_utc(0), (1970, 1, 1, 0, 0, 0));
    // 2024-02-29 00:00:00 UTC（闰日：最容易算错的那天）
    assert_eq!(to_utc(1_709_164_800), (2024, 2, 29, 0, 0, 0));
    // 2026-10-22 22:56:30 UTC
    assert_eq!(to_utc(1_792_709_790), (2026, 10, 22, 22, 56, 30));
}

#[test]
fn secret_keys_match_case_insensitively() {
    for key in [
        "apiKey",
        "API_KEY",
        "access_token",
        "PASSWORD",
        "clientSecret",
        "credentials",
    ] {
        assert!(is_secret_key(key), "{key} 应该被判为敏感");
    }
    for key in ["fontSize", "language", "sidebarOpen"] {
        assert!(!is_secret_key(key), "{key} 不该被判为敏感");
    }
}

#[test]
fn redact_replaces_nested_and_array_secrets() {
    let mut value = serde_json::json!({
        "fontSize": 13,
        "providers": [{ "name": "x", "apiKey": "sk-123" }],
        "proxy": { "host": "127.0.0.1", "password": "p" },
        "history": ["rm -rf /"]
    });
    redact(&mut value);
    assert_eq!(value["fontSize"], 13);
    assert_eq!(value["proxy"]["host"], "127.0.0.1");
    assert_eq!(value["providers"][0]["name"], "x");
    assert_eq!(value["providers"][0]["apiKey"], "***（已脱敏）");
    assert_eq!(value["proxy"]["password"], "***（已脱敏）");
    assert_eq!(value["history"][0], "rm -rf /");
}

#[test]
fn collect_logs_keeps_only_latest_days() {
    let base = std::env::temp_dir().join(format!(
        "tera-shell-diag-test-{}",
        std::process::id()
    ));
    let _ = std::fs::remove_dir_all(&base);
    for day in ["2026-10-20", "2026-10-21", "2026-10-22"] {
        let dir = base.join(day);
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("app.log"), "x").unwrap();
    }
    let files = collect_logs(&base, 2);
    assert_eq!(files.len(), 2);
    assert!(
        files
            .iter()
            .all(|(name, _)| !name.contains("2026-10-20")),
        "只该保留最近两天"
    );
    let _ = std::fs::remove_dir_all(&base);
}

#[test]
fn collect_logs_tolerates_missing_root() {
    let missing = std::env::temp_dir().join("tera-shell-diag-missing-dir");
    let _ = std::fs::remove_dir_all(&missing);
    assert!(collect_logs(&missing, 3).is_empty());
}

#[test]
#[ignore = "手动核对 zip 结构：cargo test --lib --offline -- --ignored sample"]
fn write_sample_zip() {
    let path = std::path::Path::new("target/diag-sample.zip");
    let file = File::create(path).unwrap();
    let mut zip = StoredZip::new(file);
    zip.add("info.txt", b"hello\n").unwrap();
    zip.add("logs/2026-10-22/app.log", b"line1\nline2\n").unwrap();
    zip.finish().unwrap();
    println!("SAMPLE={}", path.display());
}
