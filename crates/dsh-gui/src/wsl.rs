//! WSL2 backend runtime for DSH Desktop.
//!
//! When the user switches the backend to `wsl`, the GUI can no longer execute
//! the bundled Windows `node.exe` — a WSL2 kernel cannot run PE binaries or
//! the win32 native modules in the payload. Instead the DSH web server runs
//! inside a chosen distro and is bridged to the WebView by WSL2's default
//! `localhostForwarding` (a service bound on the distro's 127.0.0.1 shows up
//! on the Windows host at the same loopback port). The readiness/probe flow in
//! `startup.rs` therefore works unchanged.
//!
//! Runtime source, resolved in order:
//!   1. A bundled Linux payload (Windows install dir payload-linux/, produced
//!      by a Linux/CI build) — deployed into the distro on first use and
//!      invoked directly. Zero install, matches the desktop philosophy.
//!   2. Fallback: an existing global `dsh` already installed inside the
//!      distro (PATH). Keeps WSL mode usable even without a Linux payload.
//!
//! Because `sharp`/`koffi`/`node-pty` ship platform-specific binaries and only
//! the win32 variants are installed by `npm ci` on Windows, a Linux payload
//! cannot be assembled on a Windows machine; this module only *consumes* one.

use std::io::Write;
use std::path::Path;
use std::process::{Command, Stdio};

use crate::settings::BackendSettings;

/// Stream a gzipped tar of a directory tree by delegating to the system
/// `tar.exe` (bsdtar, shipped with Win10/11 and already used by
/// fetch-node.mjs). The archive is emitted to stdout gz-compressed, so it can
/// be piped straight into the wsl-side `tar -xz`.
fn stream_tar_tree(source: &Path, stdout: &mut impl std::io::Write) -> std::io::Result<()> {
    use std::process::Stdio;
    // `-czf -` writes a gzip tar to stdout; `-C <src>` changes dir so the
    // archive contains `./node`, `./app`, … extracted relative to deploy dir.
    let mut cmd = Command::new("tar.exe");
    cmd.arg("-czf")
        .arg("-")
        .arg("-C")
        .arg(source)
        .arg(".")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    let mut child = cmd.spawn()?;
    let mut out = child.stdout.take().unwrap();
    std::io::copy(&mut out, stdout)?;
    let status = child.wait()?;
    if !status.success() {
        return Err(std::io::Error::other(format!("tar.exe failed: {status}")));
    }
    Ok(())
}

/// Arguments for `wsl.exe` selecting a distro (when configured).
fn wsl_distro_args(backend: &BackendSettings) -> Vec<String> {
    if backend.distro.trim().is_empty() {
        Vec::new()
    } else {
        vec!["-d".into(), backend.distro.trim().to_string()]
    }
}

/// Where a bundled Linux payload would land in the installed layout. Tauri
/// bundles `payload/**/*`, so a linux build drops it at `<install>/payload-linux/`.
pub fn bundled_linux_payload_root() -> Option<std::path::PathBuf> {
    let root = crate::payload_root();
    let candidate = root.join("payload-linux");
    let node = candidate.join("node").join("bin").join("node");
    let bin = candidate
        .join("app")
        .join("node_modules")
        .join("@deepseek-ai")
        .join("dsh")
        .join("lib")
        .join("bin.js");
    if node.is_file() && bin.is_file() {
        Some(candidate)
    } else {
        None
    }
}

/// Probe for the WSL CLI so the settings panel / startup can surface a
/// friendly error instead of a confusing spawn failure.
pub fn check_wsl() -> Result<(), String> {
    Command::new("wsl.exe")
        .args(["--status"])
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .map_err(|e| format!("wsl.exe 不可用（是否已安装 WSL？）：{e}"))?;
    Ok(())
}

/// Quoted shell literal so a path with spaces survives `sh -lc '...'`.
fn shq(value: &str) -> String {
    format!("'{}'", value.replace('\'', "'\\''"))
}

