//! Antigravity CLI (`agy -p --output-format stream-json`) when it is installed, else the
//! Gemini CLI (`gemini --output-format stream-json`).

use std::path::PathBuf;

use serde_json::Value;

use super::*;

/// The Antigravity CLI: Patchwork's own install (`patchwork/clis` in the config folder),
/// else `agy` on PATH.
pub fn antigravity_bin() -> Option<PathBuf> {
    let config = if cfg!(target_os = "macos") {
        home_dir().map(|h| h.join("Library/Application Support"))
    } else {
        std::env::var_os("XDG_CONFIG_HOME")
            .map(PathBuf::from)
            .or_else(|| home_dir().map(|h| h.join(".config")))
    };
    config
        .map(|c| c.join("patchwork/clis/agy"))
        .filter(|p| p.is_file())
        .or_else(|| which::which("agy").ok())
}

/// `~/.gemini`.
pub fn home() -> Option<PathBuf> {
    home_dir().map(|h| h.join(".gemini"))
}

fn settings() -> Option<Value> {
    serde_json::from_str(&std::fs::read_to_string(home()?.join("settings.json")).ok()?).ok()
}

fn env_set(name: &str) -> bool {
    std::env::var(name).is_ok_and(|v| !v.trim().is_empty())
}

/// Gemini has no auth-status command, so this checks what the CLI itself reads:
/// an API key in the environment, a Google login, or a configured auth type.
pub fn auth(status: &mut AgentStatus) {
    // Antigravity has no auth-status command or documented credentials file either; a run
    // that is not signed in fails with "authentication required".
    if antigravity_bin().is_some() {
        status.signed_in = true;
        status.detail = "Using the Antigravity CLI — run `agy` once to sign in".into();
        return;
    }
    let selected = settings().and_then(|s| {
        s["security"]["auth"]["selectedType"]
            .as_str()
            .or_else(|| s["selectedAuthType"].as_str())
            .map(String::from)
    });
    let detail = if env_set("GEMINI_API_KEY") {
        Some("Using GEMINI_API_KEY".to_string())
    } else if env_set("GOOGLE_API_KEY") || env_set("GOOGLE_CLOUD_PROJECT") {
        Some("Using Vertex AI credentials".to_string())
    } else if home().is_some_and(|h| h.join("oauth_creds.json").is_file()) {
        Some("Signed in with Google".to_string())
    } else {
        selected.map(|t| format!("Configured for {t}"))
    };
    status.signed_in = detail.is_some();
    status.detail = detail.unwrap_or_else(|| "Not signed in — run `gemini` to log in".into());
}

/// `GEMINI_MODEL`, else the `model` in `~/.gemini/settings.json`.
pub fn configured_model() -> Option<String> {
    if let Ok(model) = std::env::var("GEMINI_MODEL")
        && !model.trim().is_empty()
    {
        return Some(model);
    }
    let s = settings()?;
    s["model"]["name"]
        .as_str()
        .or_else(|| s["model"].as_str())
        .map(String::from)
}

/// Antigravity's models (`agy models` prints `<id>\t<label>` lines), else the Gemini models
/// from the fetched model manifest.
pub fn models() -> Vec<ModelOption> {
    if antigravity_bin().is_none() {
        return model_manifest::models("gemini");
    }
    let listed = probe(AgentKind::Gemini, &["models"])
        .map(|p| p.stdout)
        .unwrap_or_default();
    listed
        .lines()
        .filter_map(|l| l.split_once('\t'))
        .map(|(id, label)| ModelOption {
            id: Some(id.trim().into()),
            label: label.trim().into(),
            default_model: None,
        })
        .collect()
}

/// Gemini runs headless, so "default" cannot ask: actions that need approval are refused.
pub fn turn_args(spec: &TurnSpec) -> Vec<String> {
    if antigravity_bin().is_some() {
        agy_turn_args(spec)
    } else {
        gemini_turn_args(spec)
    }
}

fn gemini_turn_args(spec: &TurnSpec) -> Vec<String> {
    let TurnSpec {
        session_id, model, ..
    } = *spec;
    let mode = match spec.mode {
        AccessMode::FullAccess => "yolo",
        AccessMode::AutoAcceptEdits => "auto_edit",
        AccessMode::Supervised | AccessMode::Auto => "default",
    };
    let mut args: Vec<String> = ["--output-format", "stream-json", "--approval-mode", mode]
        .map(String::from)
        .into();
    if let Some(id) = session_id {
        args.extend(["--resume".to_string(), id.to_string()]);
    }
    if let Some(m) = model {
        args.extend(["--model".to_string(), m.to_string()]);
    }
    // The `=` form keeps a prompt that starts with "-" from being read as a flag.
    args.push(format!("--prompt={}", prompt(spec)));
    args
}

