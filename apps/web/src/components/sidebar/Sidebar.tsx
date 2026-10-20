import { useRef, useState, type KeyboardEvent, type MouseEvent, type ReactNode } from "react";
import {
  ArrowCounterClockwiseIcon,
  ArrowsClockwiseIcon,
  CaretRightIcon,
  CheckIcon,
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
import {
  AGENT_LABELS,
  api,
  type AgentKind,
  type FileChange,
  type Project,
  type Thread,
} from "~/api";
import { confirm } from "@tauri-apps/plugin-dialog";
import ProviderLogos from "~/components/ProviderLogos";
import ContextMenu, { type MenuItem } from "~/components/sidebar/ContextMenu";
import UsagePopover from "~/components/usage/UsagePopover";
import { isWorking } from "~/hooks/useThreads";
import { baseName, dirName, displayTitle, errorText, formatRelative } from "~/lib/util";

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

const STATUS_COLOR: Record<FileChange["status"], string> = {
  modified: "text-accent-text",
  added: "text-success",
  untracked: "text-success",
  deleted: "text-danger",
  renamed: "text-accent-text",
};

interface StripeProps {
  view: SidebarView | null;
  onSelect: (view: SidebarView) => void;
  onOpenSettings: () => void;
}

export function ToolStripe({ view, onSelect, onOpenSettings }: StripeProps) {
  return (
    <nav className="flex w-[var(--stripe-w)] flex-none flex-col items-center gap-1 border-r border-border bg-app py-1.5">
      {STRIPE.map(({ view: v, label, Icon }) => (
        <button
          key={v}
          className={`grid h-7 w-7 cursor-pointer place-items-center rounded-[var(--radius)] border-none ${view === v ? "bg-selected text-fg" : "bg-transparent text-fg-muted hover:bg-hover hover:text-fg"}`}
          title={label}
          aria-label={label}
          aria-pressed={view === v}
          onClick={() => onSelect(v)}
        >
          <Icon size={18} />
        </button>
      ))}
      <button
        className="mt-auto grid h-7 w-7 cursor-pointer place-items-center rounded-[var(--radius)] border-none bg-transparent text-fg-muted hover:bg-hover hover:text-fg"
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
  /** Files of the reply the Changes view was opened from, if any. */
  changeFocus: string[] | null;
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
    <aside className="flex min-h-0 w-[264px] flex-none flex-col border-r border-border bg-panel text-[length:var(--fs-md)] [--fs-xs:12px] [--fs-sm:13px] [--fs-md:14px]">
      <button
        className="mx-2 mt-3 mb-0.5 flex h-8 flex-none cursor-pointer items-center gap-1.5 rounded-[var(--radius-sm)] border-none bg-transparent px-2 text-[length:var(--fs-sm)] text-fg-muted hover:bg-hover hover:text-fg"
        onClick={props.onOpenPalette}
      >
        <MagnifyingGlassIcon size={16} />
        Search…
        <kbd className="kbd ml-auto">Ctrl K</kbd>
      </button>
      {props.view === "tasks" ? <TasksView {...props} /> : <ChangesView {...props} />}
      <UsagePopover agents={props.agents} />
    </aside>
  );
}

function SectionLabel({ children, action }: { children: ReactNode; action?: ReactNode }) {
  return (
    <div className="flex items-center justify-between px-1.5 pt-2.5 pb-1 text-[length:var(--fs-xs)] tracking-[0.06em] text-fg-muted uppercase">
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
  // The native dialog is async in Tauri; window.confirm returns before the user answers.
  const removeThread = async (thread: Thread) => {
    const question = `Remove ${displayTitle(thread.title)}?`;
    if (await confirm(question, { title: "Remove", kind: "warning" })) onDeleteThread(thread.id);
  };
  const menuItems = (target: Target): MenuItem[] => [
    { label: "Rename", Icon: PencilSimpleIcon, onSelect: () => setRenaming(target) },
    {
      label: "Remove",
      Icon: TrashIcon,
      danger: true,
      onSelect: async () => {
        if (target.kind === "thread") {
          const thread = threads.find((t) => t.id === target.id);
          if (thread) await removeThread(thread);
          return;
        }
        const name = projects.find((p) => p.id === target.id)?.name ?? "this project";
        if (
          await confirm(`Remove ${name} and its tasks?`, {
            title: "Remove project",
            kind: "warning",
          })
        ) {
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
    onRemoveThread: removeThread,
    renaming,
    onContextMenu: openMenu,
    onCommitRename: commitRename,
    onCancelRename: () => setRenaming(null),
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-px overflow-y-auto p-2">
      <SectionLabel
        action={
          <button className="btn-icon" title="New chat" aria-label="New chat" onClick={onNewChat}>
            <PlusIcon size={16} />
          </button>
        }
      >
        Chats
      </SectionLabel>
      {chats.length === 0 && (
        <div className="px-3 py-2 text-[length:var(--fs-sm)] text-fg-muted">No chats yet</div>
      )}
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
      {projects.length === 0 && (
        <div className="px-3 py-2 text-[length:var(--fs-sm)] text-fg-muted">No projects yet</div>
      )}
      {projects.map((p) => {
        const open = !collapsed.has(p.id);
        const tasks = threads.filter((t) => t.projectId === p.id);
        return (
          <div key={p.id}>
            <div
              className="group mt-1 flex min-h-8 w-full cursor-pointer items-center gap-2 rounded-[var(--radius-sm)] border-none bg-transparent px-1.5 text-left text-fg hover:bg-hover"
              title={p.path}
              onClick={() => toggle(p.id)}
              onContextMenu={(e) => openMenu(e, { kind: "project", id: p.id })}
            >
              <span className="inline-flex w-4 flex-none justify-center">
                <CaretRightIcon size={15} className={open ? "rotate-90" : undefined} />
              </span>
              <FolderIcon size={15} className="text-fg-subtle" />
              {renaming?.kind === "project" && renaming.id === p.id ? (
                <InlineName
                  initial={p.name}
                  onCommit={(name) => commitRename({ kind: "project", id: p.id }, name, p.name)}
                  onCancel={() => setRenaming(null)}
                />
              ) : (
                <span className="min-w-0 flex-1 overflow-hidden text-ellipsis whitespace-nowrap font-medium">
                  {p.name}
                </span>
              )}
              <button
                className="btn-icon hidden h-5 w-5 flex-none group-hover:inline-flex"
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
              <div className="pt-0.5 pb-1.5 pl-3.5">
                {tasks.length === 0 && (
                  <div className="px-3 py-2 text-[length:var(--fs-sm)] text-fg-muted">
                    No tasks yet
                  </div>
                )}
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
      className="h-[22px] min-w-0 flex-1 border border-border-focus rounded-[var(--radius-sm)] bg-input px-1 text-fg outline-none"
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
  onRemoveThread,
  renaming,
  onContextMenu,
  onCommitRename,
  onCancelRename,
}: {
  thread: Thread;
  selectedId: string | null;
  onSelectThread: (id: string) => void;
  onRemoveThread: (thread: Thread) => void;
  renaming: Target | null;
  onContextMenu: (e: MouseEvent, target: Target) => void;
  onCommitRename: (target: Target, name: string, current: string) => void;
  onCancelRename: () => void;
}) {
  const editing = renaming?.kind === "thread" && renaming.id === thread.id;
  const selected = thread.id === selectedId;
  const last = thread.messages[thread.messages.length - 1];
  const needsApproval = last?.approvals.some((a) => a.status === "pending") ?? false;
  return (
    <div
      className={`group flex min-h-[26px] w-full cursor-pointer flex-col items-stretch gap-1 rounded-[var(--radius-sm)] border-none mb-1 px-2.5 py-2 text-left text-fg ${selected ? "bg-selected" : "bg-[color-mix(in_srgb,var(--bg-hover)_40%,transparent)] hover:bg-hover"}`}
      onClick={() => onSelectThread(thread.id)}
      onContextMenu={(e) => onContextMenu(e, { kind: "thread", id: thread.id })}
    >
      <div className="flex min-h-5 min-w-0 items-center gap-1.5">
        {editing ? (
          <InlineName
            initial={thread.title}
            onCommit={(name) =>
              onCommitRename({ kind: "thread", id: thread.id }, name, thread.title)
            }
            onCancel={onCancelRename}
          />
        ) : (
          <span
            className={`min-w-0 flex-1 overflow-hidden text-ellipsis whitespace-nowrap ${selected ? "font-medium text-fg" : ""}`}
          >
            {displayTitle(thread.title)}
          </span>
        )}
        <span
          className={`flex-none text-[length:var(--fs-xs)] group-hover:hidden ${selected ? "text-fg-muted" : "text-fg-subtle"}`}
        >
          {formatRelative(last?.createdAt ?? thread.createdAt)}
        </span>
        <button
          className="btn-icon hidden h-5 w-5 flex-none group-hover:inline-flex"
          title="Delete"
          aria-label="Delete"
          onClick={(e) => {
            e.stopPropagation();
            onRemoveThread(thread);
          }}
        >
          <TrashIcon size={14} />
        </button>
      </div>
      <div className="flex min-h-5 min-w-0 items-center justify-end gap-1.5">
        {needsApproval ? (
          <span title="Waiting for approval" className="inline-flex flex-none text-warning">
            <ShieldWarningIcon size={15} />
          </span>
        ) : (
          isWorking(thread) && (
            <span title="Working" className="inline-flex flex-none">
              <CircleNotchIcon size={15} className="spin text-accent-text" />
            </span>
          )
        )}
        <span className="inline-flex flex-none" title={AGENT_LABELS[thread.agent]}>
          <ProviderLogos kind={thread.agent} size={14} />
        </span>
      </div>
    </div>
  );
}

/** A small text button for acting on several changed files at once. */
function BulkButton({ onClick, children }: { onClick: () => void; children: ReactNode }) {
  return (
    <button
      className="cursor-pointer rounded-[var(--radius-sm)] border-none bg-transparent px-1.5 py-0.5 text-[length:var(--fs-xs)] text-fg-muted hover:bg-hover hover:text-fg"
      onClick={onClick}
    >
      {children}
    </button>
  );
}

/** One changed file: opens its diff, with Apply (stage) and Reject (revert) on hover. */
function ChangeRow({
  change,
  onOpen,
  onApply,
  onReject,
}: {
  change: FileChange;
  onOpen: () => void;
  onApply: () => void;
  onReject: () => void;
}) {
  const name = baseName(change.path);
  return (
    <div className="group flex min-h-[26px] items-center gap-1 rounded-[var(--radius-sm)] py-0.5 pr-1 pl-3 hover:bg-hover">
      <button
        className="flex min-w-0 flex-1 cursor-pointer items-center gap-2 border-none bg-transparent p-0 text-fg text-left"
        title={change.path}
        onClick={onOpen}
      >
        <span
          className={`w-3.5 flex-none text-center font-[family-name:var(--font-mono)] text-[length:var(--fs-xs)] font-bold ${STATUS_COLOR[change.status]}`}
        >
          {STATUS_LETTER[change.status]}
        </span>
        <span className="min-w-0 flex-1 truncate">{name}</span>
        <span className="text-success">+{change.additions}</span>
        <span className="text-danger">−{change.deletions}</span>
      </button>
      <button
        className="btn-icon opacity-0 group-hover:opacity-100 focus:opacity-100"
        title="Apply"
        aria-label={`Apply ${name}`}
        onClick={onApply}
      >
        <CheckIcon size={14} />
      </button>
      <button
        className="btn-icon opacity-0 group-hover:opacity-100 focus:opacity-100"
        title="Reject"
        aria-label={`Reject ${name}`}
        onClick={onReject}
      >
        <ArrowCounterClockwiseIcon size={14} />
      </button>
    </div>
  );
}

/** Changed files. Those from the reply the view was opened from are pinned on top; the rest are grouped by folder. */
function ChangesView({
  project,
  changes,
  changeFocus,
  onRefreshChanges,
  onOpenChange,
}: SidebarProps) {
  const [error, setError] = useState<string | null>(null);
  const pinned = changes.filter((c) => changeFocus?.includes(c.path));
  const folders = new Map<string, FileChange[]>();
  for (const c of changes) {
    if (pinned.includes(c)) continue;
    const dir = dirName(c.path);
    folders.set(dir, [...(folders.get(dir) ?? []), c]);
  }

  async function act(action: () => Promise<void>) {
    setError(null);
    try {
      await action();
      onRefreshChanges();
    } catch (e) {
      setError(errorText(e));
    }
  }

  async function reject(path: string) {
    if (!project) return;
    const question = `Discard changes to ${baseName(path)}?`;
    if (!(await confirm(question, { title: "Reject", kind: "warning" }))) return;
    void act(() => api.revertFile(project.id, path));
  }

  /** Stages every file in `files`, one after another. */
  function applyAll(files: FileChange[]) {
    if (!project) return;
    void act(async () => {
      for (const f of files) await api.acceptFile(project.id, f.path);
    });
  }

  /** Reverts every file in `files` after one confirmation. */
  async function rejectAll(files: FileChange[]) {
    if (!project || files.length === 0) return;
    const count = files.length === 1 ? "1 file" : `${files.length} files`;
    if (!(await confirm(`Discard changes to ${count}?`, { title: "Reject", kind: "warning" }))) {
      return;
    }
    void act(async () => {
      for (const f of files) await api.revertFile(project.id, f.path);
    });
  }

  const row = (c: FileChange) => (
    <ChangeRow
      key={c.path}
      change={c}
      onOpen={() => onOpenChange(c.path)}
      onApply={() => project && void act(() => api.acceptFile(project.id, c.path))}
      onReject={() => void reject(c.path)}
    />
  );

  return (
    <>
      <div className="flex h-8 flex-none items-center justify-between pr-2 pl-3 text-[length:var(--fs-sm)] font-semibold">
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
      <div className="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto p-2">
        {changes.length > 0 && (
          <div className="flex justify-end gap-1 px-1">
            <BulkButton onClick={() => applyAll(changes)}>Apply all</BulkButton>
            <BulkButton onClick={() => void rejectAll(changes)}>Reject all</BulkButton>
          </div>
        )}
        {changes.length === 0 && (
          <div className="px-3 py-2 text-[length:var(--fs-sm)] text-fg-muted">No changes</div>
        )}
        {pinned.length > 0 && (
          <div className="flex flex-col gap-px rounded-[var(--radius)] border border-accent bg-selected-muted p-1">
            <div className="flex items-center justify-between gap-1 px-1.5 pt-0.5 pb-1">
              <span className="text-[length:var(--fs-xs)] font-semibold tracking-[0.04em] text-accent-text uppercase">
                From this reply
              </span>
              <span className="flex gap-1">
                <BulkButton onClick={() => applyAll(pinned)}>Apply</BulkButton>
                <BulkButton onClick={() => void rejectAll(pinned)}>Reject</BulkButton>
              </span>
            </div>
            {pinned.map(row)}
          </div>
        )}
        {[...folders]
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([dir, files]) => (
            <div key={dir} className="flex flex-col gap-px">
              <div className="flex items-center gap-1.5 px-1.5 pt-1 text-[length:var(--fs-xs)] text-fg-subtle">
                <FolderIcon size={12} />
                <span className="min-w-0 truncate">{dir || "Project root"}</span>
              </div>
              {files.map(row)}
            </div>
          ))}
        {error && <div className="px-2 text-[length:var(--fs-sm)] text-danger">{error}</div>}
      </div>
    </>
  );
}