/// Deploy dir with `~/` expanded to `$HOME`, resolved inside the distro.
pub fn resolved_deploy_dir(backend: &BackendSettings) -> String {
    let raw = backend.deploy_dir.trim();
    if raw.is_empty() || raw == "~" {
        "$HOME".to_string()
    } else if raw.starts_with("~/") {
        format!("$HOME/{}", raw.trim_start_matches("~/"))
    } else if raw.ends_with('/') {
        raw.trim_end_matches('/').to_string()
    } else {
        raw.to_string()
    }
}

/// Result of an ensure-deploy pass.
pub struct DeployOutcome {
    /// Directory the payload lives in on the Linux side.
    pub deploy_dir: String,
    /// Non-empty when the switch used the bundled-payload path; empty string
    /// when it fell back to an in-distro `dsh` because no payload was bundled.
    pub payload_dir: String,
}

/// Lay the bundled Linux payload into the distro if it is present and the
/// deployed marker is absent or stale. Streams a tar over wsl's stdin so the
/// copy crosses the filesystem boundary in one robust pass (no slow \\wsl$,
/// no per-file attribute/mode drift). A marker file records the source
/// fingerprint so a changed bundled payload is re-deployed next time.
///
/// When no Linux payload is bundled, returns an Ok outcome with an empty
/// `payload_dir` and a `warning` so the caller knows to fall back to an
/// in-distro dsh.
pub fn ensure_deployed(
    backend: &BackendSettings,
) -> Result<(DeployOutcome, Option<String>), String> {
    let deploy = resolved_deploy_dir(backend);
    let Some(source) = bundled_linux_payload_root() else {
        let warning = Some(
            "未内置 Linux 载荷（本安装包不含 payload-linux），将尝试使用发行版内已安装的 dsh".into(),
        );
        return Ok((
            DeployOutcome {
                deploy_dir: deploy,
                payload_dir: String::new(),
            },
            warning,
        ));
    };

    let meta = std::fs::metadata(source.join("node").join("bin").join("node"))
        .map_err(|e| format!("读取内置 Linux 载荷失败：{e}"))?;
    let nanos = meta
        .modified()
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .unwrap_or_default()
        .as_nanos();
    let fingerprint = format!("{}:{}", meta.len(), nanos);
    let marker = format!("{deploy}/.dsh-deployed");

    // Read the deployed marker (empty if never deployed).
    let read = Command::new("wsl.exe")
        .args(wsl_distro_args(backend))
        .args([
            "-e",
            "sh",
            "-lc",
            &format!("cat {marker} 2>/dev/null || true"),
        ])
        .stdin(Stdio::null())
        .output()
        .map_err(|e| format!("无法在 WSL 中检查已部署载荷：{e}"))?;
    let current = String::from_utf8_lossy(&read.stdout).trim().to_string();
    if current == fingerprint && !current.is_empty() {
        return Ok((
            DeployOutcome {
                deploy_dir: deploy,
                payload_dir: source.to_string_lossy().replace('\\', "/"),
            },
            None,
        ));
    }

    // Redeploy: reset the deploy dir, then stream tar into it.
    let bootstrap = format!(
        "rm -rf {} && mkdir -p {} && tar -xz -C {} && printf %s {} > {}",
        shq(&deploy),
        shq(&deploy),
        shq(&deploy),
        shq(&fingerprint),
        shq(&marker),
    );
    let mut target = Command::new("wsl.exe");
    target
        .args(wsl_distro_args(backend))
        .args(["-e", "sh", "-lc", &bootstrap])
        .stdin(Stdio::piped())
        .stdout(Stdio::inherit())
        .stderr(Stdio::inherit());
    let mut child = target
        .spawn()
        .map_err(|e| format!("无法启动 WSL 部署进程：{e}"))?;
    {
        let stdin = child.stdin.take().ok_or("WSL 部署进程没有 stdin")?;
        let mut writer = std::io::BufWriter::new(stdin);
        stream_tar_tree(&source, &mut writer)
            .map_err(|e| format!("打包/写入 Linux 载荷到 WSL 失败：{e}"))?;
        writer.flush().map_err(|e| format!("写载荷到 WSL 失败：{e}"))?;
        drop(writer);
    }
    let status = child
        .wait()
        .map_err(|e| format!("等待 WSL 部署结束失败：{e}"))?;
    if !status.success() {
        return Err(format!("WSL 载荷部署失败（退出码 {status}）"));
    }
    Ok((
        DeployOutcome {
            deploy_dir: deploy,
            payload_dir: source.to_string_lossy().replace('\\', "/"),
        },
        None,
    ))
}

