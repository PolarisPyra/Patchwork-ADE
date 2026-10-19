import { useEffect, useState } from "react";
import { CheckIcon, CircleNotchIcon } from "@phosphor-icons/react";
import { api, AGENT_LABELS, type AgentKind, type ImportScan } from "~/api";
import ProviderLogos from "~/components/ProviderLogos";
import { cx } from "~/components/onboarding/classNames";

export type ImportScans = Partial<Record<AgentKind, ImportScan | null>>;

/** Scans each agent's saved conversations; `null` marks a failed scan. */
export function useImportScans(agents: AgentKind[], enabled: boolean) {
  const [scans, setScans] = useState<ImportScans>({});
  const key = agents.join(",");
  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    setScans({});
    for (const kind of agents) {
      api.scanImports(kind).then(
        (scan) => !cancelled && setScans((s) => ({ ...s, [kind]: scan })),
        () => !cancelled && setScans((s) => ({ ...s, [kind]: null })),
      );
    }
    return () => {
      cancelled = true;
    };
    // `key` stands in for `agents`, which is a new array on every render.
  }, [key, enabled]);
  const scanning = agents.some((k) => scans[k] === undefined);
  return { scans, scanning };
}

interface ImportsStepProps {
  agents: AgentKind[];
  scans: ImportScans;
  selected: AgentKind[];
  onToggle: (kind: AgentKind) => void;
  error: string | null;
}

export default function ImportsStep({ agents, scans, selected, onToggle, error }: ImportsStepProps) {
  return (
    <>
      <div className="ob-card-header">
        <span className="ob-card-title">Conversations found on this computer</span>
      </div>
      <div className="ob-option-list" role="group" aria-label="Providers to import from">
        {agents.map((kind) => {
          const scan = scans[kind];
          const importable = (scan?.new ?? 0) > 0;
          const isSelected = importable && selected.includes(kind);
          return (
            <button
              key={kind}
              type="button"
              role="checkbox"
              aria-checked={isSelected}
              disabled={!importable}
              className={cx("ob-option", importable && "is-clickable", isSelected && "is-selected")}
              onClick={() => onToggle(kind)}
            >
              <span className="ob-tile ob-tile-lg">
                <ProviderLogos kind={kind} size={26} />
              </span>
              <span className="ob-option-text">
                <span className="ob-option-name">{AGENT_LABELS[kind]}</span>
                <span className="ob-option-detail">{describeScan(scan)}</span>
              </span>
              <span className="ob-option-trail">
                {scan === undefined && (
                  <span className="badge">
                    <CircleNotchIcon size={12} className="spin" />
                    Scanning…
                  </span>
                )}
                {importable && (
                  <span className={cx("ob-checkbox", isSelected && "is-selected")}>
                    {isSelected && <CheckIcon size={12} weight="bold" />}
                  </span>
                )}
              </span>
            </button>
          );
        })}
      </div>
      {error && <p className="ob-error">{error}</p>}
    </>
  );
}

function describeScan(scan: ImportScan | null | undefined): string {
  if (scan === undefined) return "Looking for saved conversations…";
  if (scan === null) return "Couldn't read saved conversations";
  if (scan.found === 0) return "No saved conversations";
  if (scan.new === 0) return `All ${scan.found} conversations are already imported`;
  const plural = scan.new === 1 ? "conversation" : "conversations";
  return `${scan.new} ${plural} to import, grouped into projects by folder`;
}
