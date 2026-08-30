use portable_pty::{CommandBuilder, MasterPty, PtySize, native_pty_system};
use serde::{Deserialize, Serialize};
use std::{collections::HashMap, io::Write, sync::Mutex};
use tauri::{AppHandle, Emitter, State};

struct Session {
    writer: Box<dyn Write + Send>,
    master: Box<dyn MasterPty + Send>,
    child: Box<dyn portable_pty::Child + Send + Sync>,
}

#[derive(Default)]
pub struct Terminals(Mutex<HashMap<String, Session>>);

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Config {
    id: String,
    kind: String,
    host: Option<String>,
    port: Option<u16>,
    username: Option<String>,
}

#[derive(Clone, Serialize)]
struct Output {
    id: String,
    data: String,
}

#[tauri::command(rename = "terminal_start")]
pub fn start(app: AppHandle, config: Config, terminals: State<Terminals>) -> Result<(), String> {
    let pty = native_pty_system()
        .openpty(PtySize {
            rows: 30,
            cols: 100,
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|error| error.to_string())?;
    let mut command = command(&config)?;
    if let Some(home) = std::env::var_os(if cfg!(windows) { "USERPROFILE" } else { "HOME" }) {
        command.cwd(home);
    }
    let child = pty
        .slave
        .spawn_command(command)
        .map_err(|error| error.to_string())?;
    let mut reader = pty
        .master
        .try_clone_reader()
        .map_err(|error| error.to_string())?;
    let writer = pty
        .master
        .take_writer()
        .map_err(|error| error.to_string())?;
    let id = config.id;
    terminals.0.lock().map_err(|_| "终端状态不可用")?.insert(
        id.clone(),
        Session {
            writer,
            master: pty.master,
            child,
        },
    );
    std::thread::spawn(move || {
        let mut buffer = [0_u8; 8192];
        while let Ok(size) = std::io::Read::read(&mut reader, &mut buffer) {
            if size == 0 {
                break;
            }
            let _ = app.emit(
                "terminal-output",
                Output {
                    id: id.clone(),
                    data: String::from_utf8_lossy(&buffer[..size]).into_owned(),
                },
            );
        }
        let _ = app.emit("terminal-exit", id);
    });
    Ok(())
}

fn command(config: &Config) -> Result<CommandBuilder, String> {
    if config.kind != "ssh" {
        return Ok(if cfg!(windows) {
            let mut command = CommandBuilder::new("powershell.exe");
            command.arg("-NoLogo");
            command
        } else {
            CommandBuilder::new(std::env::var("SHELL").unwrap_or_else(|_| "/bin/sh".into()))
        });
    }
    let host = config
        .host
        .as_ref()
        .filter(|value| !value.trim().is_empty())
        .ok_or("请输入主机地址")?;
    let target = config
        .username
        .as_ref()
        .filter(|value| !value.trim().is_empty())
        .map_or_else(|| host.clone(), |username| format!("{username}@{host}"));
    let mut command = CommandBuilder::new("ssh");
    command.args(["-tt", "-p", &config.port.unwrap_or(22).to_string(), &target]);
    Ok(command)
}

#[tauri::command(rename = "terminal_write")]
pub fn write(id: String, data: String, terminals: State<Terminals>) -> Result<(), String> {
    let mut sessions = terminals.0.lock().map_err(|_| "终端状态不可用")?;
    let session = sessions.get_mut(&id).ok_or("终端会话不存在")?;
    session
        .writer
        .write_all(data.as_bytes())
        .map_err(|error| error.to_string())?;
    session.writer.flush().map_err(|error| error.to_string())
}

#[tauri::command(rename = "terminal_resize")]
pub fn resize(id: String, rows: u16, cols: u16, terminals: State<Terminals>) -> Result<(), String> {
    terminals
        .0
        .lock()
        .map_err(|_| "终端状态不可用")?
        .get(&id)
        .ok_or("终端会话不存在")?
        .master
        .resize(PtySize {
            rows,
            cols,
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|error| error.to_string())
}

#[tauri::command(rename = "terminal_close")]
pub fn close(id: String, terminals: State<Terminals>) -> Result<(), String> {
    if let Some(mut session) = terminals
        .0
        .lock()
        .map_err(|_| "终端状态不可用")?
        .remove(&id)
    {
        session.child.kill().map_err(|error| error.to_string())?;
        let _ = session.child.wait();
    }
    Ok(())
}
