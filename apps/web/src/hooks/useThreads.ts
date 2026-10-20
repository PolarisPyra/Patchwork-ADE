import { useCallback, useEffect, useRef, useState } from "react";
import {
  api,
  onAgentEvent,
  type AccessMode,
  type AgentEvent,
  type AgentKind,
  type Attachment,
  type Message,
  type StepStatus,
  type Thread,
} from "~/api";

export interface NewThreadOptions {
  agent: AgentKind;
  model: string | null;
  accessMode: AccessMode;
}

/** True while any message in the thread is still streaming. */
export function isWorking(thread: Thread | null): boolean {
  return thread?.messages.some((m) => m.status === "streaming") ?? false;
}

/** Same rule as the backend: first line, trimmed, at most 60 characters. */
function titleFrom(text: string): string {
  const line = (text.split("\n")[0] ?? "").trim();
  return Array.from(line).slice(0, 60).join("");
}

/** Adds or replaces a message, keeping creation order. */
function upsertMessage(list: Message[], msg: Message): Message[] {
  const rest = list.filter((m) => m.id !== msg.id);
  const at = rest.findIndex((m) => m.createdAt >= msg.createdAt);
  return at === -1 ? [...rest, msg] : [...rest.slice(0, at), msg, ...rest.slice(at)];
}

function updateMessage(thread: Thread, messageId: string, fn: (m: Message) => Message): Thread {
  return { ...thread, messages: thread.messages.map((m) => (m.id === messageId ? fn(m) : m)) };
}

/** Applies one streamed agent event. Pure: returns a new thread object. */
export function applyAgentEvent(thread: Thread, event: AgentEvent): Thread {
  switch (event.type) {
    case "messageStarted":
      return { ...thread, messages: upsertMessage(thread.messages, event.message) };
    case "textDelta": {
      const { messageId, text } = event;
      return updateMessage(thread, messageId, (m) => ({ ...m, text: m.text + text }));
    }
    case "toolStarted": {
      const { messageId, tool } = event;
      return updateMessage(thread, messageId, (m) => ({ ...m, tools: [...m.tools, tool] }));
    }
    case "toolFinished": {
      const { messageId, toolId, isError } = event;
      const status: StepStatus = isError ? "error" : "done";
      return updateMessage(thread, messageId, (m) => ({
        ...m,
        tools: m.tools.map((t) => (t.id === toolId ? { ...t, status } : t)),
      }));
    }
    case "planUpdated": {
      const { messageId, steps } = event;
      return updateMessage(thread, messageId, (m) => ({ ...m, plan: steps }));
    }
    case "fileTouched": {
      const { messageId, path } = event;
      return updateMessage(thread, messageId, (m) =>
        m.files.includes(path) ? m : { ...m, files: [...m.files, path] },
      );
    }
    case "approvalRequested": {
      const { messageId, approval } = event;
      return updateMessage(thread, messageId, (m) => ({
        ...m,
        approvals: [...m.approvals, approval],
      }));
    }
    case "approvalResolved": {
      const { messageId, approvalId, allowed } = event;
      const status = allowed ? "allowed" : "denied";
      return updateMessage(thread, messageId, (m) => ({
        ...m,
        approvals: m.approvals.map((a) => (a.id === approvalId ? { ...a, status } : a)),
      }));
    }
    case "turnCompleted": {
      const { messageId, status, error } = event;
      // Nothing can still be running once the turn has ended (mirrors runner.rs).
      const toolEnd = status === "complete" ? "done" : "error";
      return updateMessage(thread, messageId, (m) => ({
        ...m,
        status,
        error,
        tools: m.tools.map((t) => (t.status === "running" ? { ...t, status: toolEnd } : t)),
        plan: m.plan.map((s) => (s.status === "running" ? { ...s, status: "pending" } : s)),
        approvals: m.approvals.map((a) =>
          a.status === "pending" ? { ...a, status: "denied" } : a,
        ),
      }));
    }
  }
}

