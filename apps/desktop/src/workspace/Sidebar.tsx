import { useEffect, useState, type ReactNode } from "react";
import {
  FolderPlus,
  GitCompareArrows,
  ChevronRight,
  Folder,
  Loader2,
  MessagesSquare,
  Plus,
  RefreshCw,
  Settings,
  Trash2,
  type LucideIcon,
} from "lucide-react";
import {
  api,
  AGENT_LABELS,
  type AgentKind,
  type AgentStatus,
  type FileChange,
  type Project,
  type Thread,
} from "../api";
import AgentIcon from "../components/AgentIcon";
import { isWorking } from "./useThreads";
import { baseName, describeAgent, dirName, formatRelative } from "./util";

export type SidebarView = "tasks" | "changes";

const STRIPE: { view: SidebarView; label: string; Icon: LucideIcon }[] = [
  { view: "tasks", label: "Tasks", Icon: MessagesSquare },
  { view: "changes", label: "Changes", Icon: GitCompareArrows },
];

const STATUS_LETTER: Record<FileChange["status"], string> = {
  modified: "M",
  added: "A",
  untracked: "U",
  deleted: "D",
  renamed: "R",
};

interface StripeProps {
  view: SidebarView | null;
  onSelect: (view: SidebarView) => void;
  onOpenSettings: () => void;
}

export function ToolStripe({ view, onSelect, onOpenSettings }: StripeProps) {
  return (
    <nav className="ws-stripe">
      {STRIPE.map(({ view: v, label, Icon }) => (
        <button
          key={v}
          className={`ws-stripe-btn${view === v ? " active" : ""}`}
          title={label}
          aria-label={label}
          aria-pressed={view === v}
          onClick={() => onSelect(v)}
        >
          <Icon size={18} />
        </button>
      ))}
      <button
        className="ws-stripe-btn ws-stripe-bottom"
        title="Settings"
        aria-label="Settings"
        onClick={onOpenSettings}
      >
        <Settings size={18} />
      </button>
    </nav>
  );
}

interface SidebarProps {
  view: SidebarView;
  /** Connected agents, shown as status cards at the bottom. */
  agents: AgentKind[];
  /** Project of the current context (null: a chat without a project). */
  project: Project | null;
  projects: Project[];
  /** Every thread; chats without a project and each project's tasks are grouped here. */
  threads: Thread[];
  selectedId: string | null;
  changes: FileChange[];
  /** Starts a new task in the given project. */
  onNewTask: (projectId: string) => void;
  /** Starts a chat without a project. */
  onNewChat: () => void;
  onSelectThread: (id: string) => void;
  onDeleteThread: (id: string) => void;
  onOpenFolder: () => void;
  onRefreshChanges: () => void;
  onOpenChange: (path: string) => void;
}

export default function Sidebar(props: SidebarProps) {
  return (
    <aside className="ws-sidebar">
      {props.view === "tasks" ? <TasksView {...props} /> : <ChangesView {...props} />}
      <div className="ws-agent-logos-bar">
        {props.agents.map((kind) => (
          <AgentLogoBadge key={kind} agent={kind} />
        ))}
      </div>
    </aside>
  );
}

function SectionLabel({ children, action }: { children: ReactNode; action?: ReactNode }) {
  return (
    <div className="ws-section-label">
      <span>{children}</span>
      {action}
    </div>
  );
}

