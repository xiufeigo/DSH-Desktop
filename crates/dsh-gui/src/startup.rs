use std::fmt;
use std::io::{Read, Write};
use std::net::{IpAddr, Ipv4Addr, SocketAddr, TcpStream};
use std::sync::mpsc::{Receiver, RecvTimeoutError};
use std::time::{Duration, Instant};

const BOOT_MARKER: &[u8] = b"__DSH_BOOT__";
const MAX_RESPONSE_BYTES: u64 = 2 * 1024 * 1024;
const CONNECT_TIMEOUT: Duration = Duration::from_millis(100);
const READ_TIMEOUT: Duration = Duration::from_millis(500);
const SERVER_URL_PREFIX: &str = "dsh web: ";
pub const READY_POLL_INTERVAL: Duration = Duration::from_millis(50);

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ChildState {
    Running,
    Exited(Option<i32>),
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum WaitReadyError {
    ProcessExited(Option<i32>),
    ProcessCheck(String),
    LogRead(String),
    InvalidEndpoint(String),
    EndpointTimeout,
    Timeout,
}

impl fmt::Display for WaitReadyError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::ProcessExited(Some(code)) => {
                write!(
                    formatter,
                    "dsh web exited before readiness (exit code {code})"
                )
            }
            Self::ProcessExited(None) => {
                write!(formatter, "dsh web exited before readiness (no exit code)")
            }
            Self::ProcessCheck(error) => {
                write!(formatter, "failed to inspect dsh web process: {error}")
            }
            Self::LogRead(error) => {
                write!(formatter, "failed to read dsh web startup output: {error}")
            }
            Self::InvalidEndpoint(endpoint) => {
                write!(
                    formatter,
                    "dsh web reported an invalid endpoint: {endpoint}"
                )
            }
            Self::EndpointTimeout => write!(formatter, "dsh web did not report its endpoint"),
            Self::Timeout => write!(formatter, "dsh web readiness timed out"),
        }
    }
}

pub fn parse_server_port(log: &str) -> Result<Option<u16>, WaitReadyError> {
    for line in log.lines() {
        let Some(endpoint) = line.trim().strip_prefix(SERVER_URL_PREFIX) else {
            continue;
        };
        let normalized = endpoint.strip_suffix('/').unwrap_or(endpoint);
        let Some(port) = normalized.strip_prefix("http://127.0.0.1:") else {
            return Err(WaitReadyError::InvalidEndpoint(endpoint.to_string()));
        };
        let Ok(port) = port.parse::<u16>() else {
            return Err(WaitReadyError::InvalidEndpoint(endpoint.to_string()));
        };
        if port == 0 {
            return Err(WaitReadyError::InvalidEndpoint(endpoint.to_string()));
        }
        return Ok(Some(port));
    }
    Ok(None)
}

pub fn is_ready_response(response: &[u8]) -> bool {
    let Some(headers_end) = response.windows(4).position(|window| window == b"\r\n\r\n") else {
        return false;
    };
    let Some(status_end) = response[..headers_end]
        .windows(2)
        .position(|window| window == b"\r\n")
    else {
        return false;
    };
    let Ok(status_line) = std::str::from_utf8(&response[..status_end]) else {
        return false;
    };
    let mut fields = status_line.split_ascii_whitespace();
    let protocol = fields.next();
    let status = fields.next().and_then(|value| value.parse::<u16>().ok());
    if !matches!(protocol, Some("HTTP/1.0" | "HTTP/1.1")) || !matches!(status, Some(200..=299)) {
        return false;
    }

    response[headers_end + 4..]
        .windows(BOOT_MARKER.len())
        .any(|window| window == BOOT_MARKER)
}

fn probe_ready(port: u16, timeout: Duration) -> bool {
    if timeout.is_zero() {
        return false;
    }
    let started = Instant::now();
    let address = SocketAddr::new(IpAddr::V4(Ipv4Addr::LOCALHOST), port);
    let Ok(mut stream) = TcpStream::connect_timeout(&address, CONNECT_TIMEOUT.min(timeout)) else {
        return false;
    };
    let remaining = timeout.saturating_sub(started.elapsed());
    if remaining.is_zero() {
        return false;
    }
    let io_timeout = READ_TIMEOUT.min(remaining);
    let _ = stream.set_read_timeout(Some(io_timeout));
    let _ = stream.set_write_timeout(Some(io_timeout));
    let request = format!(
        "GET / HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nConnection: close\r\nAccept: text/html\r\n\r\n"
    );
    if stream.write_all(request.as_bytes()).is_err() {
        return false;
    }

    let mut response = Vec::new();
    if stream
        .take(MAX_RESPONSE_BYTES)
        .read_to_end(&mut response)
        .is_err()
    {
        return false;
    }
    is_ready_response(&response)
}

