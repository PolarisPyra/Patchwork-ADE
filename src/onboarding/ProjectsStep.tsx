import { useState } from "react";
import { Check } from "lucide-react";
import { open } from "@tauri-apps/plugin-dialog";
import { api, type Settings } from "../api";
import type { UpdateSettings } from "../App";
import { cx } from "./classNames";

interface ProjectsStepProps {
  settings: Settings;
  updateSettings: UpdateSettings;
}

type Action = "open" | "create";

function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

export default function ProjectsStep({ settings, updateSettings }: ProjectsStepProps) {
  const [action, setAction] = useState<Action | null>(null);
  const [createOpen, setCreateOpen] = useState(false);
  const [parent, setParent] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // The backend appends the project and makes it active, so re-read it rather
  // than merging into possibly stale local state.
  const syncProjects = async () => {
    const fresh = await api.getSettings();
    await updateSettings((s) => ({
      ...s,
      projects: fresh.projects,
      activeProjectId: fresh.activeProjectId,
    }));
  };

  const run = async (kind: Action, task: () => Promise<unknown>): Promise<boolean> => {
    setAction(kind);
    setBusy(true);
    setError(null);
    try {
      await task();
      await syncProjects();
      return true;
    } catch (e) {
      setError(errorMessage(e));
      return false;
    } finally {
      setBusy(false);
    }
  };

  const pickFolder = async (): Promise<string | null> => {
    try {
      return await open({ directory: true });
    } catch (e) {
      setError(errorMessage(e));
      return null;
    }
  };

  const browseExisting = async () => {
    const path = await pickFolder();
    if (path) await run("open", () => api.addProject(path));
  };

  const chooseParent = async () => {
    const path = await pickFolder();
    if (path) setParent(path);
  };

  const createProject = async () => {
    const trimmed = name.trim();
    if (!parent || !trimmed) return;
    if (await run("create", () => api.createProject(parent, trimmed))) setName("");
  };

  const setActive = (id: string) =>
    void updateSettings((s) => ({ ...s, activeProjectId: id }));

  return (
    <>
      <div>
        <div className="ob-card-title">Project workspace</div>
        <div className="ob-card-sub">Start from an existing folder or create a new workspace.</div>
      </div>

      <div className="ob-option-group">
        <div className={cx("ob-option", action === "open" && "is-selected")}>
          <span className="ob-option-index">01</span>
          <span className="ob-option-text">
            <span className="ob-option-name">Open a local project</span>
            <span className="ob-option-detail">Select a folder from your computer to start working.</span>
          </span>
          <button type="button" className="btn" disabled={busy} onClick={() => void browseExisting()}>
            Browse folders
          </button>
        </div>

        <div className={cx("ob-option", action === "create" && "is-selected")}>
          <span className="ob-option-index">02</span>
          <span className="ob-option-text">
            <span className="ob-option-name">Create a new project</span>
            <span className="ob-option-detail">Choose a location and initialize an empty workspace.</span>
          </span>
          <button
            type="button"
            className="btn"
            disabled={busy}
            onClick={() => {
              setCreateOpen(true);
              setAction("create");
            }}
          >
            Create project
          </button>
        </div>

        {createOpen && (
          <div className="ob-create">
            <div className="ob-form-row">
              <span className="ob-form-label">Location</span>
              <span className={cx("ob-path", !parent && "is-empty")}>{parent ?? "No location chosen"}</span>
              <button type="button" className="btn" disabled={busy} onClick={() => void chooseParent()}>
                Choose…
              </button>
            </div>
            <div className="ob-form-row">
              <label htmlFor="ob-project-name" className="ob-form-label">
                Name
              </label>
              <input
                id="ob-project-name"
                className="input ob-name-input"
                value={name}
                placeholder="my-project"
                onChange={(e) => setName(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") void createProject();
                }}
              />
            </div>
            <div className="ob-create-actions">
              <button
                type="button"
                className="btn btn-primary"
                disabled={busy || !parent || !name.trim()}
                onClick={() => void createProject()}
              >
                Create
              </button>
            </div>
          </div>
        )}
      </div>

      {error && (
        <p className="ob-error" role="alert">
          {error}
        </p>
      )}

      <div>
        <div className="ob-section-title">Recent projects</div>
        {settings.projects.length === 0 ? (
          <p className="ob-muted">No projects yet.</p>
        ) : (
          <ul className="ob-project-list">
            {settings.projects.map((p) => {
              const active = p.id === settings.activeProjectId;
              return (
                <li key={p.id}>
                  <button
                    type="button"
                    className={cx("ob-project-row", active && "is-active")}
                    aria-pressed={active}
                    onClick={() => setActive(p.id)}
                  >
                    <span className="ob-project-check">{active && <Check size={14} strokeWidth={3} />}</span>
                    <span className="ob-project-name">{p.name}</span>
                    <span className="ob-project-path">{p.path}</span>
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </>
  );
}
