//! Runs agent turns by spawning the agent CLIs and translating their JSONL
//! output into `AgentEvent`s. Each turn is one child process; its stdin stays
//! open while the turn runs so approvals can be answered.

use std::collections::{HashMap, VecDeque};
use std::io::{BufRead, BufReader, Write};
use std::process::{Child, ChildStderr, ChildStdin, ChildStdout, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, PoisonError};
use std::thread::JoinHandle;
use std::time::Duration;

#[cfg(unix)]
use std::os::unix::process::CommandExt;

use crate::Server;
use crate::provider::{self, GoalUpdate, Parsed, TurnSpec};
use crate::types::*;
use crate::workspace;
use serde_json::Value;

/// How much of the agent's stderr is kept for error reporting.
const STDERR_TAIL_BYTES: usize = 4096;

/// The agent's stdin; None once the turn has finished.
type Stdin = Arc<Mutex<Option<ChildStdin>>>;

/// Pending approvals of one turn: approval id → its message and the provider's reply context.
type Pending = Arc<Mutex<HashMap<String, (String, Value)>>>;

/// A message sent during a turn, kept until the agent answers it or the turn ends.
struct FollowUp {
    text: String,
    attachments: Vec<Attachment>,
    images: Vec<provider::Image>,
}

/// Steering messages written to the agent that it has not yet answered, oldest first.
type Steers = Arc<Mutex<VecDeque<FollowUp>>>;

/// Subagents the agent started: tool call id → the agent's own task id.
type Tasks = Arc<Mutex<HashMap<String, String>>>;

/// Messages the agent could not take mid-turn; they start the next turn.
type Queue = Arc<Mutex<Vec<FollowUp>>>;

/// What became of a message sent to a thread.
pub enum Delivery {
    /// Written to the running turn.
    Steered,
    /// Waiting for the running turn to end.
    Queued,
    /// No turn is running.
    NotRunning,
}

/// The agent's id for the turn now running (Codex reports it once the turn starts).
type NativeTurn = Arc<Mutex<Option<String>>>;

struct RunningTurn {
    pid: u32,
    cancelled: Arc<AtomicBool>,
    agent: AgentKind,
    stdin: Stdin,
    pending: Pending,
    native_turn: NativeTurn,
    steers: Steers,
    queue: Queue,
    tasks: Tasks,
}

#[derive(Default)]
pub struct Runner {
    turns: Mutex<HashMap<String, RunningTurn>>,
}

impl Runner {
    pub fn is_running(&self, thread_id: &str) -> bool {
        self.turns
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .contains_key(thread_id)
    }

    pub fn start_turn(
        &self,
        server: &Arc<Server>,
        thread_id: String,
        text: String,
        attachments: Vec<Attachment>,
        images: Vec<provider::Image>,
    ) -> Result<(), String> {
        let (agent, root, session_id, model, mode) = {
            let thread = server.store.thread(&thread_id).ok_or("Task not found")?;
            let settings = server.store.settings();
            let root = match &thread.project_id {
                Some(id) => settings
                    .projects
                    .iter()
                    .find(|p| &p.id == id)
                    .map(|p| p.path.clone())
                    .ok_or("Project not found")?,
                None => {
                    let dir = server.chat_dir(&thread_id);
                    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
                    dir.to_string_lossy().into_owned()
                }
            };
            (
                thread.agent,
                root,
                thread.session_id,
                thread.model,
                thread.access_mode,
            )
        };
        let spec = TurnSpec {
            root: &root,
            session_id: session_id.as_deref(),
            model: model.as_deref(),
            text: &text,
            mode,
            attachments: &attachments,
            images: &images,
        };

        // Agents often edit files through the shell, so changes are also found by
        // comparing git state before and after the turn.
        let baseline = workspace::git_changes(&root).unwrap_or_default();
        let args = provider::turn_args(agent, &spec);
        let input = provider::turn_input(agent, &spec);
        let mut cmd = provider::agent_command(agent)?;
        cmd.args(&args)
            .current_dir(&root)
            .stdin(if input.is_empty() {
                Stdio::null()
            } else {
                Stdio::piped()
            })
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        #[cfg(unix)]
        cmd.process_group(0);
        let mut child = cmd
            .spawn()
            .map_err(|e| format!("Failed to start agent: {e}"))?;
        let (Some(stdout), Some(stderr)) = (child.stdout.take(), child.stderr.take()) else {
            return Err("Agent output is unavailable".into());
        };
        let stderr_tail = std::thread::spawn(move || read_stderr_tail(stderr));
        let stdin: Stdin = Arc::new(Mutex::new(child.stdin.take()));
        for line in &input {
            write_line(&stdin, line);
        }

        let message = assistant_message();
        let cancelled = Arc::new(AtomicBool::new(false));
        let pending = Pending::default();
        let native_turn = NativeTurn::default();
        let steers = Steers::default();
        let queue = Queue::default();
        let tasks = Tasks::default();
        let turn = Turn {
            server: server.clone(),
            thread_id: thread_id.clone(),
            message_id: message.id.clone(),
            agent,
            cancelled: cancelled.clone(),
            baseline,
            stdin: stdin.clone(),
            pending: pending.clone(),
            native_turn: native_turn.clone(),
            steers: steers.clone(),
            queue: queue.clone(),
            tasks: tasks.clone(),
            root,
            session_id,
            model,
            text,
            mode,
            attachments,
            images,
        };
        self.turns
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .insert(
                thread_id,
                RunningTurn {
                    pid: child.id(),
                    cancelled,
                    agent,
                    stdin,
                    pending,
                    native_turn,
                    steers,
                    queue,
                    tasks,
                },
            );
        turn.publish(AgentEvent::MessageStarted { message });
        std::thread::spawn(move || drive(turn, child, stdout, stderr_tail));
        Ok(())
    }

