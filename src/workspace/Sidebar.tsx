import { useEffect, useState, type ReactNode } from "react";
import {
  FolderPlus,
  GitCompareArrows,
  Loader2,
  MessageSquarePlus,
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
  project: Project | null;
  projects: Project[];
  threads: Thread[];
  selectedId: string | null;
  changes: FileChange[];
  onNewTask: () => void;
  /** Starts a chat without a project (switches to the Chats scope). */
  onNewChat: () => void;
  onSelectThread: (id: string) => void;
  onDeleteThread: (id: string) => void;
  /** `null` selects the Chats scope (no project). */
  onSelectProject: (id: string | null) => void;
  onOpenFolder: () => void;
  onRefreshChanges: () => void;
  onOpenChange: (path: string) => void;
}

export default function Sidebar(props: SidebarProps) {
  return (
    <aside className="ws-sidebar">
      {props.view === "tasks" ? <TasksView {...props} /> : <ChangesView {...props} />}
      <div className="ws-agent-cards">
        {props.agents.map((kind) => (
          <AgentCard key={kind} agent={kind} />
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
  project,
  projects,
  threads,
  selectedId,
  onNewTask,
  onNewChat,
  onSelectThread,
  onDeleteThread,
  onSelectProject,
  onOpenFolder,
}: SidebarProps) {
  return (
    <div className="ws-sidebar-scroll">
      <button className="ws-new-task" onClick={onNewTask}>
        <Plus size={14} />
        {project ? "New task" : "New chat"}
        <kbd className="kbd">Ctrl T</kbd>
      </button>

      <SectionLabel>{project ? "Tasks" : "Chats"}</SectionLabel>
      {threads.length === 0 && (
        <div className="ws-muted-note">{project ? "No tasks yet" : "No chats yet"}</div>
      )}
      {threads.map((t) => {
        const last = t.messages[t.messages.length - 1];
        return (
          <div
            key={t.id}
            className={`ws-row${t.id === selectedId ? " selected" : ""}`}
            onClick={() => onSelectThread(t.id)}
          >
            <span className="ws-slot">
              {isWorking(t) && <Loader2 size={13} className="spin ws-icon-accent" />}
            </span>
            <span className="ws-row-title">{t.title}</span>
            <span className="ws-row-time">{formatRelative(last?.createdAt ?? t.createdAt)}</span>
            <button
              className="btn-icon ws-row-delete"
              title="Delete task"
              aria-label="Delete task"
              onClick={(e) => {
                e.stopPropagation();
                onDeleteThread(t.id);
              }}
            >
              <Trash2 size={13} />
            </button>
          </div>
        );
      })}

      <SectionLabel
        action={
          <span className="ws-section-actions">
            <button className="btn-icon" title="New chat without a project" aria-label="New chat" onClick={onNewChat}>
              <MessageSquarePlus size={14} />
            </button>
            <button className="btn-icon" title="Open folder…" aria-label="Open folder" onClick={onOpenFolder}>
              <FolderPlus size={14} />
            </button>
          </span>
        }
      >
        Projects
      </SectionLabel>
      <div className="ws-row" title="Conversations without a project" onClick={() => onSelectProject(null)}>
        <span className={`ws-dot${project ? "" : " active"}`} />
        <span className="ws-row-title">Chats</span>
        <span className="ws-row-time">No project</span>
      </div>
      {projects.map((p) => (
        <div key={p.id} className="ws-row" title={p.path} onClick={() => onSelectProject(p.id)}>
          <span className={`ws-dot${p.id === project?.id ? " active" : ""}`} />
          <span className="ws-row-title">{p.name}</span>
        </div>
      ))}
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

function AgentCard({ agent }: { agent: AgentKind }) {
  const [status, setStatus] = useState<AgentStatus | null | undefined>(undefined);

  // Detect once per agent kind (on mount, and if the default agent changes).
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

  return (
    <div className="ws-agent-card">
      <AgentIcon kind={agent} size={24} />
      <div className="ws-agent-text">
        <div className="ws-agent-name">{AGENT_LABELS[agent]}</div>
        <div className="ws-agent-sub">{describeAgent(status)}</div>
      </div>
    </div>
  );
}