/// The dsh web bootstrap suffix shared by both payload modes.
fn dsh_web_args() -> &'static str {
    "--profile web --no-open --host 127.0.0.1 --port 0"
}

/// Spawn `dsh web` inside the distro in the foreground. Keeping it in the
/// foreground (no nohup/detach) means the `wsl.exe` child stays alive and
/// represents the backend, so the existing `capture_server_stdout` /
/// `server_state` / kill flow in main.rs works unchanged. The Linux PID is
/// recorded to a pidfile so we can terminate the real process — killing only
/// the wsl.exe relay would orphan it.
///
/// Returns a fully configured `wsl.exe` command (stdout piped, stderr not yet
/// assigned so main.rs can point it at the log file). main.rs owns spawning
/// so the native and WSL paths share the same stdout/proxy plumbing.
pub fn build_command(
    backend: &BackendSettings,
    outcome: &DeployOutcome,
) -> Command {
    let deploy = &outcome.deploy_dir;
    let pidfile = format!("{deploy}/.dsh.pid");

    let run = if !outcome.payload_dir.is_empty() {
        // Bundled Linux payload deployed under deploy_dir.
        let node = format!("{}/{}/{}", deploy, "node", "bin/node");
        let bin = format!(
            "{}/{}/{}",
            deploy, "app/node_modules", "@deepseek-ai/dsh/lib/bin.js"
        );
        format!(
            "echo $$ > {pid} && exec {node} {bin} {args}",
            pid = shq(&pidfile),
            node = shq(&node),
            bin = shq(&bin),
            args = dsh_web_args(),
        )
    } else {
        // In-distro dsh fallback. Prefer the Linux npm-global prefix: WSL
        // often inherits /mnt/c/.../npm from Windows, whose dsh shim points
        // at win32 native modules and must never be selected by accident.
        format!(
            "echo $$ > {pid} && if [ -x \"$HOME/.npm-global/bin/dsh\" ]; then exec \"$HOME/.npm-global/bin/dsh\" web {args}; else exec dsh web {args}; fi",
            pid = shq(&pidfile),
            args = dsh_web_args(),
        )
    };

    let mut cmd = Command::new("wsl.exe");
    cmd.args(wsl_distro_args(backend))
        .args(["-e", "sh", "-lc", &run])
        .stdin(Stdio::null())
        .stdout(Stdio::piped());
    cmd
}

/// Terminate the Linux backend. Uses the pidfile written at spawn; falls back
/// to pkill of the dsh bin path. This actually stops the WSL process tree.
pub fn kill_remote(backend: &BackendSettings) {
    let deploy = resolved_deploy_dir(backend);
    let pidfile = format!("{deploy}/.dsh.pid");
    let script = format!(
        "pid=$(cat {} 2>/dev/null || true); \
         [ -n \"$pid\" ] && kill -9 $pid 2>/dev/null; \
         pkill -f '@deepseek-ai/dsh/lib/bin.js' 2>/dev/null; \
         rm -f {}; true",
        shq(&pidfile),
        shq(&pidfile),
    );
    let _ = Command::new("wsl.exe")
        .args(wsl_distro_args(backend))
        .args(["-e", "sh", "-lc", &script])
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status();
}