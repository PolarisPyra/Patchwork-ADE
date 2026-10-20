//! Tauri shell: exposes `patchwork_server::Server` as commands and forwards
//! agent events to the web UI on the `"agent-event"` channel.

use std::sync::Arc;

use patchwork_server::types::*;
use patchwork_server::{Res, Server, persistence, provider};
use tauri::{Emitter, Manager, State};

type Srv<'a> = State<'a, Arc<Server>>;

/// Runs blocking work (CLI probes, network, disk scans) off the main thread.
async fn blocking<T: Send + 'static>(f: impl FnOnce() -> T + Send + 'static) -> Res<T> {
    tauri::async_runtime::spawn_blocking(f)
        .await
        .map_err(|e| e.to_string())
}

// ---- settings & projects -------------------------------------------------

#[tauri::command]
fn get_settings(server: Srv) -> Settings {
    server.store.settings()
}

#[tauri::command]
fn save_settings(server: Srv, settings: Settings) -> Res<()> {
    server.save_settings(settings)
}

#[tauri::command]
fn list_models(kind: AgentKind) -> Vec<ModelOption> {
    provider::list_models(kind)
}

#[tauri::command]
async fn detect_agent(kind: AgentKind) -> AgentStatus {
    blocking(move || provider::detect_agent(kind))
        .await
        .unwrap_or_else(|e| AgentStatus {
            kind,
            installed: false,
            version: None,
            signed_in: false,
            detail: e,
        })
}

#[tauri::command]
/// Cached; `refresh` asks for new numbers, which the server still throttles.
async fn get_usage(server: Srv<'_>, kind: AgentKind, refresh: bool) -> Res<ProviderUsage> {
    let server = server.inner().clone();
    blocking(move || server.usage.get(kind, refresh)).await
}

#[tauri::command]
fn add_project(server: Srv, path: String) -> Res<Project> {
    server.add_project(&path)
}

#[tauri::command]
fn create_project(server: Srv, parent: String, name: String) -> Res<Project> {
    server.create_project(&parent, &name)
}

#[tauri::command]
fn rename_project(server: Srv, id: String, name: String) -> Res<()> {
    server.rename_project(&id, &name)
}

#[tauri::command]
fn rename_thread(server: Srv, id: String, title: String) -> Res<()> {
    server.rename_thread(&id, &title)
}

#[tauri::command]
fn remove_project(server: Srv, id: String) -> Res<()> {
    server.remove_project(&id)
}

// ---- threads & turns -----------------------------------------------------

#[tauri::command]
fn list_threads(server: Srv) -> Vec<Thread> {
    server.list_threads()
}

#[tauri::command]
fn reorder_threads(server: Srv, ids: Vec<String>, folder_id: Option<String>) -> Res<()> {
    server.reorder_threads(&ids, folder_id.as_deref())
}

#[tauri::command]
fn list_folders(server: Srv) -> Vec<Folder> {
    server.list_folders()
}

#[tauri::command]
fn create_folder(server: Srv, project_id: String, name: String) -> Res<Folder> {
    server.create_folder(&project_id, &name)
}

#[tauri::command]
fn rename_folder(server: Srv, id: String, name: String) -> Res<()> {
    server.rename_folder(&id, &name)
}

#[tauri::command]
fn remove_folder(server: Srv, id: String) -> Res<()> {
    server.remove_folder(&id)
}

#[tauri::command]
fn list_files(server: Srv, project_id: String) -> Res<Vec<String>> {
    server.list_files(&project_id)
}

#[tauri::command]
fn antigravity_installed(server: Srv) -> bool {
    server.antigravity_installed()
}

