//! Imports conversations that the agent CLIs saved on disk, so work started
//! outside Patchwork shows up as threads. Each imported thread keeps the CLI's
//! session id, so follow-up messages resume the original conversation.

mod claude;
mod codex;
mod gemini;

use crate::types::*;

/// A conversation read from an agent CLI's session files.
#[derive(Debug, Clone)]
pub struct Session {
    pub session_id: String,
    /// Working directory the conversation ran in.
    pub cwd: String,
    pub title: Option<String>,
    pub created_at: u64,
    pub messages: Vec<SessionMessage>,
}

#[derive(Debug, Clone)]
pub struct SessionMessage {
    pub role: Role,
    pub text: String,
    pub created_at: u64,
}

/// Every conversation `kind` has saved on disk, in no particular order.
/// Unreadable files and conversations without a user message are skipped.
pub fn sessions(kind: AgentKind) -> Vec<Session> {
    let all = match kind {
        AgentKind::Claude => claude::sessions(),
        AgentKind::Codex => codex::sessions(),
        AgentKind::Gemini => gemini::sessions(),
    };
    all.into_iter()
        .filter(|s| s.messages.iter().any(|m| m.role == Role::User))
        .collect()
}

impl SessionMessage {
    fn new(role: Role, text: String, created_at: u64) -> Self {
        Self {
            role,
            text,
            created_at,
        }
    }
}

/// Appends assistant text to the previous assistant message, or starts a new one.
fn push_merged(messages: &mut Vec<SessionMessage>, role: Role, text: String, at: u64) {
    let text = text.trim().to_string();
    if text.is_empty() {
        return;
    }
    match messages.last_mut() {
        Some(last) if role == Role::Assistant && last.role == Role::Assistant => {
            last.text.push_str("\n\n");
            last.text.push_str(&text);
        }
        _ => messages.push(SessionMessage::new(role, text, at)),
    }
}

/// Converts an imported session into a stored thread.
pub fn to_thread(kind: AgentKind, session: Session, project_id: Option<String>) -> Thread {
    let title = session
        .title
        .filter(|t| !t.trim().is_empty())
        .or_else(|| {
            session
                .messages
                .iter()
                .find(|m| m.role == Role::User)
                .map(|m| crate::title_from(&m.text))
        })
        .unwrap_or_else(|| "Imported conversation".into());
    Thread {
        id: new_id(),
        project_id,
        title,
        agent: kind,
        model: None,
        session_id: Some(session.session_id),
        created_at: session.created_at,
        messages: session
            .messages
            .into_iter()
            .map(|m| Message {
                id: new_id(),
                role: m.role,
                text: m.text,
                created_at: m.created_at,
                status: MessageStatus::Complete,
                tools: vec![],
                plan: vec![],
                files: vec![],
                error: None,
            })
            .collect(),
    }
}
