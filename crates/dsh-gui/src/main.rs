#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::fs::{self, File};
use std::io::{Read, Write};
use std::net::{TcpListener, TcpStream};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use tauri::{Manager, RunEvent, WebviewUrl, WebviewWindowBuilder};

#[cfg(windows)]
use std::os::windows::process::CommandExt;

static SERVER: Mutex<Option<Child>> = Mutex::new(None);

const WEBVIEW2_URL: &str = "https://developer.microsoft.com/microsoft-edge/webview2/";

fn kill_server() {
    if let Some(mut child) = SERVER.lock().unwrap().take() {
        let _ = child.kill();
        let _ = child.wait();
    }
}

/// Where the payload lives:
/// 1. $DSH_PAYLOAD_DIR (explicit override)
/// 2. <exe dir>/payload  (installed layout: payload/{node,app}/)
/// 3. repo root          (dev: payload/node + node_modules)
fn payload_root() -> PathBuf {
    if let Ok(dir) = std::env::var("DSH_PAYLOAD_DIR") {
        return PathBuf::from(dir);
    }
    let exe = std::env::current_exe().unwrap_or_default();
    let exe_dir = exe.parent().unwrap_or_else(|| Path::new(".")).to_path_buf();
    let installed = exe_dir.join("payload");
    if installed.join("app").is_dir() {
        return installed;
    }
    exe_dir.join("..").join("..").join("..")
}

fn node_binary() -> PathBuf {
    let root = payload_root();
    let direct = root.join("node").join("node.exe");
    if direct.is_file() {
        direct
    } else {
        root.join("payload").join("node").join("node.exe")
    }
}

fn app_modules() -> PathBuf {
    let root = payload_root();
    let direct = root.join("app").join("node_modules");
    if direct.is_dir() {
        direct
    } else {
        root.join("node_modules")
    }
}

fn dsh_script() -> PathBuf {
    app_modules()
        .join("@deepseek-ai")
        .join("dsh")
        .join("lib")
        .join("bin.js")
}

fn log_dir() -> PathBuf {
    std::env::var_os("APPDATA")
        .map(PathBuf::from)
        .unwrap_or_else(std::env::temp_dir)
        .join("dsh-desktop")
        .join("logs")
}

fn free_port() -> u16 {
    TcpListener::bind("127.0.0.1:0")
        .expect("no free loopback port")
        .local_addr()
        .unwrap()
        .port()
}

fn spawn_server(port: u16) -> std::io::Result<Child> {
    let dir = log_dir();
    fs::create_dir_all(&dir)?;
    let stdout = File::create(dir.join("dsh-web.log"))?;
    let stderr = stdout.try_clone()?;
    let mut cmd = Command::new(node_binary());
    // GUI 程序没有控制台；不给 console 子系统的 node 子进程分配新控制台，
    // 否则每次启动都会闪一个黑色 cmd 窗口。
    #[cfg(windows)]
    cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
    cmd.arg(dsh_script())
        .args([
            "--profile",
            "web",
            "--host",
            "127.0.0.1",
            "--port",
            &port.to_string(),
        ])
        .stdin(Stdio::null())
        .stdout(Stdio::from(stdout))
        .stderr(Stdio::from(stderr));
    cmd.spawn()
}

fn wait_ready(port: u16, timeout: Duration) -> bool {
    let deadline = Instant::now() + timeout;
    while Instant::now() < deadline {
        if let Ok(mut stream) = TcpStream::connect(("127.0.0.1", port)) {
            stream.set_read_timeout(Some(Duration::from_secs(2))).ok();
            let req = format!("GET / HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nConnection: close\r\n\r\n");
            if stream.write_all(req.as_bytes()).is_ok() {
                let mut buf = Vec::new();
                if stream.read_to_end(&mut buf).is_ok()
                    && String::from_utf8_lossy(&buf).starts_with("HTTP/1.")
                {
                    return true;
                }
            }
        }
        std::thread::sleep(Duration::from_millis(300));
    }
    false
}

#[cfg(windows)]
fn webview2_installed() -> bool {
    use winreg::enums::{HKEY_CURRENT_USER, HKEY_LOCAL_MACHINE};
    use winreg::RegKey;
    const HKLM_PATH: &str =
        r"SOFTWARE\WOW6432Node\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}";
    const HKCU_PATH: &str =
        r"Software\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}";
    RegKey::predef(HKEY_LOCAL_MACHINE).open_subkey(HKLM_PATH).is_ok()
        || RegKey::predef(HKEY_CURRENT_USER).open_subkey(HKCU_PATH).is_ok()
}

#[cfg(windows)]
fn show_webview2_missing() {
    use windows::core::PCWSTR;
    use windows::Win32::UI::WindowsAndMessaging::{MessageBoxW, MB_ICONWARNING, MB_OK};
    let title: Vec<u16> = "DSH Desktop".encode_utf16().chain(std::iter::once(0)).collect();
    let text: Vec<u16> = format!(
        "未检测到 Microsoft Edge WebView2 运行时，DSH Desktop 需要它来显示界面。\n\n请从以下地址下载安装后重试：\n{WEBVIEW2_URL}"
    )
    .encode_utf16()
    .chain(std::iter::once(0))
    .collect();
    unsafe {
        MessageBoxW(
            None,
            PCWSTR(text.as_ptr()),
            PCWSTR(title.as_ptr()),
            MB_OK | MB_ICONWARNING,
        );
    }
}

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.unminimize();
                let _ = window.set_focus();
            }
        }))
        .setup(move |app| {
            #[cfg(windows)]
            if !webview2_installed() {
                show_webview2_missing();
                std::process::exit(2);
            }

            let port = free_port();
            match spawn_server(port) {
                Ok(child) => *SERVER.lock().unwrap() = Some(child),
                Err(e) => {
                    eprintln!("dsh-gui: 启动 dsh 失败: {e}");
                    std::process::exit(1);
                }
            }
            if !wait_ready(port, Duration::from_secs(60)) {
                eprintln!("dsh-gui: dsh web 服务未在 60 秒内就绪");
                kill_server();
                std::process::exit(1);
            }

            WebviewWindowBuilder::new(
                app,
                "main",
                WebviewUrl::External(format!("http://127.0.0.1:{port}").parse().unwrap()),
            )
            .title("DSH Desktop")
            .inner_size(1440.0, 900.0)
            .min_inner_size(900.0, 640.0)
            .build()?;
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|_app, event| {
            if let RunEvent::Exit = event {
                kill_server();
            }
        });
}
