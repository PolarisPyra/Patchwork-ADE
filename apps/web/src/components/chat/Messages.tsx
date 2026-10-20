import { useCallback, useLayoutEffect, useRef, useState } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import {
  ArrowClockwiseIcon,
  ArrowDownIcon,
  CaretRightIcon,
  CheckCircleIcon,
  CheckIcon,
  CircleIcon,
  CircleNotchIcon,
  GitDiffIcon,
  ShieldWarningIcon,
  XCircleIcon,
} from "@phosphor-icons/react";
import {
  AGENT_LABELS,
  type AgentKind,
  type Approval,
  type FileChange,
  type Message,
  type MessageStatus,
  type PlanStep,
  type StepStatus,
  type Thread,
  type ToolCall,
} from "~/api";
import type { CanvasTab } from "~/components/canvas/Canvas";
import AttachmentChip, { AttachmentTile } from "~/components/chat/AttachmentChip";
import Markdown, { ACTION_CLASS, CopyButton } from "~/components/chat/Markdown";
import { formatClock } from "~/lib/util";

type OpenCanvas = (path: string, message: Message | null, tab: CanvasTab) => void;

interface MessagesProps {
  thread: Thread;
  changes: FileChange[];
  busy: boolean;
  /** Omitted for chats without a project: the change summary is hidden. */
  onOpenCanvas?: OpenCanvas;
  /** Opens the sidebar's Changes view. */
  onShowChanges: (paths: string[]) => void;
  onRetry: (message: Message) => void;
  /** Answers a pending approval in the running turn. */
  onRespond: (approvalId: string, allow: boolean) => void;
}

export default function Messages({
  thread,
  changes,
  busy,
  onOpenCanvas,
  onShowChanges,
  onRetry,
  onRespond,
}: MessagesProps) {
  const { messages } = thread;
  const parentRef = useRef<HTMLDivElement>(null);
  const [atEnd, setAtEnd] = useState(true);

  // Only the rows on screen are rendered. The list stays pinned to the newest message
  // while a reply streams in, unless the reader has scrolled up to read history.
  const virtualizer = useVirtualizer({
    count: messages.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => 120,
    getItemKey: useCallback((index: number) => messages[index]!.id, [messages]),
    anchorTo: "end",
    followOnAppend: true,
    scrollEndThreshold: 80,
    overscan: 6,
    onChange: (instance) => setAtEnd(instance.isAtEnd()),
  });

  // Jump to the newest message when the reader sends one, as most chat apps do.
  const lastUserMessageId = [...messages].reverse().find((m) => m.role === "user")?.id;
  useLayoutEffect(() => {
    virtualizer.scrollToEnd();
  }, [lastUserMessageId, virtualizer]);

  return (
    <div className="relative flex min-h-0 flex-1 flex-col">
      <div ref={parentRef} className="min-h-0 flex-1 overflow-y-auto py-6">
        <div
          ref={virtualizer.containerRef}
          className="relative mx-auto max-w-[820px] px-6"
          style={{ height: virtualizer.getTotalSize() }}
        >
          {virtualizer.getVirtualItems().map((item) => {
            const message = messages[item.index]!;
            return (
              <div
                key={item.key}
                ref={virtualizer.measureElement}
                data-index={item.index}
                className="absolute top-0 left-0 w-full px-6 pb-5"
              >
                {message.role === "user" ? (
                  <UserMessage message={message} />
                ) : (
                  <AssistantMessage
                    message={message}
                    agent={thread.agent}
                    changes={changes}
                    retryMessage={
                      messages[item.index - 1]?.role === "user" ? messages[item.index - 1]! : null
                    }
                    busy={busy}
                    onOpenCanvas={onOpenCanvas}
                    onShowChanges={onShowChanges}
                    onRetry={onRetry}
                    onRespond={onRespond}
                  />
                )}
              </div>
            );
          })}
        </div>
      </div>
      {!atEnd && (
        <button
          type="button"
          className="absolute bottom-3 left-1/2 grid h-8 w-8 -translate-x-1/2 cursor-pointer place-items-center rounded-full border border-border bg-panel text-fg shadow-[var(--shadow-popup)] hover:bg-hover"
          aria-label="Jump to latest message"
          onClick={() => virtualizer.scrollToEnd({ behavior: "smooth" })}
        >
          <ArrowDownIcon size={14} />
        </button>
      )}
    </div>
  );
}

