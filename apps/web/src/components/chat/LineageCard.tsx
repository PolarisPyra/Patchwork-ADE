import { useState } from "react";
import { CaretDownIcon, TreeStructureIcon } from "@phosphor-icons/react";
import { AGENT_LABELS, type StepStatus, type Thread, type ToolCall } from "~/api";
import ProviderLogos from "~/components/ProviderLogos";

const DOT_COLOR: Record<StepStatus, string> = {
  pending: "bg-fg-subtle",
  running: "bg-accent animate-pulse",
  done: "bg-success",
  error: "bg-danger",
};

/** The subagents the agent started in its latest turn that started any. */
function latestSubagents(thread: Thread): ToolCall[] {
  const turn = [...thread.messages].reverse().find((m) => m.tools.some((t) => t.subagent));
  return turn?.tools.filter((t) => t.subagent) ?? [];
}

/** Parent agent on top, the subagents it spawned below, each with its model and status. */
export default function LineageCard({ thread, working }: { thread: Thread; working: boolean }) {
  const [open, setOpen] = useState(true);
  const subagents = latestSubagents(thread);
  if (subagents.length === 0) return null;

  return (
    <div className="absolute top-3 right-4 z-10 w-[260px] rounded-[var(--radius-lg)] border border-border bg-panel text-[length:var(--fs-sm)] shadow-[var(--shadow-popup)]">
      <button
        className="flex w-full cursor-pointer items-center gap-2 border-none bg-transparent px-3 py-2 text-fg"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
      >
        <TreeStructureIcon size={14} className="flex-none text-fg-muted" />
        <span className="flex-1 text-left font-semibold">Lineage</span>
        <span className="text-fg-subtle">{subagents.length} subagents</span>
        <CaretDownIcon size={12} className={open ? undefined : "-rotate-90"} />
      </button>
      {open && (
        <div className="flex flex-col gap-2 px-3 pb-3">
          <div className="flex items-center gap-2 rounded-[var(--radius)] bg-hover px-2 py-1.5">
            <ProviderLogos kind={thread.agent} size={14} />
            <span className="flex-1 truncate font-semibold">{AGENT_LABELS[thread.agent]}</span>
            <span className="truncate text-fg-muted">{thread.model ?? "default model"}</span>
            <span
              className={`h-2 w-2 flex-none rounded-full ${working ? DOT_COLOR.running : DOT_COLOR.done}`}
            />
          </div>
          <div className="ml-3 flex flex-col gap-1.5 border-l-2 border-border pl-3">
            {subagents.map((tool) => (
              <div key={tool.id} className="flex min-w-0 flex-col gap-0.5">
                <div className="flex items-center gap-2">
                  <span className={`h-2 w-2 flex-none rounded-full ${DOT_COLOR[tool.status]}`} />
                  <span className="flex-1 truncate font-medium">{tool.subagent?.kind}</span>
                  <span className="truncate text-fg-muted">
                    {tool.subagent?.model ?? "inherits"}
                  </span>
                </div>
                {tool.subagent?.description && (
                  <div className="truncate pl-4 text-fg-subtle" title={tool.subagent.description}>
                    {tool.subagent.description}
                  </div>
                )}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
