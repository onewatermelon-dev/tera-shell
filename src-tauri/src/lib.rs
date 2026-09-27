// 后端按功能域分目录：每个域一个模块目录，域内再按职责拆文件。
// 模块路径与原先的 `xxx.rs` 完全一致，所以域内代码无需改动。
pub mod ai;
pub mod data;
pub mod fonts;
pub mod fs;
pub mod icons;
/// 基础设施（日志、凭据加解密）
pub mod infra;
pub mod sftp;
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
        // 设置页选择“数据存储路径”时弹出系统文件夹选择框。
        .plugin(tauri_plugin_dialog::init())
        // 所有终端共享同一份后端 PTY 会话表，命令通过 session id 定位具体会话。
        .manage(terminal::Terminals::default())
        // SFTP 连接按目标缓存，避免每次进目录都重新握手认证。
        .manage(sftp::SftpPool::default())
        // 进行中的传输任务表，供暂停 / 恢复 / 取消命令定位任务。
        .manage(sftp::Transfers::default())
        // 正在被本地编辑的远程文件，保存后自动回传。
        .manage(sftp::open::EditWatchers::default())
        // AI 命令的 exec 会话池：独立于终端 PTY 的命令执行通道。
        .manage(ai::ExecPool::default())
        // 暴露给前端 invoke() 的最小终端命令集合。
        .invoke_handler(tauri::generate_handler![
            terminal::start,
            terminal::write,
            terminal::resize,
            terminal::close,
            fs::list_dir,
            fs::places,
            fs::drives,
            fs::open_path,
            fs::open_notepad,
            fs::make_dir,
            fs::create_file,
            fs::remove_path,
            fs::copy_path,
            fs::rename::rename_local,
            sftp::list,
            sftp::upload,
            sftp::download,
            sftp::make_remote_dir,
            sftp::create_remote_file,
            sftp::remove_remote_path,
            sftp::chmod,
            sftp::pause_transfer,
            sftp::open::edit_remote,
            sftp::open::stop_edit,
            sftp::open::stop_all_edits,
            sftp::rename::rename_remote,
            sftp::window::open_sftp_window,
            sftp::resume_transfer,
            sftp::cancel_transfer,
            ai::run_command,
            ai::chat_stream,
            infra::secret::encrypt,
            infra::secret::decrypt,
            infra::http::http_post_json,
            infra::http::http_post_text,
            data::load_all,
            data::save_one,
            data::current_root,
            data::set_data_dir,
            data::pick_data_dir,
            fonts::list_fonts,
            open_devtools
        ])
        .setup(|app| {
            // 优先初始化日志，后续启动阶段的错误都能被记录。
            infra::logging::init(app);
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
