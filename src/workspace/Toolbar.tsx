import { ChevronDown, FolderPlus, GitBranch, Moon, Search, Settings, Sun } from "lucide-react";
import { AGENT_LABELS, type Project, type Thread } from "../api";
import Dropdown from "./Dropdown";

const TILE_COLORS = [
  "var(--accent)",
  "var(--syn-string)",
  "var(--syn-property)",
  "var(--syn-keyword)",
  "var(--syn-type)",
];

/** Stable tile color per project name, drawn from the theme palette. */
function tileColor(name: string): string {
  let hash = 0;
  for (const ch of name) hash = (hash * 31 + (ch.codePointAt(0) ?? 0)) >>> 0;
  return TILE_COLORS[hash % TILE_COLORS.length];
}

function initials(name: string): string {
  return Array.from(name.trim()).slice(0, 2).join("").toUpperCase();
}

interface ToolbarProps {
  project: Project | null;
  projects: Project[];
  branch: string | null;
  thread: Thread | null;
  resolvedTheme: "light" | "dark";
  onSelectProject: (id: string) => void;
  onOpenFolder: () => void;
  onOpenPalette: () => void;
  toggleTheme: () => void;
  onOpenSettings: () => void;
}

export default function Toolbar({
  project,
  projects,
  branch,
  thread,
  resolvedTheme,
  onSelectProject,
  onOpenFolder,
  onOpenPalette,
  toggleTheme,
  onOpenSettings,
}: ToolbarProps) {
  const pickTheme = (t: "light" | "dark") => {
    if (t !== resolvedTheme) toggleTheme();
  };
  const name = project?.name ?? "";

  return (
    <header className="ws-toolbar">
      <div className="ws-logo">P</div>

      <Dropdown
        trigger={({ toggle }) => (
          <button className="ws-project-btn" onClick={toggle}>
            <span className="ws-project-tile" style={{ background: tileColor(name) }}>
              {initials(name)}
            </span>
            <span className="ws-project-label">{project?.name ?? "No project"}</span>
            <ChevronDown size={14} />
          </button>
        )}
      >
        {(close) => (
          <>
            {projects.map((p) => (
              <button
                key={p.id}
                className="ws-menu-item"
                onClick={() => {
                  close();
                  onSelectProject(p.id);
                }}
              >
                <span className={`ws-dot${p.id === project?.id ? " active" : ""}`} />
                {p.name}
              </button>
            ))}
            {projects.length > 0 && <div className="ws-menu-sep" />}
            <button
              className="ws-menu-item"
              onClick={() => {
                close();
                onOpenFolder();
              }}
            >
              <FolderPlus size={14} />
              Open folder…
            </button>
          </>
        )}
      </Dropdown>

      {branch && (
        <>
          <span className="ws-sep" />
          <span className="ws-branch" title="Current branch">
            <GitBranch size={14} />
            {branch}
          </span>
        </>
      )}

      <div className="ws-toolbar-center">
        {thread && (
          <>
            <span className="ws-title">{thread.title}</span>
            <span className="badge badge-accent">{AGENT_LABELS[thread.agent]}</span>
          </>
        )}
      </div>

      <div className="ws-toolbar-right">
        <button className="ws-search" onClick={onOpenPalette}>
          <Search size={14} />
          Search…
          <kbd className="kbd">Ctrl K</kbd>
        </button>
        <div className="ws-segmented" role="group" aria-label="Theme">
          <button
            className={`ws-seg${resolvedTheme === "light" ? " active" : ""}`}
            title="Light theme"
            aria-pressed={resolvedTheme === "light"}
            onClick={() => pickTheme("light")}
          >
            <Sun size={14} />
          </button>
          <button
            className={`ws-seg${resolvedTheme === "dark" ? " active" : ""}`}
            title="Dark theme"
            aria-pressed={resolvedTheme === "dark"}
            onClick={() => pickTheme("dark")}
          >
            <Moon size={14} />
          </button>
        </div>
        <button className="btn-icon" title="Settings" aria-label="Settings" onClick={onOpenSettings}>
          <Settings size={16} />
        </button>
      </div>
    </header>
  );
}
