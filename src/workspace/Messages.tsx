import { useState } from "react";
import {
  Check,
  ChevronRight,
  Circle,
  CircleX,
  Code2,
  Loader2,
  PanelRight,
  RotateCw,
} from "lucide-react";
import {
  AGENT_LABELS,
  type AgentKind,
  type FileChange,
  type Message,
  type MessageStatus,
  type PlanStep,
  type StepStatus,
  type Thread,
  type ToolCall,
} from "../api";
import type { CanvasTab } from "./canvas/Canvas";
import Markdown, { CopyButton } from "./Markdown";
import { baseName, formatClock, languageLabel } from "./util";

type OpenCanvas = (path: string, message: Message | null, tab: CanvasTab) => void;

interface MessagesProps {
  thread: Thread;
  changes: FileChange[];
  busy: boolean;
  onOpenCanvas: OpenCanvas;
  onRetry: (text: string) => void;
}

export default function Messages({ thread, changes, busy, onOpenCanvas, onRetry }: MessagesProps) {
  const { messages } = thread;
  return (
    <div className="ws-messages">
      {messages.map((message, i) =>
        message.role === "user" ? (
          <UserMessage key={message.id} message={message} />
        ) : (
          <AssistantMessage
            key={message.id}
            message={message}
            agent={thread.agent}
            changes={changes}
            retryText={messages[i - 1]?.role === "user" ? messages[i - 1].text : null}
            busy={busy}
            onOpenCanvas={onOpenCanvas}
            onRetry={onRetry}
          />
        ),
      )}
    </div>
  );
}

function UserMessage({ message }: { message: Message }) {
  return (
    <div className="ws-user">
      <div className="ws-user-bubble selectable">{message.text}</div>
      <div className="ws-user-meta">You · {formatClock(message.createdAt)}</div>
    </div>
  );
}

interface AssistantProps {
  message: Message;
  agent: AgentKind;
  changes: FileChange[];
  retryText: string | null;
  busy: boolean;
  onOpenCanvas: OpenCanvas;
  onRetry: (text: string) => void;
}

function AssistantMessage({
  message,
  agent,
  changes,
  retryText,
  busy,
  onOpenCanvas,
  onRetry,
}: AssistantProps) {
  const streaming = message.status === "streaming";
  return (
    <section className="ws-assistant">
      <header className="ws-assistant-head">
        <span className="ws-assistant-agent">{AGENT_LABELS[agent]}</span>
        <StatusBadge status={message.status} />
        <span className="ws-assistant-time">{formatClock(message.createdAt)}</span>
      </header>
      {message.text && <Markdown text={message.text} />}
      {message.plan.length > 0 && <PlanList steps={message.plan} />}
      {message.tools.length > 0 && <ToolActivity tools={message.tools} />}
      {message.files.map((path) => (
        <FileCard
          key={path}
          path={path}
          change={changes.find((c) => c.path === path)}
          onOpen={() => onOpenCanvas(path, message, "code")}
        />
      ))}
      {message.error && <div className="ws-error-box">{message.error}</div>}
      {!streaming && (
        <div className="ws-actions">
          <CopyButton text={message.text} />
          {retryText !== null && (
            <button className="ws-action" disabled={busy} onClick={() => onRetry(retryText)}>
              <RotateCw size={13} /> Retry
            </button>
          )}
        </div>
      )}
    </section>
  );
}

function StatusBadge({ status }: { status: MessageStatus }) {
  switch (status) {
    case "streaming":
      return (
        <span className="badge badge-accent">
          <Loader2 size={12} className="spin" />
          Working…
        </span>
      );
    case "complete":
      return (
        <span className="badge badge-accent">
          <Check size={12} />
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
      return <Check size={14} className="ws-step ws-icon-accent" />;
    case "running":
      return <Loader2 size={14} className="ws-step spin ws-icon-accent" />;
    case "error":
      return <CircleX size={14} className="ws-step ws-icon-danger" />;
    case "pending":
      return <Circle size={14} className="ws-step ws-icon-muted" />;
  }
}

function PlanList({ steps }: { steps: PlanStep[] }) {
  return (
    <ol className="ws-plan">
      {steps.map((step, i) => (
        <li key={i}>
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
    <div className="ws-tools">
      <button className="ws-tools-toggle" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
        <ChevronRight size={14} className={open ? "ws-rotated" : undefined} />
        {tools.length} {tools.length === 1 ? "action" : "actions"}
      </button>
      {open && (
        <ul className="ws-tool-list">
          {tools.map((tool) => (
            <li key={tool.id} className="ws-tool-row">
              <StepIcon status={tool.status} />
              <span className="ws-tool-name">{tool.name}</span>
              <span className="ws-tool-summary">{tool.summary}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function FileCard({
  path,
  change,
  onOpen,
}: {
  path: string;
  change: FileChange | undefined;
  onOpen: () => void;
}) {
  return (
    <div className="ws-file-card">
      <div className="ws-file-icon">
        <Code2 size={20} />
      </div>
      <div className="ws-file-info">
        <div className="ws-file-name" title={path}>
          {baseName(path)}
        </div>
        <div className="ws-file-meta">
          <span>{languageLabel(path)}</span>
          {change && (
            <>
              <span className="ws-add">+{change.additions}</span>
              <span className="ws-del">−{change.deletions}</span>
            </>
          )}
        </div>
      </div>
      <button className="btn" onClick={onOpen}>
        <PanelRight size={14} />
        Open canvas
      </button>
    </div>
  );
}
