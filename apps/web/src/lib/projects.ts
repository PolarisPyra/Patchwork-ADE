import { open } from "@tauri-apps/plugin-dialog";
import { api } from "~/api";
import type { UpdateSettings } from "~/app/App";

/** Re-reads the project list from the backend; never overwrites it with stale local copies. */
export async function syncProjects(updateSettings: UpdateSettings): Promise<void> {
  const fresh = await api.getSettings();
  await updateSettings((s) => ({
    ...s,
    projects: fresh.projects,
    activeProjectId: fresh.activeProjectId,
  }));
}

/** Folder picker, then registers the folder as the active project. No-op if cancelled. */
export async function openFolderAsProject(updateSettings: UpdateSettings): Promise<void> {
  const path = await open({ directory: true, multiple: false });
  if (typeof path !== "string") return;
  await api.addProject(path);
  await syncProjects(updateSettings);
}
