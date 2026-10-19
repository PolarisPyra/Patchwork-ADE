import { CaretRightIcon, CircleNotchIcon, GitBranchIcon } from "@phosphor-icons/react";
import { AGENT_LABELS, type AgentKind, type Project } from "~/api";

interface StatusBarProps {
  project: Project | null;
  branch: string | null;
  changeCount: number;
  agent: AgentKind;
  working: boolean;
  onOpenChanges: () => void;
}

export default function StatusBar({
  project,
  branch,
  changeCount,
  agent,
  working,
  onOpenChanges,
}: StatusBarProps) {
  return (
    <footer className="flex min-w-0 items-center gap-3 border-t border-border bg-app px-2.5 text-[length:var(--fs-xs)] text-fg-muted">
      <div className="flex min-w-0 items-center gap-1 overflow-hidden whitespace-nowrap">
        <span>{project?.name ?? "No project"}</span>
        {branch && (
          <>
            <CaretRightIcon size={12} />
            <GitBranchIcon size={12} />
            <span>{branch}</span>
          </>
        )}
      </div>
      <span className="flex-1" />
      <button
        className="inline-flex h-[18px] cursor-pointer items-center gap-1 rounded-[3px] border-none bg-transparent px-1 hover:bg-hover hover:text-fg"
        onClick={onOpenChanges}
      >
        {changeCount} changes
      </button>
      <span className="inline-flex items-center gap-1">
        {working ? (
          <>
            <CircleNotchIcon size={12} className="spin" />
            {AGENT_LABELS[agent]} working…
          </>
        ) : (
          "Idle"
        )}
      </span>
    </footer>
  );
}