/// Antigravity without a way to ask: in "default" mode, actions that need approval are
/// refused and the run goes on.
fn agy_turn_args(spec: &TurnSpec) -> Vec<String> {
    let mut args: Vec<String> = ["--output-format", "stream-json"].map(String::from).into();
    match spec.mode {
        AccessMode::FullAccess => args.push("--dangerously-skip-permissions".into()),
        AccessMode::AutoAcceptEdits => args.push("--mode=accept-edits".into()),
        AccessMode::Auto => args.push("--mode=auto".into()),
        AccessMode::Supervised => {}
    }
    if let Some(id) = spec.session_id {
        args.push(format!("--conversation={id}"));
    }
    if let Some(m) = spec.model {
        args.push(format!("--model={m}"));
    }
    if let Some(e) = spec.effort {
        args.push(format!("--effort={e}"));
    }
    // The `=` form keeps a prompt that starts with "-" from being read as a flag. Slash
    // commands such as `/goal` are expanded in print mode.
    args.push(format!("--print={}", prompt(spec)));
    args
}

/// Maps one line of the agent's stream-json output. Assistant text arrives as deltas that
/// belong to the same block.
pub fn parse(v: &Value, spec: &TurnSpec, message_id: &str) -> Vec<Parsed> {
    if v.get("event").is_some() {
        return agy_parse(v, spec, message_id);
    }
    let root = spec.root;
    let mut out = Vec::new();
    match v["type"].as_str() {
        Some("init") => {
            if let Some(id) = v["session_id"].as_str() {
                out.push(Parsed::SessionId(id.into()));
            }
        }
        Some("message") if v["role"] == "assistant" => {
            let text = v["content"].as_str().unwrap_or_default();
            if !text.is_empty() {
                out.push(text_delta(message_id, text));
            }
        }
        Some("tool_use") => {
            let id = v["tool_id"].as_str().unwrap_or_default();
            let name = v["tool_name"].as_str().unwrap_or("Tool");
            let params = &v["parameters"];
            out.push(tool_started(
                message_id,
                id,
                name,
                summarize(params, root),
                None,
                None,
            ));
            if matches!(name, "write_file" | "replace" | "edit")
                && let Some(path) = params["file_path"].as_str()
            {
                out.push(file_touched(message_id, relative(root, path)));
            }
        }
        Some("tool_result") => {
            let id = v["tool_id"].as_str().unwrap_or_default();
            out.push(tool_finished(message_id, id, v["status"] == "error"));
        }
        Some("error") if v["severity"] != "warning" => {
            let message = v["message"].as_str().unwrap_or("Antigravity CLI reported an error");
            out.push(Parsed::Error(message.into()));
        }
        Some("result") if v["status"] == "error" => {
            let message = v["error"]["message"].as_str().unwrap_or("Turn failed");
            out.push(Parsed::Error(message.into()));
        }
        _ => {}
    }
    out
}

