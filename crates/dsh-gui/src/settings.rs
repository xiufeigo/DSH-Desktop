//! Wrapper-owned proxy settings for DSH Desktop.
//!
//! Why a wrapper-owned file: the DeepSeek Harness deliberately accepts
//! network-bootstrap variables (`HTTP_PROXY` / `HTTPS_PROXY` / `NO_PROXY` /
//! `NODE_USE_ENV_PROXY`) only from the launching environment — its `.env`
//! loader rejects those names as bootstrap-only. The desktop wrapper IS that
//! launching environment, so the preference lives in
//! `%APPDATA%\dsh-desktop\settings.json` and is injected into the spawned
//! dsh web process; every plugin, session shell, and tool call beneath it
//! inherits the same environment. Nothing here touches machine-wide
//! environment variables or other applications.
//!
//! Node's global `fetch` (undici) ignores both the Windows system proxy and
//! plain `HTTP(S)_PROXY` env vars unless `NODE_USE_ENV_PROXY=1` is set
//! (Node >= 24), which is exactly what this module writes alongside them.

use serde::{Deserialize, Serialize};
use std::fs;
use std::path::{Path, PathBuf};

/// Loopback/LAN names that must never be pushed through the proxy. The dsh
/// web UI itself is served on 127.0.0.1, so an empty user override still gets
/// this baseline injected.
pub const DEFAULT_NO_PROXY: &str = "localhost,127.0.0.1,::1";

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
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
    /// blank address, or a scheme undici cannot tunnel through (it only
    /// speaks HTTP CONNECT proxies — `socks5://` would silently not route).
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
            // A host is required; anything beyond it (port/path) is optional.
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

    /// The exact environment entries to inject for an effective proxy.
    /// Uppercase for Node/undici plus lowercase duplicates so non-Node tools
    /// that only read the lowercase spellings (common curl/pip/git configs)
    /// behave the same inside sessions and tool calls.
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

    /// Apply the entries onto a child command when effective.
    pub fn apply_to(&self, cmd: &mut std::process::Command) -> bool {
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

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
struct SettingsFile {
    proxy: ProxySettings,
}

fn settings_file_in(base: &Path) -> PathBuf {
    base.join("dsh-desktop").join("settings.json")
}

/// `%APPDATA%\dsh-desktop\settings.json`.
pub fn settings_path() -> PathBuf {
    let base = std::env::var_os("APPDATA")
        .map(PathBuf::from)
        .unwrap_or_else(std::env::temp_dir);
    settings_file_in(&base)
}

/// Best-effort load: missing or corrupt file falls back to defaults so a bad
/// hand-edit can never block startup.
pub fn load_proxy() -> ProxySettings {
    load_proxy_from(&settings_path())
}

pub fn load_proxy_from(path: &Path) -> ProxySettings {
    let Ok(text) = fs::read_to_string(path) else {
        return ProxySettings::default();
    };
    serde_json::from_str::<SettingsFile>(&text)
        .map(|file| file.proxy)
        .unwrap_or_default()
}

/// Persist atomically enough for a hand-edited config file: write a sibling
/// temp file, then rename over the target.
pub fn save_proxy(proxy: &ProxySettings) -> Result<(), String> {
    save_proxy_to(&settings_path(), proxy)
}

pub fn save_proxy_to(path: &Path, proxy: &ProxySettings) -> Result<(), String> {
    let dir = path
        .parent()
        .ok_or_else(|| "settings path has no parent directory".to_string())?;
    fs::create_dir_all(dir).map_err(|error| format!("创建设置目录失败: {error}"))?;
    let text = serde_json::to_string_pretty(&SettingsFile {
        proxy: proxy.clone(),
    })
    .map_err(|error| format!("序列化设置失败: {error}"))?;
    let tmp = path.with_extension("json.tmp");
    fs::write(&tmp, text).map_err(|error| format!("写入设置失败: {error}"))?;
    fs::rename(&tmp, path).map_err(|error| format!("保存设置失败: {error}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn disabled_or_blank_entries_never_apply() {
        assert!(ProxySettings::default().effective().is_none());
        assert!(
            ProxySettings {
                enabled: true,
                url: String::new(),
                no_proxy: String::new(),
            }
            .effective()
            .is_none()
        );
    }

    #[test]
    fn only_http_connect_schemes_apply() {
        for url in ["socks5://127.0.0.1:7897", "ftp://proxy:21", "127.0.0.1:7897"] {
            let entry = ProxySettings {
                enabled: true,
                url: url.into(),
                no_proxy: String::new(),
            };
            assert!(entry.effective().is_none(), "must reject {url}");
        }
    }

    #[test]
    fn effective_trims_and_env_vars_carry_the_baseline_bypass() {
        let entry = ProxySettings {
            enabled: true,
            url: " HTTP://127.0.0.1:7897/ ".into(),
            no_proxy: " .internal ".into(),
        };
        let effective = entry.effective().expect("http scheme must apply");
        assert_eq!(effective.url, "HTTP://127.0.0.1:7897");
        let vars = effective.env_vars();
        for name in [
            "HTTP_PROXY",
            "http_proxy",
            "HTTPS_PROXY",
            "https_proxy",
            "NO_PROXY",
            "no_proxy",
            "NODE_USE_ENV_PROXY",
        ] {
            assert!(
                vars.iter().any(|(key, _)| key == name),
                "missing {name}"
            );
        }
        assert_eq!(
            vars.iter().find(|(key, _)| key == "NO_PROXY").unwrap().1,
            ".internal"
        );
    }

    #[test]
    fn empty_bypass_falls_back_to_loopback_defaults() {
        let entry = ProxySettings {
            enabled: true,
            url: "http://127.0.0.1:7897".into(),
            no_proxy: String::new(),
        };
        let vars = entry.env_vars();
        assert_eq!(
            vars.iter().find(|(key, _)| key == "NO_PROXY").unwrap().1,
            DEFAULT_NO_PROXY
        );
    }

    #[test]
    fn settings_round_trip_through_disk() {
        let dir = std::env::temp_dir().join(format!("dsh-gui-settings-test-{}", std::process::id()));
        let path = dir.join("settings.json");
        let _ = fs::remove_file(&path);
        assert_eq!(load_proxy_from(&path), ProxySettings::default());

        let entry = ProxySettings {
            enabled: true,
            url: "http://127.0.0.1:7897".into(),
            no_proxy: "localhost".into(),
        };
        save_proxy_to(&path, &entry).expect("save must succeed");
        assert_eq!(load_proxy_from(&path), entry);

        fs::write(&path, "{not json").unwrap();
        assert_eq!(load_proxy_from(&path), ProxySettings::default());
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn apply_to_reports_whether_injection_happened() {
        let mut cmd = std::process::Command::new("node");
        assert!(!ProxySettings::default().apply_to(&mut cmd));

        let entry = ProxySettings {
            enabled: true,
            url: "http://127.0.0.1:7897".into(),
            no_proxy: String::new(),
        };
        assert!(entry.apply_to(&mut cmd));
    }
}
