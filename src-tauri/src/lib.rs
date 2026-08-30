mod terminal;

/// 创建并运行 Tauri 桌面应用。
///
/// 插件必须在应用启动阶段注册，前端才能调用对应的 JavaScript API；
/// 实际允许执行的操作还会受到 `capabilities/default.json` 的权限限制。
#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        // 提供现有的系统命令/程序启动能力。
        .plugin(tauri_plugin_shell::init())
        // 为终端中的 Ctrl+单击链接提供“使用系统默认浏览器打开 URL”的能力。
        .plugin(tauri_plugin_opener::init())
        // 所有终端共享同一份后端 PTY 会话表，命令通过 session id 定位具体会话。
        .manage(terminal::Terminals::default())
        // 暴露给前端 invoke() 的最小终端命令集合。
        .invoke_handler(tauri::generate_handler![
            terminal::start,
            terminal::write,
            terminal::resize,
            terminal::close
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