function UserMessage({ message }: { message: Message }) {
  return (
    <div className="flex max-w-[75%] flex-col items-end gap-1 self-end">
      <div className="px-2 text-[length:var(--fs-xs)] text-fg-subtle">
        You · {formatClock(message.createdAt)}
      </div>
      {message.attachments.length > 0 && (
        <div className="flex flex-wrap justify-end gap-1.5">
          {message.attachments.map((a) =>
            a.kind === "image" ? (
              <AttachmentTile key={a.path} attachment={a} />
            ) : (
              <AttachmentChip key={a.path} attachment={a} />
            ),
          )}
        </div>
      )}
      {message.text && (
        <div className="rounded-[12px] bg-[color-mix(in_srgb,var(--text)_10%,var(--bg-editor))] px-4 py-2.5 leading-[1.55] whitespace-pre-wrap text-fg [word-break:break-word] selectable">
          {message.text}
        </div>
      )}
    </div>
  );
}

interface AssistantProps {
  message: Message;
  agent: AgentKind;
  changes: FileChange[];
  retryMessage: Message | null;
  busy: boolean;
  onOpenCanvas?: OpenCanvas;
  onShowChanges: (paths: string[]) => void;
  onRetry: (message: Message) => void;
  onRespond: (approvalId: string, allow: boolean) => void;
}

function AssistantMessage({
  message,
  agent,
  changes,
  retryMessage,
  busy,
  onOpenCanvas,
  onShowChanges,
  onRetry,
  onRespond,
}: AssistantProps) {
  const streaming = message.status === "streaming";
  return (
    <section className="flex min-w-0 flex-col gap-2.5">
      <header className="flex items-center gap-2">
        <span className="text-[length:var(--fs-xs)] font-semibold tracking-[0.05em] text-fg-muted uppercase">
          {AGENT_LABELS[agent]}
        </span>
        <StatusBadge status={message.status} />
      </header>
      {message.text && <Markdown text={message.text} />}
      {message.plan.length > 0 && <PlanList steps={message.plan} />}
      {message.tools.some((t) => !t.parent) && (
        <ToolActivity tools={message.tools.filter((t) => !t.parent)} />
      )}
      {message.approvals.map((approval) => (
        <ApprovalCard key={approval.id} approval={approval} onRespond={onRespond} />
      ))}
      {onOpenCanvas && message.files.length > 0 && (
        <ChangeSummary
          paths={message.files}
          changes={changes}
          onShow={() => onShowChanges(message.files)}
        />
      )}
      {message.error && (
        <div className="rounded-[var(--radius)] bg-[var(--danger-soft)] px-3 py-2 text-[length:var(--fs-sm)] whitespace-pre-wrap text-danger [word-break:break-word]">
          {message.error}
        </div>
      )}
      {!streaming && (
        <div className="flex gap-1">
          <CopyButton text={message.text} />
          {retryMessage !== null && (
            <button className={ACTION_CLASS} disabled={busy} onClick={() => onRetry(retryMessage)}>
              <ArrowClockwiseIcon size={13} /> Retry
            </button>
          )}
          <span className="ml-1.5 inline-flex h-6 items-center text-[length:var(--fs-xs)] text-fg-muted">
            {formatClock(message.createdAt)}
          </span>
        </div>
      )}
    </section>
  );
}

function ApprovalCard({
  approval,
  onRespond,
}: {
  approval: Approval;
  onRespond: (approvalId: string, allow: boolean) => void;
}) {
  const { id, title, detail, status } = approval;
  return (
    <div
      className={`flex flex-col gap-2 rounded-[var(--radius)] border bg-panel px-3 py-2.5 text-[length:var(--fs-sm)] ${status === "pending" ? "border-warning" : "border-border-strong"}`}
    >
      <div
        className={`flex items-center gap-1.5 ${status === "pending" ? "text-warning" : status === "allowed" ? "text-success" : "text-danger"}`}
      >
        {status === "pending" ? (
          <ShieldWarningIcon size={15} />
        ) : status === "allowed" ? (
          <CheckCircleIcon size={15} />
        ) : (
          <XCircleIcon size={15} />
        )}
        <span className="font-semibold text-fg">{title}</span>
        {status !== "pending" && (
          <span className="ml-auto">{status === "allowed" ? "Allowed" : "Denied"}</span>
        )}
      </div>
      {detail && (
        <code className="rounded-[var(--radius-sm)] bg-editor px-2 py-1.5 font-[family-name:var(--font-mono)] break-all whitespace-pre-wrap selectable">
          {detail}
        </code>
      )}
      {status === "pending" && (
        <div className="flex justify-end gap-1.5">
          <button className="btn" onClick={() => onRespond(id, false)}>
            Deny
          </button>
          <button className="btn btn-primary" onClick={() => onRespond(id, true)}>
            Allow
          </button>
        </div>
      )}
    </div>
  );
}

