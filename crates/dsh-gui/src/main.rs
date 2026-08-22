#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod relay;
mod settings;
mod startup;

use std::fs::{self, File};
use std::io::{BufRead, BufReader, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdout, Command, Stdio};
use std::sync::atomic::{AtomicBool, AtomicU16, Ordering};
use std::sync::mpsc::{self, Receiver, SyncSender};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

use startup::ChildState;
use tauri::window::Color;
#[cfg(windows)]
use tauri::window::{Effect, EffectsBuilder};
use tauri::{Manager, RunEvent, UserAttentionType, WebviewUrl, WebviewWindowBuilder};
use tauri_plugin_notification::NotificationExt;

#[cfg(windows)]
use std::os::windows::process::CommandExt;

static SERVER: Mutex<Option<Child>> = Mutex::new(None);
// 本地转发中继：后端环境里的代理地址永远指向它；上游指向(Clash/直连)
// 由 RELAY_TARGET 持有，改设置即时切换，无需重启后端。
static RELAY_TARGET: OnceLock<relay::RelayTarget> = OnceLock::new();
static RELAY_PORT: AtomicU16 = AtomicU16::new(0);
// 当前实际生效的出口(Some=经该地址转发,None=直连),供设置面板展示。
static ACTIVE_URL: Mutex<Option<String>> = Mutex::new(None);
static RESTARTING: AtomicBool = AtomicBool::new(false);
static STARTUP_TRACE: OnceLock<StartupTrace> = OnceLock::new();
static INTERACTIVE_REPORTED: AtomicBool = AtomicBool::new(false);
static SERVER_PORT: AtomicU16 = AtomicU16::new(0);

const WEBVIEW2_URL: &str = "https://developer.microsoft.com/microsoft-edge/webview2/";
const READY_TIMEOUT: Duration = Duration::from_secs(60);

struct StartupTrace {
    started: Instant,
    file: Option<Mutex<File>>,
}

fn init_startup_trace() -> std::io::Result<()> {
    let enabled = std::env::var("DSH_STARTUP_TRACE").as_deref() == Ok("1");
    let file = if enabled {
        let dir = log_dir();
        fs::create_dir_all(&dir)?;
        Some(Mutex::new(File::create(dir.join("startup-trace.jsonl"))?))
    } else {
        None
    };
    let _ = STARTUP_TRACE.set(StartupTrace {
        started: Instant::now(),
        file,
    });
    trace_startup("process_started", None);
    Ok(())
}

fn trace_startup(phase: &str, detail: Option<&str>) {
    let Some(trace) = STARTUP_TRACE.get() else {
        return;
    };
    let Some(file) = &trace.file else {
        return;
    };
    let record = serde_json::json!({
        "elapsed_ms": trace.started.elapsed().as_secs_f64() * 1000.0,
        "phase": phase,
        "detail": detail,
    });
    let mut file = file.lock().expect("startup trace lock poisoned");
    writeln!(file, "{record}").expect("failed to write startup trace");
}

fn startup_trace_enabled() -> bool {
    STARTUP_TRACE
        .get()
        .is_some_and(|trace| trace.file.is_some())
}

#[tauri::command]
fn startup_interactive() {
    if INTERACTIVE_REPORTED
        .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
        .is_ok()
    {
        trace_startup("interactive", None);
    }
}

fn clip_notify_text(value: &str, max_chars: usize) -> String {
    value
        .chars()
        .filter(|ch| *ch == '\n' || !ch.is_control())
        .take(max_chars)
        .collect()
}

/// Windows toast for session wait/finish. Skip when the main window is focused
/// so the user is not pinged by a card they can already see. Taskbar flash
/// still runs when the window is in the background.
#[tauri::command]
fn show_desktop_notification(app: tauri::AppHandle, title: String, body: String) {
    let title = clip_notify_text(&title, 80);
    let body = clip_notify_text(&body, 200);
    if title.is_empty() {
        return;
    }
    if let Some(window) = app.get_webview_window("main") {
        if window.is_focused().unwrap_or(false) {
            return;
        }
        let _ = window.request_user_attention(Some(UserAttentionType::Informational));
    }
    let _ = app
        .notification()
        .builder()
        .title(&title)
        .body(&body)
        .show();
}

