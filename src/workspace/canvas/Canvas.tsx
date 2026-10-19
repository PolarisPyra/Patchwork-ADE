import type { Message } from "../../api";

export type CanvasTab = "plan" | "code" | "diff";

export interface CanvasProps {
  projectId: string;
  /** Project-relative file path to show in Code/Diff tabs. */
  path: string | null;
  /** Assistant message whose plan (Plan tab) and files are shown; null if none. */
  message: Message | null;
  initialTab?: CanvasTab;
  onClose: () => void;
  /** Called after Apply/Reject succeeds so the parent can refresh git state. */
  onChangesUpdated: () => void;
}

// STUB — to be implemented.
export default function Canvas(_props: CanvasProps) {
  return <aside>Canvas</aside>;
}
