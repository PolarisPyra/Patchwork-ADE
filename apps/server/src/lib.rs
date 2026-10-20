//! Patchwork's backend. The desktop shell exposes these methods as Tauri
//! commands and forwards agent events to the UI.

pub mod import;
pub mod persistence;
pub mod provider;
mod runner;
mod time;
pub mod types;
pub mod usage;
pub mod workspace;

use std::path::{Path, PathBuf};
use std::sync::Arc;

use persistence::Store;
use runner::{Delivery, Runner};
use types::*;

pub type Res<T> = Result<T, String>;

/// Receives every agent event, e.g. to forward it to the UI.
pub type EventSink = Box<dyn Fn(AgentEventEnvelope) + Send + Sync>;

pub struct Server {
    pub store: Store,
    pub usage: usage::UsageCache,
    runner: Runner,
    /// Parent of the scratch folders that project-less chats run in.
    chats_dir: PathBuf,
    /// Where Patchwork installs agent CLIs (`clis` under the config folder).
    clis_dir: PathBuf,
    sink: EventSink,
}

/// Trims a user-entered name; blank names are refused.
/// `app_state` key for the thread the user had open last.
const LAST_THREAD_KEY: &str = "last_thread_id";
/// `app_state` key for the projects and folders the sidebar has collapsed (JSON array).
const COLLAPSED_KEY: &str = "collapsed_sections";

fn clean_name(name: &str) -> Res<String> {
    let name = name.trim();
    if name.is_empty() {
        return Err("Name can't be empty".into());
    }
    Ok(name.chars().take(120).collect())
}

/// A thread title from the first line of a message.
pub fn title_from(text: &str) -> String {
    let line = text.lines().next().unwrap_or("").trim();
    line.chars().take(60).collect()
}

impl Server {
    /// `config_dir` holds the database and config files; `data_dir` holds chat scratch folders.
    pub fn open(config_dir: PathBuf, data_dir: &Path, sink: EventSink) -> Res<Arc<Self>> {
        provider::model_manifest::start(&config_dir);
        let clis_dir = config_dir.join("clis");
        Ok(Arc::new(Self {
            store: Store::open(config_dir)?,
            usage: usage::UsageCache::default(),
            runner: Runner::default(),
            chats_dir: data_dir.join("chats"),
            clis_dir,
            sink,
        }))
    }

    fn emit(&self, event: AgentEventEnvelope) {
        (self.sink)(event);
    }

    /// Whether the Antigravity CLI (`agy`) is installed in Patchwork's CLI folder.
    pub fn antigravity_installed(&self) -> bool {
        self.clis_dir.join("agy").is_file()
    }

    /// Downloads Antigravity's install script to a file, then runs it into Patchwork's CLI
    /// folder. The script is saved first, so the file that runs is the one that was fetched.
    pub fn install_antigravity(&self) -> Res<()> {
        if cfg!(windows) {
            return Err("Setting up the Antigravity CLI from Patchwork is for macOS and Linux for now.".into());
        }
        std::fs::create_dir_all(&self.clis_dir).map_err(|e| e.to_string())?;
        let script = self.clis_dir.join("install-antigravity.sh");
        let fetch = std::process::Command::new("curl")
            .args(["-fsSL", "https://antigravity.google/cli/install.sh", "-o"])
            .arg(&script)
            .output()
            .map_err(|e| format!("Could not run curl: {e}"))?;
        if !fetch.status.success() {
            return Err(format!(
                "Download failed: {}",
                String::from_utf8_lossy(&fetch.stderr).trim()
            ));
        }
        let run = std::process::Command::new("bash")
            .arg(&script)
            .arg("--dir")
            .arg(&self.clis_dir)
            .output()
            .map_err(|e| format!("Could not run the installer: {e}"))?;
        let _ = std::fs::remove_file(&script);
        if !run.status.success() || !self.antigravity_installed() {
            return Err(format!(
                "The install did not finish: {}",
                String::from_utf8_lossy(&run.stderr).trim()
            ));
        }
        Ok(())
    }