/// Proxy preferences as saved on disk plus the LIVE egress (`active_url` is
/// null for direct). Thanks to the local relay, `active_url` tracks saves
/// immediately — no restart involved.
#[tauri::command]
fn get_proxy_settings() -> serde_json::Value {
    let saved = settings::load_proxy();
    let active = ACTIVE_URL.lock().unwrap().clone();
    serde_json::json!({
        "saved": saved,
        "activeUrl": active,
    })
}

/// Validate + persist + hot-apply. The relay swaps its upstream atomically,
/// so the next connection from the backend (or any plugin/session/tool child)
/// already uses the new value.
#[tauri::command]
fn set_proxy_settings(enabled: bool, url: String, no_proxy: String) -> Result<(), String> {
    let entry = settings::ProxySettings {
        enabled,
        url,
        no_proxy,
    };
    if enabled && entry.effective().is_none() {
        return Err("代理地址无效：需要 http:// 或 https:// 开头的完整地址（例如 http://127.0.0.1:7897）".to_string());
    }
    settings::save_proxy(&entry)?;
    let live = entry.effective().map(|effective| effective.url);
    if let Some(target) = RELAY_TARGET.get() {
        target.set(live.clone());
    }
    *ACTIVE_URL.lock().unwrap() = live;
    Ok(())
}

