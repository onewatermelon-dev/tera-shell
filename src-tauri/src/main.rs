// 防止 Windows 上发布额外的控制台窗口，请勿删除！
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    tera_shell_lib::run()
}
