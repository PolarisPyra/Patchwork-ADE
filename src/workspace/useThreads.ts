import { useEffect, useRef, useState } from "react";
import {
  api,
  onAgentEvent,
  type AgentEvent,
  type AgentKind,
  type Message,
  type StepStatus,
  type Thread,
} from "../api";

export const NEW_TASK_TITLE = "New task";

export interface NewThreadOptions {
  agent: AgentKind;
  model: string | null;
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
      }));
    }
  }
}

/**
 * Threads for one project plus the selection. `select(null)` means no thread is
 * selected (the composer then creates one on send). `onTurnCompleted` fires after
 * any turn ends so the caller can refresh git state.
 */
export function useThreads(projectId: string | null, onTurnCompleted: () => void) {
  const [threads, setThreads] = useState<Thread[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const turnDone = useRef(onTurnCompleted);

  useEffect(() => {
    turnDone.current = onTurnCompleted;
  });

  // Load the project's threads; the most recent one is selected by default.
  useEffect(() => {
    if (!projectId) return;
    let cancelled = false;
    api.listThreads(projectId).then(
      (list) => {
        if (cancelled) return;
        setThreads(list);
        setSelectedId(list[0]?.id ?? null);
      },
      () => {
        if (!cancelled) setThreads([]);
      },
    );
    return () => {
      cancelled = true;
    };
  }, [projectId]);

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

  const visible = threads.filter((t) => t.projectId === projectId);
  const selected = visible.find((t) => t.id === selectedId) ?? null;

  async function createThread(opts: NewThreadOptions): Promise<Thread> {
    if (!projectId) throw new Error("No project is open");
    const thread = await api.createThread(projectId, opts.agent, opts.model);
    setThreads((prev) => [thread, ...prev]);
    setSelectedId(thread.id);
    return thread;
  }

  async function deleteThread(id: string): Promise<void> {
    await api.deleteThread(id);
    const next = visible.find((t) => t.id !== id)?.id ?? null;
    setThreads((prev) => prev.filter((t) => t.id !== id));
    setSelectedId((cur) => (cur === id ? next : cur));
  }

  async function setModel(id: string, model: string | null): Promise<void> {
    await api.setThreadModel(id, model);
    setThreads((prev) => prev.map((t) => (t.id === id ? { ...t, model } : t)));
  }

  /** Sends a message, creating a thread first when none is selected. */
  async function send(text: string, draft: NewThreadOptions): Promise<void> {
    const thread = selected ?? (await createThread(draft));
    const message = await api.sendMessage(thread.id, text);
    setThreads((prev) =>
      prev.map((t) =>
        t.id !== thread.id
          ? t
          : {
              ...t,
              title: t.title === NEW_TASK_TITLE ? titleFrom(text) : t.title,
              messages: upsertMessage(t.messages, message),
            },
      ),
    );
  }

  return {
    threads: visible,
    selected,
    select: setSelectedId,
    createThread,
    deleteThread,
    setModel,
    send,
  };
}
