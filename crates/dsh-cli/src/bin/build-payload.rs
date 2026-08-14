//! Append a tar.zst payload + footer to a launcher binary.
//!
//! usage: cargo run --release --bin build-payload -- <payload-dir> <launcher-exe> <output>

use dsh_cli::MAGIC;
use sha2::{Digest, Sha256};
use std::fs::{self, File};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};

/// Append every file under `dir` with a fixed mtime (0) and sorted order so
/// identical payloads produce identical archives — same content, same binary
/// hash, same extraction cache.
fn append_tree<W: Write>(builder: &mut tar::Builder<W>, dir: &Path) -> std::io::Result<()> {
    fn walk(dir: &Path, base: &Path, out: &mut Vec<PathBuf>) {
        let mut entries: Vec<_> = fs::read_dir(dir)
            .expect("read payload dir")
            .filter_map(|e| e.ok())
            .collect();
        entries.sort_by_key(|e| e.file_name());
        for entry in entries {
            let path = entry.path();
            if entry.file_type().expect("file type").is_dir() {
                walk(&path, base, out);
            } else {
                out.push(path.strip_prefix(base).expect("strip prefix").to_path_buf());
            }
        }
    }
    let mut files = Vec::new();
    walk(dir, dir, &mut files);
    for rel in files {
        let full = dir.join(&rel);
        let meta = fs::metadata(&full)?;
        let mut header = tar::Header::new_gnu();
        header.set_metadata(&meta);
        header.set_mtime(0);
        header.set_cksum();
        let mut f = File::open(&full)?;
        builder.append_data(&mut header, &rel, &mut f)?;
    }
    Ok(())
}

fn main() {
    let args: Vec<String> = std::env::args().collect();
    if args.len() != 4 {
        eprintln!("usage: build-payload <payload-dir> <launcher-exe> <output>");
        std::process::exit(2);
    }
    let payload_dir = &args[1];
    let launcher = &args[2];
    let output = &args[3];

    let mut tar_bytes = Vec::new();
    {
        let mut builder = tar::Builder::new(&mut tar_bytes);
        append_tree(&mut builder, Path::new(payload_dir)).expect("tar payload");
        builder.finish().expect("finish tar");
    }
    let compressed = zstd::bulk::compress(&tar_bytes, 12).expect("zstd compress");

    let mut launcher_bytes = Vec::new();
    File::open(launcher)
        .expect("open launcher")
        .read_to_end(&mut launcher_bytes)
        .expect("read launcher");

    let mut out = File::create(output).expect("create output");
    out.write_all(&launcher_bytes).expect("write launcher");
    let offset = launcher_bytes.len() as u64;
    out.write_all(&compressed).expect("write payload");
    let sha = format!("{:x}", Sha256::digest(&compressed));
    out.write_all(MAGIC).expect("write magic");
    out.write_all(&offset.to_le_bytes()).expect("write offset");
    out.write_all(sha.as_bytes()).expect("write sha");

    let mb = compressed.len() as f64 / 1024.0 / 1024.0;
    println!("build-payload: payload={:.1} MB, output={}", mb, output);
}
