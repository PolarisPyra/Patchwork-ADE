import { ShieldWarningIcon } from "@phosphor-icons/react";
import type { Approval } from "~/api";

interface PendingApprovalBannerProps {
  /** Approvals waiting for an answer, oldest first. Only the first is shown. */
  approvals: Approval[];
  onRespond: (approvalId: string, allow: boolean) => void;
}

/** The tool approval the agent is waiting on, above the composer, with Allow and Deny. */
export default function PendingApprovalBanner({
  approvals,
  onRespond,
}: PendingApprovalBannerProps) {
  const [approval] = approvals;
  if (!approval) return null;
  const { id, title, detail } = approval;
  return (
    <div className="mb-1.5 flex flex-col gap-2 rounded-[var(--radius)] border border-warning bg-panel p-2.5 text-[length:var(--fs-sm)]">
      <div className="flex items-center gap-1.5 text-warning">
        <ShieldWarningIcon size={15} />
        <span className="min-w-0 truncate font-semibold text-fg">{title}</span>
        {approvals.length > 1 && (
          <span className="ml-auto flex-none text-fg-muted tabular-nums">1/{approvals.length}</span>
        )}
      </div>
      {detail && (
        <code className="max-h-40 overflow-auto rounded-[var(--radius-sm)] bg-editor px-2 py-1.5 font-[family-name:var(--font-mono)] break-all whitespace-pre-wrap selectable">
          {detail}
        </code>
      )}
      <div className="flex justify-end gap-1.5">
        <button className="btn" onClick={() => onRespond(id, false)}>
          Deny
        </button>
        <button className="btn btn-primary" onClick={() => onRespond(id, true)}>
          Allow
        </button>
      </div>
    </div>
  );
}
