//! Codex (`codex exec --json`).

use std::path::{Path, PathBuf};

use serde_json::Value;

use super::*;

/// `$CODEX_HOME`, else `~/.codex`.
pub fn home() -> Option<PathBuf> {
    std::env::var_os("CODEX_HOME")
        .map(PathBuf::from)
        .or_else(|| home_dir().map(|h| h.join(".codex")))
}

pub fn auth(status: &mut AgentStatus) {
    let login = probe(AgentKind::Codex, &["login", "status"])
        .filter(|p| p.success)
        .and_then(|p| {
            p.stdout
                .lines()
                .chain(p.stderr.lines())
                .find(|l| l.contains("Logged in"))
                .map(|l| l.trim().to_string())
        });
    status.signed_in = login.is_some();
    status.detail = login.unwrap_or_else(|| "Not signed in — run `codex login`".into());
}

/// Read only model settings, without launching an inference request.
pub fn configured_model() -> Option<String> {
    let settings: toml::Value =
        toml::from_str(&std::fs::read_to_string(home()?.join("config.toml")).ok()?).ok()?;
    let profile_model = settings
        .get("profile")
        .and_then(toml::Value::as_str)
        .and_then(|profile| settings.get("profiles")?.get(profile)?.get("model"));
    Some(
        profile_model
            .or_else(|| settings.get("model"))?
            .as_str()?
            .to_owned(),
    )
}

/// The models the CLI caches in `$CODEX_HOME/models_cache.json`.
pub fn models() -> Vec<ModelOption> {
    home()
        .and_then(|h| std::fs::read_to_string(h.join("models_cache.json")).ok())
        .map(|json| cached_models(&json))
        .unwrap_or_default()
}

/// Visible models from Codex's model cache, in the CLI's priority order.
fn cached_models(json: &str) -> Vec<ModelOption> {
    let Ok(v) = serde_json::from_str::<Value>(json) else {
        return vec![];
    };
    let mut listed: Vec<(i64, ModelOption)> = v["models"]
        .as_array()
        .into_iter()
        .flatten()
        .filter(|m| m["visibility"] == "list")
        .filter_map(|m| {
            let slug = m["slug"].as_str()?;
            let label = m["display_name"].as_str().unwrap_or(slug);
            let priority = m["priority"].as_i64().unwrap_or(i64::MAX);
            Some((
                priority,
                ModelOption {
                    id: Some(slug.into()),
                    label: label.into(),
                    default_model: None,
                },
            ))
        })
        .collect();
    listed.sort_by_key(|(priority, _)| *priority);
    listed.into_iter().map(|(_, m)| m).collect()
}

/// `(modified time, path)` of every rollout file under `dir`.
pub fn rollout_files(dir: &Path) -> Vec<(std::time::SystemTime, PathBuf)> {
    let mut out = Vec::new();
    let mut stack = vec![dir.to_path_buf()];
    while let Some(dir) = stack.pop() {
        for entry in std::fs::read_dir(&dir).into_iter().flatten().flatten() {
            let path = entry.path();
            if path.is_dir() {
                stack.push(path);
            } else if path.extension().is_some_and(|e| e == "jsonl") {
                let modified = entry.metadata().and_then(|m| m.modified());
                out.push((modified.unwrap_or(std::time::UNIX_EPOCH), path));
            }
        }
    }
    out
}

/// The prompt is the final positional argument.
pub fn turn_args(
    root: &str,
    session_id: Option<&str>,
    model: Option<&str>,
    text: &str,
) -> Vec<String> {
    let mut args: Vec<String> = Vec::new();
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
    args
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
pub fn parse(v: &Value, root: &str, message_id: &str) -> Vec<Parsed> {
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
    fn codex_thread_and_config_warnings() {
        let started = json!({"type": "thread.started", "thread_id": "01a154bb"});
        assert!(matches!(
            parse(&started, "/abs", "m1").as_slice(),
            [Parsed::SessionId(id)] if id == "01a154bb"
        ));

        let turn = json!({"type": "turn.started"});
        assert!(parse(&turn, "/abs", "m1").is_empty());

        let warning = json!({"type": "item.completed", "item": {
            "id": "item_0", "type": "error",
            "message": "Codex is ignoring 1 unrecognized configuration setting"
        }});
        assert!(parse(&warning, "/abs", "m1").is_empty());
    }

    #[test]
    fn codex_message_and_command() {
        let msg = json!({"type": "item.completed", "item": {"id": "item_2", "type": "agent_message", "text": "hi"}});
        assert!(matches!(
            parse(&msg, "/abs", "m1").as_slice(),
            [Parsed::Event(AgentEvent::TextDelta { text, .. })] if text == "hi"
        ));

        let started = json!({"type": "item.started", "item": {
            "id": "item_3", "type": "command_execution", "command": "cargo  test", "status": "in_progress"
        }});
        assert!(matches!(
            parse(&started, "/abs", "m1").as_slice(),
            [Parsed::Event(AgentEvent::ToolStarted { tool, .. })]
                if tool.name == "Shell" && tool.summary == "cargo test"
        ));

        let done = json!({"type": "item.completed", "item": {
            "id": "item_3", "type": "command_execution", "command": "cargo test",
            "exit_code": 1, "status": "failed"
        }});
        let out = parse(&done, "/abs", "m1");
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
        let out = parse(&change, "/abs", "m1");
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
        let out = parse(&todos, "/abs", "m1");
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
            parse(&failed, "/abs", "m1").as_slice(),
            [Parsed::Error(e)] if e == "rate limited"
        ));
    }

    #[test]
    fn codex_args_for_new_and_resumed_turns() {
        let new = turn_args("/abs", None, None, "go");
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
        let resumed = turn_args("/abs", Some("sid"), Some("gpt"), "go");
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

    #[test]
    fn codex_models_lists_visible_models_by_priority() {
        let json = r#"{"models":[
            {"slug":"b","display_name":"B","visibility":"list","priority":2},
            {"slug":"hidden","display_name":"H","visibility":"hide","priority":0},
            {"slug":"a","display_name":"A","visibility":"list","priority":1}
        ]}"#;
        let ids: Vec<_> = cached_models(json)
            .into_iter()
            .map(|m| m.id.unwrap())
            .collect();
        assert_eq!(ids, ["a", "b"]);
        assert!(cached_models("not json").is_empty());
    }
}
