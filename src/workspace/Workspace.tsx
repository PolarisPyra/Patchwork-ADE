import type { Settings } from "../api";
import type { UpdateSettings } from "../App";

export interface WorkspaceProps {
  settings: Settings;
  updateSettings: UpdateSettings;
  resolvedTheme: "light" | "dark";
  toggleTheme: () => void;
}

// STUB — to be implemented.
export default function Workspace(_props: WorkspaceProps) {
  return <div>Workspace</div>;
}
