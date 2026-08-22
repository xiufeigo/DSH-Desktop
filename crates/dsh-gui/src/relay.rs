//! Localhost HTTP relay that makes proxy preferences hot-reloadable.
//!
//! Instead of baking the real proxy address into the dsh process environment
//! (which would make every change require a backend restart), the GUI binds a
//! tiny forwarding proxy on 127.0.0.1 and points the environment at THAT,
//! once, for the lifetime of the backend. The relay holds the current
//! upstream (`Some("http://clash:port")` = forward there, `None` = dial the
//! origin directly) behind an atomic handle, so flipping the preference takes
//! effect on the next connection — plugins, sessions, and tool calls
//! included — without touching the running processes.
//!
//! Protocol coverage mirrors what an HTTP proxy client may send us:
//! - `CONNECT host:port` → blind tunnel (TLS, SSH-over-https, websockets …);
//!   forwarded verbatim to the upstream when one is configured, otherwise the
//!   origin is dialed directly.
//! - absolute-form plain requests (`GET http://host/path`) → forwarded
//!   verbatim upstream, or rewritten to origin-form (Host header ensured,
//!   proxy hop-by-hop headers stripped) when going direct.
//!
//! Only `std::net` is used: one acceptor thread plus two short-lived copy
//! threads per connection is plenty for this traffic profile and keeps the
//! dependency tree untouched.

use std::io::{self, BufRead, BufReader, Read, Write};
use std::net::{TcpListener, TcpStream, ToSocketAddrs};
use std::sync::{Arc, RwLock};
use std::time::Duration;

/// Longest allowed request head (CONNECT line included). Real heads are far
/// smaller; the cap only bounds memory against garbage.
const MAX_HEAD_BYTES: usize = 32 * 1024;
const UPSTREAM_DIAL_TIMEOUT: Duration = Duration::from_secs(5);
const COPY_BUFFER_BYTES: usize = 16 * 1024;

/// The live proxy preference: `Some(url)` forwards to that HTTP proxy,
/// `None` connects straight to origins. Cheap to clone, safe to share.
#[derive(Clone)]
pub struct RelayTarget(Arc<RwLock<Option<String>>>);

impl RelayTarget {
    pub fn new(initial: Option<String>) -> Self {
        Self(Arc::new(RwLock::new(normalize_upstream(initial.as_deref()))))
    }

    /// Swap the upstream atomically. Existing tunnels keep flowing; every new
    /// connection uses the new value immediately.
    pub fn set(&self, next: Option<String>) {
        if let Ok(mut guard) = self.0.write() {
            *guard = normalize_upstream(next.as_deref());
        }
    }

    pub fn get(&self) -> Option<String> {
        self.0.read().ok().and_then(|guard| guard.clone())
    }
}

/// Accept `http://host[:port]` (default port 80); anything else becomes None.
fn normalize_upstream(url: Option<&str>) -> Option<String> {
    let url = url?.trim().trim_end_matches('/');
    let lower = url.to_ascii_lowercase();
    let rest = lower.strip_prefix("http://")?;
    let original_rest = &url[url.len() - rest.len()..];
    let host_part = original_rest.split(['/']).next()?;
    if host_part.is_empty() || url.contains(char::is_whitespace) {
        return None;
    }
    Some(format!("http://{host_part}"))
}

/// Bind the relay on an ephemeral loopback port and serve forever in a
/// background thread. Returns the bound port.
pub fn spawn(target: RelayTarget) -> io::Result<u16> {
    let listener = TcpListener::bind(("127.0.0.1", 0))?;
    let port = listener.local_addr()?.port();
    std::thread::Builder::new()
        .name("dsh-proxy-relay".to_string())
        .spawn(move || {
            for client in listener.incoming() {
                let Ok(client) = client else { continue };
                let target = target.clone();
                let spawned = std::thread::Builder::new()
                    .name("dsh-relay-conn".to_string())
                    .spawn(move || handle_connection(client, target));
                if spawned.is_err() {
                    break;
                }
            }
        })?;
    Ok(port)
}

fn handle_connection(client: TcpStream, target: RelayTarget) {
    let _ = client.set_nodelay(true);
    let Ok(peer) = client.try_clone() else { return };
    let mut reader = BufReader::new(peer);
    let Some(head) = read_head(&mut reader) else { return };

    let first_line_end = head
        .windows(2)
        .position(|window| window == b"\r\n")
        .unwrap_or(head.len());
    let request_line = String::from_utf8_lossy(&head[..first_line_end]).into_owned();
    if request_line.starts_with("CONNECT ") {
        tunnel(client, reader, &head, &request_line, target);
    } else if request_line.contains(' ') {
        forward_plain(client, reader, head, &request_line, target);
    } else {
        respond_simple(&client, "400 Bad Request");
    }
}

