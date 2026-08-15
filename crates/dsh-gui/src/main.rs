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
use tauri::window::{Effect, EffectsBuilder};

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

/// 把 dsh web 服务子进程挂进带 KILL_ON_JOB_CLOSE 的 Job Object。
///
/// GUI 主进程无论以何种方式退出（正常关闭、崩溃、以及安装器升级时的
/// 强制终止），操作系统都会在本进程的句柄被关闭时终止整个作业——孤儿
/// node.exe 随之退出，释放对 payload 文件（node.exe / ICU DLL / .node
/// 插件等）的锁。否则安装器只杀主进程、残留 node 子进程锁文件，下次
/// 覆盖安装会在拷贝 payload 时弹"打开文件写入时出错"。
#[cfg(windows)]
fn put_child_in_kill_job(child: &Child) {
    use windows::core::PCWSTR;
    use windows::Win32::Foundation::CloseHandle;
    use windows::Win32::System::JobObjects::{
        AssignProcessToJobObject, CreateJobObjectW, JobObjectExtendedLimitInformation,
        SetInformationJobObject, JOBOBJECT_EXTENDED_LIMIT_INFORMATION,
        JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
    };
    use windows::Win32::System::Threading::{OpenProcess, PROCESS_SET_QUOTA, PROCESS_TERMINATE};

    unsafe {
        let Ok(job) = CreateJobObjectW(None, PCWSTR::null()) else {
            return;
        };
        let mut info: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = std::mem::zeroed();
        info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
        let _ = SetInformationJobObject(
            job,
            JobObjectExtendedLimitInformation,
            &info as *const _ as *const core::ffi::c_void,
            std::mem::size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
        );
        if let Ok(process) =
            OpenProcess(PROCESS_SET_QUOTA | PROCESS_TERMINATE, false, child.id())
        {
            if AssignProcessToJobObject(job, process).is_ok() {
                // 挂入成功：不关闭 job 句柄（HANDLE 是 Copy 且无 Drop，
                // 出作用域即自然留存）。本进程退出时系统代为关闭，
                // 触发 KILL_ON_JOB_CLOSE 杀掉作业内全部子进程。
                let _ = CloseHandle(process);
                return;
            }
            let _ = CloseHandle(process);
        }
        // 挂入失败（例如环境已禁止嵌套作业）：关掉句柄，仅失去加固能力，
        // 不影响应用运行。
        let _ = CloseHandle(job);
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
    let child = cmd.spawn()?;
    #[cfg(windows)]
    put_child_in_kill_job(&child);
    Ok(child)
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
            // 无边框窗口：去掉系统标题栏，改由注入的 titlebar.js 提供
            // 顶部可见顶栏（拖拽区 + 右侧窗口按钮），并把 web 内容整体下移，
            // 顶栏不再遮挡应用内容。
            .decorations(false)
            // 毛玻璃：透明窗口 + Windows 亚克力材质，由 web UI 的透明
            // 画布与半透明侧栏透出（见 titlebar.js 注入的 frosted 样式）。
            .transparent(true)
            .initialization_script(include_str!("titlebar.js"))
            .build()?;

            #[cfg(windows)]
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.set_effects(
                    EffectsBuilder::new().effect(Effect::Acrylic).build(),
                );
            }
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