    /// Hands a message to the turn running in `thread_id`: written to the agent when it
    /// can take input mid-turn, otherwise kept to start the next turn.
    pub fn steer(
        &self,
        thread_id: &str,
        session_id: Option<&str>,
        text: &str,
        attachments: &[Attachment],
        images: &[provider::Image],
    ) -> Delivery {
        let turns = self.turns.lock().unwrap_or_else(PoisonError::into_inner);
        let Some(turn) = turns.get(thread_id) else {
            return Delivery::NotRunning;
        };
        let follow_up = FollowUp {
            text: text.into(),
            attachments: attachments.to_vec(),
            images: images.to_vec(),
        };
        // A stopped turn takes nothing more; the message starts the next turn.
        if turn.cancelled.load(Ordering::SeqCst) {
            turn.queue
                .lock()
                .unwrap_or_else(PoisonError::into_inner)
                .push(follow_up);
            return Delivery::Queued;
        }
        let turn_id = turn
            .native_turn
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .clone();
        let line = provider::steer_input(
            turn.agent,
            text,
            attachments,
            images,
            session_id,
            turn_id.as_deref(),
        );
        // Under the stdin lock, so the reader cannot close stdin between the write and
        // recording that an answer is due.
        let mut stdin = turn.stdin.lock().unwrap_or_else(PoisonError::into_inner);
        if let Some(line) = line
            && write_to(&mut stdin, &line)
        {
            turn.steers
                .lock()
                .unwrap_or_else(PoisonError::into_inner)
                .push_back(follow_up);
            return Delivery::Steered;
        }
        turn.queue
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .push(follow_up);
        Delivery::Queued
    }

    /// Stops one subagent of the running turn, leaving the rest of the turn going.
    pub fn stop_subagent(&self, thread_id: &str, tool_id: &str) -> Result<(), String> {
        let turns = self.turns.lock().unwrap_or_else(PoisonError::into_inner);
        let turn = turns
            .get(thread_id)
            .ok_or("This turn is no longer running")?;
        let line = turn
            .tasks
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .get(tool_id)
            .and_then(|task| provider::stop_subagent(turn.agent, task))
            .ok_or("This subagent can't be stopped")?;
        if write_line(&turn.stdin, &line) {
            Ok(())
        } else {
            Err("This turn no longer accepts input".into())
        }
    }

    /// Stops the turn and drops the messages waiting for it. `last_line` is written
    /// to the agent first, with a moment to act on it.
    pub fn cancel(&self, thread_id: &str, last_line: Option<String>) {
        let turns = self.turns.lock().unwrap_or_else(PoisonError::into_inner);
        if let Some(turn) = turns.get(thread_id) {
            turn.cancelled.store(true, Ordering::SeqCst);
            turn.queue
                .lock()
                .unwrap_or_else(PoisonError::into_inner)
                .clear();
            let pid = turn.pid;
            if last_line.is_some_and(|line| write_line(&turn.stdin, &line)) {
                std::thread::spawn(move || {
                    std::thread::sleep(Duration::from_millis(300));
                    workspace::signal_process_group(pid, libc::SIGTERM);
                });
            } else {
                workspace::signal_process_group(pid, libc::SIGTERM);
            }
        }
    }