fn wait_ready_with<C, P>(
    timeout: Duration,
    poll_interval: Duration,
    mut child_state: C,
    mut ready_probe: P,
) -> Result<(), WaitReadyError>
where
    C: FnMut() -> Result<ChildState, String>,
    P: FnMut(Duration) -> bool,
{
    let deadline = Instant::now() + timeout;
    loop {
        let now = Instant::now();
        if now >= deadline {
            return Err(WaitReadyError::Timeout);
        }
        match child_state().map_err(WaitReadyError::ProcessCheck)? {
            ChildState::Running => {}
            ChildState::Exited(code) => return Err(WaitReadyError::ProcessExited(code)),
        }
        if ready_probe(deadline.saturating_duration_since(Instant::now())) {
            if Instant::now() >= deadline {
                return Err(WaitReadyError::Timeout);
            }
            match child_state().map_err(WaitReadyError::ProcessCheck)? {
                ChildState::Running => return Ok(()),
                ChildState::Exited(code) => return Err(WaitReadyError::ProcessExited(code)),
            }
        }

        let now = Instant::now();
        if now >= deadline {
            return Err(WaitReadyError::Timeout);
        }
        std::thread::sleep(poll_interval.min(deadline.saturating_duration_since(now)));
    }
}

fn wait_server_port_with<C, E>(
    timeout: Duration,
    poll_interval: Duration,
    mut child_state: C,
    mut receive_endpoint: E,
) -> Result<u16, WaitReadyError>
where
    C: FnMut() -> Result<ChildState, String>,
    E: FnMut(Duration) -> Result<Option<Result<u16, WaitReadyError>>, String>,
{
    let deadline = Instant::now() + timeout;
    loop {
        match child_state().map_err(WaitReadyError::ProcessCheck)? {
            ChildState::Running => {}
            ChildState::Exited(code) => return Err(WaitReadyError::ProcessExited(code)),
        }

        let now = Instant::now();
        if now >= deadline {
            return Err(WaitReadyError::EndpointTimeout);
        }
        let wait = poll_interval.min(deadline.saturating_duration_since(now));
        if let Some(endpoint) = receive_endpoint(wait).map_err(WaitReadyError::LogRead)? {
            return endpoint;
        }
    }
}

pub fn wait_server_port<C>(
    endpoint: &Receiver<Result<u16, WaitReadyError>>,
    timeout: Duration,
    child_state: C,
) -> Result<u16, WaitReadyError>
where
    C: FnMut() -> Result<ChildState, String>,
{
    wait_server_port_with(
        timeout,
        READY_POLL_INTERVAL,
        child_state,
        |wait| match endpoint.recv_timeout(wait) {
            Ok(result) => Ok(Some(result)),
            Err(RecvTimeoutError::Timeout) => Ok(None),
            Err(RecvTimeoutError::Disconnected) => {
                Err("dsh web stdout closed before reporting an endpoint".to_string())
            }
        },
    )
}

