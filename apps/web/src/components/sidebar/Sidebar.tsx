import { useRef, useState, type KeyboardEvent, type MouseEvent, type ReactNode } from "react";
import {
  ArrowsClockwiseIcon,
  CaretRightIcon,
  ChatsIcon,
  CircleNotchIcon,
  FolderIcon,
  FolderPlusIcon,
  GearSixIcon,
  GitDiffIcon,
  MagnifyingGlassIcon,
  PencilSimpleIcon,
  PlusIcon,
  ShieldWarningIcon,
  TrashIcon,
  type Icon,
} from "@phosphor-icons/react";
import { AGENT_LABELS, type AgentKind, type FileChange, type Project, type Thread } from "~/api";
import ProviderLogos from "~/components/ProviderLogos";
import ContextMenu, { type MenuItem } from "~/components/sidebar/ContextMenu";
import UsagePopover from "~/components/usage/UsagePopover";
import { isWorking } from "~/hooks/useThreads";
import { baseName, dirName, displayTitle, formatRelative } from "~/lib/util";

export type SidebarView = "tasks" | "changes";

const STRIPE: { view: SidebarView; label: string; Icon: Icon }[] = [
  { view: "tasks", label: "Tasks", Icon: ChatsIcon },
  { view: "changes", label: "Changes", Icon: GitDiffIcon },
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
        <GearSixIcon size={18} />
      </button>
    </nav>
  );
}

interface SidebarProps {
  view: SidebarView;
  /** Connected agents, whose usage the footer shows. */
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
  onRenameThread: (id: string, title: string) => void;
  onRenameProject: (id: string, name: string) => void;
  onRemoveProject: (id: string) => void;
  onOpenFolder: () => void;
  onRefreshChanges: () => void;
  onOpenChange: (path: string) => void;
  /** Opens the command palette. */
  onOpenPalette: () => void;
}

/** A row a context menu acts on: a project, or a task or chat. */
interface Target {
  kind: "project" | "thread";
  id: string;
}

