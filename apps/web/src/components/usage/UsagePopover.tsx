import { useCallback, useEffect, useRef, useState } from "react";
import { ArrowsClockwiseIcon, ChartBarIcon } from "@phosphor-icons/react";
import { api, AGENT_LABELS, type AgentKind, type AgentStatus, type ProviderUsage } from "~/api";
import ProviderLogos from "~/components/ProviderLogos";
import { describeAgent, errorText } from "~/lib/util";

/** "in 3h 12m", "in 2d 4h", "in 5m". */
function resetsIn(at: number): string {
  const mins = Math.max(0, Math.round((at - Date.now()) / 60000));
  const d = Math.floor(mins / 1440);
  const h = Math.floor((mins % 1440) / 60);
  const m = mins % 60;
  if (d > 0) return `in ${d}d ${h}h`;
  if (h > 0) return `in ${h}h ${m}m`;
  return `in ${m}m`;
}

function level(percent: number): string {
  if (percent >= 90) return "bg-danger";
  if (percent >= 70) return "bg-warning";
  return "bg-accent";
}

type Entry = { usage?: ProviderUsage; error?: string; status?: AgentStatus | null };

/** Sidebar footer button that opens subscription usage for each connected agent. */
export default function UsagePopover({ agents }: { agents: AgentKind[] }) {
  const [open, setOpen] = useState(false);
  const [entries, setEntries] = useState<Partial<Record<AgentKind, Entry>>>({});
  const [loading, setLoading] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  const load = useCallback(
    (refresh: boolean) => {
      setLoading(true);
      const jobs = agents.map(async (kind) => {
        const status = await api.detectAgent(kind).catch(() => null);
        const entry: Entry = { status };
        if (status?.installed && status.signedIn) {
          try {
            entry.usage = await api.getUsage(kind, refresh);
          } catch (e) {
            entry.error = errorText(e);
          }
        }
        setEntries((prev) => ({ ...prev, [kind]: entry }));
      });
      void Promise.all(jobs).finally(() => setLoading(false));
    },
    [agents],
  );

  useEffect(() => {
    if (!open) return;
    load(false);
    const onDown = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node | null)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open, load]);

  return (
    <div className="relative flex-none py-1.5 px-2" ref={ref}>
      <button
        className={`flex items-center gap-1.5 w-full h-7 px-2 border-none rounded-[var(--radius-sm)] bg-transparent text-fg-muted text-[length:var(--fs-sm)] cursor-pointer hover:bg-hover hover:text-fg${open ? " bg-hover text-fg" : ""}`}
        title="Usage"
        aria-label="Usage"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
      >
        <ChartBarIcon size={18} />
        <span>Usage</span>
      </button>
      {open && (
        <div
          className="absolute left-2 right-2 bottom-[calc(100%_+_4px)] z-20 min-w-[240px] max-h-[420px] overflow-y-auto pt-2 px-2.5 pb-2.5 flex flex-col gap-3 bg-elevated border border-border-strong rounded-[var(--radius)]"
          role="dialog"
          aria-label="Usage"
        >
          <div className="flex items-center justify-between font-semibold">
            <span>Usage</span>
            <button
              className="btn-icon"
              title="Refresh"
              aria-label="Refresh"
              onClick={() => load(true)}
              disabled={loading}
            >
              <ArrowsClockwiseIcon size={14} className={loading ? "spin" : undefined} />
            </button>
          </div>
          {agents.length === 0 && (
            <div className="text-fg-muted text-[length:var(--fs-sm)]">No agents connected</div>
          )}
          {agents.map((kind) => (
            <AgentUsage key={kind} kind={kind} entry={entries[kind]} />
          ))}
        </div>
      )}
    </div>
  );
}

function AgentUsage({ kind, entry }: { kind: AgentKind; entry: Entry | undefined }) {
  const usage = entry?.usage;
  const ready = entry?.status?.installed && entry.status.signedIn;
  const note = !entry
    ? "Loading…"
    : !ready
      ? describeAgent(entry.status)
      : (entry.error ??
        usage?.error ??
        (usage?.windows.length === 0 ? "No limits reported" : null));
  return (
    <section className="flex flex-col gap-2">
      <div className="flex items-center gap-1.5">
        <ProviderLogos kind={kind} size={14} />
        <span className="flex-1 font-medium">{AGENT_LABELS[kind]}</span>
        {usage?.plan && <span className="badge">{usage.plan}</span>}
      </div>
      {note && <div className="text-fg-muted text-[length:var(--fs-sm)]">{note}</div>}
      {usage?.windows.map((w) => (
        <div key={w.label} className="flex flex-col gap-1 text-[length:var(--fs-sm)]">
          <div className="flex justify-between">
            <span>{w.label}</span>
            <span className="tabular-nums text-fg-muted">{Math.round(w.usedPercent)}%</span>
          </div>
          <div className="h-1.5 rounded-[3px] bg-selected-muted overflow-hidden">
            <div
              className={`h-full rounded-[3px] ${level(w.usedPercent)}`}
              style={{ width: `${Math.min(100, w.usedPercent)}%` }}
            />
          </div>
          {w.resetsAt && (
            <div className="text-fg-subtle text-[length:var(--fs-xs)]">
              Resets {resetsIn(w.resetsAt)}
            </div>
          )}
        </div>
      ))}
    </section>
  );
}