    /// Scratch working directory for a chat that has no project.
    pub fn chat_dir(&self, thread_id: &str) -> PathBuf {
        self.chats_dir.join(thread_id)
    }

    pub fn project_root(&self, project_id: &str) -> Res<String> {
        self.store
            .settings()
            .projects
            .into_iter()
            .find(|p| p.id == project_id)
            .map(|p| p.path)
            .ok_or_else(|| format!("unknown project {project_id}"))
    }

    // ---- settings & projects ---------------------------------------------

    pub fn save_settings(&self, settings: Settings) -> Res<()> {
        self.store.update_settings(|s| *s = settings)
    }

    /// Adds `project` unless its path is already registered; returns the stored one.
    fn register_project(&self, project: Project, activate: bool) -> Res<Project> {
        self.store.update_settings(|s| {
            let p = match s.projects.iter().find(|p| p.path == project.path) {
                Some(existing) => existing.clone(),
                None => {
                    s.projects.push(project.clone());
                    project
                }
            };
            if activate {
                s.active_project_id = Some(p.id.clone());
            }
            p
        })
    }

    pub fn add_project(&self, path: &str) -> Res<Project> {
        self.register_project(workspace::make_project(path)?, true)
    }

    pub fn create_project(&self, parent: &str, name: &str) -> Res<Project> {
        self.register_project(workspace::create_project_dir(parent, name)?, true)
    }

    pub fn rename_project(&self, id: &str, name: &str) -> Res<()> {
        let name = clean_name(name)?;
        self.store.update_settings(|s| {
            let project = s.projects.iter_mut().find(|p| p.id == id);
            project.ok_or_else(|| format!("unknown project {id}"))?.name = name;
            Ok::<_, String>(())
        })?
    }

    pub fn remove_project(&self, id: &str) -> Res<()> {
        self.store.update_settings(|s| {
            s.projects.retain(|p| p.id != id);
            if s.active_project_id.as_deref() == Some(id) {
                s.active_project_id = s.projects.first().map(|p| p.id.clone());
            }
        })?;
        self.store.delete_project_threads(id)
    }

    // ---- threads & turns -------------------------------------------------

    /// Every thread (project tasks and project-less chats), in sidebar order.
    pub fn list_threads(&self) -> Vec<Thread> {
        let mut ts = self.store.threads();
        ts.sort_by_key(|t| t.position);
        ts
    }

    /// Puts `ids` in `folder_id` (None: the top level) in their new order.
    pub fn reorder_threads(&self, ids: &[String], folder_id: Option<&str>) -> Res<()> {
        if let Some(folder_id) = folder_id {
            self.folder(folder_id)?;
        }
        self.store.reorder_threads(ids, folder_id)
    }

    /// Files of a project that a mention can refer to.
    pub fn list_files(&self, project_id: &str) -> Res<Vec<String>> {
        workspace::list_files(&self.project_root(project_id)?)
    }

    /// The thread that was open when the app last closed, if one was recorded.
    pub fn last_thread_id(&self) -> Option<String> {
        self.store.state(LAST_THREAD_KEY)
    }

    pub fn set_last_thread_id(&self, id: &str) -> Res<()> {
        self.store.set_state(LAST_THREAD_KEY, id)
    }

    /// Ids of the projects and folders that were collapsed in the sidebar.
    pub fn collapsed_sections(&self) -> Vec<String> {
        self.store
            .state(COLLAPSED_KEY)
            .and_then(|json| serde_json::from_str(&json).ok())
            .unwrap_or_default()
    }

    pub fn set_collapsed_sections(&self, ids: &[String]) -> Res<()> {
        let json = serde_json::to_string(ids).map_err(|e| e.to_string())?;
        self.store.set_state(COLLAPSED_KEY, &json)
    }

    // ---- folders ---------------------------------------------------------