export default function Sidebar(props: SidebarProps) {
  return (
    <aside className="ws-sidebar">
      <button className="ws-sidebar-search" onClick={props.onOpenPalette}>
        <MagnifyingGlassIcon size={16} />
        Search…
        <kbd className="kbd">Ctrl K</kbd>
      </button>
      {props.view === "tasks" ? <TasksView {...props} /> : <ChangesView {...props} />}
      <UsagePopover agents={props.agents} />
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
  onRenameThread,
  onRenameProject,
  onRemoveProject,
  onOpenFolder,
}: SidebarProps) {
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(new Set());
  const [menu, setMenu] = useState<{ x: number; y: number; target: Target } | null>(null);
  const [renaming, setRenaming] = useState<Target | null>(null);
  const toggle = (id: string) =>
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (!next.delete(id)) next.add(id);
      return next;
    });
  const chats = threads.filter((t) => t.projectId === null);

  const openMenu = (e: MouseEvent, target: Target) => {
    e.preventDefault();
    setMenu({ x: e.clientX, y: e.clientY, target });
  };
  const menuItems = (target: Target): MenuItem[] => [
    { label: "Rename", Icon: PencilSimpleIcon, onSelect: () => setRenaming(target) },
    {
      label: "Remove",
      Icon: TrashIcon,
      danger: true,
      onSelect: () => {
        if (target.kind === "thread") {
          onDeleteThread(target.id);
          return;
        }
        const name = projects.find((p) => p.id === target.id)?.name ?? "this project";
        if (window.confirm(`Remove ${name} and its tasks? Its files are not deleted.`)) {
          onRemoveProject(target.id);
        }
      },
    },
  ];
  /** Saves a new name, unless it is blank or unchanged. */
  const commitRename = (target: Target, name: string, current: string) => {
    setRenaming(null);
    const trimmed = name.trim();
    if (!trimmed || trimmed === current) return;
    if (target.kind === "thread") onRenameThread(target.id, trimmed);
    else onRenameProject(target.id, trimmed);
  };
  const rowProps = {
    selectedId,
    onSelectThread,
    onDeleteThread,
    renaming,
    onContextMenu: openMenu,
    onCommitRename: commitRename,
    onCancelRename: () => setRenaming(null),
  };

  return (
    <div className="ws-sidebar-scroll">
      <SectionLabel
        action={
          <button className="btn-icon" title="New chat" aria-label="New chat" onClick={onNewChat}>
            <PlusIcon size={16} />
          </button>
        }
      >
        Chats
      </SectionLabel>
      {chats.length === 0 && <div className="ws-muted-note">No chats yet</div>}
      {chats.map((t) => (
        <ThreadRow key={t.id} thread={t} {...rowProps} />
      ))}
      {menu && (
        <ContextMenu
          x={menu.x}
          y={menu.y}
          items={menuItems(menu.target)}
          onClose={() => setMenu(null)}
        />
      )}

      <SectionLabel
        action={
          <button
            className="btn-icon"
            title="Open folder…"
            aria-label="Open folder"
            onClick={onOpenFolder}
          >
            <FolderPlusIcon size={16} />
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
            <div
              className="ws-row ws-project-row-tree"
              title={p.path}
              onClick={() => toggle(p.id)}
              onContextMenu={(e) => openMenu(e, { kind: "project", id: p.id })}
            >
              <span className="ws-slot">
                <CaretRightIcon size={15} className={open ? "ws-rotated" : undefined} />
              </span>
              <FolderIcon size={15} className="ws-icon-muted" />
              {renaming?.kind === "project" && renaming.id === p.id ? (
                <InlineName
                  initial={p.name}
                  onCommit={(name) => commitRename({ kind: "project", id: p.id }, name, p.name)}
                  onCancel={() => setRenaming(null)}
                />
              ) : (
                <span className="ws-row-title">{p.name}</span>
              )}
              <button
                className="btn-icon ws-row-action"
                title={`New task in ${p.name}`}
                aria-label={`New task in ${p.name}`}
                onClick={(e) => {
                  e.stopPropagation();
                  onNewTask(p.id);
                }}
              >
                <PlusIcon size={15} />
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

/** Name field shown in place of a title while renaming. Commits once, on Enter or blur. */
function InlineName({
  initial,
  onCommit,
  onCancel,
}: {
  initial: string;
  onCommit: (name: string) => void;
  onCancel: () => void;
}) {
  // Enter, Escape and the blur that follows them must not each act.
  const done = useRef(false);
  const finish = (action: () => void) => {
    if (done.current) return;
    done.current = true;
    action();
  };
  const keyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    e.stopPropagation();
    if (e.key === "Enter") finish(() => onCommit(e.currentTarget.value));
    else if (e.key === "Escape") finish(onCancel);
  };
  return (
    <input
      className="ws-inline-name"
      aria-label="Name"
      defaultValue={initial}
      autoFocus
      onClick={(e) => e.stopPropagation()}
      onContextMenu={(e) => e.stopPropagation()}
      onKeyDown={keyDown}
      onBlur={(e) => finish(() => onCommit(e.currentTarget.value))}
    />
  );
}

function ThreadRow({
  thread,
  selectedId,
  onSelectThread,
  onDeleteThread,
  renaming,
  onContextMenu,
  onCommitRename,
  onCancelRename,
}: {
  thread: Thread;
  selectedId: string | null;
  onSelectThread: (id: string) => void;
  onDeleteThread: (id: string) => void;
  renaming: Target | null;
  onContextMenu: (e: MouseEvent, target: Target) => void;
  onCommitRename: (target: Target, name: string, current: string) => void;
  onCancelRename: () => void;
}) {
  const editing = renaming?.kind === "thread" && renaming.id === thread.id;
  const last = thread.messages[thread.messages.length - 1];
  const needsApproval = last?.approvals.some((a) => a.status === "pending") ?? false;
  return (
    <div
      className={`ws-row ws-thread-card${thread.id === selectedId ? " selected" : ""}`}
      onClick={() => onSelectThread(thread.id)}
      onContextMenu={(e) => onContextMenu(e, { kind: "thread", id: thread.id })}
    >
      <div className="ws-card-line">
        {editing ? (
          <InlineName
            initial={thread.title}
            onCommit={(name) =>
              onCommitRename({ kind: "thread", id: thread.id }, name, thread.title)
            }
            onCancel={onCancelRename}
          />
        ) : (
          <span className="ws-row-title">{displayTitle(thread.title)}</span>
        )}
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
          <TrashIcon size={14} />
        </button>
      </div>
      <div className="ws-card-line ws-card-foot">
        {needsApproval ? (
          <span title="Waiting for approval" className="ws-card-status ws-icon-warning">
            <ShieldWarningIcon size={15} />
          </span>
        ) : (
          isWorking(thread) && (
            <span title="Working" className="ws-card-status">
              <CircleNotchIcon size={15} className="spin ws-icon-accent" />
            </span>
          )
        )}
        <span className="ws-card-logo" title={AGENT_LABELS[thread.agent]}>
          <ProviderLogos kind={thread.agent} size={14} />
        </span>
      </div>
    </div>
  );
}

function ChangesView({ changes, onRefreshChanges, onOpenChange }: SidebarProps) {
  return (
    <>
      <div className="ws-sidebar-head">
        <span>Changes</span>
        <button
          className="btn-icon"
          title="Refresh"
          aria-label="Refresh"
          onClick={onRefreshChanges}
        >
          <ArrowsClockwiseIcon size={16} />
        </button>
      </div>
      <div className="ws-sidebar-scroll">
        {changes.length === 0 && <div className="ws-muted-note">No changes</div>}
        {changes.map((c) => (
          <button
            key={c.path}
            className="ws-row ws-change"
            title={c.path}
            onClick={() => onOpenChange(c.path)}
          >
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
