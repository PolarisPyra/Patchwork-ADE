mod runner;
mod store;
mod types;
mod workspace;

use tauri::{Manager, State};

use runner::Runner;
use store::Store;
use types::*;

type Res<T> = Result<T, String>;

fn project_root(store: &Store, project_id: &str) -> Res<String> {
    store
        .settings()
        .projects
        .into_iter()
        .find(|p| p.id == project_id)
        .map(|p| p.path)
        .ok_or_else(|| format!("unknown project {project_id}"))
}

// ---- settings & projects -------------------------------------------------

#[tauri::command]
fn get_settings(store: State<Store>) -> Settings {
    store.settings()
}

#[tauri::command]
fn save_settings(store: State<Store>, settings: Settings) -> Res<()> {
    store.update_settings(|s| *s = settings)
}

#[tauri::command]
fn list_models(kind: AgentKind) -> Vec<ModelOption> {
    workspace::list_models(kind)
}

#[tauri::command]
async fn detect_agent(kind: AgentKind) -> AgentStatus {
    tauri::async_runtime::spawn_blocking(move || workspace::detect_agent(kind))
        .await
        .unwrap_or_else(|e| AgentStatus {
            kind,
            installed: false,
            version: None,
            signed_in: false,
            detail: e.to_string(),
        })
}

fn register_project(store: &Store, project: Project) -> Res<Project> {
    store.update_settings(|s| {
        let p = match s.projects.iter().find(|p| p.path == project.path) {
            Some(existing) => existing.clone(),
            None => {
                s.projects.push(project.clone());
                project
            }
        };
        s.active_project_id = Some(p.id.clone());
        p
    })
}

#[tauri::command]
fn add_project(store: State<Store>, path: String) -> Res<Project> {
    let project = workspace::make_project(&path)?;
    register_project(&store, project)
}

#[tauri::command]
fn create_project(store: State<Store>, parent: String, name: String) -> Res<Project> {
    let project = workspace::create_project_dir(&parent, &name)?;
    register_project(&store, project)
}

#[tauri::command]
fn remove_project(store: State<Store>, id: String) -> Res<()> {
    store.update_settings(|s| {
        s.projects.retain(|p| p.id != id);
        if s.active_project_id.as_deref() == Some(&id) {
            s.active_project_id = s.projects.first().map(|p| p.id.clone());
        }
    })?;
    store.update_threads(|ts| ts.retain(|t| t.project_id.as_deref() != Some(&id)))
}

// ---- threads & turns -----------------------------------------------------

#[tauri::command]
/// Every thread (project tasks and project-less chats), newest first.
fn list_threads(store: State<Store>) -> Vec<Thread> {
    let mut ts = store.threads();
    ts.sort_by_key(|t| std::cmp::Reverse(t.created_at));
    ts
}

#[tauri::command]
fn create_thread(
    store: State<Store>,
    project_id: Option<String>,
    agent: AgentKind,
    model: Option<String>,
) -> Res<Thread> {
    if let Some(id) = &project_id {
        project_root(&store, id)?;
    }
    let title = if project_id.is_some() {
        "New task"
    } else {
        "New chat"
    };
    let thread = Thread {
        id: new_id(),
        project_id,
        title: title.into(),
        agent,
        model,
        session_id: None,
        created_at: now_ms(),
        messages: vec![],
    };
    let t = thread.clone();
    store.update_threads(|ts| ts.push(t))?;
    Ok(thread)
}

#[tauri::command]
fn delete_thread(
    app: tauri::AppHandle,
    store: State<Store>,
    runner: State<Runner>,
    id: String,
) -> Res<()> {
    runner.cancel(&id);
    if store.thread(&id).is_some_and(|t| t.project_id.is_none()) {
        let _ = std::fs::remove_dir_all(runner::chat_dir(&app, &id)?);
    }
    store.update_threads(|ts| ts.retain(|t| t.id != id))
}

