import { useEffect, useState } from "react";
import { SquareIcon, TargetIcon, XIcon } from "@phosphor-icons/react";
import type { Goal, GoalStatus, Message } from "~/api";

const LABELS: Record<GoalStatus, string> = {
  active: "Pursuing goal",
  paused: "Goal paused",
  blocked: "Goal blocked",
  usageLimited: "Goal stopped at usage limit",
  budgetLimited: "Goal reached token budget",
  complete: "Goal complete",
};

/** "45s", "3m 12s", "1h 4m". */
function formatDuration(seconds: number): string {
  const s = Math.floor(seconds);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}

/** "950", "12k", "1.5M". */
function formatTokens(n: number): string {
  const scaled = (x: number) => (x < 10 ? x.toFixed(1) : String(Math.round(x))).replace(/\.0$/, "");
  if (n >= 1_000_000) return `${scaled(n / 1_000_000)}M`;
  if (n >= 1_000) return `${scaled(n / 1_000)}k`;
  return String(n);
}

/**
 * What the agent is doing right now: the running plan step, else the running tool call, from
 * the reply that is streaming. Null between steps.
 */
export function currentActivity(messages: Message[]): string | null {
  const streaming = messages
    .filter((m) => m.role === "assistant" && m.status === "streaming")
    .at(-1);
  if (!streaming) return null;
  const step = streaming.plan.find((s) => s.status === "running");
  if (step) return step.text;
  const tool = streaming.tools.filter((t) => t.status === "running").at(-1);
  if (tool) return tool.summary ? `${tool.name} ${tool.summary}` : tool.name;
  return null;
}

/**
 * The banner for a goal. The subtext is what the agent is doing now (the goal stays in the
 * tooltip). The square stops an active goal; the X only hides a finished one.
 */
export default function GoalBanner({
  goal,
  activity,
  onStop,
  onDismiss,
}: {
  goal: Goal;
  activity: string | null;
  onStop: () => void;
  onDismiss: () => void;
}) {
  const active = goal.status === "active";
  const [now, setNow] = useState(() => Date.now());
  // Only an active goal's elapsed time moves; the others show the time they stopped at.
  useEffect(() => {
    if (!active) return;
    setNow(Date.now());
    const id = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, [active]);

  const seconds = goal.timeUsedSeconds ?? Math.max(0, (now - goal.startedAt) / 1000);
  const usage = [formatDuration(seconds)];
  if (goal.tokensUsed != null) {
    usage.push(
      goal.tokenBudget != null
        ? `${formatTokens(goal.tokensUsed)} / ${formatTokens(goal.tokenBudget)} tokens`
        : `${formatTokens(goal.tokensUsed)} tokens`,
    );
  }
  if (goal.checks) usage.push(goal.checks === 1 ? "1 check" : `${goal.checks} checks`);

  const complete = goal.status === "complete";
  const label = complete ? "Dismiss goal" : "Stop goal";
  return (
    // One quiet line above the composer, in the chat's own colors.
    <div
      className="mb-1.5 flex min-w-0 items-center gap-2 px-2 text-[length:var(--fs-sm)]"
      title={goal.objective}
    >
      <TargetIcon
        size={14}
        className={`flex-none ${active ? "text-accent-text" : "text-fg-subtle"}`}
      />
      <span className="flex-none font-semibold text-fg">{LABELS[goal.status]}</span>
      <span className="min-w-0 flex-1 truncate text-fg-muted">
        {active ? (activity ?? "Working…") : goal.objective}
      </span>
      {/* Tabular digits keep the timer from changing width as it counts, so nothing shifts. */}
      <span className="flex-none whitespace-nowrap text-fg-subtle tabular-nums">
        {usage.join(" · ")}
      </span>
      <button
        className="grid h-6 w-6 flex-none cursor-pointer place-items-center rounded-[var(--radius)] border-none bg-transparent text-fg-subtle hover:bg-hover hover:text-fg"
        onClick={complete ? onDismiss : onStop}
        title={label}
        aria-label={label}
      >
        {complete ? <XIcon size={12} /> : <SquareIcon size={10} weight="fill" />}
      </button>
    </div>
  );
}