    /// Sends the user's answer to a pending approval and records it.
    pub fn respond(
        &self,
        server: &Server,
        thread_id: &str,
        approval_id: &str,
        allow: bool,
    ) -> Result<(), String> {
        let (agent, stdin, (message_id, reply)) = {
            let turns = self.turns.lock().unwrap_or_else(PoisonError::into_inner);
            let turn = turns
                .get(thread_id)
                .ok_or("This turn is no longer running")?;
            let reply = turn
                .pending
                .lock()
                .unwrap_or_else(PoisonError::into_inner)
                .remove(approval_id)
                .ok_or("This request was already answered")?;
            (turn.agent, turn.stdin.clone(), reply)
        };
        write_line(&stdin, &provider::approval_reply(agent, &reply, allow));
        publish(
            server,
            thread_id,
            AgentEvent::ApprovalResolved {
                message_id: message_id.clone(),
                approval_id: approval_id.into(),
                allowed: allow,
            },
        );
        Ok(())
    }
}

/// Writes one line to the agent's stdin, if it is still open.
fn write_line(stdin: &Mutex<Option<ChildStdin>>, line: &str) -> bool {
    write_to(
        &mut stdin.lock().unwrap_or_else(PoisonError::into_inner),
        line,
    )
}

fn write_to(stdin: &mut Option<ChildStdin>, line: &str) -> bool {
    let Some(pipe) = stdin.as_mut() else {
        return false;
    };
    match writeln!(pipe, "{line}").and_then(|()| pipe.flush()) {
        Ok(()) => true,
        Err(e) => {
            log::warn!("failed to write to agent: {e}");
            false
        }
    }
}

/// Saves `event` onto the stored message, then streams it to the frontend.
fn publish(server: &Server, thread_id: &str, event: AgentEvent) {
    if let Err(e) = server.store.update_thread(thread_id, |t| apply(t, &event)) {
        log::warn!("failed to save agent event: {e}");
    }
    server.emit(AgentEventEnvelope {
        thread_id: thread_id.into(),
        event,
    });
}

/// Everything the stdout reader needs to persist and publish one turn's events.
struct Turn {
    server: Arc<Server>,
    thread_id: String,
    message_id: String,
    agent: AgentKind,
    cancelled: Arc<AtomicBool>,
    /// `git status` of the project when the turn started.
    baseline: Vec<FileChange>,
    stdin: Stdin,
    pending: Pending,
    native_turn: NativeTurn,
    steers: Steers,
    queue: Queue,
    tasks: Tasks,
    root: String,
    session_id: Option<String>,
    model: Option<String>,
    text: String,
    mode: AccessMode,
    attachments: Vec<Attachment>,
    images: Vec<provider::Image>,
}

impl Turn {
    fn publish(&self, event: AgentEvent) {
        publish(&self.server, &self.thread_id, event);
    }

    /// Starts a new assistant message for what the agent says after taking a steering
    /// message, so the answer follows that message instead of growing the reply above it.
    fn next_segment(&mut self, unsaved: &mut String) {
        self.save_text(unsaved);
        let message = assistant_message();
        self.message_id = message.id.clone();
        self.publish(AgentEvent::MessageStarted { message });
    }

    /// Closes stdin, which lets the agent exit, unless it still owes an answer to a
    /// steering message.
    fn close_unless_steered(&self) {
        let mut stdin = self.stdin.lock().unwrap_or_else(PoisonError::into_inner);
        if self
            .steers
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .is_empty()
        {
            stdin.take();
        }
    }

    /// Streams a text delta to the frontend without saving it; the reader
    /// collects it in `unsaved` so it is stored in one write later.
    fn stream_text(&self, event: AgentEvent, unsaved: &mut String) {
        if let AgentEvent::TextDelta { text, .. } = &event {
            unsaved.push_str(text);
        }
        self.server.emit(AgentEventEnvelope {
            thread_id: self.thread_id.clone(),
            event,
        });
    }

    /// Saves text that was streamed but not yet stored.
    fn save_text(&self, unsaved: &mut String) {
        if unsaved.is_empty() {
            return;
        }
        let event = AgentEvent::TextDelta {
            message_id: self.message_id.clone(),
            text: std::mem::take(unsaved),
        };
        if let Err(e) = self
            .server
            .store
            .update_thread(&self.thread_id, |t| apply(t, &event))
        {
            log::warn!("failed to save agent text: {e}");
        }
    }

