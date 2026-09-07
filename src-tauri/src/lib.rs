pub mod logging;
mod secret;
pub mod terminal;

/// 前端 F12 / Ctrl+Shift+I 打开 DevTools。
/// 浏览器级快捷键被禁用后 F12 不再生效，需要走这个命令手动打开。
#[tauri::command]
fn open_devtools(window: tauri::WebviewWindow) {
    window.open_devtools();
}

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
            terminal::close,
            secret::encrypt,
            secret::decrypt,
            open_devtools
        ])
        .setup(|app| {
            // 优先初始化日志，后续启动阶段的错误都能被记录。
            logging::init(app);
            // WebView2 的浏览器级快捷键（Ctrl+F 页面查找栏等）会抢在页面 JS 之前
            // 响应，preventDefault 拦不住；原生禁用后查找统一走应用内实现。
            #[cfg(target_os = "windows")]
            {
                use tauri::Manager;
                if let Some(window) =
                    app.get_webview_window("main")
                {
                    let _ = window.with_webview(|webview| {
                        #[cfg(target_os = "windows")]
                        unsafe {
                            use windows_core::Interface;
                            let controller = webview.controller();
                            if let Ok(webview2) =
                                controller.CoreWebView2()
                            {
                                if let Ok(settings) =
                                    webview2.Settings()
                                {
                                    let _ = settings
                                        .cast::<webview2_com::Microsoft::Web::WebView2::Win32::ICoreWebView2Settings3>()
                                        .and_then(|s| {
                                            s.SetAreBrowserAcceleratorKeysEnabled(
                                                false
                                            )
                                        });
                                }
                            }
                        }
                    });
                }
            }
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
