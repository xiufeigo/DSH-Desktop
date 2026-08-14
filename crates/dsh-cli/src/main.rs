#![cfg_attr(target_os = "windows", windows_subsystem = "console")]

use dsh_cli::{dsh_script, ensure_payload, node_binary};
use std::process::{Command, ExitCode};

#[cfg(unix)]
fn ignore_sigint() {
    // Let the terminal's Ctrl+C reach the node child (same foreground process
    // group); the parent keeps waiting and mirrors the child's exit code.
    unsafe {
        libc::signal(libc::SIGINT, libc::SIG_IGN);
    }
}

fn main() -> ExitCode {
    let exe = std::env::current_exe().unwrap_or_default();
    let payload = match ensure_payload(&exe) {
        Ok(dir) => dir,
        Err(e) => {
            eprintln!("dsh-cli: {e}");
            return ExitCode::from(1);
        }
    };

    #[cfg(unix)]
    ignore_sigint();

    let args: Vec<_> = std::env::args_os().skip(1).collect();
    let status = Command::new(node_binary(&payload))
        .arg(dsh_script(&payload))
        .args(&args)
        .status();

    match status {
        Ok(st) => ExitCode::from(st.code().unwrap_or(1).clamp(0, 255) as u8),
        Err(e) => {
            eprintln!("dsh-cli: 启动 Node 失败: {e}");
            ExitCode::from(1)
        }
    }
}