    fn spec(&self) -> TurnSpec<'_> {
        TurnSpec {
            root: &self.root,
            session_id: self.session_id.as_deref(),
            model: self.model.as_deref(),
            text: &self.text,
            mode: self.mode,
            attachments: &self.attachments,
            images: &self.images,
        }
    }
}

/// An empty assistant message the agent's output streams into.
fn assistant_message() -> Message {
    Message {
        id: new_id(),
        role: Role::Assistant,
        text: String::new(),
        created_at: now_ms(),
        status: MessageStatus::Streaming,
        tools: vec![],
        plan: vec![],
        files: vec![],
        error: None,
        approvals: vec![],
        attachments: vec![],
        steer: false,
    }
}

/// The thread's goal after the agent reports `update`.
fn next_goal(current: Option<&Goal>, update: GoalUpdate) -> Option<Goal> {
    match update {
        GoalUpdate::Set { objective, checks } => Some(Goal {
            // Restating the same goal keeps when it was set.
            started_at: current
                .filter(|g| g.objective == objective)
                .map_or_else(now_ms, |g| g.started_at),
            objective,
            status: GoalStatus::Active,
            checks,
            tokens_used: None,
            token_budget: None,
            time_used_seconds: None,
        }),
        GoalUpdate::Checked => current.map(|g| Goal {
            status: GoalStatus::Active,
            checks: Some(g.checks.unwrap_or(0) + 1),
            ..g.clone()
        }),
        GoalUpdate::Cleared => None,
        GoalUpdate::Reported(goal) => Some(goal),
    }
}

