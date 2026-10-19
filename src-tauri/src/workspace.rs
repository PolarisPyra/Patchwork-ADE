//! Filesystem, git, and agent-detection helpers. All functions are blocking.
//! STUB — to be implemented.
#![allow(unused)]

use crate::types::*;

/// Resolves the agent CLI (searching PATH plus common install dirs, since GUI
/// launches may not inherit the shell PATH) and returns a Command for it with
/// the binary's directory prepended to PATH (codex needs `node` beside it).
pub fn agent_command(kind: AgentKind) -> Result<std::process::Command, String> { todo!() }
pub fn detect_agent(kind: AgentKind) -> AgentStatus { todo!() }
pub fn make_project(path: &str) -> Result<Project, String> { todo!() }
pub fn create_project_dir(parent: &str, name: &str) -> Result<Project, String> { todo!() }
pub fn read_file(root: &str, rel: &str) -> Result<String, String> { todo!() }
pub fn git_branch(root: &str) -> Option<String> { todo!() }
pub fn git_changes(root: &str) -> Result<Vec<FileChange>, String> { todo!() }
pub fn git_file_diff(root: &str, rel: &str) -> Result<String, String> { todo!() }
pub fn accept_file(root: &str, rel: &str) -> Result<(), String> { todo!() }
pub fn revert_file(root: &str, rel: &str) -> Result<(), String> { todo!() }
pub fn open_in_editor(root: &str, rel: &str) -> Result<(), String> { todo!() }
