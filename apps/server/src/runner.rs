//! Runs agent turns by spawning the agent CLIs and translating their JSONL
//! output into `AgentEvent`s. Each turn is one child process.

use std::collections::{HashMap, HashSet};
use std::io::{BufRead, BufReader};
use std::process::{Child, ChildStderr, ChildStdout, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, PoisonError};
use std::thread::JoinHandle;

#[cfg(unix)]
use std::os::unix::process::CommandExt;

use crate::Server;
use crate::provider::{self, Parsed};
use crate::types::*;
use crate::workspace;
use serde_json::Value;

/// How much of the agent's stderr is kept for error reporting.
const STDERR_TAIL_BYTES: usize = 4096;

struct RunningTurn {
    pid: u32,
    cancelled: Arc<AtomicBool>,
}

#[derive(Default)]
pub struct Runner {
    turns: Mutex<HashMap<String, RunningTurn>>,
}

impl Runner {
    pub fn is_running(&self, thread_id: &str) -> bool {
        self.turns
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .contains_key(thread_id)
    }

    pub fn start_turn(
        &self,
        server: &Arc<Server>,
        thread_id: String,
        text: String,
    ) -> Result<(), String> {
        let (agent, root, session_id, model, bypass) = {
            let thread = server.store.thread(&thread_id).ok_or("Task not found")?;
            let settings = server.store.settings();
            let root = match &thread.project_id {
                Some(id) => settings
                    .projects
                    .iter()
                    .find(|p| &p.id == id)
                    .map(|p| p.path.clone())
                    .ok_or("Project not found")?,
                None => {
                    let dir = server.chat_dir(&thread_id);
                    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
                    dir.to_string_lossy().into_owned()
                }
            };
            (
                thread.agent,
                root,
                thread.session_id,
                thread.model,
                settings.integrations.terminal,
            )
        };

        // Agents often edit files through the shell, so changes are also found by
        // comparing git state before and after the turn.
        let baseline = workspace::git_changes(&root).unwrap_or_default();
        let args = provider::turn_args(
            agent,
            &root,
            session_id.as_deref(),
            model.as_deref(),
            &text,
            bypass,
        );
        let mut cmd = provider::agent_command(agent)?;
        cmd.args(&args)
            .current_dir(&root)
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        #[cfg(unix)]
        cmd.process_group(0);
        let mut child = cmd
            .spawn()
            .map_err(|e| format!("Failed to start agent: {e}"))?;
        let (Some(stdout), Some(stderr)) = (child.stdout.take(), child.stderr.take()) else {
            return Err("Agent output is unavailable".into());
        };
        let stderr_tail = std::thread::spawn(move || read_stderr_tail(stderr));

        let message = Message {
            id: new_id(),
            role: Role::Assistant,
            text: String::new(),
            created_at: now_ms(),
            status: MessageStatus::Streaming,
            tools: vec![],
            plan: vec![],
            files: vec![],
            error: None,
        };
        let cancelled = Arc::new(AtomicBool::new(false));
        let turn = Turn {
            server: server.clone(),
            thread_id: thread_id.clone(),
            message_id: message.id.clone(),
            agent,
            root,
            cancelled: cancelled.clone(),
            baseline,
        };
        self.turns
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .insert(
                thread_id,
                RunningTurn {
                    pid: child.id(),
                    cancelled,
                },
            );
        turn.publish(AgentEvent::MessageStarted { message });
        std::thread::spawn(move || drive(turn, child, stdout, stderr_tail));
        Ok(())
    }

    pub fn cancel(&self, thread_id: &str) {
        let turns = self.turns.lock().unwrap_or_else(PoisonError::into_inner);
        if let Some(turn) = turns.get(thread_id) {
            turn.cancelled.store(true, Ordering::SeqCst);
            workspace::signal_process_group(turn.pid, libc::SIGTERM);
        }
    }
}

/// Everything the stdout reader needs to persist and publish one turn's events.
struct Turn {
    server: Arc<Server>,
    thread_id: String,
    message_id: String,
    agent: AgentKind,
    root: String,
    cancelled: Arc<AtomicBool>,
    /// `git status` of the project when the turn started.
    baseline: Vec<FileChange>,
}

impl Turn {
    /// Saves `event` onto the stored message, then streams it to the frontend.
    fn publish(&self, event: AgentEvent) {
        let store = &self.server.store;
        if let Err(e) = store.update_thread(&self.thread_id, |t| apply(t, &self.message_id, &event))
        {
            log::warn!("failed to save agent event: {e}");
        }
        self.server.emit(AgentEventEnvelope {
            thread_id: self.thread_id.clone(),
            event,
        });
    }
}

