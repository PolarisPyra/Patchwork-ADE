import { useCallback, useEffect, useRef, useState, type MouseEvent as ReactMouseEvent } from "react";
import { X } from "lucide-react";
import { api, defaultAgentOf, type FileChange, type Message, type Settings } from "../api";
import type { UpdateSettings } from "../App";
import Canvas, { type CanvasTab } from "./canvas/Canvas";
import Chat from "./Chat";
import CommandPalette, { type PaletteItem } from "./CommandPalette";
import { openFolderAsProject } from "./projects";
import SettingsDialog from "./SettingsDialog";
import Sidebar, { ToolStripe, type SidebarView } from "./Sidebar";
import StatusBar from "./StatusBar";
import Toolbar from "./Toolbar";
import { isWorking, useThreads } from "./useThreads";
import { AGENT_KINDS, errorText } from "./util";
import "./Workspace.css";

export interface WorkspaceProps {
  settings: Settings;
  updateSettings: UpdateSettings;
  resolvedTheme: "light" | "dark";
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

export default function Workspace({ settings, updateSettings, resolvedTheme, toggleTheme }: WorkspaceProps) {
  const { threads, selected, select, createThread, deleteThread, setModel, send } = useThreads(
    settings.activeProjectId,
    () => void refreshGit(),
  );
  // The selected thread decides the project (null: a chat without a project);
  // with nothing selected, the last active project does.
  const project =
    settings.projects.find((p) => p.id === (selected ? selected.projectId : settings.activeProjectId)) ?? null;
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

  /** Remembers the current project so the next launch reopens it. */
  const rememberProject = async (id: string | null) => {
    if (settings.activeProjectId !== id) await updateSettings((s) => ({ ...s, activeProjectId: id }));
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
      await createThread(id, { agent: defaultAgent, model: null });
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
    { id: "new-chat", group: "Actions", label: "New chat", hint: project ? undefined : "Ctrl T", run: newChat },
    ...(project
      ? [{ id: "new-task", group: "Actions", label: `New task in ${project.name}`, hint: "Ctrl T", run: () => newThreadIn(project.id) }]
      : []),
    { id: "toggle-theme", group: "Actions", label: "Toggle theme", run: toggleTheme },
    { id: "settings", group: "Actions", label: "Open settings", hint: "Ctrl ,", run: () => setSettingsOpen(true) },
    { id: "open-folder", group: "Actions", label: "Open folder…", run: openFolder },
    ...threads.map((t) => ({
      id: `task-${t.id}`,
      group: settings.projects.find((p) => p.id === t.projectId)?.name ?? "Chats",
      label: t.title,
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
    <div className="ws-root">
      <Toolbar
        project={project}
        projects={settings.projects}
        branch={branch}
        thread={selected}
        resolvedTheme={resolvedTheme}
        onSelectProject={selectProject}
        onOpenFolder={openFolder}
        onOpenPalette={() => setPaletteOpen(true)}
        toggleTheme={toggleTheme}
      />

      <div className="ws-body" ref={bodyRef}>
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
            onOpenFolder={openFolder}
            onRefreshChanges={() => attempt(refreshGit)}
            onOpenChange={(path) => openCanvasAt(path, null, "diff")}
          />
        )}

        <main className="ws-main">
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
            onDeselect={() => select(null)}
          />
        </main>

        {openCanvas && (
          <>
            <div className="ws-splitter" onMouseDown={startResize} />
            <div
              className="ws-canvas-slot"
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

      <StatusBar
        project={project}
        branch={branch}
        changeCount={changes.length}
        agent={selected?.agent ?? defaultAgent}
        working={isWorking(selected)}
        resolvedTheme={resolvedTheme}
        onOpenChanges={() => setView("changes")}
      />

      {error && (
        <div className="ws-toast" role="alert">
          <span>{error}</span>
          <button className="btn-icon" aria-label="Dismiss" onClick={() => setError(null)}>
            <X size={14} />
          </button>
        </div>
      )}
      {paletteOpen && <CommandPalette items={paletteItems} onClose={() => setPaletteOpen(false)} />}
      {settingsOpen && (
        <SettingsDialog
          settings={settings}
          updateSettings={updateSettings}
          onClose={() => setSettingsOpen(false)}
        />
      )}
    </div>
  );
}