/// Reads the agent's stdout until it closes, then records the final status.
fn drive(mut turn: Turn, mut child: Child, stdout: ChildStdout, stderr_tail: JoinHandle<String>) {
    let mut has_text = false;
    // Gemini streams one text block as many deltas; other agents send whole blocks.
    let mut last_was_text = false;
    // Tool id → the message it was started in, which a steer may since have moved on from.
    let mut tool_owner: HashMap<String, String> = HashMap::new();
    // Subagents still running, and whether the call of one sent to the background, which
    // returns at once, failed; it is reported finished when the subagent ends.
    let mut running_tasks: HashMap<String, Option<bool>> = HashMap::new();
    // Every message of the turn: the first reply, then one per steering message taken.
    let mut segments = vec![turn.message_id.clone()];
    let mut stream_error: Option<String> = None;
    let mut goal = turn
        .server
        .store
        .thread(&turn.thread_id)
        .and_then(|t| t.goal);
    // Whether the agent did any work toward the goal since it was set (Claude).
    let mut worked = false;
    // The agent reported its turn finished; Codex may start another for an active goal.
    let mut ended = false;
    // Codex reported this run's goal active, so it starts further turns toward it.
    let mut goal_run = false;
    // Text streamed to the frontend but not yet stored; saving every delta
    // stalls the reader, so it is stored before the next event and at the end.
    let mut unsaved = String::new();

    for line in BufReader::new(stdout).lines() {
        let Ok(line) = line else { continue };
        let Ok(value) = serde_json::from_str::<Value>(&line) else {
            continue;
        };
        let parsed = provider::parse_line(turn.agent, &value, &turn.spec(), &turn.message_id);
        for item in parsed {
            match item {
                Parsed::Send(line) => {
                    write_line(&turn.stdin, &line);
                }
                Parsed::Approval {
                    title,
                    detail,
                    reply,
                } => {
                    let approval = Approval {
                        id: new_id(),
                        title,
                        detail,
                        status: ApprovalStatus::Pending,
                    };
                    turn.pending
                        .lock()
                        .unwrap_or_else(PoisonError::into_inner)
                        .insert(approval.id.clone(), (turn.message_id.clone(), reply));
                    turn.save_text(&mut unsaved);
                    turn.publish(AgentEvent::ApprovalRequested {
                        message_id: turn.message_id.clone(),
                        approval,
                    });
                }
                Parsed::Finished => {
                    ended = true;
                    let steered = !turn
                        .steers
                        .lock()
                        .unwrap_or_else(PoisonError::into_inner)
                        .is_empty();
                    // Claude ends its reply to take the steering messages, then answers them.
                    if steered && turn.agent == AgentKind::Claude {
                        turn.steers
                            .lock()
                            .unwrap_or_else(PoisonError::into_inner)
                            .clear();
                        turn.next_segment(&mut unsaved);
                        segments.push(turn.message_id.clone());
                        (has_text, last_was_text) = (false, false);
                        // Its answer ends with another result; stdin stays open for more.
                        ended = false;
                        continue;
                    }
                    // The finished turn can no longer be steered; until Codex starts the
                    // next one, messages wait for the run to end.
                    *turn
                        .native_turn
                        .lock()
                        .unwrap_or_else(PoisonError::into_inner) = None;
                    if stream_error.is_some() {
                        goal_run = false;
                    }
                    if !goal_run {
                        turn.close_unless_steered();
                    }
                }
                Parsed::Steered => {
                    turn.steers
                        .lock()
                        .unwrap_or_else(PoisonError::into_inner)
                        .pop_front();
                    turn.next_segment(&mut unsaved);
                    segments.push(turn.message_id.clone());
                    (has_text, last_was_text) = (false, false);
                    if ended && !goal_run {
                        turn.close_unless_steered();
                    }
                }
                Parsed::SteerRejected(message) => {
                    log::warn!("the agent did not take the steering message: {message}");
                    let refused = turn
                        .steers
                        .lock()
                        .unwrap_or_else(PoisonError::into_inner)
                        .pop_front();
                    turn.queue
                        .lock()
                        .unwrap_or_else(PoisonError::into_inner)
                        .extend(refused);
                    if ended && !goal_run {
                        turn.close_unless_steered();
                    }
                }
                Parsed::Goal(update) => {
                    // Once stopped, the agent's last word on the goal no longer applies.
                    if turn.cancelled.load(Ordering::SeqCst) {
                        continue;
                    }
                    if matches!(update, GoalUpdate::Set { .. }) {
                        worked = false;
                    }
                    let next = next_goal(goal.as_ref(), update);
                    if next != goal {
                        goal = next;
                        turn.save_text(&mut unsaved);
                        turn.publish(AgentEvent::GoalUpdated { goal: goal.clone() });
                    }
                    // Codex goes on toward an active goal in turns it starts itself.
                    goal_run = turn.agent == AgentKind::Codex
                        && goal
                            .as_ref()
                            .is_some_and(|g| g.status == GoalStatus::Active);
                    if ended && !goal_run {
                        turn.close_unless_steered();
                    }
                }
                Parsed::SessionId(id) => {
                    let store = &turn.server.store;
                    if let Err(e) =
                        store.update_thread(&turn.thread_id, |t| t.session_id = Some(id.clone()))
                    {
                        log::warn!("failed to save session id: {e}");
                    }
                    turn.session_id = Some(id);
                }
                Parsed::TaskStarted { tool_id, task_id } => {
                    running_tasks.insert(tool_id.clone(), None);
                    turn.tasks
                        .lock()
                        .unwrap_or_else(PoisonError::into_inner)
                        .insert(tool_id, task_id);
                }
                Parsed::TaskEnded { tool_id, failed } => {
                    if let Some(Some(call_failed)) = running_tasks.remove(&tool_id)
                        && let Some(owner) = tool_owner.get(&tool_id)
                    {
                        turn.save_text(&mut unsaved);
                        turn.publish(AgentEvent::ToolFinished {
                            message_id: owner.clone(),
                            tool_id,
                            is_error: failed || call_failed,
                        });
                    }
                }
                Parsed::TurnStarted(id) => {
                    ended = false;
                    *turn
                        .native_turn
                        .lock()
                        .unwrap_or_else(PoisonError::into_inner) = Some(id);
                }
                Parsed::Error(message) => {
                    stream_error.get_or_insert(message);
                }
                Parsed::Event(mut event) => {
                    match &mut event {
                        // Separate successive text blocks so they do not run together. Gemini
                        // and Claude stream a block as chunks, so chunks after the first stay
                        // together.
                        AgentEvent::TextDelta { text, .. } => {
                            let streams =
                                matches!(turn.agent, AgentKind::Gemini | AgentKind::Claude);
                            let continues = streams && last_was_text;
                            if has_text && !continues {
                                text.insert_str(0, "\n\n");
                            }
                            has_text = true;
                        }
                        // Codex reports a tool when it starts and again when it completes;
                        // only the first ToolStarted for an id is kept.
                        AgentEvent::ToolStarted { tool, message_id } => {
                            if tool_owner.contains_key(&tool.id) {
                                continue;
                            }
                            tool_owner.insert(tool.id.clone(), message_id.clone());
                        }
                        AgentEvent::ToolFinished {
                            tool_id,
                            message_id,
                            is_error,
                        } => {
                            if let Some(owner) = tool_owner.get(tool_id) {
                                message_id.clone_from(owner);
                            }
                            if let Some(held) = running_tasks.get_mut(tool_id.as_str()) {
                                *held = Some(*is_error);
                                continue;
                            }
                        }
                        _ => {}
                    }
                    worked = true;
                    last_was_text = matches!(event, AgentEvent::TextDelta { .. });
                    if last_was_text {
                        turn.stream_text(event, &mut unsaved);
                    } else {
                        turn.save_text(&mut unsaved);
                        turn.publish(event);
                    }
                }
            }
        }
    }
    // The stream has closed, whether the turn finished, failed, or was cancelled.
    turn.save_text(&mut unsaved);

    let exit = child.wait().ok();
    let tail = stderr_tail.join().unwrap_or_default();
    let cancelled = turn.cancelled.load(Ordering::SeqCst);
    let (status, error) = if cancelled {
        (MessageStatus::Cancelled, None)
    } else if stream_error.is_some() || !exit.is_some_and(|s| s.success()) {
        let error = stream_error
            .or_else(|| last_lines(&tail))
            .unwrap_or_else(|| match exit.and_then(|s| s.code()) {
                Some(code) => format!("Agent exited with code {code}"),
                None => "Agent exited unexpectedly".into(),
            });
        (MessageStatus::Error, Some(error))
    } else {
        (MessageStatus::Complete, None)
    };

    let after = workspace::git_changes(&turn.root).unwrap_or_default();
    for path in changed_paths(&turn.baseline, &after) {
        turn.publish(AgentEvent::FileTouched {
            message_id: turn.message_id.clone(),
            path,
        });
    }

    // A stopped goal is paused; Claude's goal is met once a run working on it ends well.
    // The stored goal is read again, since the user may have cleared it meanwhile.
    let goal = turn
        .server
        .store
        .thread(&turn.thread_id)
        .and_then(|t| t.goal);
    if let Some(g) = goal.as_ref().filter(|g| g.status == GoalStatus::Active) {
        let status = if cancelled {
            Some(GoalStatus::Paused)
        } else if turn.agent == AgentKind::Claude && status == MessageStatus::Complete && worked {
            Some(GoalStatus::Complete)
        } else {
            None
        };
        if let Some(status) = status {
            let goal = Some(Goal {
                status,
                ..g.clone()
            });
            turn.publish(AgentEvent::GoalUpdated { goal });
        }
    }

    // Forget the turn before announcing it, so a follow-up message sent on
    // TurnCompleted is not rejected as "already running". Messages that waited for
    // the turn are taken at the same moment, so none is left behind.
    let waiting = {
        let mut turns = turn
            .server
            .runner
            .turns
            .lock()
            .unwrap_or_else(PoisonError::into_inner);
        turns.remove(&turn.thread_id);
        let mut waiting =
            std::mem::take(&mut *turn.queue.lock().unwrap_or_else(PoisonError::into_inner));
        // Steering messages the agent never answered wait too, unless the turn was
        // stopped; messages sent after Stop still start the next turn.
        let unanswered = turn
            .steers
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .drain(..)
            .collect::<Vec<_>>();
        if !cancelled {
            waiting.extend(unanswered);
        }
        waiting
    };
    // Earlier messages of the turn were answered in full before a steer moved it on.
    for id in &segments[..segments.len() - 1] {
        turn.publish(AgentEvent::TurnCompleted {
            message_id: id.clone(),
            status: MessageStatus::Complete,
            error: None,
        });
    }
    turn.publish(AgentEvent::TurnCompleted {
        message_id: turn.message_id.clone(),
        status,
        error,
    });

    if !waiting.is_empty() {
        let text = waiting
            .iter()
            .map(|f| f.text.as_str())
            .collect::<Vec<_>>()
            .join("\n\n");
        let (attachments, images) = waiting.into_iter().map(|f| (f.attachments, f.images)).fold(
            (vec![], vec![]),
            |(mut a, mut i), (fa, fi)| {
                a.extend(fa);
                i.extend(fi);
                (a, i)
            },
        );
        let server = turn.server.clone();
        if let Err(e) =
            server
                .runner
                .start_turn(&server, turn.thread_id.clone(), text, attachments, images)
        {
            log::warn!("failed to start the turn for queued messages: {e}");
        }
    }
}

