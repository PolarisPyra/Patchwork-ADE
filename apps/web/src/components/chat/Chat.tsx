import { useEffect, useRef, useState, type UIEvent } from "react";
import { FolderPlusIcon } from "@phosphor-icons/react";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import {
  api,
  type AccessMode,
  type AgentKind,
  type Attachment,
  type FileChange,
  type Message,
  type Project,
  type Thread,
} from "~/api";
import ProviderLogos from "~/components/ProviderLogos";
import type { CanvasTab } from "~/components/canvas/Canvas";
import { lastAccessMode } from "~/components/chat/AccessPicker";
import Composer from "~/components/chat/Composer";
import Messages from "~/components/chat/Messages";
import { isWorking, type NewThreadOptions } from "~/hooks/useThreads";
import { errorText } from "~/lib/util";

const SUGGESTIONS = [
  { label: "Explain this codebase", prefill: "Explain this codebase" },
  { label: "Find and fix a bug", prefill: "Find and fix a bug" },
  { label: "Write tests for…", prefill: "Write tests for " },
];

const CHAT_SUGGESTIONS = [
  { label: "Explain a concept", prefill: "Explain " },
  { label: "Draft a script", prefill: "Write a script that " },
  { label: "Review a snippet", prefill: "Review this code:\n" },
];

interface ChatProps {
  project: Project | null;
  thread: Thread | null;
  changes: FileChange[];
  defaultAgent: AgentKind;
  /** Connected agents offered in the composer's agent picker. */
  agents: AgentKind[];
  onOpenFolder: () => void;
  onOpenCanvas: (path: string, message: Message | null, tab: CanvasTab) => void;
  onShowChanges: () => void;
  onSend: (text: string, attachments: Attachment[], draft: NewThreadOptions) => Promise<void>;
  onCancel: (threadId: string) => Promise<void>;
  onSetModel: (threadId: string, agent: AgentKind, model: string | null) => Promise<void>;
  onSetAccessMode: (threadId: string, mode: AccessMode) => Promise<void>;
}