/// Reads the agent's stdout until it closes, then records the final status.
fn drive(turn: Turn, mut child: Child, stdout: ChildStdout, stderr_tail: JoinHandle<String>) {
    let mut has_text = false;
    // Gemini streams one text block as many deltas; other agents send whole blocks.
    let mut last_was_text = false;
    let mut started = HashSet::new();
    let mut stream_error: Option<String> = None;

    for line in BufReader::new(stdout).lines() {
        let Ok(line) = line else { continue };
        let Ok(value) = serde_json::from_str::<Value>(&line) else {
            continue;
        };
        let parsed = provider::parse_line(turn.agent, &value, &turn.root, &turn.message_id);
        for item in parsed {
            match item {
                Parsed::SessionId(id) => {
                    let store = &turn.server.store;
                    if let Err(e) =
                        store.update_thread(&turn.thread_id, |t| t.session_id = Some(id))
                    {
                        log::warn!("failed to save session id: {e}");
                    }
                }
                Parsed::Error(message) => {
                    stream_error.get_or_insert(message);
                }
                Parsed::Event(mut event) => {
                    match &mut event {
                        // Separate successive text blocks so they do not run together.
                        AgentEvent::TextDelta { text, .. } => {
                            let continues = turn.agent == AgentKind::Gemini && last_was_text;
                            if has_text && !continues {
                                text.insert_str(0, "\n\n");
                            }
                            has_text = true;
                        }
                        // Codex reports a tool when it starts and again when it completes;
                        // only the first ToolStarted for an id is kept.
                        AgentEvent::ToolStarted { tool, .. }
                            if !started.insert(tool.id.clone()) =>
                        {
                            continue;
                        }
                        _ => {}
                    }
                    last_was_text = matches!(event, AgentEvent::TextDelta { .. });
                    turn.publish(event);
                }
            }
        }
    }

    let exit = child.wait().ok();
    let tail = stderr_tail.join().unwrap_or_default();
    let (status, error) = if turn.cancelled.load(Ordering::SeqCst) {
        (MessageStatus::Cancelled, None)
    } else if stream_error.is_some() || !exit.is_some_and(|s| s.success()) {
        let error = stream_error
            .or_else(|| last_lines(&tail))
            .unwrap_or_else(|| match exit.and_then(|s| s.code()) {
                Some(code) => format!("Agent exited with code {code}"),
                None => "Agent exited unexpectedly".into(),
            });
        (MessageStatus::Error, Some(error))
    } else {
        (MessageStatus::Complete, None)
    };

    let after = workspace::git_changes(&turn.root).unwrap_or_default();
    for path in changed_paths(&turn.baseline, &after) {
        turn.publish(AgentEvent::FileTouched {
            message_id: turn.message_id.clone(),
            path,
        });
    }

    // Forget the turn before announcing it, so a follow-up message sent on
    // TurnCompleted is not rejected as "already running".
    turn.server
        .runner
        .turns
        .lock()
        .unwrap_or_else(PoisonError::into_inner)
        .remove(&turn.thread_id);
    turn.publish(AgentEvent::TurnCompleted {
        message_id: turn.message_id.clone(),
        status,
        error,
    });
}

/// Paths whose git status or line counts differ between two snapshots.
fn changed_paths(before: &[FileChange], after: &[FileChange]) -> Vec<String> {
    let key = |c: &FileChange| (c.status.clone(), c.additions, c.deletions);
    after
        .iter()
        .filter(|a| {
            before
                .iter()
                .find(|b| b.path == a.path)
                .is_none_or(|b| key(b) != key(a))
        })
        .map(|a| a.path.clone())
        .collect()
}

/// Reads all of stderr but keeps only roughly the last `STDERR_TAIL_BYTES`.
fn read_stderr_tail(stderr: ChildStderr) -> String {
    let mut reader = BufReader::new(stderr);
    let mut tail = String::new();
    let mut line = Vec::new();
    while reader.read_until(b'\n', &mut line).unwrap_or(0) > 0 {
        tail.push_str(&String::from_utf8_lossy(&line));
        line.clear();
        if tail.len() > STDERR_TAIL_BYTES {
            let mut cut = tail.len() - STDERR_TAIL_BYTES;
            while !tail.is_char_boundary(cut) {
                cut += 1;
            }
            tail.drain(..cut);
        }
    }
    tail
}

/// The last few non-empty stderr lines, used as the error text when the CLI fails without a message.
fn last_lines(tail: &str) -> Option<String> {
    let mut lines: Vec<&str> = tail
        .lines()
        .rev()
        .filter(|l| !l.trim().is_empty())
        .take(3)
        .collect();
    lines.reverse();
    (!lines.is_empty()).then(|| lines.join("\n"))
}

