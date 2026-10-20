// Typed bridge to the Rust backend. Mirrors apps/server/src/types.rs and the
// commands registered in apps/desktop/src-tauri/src/lib.rs — keep all three in sync.
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

export type AgentKind = "claude" | "codex" | "gemini";
export type Theme = "light" | "dark" | "system";
export type Role = "user" | "assistant";
export type MessageStatus = "streaming" | "complete" | "error" | "cancelled";
export type StepStatus = "pending" | "running" | "done" | "error";
export type AttachmentKind = "image" | "file" | "folder";

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

/** A model the user can pick for an agent. `id: null` is the CLI's own default. */
export interface ModelOption {
  id: string | null;
  label: string;
  defaultModel?: string | null;
}

export interface ToolCall {
  id: string;
  name: string;
  summary: string;
  status: StepStatus;
  subagent: SubAgent | null;
  /** The subagent call (its id) this call ran inside, if any. */
  parent: string | null;
}

/** A subagent an agent started, e.g. with Claude Code's Task tool. */
export interface SubAgent {
  kind: string;
  description: string;
  /** null means the subagent inherits the parent's model. */
  model: string | null;
}

export interface PlanStep {
  text: string;
  status: StepStatus;
}

/** How much an agent may do without asking, like T3 Code's runtime modes. */
export type AccessMode = "supervised" | "auto-accept-edits" | "auto" | "full-access";

export type ApprovalStatus = "pending" | "allowed" | "denied";

/** An action the agent asked permission for during a turn. */
export interface Approval {
  id: string;
  /** e.g. "Run command", "Edit files". */
  title: string;
  detail: string;
  status: ApprovalStatus;
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
  approvals: Approval[];
  attachments: Attachment[];
}

/** Something dropped into the composer, sent to the agent with the message. */
export interface Attachment {
  kind: AttachmentKind;
  /** Absolute path on disk. */
  path: string;
  /** Last path component, for display. */
  name: string;
}

export interface Thread {
  id: string;
  /** null for a chat without a project (runs in a private scratch folder). */
  projectId: string | null;
  title: string;
  agent: AgentKind;
  model: string | null;
  accessMode: AccessMode;
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

/** One rate-limit window, e.g. the 5-hour session limit. */
export interface UsageWindow {
  label: string;
  /** 0–100. */
  usedPercent: number;
  /** Epoch ms. */
  resetsAt: number | null;
}

/** Subscription usage limits for one agent. */
export interface ProviderUsage {
  kind: AgentKind;
  plan: string | null;
  windows: UsageWindow[];
  /** Why no windows are shown, e.g. "Not signed in". */
  error: string | null;
  updatedAt: number | null;
}

/** Where imported conversations come from: an agent CLI, or T3 Code. */
export type ImportSource = AgentKind | "t3";

/** Conversations a source saved on disk that can be imported. */
export interface ImportScan {
  kind: ImportSource;
  found: number;
  /** Not yet in Patchwork. */
  new: number;
  /** Sub-agent runs, which are not offered for import. */
  subagents: number;
}

export type AgentEvent =
  | { type: "messageStarted"; message: Message }
  | { type: "textDelta"; messageId: string; text: string }
  | { type: "toolStarted"; messageId: string; tool: ToolCall }
  | { type: "toolFinished"; messageId: string; toolId: string; isError: boolean }
  | { type: "planUpdated"; messageId: string; steps: PlanStep[] }
  | { type: "fileTouched"; messageId: string; path: string }
  | { type: "approvalRequested"; messageId: string; approval: Approval }
  | { type: "approvalResolved"; messageId: string; approvalId: string; allowed: boolean }
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
  gemini: "Gemini CLI",
};

export const SOURCE_LABELS: Record<ImportSource, string> = { ...AGENT_LABELS, t3: "T3 Code" };

/** Import sources to offer: each connected agent's own files, plus T3 Code. */
export function importSourcesFor(agents: AgentKind[]): ImportSource[] {
  return [...agents, "t3"];
}

const agentStatusCache: Partial<Record<AgentKind, AgentStatus>> = {};
const pendingDetect: Partial<Record<AgentKind, Promise<AgentStatus>>> = {};

