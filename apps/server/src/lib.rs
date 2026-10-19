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
use runner::Runner;
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
    sink: EventSink,
}

/// Trims a user-entered name; blank names are refused.
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
        Ok(Arc::new(Self {
            store: Store::open(config_dir)?,
            usage: usage::UsageCache::default(),
            runner: Runner::default(),
            chats_dir: data_dir.join("chats"),
            sink,
        }))
    }

    fn emit(&self, event: AgentEventEnvelope) {
        (self.sink)(event);
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

    /// Every thread (project tasks and project-less chats), newest first.
    pub fn list_threads(&self) -> Vec<Thread> {
        let mut ts = self.store.threads();
        ts.sort_by_key(|t| std::cmp::Reverse(t.created_at));
        ts
    }

    pub fn create_thread(
        &self,
        project_id: Option<String>,
        agent: AgentKind,
        model: Option<String>,
        access_mode: AccessMode,
    ) -> Res<Thread> {
        if let Some(id) = &project_id {
            self.project_root(id)?;
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
            access_mode,
            session_id: None,
            created_at: now_ms(),
            messages: vec![],
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
        self.runner.cancel(id);
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

    /// Appends the user message, then starts the agent turn in the background.
    /// Returns the stored user message; assistant output arrives via the event sink.
    pub fn send_message(self: &Arc<Self>, thread_id: String, text: String) -> Res<Message> {
        if self.runner.is_running(&thread_id) {
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
            approvals: vec![],
        };
        let m = msg.clone();
        self.store.update_thread(&thread_id, |t| {
            if t.messages.is_empty() {
                t.title = title_from(&text);
            }
            t.messages.push(m);
        })?;
        self.runner.start_turn(self, thread_id, text)?;
        Ok(msg)
    }

    pub fn cancel_turn(&self, thread_id: &str) {
        self.runner.cancel(thread_id);
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
        let all: Vec<_> = all.into_iter().filter(|s| !s.subagent).collect();
        let found = all.len() as u32;
        let new = all
            .into_iter()
            .filter(|s| {
                !known
                    .iter()
                    .any(|(a, id)| *a == s.agent && *id == s.session_id)
            })
            .filter(|s| !Path::new(&s.cwd).starts_with(&self.chats_dir))
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
