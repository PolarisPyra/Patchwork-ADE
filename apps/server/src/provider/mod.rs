//! Agent CLIs: locating and probing them, building turn arguments, and mapping
//! their JSONL output. Each provider module knows one CLI.

pub mod claude;
pub mod codex;
pub mod gemini;

use std::io::Read;
use std::path::PathBuf;
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

#[cfg(unix)]
use std::os::unix::process::CommandExt;

use serde_json::Value;

use crate::types::*;
use crate::workspace::signal_process_group;

/// Upper bound for any single agent CLI probe (`--version`, `auth status`, ...).
const PROBE_TIMEOUT: Duration = Duration::from_secs(10);

pub fn home_dir() -> Option<PathBuf> {
    std::env::var_os("HOME").map(PathBuf::from)
}

/// Directories searched when `which` cannot find the agent CLI on PATH.
fn fallback_dirs() -> Vec<PathBuf> {
    let home = home_dir().unwrap_or_default();
    let mut dirs: Vec<PathBuf> = [".local/bin", ".cargo/bin", ".bun/bin"]
        .iter()
        .map(|d| home.join(d))
        .collect();
    dirs.extend(["/usr/local/bin", "/opt/homebrew/bin"].map(PathBuf::from));
    if let Ok(entries) = std::fs::read_dir(home.join(".nvm/versions/node")) {
        let mut nvm: Vec<PathBuf> = entries.flatten().map(|e| e.path().join("bin")).collect();
        nvm.sort();
        dirs.extend(nvm);
    }
    dirs
}

fn find_binary(name: &str) -> Option<PathBuf> {
    which::which(name).ok().or_else(|| {
        fallback_dirs()
            .into_iter()
            .map(|d| d.join(name))
            .find(|p| p.is_file())
    })
}

/// Resolves the agent CLI (searching PATH plus common install dirs, since GUI
/// launches may not inherit the shell PATH) and returns a Command for it with
/// the binary's directory prepended to PATH (codex and gemini need `node` beside it).
pub fn agent_command(kind: AgentKind) -> Result<Command, String> {
    let (name, missing) = match kind {
        AgentKind::Claude => ("claude", "Claude Code is not installed"),
        AgentKind::Codex => ("codex", "Codex is not installed"),
        AgentKind::Gemini => ("gemini", "Gemini CLI is not installed"),
    };
    let bin = find_binary(name).ok_or(missing)?;
    let mut cmd = Command::new(&bin);
    if let Some(dir) = bin.parent() {
        let mut paths = vec![dir.to_path_buf()];
        if let Some(existing) = std::env::var_os("PATH") {
            paths.extend(std::env::split_paths(&existing));
        }
        if let Ok(joined) = std::env::join_paths(paths) {
            cmd.env("PATH", joined);
        }
    }
    Ok(cmd)
}

pub struct Probe {
    pub success: bool,
    pub stdout: String,
    pub stderr: String,
}

/// Runs the agent CLI with `args`. Returns None if it cannot start or exceeds
/// `PROBE_TIMEOUT` (the process group is killed in that case).
pub fn probe(kind: AgentKind, args: &[&str]) -> Option<Probe> {
    let mut cmd = agent_command(kind).ok()?;
    cmd.args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    #[cfg(unix)]
    cmd.process_group(0);
    let mut child = cmd.spawn().ok()?;
    let mut stdout = child.stdout.take()?;
    let mut stderr = child.stderr.take()?;
    let out_reader = std::thread::spawn(move || {
        let mut buf = Vec::new();
        let _ = stdout.read_to_end(&mut buf);
        buf
    });
    let err_reader = std::thread::spawn(move || {
        let mut buf = Vec::new();
        let _ = stderr.read_to_end(&mut buf);
        buf
    });

    let deadline = Instant::now() + PROBE_TIMEOUT;
    let exit = loop {
        match child.try_wait() {
            Ok(Some(status)) => break status,
            Ok(None) if Instant::now() < deadline => std::thread::sleep(Duration::from_millis(10)),
            _ => {
                signal_process_group(child.id(), libc::SIGKILL);
                let _ = child.kill();
                let _ = child.wait();
                return None;
            }
        }
    };
    Some(Probe {
        success: exit.success(),
        stdout: String::from_utf8_lossy(&out_reader.join().unwrap_or_default()).into_owned(),
        stderr: String::from_utf8_lossy(&err_reader.join().unwrap_or_default()).into_owned(),
    })
}

pub fn detect_agent(kind: AgentKind) -> AgentStatus {
    let mut status = AgentStatus {
        kind,
        installed: false,
        version: None,
        signed_in: false,
        detail: "Not installed".into(),
    };
    let Some(version) = probe(kind, &["--version"]).filter(|p| p.success) else {
        return status;
    };
    status.installed = true;
    // "2.1.303 (Claude Code)", "codex-cli 0.163.0" and "0.64.0" all carry the version as a numeric word.
    status.version = version
        .stdout
        .split_whitespace()
        .find(|w| w.starts_with(|c: char| c.is_ascii_digit()))
        .map(String::from);
    match kind {
        AgentKind::Claude => claude::auth(&mut status),
        AgentKind::Codex => codex::auth(&mut status),
        AgentKind::Gemini => gemini::auth(&mut status),
    }
    status
}

/// Models offered for `kind`, starting with the CLI default.
pub fn list_models(kind: AgentKind) -> Vec<ModelOption> {
    let (default_model, models) = match kind {
        AgentKind::Claude => (claude::configured_model(), claude::models()),
        AgentKind::Codex => (codex::configured_model(), codex::models()),
        AgentKind::Gemini => (gemini::configured_model(), gemini::models()),
    };
    let mut out = vec![ModelOption {
        id: None,
        label: "Default".into(),
        default_model: default_model.filter(|m| !m.trim().is_empty()),
    }];
    out.extend(models);
    out
}

/// Fixed model aliases, as `ModelOption`s.
fn alias_models(aliases: &[(&str, &str)]) -> Vec<ModelOption> {
    aliases
        .iter()
        .map(|(id, label)| ModelOption {
            id: Some((*id).into()),
            label: (*label).into(),
            default_model: None,
        })
        .collect()
}

/// Command-line arguments for one turn.
pub fn turn_args(
    agent: AgentKind,
    root: &str,
    session_id: Option<&str>,
    model: Option<&str>,
    text: &str,
    bypass: bool,
) -> Vec<String> {
    match agent {
        AgentKind::Claude => claude::turn_args(session_id, model, text, bypass),
        AgentKind::Codex => codex::turn_args(root, session_id, model, text),
        AgentKind::Gemini => gemini::turn_args(session_id, model, text, bypass),
    }
}

/// Maps one line of the agent's JSONL output.
pub fn parse_line(agent: AgentKind, v: &Value, root: &str, message_id: &str) -> Vec<Parsed> {
    match agent {
        AgentKind::Claude => claude::parse(v, root, message_id),
        AgentKind::Codex => codex::parse(v, root, message_id),
        AgentKind::Gemini => gemini::parse(v, root, message_id),
    }
}

/// What one JSONL line means for the turn.
#[derive(Debug)]
pub enum Parsed {
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
