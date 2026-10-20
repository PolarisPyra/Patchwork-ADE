import type { FileChange, Message, Thread, ToolCall } from "~/api";

export function tool(overrides: Partial<ToolCall> & { id: string }): ToolCall {
  return {
    name: "Bash",
    summary: "",
    status: "done",
    subagent: null,
    parent: null,
    ...overrides,
  };
}

export function assistant(overrides: Partial<Message> = {}): Message {
  return {
    id: "m-assistant",
    role: "assistant",
    text: "",
    createdAt: 0,
    status: "complete",
    tools: [],
    plan: [],
    files: [],
    error: null,
    approvals: [],
    attachments: [],
    ...overrides,
  };
}

export function thread(messages: Message[], overrides: Partial<Thread> = {}): Thread {
  return {
    id: "t1",
    projectId: "p1",
    title: "Task",
    agent: "claude",
    model: "opus",
    accessMode: "full-access",
    sessionId: null,
    createdAt: 0,
    messages,
    ...overrides,
  };
}

export function change(path: string, overrides: Partial<FileChange> = {}): FileChange {
  return { path, status: "modified", additions: 1, deletions: 0, staged: false, ...overrides };
}
