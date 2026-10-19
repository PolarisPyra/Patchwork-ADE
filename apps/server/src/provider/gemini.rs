//! Gemini CLI (`gemini --output-format stream-json`).

use std::path::PathBuf;

use serde_json::Value;

use super::*;

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

/// Current Gemini models, from the bundled model manifest.
pub fn models() -> Vec<ModelOption> {
    manifest_models("gemini")
}

pub fn turn_args(
    session_id: Option<&str>,
    model: Option<&str>,
    text: &str,
    bypass: bool,
) -> Vec<String> {
    let mode = if bypass { "yolo" } else { "auto_edit" };
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
    args.push(format!("--prompt={text}"));
    args
}

/// Maps one line of `gemini --output-format stream-json` output. Assistant
/// text arrives as deltas that belong to the same block.
pub fn parse(v: &Value, root: &str, message_id: &str) -> Vec<Parsed> {
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
            out.push(tool_started(message_id, id, name, summarize(params, root)));
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
            let message = v["message"].as_str().unwrap_or("Gemini reported an error");
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

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn init_message_and_user_echo() {
        let init = json!({"type": "init", "session_id": "s1", "model": "gemini-2.5-pro"});
        assert!(
            matches!(parse(&init, "/abs", "m").as_slice(), [Parsed::SessionId(id)] if id == "s1")
        );

        let user = json!({"type": "message", "role": "user", "content": "hi"});
        assert!(parse(&user, "/abs", "m").is_empty());

        let delta =
            json!({"type": "message", "role": "assistant", "content": "Hel", "delta": true});
        assert!(matches!(
            parse(&delta, "/abs", "m").as_slice(),
            [Parsed::Event(AgentEvent::TextDelta { text, .. })] if text == "Hel"
        ));
    }

    #[test]
    fn tools_and_errors() {
        let tool = json!({"type": "tool_use", "tool_name": "write_file", "tool_id": "t1",
            "parameters": {"file_path": "/abs/a.txt", "content": "hi"}});
        let out = parse(&tool, "/abs", "m");
        assert!(
            matches!(&out[0], Parsed::Event(AgentEvent::ToolStarted { tool, .. }) if tool.summary == "a.txt")
        );
        assert!(
            matches!(&out[1], Parsed::Event(AgentEvent::FileTouched { path, .. }) if path == "a.txt")
        );

        let result = json!({"type": "tool_result", "tool_id": "t1", "status": "error"});
        assert!(matches!(
            parse(&result, "/abs", "m").as_slice(),
            [Parsed::Event(AgentEvent::ToolFinished {
                is_error: true,
                ..
            })]
        ));

        let warning = json!({"type": "error", "severity": "warning", "message": "loop"});
        assert!(parse(&warning, "/abs", "m").is_empty());
        let failed = json!({"type": "result", "status": "error", "error": {"type": "x", "message": "quota"}});
        assert!(
            matches!(parse(&failed, "/abs", "m").as_slice(), [Parsed::Error(e)] if e == "quota")
        );
        let ok = json!({"type": "result", "status": "success"});
        assert!(parse(&ok, "/abs", "m").is_empty());
    }

    #[test]
    fn args_resume_and_quote_prompt() {
        assert_eq!(
            turn_args(Some("sid"), Some("pro"), "-x", false),
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