/// Read bytes up to and including the blank line that ends the head.
fn read_head(reader: &mut BufReader<TcpStream>) -> Option<Vec<u8>> {
    let mut head = Vec::with_capacity(1024);
    loop {
        let mut line = Vec::new();
        let read = reader.read_until(b'\n', &mut line).ok()?;
        if read == 0 {
            return None;
        }
        head.extend_from_slice(&line);
        // 空行(\r\n 或 \n)标志头部结束。
        if line == b"\r\n" || line == b"\n" {
            return Some(head);
        }
        if head.len() > MAX_HEAD_BYTES {
            return None;
        }
    }
}

fn respond_simple(mut stream: &TcpStream, status: &str) {
    let _ = stream.write_all(format!("HTTP/1.1 {status}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n").as_bytes());
    let _ = stream.shutdown(std::net::Shutdown::Both);
}

/// CONNECT: forward verbatim to the upstream proxy, or dial the origin when
/// no upstream is configured; afterwards both sides speak TLS privately.
fn tunnel(
    client: TcpStream,
    reader: BufReader<TcpStream>,
    head: &[u8],
    request_line: &str,
    target: RelayTarget,
) {
    let upstream = target.get();
    let destination = match &upstream {
        Some(_) => dial_upstream(&upstream),
        None => {
            // "CONNECT host:port HTTP/1.1" — the authority sits between the spaces.
            let authority = request_line.split(' ').nth(1).unwrap_or_default();
            dial_authority(authority)
        }
    };
    let Ok(mut dest) = destination else {
        respond_simple(&client, "502 Bad Gateway");
        return;
    };

    if upstream.is_some() {
        // The upstream speaks full HTTP proxy: hand it our client's exact head.
        if dest.write_all(head).is_err() {
            respond_simple(&client, "502 Bad Gateway");
            return;
        }
    } else {
        // Origin already connected by name; answer the CONNECT ourselves.
        if dest
            .write_all(b"HTTP/1.1 200 Connection established\r\n\r\n")
            .is_err()
        {
            return;
        }
    }

    // Anything the client pipelined behind the head (rare but legal) must not
    // be lost to the BufReader's buffer.
    let buffered: Vec<u8> = reader.buffer().to_vec();
    if !buffered.is_empty() && dest.write_all(&buffered).is_err() {
        return;
    }
    splice(client, dest);
}

/// Plain requests: verbatim relay when upstream exists; origin-form rewrite
/// when going direct.
fn forward_plain(
    client: TcpStream,
    reader: BufReader<TcpStream>,
    head: Vec<u8>,
    request_line: &str,
    target: RelayTarget,
) {
    let upstream = target.get();
    let buffered: Vec<u8> = reader.buffer().to_vec();

    if let Some(url) = &upstream {
        let Ok(mut dest) = dial_upstream(&Some(url.clone())) else {
            respond_simple(&client, "502 Bad Gateway");
            return;
        };
        if dest.write_all(&head).is_err() || (!buffered.is_empty() && dest.write_all(&buffered).is_err())
        {
            respond_simple(&client, "502 Bad Gateway");
            return;
        }
        splice(client, dest);
        return;
    }

    // Direct mode: act as the proxy ourselves.
    let Some((method, uri, version)) = split_request_line(request_line) else {
        respond_simple(&client, "400 Bad Request");
        return;
    };
    let Some((authority, path)) = split_absolute_uri(&uri) else {
        respond_simple(&client, "400 Bad Request");
        return;
    };
    let Some(rewritten) = rewrite_head_origin_form(&head, &method, &path, &version, &authority)
    else {
        respond_simple(&client, "400 Bad Request");
        return;
    };
    let mut origin = match dial_authority(&authority) {
        Ok(origin) => origin,
        Err(error) => {
            eprintln!("dsh-relay: direct dial {authority} failed: {error}");
            respond_simple(&client, "502 Bad Gateway");
            return;
        }
    };
    if origin.write_all(&rewritten).is_err()
        || (!buffered.is_empty() && origin.write_all(&buffered).is_err())
    {
        return;
    }
    splice(client, origin);
}