function StatusBadge({ status }: { status: MessageStatus }) {
  switch (status) {
    case "streaming":
      return (
        <span className="badge badge-accent">
          <CircleNotchIcon size={12} className="spin" />
          Working…
        </span>
      );
    case "complete":
      return (
        <span className="badge badge-accent">
          <CheckIcon size={12} />
          Task complete
        </span>
      );
    case "error":
      return <span className="badge badge-danger">Failed</span>;
    case "cancelled":
      return <span className="badge">Stopped</span>;
  }
}

function StepIcon({ status }: { status: StepStatus }) {
  switch (status) {
    case "done":
      return <CheckIcon size={14} className="mt-0.5 flex-none text-accent-text" />;
    case "running":
      return <CircleNotchIcon size={14} className="mt-0.5 flex-none spin text-accent-text" />;
    case "error":
      return <XCircleIcon size={14} className="mt-0.5 flex-none text-danger" />;
    case "pending":
      return <CircleIcon size={14} className="mt-0.5 flex-none text-fg-subtle" />;
  }
}

function PlanList({ steps }: { steps: PlanStep[] }) {
  return (
    <ol className="m-0 flex list-none flex-col gap-1.5 rounded-[var(--radius)] border border-border bg-panel px-3 py-2.5">
      {steps.map((step, i) => (
        <li key={i} className="flex items-start gap-2">
          <StepIcon status={step.status} />
          <span>{step.text}</span>
        </li>
      ))}
    </ol>
  );
}

function ToolActivity({ tools }: { tools: ToolCall[] }) {
  const [open, setOpen] = useState(false);
  return (
    <div>
      <button
        className="inline-flex cursor-pointer items-center gap-1 self-start rounded-[var(--radius-sm)] border-none bg-transparent px-1 py-0.5 text-[length:var(--fs-sm)] text-fg-muted hover:bg-hover hover:text-fg"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
      >
        <CaretRightIcon size={14} className={open ? "rotate-90" : undefined} />
        {tools.length} {tools.length === 1 ? "action" : "actions"}
      </button>
      {open && (
        <ul className="m-0 mt-1 flex list-none flex-col gap-1 border-l-2 border-border px-2 py-1.5 font-[family-name:var(--font-mono)] text-[12px]">
          {tools.map((tool) => (
            <li key={tool.id} className="flex min-w-0 items-center gap-2 [&>svg]:mt-0">
              <StepIcon status={tool.status} />
              <span className="flex-none font-semibold">{tool.name}</span>
              <span className="min-w-0 overflow-hidden text-ellipsis whitespace-nowrap text-fg-muted">
                {tool.summary}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** One line for the files a message touched; the list itself lives in the Changes view. */
function ChangeSummary({
  paths,
  changes,
  onShow,
}: {
  paths: string[];
  changes: FileChange[];
  onShow: () => void;
}) {
  const found = changes.filter((c) => paths.includes(c.path));
  const additions = found.reduce((sum, c) => sum + c.additions, 0);
  const deletions = found.reduce((sum, c) => sum + c.deletions, 0);
  return (
    <div className="flex items-center gap-3 rounded-[var(--radius)] border border-border bg-panel px-3 py-2 text-[length:var(--fs-sm)]">
      <GitDiffIcon size={14} className="flex-none text-fg-muted" />
      <span>
        {paths.length} {paths.length === 1 ? "file" : "files"} changed
      </span>
      {found.length > 0 && (
        <>
          <span className="text-success">+{additions}</span>
          <span className="text-danger">−{deletions}</span>
        </>
      )}
      <span className="flex-1" />
      <button className="btn" onClick={onShow}>
        Show changes
      </button>
    </div>
  );
}
