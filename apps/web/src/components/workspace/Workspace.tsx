import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
} from "react";
import { XIcon } from "@phosphor-icons/react";
import { api, defaultAgentOf, type FileChange, type Message, type Settings } from "~/api";
import type { UpdateSettings } from "~/app/App";
import Canvas, { type CanvasTab } from "~/components/canvas/Canvas";
import { lastAccessMode } from "~/components/chat/AccessPicker";
import Chat from "~/components/chat/Chat";
import CommandPalette, { type PaletteItem } from "~/components/workspace/CommandPalette";
import { openFolderAsProject, syncProjects } from "~/lib/projects";
import SettingsDialog from "~/components/settings/SettingsDialog";
import Sidebar, { ToolStripe, type SidebarView } from "~/components/sidebar/Sidebar";
import StatusBar from "~/components/workspace/StatusBar";
import Toolbar from "~/components/workspace/Toolbar";
import { isWorking, useThreads } from "~/hooks/useThreads";
import { AGENT_KINDS, displayTitle, errorText } from "~/lib/util";

export interface WorkspaceProps {
  settings: Settings;
  updateSettings: UpdateSettings;
  toggleTheme: () => void;
}

interface CanvasState {
  /** Bumped on every open so the canvas re-initialises its tab. */
  seq: number;
  projectId: string;
  path: string | null;
  message: Message | null;
  tab: CanvasTab;
}

interface GitState {
  projectId: string;
  branch: string | null;
  changes: FileChange[];
}

const CANVAS_MIN_PX = 340;
const CANVAS_MAX_FRACTION = 0.7;