export default function Chat({
  project,
  thread,
  changes,
  defaultAgent,
  agents,
  onOpenFolder,
  onOpenCanvas,
  onShowChanges,
  onSend,
  onCancel,
  onSetModel,
  onSetAccessMode,
}: ChatProps) {
  // Drafts are kept per thread ("new" when nothing is selected).
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  // Files and images dropped into the composer, kept per thread like drafts.
  const [pending, setPending] = useState<Record<string, Attachment[]>>({});
  const [dropping, setDropping] = useState(false);
  // Agent/model/access chosen for the next thread; null means the defaults.
  const [pick, setPick] = useState<NewThreadOptions | null>(null);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const stickToBottom = useRef(true);

  const key = thread?.id ?? "new";
  const keyRef = useRef(key);
  const draft = drafts[key] ?? "";
  const setDraft = (text: string) => setDrafts((d) => ({ ...d, [key]: text }));
  const attachments = pending[key] ?? [];
  const setAttachments = (next: Attachment[]) => setPending((p) => ({ ...p, [key]: next }));

  const newOpts: NewThreadOptions = pick ?? {
    agent: defaultAgent,
    model: null,
    accessMode: lastAccessMode(),
  };
  const empty = !thread || thread.messages.length === 0;
  const agent = thread?.agent ?? newOpts.agent;
  const model = thread ? thread.model : newOpts.model;
  const accessMode = thread?.accessMode ?? newOpts.accessMode;
  const working = sending || isWorking(thread);
  // Before the first message any connected agent's models are offered.
  const offered = agents.includes(agent) ? agents : [agent, ...agents];

  useEffect(() => {
    stickToBottom.current = true;
  }, [thread?.id]);

  useEffect(() => {
    const el = scrollRef.current;
    if (el && stickToBottom.current) el.scrollTop = el.scrollHeight;
  }, [thread?.id, thread?.messages]);

  useEffect(() => {
    keyRef.current = key;
  }, [key]);

  // Tauri hands dropped files over as paths (HTML drop events carry none), so drops are
  // listened for on the webview and kept only when they land on the chat.
  useEffect(() => {
    async function attach(paths: string[]) {
      const sentKey = keyRef.current;
      try {
        const found = await Promise.all(paths.map((path) => api.attachmentForPath(path)));
        setPending((prev) => {
          const current = prev[sentKey] ?? [];
          const fresh = found.filter((a) => !current.some((c) => c.path === a.path));
          return { ...prev, [sentKey]: [...current, ...fresh] };
        });
      } catch (e) {
        setError(errorText(e));
      }
    }
    function overChat(position: { x: number; y: number }) {
      const el = rootRef.current;
      if (!el) return false;
      // Positions are physical pixels; the chat's rect is in CSS pixels.
      const scale = window.devicePixelRatio;
      const r = el.getBoundingClientRect();
      const x = position.x / scale;
      const y = position.y / scale;
      return x >= r.left && x <= r.right && y >= r.top && y <= r.bottom;
    }
    let cancelled = false;
    let unlisten: (() => void) | undefined;
    void getCurrentWebview()
      .onDragDropEvent(({ payload }) => {
        if (payload.type === "leave") {
          setDropping(false);
        } else if (payload.type === "drop") {
          setDropping(false);
          if (overChat(payload.position)) void attach(payload.paths);
        } else {
          setDropping(overChat(payload.position));
        }
      })
      .then((fn) => {
        if (cancelled) fn();
        else unlisten = fn;
      });
    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, []);

  function onScroll(e: UIEvent<HTMLDivElement>) {
    const el = e.currentTarget;
    stickToBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 48;
  }

  async function dispatch(text: string, files: Attachment[], restoreOnError: boolean) {
    const sentKey = key;
    setError(null);
    setSending(true);
    stickToBottom.current = true;
    try {
      await onSend(text, files, newOpts);
    } catch (e) {
      setError(errorText(e));
      if (restoreOnError) {
        setDrafts((d) => (d[sentKey] ? d : { ...d, [sentKey]: text }));
        setPending((p) => (p[sentKey] ? p : { ...p, [sentKey]: files }));
      }
    } finally {
      setSending(false);
    }
  }

  function submit() {
    const text = draft.trim();
    if ((!text && attachments.length === 0) || working) return;
    setDraft("");
    setAttachments([]);
    void dispatch(text, attachments, true);
  }

  function retry(message: Message) {
    if (!working) void dispatch(message.text, message.attachments, false);
  }

  function stop() {
    if (!thread) return;
    setError(null);
    onCancel(thread.id).catch((e: unknown) => setError(errorText(e)));
  }

  function pickModel(nextAgent: AgentKind, nextModel: string | null) {
    if (!thread) {
      setPick({ ...newOpts, agent: nextAgent, model: nextModel });
      return;
    }
    setError(null);
    onSetModel(thread.id, nextAgent, nextModel).catch((e: unknown) => setError(errorText(e)));
  }

  function pickAccess(mode: AccessMode) {
    if (!thread) {
      setPick({ ...newOpts, accessMode: mode });
      return;
    }
    setError(null);
    onSetAccessMode(thread.id, mode).catch((e: unknown) => setError(errorText(e)));
  }

  function respond(approvalId: string, allow: boolean) {
    if (!thread) return;
    setError(null);
    api.respondApproval(thread.id, approvalId, allow).catch((e: unknown) => setError(errorText(e)));
  }

  const isNew = !thread || empty;
  return (
    <div
      className={`flex min-h-0 min-w-0 flex-1 flex-col${isNew ? " justify-center" : ""}`}
      ref={rootRef}
    >
      <div
        className={`min-h-0 overflow-y-auto ${isNew ? "flex-none" : "flex-1"}`}
        ref={scrollRef}
        onScroll={onScroll}
      >
        {!isNew ? (
          <Messages
            thread={thread}
            changes={changes}
            busy={working}
            onOpenCanvas={project ? onOpenCanvas : undefined}
            onShowChanges={onShowChanges}
            onRetry={retry}
            onRespond={respond}
          />
        ) : (
          <div className="flex h-auto flex-col items-center justify-center gap-4 p-6 text-center">
            <ProviderLogos kind={agent} size={40} />
            <h2 className="m-0 text-[length:var(--fs-xl)] font-semibold">
              {project ? `What should we build in ${project.name}?` : "What's on your mind?"}
            </h2>
            {!project && (
              <>
                <p className="-mt-1.5 mb-0 text-fg-muted">
                  This chat has no project; the agent works in a private scratch folder.
                </p>
                <button className="btn my-2 h-8 !px-4" onClick={onOpenFolder}>
                  <FolderPlusIcon size={14} />
                  Open a project
                </button>
              </>
            )}
            <div className="flex max-w-[560px] flex-wrap justify-center gap-2">
              {(project ? SUGGESTIONS : CHAT_SUGGESTIONS).map((s) => (
                <button
                  key={s.label}
                  className="h-7 cursor-pointer rounded-[14px] border border-border-strong bg-panel px-3 text-fg hover:bg-hover"
                  onClick={() => setDraft(s.prefill)}
                >
                  {s.label}
                </button>
              ))}
            </div>
          </div>
        )}
      </div>
      <div className="mx-auto w-full max-w-[820px] flex-none box-border px-6 pb-4">
        <Composer
          value={draft}
          onChange={setDraft}
          onSubmit={submit}
          onStop={stop}
          working={working}
          error={error}
          agent={agent}
          model={model}
          agents={empty ? offered : [agent]}
          onPickModel={pickModel}
          accessMode={accessMode}
          onPickAccess={pickAccess}
          attachments={attachments}
          onRemoveAttachment={(i) => setAttachments(attachments.filter((_, j) => j !== i))}
          dropping={dropping}
        />
      </div>
    </div>
  );
}
