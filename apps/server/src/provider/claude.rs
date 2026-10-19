//! Claude Code (`claude -p --output-format stream-json`).

use std::path::PathBuf;

use serde_json::Value;

use super::*;

/// `$CLAUDE_CONFIG_DIR`, else `~/.claude`.
pub fn home() -> Option<PathBuf> {
    std::env::var_os("CLAUDE_CONFIG_DIR")
        .map(PathBuf::from)
        .or_else(|| home_dir().map(|h| h.join(".claude")))
}

pub fn auth(status: &mut AgentStatus) {
    let json = probe(AgentKind::Claude, &["auth", "status"])
        .and_then(|p| serde_json::from_str::<Value>(p.stdout.trim()).ok());
    let logged_in = json
        .as_ref()
        .and_then(|v| v["loggedIn"].as_bool())
        .unwrap_or(false);
    if logged_in {
        let method = json
            .as_ref()
            .and_then(|v| v["authMethod"].as_str())
            .unwrap_or("claude.ai");
        status.signed_in = true;
        status.detail = format!("Signed in with {method}");
    } else {
        status.detail = "Not signed in — run `claude` to log in".into();
    }
}

/// Read only model settings, without launching an inference request.
pub fn configured_model() -> Option<String> {
    if let Ok(model) = std::env::var("ANTHROPIC_MODEL")
        && !model.trim().is_empty()
    {
        return Some(model);
    }
    let settings: Value =
        serde_json::from_str(&std::fs::read_to_string(home()?.join("settings.json")).ok()?).ok()?;
    Some(settings.get("model")?.as_str()?.to_owned())
}

/// Claude Code aliases always resolve to the newest model of each family.
pub fn models() -> Vec<ModelOption> {
    alias_models(&[
        ("fable", "Fable"),
        ("opus", "Opus"),
        ("sonnet", "Sonnet"),
        ("haiku", "Haiku"),
    ])
}

/// The prompt is the final positional argument.
pub fn turn_args(
    session_id: Option<&str>,
    model: Option<&str>,
    text: &str,
    bypass: bool,
) -> Vec<String> {
    let mut args: Vec<String> = Vec::new();
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
    args
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
pub fn parse(v: &Value, root: &str, message_id: &str) -> Vec<Parsed> {
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

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn claude_init_is_session_and_noise_is_ignored() {
        let init =
            json!({"type": "system", "subtype": "init", "cwd": "/abs", "session_id": "9578"});
        let out = parse(&init, "/abs", "m1");
        assert!(matches!(out.as_slice(), [Parsed::SessionId(id)] if id == "9578"));

        let hook = json!({"type": "system", "subtype": "hook_started"});
        assert!(parse(&hook, "/abs", "m1").is_empty());
        let rate = json!({"type": "rate_limit_event"});
        assert!(parse(&rate, "/abs", "m1").is_empty());
    }

    #[test]
    fn claude_assistant_text_and_edit() {
        let v = json!({"type": "assistant", "message": {"content": [
            {"type": "text", "text": "hi"},
            {"type": "thinking", "thinking": "..."},
            {"type": "tool_use", "id": "toolu_1", "name": "Edit",
             "input": {"file_path": "/abs/a.css", "old_string": "..", "new_string": ".."}}
        ]}});
        let out = parse(&v, "/abs", "m1");
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
        let out = parse(&v, "/abs", "m1");
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
        let out = parse(&user, "/abs", "m1");
        assert!(matches!(
            out.as_slice(),
            [Parsed::Event(AgentEvent::ToolFinished { tool_id, is_error: true, .. })] if tool_id == "toolu_1"
        ));

        let failed = json!({"type": "result", "subtype": "success", "is_error": true, "result": "Invalid key"});
        let out = parse(&failed, "/abs", "m1");
        assert!(matches!(out.as_slice(), [Parsed::Error(e)] if e == "Invalid key"));

        let ok = json!({"type": "result", "subtype": "success", "is_error": false, "result": "hi"});
        assert!(parse(&ok, "/abs", "m1").is_empty());
    }

    #[test]
    fn claude_args_include_resume_model_and_mode() {
        let args = turn_args(Some("sid"), Some("opus"), "do it", true);
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
}
