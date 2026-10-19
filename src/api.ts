// Typed bridge to the Rust backend. Mirrors src-tauri/src/types.rs and the
// commands registered in src-tauri/src/lib.rs — keep all three in sync.
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

export type AgentKind = "claude" | "codex";
export type Theme = "light" | "dark" | "system";
export type Role = "user" | "assistant";
export type MessageStatus = "streaming" | "complete" | "error" | "cancelled";
export type StepStatus = "pending" | "running" | "done" | "error";

export interface Integrations {
  github: boolean;
  terminal: boolean;
  figma: boolean;
  browser: boolean;
}

export interface Project {
  id: string;
  name: string;
  path: string;
}

export interface Settings {
  onboarded: boolean;
  theme: Theme;
  /** Connected agents; the first is the default for new tasks. */
  agents: AgentKind[];
  integrations: Integrations;
  projects: Project[];
  activeProjectId: string | null;
}

export interface AgentStatus {
  kind: AgentKind;
  installed: boolean;
  version: string | null;
  signedIn: boolean;
  detail: string;
}

export interface ToolCall {
  id: string;
  name: string;
  summary: string;
  status: StepStatus;
}

export interface PlanStep {
  text: string;
  status: StepStatus;
}

export interface Message {
  id: string;
  role: Role;
  text: string;
  createdAt: number; // epoch ms
  status: MessageStatus;
  tools: ToolCall[];
  plan: PlanStep[];
  files: string[]; // project-relative paths edited during this message
  error: string | null;
}

export interface Thread {
  id: string;
  /** null for a chat without a project (runs in a private scratch folder). */
  projectId: string | null;
  title: string;
  agent: AgentKind;
  model: string | null;
  sessionId: string | null;
  createdAt: number;
  messages: Message[];
}

export interface FileChange {
  path: string;
  status: "modified" | "added" | "deleted" | "untracked" | "renamed";
  additions: number;
  deletions: number;
  staged: boolean;
}

export type AgentEvent =
  | { type: "messageStarted"; message: Message }
  | { type: "textDelta"; messageId: string; text: string }
  | { type: "toolStarted"; messageId: string; tool: ToolCall }
  | { type: "toolFinished"; messageId: string; toolId: string; isError: boolean }
  | { type: "planUpdated"; messageId: string; steps: PlanStep[] }
  | { type: "fileTouched"; messageId: string; path: string }
  | {
      type: "turnCompleted";
      messageId: string;
      status: Exclude<MessageStatus, "streaming">;
      error: string | null;
    };

export interface AgentEventEnvelope {
  threadId: string;
  event: AgentEvent;
}

export const DEFAULT_SETTINGS: Settings = {
  onboarded: false,
  theme: "dark",
  agents: [],
  integrations: { github: false, terminal: false, figma: false, browser: false },
  projects: [],
  activeProjectId: null,
};

/** Agent used for new tasks: the first connected one, else Claude Code. */
export function defaultAgentOf(settings: Settings): AgentKind {
  return settings.agents[0] ?? "claude";
}

export const AGENT_LABELS: Record<AgentKind, string> = {
  claude: "Claude Code",
  codex: "Codex",
};

/** Model choices per agent. `null` means the CLI's own default. */
export const AGENT_MODELS: Record<AgentKind, { id: string | null; label: string }[]> = {
  claude: [
    { id: null, label: "Default" },
    { id: "opus", label: "Opus" },
    { id: "sonnet", label: "Sonnet" },
    { id: "haiku", label: "Haiku" },
  ],
  codex: [{ id: null, label: "Default" }],
};

export const api = {
  getSettings: () => invoke<Settings>("get_settings"),
  saveSettings: (settings: Settings) => invoke<void>("save_settings", { settings }),
  detectAgent: (kind: AgentKind) => invoke<AgentStatus>("detect_agent", { kind }),

  /** Registers an existing folder; also makes it the active project. */
  addProject: (path: string) => invoke<Project>("add_project", { path }),
  /** Creates `parent/name`, runs `git init`, registers it as the active project. */
  createProject: (parent: string, name: string) =>
    invoke<Project>("create_project", { parent, name }),
  removeProject: (id: string) => invoke<void>("remove_project", { id }),

  /** Newest first. `null` lists the chats that have no project. */
  listThreads: (projectId: string | null) => invoke<Thread[]>("list_threads", { projectId }),
  createThread: (projectId: string | null, agent: AgentKind, model: string | null) =>
    invoke<Thread>("create_thread", { projectId, agent, model }),
  deleteThread: (id: string) => invoke<void>("delete_thread", { id }),
  setThreadModel: (id: string, model: string | null) =>
    invoke<void>("set_thread_model", { id, model }),
  /** Returns the stored user message; assistant output streams via onAgentEvent. */
  sendMessage: (threadId: string, text: string) =>
    invoke<Message>("send_message", { threadId, text }),
  cancelTurn: (threadId: string) => invoke<void>("cancel_turn", { threadId }),

  readFile: (projectId: string, path: string) =>
    invoke<string>("read_file", { projectId, path }),
  gitBranch: (projectId: string) => invoke<string | null>("git_branch", { projectId }),
  gitChanges: (projectId: string) => invoke<FileChange[]>("git_changes", { projectId }),
  /** Unified diff text for one file (empty string if unchanged). */
  gitFileDiff: (projectId: string, path: string) =>
    invoke<string>("git_file_diff", { projectId, path }),
  /** "Apply changes": stages the file (git add). */
  acceptFile: (projectId: string, path: string) =>
    invoke<void>("accept_file", { projectId, path }),
  /** "Reject": restores the file to HEAD (deletes it if untracked). */
  revertFile: (projectId: string, path: string) =>
    invoke<void>("revert_file", { projectId, path }),
  openInEditor: (projectId: string, path: string) =>
    invoke<void>("open_in_editor", { projectId, path }),
};

export function onAgentEvent(cb: (e: AgentEventEnvelope) => void): Promise<UnlistenFn> {
  return listen<AgentEventEnvelope>("agent-event", (e) => cb(e.payload));
}