/// Kill the dsh web process and respawn it with the freshly saved settings,
/// then reuse the normal readiness wait + navigation flow. Sessions running
/// under the old backend die with it — the panel says so before invoking.
#[tauri::command]
fn restart_backend(app: tauri::AppHandle) -> Result<(), String> {
    if RESTARTING
        .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
        .is_err()
    {
        return Err("后端正在重启中，请稍候".to_string());
    }
    trace_startup("backend_restart_requested", None);
    kill_server();
    match spawn_server() {
        Ok((child, endpoint)) => {
            *SERVER.lock().unwrap() = Some(child);
            trace_startup("server_spawned", Some("restart"));
            let app_handle = app;
            let spawned = std::thread::Builder::new()
                .name("dsh-restart-readiness".to_string())
                .spawn(move || {
                    finish_startup(app_handle, endpoint);
                    RESTARTING.store(false, Ordering::SeqCst);
                });
            spawned.map_err(|error| {
                RESTARTING.store(false, Ordering::SeqCst);
                format!("无法启动就绪检测线程：{error}")
            })?;
            Ok(())
        }
        Err(error) => {
            RESTARTING.store(false, Ordering::SeqCst);
            Err(format!("无法启动 DSH 后端：{error}"))
        }
    }
}

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
fn put_child_in_kill_job(child: &Child) -> std::io::Result<()> {
    use windows::core::PCWSTR;
    use windows::Win32::Foundation::CloseHandle;
    use windows::Win32::System::JobObjects::{
        AssignProcessToJobObject, CreateJobObjectW, JobObjectExtendedLimitInformation,
        SetInformationJobObject, JOBOBJECT_EXTENDED_LIMIT_INFORMATION,
        JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
    };
    use windows::Win32::System::Threading::{OpenProcess, PROCESS_SET_QUOTA, PROCESS_TERMINATE};

    unsafe {
        let job = CreateJobObjectW(None, PCWSTR::null())
            .map_err(|error| std::io::Error::other(error.to_string()))?;
        let mut info: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = std::mem::zeroed();
        info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
        if let Err(error) = SetInformationJobObject(
            job,
            JobObjectExtendedLimitInformation,
            &info as *const _ as *const core::ffi::c_void,
            std::mem::size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
        ) {
            let _ = CloseHandle(job);
            return Err(std::io::Error::other(format!(
                "failed to enable KILL_ON_JOB_CLOSE: {error}"
            )));
        }
        let process = match OpenProcess(PROCESS_SET_QUOTA | PROCESS_TERMINATE, false, child.id()) {
            Ok(process) => process,
            Err(error) => {
                let _ = CloseHandle(job);
                return Err(std::io::Error::other(format!(
                    "failed to open dsh web process for job assignment: {error}"
                )));
            }
        };
        if let Err(error) = AssignProcessToJobObject(job, process) {
            let _ = CloseHandle(process);
            let _ = CloseHandle(job);
            return Err(std::io::Error::other(format!(
                "failed to assign dsh web to kill job: {error}"
            )));
        }
        let _ = CloseHandle(process);
        // Intentionally retain the job handle until process exit so Windows applies
        // KILL_ON_JOB_CLOSE to the entire dsh web process tree.
        Ok(())
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

fn capture_server_stdout(
    stdout: ChildStdout,
    mut log: File,
    endpoint: SyncSender<Result<u16, startup::WaitReadyError>>,
) {
    let mut reader = BufReader::new(stdout);
    let mut line = Vec::new();
    let mut endpoint = Some(endpoint);
    let mut log_available = true;
    loop {
        line.clear();
        match reader.read_until(b'\n', &mut line) {
            Ok(0) => {
                if let Some(endpoint) = endpoint.take() {
                    let _ = endpoint.try_send(Err(startup::WaitReadyError::LogRead(
                        "dsh web stdout closed before reporting an endpoint".to_string(),
                    )));
                }
                return;
            }
            Ok(_) => {}
            Err(error) => {
                if let Some(endpoint) = endpoint.take() {
                    let _ =
                        endpoint.try_send(Err(startup::WaitReadyError::LogRead(error.to_string())));
                }
                return;
            }
        }

        if log_available {
            if let Err(error) = log.write_all(&line) {
                log_available = false;
                if let Some(endpoint) = endpoint.take() {
                    let _ = endpoint.try_send(Err(startup::WaitReadyError::LogRead(format!(
                        "failed to persist dsh web stdout: {error}"
                    ))));
                }
            }
        }
        if let Some(sender) = endpoint.as_ref() {
            match startup::parse_server_port(&String::from_utf8_lossy(&line)) {
                Ok(Some(port)) => {
                    let _ = sender.try_send(Ok(port));
                    endpoint = None;
                }
                Ok(None) => {}
                Err(error) => {
                    let _ = sender.try_send(Err(error));
                    endpoint = None;
                }
            }
        }
    }
}

fn spawn_server() -> std::io::Result<(Child, Receiver<Result<u16, startup::WaitReadyError>>)> {
    let dir = log_dir();
    fs::create_dir_all(&dir)?;
    let stdout_log = File::create(dir.join("dsh-web.log"))?;
    let stderr = stdout_log.try_clone()?;
    let mut cmd = Command::new(node_binary());
    // 代理走本地中继：环境变量只写一次、永远指向 127.0.0.1 的 relay 端口；
    // 上游(Clash 地址或直连)由 GUI 进程持有并可热切换，改设置不用重启后端。
    // 中继万一没起来，退回老行为——把真实地址静态注入。
    let saved = settings::load_proxy();
    let bypass = if saved.no_proxy.trim().is_empty() {
        settings::DEFAULT_NO_PROXY.to_string()
    } else {
        saved.no_proxy.trim().to_string()
    };
    let relay_port = RELAY_PORT.load(Ordering::Acquire);
    let applied: Option<String> = if relay_port != 0 {
        let url = format!("http://127.0.0.1:{relay_port}");
        for (name, value) in [
            ("HTTP_PROXY", url.clone()),
            ("http_proxy", url.clone()),
            ("HTTPS_PROXY", url.clone()),
            ("https_proxy", url.clone()),
            ("NO_PROXY", bypass.clone()),
            ("no_proxy", bypass),
            ("NODE_USE_ENV_PROXY", "1".to_string()),
        ] {
            cmd.env(name, value);
        }
        Some(url)
    } else if saved.apply_to(&mut cmd) {
        Some(saved.url.trim().trim_end_matches('/').to_string())
    } else {
        None
    };
    *ACTIVE_URL.lock().unwrap() = applied.clone();
    if let Some(url) = &applied {
        trace_startup("proxy_enabled", Some(url));
    }
    // GUI 程序没有控制台；不给 console 子系统的 node 子进程分配新控制台，
    // 否则每次启动都会闪一个黑色 cmd 窗口。
    #[cfg(windows)]
    cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
    cmd.arg(dsh_script())
        .args(["--profile", "web", "--no-open", "--host", "127.0.0.1", "--port", "0"])
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::from(stderr));
    let mut child = cmd.spawn()?;
    #[cfg(windows)]
    if let Err(error) = put_child_in_kill_job(&child) {
        let _ = child.kill();
        let _ = child.wait();
        return Err(error);
    }
    let stdout = match child.stdout.take() {
        Some(stdout) => stdout,
        None => {
            let _ = child.kill();
            let _ = child.wait();
            return Err(std::io::Error::other("dsh web stdout pipe was not created"));
        }
    };
    let (endpoint_tx, endpoint_rx) = mpsc::sync_channel(1);
    if let Err(error) = std::thread::Builder::new()
        .name("dsh-stdout".to_string())
        .spawn(move || capture_server_stdout(stdout, stdout_log, endpoint_tx))
    {
        let _ = child.kill();
        let _ = child.wait();
        return Err(error);
    }
    Ok((child, endpoint_rx))
}

fn server_state() -> Result<ChildState, String> {
    let mut server = SERVER
        .lock()
        .map_err(|_| "server process lock poisoned".to_string())?;
    let Some(child) = server.as_mut() else {
        return Ok(ChildState::Exited(None));
    };
    child
        .try_wait()
        .map(|status| match status {
            Some(status) => ChildState::Exited(status.code()),
            None => ChildState::Running,
        })
        .map_err(|error| error.to_string())
}

#[cfg(windows)]
fn webview2_installed() -> bool {
    use winreg::enums::{HKEY_CURRENT_USER, HKEY_LOCAL_MACHINE};
    use winreg::RegKey;
    const HKLM_PATH: &str =
        r"SOFTWARE\WOW6432Node\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}";
    const HKCU_PATH: &str =
        r"Software\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}";
    RegKey::predef(HKEY_LOCAL_MACHINE)
        .open_subkey(HKLM_PATH)
        .is_ok()
        || RegKey::predef(HKEY_CURRENT_USER)
            .open_subkey(HKCU_PATH)
            .is_ok()
}

#[cfg(windows)]
fn show_webview2_missing() {
    use windows::core::PCWSTR;
    use windows::Win32::UI::WindowsAndMessaging::{MessageBoxW, MB_ICONWARNING, MB_OK};
    let title: Vec<u16> = "DSH Desktop"
        .encode_utf16()
        .chain(std::iter::once(0))
        .collect();
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

#[cfg(windows)]
fn show_startup_error(message: &str) {
    use windows::core::PCWSTR;
    use windows::Win32::UI::WindowsAndMessaging::{MessageBoxW, MB_ICONERROR, MB_OK};
    let title: Vec<u16> = "DSH Desktop"
        .encode_utf16()
        .chain(std::iter::once(0))
        .collect();
    let text: Vec<u16> = message.encode_utf16().chain(std::iter::once(0)).collect();
    unsafe {
        MessageBoxW(
            None,
            PCWSTR(text.as_ptr()),
            PCWSTR(title.as_ptr()),
            MB_OK | MB_ICONERROR,
        );
    }
}

#[cfg(not(windows))]
fn show_startup_error(message: &str) {
    eprintln!("DSH Desktop: {message}");
}

fn is_trusted_navigation(url: &tauri::Url, port: u16) -> bool {
    if !url.username().is_empty() || url.password().is_some() {
        return false;
    }
    match (url.scheme(), url.host_str(), url.port()) {
        ("tauri", Some("localhost"), None) => true,
        ("http" | "https", Some("tauri.localhost"), None) => true,
        ("http", Some("127.0.0.1" | "localhost"), Some(candidate)) => {
            port != 0 && candidate == port
        }
        _ => false,
    }
}

/// 用系统默认浏览器打开外部链接。消息里的链接是 `target="_blank"`，
/// WebView2 默认拒绝新窗口请求——不接管的话点击毫无反应；同时防止
/// 顶层导航把整个应用窗口带离 127.0.0.1 的 web UI。
#[cfg(windows)]
fn open_in_browser(url: &str) {
    use windows::core::PCWSTR;
    use windows::Win32::UI::Shell::ShellExecuteW;
    use windows::Win32::UI::WindowsAndMessaging::SW_SHOWNORMAL;

    let action: Vec<u16> = "open".encode_utf16().chain(std::iter::once(0)).collect();
    let target: Vec<u16> = url.encode_utf16().chain(std::iter::once(0)).collect();
    unsafe {
        let _ = ShellExecuteW(
            None,
            PCWSTR(action.as_ptr()),
            PCWSTR(target.as_ptr()),
            PCWSTR::null(),
            PCWSTR::null(),
            SW_SHOWNORMAL,
        );
    }
}

#[cfg(not(windows))]
fn open_in_browser(url: &str) {
    let _ = Command::new("xdg-open").arg(url).spawn();
}

fn fail_startup(app: &tauri::AppHandle, message: String) {
    trace_startup("startup_failed", Some(&message));
    let window_exists = app.get_webview_window("main").is_some();
    kill_server();
    if !window_exists {
        return;
    }
    show_startup_error(&message);
    app.exit(1);
}

fn finish_startup(app: tauri::AppHandle, endpoint: Receiver<Result<u16, startup::WaitReadyError>>) {
    let started = Instant::now();
    let log = log_dir().join("dsh-web.log");
    let port = match startup::wait_server_port(&endpoint, READY_TIMEOUT, server_state) {
        Ok(port) => port,
        Err(error) => {
            fail_startup(
                &app,
                format!(
                    "DSH 后端未能报告监听地址：{error}\n\n请查看日志：{}",
                    log.display()
                ),
            );
            return;
        }
    };
    SERVER_PORT.store(port, Ordering::Release);
    trace_startup("server_listening", Some(&format!("port={port}")));

    let remaining = READY_TIMEOUT.saturating_sub(started.elapsed());
    match startup::wait_ready(port, remaining, server_state) {
        Ok(()) => {
            trace_startup("backend_ready", None);
            match server_state() {
                Ok(ChildState::Running) => {}
                Ok(ChildState::Exited(code)) => {
                    fail_startup(
                        &app,
                        format!("DSH 后端在界面加载前退出（退出码：{code:?}）"),
                    );
                    return;
                }
                Err(error) => {
                    fail_startup(&app, format!("无法确认 DSH 后端状态：{error}"));
                    return;
                }
            }
            let Some(window) = app.get_webview_window("main") else {
                kill_server();
                return;
            };
            let url = tauri::Url::parse(&format!("http://127.0.0.1:{port}/"))
                .expect("loopback startup URL must be valid");
            if let Err(error) = window.navigate(url) {
                fail_startup(&app, format!("无法加载 DSH 界面：{error}"));
                return;
            }
            trace_startup("navigation_requested", None);
        }
        Err(error) => {
            fail_startup(
                &app,
                format!("DSH 后端未能就绪：{error}\n\n请查看日志：{}", log.display()),
            );
        }
    }
}

fn main() {
    if let Err(error) = init_startup_trace() {
        show_startup_error(&format!("无法创建启动跟踪日志：{error}"));
        std::process::exit(1);
    }

    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.unminimize();
                let _ = window.set_focus();
            }
        }))
        // 剪贴板插件：clipboard.js 用它兜底 WebView2 里不稳定的
        // navigator.clipboard.writeText（复制按钮点击无反应的根因）。
        .plugin(tauri_plugin_clipboard::init())
        .plugin(tauri_plugin_notification::init())
        .invoke_handler(tauri::generate_handler![
            startup_interactive,
            show_desktop_notification,
            get_proxy_settings,
            set_proxy_settings,
            restart_backend
        ])
        .setup(|app| {
            #[cfg(windows)]
            if !webview2_installed() {
                trace_startup("startup_failed", Some("WebView2 runtime missing"));
                show_webview2_missing();
                std::process::exit(2);
            }

            // 先起本地中继，后端环境才能在 spawn 时指向它（热加载的根基）。
            let saved_proxy = settings::load_proxy();
            let relay_target = relay::RelayTarget::new(if saved_proxy.enabled {
                Some(saved_proxy.url.clone())
            } else {
                None
            });
            match relay::spawn(relay_target.clone()) {
                Ok(port) => {
                    RELAY_PORT.store(port, Ordering::Release);
                    let _ = RELAY_TARGET.set(relay_target);
                    trace_startup("relay_listening", Some(&format!("port={port}")));
                }
                Err(error) => {
                    trace_startup("relay_failed", Some(&error.to_string()));
                }
            }

            let endpoint = match spawn_server() {
                Ok((child, endpoint)) => {
                    *SERVER.lock().unwrap() = Some(child);
                    trace_startup("server_spawned", None);
                    endpoint
                }
                Err(error) => {
                    let message = format!("无法启动 DSH 后端：{error}");
                    trace_startup("startup_failed", Some(&message));
                    show_startup_error(&message);
                    return Err(error.into());
                }
            };

            let window =
                WebviewWindowBuilder::new(app, "main", WebviewUrl::App("index.html".into()))
                    .title("DSH Desktop")
                    .inner_size(1440.0, 900.0)
                    .min_inner_size(900.0, 640.0)
                    // 无边框窗口：去掉系统标题栏，改由注入的 titlebar.js 提供
                    // 顶部可见顶栏（拖拽区 + 右侧窗口按钮）。启动页顶栏与内容
                    // 共用同一块亚克力；进入 web UI 后把内容整体下移，顶栏不再
                    // 遮挡应用内容。
                    .decorations(false)
                    // 毛玻璃：透明窗口 + Windows 亚克力材质。启动页整窗透出；
                    // 进入 web UI 后由半透明侧栏（透明度可调）透出，工作区保持
                    // 不透明（见 titlebar.js）。
                    .transparent(true)
                    // WebView2 默认白底会把 CSS 透明像素合成回实白，亚克力
                    // 透不出来。alpha=0 才走窗口材质。
                    .background_color(Color(0, 0, 0, 0))
                    // 提示音在后台事件（回合结束/待审批）时触发，没有用户手势；
                    // WebView2 默认的自动播放策略会拦截这类带声音的播放，这里
                    // 显式放行。仅 Windows 生效（其余平台不支持、自动忽略），
                    // 并保留 wry 默认的 disable-features 参数。
                    .additional_browser_args(
                        "--disable-features=msWebOOUI,msPdfOOUI,msSmartScreenProtection \
                         --autoplay-policy=no-user-gesture-required",
                    )
                    .initialization_script(include_str!("titlebar.js"))
                    // 提示音资源（opencode MIT 音效，data URI 内嵌）：见 audio.js，
                    // 必须先于 notify.js 注入，供其按设置播放。
                    .initialization_script(include_str!("audio.js"))
                    // 会话通知 + 提示音：见 notify.js。
                    .initialization_script(include_str!("notify.js"))
                    // 剪贴板写兜底：见 clipboard.js。
                    .initialization_script(include_str!("clipboard.js"))
                    // 启动追踪：在真实 Web UI 出现第一个可交互控件时回报。
                    .initialization_script(if startup_trace_enabled() {
                        include_str!("startup.js")
                    } else {
                        ""
                    })
                    // 顶层导航：内部地址放行，外站转到系统默认浏览器并拦截，
                    // 避免消息里的链接把整个应用窗口带离 web UI。
                    .on_navigation(move |url| {
                        if is_trusted_navigation(url, SERVER_PORT.load(Ordering::Acquire)) {
                            true
                        } else {
                            open_in_browser(url.as_str());
                            false
                        }
                    })
                    // target="_blank" 的新窗口请求：WebView2 默认拒绝（点了没反应），
                    // 这里把外站链接交给系统浏览器。
                    .on_new_window(move |url, _features| {
                        if is_trusted_navigation(&url, SERVER_PORT.load(Ordering::Acquire)) {
                            tauri::webview::NewWindowResponse::Allow
                        } else {
                            open_in_browser(url.as_str());
                            tauri::webview::NewWindowResponse::Deny
                        }
                    })
                    .build()?;
            trace_startup("webview_created", None);

            #[cfg(windows)]
            let _ = window.set_effects(EffectsBuilder::new().effect(Effect::Acrylic).build());

            let app_handle = app.handle().clone();
            if let Err(error) = std::thread::Builder::new()
                .name("dsh-readiness".to_string())
                .spawn(move || finish_startup(app_handle, endpoint))
            {
                let message = format!("无法启动就绪检测线程：{error}");
                trace_startup("startup_failed", Some(&message));
                kill_server();
                show_startup_error(&message);
                return Err(error.into());
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn navigation_allows_only_the_current_loopback_service_and_app_origin() {
        let port = 49_152;
        for allowed in [
            "http://127.0.0.1:49152/",
            "http://localhost:49152/session",
            "http://tauri.localhost/",
            "tauri://localhost/index.html",
        ] {
            let url = tauri::Url::parse(allowed).unwrap();
            assert!(
                is_trusted_navigation(&url, port),
                "expected allowed: {allowed}"
            );
        }

        for rejected in [
            "http://127.0.0.1:49153/",
            "http://127.0.0.1:49152@evil.example/",
            "http://127.0.0.1.evil.example:49152/",
            "https://127.0.0.1:49152/",
            "https://example.com/",
            "file:///C:/Windows/System32/calc.exe",
            "data:text/html,hello",
            "javascript:alert(1)",
        ] {
            let url = tauri::Url::parse(rejected).unwrap();
            assert!(
                !is_trusted_navigation(&url, port),
                "expected rejected: {rejected}"
            );
        }
    }
}