/**
 * Every thread (project tasks and project-less chats) plus the selection.
 * `select(null)` means no thread is selected (the composer then creates one on
 * send). `initialProjectId` picks the default selection after loading.
 * `onTurnCompleted` fires after any turn ends so the caller can refresh git state.
 */
export function useThreads(initialProjectId: string | null, onTurnCompleted: () => void) {
  const [threads, setThreads] = useState<Thread[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const turnDone = useRef(onTurnCompleted);
  const initialProject = useRef(initialProjectId);

  useEffect(() => {
    turnDone.current = onTurnCompleted;
  });

  // Load once; select the newest thread of the initial project (or chat).
  useEffect(() => {
    let cancelled = false;
    api.listThreads().then(
      (list) => {
        if (cancelled) return;
        setThreads(list);
        setSelectedId(list.find((t) => t.projectId === initialProject.current)?.id ?? null);
      },
      () => {
        if (!cancelled) setThreads([]);
      },
    );
    return () => {
      cancelled = true;
    };
  }, []);

  /** Re-reads every thread from the backend, e.g. after importing. */
  const reload = useCallback(() => api.listThreads().then(setThreads), []);

  // Subscribe once for the app's lifetime; events for unknown threads are ignored.
  useEffect(() => {
    let disposed = false;
    let unlisten: (() => void) | undefined;
    void onAgentEvent(({ threadId, event }) => {
      setThreads((prev) =>
        prev.some((t) => t.id === threadId)
          ? prev.map((t) => (t.id === threadId ? applyAgentEvent(t, event) : t))
          : prev,
      );
      if (event.type === "turnCompleted") turnDone.current();
    }).then((u) => {
      if (disposed) u();
      else unlisten = u;
    });
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, []);

  const selected = threads.find((t) => t.id === selectedId) ?? null;

  /** Creates a thread in `projectId` (null: a chat without a project) and selects it. */
  async function createThread(projectId: string | null, opts: NewThreadOptions): Promise<Thread> {
    const thread = await api.createThread(projectId, opts.agent, opts.model, opts.accessMode);
    setThreads((prev) => [thread, ...prev]);
    setSelectedId(thread.id);
    return thread;
  }

  async function deleteThread(id: string): Promise<void> {
    await api.deleteThread(id);
    setThreads((prev) => prev.filter((t) => t.id !== id));
    setSelectedId((cur) => (cur === id ? null : cur));
  }

  async function renameThread(id: string, title: string): Promise<void> {
    await api.renameThread(id, title);
    setThreads((prev) => prev.map((t) => (t.id === id ? { ...t, title } : t)));
  }

  async function setModel(id: string, agent: AgentKind, model: string | null): Promise<void> {
    await api.setThreadModel(id, agent, model);
    setThreads((prev) => prev.map((t) => (t.id === id ? { ...t, agent, model } : t)));
  }

  async function setAccessMode(id: string, accessMode: AccessMode): Promise<void> {
    await api.setThreadAccessMode(id, accessMode);
    setThreads((prev) => prev.map((t) => (t.id === id ? { ...t, accessMode } : t)));
  }

  /** Sends a message, creating a thread in `projectId` first when none is selected. */
  async function send(
    text: string,
    attachments: Attachment[],
    draft: NewThreadOptions,
    projectId: string | null,
  ): Promise<void> {
    const thread = selected ?? (await createThread(projectId, draft));
    const message = await api.sendMessage(thread.id, text, attachments);
    setThreads((prev) =>
      prev.map((t) =>
        t.id !== thread.id
          ? t
          : {
              ...t,
              // Mirrors the backend: the first message names the thread.
              title: t.messages.length === 0 ? titleFrom(text) : t.title,
              messages: upsertMessage(t.messages, message),
            },
      ),
    );
  }

  return {
    threads,
    reload,
    selected,
    select: setSelectedId,
    createThread,
    deleteThread,
    renameThread,
    setModel,
    setAccessMode,
    send,
  };
}
