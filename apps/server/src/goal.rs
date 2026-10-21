//! A thread's `/goal`: how the agent's reports change it, and how stopping it works.

use std::sync::Arc;

use crate::provider::GoalUpdate;
use crate::types::*;
use crate::{Res, Server};

/// The thread's goal after the agent reports `update`.
pub(crate) fn next_goal(current: Option<&Goal>, update: GoalUpdate) -> Option<Goal> {
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

impl Server {
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
            self.send_message(thread_id.into(), stop.into(), vec![], false)?;
        }
        Ok(())
    }
}