#[tauri::command]
/// Sets the thread's model. The agent can only change before the first message,
/// since the conversation session belongs to one CLI.
fn set_thread_model(
    store: State<Store>,
    id: String,
    agent: AgentKind,
    model: Option<String>,
) -> Res<()> {
    let thread = store.thread(&id).ok_or("Task not found")?;
    if thread.agent != agent && !thread.messages.is_empty() {
        return Err("The agent can't change after the conversation has started".into());
    }
    store.update_thread(&id, |t| {
        t.agent = agent;
        t.model = model;
    })
}

/// Appends the user message, then starts the agent turn in the background.
/// Returns the stored user message; assistant output arrives via `agent-event`.
#[tauri::command]
fn send_message(
    app: tauri::AppHandle,
    store: State<Store>,
    runner: State<Runner>,
    thread_id: String,
    text: String,
) -> Res<Message> {
    if runner.is_running(&thread_id) {
        return Err("A turn is already running in this task".into());
    }
    let msg = Message {
        id: new_id(),
        role: Role::User,
        text: text.clone(),
        created_at: now_ms(),
        status: MessageStatus::Complete,
        tools: vec![],
        plan: vec![],
        files: vec![],
        error: None,
    };
    let m = msg.clone();
    store.update_thread(&thread_id, |t| {
        if t.messages.is_empty() {
            let line = text.lines().next().unwrap_or("").trim();
            t.title = line.chars().take(60).collect();
        }
        t.messages.push(m);
    })?;
    runner.start_turn(app, thread_id, text)?;
    Ok(msg)
}

#[tauri::command]
fn cancel_turn(runner: State<Runner>, thread_id: String) {
    runner.cancel(&thread_id);
}

// ---- files & git ---------------------------------------------------------

#[tauri::command]
fn read_file(store: State<Store>, project_id: String, path: String) -> Res<String> {
    workspace::read_file(&project_root(&store, &project_id)?, &path)
}

#[tauri::command]
fn git_branch(store: State<Store>, project_id: String) -> Res<Option<String>> {
    Ok(workspace::git_branch(&project_root(&store, &project_id)?))
}

#[tauri::command]
fn git_changes(store: State<Store>, project_id: String) -> Res<Vec<FileChange>> {
    workspace::git_changes(&project_root(&store, &project_id)?)
}

#[tauri::command]
fn git_file_diff(store: State<Store>, project_id: String, path: String) -> Res<String> {
    workspace::git_file_diff(&project_root(&store, &project_id)?, &path)
}

#[tauri::command]
fn accept_file(store: State<Store>, project_id: String, path: String) -> Res<()> {
    workspace::accept_file(&project_root(&store, &project_id)?, &path)
}

#[tauri::command]
fn revert_file(store: State<Store>, project_id: String, path: String) -> Res<()> {
    workspace::revert_file(&project_root(&store, &project_id)?, &path)
}

#[tauri::command]
fn open_in_editor(store: State<Store>, project_id: String, path: String) -> Res<()> {
    workspace::open_in_editor(&project_root(&store, &project_id)?, &path)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            if cfg!(debug_assertions) {
                app.handle().plugin(
                    tauri_plugin_log::Builder::default()
                        .level(log::LevelFilter::Info)
                        .build(),
                )?;
            }
            let dir = app.path().app_config_dir()?;
            app.manage(Store::open(dir));
            app.manage(Runner::default());
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            get_settings,
            save_settings,
            detect_agent,
            list_models,
            add_project,
            create_project,
            remove_project,
            list_threads,
            create_thread,
            delete_thread,
            set_thread_model,
            send_message,
            cancel_turn,
            read_file,
            git_branch,
            git_changes,
            git_file_diff,
            accept_file,
            revert_file,
            open_in_editor,
        ])
        .run(tauri::generate_context!())
        .expect("error while running Patchwork");
}