export default function Workspace({ settings, updateSettings, toggleTheme }: WorkspaceProps) {
  const {
    threads,
    reload,
    selected,
    select,
    createThread,
    deleteThread,
    renameThread,
    setModel,
    setAccessMode,
    send,
  } = useThreads(settings.activeProjectId, () => void refreshGit());
  // The selected thread decides the project (null: a chat without a project);
  // with nothing selected, the last active project does.
  const project =
    settings.projects.find(
      (p) => p.id === (selected ? selected.projectId : settings.activeProjectId),
    ) ?? null;
  const projectId = project?.id ?? null;
  const defaultAgent = defaultAgentOf(settings);
  // Display order stays fixed; `settings.agents` order only marks the default.
  const connectedAgents = AGENT_KINDS.filter((k) => settings.agents.includes(k));

  const [view, setView] = useState<SidebarView | null>("tasks");
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [canvas, setCanvas] = useState<CanvasState | null>(null);
  const [canvasWidth, setCanvasWidth] = useState<number | null>(null);
  const [git, setGit] = useState<GitState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const bodyRef = useRef<HTMLDivElement>(null);

  // A canvas belongs to the project it was opened in; it is hidden after a project switch.
  const openCanvas = canvas && canvas.projectId === projectId ? canvas : null;
  const changes = git && git.projectId === projectId ? git.changes : [];
  const branch = git && git.projectId === projectId ? git.branch : null;

  const refreshGit = useCallback(() => {
    if (!projectId) return Promise.resolve();
    return Promise.all([
      api.gitBranch(projectId).catch(() => null),
      api.gitChanges(projectId).catch(() => []),
    ]).then(([nextBranch, nextChanges]) =>
      setGit({ projectId, branch: nextBranch, changes: nextChanges }),
    );
  }, [projectId]);

  useEffect(() => {
    void refreshGit();
  }, [refreshGit]);

  function attempt(fn: () => Promise<unknown>) {
    setError(null);
    fn().catch((e: unknown) => setError(errorText(e)));
  }

  const openFolder = () => attempt(() => openFolderAsProject(updateSettings));
  const renameProjectTo = (id: string, name: string) =>
    attempt(async () => {
      await api.renameProject(id, name);
      await syncProjects(updateSettings);
    });
  // The backend also deletes the project's tasks, so the thread list is reloaded.
  const removeProjectNow = (id: string) =>
    attempt(async () => {
      await api.removeProject(id);
      await syncProjects(updateSettings);
      await reload();
    });

  /** Remembers the current project so the next launch reopens it. */
  const rememberProject = async (id: string | null) => {
    if (settings.activeProjectId !== id)
      await updateSettings((s) => ({ ...s, activeProjectId: id }));
  };

  const selectThread = (id: string) => {
    select(id);
    const thread = threads.find((t) => t.id === id);
    if (thread) attempt(() => rememberProject(thread.projectId));
  };

  const selectProject = (id: string) => {
    select(threads.find((t) => t.projectId === id)?.id ?? null);
    attempt(() => rememberProject(id));
  };

  /** New thread in a project, or a chat without a project when `id` is null. */
  const newThreadIn = (id: string | null) =>
    attempt(async () => {
      await createThread(id, { agent: defaultAgent, model: null, accessMode: lastAccessMode() });
      await rememberProject(id);
    });
  const newChat = () => newThreadIn(null);

  const openCanvasAt = (path: string, message: Message | null, tab: CanvasTab) => {
    if (!projectId) return;
    setCanvas((prev) => ({ seq: (prev?.seq ?? 0) + 1, projectId, path, message, tab }));
  };

  function startResize(e: ReactMouseEvent) {
    const body = bodyRef.current;
    if (!body) return;
    e.preventDefault();
    const right = body.getBoundingClientRect().right;
    const max = body.clientWidth * CANVAS_MAX_FRACTION;
    const onMove = (ev: MouseEvent) =>
      setCanvasWidth(Math.min(max, Math.max(CANVAS_MIN_PX, right - ev.clientX)));
    const onUp = () => {
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onUp);
    };
    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
  }

  // Global shortcuts. Re-registered each render so handlers see current state.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const mod = e.ctrlKey || e.metaKey;
      const key = e.key.toLowerCase();
      if (e.key === "Escape") {
        if (paletteOpen) setPaletteOpen(false);
        else if (settingsOpen) setSettingsOpen(false);
        else if (openCanvas) setCanvas(null);
        else return;
      } else if (mod && key === "k") {
        setPaletteOpen((o) => !o);
      } else if (mod && key === "t") {
        newThreadIn(projectId);
      } else if (mod && e.key === ",") {
        setSettingsOpen(true);
      } else {
        return;
      }
      e.preventDefault();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  const paletteItems: PaletteItem[] = [
    {
      id: "new-chat",
      group: "Actions",
      label: "New chat",
      hint: project ? undefined : "Ctrl T",
      run: newChat,
    },
    ...(project
      ? [
          {
            id: "new-task",
            group: "Actions",
            label: `New task in ${project.name}`,
            hint: "Ctrl T",
            run: () => newThreadIn(project.id),
          },
        ]
      : []),
    { id: "toggle-theme", group: "Actions", label: "Toggle theme", run: toggleTheme },
    {
      id: "settings",
      group: "Actions",
      label: "Open settings",
      hint: "Ctrl ,",
      run: () => setSettingsOpen(true),
    },
    { id: "open-folder", group: "Actions", label: "Open folder…", run: openFolder },
    ...threads.map((t) => ({
      id: `task-${t.id}`,
      group: settings.projects.find((p) => p.id === t.projectId)?.name ?? "Chats",
      label: displayTitle(t.title),
      run: () => {
        setView("tasks");
        selectThread(t.id);
      },
    })),
    ...settings.projects.map((p) => ({
      id: `project-${p.id}`,
      group: "Projects",
      label: p.name,
      hint: p.path,
      run: () => selectProject(p.id),
    })),
  ];

  return (
    <div className="grid h-full grid-rows-[var(--toolbar-h)_minmax(0,1fr)_var(--statusbar-h)] bg-app text-fg">
      <Toolbar
        project={project}
        projects={settings.projects}
        branch={branch}
        onSelectProject={selectProject}
        onOpenFolder={openFolder}
      />

      <div className="flex min-h-0 min-w-0" ref={bodyRef}>
        <ToolStripe
          view={view}
          onSelect={(v) => setView(view === v ? null : v)}
          onOpenSettings={() => setSettingsOpen(true)}
        />
        {view && (
          <Sidebar
            view={view}
            agents={connectedAgents.length > 0 ? connectedAgents : [defaultAgent]}
            project={project}
            projects={settings.projects}
            threads={threads}
            selectedId={selected?.id ?? null}
            changes={changes}
            onNewTask={newThreadIn}
            onNewChat={newChat}
            onSelectThread={selectThread}
            onDeleteThread={(id) => attempt(() => deleteThread(id))}
            onRenameThread={(id, title) => attempt(() => renameThread(id, title))}
            onRenameProject={renameProjectTo}
            onRemoveProject={removeProjectNow}
            onOpenFolder={openFolder}
            onRefreshChanges={() => attempt(refreshGit)}
            onOpenChange={(path) => openCanvasAt(path, null, "diff")}
            onOpenPalette={() => setPaletteOpen(true)}
          />
        )}

        <div className="flex min-h-0 min-w-0 flex-1">
          <main className="flex min-w-0 flex-1 bg-editor">
            <Chat
              project={project}
              thread={selected}
              changes={changes}
              defaultAgent={defaultAgent}
              agents={connectedAgents}
              onOpenFolder={openFolder}
              onOpenCanvas={openCanvasAt}
              onSend={(text, draft) => send(text, draft, projectId)}
              onCancel={(id) => api.cancelTurn(id)}
              onSetModel={setModel}
              onSetAccessMode={setAccessMode}
            />
          </main>

          {openCanvas && (
            <>
              <div
                className="relative w-1 flex-none cursor-col-resize after:absolute after:top-0 after:bottom-0 after:left-1/2 after:w-px after:-translate-x-1/2 after:bg-border after:content-['']"
                onMouseDown={startResize}
              />
              <div
                className="flex w-[max(420px,46%)] min-h-0 min-w-0 flex-none [&>*]:min-w-0 [&>*]:flex-1"
                style={canvasWidth !== null ? { width: canvasWidth } : undefined}
              >
                <Canvas
                  key={openCanvas.seq}
                  projectId={openCanvas.projectId}
                  path={openCanvas.path}
                  message={openCanvas.message}
                  initialTab={openCanvas.tab}
                  onClose={() => setCanvas(null)}
                  onChangesUpdated={() => void refreshGit()}
                />
              </div>
            </>
          )}
        </div>
      </div>

      <StatusBar
        project={project}
        branch={branch}
        changeCount={changes.length}
        agent={selected?.agent ?? defaultAgent}
        working={isWorking(selected)}
        onOpenChanges={() => setView("changes")}
      />

      {error && (
        <div
          className="fixed right-4 bottom-[calc(var(--statusbar-h)_+_12px)] z-[95] flex max-w-[420px] items-center gap-2 rounded-[var(--radius)] border border-danger bg-elevated py-2 pr-2 pl-3 text-[length:var(--fs-sm)] shadow-[var(--shadow-popup)]"
          role="alert"
        >
          <span>{error}</span>
          <button className="btn-icon" aria-label="Dismiss" onClick={() => setError(null)}>
            <XIcon size={14} />
          </button>
        </div>
      )}
      {paletteOpen && <CommandPalette items={paletteItems} onClose={() => setPaletteOpen(false)} />}
      {settingsOpen && (
        <SettingsDialog
          settings={settings}
          updateSettings={updateSettings}
          onImported={() => void reload()}
          onClose={() => setSettingsOpen(false)}
        />
      )}
    </div>
  );
}