    pub fn list_folders(&self) -> Vec<Folder> {
        self.store.folders()
    }

    fn folder(&self, id: &str) -> Res<Folder> {
        self.store
            .folders()
            .into_iter()
            .find(|f| f.id == id)
            .ok_or_else(|| format!("unknown folder {id}"))
    }

    pub fn create_folder(&self, project_id: &str, name: &str) -> Res<Folder> {
        self.project_root(project_id)?;
        let folder = Folder {
            id: new_id(),
            project_id: project_id.into(),
            name: clean_name(name)?,
        };
        self.store.create_folder(folder.clone())?;
        Ok(folder)
    }

    pub fn rename_folder(&self, id: &str, name: &str) -> Res<()> {
        let name = clean_name(name)?;
        self.folder(id)?;
        self.store.rename_folder(id, &name)
    }

    /// Its tasks move to the project's top level.
    pub fn remove_folder(&self, id: &str) -> Res<()> {
        self.folder(id)?;
        self.store.delete_folder(id)
    }

    pub fn create_thread(
        &self,
        project_id: Option<String>,
        agent: AgentKind,
        model: Option<String>,
        access_mode: AccessMode,
        effort: Option<String>,
    ) -> Res<Thread> {
        if let Some(id) = &project_id {
            self.project_root(id)?;
        }
        let title = if project_id.is_some() {
            "New task"
        } else {
            "New chat"
        };
        let created_at = now_ms();
        let thread = Thread {
            id: new_id(),
            project_id,
            title: title.into(),
            agent,
            model,
            access_mode,
            effort,
            session_id: None,
            created_at,
            messages: vec![],
            goal: None,
            position: -(created_at as i64),
            folder_id: None,
        };
        self.store.insert_threads(vec![thread.clone()])?;
        Ok(thread)
    }

    pub fn rename_thread(&self, id: &str, title: &str) -> Res<()> {
        let title = clean_name(title)?;
        self.store.thread(id).ok_or("Task not found")?;
        self.store.update_thread(id, |t| t.title = title)
    }

    pub fn delete_thread(&self, id: &str) {
        self.runner.cancel(id, None);
        if self
            .store
            .thread(id)
            .is_some_and(|t| t.project_id.is_none())
        {
            let _ = std::fs::remove_dir_all(self.chat_dir(id));
        }
        if let Err(e) = self.store.delete_thread(id) {
            log::warn!("failed to delete thread: {e}");
        }
    }

    /// Sets the thread's model. The agent can only change before the first message,
    /// since the conversation session belongs to one CLI.
    pub fn set_thread_model(&self, id: &str, agent: AgentKind, model: Option<String>) -> Res<()> {
        let thread = self.store.thread(id).ok_or("Task not found")?;
        if thread.agent != agent && !thread.messages.is_empty() {
            return Err("The agent can't change after the conversation has started".into());
        }
        self.store.update_thread(id, |t| {
            t.agent = agent;
            t.model = model;
        })
    }

    /// Takes effect from the thread's next turn.
    pub fn set_thread_access_mode(&self, id: &str, mode: AccessMode) -> Res<()> {
        self.store.update_thread(id, |t| t.access_mode = mode)
    }

    /// Takes effect from the thread's next turn.
    pub fn set_thread_effort(&self, id: &str, effort: Option<String>) -> Res<()> {
        self.store.update_thread(id, |t| t.effort = effort)
    }

