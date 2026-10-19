//! Runs agent turns by spawning the Claude Code / Codex CLIs and translating
//! their JSONL output into `AgentEvent`s. Each turn is one child process.

use std::collections::{HashMap, HashSet};
use std::io::{BufRead, BufReader};
use std::process::{Child, ChildStderr, ChildStdout, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, PoisonError};
use std::thread::JoinHandle;

#[cfg(unix)]
use std::os::unix::process::CommandExt;

use serde_json::Value;
use tauri::{AppHandle, Emitter, Manager};

use crate::store::Store;
use crate::types::*;
use crate::workspace;

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
        app: AppHandle,
        thread_id: String,
        text: String,
    ) -> Result<(), String> {
        let (agent, root, session_id, model, bypass) = {
            let store = app.state::<Store>();
            let thread = store.thread(&thread_id).ok_or("Task not found")?;
            let settings = store.settings();
            let root = match &thread.project_id {
                Some(id) => settings
                    .projects
                    .iter()
                    .find(|p| &p.id == id)
                    .map(|p| p.path.clone())
                    .ok_or("Project not found")?,
                None => {
                    let dir = chat_dir(&app, &thread_id)?;
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
        let args = turn_args(
            agent,
            &root,
            session_id.as_deref(),
            model.as_deref(),
            &text,
            bypass,
        );
        let mut cmd = workspace::agent_command(agent)?;
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
            app,
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

/// Scratch working directory for a chat that has no project.
pub fn chat_dir(app: &AppHandle, thread_id: &str) -> Result<std::path::PathBuf, String> {
    let base = app.path().app_local_data_dir().map_err(|e| e.to_string())?;
    Ok(base.join("chats").join(thread_id))
}

/// Everything the stdout reader needs to persist and publish one turn's events.
struct Turn {
    app: AppHandle,
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
        let store = self.app.state::<Store>();
        if let Err(e) = store.update_thread(&self.thread_id, |t| apply(t, &self.message_id, &event))
        {
            log::warn!("failed to save agent event: {e}");
        }
        let _ = self.app.emit(
            "agent-event",
            AgentEventEnvelope {
                thread_id: self.thread_id.clone(),
                event,
            },
        );
    }
}

/// Reads the agent's stdout until it closes, then records the final status.
fn drive(turn: Turn, mut child: Child, stdout: ChildStdout, stderr_tail: JoinHandle<String>) {
    let mut has_text = false;
    let mut started = HashSet::new();
    let mut stream_error: Option<String> = None;

    for line in BufReader::new(stdout).lines() {
        let Ok(line) = line else { continue };
        let Ok(value) = serde_json::from_str::<Value>(&line) else {
            continue;
        };
        let parsed = match turn.agent {
            AgentKind::Claude => parse_claude(&value, &turn.root, &turn.message_id),
            AgentKind::Codex => parse_codex(&value, &turn.root, &turn.message_id),
        };
        for item in parsed {
            match item {
                Parsed::SessionId(id) => {
                    let store = turn.app.state::<Store>();
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
                            if has_text {
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
    turn.app
        .state::<Runner>()
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

/// Command-line arguments for one turn. Both CLIs take the prompt as the final positional argument.
fn turn_args(
    agent: AgentKind,
    root: &str,
    session_id: Option<&str>,
    model: Option<&str>,
    text: &str,
    bypass: bool,
) -> Vec<String> {
    let mut args: Vec<String> = Vec::new();
    match agent {
        AgentKind::Claude => {
            let mode = if bypass {
                "bypassPermissions"
            } else {
                "acceptEdits"
            };
            args.extend(
                [
                    "-p",
                    "--output-format",
                    "stream-json",
                    "--verbose",
                    "--permission-mode",
                    mode,
                ]
                .map(String::from),
            );
            if let Some(id) = session_id {
                args.extend(["--resume".to_string(), id.to_string()]);
            }
            if let Some(m) = model {
                args.extend(["--model".to_string(), m.to_string()]);
            }
            // `--` keeps a prompt that starts with "-" from being read as a flag.
            args.extend(["--".to_string(), text.to_string()]);
        }
        AgentKind::Codex => {
            args.extend(
                [
                    "exec",
                    "--json",
                    "--skip-git-repo-check",
                    "-C",
                    root,
                    "-s",
                    "workspace-write",
                ]
                .map(String::from),
            );
            if let Some(m) = model {
                args.extend(["-m".to_string(), m.to_string()]);
            }
            if let Some(id) = session_id {
                args.extend(["resume".to_string(), id.to_string()]);
            }
            args.extend(["--".to_string(), text.to_string()]);
        }
    }
    args
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

/// What one JSONL line means for the turn.
#[derive(Debug)]
enum Parsed {
    Event(AgentEvent),
    SessionId(String),
    /// The turn failed with this message.
    Error(String),
}

/// Collapses whitespace and caps the length, for tool summaries.
fn one_line(s: &str) -> String {
    s.split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .chars()
        .take(120)
        .collect()
}

/// Strips the project root so paths are project-relative; other paths pass through.
fn relative(root: &str, path: &str) -> String {
    path.strip_prefix(root)
        .and_then(|p| p.strip_prefix('/'))
        .unwrap_or(path)
        .to_string()
}

fn tool_started(message_id: &str, id: &str, name: &str, summary: String) -> Parsed {
    Parsed::Event(AgentEvent::ToolStarted {
        message_id: message_id.into(),
        tool: ToolCall {
            id: id.into(),
            name: name.into(),
            summary,
            status: StepStatus::Running,
        },
    })
}

fn tool_finished(message_id: &str, tool_id: &str, is_error: bool) -> Parsed {
    Parsed::Event(AgentEvent::ToolFinished {
        message_id: message_id.into(),
        tool_id: tool_id.into(),
        is_error,
    })
}

fn file_touched(message_id: &str, path: String) -> Parsed {
    Parsed::Event(AgentEvent::FileTouched {
        message_id: message_id.into(),
        path,
    })
}

fn text_delta(message_id: &str, text: &str) -> Parsed {
    Parsed::Event(AgentEvent::TextDelta {
        message_id: message_id.into(),
        text: text.into(),
    })
}

/// One-line summary of a tool call's input: the first useful field that is present.
fn summarize(input: &Value, root: &str) -> String {
    const KEYS: [&str; 6] = [
        "command",
        "file_path",
        "pattern",
        "url",
        "description",
        "query",
    ];
    KEYS.iter()
        .find_map(|key| {
            input[*key].as_str().filter(|s| !s.is_empty()).map(|s| {
                if *key == "file_path" {
                    relative(root, s)
                } else {
                    s.to_string()
                }
            })
        })
        .map(|s| one_line(&s))
        .unwrap_or_default()
}

fn claude_step_status(status: Option<&str>) -> StepStatus {
    match status {
        Some("in_progress") => StepStatus::Running,
        Some("completed") => StepStatus::Done,
        _ => StepStatus::Pending,
    }
}

fn claude_tool_use(block: &Value, root: &str, message_id: &str, out: &mut Vec<Parsed>) {
    let id = block["id"].as_str().unwrap_or_default();
    let name = block["name"].as_str().unwrap_or("Tool");
    let input = &block["input"];
    out.push(tool_started(message_id, id, name, summarize(input, root)));

    let path_of = |key: &str| input[key].as_str().map(|p| relative(root, p));
    let touched = match name {
        "Edit" | "Write" | "MultiEdit" => path_of("file_path"),
        "NotebookEdit" => path_of("notebook_path"),
        _ => None,
    };
    if let Some(path) = touched {
        out.push(file_touched(message_id, path));
    }
    if name == "TodoWrite" {
        let steps = input["todos"]
            .as_array()
            .into_iter()
            .flatten()
            .map(|todo| PlanStep {
                text: todo["content"].as_str().unwrap_or_default().into(),
                status: claude_step_status(todo["status"].as_str()),
            })
            .collect();
        out.push(Parsed::Event(AgentEvent::PlanUpdated {
            message_id: message_id.into(),
            steps,
        }));
    }
}

/// Maps one line of `claude -p --output-format stream-json` output.
fn parse_claude(v: &Value, root: &str, message_id: &str) -> Vec<Parsed> {
    let mut out = Vec::new();
    let blocks: &[Value] = v["message"]["content"]
        .as_array()
        .map_or(&[], Vec::as_slice);
    match v["type"].as_str() {
        Some("system") if v["subtype"] == "init" => {
            if let Some(id) = v["session_id"].as_str() {
                out.push(Parsed::SessionId(id.into()));
            }
        }
        Some("assistant") => {
            for block in blocks {
                match block["type"].as_str() {
                    Some("text") => {
                        let text = block["text"].as_str().unwrap_or_default();
                        if !text.is_empty() {
                            out.push(text_delta(message_id, text));
                        }
                    }
                    Some("tool_use") => claude_tool_use(block, root, message_id, &mut out),
                    _ => {}
                }
            }
        }
        Some("user") => {
            for block in blocks.iter().filter(|b| b["type"] == "tool_result") {
                let id = block["tool_use_id"].as_str().unwrap_or_default();
                let is_error = block["is_error"].as_bool().unwrap_or(false);
                out.push(tool_finished(message_id, id, is_error));
            }
        }
        Some("result") => {
            let is_error = v["is_error"].as_bool().unwrap_or(false);
            let subtype = v["subtype"].as_str().unwrap_or("error");
            if is_error || subtype != "success" {
                let text = v["result"]
                    .as_str()
                    .filter(|s| !s.is_empty())
                    .unwrap_or(subtype);
                out.push(Parsed::Error(text.into()));
            }
        }
        _ => {}
    }
    out
}

fn codex_step_status_list(items: &Value) -> Vec<PlanStep> {
    let mut running_taken = false;
    items
        .as_array()
        .into_iter()
        .flatten()
        .map(|todo| {
            let status = if todo["completed"].as_bool() == Some(true) {
                StepStatus::Done
            } else if !running_taken {
                running_taken = true;
                StepStatus::Running
            } else {
                StepStatus::Pending
            };
            PlanStep {
                text: todo["text"].as_str().unwrap_or_default().into(),
                status,
            }
        })
        .collect()
}

/// Maps one item event (`item.started` / `item.updated` / `item.completed`).
fn codex_item(completed: bool, item: &Value, root: &str, message_id: &str, out: &mut Vec<Parsed>) {
    let id = item["id"].as_str().unwrap_or_default();
    match item["type"].as_str() {
        Some("agent_message") if completed => {
            let text = item["text"].as_str().unwrap_or_default();
            if !text.is_empty() {
                out.push(text_delta(message_id, text));
            }
        }
        Some("command_execution") => {
            let command = item["command"].as_str().unwrap_or_default();
            out.push(tool_started(message_id, id, "Shell", one_line(command)));
            if completed {
                let failed = item["exit_code"].as_i64().unwrap_or(0) != 0;
                out.push(tool_finished(message_id, id, failed));
            }
        }
        Some("mcp_tool_call") => {
            let summary = format!(
                "{}.{}",
                item["server"].as_str().unwrap_or_default(),
                item["tool"].as_str().unwrap_or_default()
            );
            out.push(tool_started(message_id, id, "MCP", summary));
            if completed {
                out.push(tool_finished(message_id, id, item["status"] == "failed"));
            }
        }
        Some("web_search") => {
            let query = item["query"].as_str().unwrap_or_default();
            out.push(tool_started(message_id, id, "WebSearch", one_line(query)));
            if completed {
                out.push(tool_finished(message_id, id, false));
            }
        }
        Some("file_change") if completed => {
            let paths: Vec<String> = item["changes"]
                .as_array()
                .into_iter()
                .flatten()
                .filter_map(|c| c["path"].as_str())
                .map(|p| relative(root, p))
                .collect();
            out.push(tool_started(
                message_id,
                id,
                "Edit",
                one_line(&paths.join(", ")),
            ));
            for path in paths {
                out.push(file_touched(message_id, path));
            }
            out.push(tool_finished(message_id, id, item["status"] == "failed"));
        }
        Some("todo_list") => {
            out.push(Parsed::Event(AgentEvent::PlanUpdated {
                message_id: message_id.into(),
                steps: codex_step_status_list(&item["items"]),
            }));
        }
        _ => {}
    }
}

/// Maps one line of `codex exec --json` output.
fn parse_codex(v: &Value, root: &str, message_id: &str) -> Vec<Parsed> {
    let mut out = Vec::new();
    match v["type"].as_str() {
        Some("thread.started") => {
            if let Some(id) = v["thread_id"].as_str() {
                out.push(Parsed::SessionId(id.into()));
            }
        }
        Some(kind @ ("item.started" | "item.updated" | "item.completed")) => {
            if let Some(item) = v.get("item") {
                codex_item(kind == "item.completed", item, root, message_id, &mut out);
            }
        }
        Some("turn.failed") => {
            let message = v["error"]["message"].as_str().unwrap_or("Turn failed");
            out.push(Parsed::Error(message.into()));
        }
        Some("error") => {
            let message = v["message"].as_str().unwrap_or("Codex reported an error");
            out.push(Parsed::Error(message.into()));
        }
        _ => {}
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn claude_init_is_session_and_noise_is_ignored() {
        let init =
            json!({"type": "system", "subtype": "init", "cwd": "/abs", "session_id": "9578"});
        let out = parse_claude(&init, "/abs", "m1");
        assert!(matches!(out.as_slice(), [Parsed::SessionId(id)] if id == "9578"));

        let hook = json!({"type": "system", "subtype": "hook_started"});
        assert!(parse_claude(&hook, "/abs", "m1").is_empty());
        let rate = json!({"type": "rate_limit_event"});
        assert!(parse_claude(&rate, "/abs", "m1").is_empty());
    }

    #[test]
    fn claude_assistant_text_and_edit() {
        let v = json!({"type": "assistant", "message": {"content": [
            {"type": "text", "text": "hi"},
            {"type": "thinking", "thinking": "..."},
            {"type": "tool_use", "id": "toolu_1", "name": "Edit",
             "input": {"file_path": "/abs/a.css", "old_string": "..", "new_string": ".."}}
        ]}});
        let out = parse_claude(&v, "/abs", "m1");
        assert_eq!(out.len(), 3);
        assert!(
            matches!(&out[0], Parsed::Event(AgentEvent::TextDelta { text, .. }) if text == "hi")
        );
        assert!(matches!(
            &out[1],
            Parsed::Event(AgentEvent::ToolStarted { tool, .. })
                if tool.id == "toolu_1" && tool.name == "Edit" && tool.summary == "a.css"
                    && tool.status == StepStatus::Running
        ));
        assert!(
            matches!(&out[2], Parsed::Event(AgentEvent::FileTouched { path, .. }) if path == "a.css")
        );
    }

    #[test]
    fn claude_todo_write_becomes_plan() {
        let v = json!({"type": "assistant", "message": {"content": [
            {"type": "tool_use", "id": "t2", "name": "TodoWrite", "input": {"todos": [
                {"content": "Plan", "status": "completed"},
                {"content": "Build", "status": "in_progress"},
                {"content": "Ship", "status": "pending"}
            ]}}
        ]}});
        let out = parse_claude(&v, "/abs", "m1");
        let [_, Parsed::Event(AgentEvent::PlanUpdated { steps, .. })] = out.as_slice() else {
            panic!("expected a plan update, got {out:?}");
        };
        let statuses: Vec<StepStatus> = steps.iter().map(|s| s.status).collect();
        assert_eq!(
            statuses,
            [StepStatus::Done, StepStatus::Running, StepStatus::Pending]
        );
    }

    #[test]
    fn claude_tool_result_and_result_errors() {
        let user = json!({"type": "user", "message": {"content": [
            {"type": "tool_result", "tool_use_id": "toolu_1", "is_error": true, "content": "x"}
        ]}});
        let out = parse_claude(&user, "/abs", "m1");
        assert!(matches!(
            out.as_slice(),
            [Parsed::Event(AgentEvent::ToolFinished { tool_id, is_error: true, .. })] if tool_id == "toolu_1"
        ));

        let failed = json!({"type": "result", "subtype": "success", "is_error": true, "result": "Invalid key"});
        let out = parse_claude(&failed, "/abs", "m1");
        assert!(matches!(out.as_slice(), [Parsed::Error(e)] if e == "Invalid key"));

        let ok = json!({"type": "result", "subtype": "success", "is_error": false, "result": "hi"});
        assert!(parse_claude(&ok, "/abs", "m1").is_empty());
    }

    #[test]
    fn codex_thread_and_config_warnings() {
        let started = json!({"type": "thread.started", "thread_id": "01a154bb"});
        assert!(matches!(
            parse_codex(&started, "/abs", "m1").as_slice(),
            [Parsed::SessionId(id)] if id == "01a154bb"
        ));

        let turn = json!({"type": "turn.started"});
        assert!(parse_codex(&turn, "/abs", "m1").is_empty());

        let warning = json!({"type": "item.completed", "item": {
            "id": "item_0", "type": "error",
            "message": "Codex is ignoring 1 unrecognized configuration setting"
        }});
        assert!(parse_codex(&warning, "/abs", "m1").is_empty());
    }

    #[test]
    fn codex_message_and_command() {
        let msg = json!({"type": "item.completed", "item": {"id": "item_2", "type": "agent_message", "text": "hi"}});
        assert!(matches!(
            parse_codex(&msg, "/abs", "m1").as_slice(),
            [Parsed::Event(AgentEvent::TextDelta { text, .. })] if text == "hi"
        ));

        let started = json!({"type": "item.started", "item": {
            "id": "item_3", "type": "command_execution", "command": "cargo  test", "status": "in_progress"
        }});
        assert!(matches!(
            parse_codex(&started, "/abs", "m1").as_slice(),
            [Parsed::Event(AgentEvent::ToolStarted { tool, .. })]
                if tool.name == "Shell" && tool.summary == "cargo test"
        ));

        let done = json!({"type": "item.completed", "item": {
            "id": "item_3", "type": "command_execution", "command": "cargo test",
            "exit_code": 1, "status": "failed"
        }});
        let out = parse_codex(&done, "/abs", "m1");
        assert!(matches!(
            out.last(),
            Some(Parsed::Event(AgentEvent::ToolFinished { tool_id, is_error: true, .. })) if tool_id == "item_3"
        ));
    }

    #[test]
    fn codex_file_change_and_todo_list() {
        let change = json!({"type": "item.completed", "item": {
            "id": "item_4", "type": "file_change", "status": "completed",
            "changes": [{"path": "/abs/src/a.ts", "kind": "update"}]
        }});
        let out = parse_codex(&change, "/abs", "m1");
        assert_eq!(out.len(), 3);
        assert!(matches!(
            &out[0],
            Parsed::Event(AgentEvent::ToolStarted { tool, .. }) if tool.name == "Edit" && tool.summary == "src/a.ts"
        ));
        assert!(
            matches!(&out[1], Parsed::Event(AgentEvent::FileTouched { path, .. }) if path == "src/a.ts")
        );
        assert!(matches!(
            &out[2],
            Parsed::Event(AgentEvent::ToolFinished {
                is_error: false,
                ..
            })
        ));

        let todos = json!({"type": "item.updated", "item": {"id": "item_5", "type": "todo_list", "items": [
            {"text": "Read", "completed": true},
            {"text": "Edit", "completed": false},
            {"text": "Test", "completed": false}
        ]}});
        let out = parse_codex(&todos, "/abs", "m1");
        let [Parsed::Event(AgentEvent::PlanUpdated { steps, .. })] = out.as_slice() else {
            panic!("expected a plan update, got {out:?}");
        };
        let statuses: Vec<StepStatus> = steps.iter().map(|s| s.status).collect();
        assert_eq!(
            statuses,
            [StepStatus::Done, StepStatus::Running, StepStatus::Pending]
        );
    }

    #[test]
    fn codex_turn_failure_is_error() {
        let failed = json!({"type": "turn.failed", "error": {"message": "rate limited"}});
        assert!(matches!(
            parse_codex(&failed, "/abs", "m1").as_slice(),
            [Parsed::Error(e)] if e == "rate limited"
        ));
    }

    #[test]
    fn claude_args_include_resume_model_and_mode() {
        let args = turn_args(
            AgentKind::Claude,
            "/abs",
            Some("sid"),
            Some("opus"),
            "do it",
            true,
        );
        assert_eq!(
            args,
            [
                "-p",
                "--output-format",
                "stream-json",
                "--verbose",
                "--permission-mode",
                "bypassPermissions",
                "--resume",
                "sid",
                "--model",
                "opus",
                "--",
                "do it",
            ]
        );
    }

    #[test]
    fn codex_args_for_new_and_resumed_turns() {
        let new = turn_args(AgentKind::Codex, "/abs", None, None, "go", false);
        assert_eq!(
            new,
            [
                "exec",
                "--json",
                "--skip-git-repo-check",
                "-C",
                "/abs",
                "-s",
                "workspace-write",
                "--",
                "go"
            ]
        );
        let resumed = turn_args(
            AgentKind::Codex,
            "/abs",
            Some("sid"),
            Some("gpt"),
            "go",
            false,
        );
        assert_eq!(
            resumed,
            [
                "exec",
                "--json",
                "--skip-git-repo-check",
                "-C",
                "/abs",
                "-s",
                "workspace-write",
                "-m",
                "gpt",
                "resume",
                "sid",
                "--",
                "go",
            ]
        );
    }

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
        let args = turn_args(agent, root_str, None, model, prompt, false);
        let out = workspace::agent_command(agent)
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
            .flat_map(|v| match agent {
                AgentKind::Claude => parse_claude(&v, root_str, "m"),
                AgentKind::Codex => parse_codex(&v, root_str, "m"),
            })
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
}
