import { useCallback, useEffect, useRef, useState } from "react";
import { ArrowsClockwiseIcon, ChartBarIcon } from "@phosphor-icons/react";
import { api, AGENT_LABELS, type AgentKind, type AgentStatus, type ProviderUsage } from "~/api";
import ProviderLogos from "~/components/ProviderLogos";
import { describeAgent, errorText } from "~/lib/util";
import "./Usage.css";

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
  if (percent >= 90) return " is-danger";
  if (percent >= 70) return " is-warning";
  return "";
}

type Entry = { usage?: ProviderUsage; error?: string; status?: AgentStatus | null };

/** Sidebar footer button that opens subscription usage for each connected agent. */
export default function UsagePopover({ agents }: { agents: AgentKind[] }) {
  const [open, setOpen] = useState(false);
  const [entries, setEntries] = useState<Partial<Record<AgentKind, Entry>>>({});
  const [loading, setLoading] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  const load = useCallback(() => {
    setLoading(true);
    const jobs = agents.map(async (kind) => {
      const status = await api.detectAgent(kind).catch(() => null);
      const entry: Entry = { status };
      if (status?.installed && status.signedIn) {
        try {
          entry.usage = await api.getUsage(kind);
        } catch (e) {
          entry.error = errorText(e);
        }
      }
      setEntries((prev) => ({ ...prev, [kind]: entry }));
    });
    void Promise.all(jobs).finally(() => setLoading(false));
  }, [agents]);

  useEffect(() => {
    if (!open) return;
    load();
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
    <div className="usage" ref={ref}>
      <button
        className={`usage-trigger${open ? " active" : ""}`}
        title="Usage"
        aria-label="Usage"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
      >
        <ChartBarIcon size={18} />
        <span>Usage</span>
      </button>
      {open && (
        <div className="usage-popup" role="dialog" aria-label="Usage">
          <div className="usage-head">
            <span>Usage</span>
            <button className="btn-icon" title="Refresh" aria-label="Refresh" onClick={load} disabled={loading}>
              <ArrowsClockwiseIcon size={14} className={loading ? "spin" : undefined} />
            </button>
          </div>
          {agents.length === 0 && <div className="usage-note">No agents connected</div>}
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
      : (entry.error ?? usage?.error ?? (usage?.windows.length === 0 ? "No limits reported" : null));
  return (
    <section className="usage-agent">
      <div className="usage-agent-head">
        <ProviderLogos kind={kind} size={14} />
        <span className="usage-agent-name">{AGENT_LABELS[kind]}</span>
        {usage?.plan && <span className="badge">{usage.plan}</span>}
      </div>
      {note && <div className="usage-note">{note}</div>}
      {usage?.windows.map((w) => (
        <div key={w.label} className="usage-window">
          <div className="usage-window-row">
            <span>{w.label}</span>
            <span className="usage-percent">{Math.round(w.usedPercent)}%</span>
          </div>
          <div className="usage-bar">
            <div className={`usage-bar-fill${level(w.usedPercent)}`} style={{ width: `${Math.min(100, w.usedPercent)}%` }} />
          </div>
          {w.resetsAt && <div className="usage-reset">Resets {resetsIn(w.resetsAt)}</div>}
        </div>
      ))}
    </section>
  );
}
