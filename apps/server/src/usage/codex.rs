//! Codex subscription limits. Codex records its latest rate limits in each
//! session's rollout file (`token_count` events), so the newest one is used.

use std::path::Path;

use serde_json::Value;

use crate::provider;
use crate::time::parse_rfc3339_ms;
use crate::types::*;

/// How many of the most recently modified rollout files are searched.
const RECENT_FILES: usize = 30;

pub fn usage(mut out: ProviderUsage) -> Result<ProviderUsage, String> {
    let sessions = provider::codex::home()
        .map(|h| h.join("sessions"))
        .ok_or("Codex home not found")?;
    let mut files = provider::codex::rollout_files(&sessions);
    files.sort_by_key(|(modified, _)| std::cmp::Reverse(*modified));
    let (at, limits) = files
        .iter()
        .take(RECENT_FILES)
        .find_map(|(_, path)| latest_limits(path))
        .ok_or("No usage reported yet — send a Codex message first")?;
    out.plan = limits["plan_type"].as_str().map(String::from);
    out.windows = ["primary", "secondary"]
        .iter()
        .filter_map(|key| window(&limits[*key], at))
        .collect();
    out.updated_at = Some(at);
    Ok(out)
}

/// The last `rate_limits` with a primary window in one rollout file, with its timestamp.
fn latest_limits(path: &Path) -> Option<(u64, Value)> {
    let text = std::fs::read_to_string(path).ok()?;
    text.lines().rev().find_map(|line| {
        if !line.contains("\"rate_limits\"") {
            return None;
        }
        let v: Value = serde_json::from_str(line).ok()?;
        let limits = &v["payload"]["rate_limits"];
        if !limits["primary"].is_object() {
            return None;
        }
        let at = v["timestamp"].as_str().and_then(parse_rfc3339_ms)?;
        Some((at, limits.clone()))
    })
}

/// One window; a window whose reset time has passed is shown as unused.
fn window(w: &Value, reported_at: u64) -> Option<UsageWindow> {
    let used = w["used_percent"].as_f64()?;
    let minutes = w["window_minutes"].as_u64()?;
    let resets_at = w["resets_at"].as_u64().map(|s| s * 1000).or_else(|| {
        w["resets_in_seconds"]
            .as_u64()
            .map(|s| reported_at + s * 1000)
    });
    let expired = resets_at.is_some_and(|r| r <= now_ms());
    Some(UsageWindow {
        label: super::window_label(minutes),
        used_percent: if expired { 0.0 } else { used },
        resets_at: resets_at.filter(|_| !expired),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn finds_latest_limits_and_expires_old_windows() {
        let dir = std::env::temp_dir().join(new_id());
        std::fs::create_dir_all(&dir).unwrap();
        let future = now_ms() / 1000 + 3600;
        let lines = [
            json!({"timestamp": "2026-01-01T00:00:00Z", "type": "event_msg", "payload": {"type": "token_count",
                "rate_limits": {"primary": {"used_percent": 5.0, "window_minutes": 300, "resets_at": future}}}}),
            json!({"timestamp": "2026-01-02T00:00:00Z", "type": "event_msg", "payload": {"type": "token_count",
                "rate_limits": {"plan_type": "plus",
                    "primary": {"used_percent": 40.0, "window_minutes": 300, "resets_at": future},
                    "secondary": {"used_percent": 70.0, "window_minutes": 10080, "resets_at": 1}}}}),
            json!({"timestamp": "2026-01-03T00:00:00Z", "type": "event_msg", "payload": {"type": "token_count",
                "rate_limits": {"primary": null}}}),
        ];
        let path = dir.join("rollout-1.jsonl");
        let text: Vec<String> = lines.iter().map(Value::to_string).collect();
        std::fs::write(&path, text.join("\n")).unwrap();

        let (_, limits) = latest_limits(&path).unwrap();
        assert_eq!(limits["plan_type"], "plus");
        let primary = window(&limits["primary"], 0).unwrap();
        assert_eq!(
            (primary.label.as_str(), primary.used_percent),
            ("Session (5h)", 40.0)
        );
        let weekly = window(&limits["secondary"], 0).unwrap();
        assert_eq!(
            (weekly.label.as_str(), weekly.used_percent, weekly.resets_at),
            ("Weekly", 0.0, None)
        );
        assert_eq!(provider::codex::rollout_files(&dir).len(), 1);
        let _ = std::fs::remove_dir_all(&dir);
    }
}
