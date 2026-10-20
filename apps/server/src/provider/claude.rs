//! Claude Code (`claude -p` with stream-json input and output).

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

/// Current Claude models, from the fetched model manifest.
pub fn models() -> Vec<ModelOption> {
    model_manifest::models("claude")
}

/// The prompt is sent on stdin (`user_message`), so approvals can be answered there too.
pub fn turn_args(spec: &TurnSpec) -> Vec<String> {
    let mode = match spec.mode {
        AccessMode::Supervised => "default",
        AccessMode::AutoAcceptEdits => "acceptEdits",
        AccessMode::Auto => "auto",
        AccessMode::FullAccess => "bypassPermissions",
    };
    let mut args: Vec<String> = [
        "-p",
        "--input-format",
        "stream-json",
        "--output-format",
        "stream-json",
        "--verbose",
        "--permission-mode",
        mode,
    ]
    .map(String::from)
    .into();
    if spec.mode != AccessMode::FullAccess {
        // Permission checks arrive as `can_use_tool` control requests on stdout.
        args.extend(["--permission-prompt-tool".to_string(), "stdio".to_string()]);
    }
    if let Some(id) = spec.session_id {
        args.extend(["--resume".to_string(), id.to_string()]);
    }
    if let Some(m) = spec.model {
        args.extend(["--model".to_string(), m.to_string()]);
    }
    args
}

/// The stream-json input line carrying the prompt and any attached images.
pub fn user_message(text: &str, images: &[Image]) -> String {
    let mut content = vec![serde_json::json!({"type": "text", "text": text})];
    content.extend(images.iter().map(|i| {
        serde_json::json!({
            "type": "image",
            "source": {"type": "base64", "media_type": i.media_type, "data": i.data}
        })
    }));
    serde_json::json!({
        "type": "user",
        "message": {"role": "user", "content": content},
        "parent_tool_use_id": null,
        "session_id": "",
    })
    .to_string()
}

pub fn approval_reply(reply: &Value, allow: bool) -> String {
    let decision = if allow {
        serde_json::json!({"behavior": "allow", "updatedInput": reply["input"]})
    } else {
        serde_json::json!({"behavior": "deny", "message": "The user denied this action."})
    };
    serde_json::json!({
        "type": "control_response",
        "response": {
            "subtype": "success",
            "request_id": reply["request_id"],
            "response": decision,
        },
    })
    .to_string()
}

/// A `can_use_tool` request becomes an approval; other control requests are refused.
fn claude_control_request(v: &Value, root: &str) -> Parsed {
    let request = &v["request"];
    if request["subtype"] != "can_use_tool" {
        return Parsed::Send(
            serde_json::json!({
                "type": "control_response",
                "response": {
                    "subtype": "error",
                    "request_id": v["request_id"],
                    "error": "Not supported by Patchwork",
                },
            })
            .to_string(),
        );
    }
    let tool = request["tool_name"].as_str().unwrap_or("a tool");
    let title = match tool {
        "Bash" => "Run command".to_string(),
        "Edit" | "Write" | "MultiEdit" | "NotebookEdit" => "Edit file".to_string(),
        _ => format!("Use {}", request["display_name"].as_str().unwrap_or(tool)),
    };
    let mut detail = summarize(&request["input"], root);
    if detail.is_empty() {
        detail = one_line(request["description"].as_str().unwrap_or_default());
    }
    Parsed::Approval {
        title,
        detail,
        reply: serde_json::json!({"request_id": v["request_id"], "input": request["input"]}),
    }
}

fn claude_step_status(status: Option<&str>) -> StepStatus {
    match status {
        Some("in_progress") => StepStatus::Running,
        Some("completed") => StepStatus::Done,
        _ => StepStatus::Pending,
    }
}

/// Task calls carry a `subagent_type`; that is what starts a subagent.
fn subagent_of(input: &Value) -> Option<SubAgent> {
    Some(SubAgent {
        kind: input["subagent_type"].as_str()?.into(),
        description: input["description"].as_str().unwrap_or_default().into(),
        model: input["model"].as_str().map(String::from),
    })
}

fn claude_tool_use(
    block: &Value,
    root: &str,
    message_id: &str,
    parent: Option<&str>,
    out: &mut Vec<Parsed>,
) {
    let id = block["id"].as_str().unwrap_or_default();
    let name = block["name"].as_str().unwrap_or("Tool");
    let input = &block["input"];
    out.push(tool_started(
        message_id,
        id,
        name,
        summarize(input, root),
        subagent_of(input),
        parent,
    ));

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
    // Messages from inside a subagent name the Agent call they belong to.
    let parent = v["parent_tool_use_id"].as_str();
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
                    Some("tool_use") => claude_tool_use(block, root, message_id, parent, &mut out),
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
            out.push(Parsed::Finished);
        }
        Some("control_request") => out.push(claude_control_request(v, root)),
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
        assert!(
            matches!(out.as_slice(), [Parsed::Error(e), Parsed::Finished] if e == "Invalid key")
        );

        let ok = json!({"type": "result", "subtype": "success", "is_error": false, "result": "hi"});
        assert!(matches!(
            parse(&ok, "/abs", "m1").as_slice(),
            [Parsed::Finished]
        ));
    }

    #[test]
    fn claude_permission_request_round_trip() {
        let request = json!({"type": "control_request", "request_id": "r1", "request": {
            "subtype": "can_use_tool", "tool_name": "Bash", "display_name": "Bash",
            "input": {"command": "rm -rf build"}}});
        let out = parse(&request, "/abs", "m1");
        let [
            Parsed::Approval {
                title,
                detail,
                reply,
            },
        ] = out.as_slice()
        else {
            panic!("{out:?}");
        };
        assert_eq!(
            (title.as_str(), detail.as_str()),
            ("Run command", "rm -rf build")
        );

        let allow: Value = serde_json::from_str(&approval_reply(reply, true)).unwrap();
        assert_eq!(allow["response"]["request_id"], "r1");
        assert_eq!(allow["response"]["response"]["behavior"], "allow");
        assert_eq!(
            allow["response"]["response"]["updatedInput"]["command"],
            "rm -rf build"
        );
        let deny: Value = serde_json::from_str(&approval_reply(reply, false)).unwrap();
        assert_eq!(deny["response"]["response"]["behavior"], "deny");

        let other = json!({"type": "control_request", "request_id": "r2",
            "request": {"subtype": "hook_callback"}});
        let out = parse(&other, "/abs", "m1");
        assert!(matches!(out.as_slice(), [Parsed::Send(line)] if line.contains("\"error\"")));
    }

    #[test]
    fn claude_args_include_resume_model_and_mode() {
        let mut spec = TurnSpec {
            root: "/abs",
            session_id: Some("sid"),
            model: Some("opus"),
            text: "do it",
            mode: AccessMode::FullAccess,
            attachments: &[],
            images: &[],
        };
        assert_eq!(
            turn_args(&spec),
            [
                "-p",
                "--input-format",
                "stream-json",
                "--output-format",
                "stream-json",
                "--verbose",
                "--permission-mode",
                "bypassPermissions",
                "--resume",
                "sid",
                "--model",
                "opus",
            ]
        );
        spec.mode = AccessMode::Supervised;
        let args = turn_args(&spec);
        assert!(
            args.windows(2)
                .any(|w| w == ["--permission-mode", "default"])
        );
        assert!(
            args.windows(2)
                .any(|w| w == ["--permission-prompt-tool", "stdio"])
        );
    }
}
