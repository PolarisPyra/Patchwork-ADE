//! Codex (`codex app-server`, JSON-RPC over stdio).

use std::path::{Path, PathBuf};

use serde_json::{Value, json};

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

/// `codex app-server` speaks JSON-RPC on stdio; `turn_input` starts the conversation.
pub fn turn_args() -> Vec<String> {
    vec!["app-server".into()]
}

/// Request id of `thread/start` / `thread/resume`; its response carries the thread id.
const THREAD_REQUEST: u64 = 2;

/// Handshake, then start or resume the thread. `turn/start` follows once the thread id is known.
pub fn turn_input(spec: &TurnSpec) -> Vec<String> {
    let mut thread = json!({"cwd": spec.root});
    if let Some(m) = spec.model {
        thread["model"] = json!(m);
    }
    let method = match spec.session_id {
        Some(id) => {
            thread["threadId"] = json!(id);
            thread["excludeTurns"] = json!(true);
            "thread/resume"
        }
        None => "thread/start",
    };
    [
        json!({"id": 1, "method": "initialize", "params": {
            "clientInfo": {"name": "patchwork", "title": "Patchwork", "version": env!("CARGO_PKG_VERSION")}
        }}),
        json!({"method": "initialized"}),
        json!({"id": THREAD_REQUEST, "method": method, "params": thread}),
    ]
    .map(|v| v.to_string())
    .into()
}

/// T3 Code's approval policy and sandbox for each access mode.
fn turn_start(spec: &TurnSpec, thread_id: &str) -> String {
    let (policy, reviewer, sandbox) = match spec.mode {
        AccessMode::Supervised => ("untrusted", "user", "readOnly"),
        AccessMode::AutoAcceptEdits => ("on-request", "user", "workspaceWrite"),
        AccessMode::Auto => ("on-request", "auto_review", "workspaceWrite"),
        AccessMode::FullAccess => ("never", "user", "dangerFullAccess"),
    };
    let mut params = json!({
        "threadId": thread_id,
        "cwd": spec.root,
        "input": [{"type": "text", "text": spec.text}],
        "approvalPolicy": policy,
        "approvalsReviewer": reviewer,
        "sandboxPolicy": {"type": sandbox},
    });
    if let Some(m) = spec.model {
        params["model"] = json!(m);
    }
    json!({"id": THREAD_REQUEST + 1, "method": "turn/start", "params": params}).to_string()
}

pub fn approval_reply(reply: &Value, allow: bool) -> String {
    let decision = if allow { "accept" } else { "decline" };
    json!({"id": reply["id"], "result": {"decision": decision}}).to_string()
}

fn plan_step_status(status: Option<&str>) -> StepStatus {
    match status {
        Some("inProgress") => StepStatus::Running,
        Some("completed") => StepStatus::Done,
        _ => StepStatus::Pending,
    }
}

/// Maps `item/started` / `item/completed`.
fn codex_item(completed: bool, item: &Value, root: &str, message_id: &str, out: &mut Vec<Parsed>) {
    let id = item["id"].as_str().unwrap_or_default();
    let failed = matches!(item["status"].as_str(), Some("failed" | "declined"));
    match item["type"].as_str() {
        Some("agentMessage") if completed => {
            let text = item["text"].as_str().unwrap_or_default();
            if !text.is_empty() {
                out.push(text_delta(message_id, text));
            }
        }
        Some("commandExecution") => {
            let command = item["command"].as_str().unwrap_or_default();
            out.push(tool_started(message_id, id, "Shell", one_line(command)));
            if completed {
                let exit_failed = item["exitCode"].as_i64().is_some_and(|c| c != 0);
                out.push(tool_finished(message_id, id, failed || exit_failed));
            }
        }
        Some("mcpToolCall") => {
            let summary = format!(
                "{}.{}",
                item["server"].as_str().unwrap_or_default(),
                item["tool"].as_str().unwrap_or_default()
            );
            out.push(tool_started(message_id, id, "MCP", summary));
            if completed {
                out.push(tool_finished(message_id, id, failed));
            }
        }
        Some("webSearch") => {
            let query = item["query"].as_str().unwrap_or_default();
            out.push(tool_started(message_id, id, "WebSearch", one_line(query)));
            if completed {
                out.push(tool_finished(message_id, id, false));
            }
        }
        Some("fileChange") => {
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
            if completed {
                if !failed {
                    out.extend(paths.into_iter().map(|p| file_touched(message_id, p)));
                }
                out.push(tool_finished(message_id, id, failed));
            }
        }
        _ => {}
    }
}