export const api = {
  getSettings: () => invoke<Settings>("get_settings"),
  saveSettings: (settings: Settings) => invoke<void>("save_settings", { settings }),
  detectAgent: async (kind: AgentKind, forceRefresh = false): Promise<AgentStatus> => {
    if (!forceRefresh && agentStatusCache[kind]) {
      return agentStatusCache[kind]!;
    }
    if (!pendingDetect[kind]) {
      pendingDetect[kind] = invoke<AgentStatus>("detect_agent", { kind })
        .then((status) => {
          agentStatusCache[kind] = status;
          delete pendingDetect[kind];
          return status;
        })
        .catch((err) => {
          delete pendingDetect[kind];
          throw err;
        });
    }
    return pendingDetect[kind]!;
  },
  /** Models for an agent, starting with "Default" (the CLI's own choice). */
  listModels: (kind: AgentKind) => invoke<ModelOption[]>("list_models", { kind }),
  /** Subscription usage limits. Cached by the backend; `refresh` asks for new
   * numbers, which it still throttles to avoid provider rate limits. */
  getUsage: (kind: AgentKind, refresh = false) =>
    invoke<ProviderUsage>("get_usage", { kind, refresh }),
  /** Counts conversations `kind` saved on disk that are not threads yet. */
  scanImports: (kind: ImportSource) => invoke<ImportScan>("scan_imports", { kind }),
  /** Imports those conversations as threads; returns how many were added. */
  importThreads: (kinds: ImportSource[]) => invoke<number>("import_threads", { kinds }),

  /** Registers an existing folder; also makes it the active project. */
  addProject: (path: string) => invoke<Project>("add_project", { path }),
  /** Creates `parent/name`, runs `git init`, registers it as the active project. */
  createProject: (parent: string, name: string) =>
    invoke<Project>("create_project", { parent, name }),
  renameProject: (id: string, name: string) => invoke<void>("rename_project", { id, name }),
  removeProject: (id: string) => invoke<void>("remove_project", { id }),

  /** All threads (project tasks and project-less chats), newest first. */
  listThreads: () => invoke<Thread[]>("list_threads"),
  createThread: (
    projectId: string | null,
    agent: AgentKind,
    model: string | null,
    accessMode: AccessMode,
  ) => invoke<Thread>("create_thread", { projectId, agent, model, accessMode }),
  deleteThread: (id: string) => invoke<void>("delete_thread", { id }),
  renameThread: (id: string, title: string) => invoke<void>("rename_thread", { id, title }),
  /** Sets agent + model; the agent can only change before the first message. */
  setThreadModel: (id: string, agent: AgentKind, model: string | null) =>
    invoke<void>("set_thread_model", { id, agent, model }),
  /** Takes effect from the thread's next turn. */
  setThreadAccessMode: (id: string, mode: AccessMode) =>
    invoke<void>("set_thread_access_mode", { id, mode }),
  /** Returns the stored user message; assistant output streams via onAgentEvent. */
  sendMessage: (threadId: string, text: string, attachments: Attachment[]) =>
    invoke<Message>("send_message", { threadId, text, attachments }),
  /** Classifies a dropped path as a file, folder, or image. */
  attachmentForPath: (path: string) => invoke<Attachment>("attachment_for_path", { path }),
  /** Lets the webview show an attached image as a thumbnail. */
  allowPreview: (path: string) => invoke<void>("allow_preview", { path }),
  cancelTurn: (threadId: string) => invoke<void>("cancel_turn", { threadId }),
  respondApproval: (threadId: string, approvalId: string, allow: boolean) =>
    invoke<void>("respond_approval", { threadId, approvalId, allow }),

  readFile: (projectId: string, path: string) => invoke<string>("read_file", { projectId, path }),
  gitBranch: (projectId: string) => invoke<string | null>("git_branch", { projectId }),
  gitChanges: (projectId: string) => invoke<FileChange[]>("git_changes", { projectId }),
  /** Unified diff text for one file (empty string if unchanged). */
  gitFileDiff: (projectId: string, path: string) =>
    invoke<string>("git_file_diff", { projectId, path }),
  /** "Apply changes": stages the file (git add). */
  acceptFile: (projectId: string, path: string) => invoke<void>("accept_file", { projectId, path }),
  /** "Reject": restores the file to HEAD (deletes it if untracked). */
  revertFile: (projectId: string, path: string) => invoke<void>("revert_file", { projectId, path }),
  openInEditor: (projectId: string, path: string) =>
    invoke<void>("open_in_editor", { projectId, path }),
};

export function onAgentEvent(cb: (e: AgentEventEnvelope) => void): Promise<UnlistenFn> {
  return listen<AgentEventEnvelope>("agent-event", (e) => cb(e.payload));
}
