import { CaretRightIcon, CircleNotchIcon, GitBranchIcon } from "@phosphor-icons/react";
import { AGENT_LABELS, type AgentKind, type Project } from "~/api";

interface StatusBarProps {
  project: Project | null;
  branch: string | null;
  changeCount: number;
  agent: AgentKind;
  working: boolean;
  resolvedTheme: "light" | "dark";
  onOpenChanges: () => void;
}

export default function StatusBar({
  project,
  branch,
  changeCount,
  agent,
  working,
  resolvedTheme,
  onOpenChanges,
}: StatusBarProps) {
  return (
    <footer className="ws-statusbar">
      <div className="ws-crumbs">
        <span>{project?.name ?? "No project"}</span>
        {branch && (
          <>
            <CaretRightIcon size={12} />
            <GitBranchIcon size={12} />
            <span>{branch}</span>
          </>
        )}
      </div>
      <span className="ws-spacer" />
      <button className="ws-status-link" onClick={onOpenChanges}>
        {changeCount} changes
      </button>
      <span className="ws-status-agent">
        {working ? (
          <>
            <CircleNotchIcon size={12} className="spin" />
            {AGENT_LABELS[agent]} working…
          </>
        ) : (
          "Idle"
        )}
      </span>
      <span>{resolvedTheme === "dark" ? "Dark" : "Light"}</span>
    </footer>
  );
}