/// Bidirectional copy until either side closes; each finished direction asks
/// the peer to see EOF so protocols with half-close behave.
fn splice(a: TcpStream, b: TcpStream) {
    let Ok(a_peer) = a.try_clone() else { return };
    let Ok(b_peer) = b.try_clone() else { return };
    let to_b = std::thread::Builder::new()
        .name("dsh-relay-copy".to_string())
        .spawn(move || pump(a_peer, b));
    if let Ok(handle) = to_b {
        pump(b_peer, a);
        let _ = handle.join();
    }
}

fn pump(mut from: TcpStream, mut to: TcpStream) {
    let mut buffer = vec![0u8; COPY_BUFFER_BYTES];
    loop {
        match from.read(&mut buffer) {
            Ok(0) => {
                let _ = to.shutdown(std::net::Shutdown::Write);
                return;
            }
            Ok(read) => {
                if to.write_all(&buffer[..read]).is_err() {
                    return;
                }
            }
            Err(_) => return,
        }
    }
}

fn split_request_line(line: &str) -> Option<(String, String, String)> {
    let mut parts = line.split(' ');
    let method = parts.next()?.to_string();
    let uri = parts.next()?.to_string();
    let version = parts.next()?.to_string();
    if parts.next().is_some() || method.is_empty() || uri.is_empty() {
        return None;
    }
    Some((method, uri, version))
}

/// `http://host[:port]/path?query` → `(host[:port], /path?query)`.
fn split_absolute_uri(uri: &str) -> Option<(String, String)> {
    const SCHEME: &str = "http://";
    if uri.len() < SCHEME.len() || !uri[..SCHEME.len()].eq_ignore_ascii_case(SCHEME) {
        return None;
    }
    let rest = &uri[SCHEME.len()..];
    let (authority, path) = match rest.find('/') {
        Some(index) => (&rest[..index], &rest[index..]),
        None => (rest, "/"),
    };
    if authority.is_empty() || authority.contains('@') {
        return None;
    }
    Some((authority.to_string(), path.to_string()))
}

/// Strip proxy hop-by-hop headers and fix the request line + Host for a
/// direct origin connection.
fn rewrite_head_origin_form(
    head: &[u8],
    method: &str,
    path: &str,
    version: &str,
    authority: &str,
) -> Option<Vec<u8>> {
    let text = std::str::from_utf8(head).ok()?;
    let mut lines = text.split("\r\n");
    let _first = lines.next()?; // 原请求行,由解析结果重建
    let mut out = Vec::with_capacity(head.len() + 32);
    out.extend_from_slice(format!("{method} {path} {version}\r\n").as_bytes());
    let mut saw_host = false;
    for line in lines {
        if line.is_empty() {
            break;
        }
        let lower = line.to_ascii_lowercase();
        if lower.starts_with("proxy-connection:")
            || lower.starts_with("proxy-authorization:")
            || lower.starts_with("proxy-authenticate:")
        {
            continue;
        }
        if lower.starts_with("host:") {
            saw_host = true;
        }
        out.extend_from_slice(line.as_bytes());
        out.extend_from_slice(b"\r\n");
    }
    if !saw_host {
        out.extend_from_slice(format!("Host: {authority}\r\n").as_bytes());
    }
    out.extend_from_slice(b"\r\n");
    Some(out)
}

fn dial_upstream(url: &Option<String>) -> io::Result<TcpStream> {
    let Some(url) = url else {
        return Err(io::Error::other("no upstream"));
    };
    let authority = url.trim_start_matches("http://");
    // http 代理默认端口 80;CONNECT 的 authority 必带端口,不受此影响。
    let with_port = if authority.contains(':') {
        authority.to_string()
    } else {
        format!("{authority}:80")
    };
    dial_authority(&with_port)
}

