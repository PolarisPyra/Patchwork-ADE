//! Shared data contract between the Rust backend and the TypeScript frontend.
//! Mirrors `src/api.ts` — keep both in sync. All fields serialize as camelCase.

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum AgentKind {
    Claude,
    Codex,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "lowercase")]
pub enum Theme {
    Light,
    #[default]
    Dark,
    System,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct Integrations {
    pub github: bool,
    pub terminal: bool,
    pub figma: bool,
    pub browser: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Project {
    pub id: String,
    pub name: String,
    pub path: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct Settings {
    pub onboarded: bool,
    pub theme: Theme,
    /// Connected agents; the first is the default for new tasks.
    pub agents: Vec<AgentKind>,
    /// Legacy single-agent setting, migrated into `agents` on load.
    #[serde(skip_serializing)]
    pub agent: Option<AgentKind>,
    pub integrations: Integrations,
    pub projects: Vec<Project>,
    pub active_project_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentStatus {
    pub kind: AgentKind,
    pub installed: bool,
    pub version: Option<String>,
    pub signed_in: bool,
    /// Human-readable one-liner, e.g. "Signed in with claude.ai" or "Not installed".
    pub detail: String,
}

/// A model the user can pick for an agent. `id: None` is the CLI's own default.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelOption {
    pub id: Option<String>,
    pub label: String,
    /// Configured CLI default; not a claim about a resumed session's runtime model.
    pub default_model: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Role {
    User,
    Assistant,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum MessageStatus {
    Streaming,
    Complete,
    Error,
    Cancelled,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum StepStatus {
    Pending,
    Running,
    Done,
    Error,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolCall {
    pub id: String,
    /// e.g. "Bash", "Edit", "command_execution"
    pub name: String,
    /// Short single-line description, e.g. the command or file path.
    pub summary: String,
    pub status: StepStatus,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PlanStep {
    pub text: String,
    pub status: StepStatus,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Message {
    pub id: String,
    pub role: Role,
    pub text: String,
    /// Unix epoch milliseconds.
    pub created_at: u64,
    pub status: MessageStatus,
    #[serde(default)]
    pub tools: Vec<ToolCall>,
    #[serde(default)]
    pub plan: Vec<PlanStep>,
    /// Project-relative paths the agent edited during this message.
    #[serde(default)]
    pub files: Vec<String>,
    #[serde(default)]
    pub error: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Thread {
    pub id: String,
    /// None for a chat without a project; it runs in a private scratch folder.
    pub project_id: Option<String>,
    pub title: String,
    pub agent: AgentKind,
    pub model: Option<String>,
    /// Claude session_id / Codex thread_id used to resume the conversation.
    pub session_id: Option<String>,
    pub created_at: u64,
    pub messages: Vec<Message>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FileChange {
    pub path: String,
    /// "modified" | "added" | "deleted" | "untracked" | "renamed"
    pub status: String,
    pub additions: u32,
    pub deletions: u32,
    pub staged: bool,
}

/// Emitted on the Tauri event channel `"agent-event"`.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentEventEnvelope {
    pub thread_id: String,
    pub event: AgentEvent,
}

#[derive(Debug, Clone, Serialize)]
#[serde(
    tag = "type",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum AgentEvent {
    /// A new assistant message placeholder (status = streaming).
    MessageStarted {
        message: Message,
    },
    /// Append `text` to the message body.
    TextDelta {
        message_id: String,
        text: String,
    },
    ToolStarted {
        message_id: String,
        tool: ToolCall,
    },
    ToolFinished {
        message_id: String,
        tool_id: String,
        is_error: bool,
    },
    /// Replace the message's plan with `steps`.
    PlanUpdated {
        message_id: String,
        steps: Vec<PlanStep>,
    },
    FileTouched {
        message_id: String,
        path: String,
    },
    /// Terminal event for a turn. `status` is complete | error | cancelled.
    TurnCompleted {
        message_id: String,
        status: MessageStatus,
        error: Option<String>,
    },
}

pub fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

pub fn new_id() -> String {
    uuid::Uuid::new_v4().to_string()
}