    /// Appends the user message, then starts the agent turn in the background.
    /// Returns the stored user message; assistant output arrives via the event sink.
    pub fn send_message(
        self: &Arc<Self>,
        thread_id: String,
        text: String,
        attachments: Vec<Attachment>,
    ) -> Res<Message> {
        let images = provider::load_images(&attachments)?;
        if provider::is_goal_command(&text) {
            if self.runner.is_running(&thread_id) {
                return Err(
                    "A /goal command runs as a turn of its own; send it once this turn ends".into(),
                );
            }
            let agent = self.store.thread(&thread_id).map(|t| t.agent);
            let arg = text.trim()["/goal".len()..].trim().to_lowercase();
            if agent == Some(AgentKind::Gemini) {
                if provider::gemini::antigravity_bin().is_none() {
                    return Err("/goal needs the Antigravity CLI; the Gemini CLI has no /goal. Install it in Settings.".into());
                }
                // Antigravity's /goal only sets a goal, so any other word would become one.
                let subcommands = [
                    "", "pause", "resume", "clear", "stop", "off", "reset", "none", "cancel",
                ];
                if subcommands.contains(&arg.as_str()) {
                    return Err("Antigravity's /goal only sets a goal: /goal <objective>. Stop a goal with the stop button.".into());
                }
            }
            // Claude would take either word as a new goal it can never meet, and loop on it.
            if agent == Some(AgentKind::Claude) && matches!(arg.as_str(), "pause" | "resume") {
                return Err(format!(
                    "Claude has no /goal {arg}. Send a message to carry on with the goal, or /goal clear to drop it."
                ));
            }
        }
        let mut msg = Message {
            id: new_id(),
            role: Role::User,
            text: text.clone(),
            created_at: now_ms(),
            status: MessageStatus::Complete,
            tools: vec![],
            plan: vec![],
            files: vec![],
            error: None,
            approvals: vec![],
            attachments: attachments.clone(),
            steer: false,
            thinking: String::new(),
            finished_at: None,
        };
        // Stored before the agent sees it, so its answer is stored after it.
        let m = msg.clone();
        let mut session_id = None;
        self.store.update_thread(&thread_id, |t| {
            if t.messages.is_empty() {
                t.title = title_from(&text);
            }
            t.messages.push(m);
            session_id = t.session_id.clone();
        })?;
        // While a turn runs, the message steers it, or waits for it to end when the
        // agent cannot take it now.
        match self.runner.steer(
            &thread_id,
            session_id.as_deref(),
            &text,
            &attachments,
            &images,
        ) {
            Delivery::Steered => {
                msg.steer = true;
                self.store.update_thread(&thread_id, |t| {
                    if let Some(m) = t.messages.iter_mut().find(|m| m.id == msg.id) {
                        m.steer = true;
                    }
                })?;
            }
            Delivery::Queued => {}
            Delivery::NotRunning => {
                self.runner
                    .start_turn(self, thread_id, text, attachments, images)?
            }
        }
        Ok(msg)
    }

    /// Stops the running turn. Codex is first told to pause the goal it is pursuing,
    /// so it does not carry on with it later.
    pub fn cancel_turn(&self, thread_id: &str) {
        let pause = self.store.thread(thread_id).and_then(|t| {
            let active = t.goal.is_some_and(|g| g.status == GoalStatus::Active);
            provider::goal_pause(t.agent, t.session_id.as_deref()?).filter(|_| active)
        });
        self.runner.cancel(thread_id, pause);
    }

    pub fn stop_subagent(&self, thread_id: &str, tool_id: &str) -> Res<()> {
        self.runner.stop_subagent(thread_id, tool_id)
    }

    /// Clears a chat: any running turn is cancelled, then its messages and agent session are
    /// deleted. The chat stays in the sidebar, empty.
    pub fn clear_thread(&self, thread_id: &str) -> Res<()> {
        self.cancel_turn(thread_id);
        self.store.clear_thread(thread_id)
    }

