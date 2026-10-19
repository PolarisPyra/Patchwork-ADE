//! Claude subscription limits from the claude.ai OAuth usage endpoint, using
//! the token Claude Code stored when the user signed in.

use std::time::Duration;

use serde_json::Value;

use crate::provider;
use crate::time::parse_rfc3339_ms;
use crate::types::*;

const USAGE_URL: &str = "https://api.anthropic.com/api/oauth/usage";

/// Windows the endpoint reports, in display order.
const WINDOWS: [(&str, &str); 4] = [
    ("five_hour", "Session (5h)"),
    ("seven_day", "Weekly"),
    ("seven_day_opus", "Weekly · Opus"),
    ("seven_day_sonnet", "Weekly · Sonnet"),
];

/// Claude Code's stored credentials: a file on Linux/Windows, the Keychain on macOS.
fn credentials() -> Option<Value> {
    let file = provider::claude::home()
        .and_then(|h| std::fs::read_to_string(h.join(".credentials.json")).ok());
    let raw = file.or_else(|| {
        let out = std::process::Command::new("security")
            .args([
                "find-generic-password",
                "-s",
                "Claude Code-credentials",
                "-w",
            ])
            .output()
            .ok()
            .filter(|o| o.status.success())?;
        Some(String::from_utf8_lossy(&out.stdout).into_owned())
    })?;
    serde_json::from_str(raw.trim()).ok()
}

pub fn usage(mut out: ProviderUsage) -> Result<ProviderUsage, String> {
    let creds = credentials().ok_or("Not signed in with a Claude subscription")?;
    let oauth = &creds["claudeAiOauth"];
    let token = oauth["accessToken"]
        .as_str()
        .ok_or("Not signed in with a Claude subscription")?;
    if oauth["expiresAt"]
        .as_u64()
        .is_some_and(|exp| exp < now_ms())
    {
        return Err("Sign-in expired — run `claude` to refresh it".into());
    }
    out.plan = oauth["subscriptionType"].as_str().map(String::from);

    let agent: ureq::Agent = ureq::Agent::config_builder()
        .timeout_global(Some(Duration::from_secs(10)))
        .build()
        .into();
    let body: Value = agent
        .get(USAGE_URL)
        .header("Authorization", &format!("Bearer {token}"))
        .header("anthropic-beta", "oauth-2025-04-20")
        .call()
        .and_then(|mut r| r.body_mut().read_json())
        .map_err(|e| format!("Couldn't load usage: {e}"))?;
    out.windows = windows(&body);
    out.updated_at = Some(now_ms());
    Ok(out)
}

fn windows(body: &Value) -> Vec<UsageWindow> {
    WINDOWS
        .iter()
        .filter_map(|(key, label)| {
            let w = &body[*key];
            Some(UsageWindow {
                label: (*label).into(),
                used_percent: w["utilization"].as_f64()?,
                resets_at: w["resets_at"].as_str().and_then(parse_rfc3339_ms),
            })
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn reads_reported_windows_only() {
        let body = json!({
            "five_hour": {"utilization": 9.0, "resets_at": "1970-01-01T00:00:01+00:00"},
            "seven_day": {"utilization": 31.0, "resets_at": null},
            "seven_day_opus": null
        });
        let w = windows(&body);
        assert_eq!(w.len(), 2);
        assert_eq!(
            (w[0].label.as_str(), w[0].used_percent, w[0].resets_at),
            ("Session (5h)", 9.0, Some(1000))
        );
        assert_eq!((w[1].label.as_str(), w[1].resets_at), ("Weekly", None));
    }
}
