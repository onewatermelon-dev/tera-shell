mod terminal;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .manage(terminal::Terminals::default())
        .invoke_handler(tauri::generate_handler![
            terminal::start,
            terminal::write,
            terminal::resize,
            terminal::close
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