    /// Stops the turn working on the goal, if any, and clears the goal, in the agent's session
    /// too: Claude restores an unmet goal whenever its session resumes, Codex keeps a stopped
    /// goal paused, and Antigravity keeps a goal per conversation, so each would otherwise
    /// pick it up again.
    pub fn stop_goal(self: &Arc<Self>, thread_id: &str) -> Res<()> {
        let Some(thread) = self.store.thread(thread_id) else {
            return Ok(());
        };
        let status = thread.goal.map(|g| g.status);
        // Only a goal still being pursued stops the turn it runs in. Clearing a finished goal
        // must not cut off an unrelated reply that is streaming.
        if status == Some(GoalStatus::Active) {
            self.cancel_turn(thread_id);
            // A `/goal` command runs as a turn of its own, so the stopped turn must end first.
            let deadline = std::time::Instant::now() + std::time::Duration::from_secs(10);
            while self.runner.is_running(thread_id) && std::time::Instant::now() < deadline {
                std::thread::sleep(std::time::Duration::from_millis(100));
            }
        }
        self.store.update_thread(thread_id, |t| t.goal = None)?;
        self.emit(AgentEventEnvelope {
            thread_id: thread_id.into(),
            event: AgentEvent::GoalUpdated { goal: None },
        });
        // Claude has already dropped a goal its evaluator judged impossible (blocked).
        let unfinished = status.is_some_and(|s| {
            s != GoalStatus::Complete
                && !(thread.agent == AgentKind::Claude && s == GoalStatus::Blocked)
        });
        if unfinished && thread.session_id.is_some() {
            // Antigravity has no command to clear a goal; its docs say to ask the agent.
            let stop = match thread.agent {
                AgentKind::Gemini => "Stop the current goal.",
                _ => "/goal clear",
            };
            self.send_message(thread_id.into(), stop.into(), vec![])?;
        }
        Ok(())
    }

    /// Answers a pending approval in the thread's running turn.
    pub fn respond_approval(
        self: &Arc<Self>,
        thread_id: &str,
        approval_id: &str,
        allow: bool,
    ) -> Res<()> {
        self.runner.respond(self, thread_id, approval_id, allow)
    }

    // ---- importing conversations ------------------------------------------

    /// Sessions `source` saved on disk that can be imported: ones whose folder
    /// still exists, that Patchwork did not run as a chat, and whose
    /// `(agent, session)` is not in `known`. Returns (found, importable).
    fn importable(
        &self,
        source: ImportSource,
        known: &[(AgentKind, String)],
    ) -> (u32, u32, Vec<import::Session>) {
        let all = import::sessions(source);
        let subagents = all.iter().filter(|s| s.subagent).count() as u32;
        // Patchwork's own chats are not the user's imports, so they are not counted.
        let all: Vec<_> = all
            .into_iter()
            .filter(|s| !s.subagent && !Path::new(&s.cwd).starts_with(&self.chats_dir))
            .collect();
        let found = all.len() as u32;
        let new = all
            .into_iter()
            .filter(|s| {
                !known
                    .iter()
                    .any(|(a, id)| *a == s.agent && *id == s.session_id)
            })
            .collect();
        (found, subagents, new)
    }

    pub fn scan_imports(&self, source: ImportSource) -> ImportScan {
        let (found, subagents, new) = self.importable(source, &self.store.session_keys());
        ImportScan {
            kind: source,
            found,
            new: new.len() as u32,
            subagents,
        }
    }

    /// Imports new sessions as threads in the project for their folder, adding
    /// the project if needed. A conversation found by more than one source (a
    /// T3 Code thread is also in the agent's own files) is imported once.
    /// Returns how many threads were added.
    pub fn import_threads(&self, sources: &[ImportSource]) -> Res<u32> {
        let mut known = self.store.session_keys();
        let mut threads = Vec::new();
        for &source in sources {
            for session in self.importable(source, &known).2 {
                if known
                    .iter()
                    .any(|(a, id)| *a == session.agent && *id == session.session_id)
                {
                    continue;
                }
                known.push((session.agent, session.session_id.clone()));
                let project_id = if import::is_chat_folder(Path::new(&session.cwd)) {
                    None
                } else {
                    let project =
                        self.register_project(workspace::make_project(&session.cwd)?, false)?;
                    Some(project.id)
                };
                threads.push(import::to_thread(session, project_id));
            }
        }
        let count = threads.len() as u32;
        self.store.insert_threads(threads)?;
        Ok(count)
    }
}
