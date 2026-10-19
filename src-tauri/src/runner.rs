//! Runs agent turns by spawning the Claude Code / Codex CLIs and translating
//! their JSONL output into `AgentEvent`s. STUB — to be implemented.
#![allow(unused)]

use tauri::AppHandle;

#[derive(Default)]
pub struct Runner {}

impl Runner {
    pub fn is_running(&self, thread_id: &str) -> bool { todo!() }
    pub fn start_turn(&self, app: AppHandle, thread_id: String, text: String) -> Result<(), String> { todo!() }
    pub fn cancel(&self, thread_id: &str) { todo!() }
}