/// Maps one line of `agy --output-format stream-json`: `init`, then a `step_update` per step
/// transition or text delta, then `result`. Each payload sits under its event's name.
fn agy_parse(v: &Value, spec: &TurnSpec, message_id: &str) -> Vec<Parsed> {
    let mut out = Vec::new();
    match v["event"].as_str() {
        Some("init") => {
            if let Some(id) = v["conversation_id"].as_str().filter(|id| !id.is_empty()) {
                out.push(Parsed::SessionId(id.into()));
            }
            // Antigravity reports nothing about a goal, so one set with `/goal` is taken as set
            // once the run starts.
            if let Some(objective) = goal_objective(spec) {
                out.push(Parsed::Goal(GoalUpdate::Set {
                    objective: objective.into(),
                    checks: None,
                }));
            }
        }
        // A subagent's steps are not part of the reply.
        Some("step_update") if v["step_update"]["subagent_info"].is_null() => {
            let step = &v["step_update"];
            if let Some(text) = step["text_delta"].as_str().filter(|t| !t.is_empty()) {
                out.push(text_delta(message_id, text));
            }
            let tool = &step["tool_info"];
            if let Some(name) = tool["name"].as_str().or_else(|| step["tool_name"].as_str()) {
                let id = format!("step-{}", step["step_index"]);
                let params = &tool["parameters"];
                // Antigravity names a file `Path`.
                let summary = params["Path"].as_str().map_or_else(
                    || summarize(params, spec.root),
                    |path| relative(spec.root, path),
                );
                out.push(tool_started(message_id, &id, name, summary, None, None));
                if step["state"] == "DONE" {
                    let failed = tool["error"].as_str().is_some_and(|e| !e.is_empty());
                    out.push(tool_finished(message_id, &id, failed));
                }
            }
        }
        Some("result") => {
            let result = &v["result"];
            if result["status"] != "SUCCESS" {
                let message = result["error"]
                    .as_str()
                    .filter(|e| !e.is_empty())
                    .or_else(|| result["status"].as_str())
                    .unwrap_or("Turn failed");
                out.push(Parsed::Error(message.into()));
            }
        }
        _ => {}
    }
    out
}

/// The objective of a `/goal <objective>` message.
fn goal_objective<'a>(spec: &TurnSpec<'a>) -> Option<&'a str> {
    if !is_goal_command(spec.text) {
        return None;
    }
    Some(spec.text.trim()["/goal".len()..].trim()).filter(|o| !o.is_empty())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    const SPEC: TurnSpec = TurnSpec {
        root: "/abs",
        session_id: None,
        model: None,
        text: "",
        mode: AccessMode::Supervised,
        effort: None,
        attachments: &[],
        images: &[],
    };

    #[test]
    fn init_message_and_user_echo() {
        let init = json!({"type": "init", "session_id": "s1", "model": "gemini-2.5-pro"});
        assert!(
            matches!(parse(&init, &SPEC, "m").as_slice(), [Parsed::SessionId(id)] if id == "s1")
        );

        let user = json!({"type": "message", "role": "user", "content": "hi"});
        assert!(parse(&user, &SPEC, "m").is_empty());

        let delta =
            json!({"type": "message", "role": "assistant", "content": "Hel", "delta": true});
        assert!(matches!(
            parse(&delta, &SPEC, "m").as_slice(),
            [Parsed::Event(AgentEvent::TextDelta { text, .. })] if text == "Hel"
        ));
    }

    #[test]
    fn tools_and_errors() {
        let tool = json!({"type": "tool_use", "tool_name": "write_file", "tool_id": "t1",
            "parameters": {"file_path": "/abs/a.txt", "content": "hi"}});
        let out = parse(&tool, &SPEC, "m");
        assert!(
            matches!(&out[0], Parsed::Event(AgentEvent::ToolStarted { tool, .. }) if tool.summary == "a.txt")
        );
        assert!(
            matches!(&out[1], Parsed::Event(AgentEvent::FileTouched { path, .. }) if path == "a.txt")
        );

        let result = json!({"type": "tool_result", "tool_id": "t1", "status": "error"});
        assert!(matches!(
            parse(&result, &SPEC, "m").as_slice(),
            [Parsed::Event(AgentEvent::ToolFinished {
                is_error: true,
                ..
            })]
        ));

        let warning = json!({"type": "error", "severity": "warning", "message": "loop"});
        assert!(parse(&warning, &SPEC, "m").is_empty());
        let failed = json!({"type": "result", "status": "error", "error": {"type": "x", "message": "quota"}});
        assert!(
            matches!(parse(&failed, &SPEC, "m").as_slice(), [Parsed::Error(e)] if e == "quota")
        );
        let ok = json!({"type": "result", "status": "success"});
        assert!(parse(&ok, &SPEC, "m").is_empty());
    }

    #[test]
    fn args_resume_and_quote_prompt() {
        assert_eq!(
            gemini_turn_args(&TurnSpec {
                root: "/abs",
                session_id: Some("sid"),
                model: Some("pro"),
                text: "-x",
                mode: AccessMode::AutoAcceptEdits,
                effort: None,
                attachments: &[],
                images: &[],
            }),
            [
                "--output-format",
                "stream-json",
                "--approval-mode",
                "auto_edit",
                "--resume",
                "sid",
                "--model",
                "pro",
                "--prompt=-x",
            ]
        );
    }
}
