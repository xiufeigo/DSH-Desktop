//! dsh-cli: single-binary launcher for the DeepSeek Harness CLI.
//!
//! Layout of the shipped binary:
//!   [ executable code ] [ tar.zst payload: node/ + app/node_modules/ ] [ footer ]
//!   footer = MAGIC(16 bytes) + payload offset(u64 LE) + sha256 hex of payload(64 chars)
//!
//! On first run the payload is extracted to a per-hash cache directory under
//! %LOCALAPPDATA%\dsh-cli (Windows) or $XDG_CACHE_HOME/dsh-cli (Linux) and
//! reused afterwards, so only the very first invocation pays the extraction
//! cost. A `.lock` directory serialises concurrent first runs.

use sha2::{Digest, Sha256};
use std::fs::{self, File};
use std::io::{Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::process::Command;
use std::thread;
use std::time::{Duration, Instant};

pub mod proxy;

/// Inject the wrapper-owned proxy preference into a dsh child command (same
/// settings.json the GUI reads; see [`proxy`] for the contract). Returns
/// whether a proxy was applied.
pub fn configure_proxy(cmd: &mut Command) -> bool {
    let entry = proxy::load_proxy();
    entry.apply_to(cmd)
}

pub const MAGIC: &[u8; 16] = b"DSHCLIPAYLOAD001";
pub const FOOTER_LEN: u64 = 16 + 8 + 64;

/// Locate the payload appended to this binary. Returns (offset, sha256 hex).
pub fn payload_info(exe: &Path) -> Option<(u64, String)> {
    let mut file = File::open(exe).ok()?;
    let total = file.metadata().ok()?.len();
    if total <= FOOTER_LEN {
        return None;
    }
    file.seek(SeekFrom::End(-(FOOTER_LEN as i64))).ok()?;
    let mut footer = vec![0u8; FOOTER_LEN as usize];
    file.read_exact(&mut footer).ok()?;
    if &footer[..16] != MAGIC {
        return None;
    }
    let offset = u64::from_le_bytes(footer[16..24].try_into().ok()?);
    if offset >= total - FOOTER_LEN {
        return None;
    }
    Some((offset, String::from_utf8_lossy(&footer[24..]).to_string()))
}

fn cache_root() -> PathBuf {
    #[cfg(windows)]
    {
        std::env::var_os("LOCALAPPDATA")
            .map(PathBuf::from)
            .unwrap_or_else(std::env::temp_dir)
            .join("dsh-cli")
    }
    #[cfg(not(windows))]
    {
        std::env::var_os("XDG_CACHE_HOME")
            .map(PathBuf::from)
            .or_else(|| std::env::var_os("HOME").map(|h| PathBuf::from(h).join(".cache")))
            .unwrap_or_else(std::env::temp_dir)
            .join("dsh-cli")
    }
}

fn read_archive(exe: &Path, offset: u64) -> Result<Vec<u8>, String> {
    let mut file = File::open(exe).map_err(|e| format!("无法读取自身: {e}"))?;
    let total = file.metadata().map_err(|e| format!("无法读取自身: {e}"))?.len();
    file.seek(SeekFrom::Start(offset)).map_err(|e| format!("读取失败: {e}"))?;
    let size = (total - FOOTER_LEN - offset) as usize;
    let mut buf = vec![0u8; size];
    file.read_exact(&mut buf).map_err(|e| format!("读取失败: {e}"))?;
    Ok(buf)
}

/// Make sure the embedded payload is extracted (once) and return its root dir.
pub fn ensure_payload(exe: &Path) -> Result<PathBuf, String> {
    let (offset, sha) = payload_info(exe)
        .ok_or_else(|| "此二进制未内嵌 dsh 载荷（请使用官方打包产物）".to_string())?;
    let archive = read_archive(exe, offset)?;
    let digest = format!("{:x}", Sha256::digest(&archive));
    if digest != sha {
        return Err("内置载荷校验失败，二进制可能已损坏，请重新下载".to_string());
    }

    let key = &digest[..16];
    let root = cache_root();
    fs::create_dir_all(&root).map_err(|e| format!("创建缓存目录失败: {e}"))?;
    let dir = root.join(key);
    let ready = dir.join(".ready");
    if ready.is_file() {
        return Ok(dir);
    }

    let lock = root.join(format!("{key}.lock"));
    match fs::create_dir(&lock) {
        Ok(()) => {
            let result = extract_payload(&archive, &dir, &ready);
            let _ = fs::remove_dir(&lock);
            result?;
            Ok(dir)
        }
        Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => {
            let deadline = Instant::now() + Duration::from_secs(120);
            while Instant::now() < deadline {
                if ready.is_file() {
                    return Ok(dir);
                }
                thread::sleep(Duration::from_millis(300));
            }
            Err("等待另一进程解压载荷超时（2 分钟）".to_string())
        }
        Err(e) => Err(format!("创建锁目录失败: {e}")),
    }
}

fn extract_payload(archive: &[u8], dir: &Path, ready: &Path) -> Result<(), String> {
    if ready.is_file() {
        return Ok(());
    }
    eprintln!("dsh-cli: 首次运行，正在解压内置载荷（约 300 MB），仅此一次…");
    let tar_bytes = zstd::stream::decode_all(archive).map_err(|e| format!("载荷解压失败: {e}"))?;
    fs::create_dir_all(dir).map_err(|e| format!("创建缓存目录失败: {e}"))?;
    let mut ar = tar::Archive::new(&tar_bytes[..]);
    ar.set_preserve_permissions(false);
    ar.unpack(dir).map_err(|e| format!("载荷解包失败: {e}"))?;
    fs::write(ready, b"ok").map_err(|e| format!("写入就绪标记失败: {e}"))?;
    Ok(())
}

/// Path to the bundled node binary inside an extracted payload dir.
#[cfg(windows)]
pub fn node_binary(payload: &Path) -> PathBuf {
    payload.join("node").join("node.exe")
}

#[cfg(not(windows))]
pub fn node_binary(payload: &Path) -> PathBuf {
    payload.join("node").join("bin").join("node")
}

/// Path to the dsh entry script inside an extracted payload dir.
pub fn dsh_script(payload: &Path) -> PathBuf {
    payload
        .join("app")
        .join("node_modules")
        .join("@deepseek-ai")
        .join("dsh")
        .join("lib")
        .join("bin.js")
}
