//! Subscription usage limits (session / weekly windows) per agent.

mod claude;
mod codex;

use crate::types::*;

pub fn usage(kind: AgentKind) -> ProviderUsage {
    let empty = ProviderUsage {
        kind,
        plan: None,
        windows: vec![],
        error: None,
        updated_at: None,
    };
    let result = match kind {
        AgentKind::Claude => claude::usage(empty),
        AgentKind::Codex => codex::usage(empty),
        AgentKind::Gemini => Err("Gemini CLI doesn't report usage limits".to_string()),
    };
    result.unwrap_or_else(|error| ProviderUsage {
        kind,
        plan: None,
        windows: vec![],
        error: Some(error),
        updated_at: None,
    })
}

/// "Session (5h)" for a 300-minute window, "Weekly" for 10080, and so on.
fn window_label(minutes: u64) -> String {
    match minutes {
        300 => "Session (5h)".into(),
        10_080 => "Weekly".into(),
        m if m % 1440 == 0 => format!("{}-day", m / 1440),
        m => format!("{}h", (m as f64 / 60.0).round()),
    }
}