/// Applies one event to the stored message. Used for both persistence and replay.
fn apply(thread: &mut Thread, message_id: &str, event: &AgentEvent) {
    if let AgentEvent::MessageStarted { message } = event {
        if !thread.messages.iter().any(|m| m.id == message.id) {
            thread.messages.push(message.clone());
        }
        return;
    }
    let Some(msg) = thread.messages.iter_mut().find(|m| m.id == message_id) else {
        return;
    };
    match event {
        AgentEvent::TextDelta { text, .. } => msg.text.push_str(text),
        AgentEvent::ToolStarted { tool, .. } => msg.tools.push(tool.clone()),
        AgentEvent::ToolFinished {
            tool_id, is_error, ..
        } => {
            if let Some(tool) = msg.tools.iter_mut().find(|t| t.id == *tool_id) {
                tool.status = if *is_error {
                    StepStatus::Error
                } else {
                    StepStatus::Done
                };
            }
        }
        AgentEvent::PlanUpdated { steps, .. } => msg.plan = steps.clone(),
        AgentEvent::FileTouched { path, .. } => {
            if !msg.files.contains(path) {
                msg.files.push(path.clone());
            }
        }
        AgentEvent::TurnCompleted { status, error, .. } => {
            msg.status = *status;
            msg.error = error.clone();
            // Nothing can still be running once the turn has ended.
            let tool_end = if *status == MessageStatus::Complete {
                StepStatus::Done
            } else {
                StepStatus::Error
            };
            for tool in msg
                .tools
                .iter_mut()
                .filter(|t| t.status == StepStatus::Running)
            {
                tool.status = tool_end;
            }
            for step in msg
                .plan
                .iter_mut()
                .filter(|s| s.status == StepStatus::Running)
            {
                step.status = StepStatus::Pending;
            }
        }
        AgentEvent::MessageStarted { .. } => {}
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn change(path: &str, status: &str, additions: u32) -> FileChange {
        FileChange {
            path: path.into(),
            status: status.into(),
            additions,
            deletions: 0,
            staged: false,
        }
    }

    #[test]
    fn changed_paths_finds_new_and_modified_files() {
        let before = [change("a.rs", "modified", 1), change("b.rs", "modified", 2)];
        let after = [
            change("a.rs", "modified", 1),
            change("b.rs", "modified", 5),
            change("c.rs", "untracked", 3),
        ];
        assert_eq!(changed_paths(&before, &after), ["b.rs", "c.rs"]);
    }

    /// Runs a real turn through the installed CLI and checks the parsed stream.
    /// Needs the agent installed and signed in: `cargo test -- --ignored`.
    fn live_turn(agent: AgentKind) {
        let root = std::env::temp_dir().join(new_id());
        std::fs::create_dir_all(&root).unwrap();
        let root_str = root.to_str().unwrap();
        let ok = std::process::Command::new("git")
            .args(["init", "-q"])
            .current_dir(&root)
            .status()
            .unwrap();
        assert!(ok.success());

        let prompt = "Create a file named hello.txt whose only content is the two letters hi (no period). Do nothing else.";
        let model = (agent == AgentKind::Claude).then_some("haiku");
        let baseline = workspace::git_changes(root_str).unwrap();
        let args = provider::turn_args(agent, root_str, None, model, prompt, false);
        let out = provider::agent_command(agent)
            .unwrap()
            .args(&args)
            .current_dir(&root)
            .stdin(Stdio::null())
            .output()
            .unwrap();
        assert!(
            out.status.success(),
            "{}",
            String::from_utf8_lossy(&out.stderr)
        );

        let parsed: Vec<Parsed> = String::from_utf8_lossy(&out.stdout)
            .lines()
            .filter_map(|l| serde_json::from_str::<Value>(l).ok())
            .flat_map(|v| provider::parse_line(agent, &v, root_str, "m"))
            .collect();
        assert!(parsed.iter().any(|p| matches!(p, Parsed::SessionId(_))));
        assert!(!parsed.iter().any(|p| matches!(p, Parsed::Error(_))));
        let changed = changed_paths(&baseline, &workspace::git_changes(root_str).unwrap());
        assert_eq!(changed, ["hello.txt"]);
        let content = std::fs::read_to_string(root.join("hello.txt")).unwrap();
        assert_eq!(content.trim(), "hi");
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    #[ignore = "runs the real Claude Code CLI"]
    fn live_claude_turn() {
        live_turn(AgentKind::Claude);
    }

    #[test]
    #[ignore = "runs the real Codex CLI"]
    fn live_codex_turn() {
        live_turn(AgentKind::Codex);
    }

    #[test]
    #[ignore = "runs the real Gemini CLI"]
    fn live_gemini_turn() {
        live_turn(AgentKind::Gemini);
    }
}