/// Paths whose git status or line counts differ between two snapshots.
fn changed_paths(before: &[FileChange], after: &[FileChange]) -> Vec<String> {
    let key = |c: &FileChange| (c.status.clone(), c.additions, c.deletions);
    after
        .iter()
        .filter(|a| {
            before
                .iter()
                .find(|b| b.path == a.path)
                .is_none_or(|b| key(b) != key(a))
        })
        .map(|a| a.path.clone())
        .collect()
}

/// Reads all of stderr but keeps only roughly the last `STDERR_TAIL_BYTES`.
fn read_stderr_tail(stderr: ChildStderr) -> String {
    let mut reader = BufReader::new(stderr);
    let mut tail = String::new();
    let mut line = Vec::new();
    while reader.read_until(b'\n', &mut line).unwrap_or(0) > 0 {
        tail.push_str(&String::from_utf8_lossy(&line));
        line.clear();
        if tail.len() > STDERR_TAIL_BYTES {
            let mut cut = tail.len() - STDERR_TAIL_BYTES;
            while !tail.is_char_boundary(cut) {
                cut += 1;
            }
            tail.drain(..cut);
        }
    }
    tail
}

/// The last few non-empty stderr lines, used as the error text when the CLI fails without a message.
fn last_lines(tail: &str) -> Option<String> {
    let mut lines: Vec<&str> = tail
        .lines()
        .rev()
        .filter(|l| !l.trim().is_empty())
        .take(3)
        .collect();
    lines.reverse();
    (!lines.is_empty()).then(|| lines.join("\n"))
}