fn dial_authority(authority: &str) -> io::Result<TcpStream> {
    let addresses: Vec<_> = authority.to_socket_addrs()?.collect();
    let mut last = io::Error::new(io::ErrorKind::AddrNotAvailable, "no address");
    for address in addresses {
        match TcpStream::connect_timeout(&address, UPSTREAM_DIAL_TIMEOUT) {
            Ok(stream) => {
                let _ = stream.set_nodelay(true);
                return Ok(stream);
            }
            Err(error) => last = error,
        }
    }
    Err(last)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::mpsc;

    fn free_port() -> u16 {
        TcpListener::bind(("127.0.0.1", 0))
            .unwrap()
            .local_addr()
            .unwrap()
            .port()
    }

    /// A stand-in HTTP proxy: answers CONNECT with 200 then echoes everything;
    /// for plain requests records the head and answers a fixed 200.
    struct FakeUpstream {
        pub port: u16,
        hits: mpsc::Receiver<Vec<u8>>,
    }

    fn spawn_fake_upstream(connect_echo: bool) -> FakeUpstream {
        let listener = TcpListener::bind(("127.0.0.1", 0)).unwrap();
        let port = listener.local_addr().unwrap().port();
        let (tx, rx) = mpsc::channel();
        std::thread::spawn(move || {
            for stream in listener.incoming() {
                let Ok(stream) = stream else { continue };
                let tx = tx.clone();
                std::thread::spawn(move || {
                    let Ok(peer) = stream.try_clone() else { return };
                    let mut reader = BufReader::new(stream);
                    let Some(head) = read_head(&mut reader) else { return };
                    let text = String::from_utf8_lossy(&head).into_owned();
                    let _ = tx.send(head);
                    let mut peer = peer;
                    if text.starts_with("CONNECT") {
                        let _ = peer.write_all(b"HTTP/1.1 200 OK\r\n\r\n");
                        if connect_echo {
                            let buffered = reader.buffer().to_vec();
                            let _ = peer.write_all(&buffered);
                            pump(reader.into_inner(), peer);
                        }
                    } else {
                        let _ = peer.write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: close\r\n\r\nok");
                        let _ = peer.shutdown(std::net::Shutdown::Write);
                    }
                });
            }
        });
        FakeUpstream { port, hits: rx }
    }

    fn relay_with(upstream: Option<String>) -> u16 {
        spawn(RelayTarget::new(upstream)).unwrap()
    }

    #[test]
    fn normalizes_upstream_urls() {
        assert_eq!(
            normalize_upstream(Some(" HTTP://127.0.0.1:7897/ ").as_deref()).as_deref(),
            Some("http://127.0.0.1:7897")
        );
        assert_eq!(normalize_upstream(Some("socks5://p:1").as_deref()), None);
        assert_eq!(normalize_upstream(None), None);
    }

    #[test]
    fn tunnels_connect_through_the_configured_upstream() {
        let upstream = spawn_fake_upstream(true);
        let port = relay_with(Some(format!("http://127.0.0.1:{}", upstream.port)));

        let mut client = TcpStream::connect(("127.0.0.1", port)).unwrap();
        client
            .write_all(b"CONNECT example.com:443 HTTP/1.1\r\nHost: example.com:443\r\n\r\n")
            .unwrap();
        let mut reader = BufReader::new(client.try_clone().unwrap());
        let head = read_head(&mut reader).unwrap();
        assert!(String::from_utf8_lossy(&head).starts_with("HTTP/1.1 200"));

        client.write_all(b"ping").unwrap();
        let mut echoed = vec![0u8; 4];
        reader.read_exact(&mut echoed).unwrap();
        assert_eq!(echoed, b"ping");

        let forwarded = upstream.hits.recv_timeout(Duration::from_secs(5)).unwrap();
        assert!(String::from_utf8_lossy(&forwarded).starts_with("CONNECT example.com:443"));
    }

    #[test]
    fn relays_plain_requests_verbatim_to_the_upstream() {
        let upstream = spawn_fake_upstream(false);
        let port = relay_with(Some(format!("http://127.0.0.1:{}", upstream.port)));

        let mut client = TcpStream::connect(("127.0.0.1", port)).unwrap();
        client
            .write_all(b"GET http://example.com/x?q=1 HTTP/1.1\r\nHost: example.com\r\n\r\n")
            .unwrap();
        let mut response = String::new();
        client.read_to_string(&mut response).unwrap();
        assert!(response.ends_with("ok"), "got: {response}");

        let forwarded = upstream.hits.recv_timeout(Duration::from_secs(5)).unwrap();
        assert!(String::from_utf8_lossy(&forwarded)
            .starts_with("GET http://example.com/x?q=1 HTTP/1.1"));
    }

    #[test]
    fn switching_targets_moves_new_connections_immediately() {
        let first = spawn_fake_upstream(true);
        let second = spawn_fake_upstream(true);
        let target = RelayTarget::new(Some(format!("http://127.0.0.1:{}", first.port)));
        let port = spawn(target.clone()).unwrap();

        let mut client_a = TcpStream::connect(("127.0.0.1", port)).unwrap();
        client_a
            .write_all(b"CONNECT a.example.com:443 HTTP/1.1\r\n\r\n")
            .unwrap();
        assert!(first.hits.recv_timeout(Duration::from_secs(5)).is_ok());

        target.set(Some(format!("http://127.0.0.1:{}", second.port)));

        let mut client_b = TcpStream::connect(("127.0.0.1", port)).unwrap();
        client_b
            .write_all(b"CONNECT b.example.com:443 HTTP/1.1\r\n\r\n")
            .unwrap();
        assert!(second.hits.recv_timeout(Duration::from_secs(5)).is_ok());
    }

    #[test]
    fn direct_mode_dials_the_connect_origin_itself() {
        // Origin echo server standing in for "the internet": no HTTP semantics,
        // just bytes — the relay owns the 200 reply to our client.
        let origin_listener = TcpListener::bind(("127.0.0.1", 0)).unwrap();
        let origin_port = origin_listener.local_addr().unwrap().port();
        std::thread::spawn(move || {
            while let Ok((stream, _)) = origin_listener.accept() {
                std::thread::spawn(move || pump_echo(stream));
            }
        });

        let port = relay_with(None);
        let mut client = TcpStream::connect(("127.0.0.1", port)).unwrap();
        client
            .write_all(format!("CONNECT 127.0.0.1:{origin_port} HTTP/1.1\r\nHost: x\r\n\r\n").as_bytes())
            .unwrap();
        let mut reader = BufReader::new(client.try_clone().unwrap());
        let head = read_head(&mut reader).unwrap();
        assert!(String::from_utf8_lossy(&head).contains("200"));
        client.write_all(b"pong").unwrap();
        let mut echoed = vec![0u8; 4];
        reader.read_exact(&mut echoed).unwrap();
        assert_eq!(echoed, b"pong");
    }

    #[test]
    fn direct_mode_rewrites_absolute_form_for_the_origin() {
        let origin_listener = TcpListener::bind(("127.0.0.1", 0)).unwrap();
        let origin_port = origin_listener.local_addr().unwrap().port();
        let (tx, rx) = mpsc::channel();
        std::thread::spawn(move || {
            let (stream, _) = origin_listener.accept().unwrap();
            let Ok(peer) = stream.try_clone() else { return };
            let mut reader = BufReader::new(stream);
            let head = read_head(&mut reader).unwrap();
            let _ = tx.send(head);
            let mut peer = peer;
            let _ = peer.write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 3\r\nConnection: close\r\n\r\ndir");
            let _ = peer.shutdown(std::net::Shutdown::Write);
        });

        let port = relay_with(None);
        let mut client = TcpStream::connect(("127.0.0.1", port)).unwrap();
        client
            .write_all(
                format!(
                    "GET http://127.0.0.1:{origin_port}/x?a=1 HTTP/1.1\r\nHost: 127.0.0.1:{origin_port}\r\nProxy-Connection: keep-alive\r\nAccept: */*\r\n\r\n"
                )
                .as_bytes(),
            )
            .unwrap();
        let mut response = String::new();
        client.read_to_string(&mut response).unwrap();
        assert!(response.ends_with("dir"), "got: {response}");

        let seen = String::from_utf8(rx.recv_timeout(Duration::from_secs(5)).unwrap()).unwrap();
        assert!(seen.starts_with("GET /x?a=1 HTTP/1.1"), "got: {seen}");
        assert!(seen.contains(&format!("Host: 127.0.0.1:{origin_port}")));
        assert!(!seen.contains("Proxy-Connection"));
    }

    #[test]
    fn upstream_outage_answers_502_instead_of_hanging() {
        let dead = free_port(); // nothing listens here
        let port = relay_with(Some(format!("http://127.0.0.1:{dead}")));
        let mut client = TcpStream::connect(("127.0.0.1", port)).unwrap();
        client
            .write_all(b"GET http://example.com/ HTTP/1.1\r\nHost: example.com\r\n\r\n")
            .unwrap();
        let mut response = String::new();
        client.read_to_string(&mut response).unwrap();
        assert!(response.starts_with("HTTP/1.1 502"), "got: {response}");
    }

    /// Plain byte echo used as a stand-in origin for tunnel tests.
    fn pump_echo(stream: TcpStream) {
        let Ok(peer) = stream.try_clone() else { return };
        let _ = peer.set_nodelay(true);
        pump(peer, stream);
    }
}