function TasksView({
  projects,
  threads,
  selectedId,
  onNewTask,
  onNewChat,
  onSelectThread,
  onDeleteThread,
  onOpenFolder,
}: SidebarProps) {
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(new Set());
  const toggle = (id: string) =>
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (!next.delete(id)) next.add(id);
      return next;
    });
  const chats = threads.filter((t) => t.projectId === null);
  const rowProps = { selectedId, onSelectThread, onDeleteThread };

  return (
    <div className="ws-sidebar-scroll">
      <button className="ws-new-task" onClick={onNewChat}>
        <Plus size={14} />
        New chat
      </button>

      <SectionLabel>Chats</SectionLabel>
      {chats.length === 0 && <div className="ws-muted-note">No chats yet</div>}
      {chats.map((t) => (
        <ThreadRow key={t.id} thread={t} {...rowProps} />
      ))}

      <SectionLabel
        action={
          <button className="btn-icon" title="Open folder…" aria-label="Open folder" onClick={onOpenFolder}>
            <FolderPlus size={14} />
          </button>
        }
      >
        Projects
      </SectionLabel>
      {projects.length === 0 && <div className="ws-muted-note">No projects yet</div>}
      {projects.map((p) => {
        const open = !collapsed.has(p.id);
        const tasks = threads.filter((t) => t.projectId === p.id);
        return (
          <div key={p.id}>
            <div className="ws-row ws-project-row-tree" title={p.path} onClick={() => toggle(p.id)}>
              <span className="ws-slot">
                <ChevronRight size={13} className={open ? "ws-rotated" : undefined} />
              </span>
              <Folder size={13} className="ws-icon-muted" />
              <span className="ws-row-title">{p.name}</span>
              <button
                className="btn-icon ws-row-action"
                title={`New task in ${p.name}`}
                aria-label={`New task in ${p.name}`}
                onClick={(e) => {
                  e.stopPropagation();
                  onNewTask(p.id);
                }}
              >
                <Plus size={13} />
              </button>
            </div>
            {open && (
              <div className="ws-tree-children">
                {tasks.length === 0 && <div className="ws-muted-note">No tasks yet</div>}
                {tasks.map((t) => (
                  <ThreadRow key={t.id} thread={t} {...rowProps} />
                ))}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

function ThreadRow({
  thread,
  selectedId,
  onSelectThread,
  onDeleteThread,
}: {
  thread: Thread;
  selectedId: string | null;
  onSelectThread: (id: string) => void;
  onDeleteThread: (id: string) => void;
}) {
  const last = thread.messages[thread.messages.length - 1];
  return (
    <div
      className={`ws-row${thread.id === selectedId ? " selected" : ""}`}
      onClick={() => onSelectThread(thread.id)}
    >
      <span className="ws-slot">
        {isWorking(thread) && <Loader2 size={13} className="spin ws-icon-accent" />}
      </span>
      <span className="ws-row-title">{thread.title}</span>
      <span className="ws-row-time">{formatRelative(last?.createdAt ?? thread.createdAt)}</span>
      <button
        className="btn-icon ws-row-delete"
        title="Delete"
        aria-label="Delete"
        onClick={(e) => {
          e.stopPropagation();
          onDeleteThread(thread.id);
        }}
      >
        <Trash2 size={13} />
      </button>
    </div>
  );
}

function ChangesView({ changes, onRefreshChanges, onOpenChange }: SidebarProps) {
  return (
    <>
      <div className="ws-sidebar-head">
        <span>Changes</span>
        <button className="btn-icon" title="Refresh" aria-label="Refresh" onClick={onRefreshChanges}>
          <RefreshCw size={14} />
        </button>
      </div>
      <div className="ws-sidebar-scroll">
        {changes.length === 0 && <div className="ws-muted-note">No changes</div>}
        {changes.map((c) => (
          <button key={c.path} className="ws-row ws-change" title={c.path} onClick={() => onOpenChange(c.path)}>
            <span className={`ws-status ws-status-${c.status}`}>{STATUS_LETTER[c.status]}</span>
            <span className="ws-change-name">
              <span>{baseName(c.path)}</span>
              <span className="ws-change-dir">{dirName(c.path)}</span>
            </span>
            <span className="ws-add">+{c.additions}</span>
            <span className="ws-del">−{c.deletions}</span>
          </button>
        ))}
      </div>
    </>
  );
}

function AgentLogoBadge({ agent }: { agent: AgentKind }) {
  const [status, setStatus] = useState<AgentStatus | null | undefined>(() => api.getCachedAgentStatus(agent));

  useEffect(() => {
    let cancelled = false;
    api.detectAgent(agent).then(
      (s) => {
        if (!cancelled) setStatus(s);
      },
      () => {
        if (!cancelled) setStatus(null);
      },
    );
    return () => {
      cancelled = true;
    };
  }, [agent]);

  const desc = describeAgent(status);
  const title = `${AGENT_LABELS[agent]} · ${desc}`;

  return (
    <div className="ws-agent-logo-badge" title={title} aria-label={title}>
      <AgentIcon kind={agent} size={20} />
      {status?.installed && status?.signedIn && <span className="ws-agent-dot-ready" />}
    </div>
  );
}