/// Maps a request Codex sends us. Approvals wait for the user; anything else is refused.
fn codex_server_request(v: &Value) -> Parsed {
    let params = &v["params"];
    let reason = params["reason"].as_str().filter(|r| !r.is_empty());
    let (title, detail) = match v["method"].as_str() {
        Some("item/commandExecution/requestApproval") => (
            "Run command",
            params["command"].as_str().or(reason).unwrap_or_default(),
        ),
        Some("item/fileChange/requestApproval") => (
            "Edit files",
            reason
                .or(params["grantRoot"].as_str())
                .unwrap_or("Apply the proposed file changes"),
        ),
        _ => {
            return Parsed::Send(
                json!({"id": v["id"], "error": {"code": -32601, "message": "Not supported by Patchwork"}})
                    .to_string(),
            );
        }
    };
    Parsed::Approval {
        title: title.into(),
        detail: one_line(detail),
        reply: json!({"id": v["id"]}),
    }
}

/// Maps one JSON-RPC message from `codex app-server`.
pub fn parse(v: &Value, spec: &TurnSpec, message_id: &str) -> Vec<Parsed> {
    let mut out = Vec::new();
    let params = &v["params"];
    match (v.get("id"), v["method"].as_str()) {
        // A response to one of our requests.
        (Some(id), None) => {
            if let Some(message) = v["error"]["message"].as_str() {
                out.extend([Parsed::Error(message.into()), Parsed::Finished]);
            } else if id == THREAD_REQUEST
                && let Some(thread_id) = v["result"]["thread"]["id"].as_str()
            {
                out.push(Parsed::SessionId(thread_id.into()));
                out.push(Parsed::Send(turn_start(spec, thread_id)));
            }
        }
        (Some(_), Some(_)) => out.push(codex_server_request(v)),
        (None, Some(kind @ ("item/started" | "item/completed"))) => {
            codex_item(
                kind == "item/completed",
                &params["item"],
                spec.root,
                message_id,
                &mut out,
            );
        }
        (None, Some("turn/plan/updated")) => {
            let steps = params["plan"]
                .as_array()
                .into_iter()
                .flatten()
                .map(|step| PlanStep {
                    text: step["step"].as_str().unwrap_or_default().into(),
                    status: plan_step_status(step["status"].as_str()),
                })
                .collect();
            out.push(Parsed::Event(AgentEvent::PlanUpdated {
                message_id: message_id.into(),
                steps,
            }));
        }
        (None, Some("error")) if params["willRetry"] != true => {
            let message = params["error"]["message"]
                .as_str()
                .unwrap_or("Codex reported an error");
            out.push(Parsed::Error(message.into()));
        }
        (None, Some("turn/completed")) => {
            let turn = &params["turn"];
            if turn["status"] == "failed" {
                let message = turn["error"]["message"].as_str().unwrap_or("Turn failed");
                out.push(Parsed::Error(message.into()));
            }
            out.push(Parsed::Finished);
        }
        _ => {}
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn spec(session_id: Option<&'static str>, mode: AccessMode) -> TurnSpec<'static> {
        TurnSpec {
            root: "/abs",
            session_id,
            model: Some("gpt"),
            text: "go",
            mode,
        }
    }

    fn sent(out: &[Parsed]) -> Vec<Value> {
        out.iter()
            .filter_map(|p| match p {
                Parsed::Send(line) => serde_json::from_str(line).ok(),
                _ => None,
            })
            .collect()
    }

    #[test]
    fn codex_starts_or_resumes_then_starts_the_turn() {
        let new: Vec<Value> = turn_input(&spec(None, AccessMode::FullAccess))
            .iter()
            .map(|l| serde_json::from_str(l).unwrap())
            .collect();
        assert_eq!(new[0]["method"], "initialize");
        assert_eq!(new[1]["method"], "initialized");
        assert_eq!(new[2]["method"], "thread/start");
        assert_eq!(new[2]["params"]["cwd"], "/abs");

        let resumed = turn_input(&spec(Some("sid"), AccessMode::FullAccess));
        let resume: Value = serde_json::from_str(&resumed[2]).unwrap();
        assert_eq!(resume["method"], "thread/resume");
        assert_eq!(resume["params"]["threadId"], "sid");

        let response = json!({"id": THREAD_REQUEST, "result": {"thread": {"id": "t1"}}});
        let out = parse(&response, &spec(None, AccessMode::Supervised), "m1");
        assert!(matches!(&out[0], Parsed::SessionId(id) if id == "t1"));
        let turn = &sent(&out)[0];
        assert_eq!(turn["method"], "turn/start");
        assert_eq!(turn["params"]["threadId"], "t1");
        assert_eq!(turn["params"]["input"][0]["text"], "go");
        assert_eq!(turn["params"]["approvalPolicy"], "untrusted");
        assert_eq!(turn["params"]["sandboxPolicy"]["type"], "readOnly");
    }

    #[test]
    fn codex_message_and_command() {
        let spec = spec(None, AccessMode::FullAccess);
        let msg = json!({"method": "item/completed", "params": {"item":
            {"id": "i2", "type": "agentMessage", "text": "hi"}}});
        assert!(matches!(
            parse(&msg, &spec, "m1").as_slice(),
            [Parsed::Event(AgentEvent::TextDelta { text, .. })] if text == "hi"
        ));

        let started = json!({"method": "item/started", "params": {"item": {
            "id": "i3", "type": "commandExecution", "command": "cargo  test", "status": "inProgress"}}});
        assert!(matches!(
            parse(&started, &spec, "m1").as_slice(),
            [Parsed::Event(AgentEvent::ToolStarted { tool, .. })]
                if tool.name == "Shell" && tool.summary == "cargo test"
        ));

        let done = json!({"method": "item/completed", "params": {"item": {
            "id": "i3", "type": "commandExecution", "command": "cargo test",
            "exitCode": 1, "status": "failed"}}});
        assert!(matches!(
            parse(&done, &spec, "m1").last(),
            Some(Parsed::Event(AgentEvent::ToolFinished { tool_id, is_error: true, .. })) if tool_id == "i3"
        ));
    }

    #[test]
    fn codex_file_change_and_plan() {
        let spec = spec(None, AccessMode::FullAccess);
        let change = json!({"method": "item/completed", "params": {"item": {
            "id": "i4", "type": "fileChange", "status": "completed",
            "changes": [{"path": "/abs/src/a.ts", "kind": {"type": "update"}, "diff": ""}]}}});
        let out = parse(&change, &spec, "m1");
        assert!(out.iter().any(
            |p| matches!(p, Parsed::Event(AgentEvent::FileTouched { path, .. }) if path == "src/a.ts")
        ));

        let plan = json!({"method": "turn/plan/updated", "params": {"plan": [
            {"step": "a", "status": "completed"},
            {"step": "b", "status": "inProgress"},
            {"step": "c", "status": "pending"}]}});
        let out = parse(&plan, &spec, "m1");
        let [Parsed::Event(AgentEvent::PlanUpdated { steps, .. })] = out.as_slice() else {
            panic!("no plan");
        };
        let statuses: Vec<_> = steps.iter().map(|s| s.status).collect();
        assert_eq!(
            statuses,
            [StepStatus::Done, StepStatus::Running, StepStatus::Pending]
        );
    }

    #[test]
    fn codex_approvals_and_unsupported_requests() {
        let spec = spec(None, AccessMode::Supervised);
        let request = json!({"id": 7, "method": "item/commandExecution/requestApproval",
            "params": {"itemId": "i1", "threadId": "t", "turnId": "u", "startedAtMs": 0,
                "command": "rm -rf build"}});
        let out = parse(&request, &spec, "m1");
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
        let answer: Value = serde_json::from_str(&approval_reply(reply, false)).unwrap();
        assert_eq!(answer, json!({"id": 7, "result": {"decision": "decline"}}));

        let input = json!({"id": 8, "method": "item/tool/requestUserInput", "params": {}});
        assert_eq!(
            sent(&parse(&input, &spec, "m1"))[0]["error"]["code"],
            -32601
        );
    }

    #[test]
    fn codex_turn_end_and_errors() {
        let spec = spec(None, AccessMode::FullAccess);
        let retrying =
            json!({"method": "error", "params": {"error": {"message": "x"}, "willRetry": true}});
        assert!(parse(&retrying, &spec, "m1").is_empty());

        let failed = json!({"method": "turn/completed", "params": {"turn": {
            "status": "failed", "error": {"message": "usage limit"}}}});
        assert!(matches!(
            parse(&failed, &spec, "m1").as_slice(),
            [Parsed::Error(e), Parsed::Finished] if e == "usage limit"
        ));

        let rejected = json!({"id": 3, "error": {"code": -1, "message": "bad model"}});
        assert!(matches!(
            parse(&rejected, &spec, "m1").as_slice(),
            [Parsed::Error(e), Parsed::Finished] if e == "bad model"
        ));
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