/// Applies one event to the stored message. Used for both persistence and replay.
fn apply(thread: &mut Thread, event: &AgentEvent) {
    let message_id = match event {
        AgentEvent::MessageStarted { message } => {
            if !thread.messages.iter().any(|m| m.id == message.id) {
                thread.messages.push(message.clone());
            }
            return;
        }
        AgentEvent::GoalUpdated { goal } => {
            thread.goal = goal.clone();
            return;
        }
        AgentEvent::TextDelta { message_id, .. }
        | AgentEvent::ToolStarted { message_id, .. }
        | AgentEvent::ToolFinished { message_id, .. }
        | AgentEvent::PlanUpdated { message_id, .. }
        | AgentEvent::FileTouched { message_id, .. }
        | AgentEvent::ApprovalRequested { message_id, .. }
        | AgentEvent::ApprovalResolved { message_id, .. }
        | AgentEvent::TurnCompleted { message_id, .. } => message_id,
    };
    let Some(msg) = thread.messages.iter_mut().find(|m| m.id == *message_id) else {
        return;
    };
    match event {
        AgentEvent::TextDelta { text, .. } => msg.text.push_str(text),
        AgentEvent::ToolStarted { tool, .. } => msg.tools.push(tool.clone()),
        AgentEvent::ToolFinished {
            tool_id, is_error, ..
        } => {
            if let Some(tool) = msg.tools.iter_mut().find(|t| t.id == *tool_id) {
                tool.ended_at = Some(now_ms());
                tool.status = if *is_error {
                    StepStatus::Error
                } else {
                    StepStatus::Done
                };
            }
        }
        AgentEvent::PlanUpdated { steps, .. } => msg.plan = steps.clone(),
        AgentEvent::FileTouched { path, .. } => {
            if !msg.files.contains(path) {
                msg.files.push(path.clone());
            }
        }
        AgentEvent::ApprovalRequested { approval, .. } => msg.approvals.push(approval.clone()),
        AgentEvent::ApprovalResolved {
            approval_id,
            allowed,
            ..
        } => {
            if let Some(approval) = msg.approvals.iter_mut().find(|a| a.id == *approval_id) {
                approval.status = if *allowed {
                    ApprovalStatus::Allowed
                } else {
                    ApprovalStatus::Denied
                };
            }
        }
        AgentEvent::TurnCompleted { status, error, .. } => {
            msg.status = *status;
            msg.error = error.clone();
            // Unanswered requests lapse with the turn.
            for approval in msg
                .approvals
                .iter_mut()
                .filter(|a| a.status == ApprovalStatus::Pending)
            {
                approval.status = ApprovalStatus::Denied;
            }
            // Nothing can still be running once the turn has ended.
            let tool_end = if *status == MessageStatus::Complete {
                StepStatus::Done
            } else {
                StepStatus::Error
            };
            for tool in msg
                .tools
                .iter_mut()
                .filter(|t| t.status == StepStatus::Running)
            {
                tool.status = tool_end;
                tool.ended_at = Some(now_ms());
            }
            for step in msg
                .plan
                .iter_mut()
                .filter(|s| s.status == StepStatus::Running)
            {
                step.status = StepStatus::Pending;
            }
        }
        AgentEvent::MessageStarted { .. } | AgentEvent::GoalUpdated { .. } => {}
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn change(path: &str, status: &str, additions: u32) -> FileChange {
        FileChange {
            path: path.into(),
            status: status.into(),
            additions,
            deletions: 0,
            staged: false,
        }
    }

    #[test]
    fn changed_paths_finds_new_and_modified_files() {
        let before = [change("a.rs", "modified", 1), change("b.rs", "modified", 2)];
        let after = [
            change("a.rs", "modified", 1),
            change("b.rs", "modified", 5),
            change("c.rs", "untracked", 3),
        ];
        assert_eq!(changed_paths(&before, &after), ["b.rs", "c.rs"]);
    }

    /// Runs a real turn through the installed CLI, allowing every approval, and
    /// checks the parsed stream. Needs the agent installed and signed in:
    /// `cargo test -- --ignored`.
    fn live_turn(agent: AgentKind, mode: AccessMode) {
        let root = std::env::temp_dir().join(new_id());
        std::fs::create_dir_all(&root).unwrap();
        let root_str = root.to_str().unwrap();
        let ok = std::process::Command::new("git")
            .args(["init", "-q"])
            .current_dir(&root)
            .status()
            .unwrap();
        assert!(ok.success());

        let spec = TurnSpec {
            root: root_str,
            session_id: None,
            model: (agent == AgentKind::Claude).then_some("haiku"),
            text: "Create a file named hello.txt whose only content is the two letters hi (no period). Do nothing else.",
            mode,
            attachments: &[],
            images: &[],
        };
        let baseline = workspace::git_changes(root_str).unwrap();
        let input = provider::turn_input(agent, &spec);
        let mut child = provider::agent_command(agent)
            .unwrap()
            .args(provider::turn_args(agent, &spec))
            .current_dir(&root)
            .stdin(if input.is_empty() {
                Stdio::null()
            } else {
                Stdio::piped()
            })
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .unwrap();
        let stdin: Stdin = Arc::new(Mutex::new(child.stdin.take()));
        for line in &input {
            write_line(&stdin, line);
        }

        let mut parsed = Vec::new();
        for line in BufReader::new(child.stdout.take().unwrap()).lines() {
            let Ok(value) = serde_json::from_str::<Value>(&line.unwrap()) else {
                continue;
            };
            for item in provider::parse_line(agent, &value, &spec, "m") {
                match &item {
                    Parsed::Send(line) => {
                        write_line(&stdin, line);
                    }
                    Parsed::Approval { reply, .. } => {
                        write_line(&stdin, &provider::approval_reply(agent, reply, true));
                    }
                    Parsed::Finished => drop(stdin.lock().unwrap().take()),
                    _ => {}
                }
                parsed.push(item);
            }
        }
        let out = child.wait_with_output().unwrap();
        assert!(
            out.status.success(),
            "{}",
            String::from_utf8_lossy(&out.stderr)
        );
        assert!(parsed.iter().any(|p| matches!(p, Parsed::SessionId(_))));
        assert!(
            !parsed.iter().any(|p| matches!(p, Parsed::Error(_))),
            "{parsed:?}"
        );
        if mode == AccessMode::Supervised && agent != AgentKind::Gemini {
            assert!(parsed.iter().any(|p| matches!(p, Parsed::Approval { .. })));
        }
        let changed = changed_paths(&baseline, &workspace::git_changes(root_str).unwrap());
        assert_eq!(changed, ["hello.txt"]);
        let content = std::fs::read_to_string(root.join("hello.txt")).unwrap();
        assert_eq!(content.trim(), "hi");
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    #[ignore = "runs the real Claude Code CLI"]
    fn live_claude_supervised_turn() {
        live_turn(AgentKind::Claude, AccessMode::Supervised);
    }

    #[test]
    #[ignore = "runs the real Codex CLI"]
    fn live_codex_supervised_turn() {
        live_turn(AgentKind::Codex, AccessMode::Supervised);
    }

    #[test]
    #[ignore = "runs the real Claude Code CLI"]
    fn live_claude_turn() {
        live_turn(AgentKind::Claude, AccessMode::FullAccess);
    }

    #[test]
    #[ignore = "runs the real Codex CLI"]
    fn live_codex_turn() {
        live_turn(AgentKind::Codex, AccessMode::FullAccess);
    }

    #[test]
    #[ignore = "runs the real Gemini CLI"]
    fn live_gemini_turn() {
        live_turn(AgentKind::Gemini, AccessMode::AutoAcceptEdits);
    }
}
