import {
  CaretDownIcon,
  ChatsIcon,
  FolderPlusIcon,
  GitBranchIcon,
} from "@phosphor-icons/react";
import { AGENT_LABELS, type Project, type Thread } from "~/api";
import Dropdown from "~/components/workspace/Dropdown";
import { displayTitle } from "~/lib/util";

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
  onSelectProject: (id: string) => void;
  onOpenFolder: () => void;
}

export default function Toolbar({
  project,
  projects,
  branch,
  thread,
  onSelectProject,
  onOpenFolder,
}: ToolbarProps) {
  const name = project?.name ?? "";

  return (
    <header className="ws-toolbar">
      <div className="ws-toolbar-left">
        <Dropdown
          trigger={({ toggle }) => (
            <button className="ws-project-btn" onClick={toggle}>
              {project ? (
                <span className="ws-project-tile" style={{ background: tileColor(name) }}>
                  {initials(name)}
                </span>
              ) : (
                <span className="ws-project-tile ws-project-tile-chats">
                  <ChatsIcon size={12} />
                </span>
              )}
              <span className="ws-project-label">{project?.name ?? "No project"}</span>
              <CaretDownIcon size={14} />
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
                <FolderPlusIcon size={14} />
                Open folder…
              </button>
            </>
          )}
        </Dropdown>

        {branch && (
          <>
            <span className="ws-sep" />
            <span className="ws-branch" title="Current branch">
              <GitBranchIcon size={14} />
              {branch}
            </span>
          </>
        )}
      </div>

      <div className="ws-toolbar-center">
        {thread && (
          <>
            <span className="ws-title">{displayTitle(thread.title)}</span>
            <span className="badge badge-accent">{AGENT_LABELS[thread.agent]}</span>
          </>
        )}
      </div>
    </header>
  );
}
