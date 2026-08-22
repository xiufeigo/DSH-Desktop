//! Wrapper-owned proxy preference for the dsh-cli launcher.
//!
//! Mirrors `crates/dsh-gui/src/settings.rs` on purpose: the two launchers are
//! independent Cargo projects, but they must agree on the same
//! `settings.json` so the desktop app and the CLI inject identical network
//! bootstrap environment. The DeepSeek Harness accepts `HTTP_PROXY` /
//! `HTTPS_PROXY` / `NO_PROXY` / `NODE_USE_ENV_PROXY` only from the launching
//! environment (its `.env` loader rejects those names as bootstrap-only), and
//! Node's global `fetch` additionally needs `NODE_USE_ENV_PROXY=1` before it
//! honors the variables at all (Node >= 24). Injection here reaches the dsh
//! process tree — plugins, sessions, tool calls — and nothing else on the
//! machine.

use serde_json::Value;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;

/// Loopback names that must never be pushed through the proxy; used when the
/// user left the bypass list blank (the web UI itself lives on 127.0.0.1).
pub const DEFAULT_NO_PROXY: &str = "localhost,127.0.0.1,::1";

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ProxySettings {
    pub enabled: bool,
    pub url: String,
    pub no_proxy: String,
}

impl Default for ProxySettings {
    fn default() -> Self {
        Self {
            enabled: false,
            url: String::new(),
            no_proxy: String::new(),
        }
    }
}

impl ProxySettings {
    /// Trimmed copy, or `None` when the entry must not be applied: disabled,
    /// blank address, or a scheme undici cannot tunnel (http CONNECT only).
    pub fn effective(&self) -> Option<ProxySettings> {
        if !self.enabled {
            return None;
        }
        let url = self.url.trim().trim_end_matches('/').to_string();
        let lower = url.to_ascii_lowercase();
        let rest = lower
            .strip_prefix("http://")
            .or_else(|| lower.strip_prefix("https://"));
        match rest {
            Some(host_part) if !host_part.is_empty() && !url.contains(char::is_whitespace) => {
                Some(Self {
                    enabled: true,
                    url,
                    no_proxy: self.no_proxy.trim().to_string(),
                })
            }
            _ => None,
        }
    }

    /// Uppercase entries for Node/undici plus lowercase duplicates so tools
    /// that only read the lowercase spellings behave identically.
    pub fn env_vars(&self) -> Vec<(String, String)> {
        let bypass = if self.no_proxy.is_empty() {
            DEFAULT_NO_PROXY.to_string()
        } else {
            self.no_proxy.clone()
        };
        vec![
            ("HTTP_PROXY".into(), self.url.clone()),
            ("http_proxy".into(), self.url.clone()),
            ("HTTPS_PROXY".into(), self.url.clone()),
            ("https_proxy".into(), self.url.clone()),
            ("NO_PROXY".into(), bypass.clone()),
            ("no_proxy".into(), bypass),
            ("NODE_USE_ENV_PROXY".into(), "1".into()),
        ]
    }

    /// Apply onto a child command; returns whether injection happened.
    pub fn apply_to(&self, cmd: &mut Command) -> bool {
        match self.effective() {
            Some(effective) => {
                for (name, value) in effective.env_vars() {
                    cmd.env(name, value);
                }
                true
            }
            None => false,
        }
    }
}

fn settings_file_in(base: &Path) -> PathBuf {
    base.join("dsh-desktop").join("settings.json")
}

/// Same location the GUI writes: `%APPDATA%\dsh-desktop\settings.json`
/// (Windows) or `$XDG_CONFIG_HOME|~/.config /dsh-desktop/settings.json`.
pub fn settings_path() -> PathBuf {
    #[cfg(windows)]
    {
        let base = std::env::var_os("APPDATA")
            .map(PathBuf::from)
            .unwrap_or_else(std::env::temp_dir);
        settings_file_in(&base)
    }
    #[cfg(not(windows))]
    {
        let base = std::env::var_os("XDG_CONFIG_HOME")
            .map(PathBuf::from)
            .or_else(|| std::env::var_os("HOME").map(|home| PathBuf::from(home).join(".config")))
            .unwrap_or_else(std::env::temp_dir);
        settings_file_in(&base)
    }
}

/// Parse the settings file body. Missing fields fall back to defaults; a
/// corrupt document is treated as "no proxy" rather than an error so a bad
/// hand-edit cannot break launches.
pub fn parse_settings(text: &str) -> ProxySettings {
    let Ok(value) = serde_json::from_str::<Value>(text) else {
        return ProxySettings::default();
    };
    let proxy = &value["proxy"];
    ProxySettings {
        enabled: proxy["enabled"].as_bool().unwrap_or(false),
        url: proxy["url"]
            .as_str()
            .unwrap_or_default()
            .trim()
            .to_string(),
        no_proxy: proxy["noProxy"]
            .as_str()
            .or_else(|| proxy["no_proxy"].as_str())
            .unwrap_or_default()
            .trim()
            .to_string(),
    }
}

/// Best-effort load of the current preference (defaults when absent).
pub fn load_proxy() -> ProxySettings {
    match fs::read_to_string(settings_path()) {
        Ok(text) => parse_settings(&text),
        Err(_) => ProxySettings::default(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_gui_written_camel_case_document() {
        let text = r#"{"proxy":{"enabled":true,"url":" http://127.0.0.1:7897/ ","noProxy":""}}"#;
        let entry = parse_settings(text);
        assert!(entry.enabled);
        // parse 只去空白，尾部斜杠由 effective() 规整。
        assert_eq!(entry.url, "http://127.0.0.1:7897/");
        let effective = entry.effective().expect("http scheme must apply");
        assert_eq!(effective.url, "http://127.0.0.1:7897");
        assert_eq!(entry.no_proxy, "");
    }

    #[test]
    fn corrupt_or_missing_documents_disable_the_proxy() {
        assert_eq!(parse_settings("{not json"), ProxySettings::default());
        assert_eq!(parse_settings("{}"), ProxySettings::default());
    }

    #[test]
    fn socks_schemes_never_apply() {
        let entry = parse_settings(
            r#"{"proxy":{"enabled":true,"url":"socks5://127.0.0.1:7897","noProxy":""}}"#,
        );
        assert!(entry.effective().is_none());
    }

    #[test]
    fn empty_bypass_falls_back_to_loopback_defaults() {
        let entry = parse_settings(r#"{"proxy":{"enabled":true,"url":"http://p:1","noProxy":""}}"#);
        let vars = entry.env_vars();
        assert_eq!(
            vars.iter().find(|(key, _)| key == "NO_PROXY").unwrap().1,
            DEFAULT_NO_PROXY
        );
        assert_eq!(
            vars.iter().find(|(key, _)| key == "NODE_USE_ENV_PROXY").unwrap().1,
            "1"
        );
    }
}
