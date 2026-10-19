import { Check, LoaderCircle, RotateCw } from "lucide-react";
import { AGENT_LABELS, type AgentKind } from "../api";
import AgentIcon from "../components/AgentIcon";
import { cx } from "./classNames";
import { AGENT_KINDS, isReady, type AgentProbe, type AgentProbes } from "./agentProbes";

interface AgentStepProps {
  probes: AgentProbes;
  checking: boolean;
  selected: AgentKind[];
  onToggle: (kind: AgentKind) => void;
  onRecheck: () => void;
}

export default function AgentStep({ probes, checking, selected, onToggle, onRecheck }: AgentStepProps) {
  return (
    <>
      <div className="ob-card-header">
        <span className="ob-card-title">Available coding agents</span>
        <button type="button" className="link ob-recheck" disabled={checking} onClick={onRecheck}>
          <RotateCw size={14} className={checking ? "spin" : undefined} />
          Check again
        </button>
      </div>
      <div className="ob-option-list" role="group" aria-label="Coding agents">
        {AGENT_KINDS.map((kind) => (
          <AgentRow
            key={kind}
            kind={kind}
            probe={probes[kind]}
            selected={selected.includes(kind)}
            onToggle={onToggle}
          />
        ))}
      </div>
    </>
  );
}

function AgentRow({
  kind,
  probe,
  selected,
  onToggle,
}: {
  kind: AgentKind;
  probe: AgentProbe;
  selected: boolean;
  onToggle: (kind: AgentKind) => void;
}) {
  const ready = isReady(probe);
  return (
    <button
      type="button"
      role="checkbox"
      aria-checked={selected}
      disabled={!ready}
      className={cx("ob-option", ready && "is-clickable", selected && "is-selected")}
      onClick={() => onToggle(kind)}
    >
      <span className="ob-tile ob-tile-lg">
        <AgentIcon kind={kind} size={26} />
      </span>
      <span className="ob-option-text">
        <span className="ob-option-name">{AGENT_LABELS[kind]}</span>
        <span className="ob-option-detail">{probe.status?.detail ?? ""}</span>
      </span>
      <span className="ob-option-trail">
        <StatusBadge probe={probe} />
        {ready && <span className={cx("ob-checkbox", selected && "is-selected")}>{selected && <Check size={12} strokeWidth={3} />}</span>}
      </span>
    </button>
  );
}

function StatusBadge({ probe }: { probe: AgentProbe }) {
  if (probe.checking) {
    return (
      <span className="badge">
        <LoaderCircle size={12} className="spin" />
        Checking…
      </span>
    );
  }
  const { status } = probe;
  if (!status) return <span className="badge">Check failed</span>;
  if (!status.installed) return <span className="badge">Not installed</span>;
  if (!status.signedIn) return <span className="badge badge-danger">Not signed in</span>;
  return (
    <span className="badge badge-success">
      {status.version ? `Ready · v${status.version}` : "Ready"}
    </span>
  );
}