pub fn wait_ready<C>(port: u16, timeout: Duration, child_state: C) -> Result<(), WaitReadyError>
where
    C: FnMut() -> Result<ChildState, String>,
{
    wait_ready_with(timeout, READY_POLL_INTERVAL, child_state, |remaining| {
        probe_ready(port, remaining)
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn accepts_successful_homepage_with_boot_manifest() {
        assert!(is_ready_response(
            b"HTTP/1.1 200 OK\r\nContent-Type: text/html\r\n\r\n<script>window.__DSH_BOOT__={}</script>"
        ));
    }

    #[test]
    fn rejects_non_success_status_even_with_boot_manifest() {
        assert!(!is_ready_response(
            b"HTTP/1.1 404 Not Found\r\n\r\n<script>window.__DSH_BOOT__={}</script>"
        ));
    }

    #[test]
    fn rejects_success_without_boot_manifest() {
        assert!(!is_ready_response(
            b"HTTP/1.1 200 OK\r\nContent-Type: text/html\r\n\r\n<html></html>"
        ));
    }

    #[test]
    fn rejects_malformed_response() {
        assert!(!is_ready_response(b"not http"));
        assert!(!is_ready_response(b"HTTP/2 200 OK\r\n\r\n__DSH_BOOT__"));
    }

    #[test]
    fn parses_only_the_loopback_endpoint_reported_by_dsh() {
        assert_eq!(
            parse_server_port("plugin output\ndsh web: http://127.0.0.1:49152\n"),
            Ok(Some(49_152))
        );
        assert_eq!(parse_server_port("plugin output\n"), Ok(None));
        assert!(matches!(
            parse_server_port("dsh web: http://evil.example:49152\n"),
            Err(WaitReadyError::InvalidEndpoint(_))
        ));
        assert!(matches!(
            parse_server_port("dsh web: http://127.0.0.1:not-a-port\n"),
            Err(WaitReadyError::InvalidEndpoint(_))
        ));
    }

    #[test]
    fn reports_child_exit_before_probe() {
        let mut probed = false;
        let result = wait_ready_with(
            Duration::from_secs(1),
            Duration::ZERO,
            || Ok(ChildState::Exited(Some(17))),
            |_| {
                probed = true;
                true
            },
        );
        assert_eq!(result, Err(WaitReadyError::ProcessExited(Some(17))));
        assert!(!probed);
    }

    #[test]
    fn reports_child_exit_after_successful_probe() {
        let mut checks = 0;
        let result = wait_ready_with(
            Duration::from_secs(1),
            Duration::ZERO,
            || {
                checks += 1;
                if checks == 1 {
                    Ok(ChildState::Running)
                } else {
                    Ok(ChildState::Exited(Some(19)))
                }
            },
            |_| true,
        );
        assert_eq!(result, Err(WaitReadyError::ProcessExited(Some(19))));
        assert_eq!(checks, 2);
    }

    #[test]
    fn reports_timeout_when_process_stays_alive() {
        let result = wait_ready_with(
            Duration::from_millis(1),
            Duration::ZERO,
            || Ok(ChildState::Running),
            |_| false,
        );
        assert_eq!(result, Err(WaitReadyError::Timeout));
    }

    #[test]
    fn zero_timeout_does_not_probe() {
        let mut probed = false;
        let result = wait_ready_with(
            Duration::ZERO,
            Duration::ZERO,
            || Ok(ChildState::Running),
            |_| {
                probed = true;
                true
            },
        );
        assert_eq!(result, Err(WaitReadyError::Timeout));
        assert!(!probed);
    }

    #[test]
    fn rejects_successful_probe_that_finishes_after_deadline() {
        let result = wait_ready_with(
            Duration::from_millis(1),
            Duration::ZERO,
            || Ok(ChildState::Running),
            |_| {
                std::thread::sleep(Duration::from_millis(2));
                true
            },
        );
        assert_eq!(result, Err(WaitReadyError::Timeout));
    }

    #[test]
    fn reports_child_exit_while_waiting_for_server_endpoint() {
        let result = wait_server_port_with(
            Duration::from_secs(1),
            Duration::ZERO,
            || Ok(ChildState::Exited(Some(23))),
            |_| Ok(None),
        );
        assert_eq!(result, Err(WaitReadyError::ProcessExited(Some(23))));
    }

    #[test]
    fn reports_endpoint_timeout_when_log_never_contains_endpoint() {
        let result = wait_server_port_with(
            Duration::from_millis(1),
            Duration::ZERO,
            || Ok(ChildState::Running),
            |_| Ok(None),
        );
        assert_eq!(result, Err(WaitReadyError::EndpointTimeout));
    }

    #[test]
    fn returns_endpoint_without_waiting_for_the_next_poll() {
        let result = wait_server_port_with(
            Duration::from_secs(1),
            READY_POLL_INTERVAL,
            || Ok(ChildState::Running),
            |_| Ok(Some(Ok(49_152))),
        );
        assert_eq!(result, Ok(49_152));
    }
}