#[tauri::command]
async fn install_antigravity(server: Srv<'_>) -> Res<()> {
    let server = server.inner().clone();
    tauri::async_runtime::spawn_blocking(move || server.install_antigravity())
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
fn clear_thread(server: Srv, id: String) -> Res<()> {
    server.clear_thread(&id)
}

#[tauri::command]
fn get_last_thread(server: Srv) -> Option<String> {
    server.last_thread_id()
}

#[tauri::command]
fn set_last_thread(server: Srv, id: String) -> Res<()> {
    server.set_last_thread_id(&id)
}

#[tauri::command]
fn get_collapsed(server: Srv) -> Vec<String> {
    server.collapsed_sections()
}

#[tauri::command]
fn set_collapsed(server: Srv, ids: Vec<String>) -> Res<()> {
    server.set_collapsed_sections(&ids)
}

#[tauri::command]
fn create_thread(
    server: Srv,
    project_id: Option<String>,
    agent: AgentKind,
    model: Option<String>,
    access_mode: AccessMode,
    effort: Option<String>,
) -> Res<Thread> {
    server.create_thread(project_id, agent, model, access_mode, effort)
}

#[tauri::command]
fn delete_thread(server: Srv, id: String) {
    server.delete_thread(&id)
}

#[tauri::command]
fn set_thread_model(server: Srv, id: String, agent: AgentKind, model: Option<String>) -> Res<()> {
    server.set_thread_model(&id, agent, model)
}

#[tauri::command]
fn set_thread_access_mode(server: Srv, id: String, mode: AccessMode) -> Res<()> {
    server.set_thread_access_mode(&id, mode)
}

#[tauri::command]
fn set_thread_effort(server: Srv, id: String, effort: Option<String>) -> Res<()> {
    server.set_thread_effort(&id, effort)
}

#[tauri::command]
fn send_message(
    server: Srv,
    thread_id: String,
    text: String,
    attachments: Vec<Attachment>,
) -> Res<Message> {
    server.send_message(thread_id, text, attachments)
}

#[tauri::command]
fn attachment_for_path(path: String) -> Res<Attachment> {
    Attachment::from_path(&path)
}

/// Lets the webview load an image for its thumbnail. The asset scope is not kept across restarts,
/// so this runs again whenever a thumbnail is shown.
#[tauri::command]
fn allow_preview(app: tauri::AppHandle, path: String) -> Res<()> {
    app.asset_protocol_scope()
        .allow_file(&path)
        .map_err(|e| e.to_string())
}

#[tauri::command]
fn cancel_turn(server: Srv, thread_id: String) {
    server.cancel_turn(&thread_id)
}

#[tauri::command]
fn stop_subagent(server: Srv, thread_id: String, tool_id: String) -> Res<()> {
    server.stop_subagent(&thread_id, &tool_id)
}

#[tauri::command]
async fn stop_goal(server: Srv<'_>, thread_id: String) -> Res<()> {
    // Waits for the stopped turn to end, so it runs off the main thread.
    let server = server.inner().clone();
    tauri::async_runtime::spawn_blocking(move || server.stop_goal(&thread_id))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
fn respond_approval(server: Srv, thread_id: String, approval_id: String, allow: bool) -> Res<()> {
    server.respond_approval(&thread_id, &approval_id, allow)
}

#[tauri::command]
async fn scan_imports(server: Srv<'_>, kind: ImportSource) -> Res<ImportScan> {
    let server = server.inner().clone();
    blocking(move || server.scan_imports(kind)).await
}

#[tauri::command]
async fn import_threads(server: Srv<'_>, kinds: Vec<ImportSource>) -> Res<u32> {
    let server = server.inner().clone();
    blocking(move || server.import_threads(&kinds)).await?
}

// ---- files & git ---------------------------------------------------------

use patchwork_server::workspace;

#[tauri::command]
fn read_file(server: Srv, project_id: String, path: String) -> Res<String> {
    workspace::read_file(&server.project_root(&project_id)?, &path)
}

#[tauri::command]
fn git_branch(server: Srv, project_id: String) -> Res<Option<String>> {
    Ok(workspace::git_branch(&server.project_root(&project_id)?))
}

#[tauri::command]
fn git_changes(server: Srv, project_id: String) -> Res<Vec<FileChange>> {
    workspace::git_changes(&server.project_root(&project_id)?)
}

#[tauri::command]
fn git_file_diff(server: Srv, project_id: String, path: String) -> Res<String> {
    workspace::git_file_diff(&server.project_root(&project_id)?, &path)
}

#[tauri::command]
fn accept_file(server: Srv, project_id: String, path: String) -> Res<()> {
    workspace::accept_file(&server.project_root(&project_id)?, &path)
}

#[tauri::command]
fn revert_file(server: Srv, project_id: String, path: String) -> Res<()> {
    workspace::revert_file(&server.project_root(&project_id)?, &path)
}

#[tauri::command]
fn open_in_editor(server: Srv, project_id: String, path: String) -> Res<()> {
    workspace::open_in_editor(&server.project_root(&project_id)?, &path)
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
            // Config lives in `~/.config/patchwork` rather than the app-identifier folder.
            let config_dir = app.path().config_dir()?.join("patchwork");
            persistence::adopt_old_dir(&app.path().app_config_dir()?, &config_dir)?;
            let handle = app.handle().clone();
            let server = Server::open(
                config_dir,
                &app.path().app_local_data_dir()?,
                Box::new(move |event| {
                    let _ = handle.emit("agent-event", event);
                }),
            )?;
            server.start_idle_compaction();
            app.manage(server);
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            get_settings,
            save_settings,
            detect_agent,
            list_models,
            get_usage,
            add_project,
            create_project,
            rename_project,
            rename_thread,
            remove_project,
            list_threads,
            reorder_threads,
            list_folders,
            create_folder,
            rename_folder,
            remove_folder,
            list_files,
            antigravity_installed,
            install_antigravity,
            clear_thread,
            get_last_thread,
            set_last_thread,
            get_collapsed,
            set_collapsed,
            create_thread,
            delete_thread,
            set_thread_model,
            set_thread_access_mode,
            set_thread_effort,
            send_message,
            attachment_for_path,
            allow_preview,
            cancel_turn,
            stop_goal,
            stop_subagent,
            respond_approval,
            scan_imports,
            import_threads,
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
