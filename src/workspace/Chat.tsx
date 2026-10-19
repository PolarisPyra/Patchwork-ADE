import { useEffect, useRef, useState, type UIEvent } from "react";
import { FolderPlus } from "lucide-react";
import type { AgentKind, FileChange, Message, Project, Thread } from "../api";
import AgentIcon from "../components/AgentIcon";
import type { CanvasTab } from "./canvas/Canvas";
import Composer from "./Composer";
import Messages from "./Messages";
import { isWorking, type NewThreadOptions } from "./useThreads";
import { errorText } from "./util";

const SUGGESTIONS = [
  { label: "Explain this codebase", prefill: "Explain this codebase" },
  { label: "Find and fix a bug", prefill: "Find and fix a bug" },
  { label: "Write tests for…", prefill: "Write tests for " },
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
  onSend: (text: string, draft: NewThreadOptions) => Promise<void>;
  onCancel: (threadId: string) => Promise<void>;
  onSetModel: (threadId: string, model: string | null) => Promise<void>;
  onDeselect: () => void;
}

export default function Chat({
  project,
  thread,
  changes,
  defaultAgent,
  agents,
  onOpenFolder,
  onOpenCanvas,
  onSend,
  onCancel,
  onSetModel,
  onDeselect,
}: ChatProps) {
  // Drafts are kept per thread ("new" when nothing is selected).
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  // Agent/model chosen for the next thread; null means the defaults.
  const [pick, setPick] = useState<NewThreadOptions | null>(null);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const stickToBottom = useRef(true);

  const key = thread?.id ?? "new";
  const draft = drafts[key] ?? "";
  const setDraft = (text: string) => setDrafts((d) => ({ ...d, [key]: text }));

  const newOpts: NewThreadOptions = pick ?? { agent: defaultAgent, model: null };
  const empty = !thread || thread.messages.length === 0;
  const agent = thread?.agent ?? newOpts.agent;
  const model = thread ? thread.model : newOpts.model;
  const working = sending || isWorking(thread);

  useEffect(() => {
    stickToBottom.current = true;
  }, [thread?.id]);

  useEffect(() => {
    const el = scrollRef.current;
    if (el && stickToBottom.current) el.scrollTop = el.scrollHeight;
  }, [thread?.id, thread?.messages]);

  function onScroll(e: UIEvent<HTMLDivElement>) {
    const el = e.currentTarget;
    stickToBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 48;
  }

  async function dispatch(text: string, restoreOnError: boolean) {
    const sentKey = key;
    setError(null);
    setSending(true);
    stickToBottom.current = true;
    try {
      await onSend(text, newOpts);
    } catch (e) {
      setError(errorText(e));
      if (restoreOnError) {
        setDrafts((d) => (d[sentKey] ? d : { ...d, [sentKey]: text }));
      }
    } finally {
      setSending(false);
    }
  }

  function submit() {
    const text = draft.trim();
    if (!text || working || !project) return;
    setDraft("");
    void dispatch(text, true);
  }

  function retry(text: string) {
    if (!working) void dispatch(text, false);
  }

  function stop() {
    if (!thread) return;
    setError(null);
    onCancel(thread.id).catch((e: unknown) => setError(errorText(e)));
  }

  function changeAgent(next: AgentKind) {
    setPick({ agent: next, model: null });
    // Only empty threads reach here; deselect so the next send creates one with this agent.
    if (thread) onDeselect();
  }

  function changeModel(next: string | null) {
    if (!thread) {
      setPick({ agent: newOpts.agent, model: next });
      return;
    }
    setError(null);
    onSetModel(thread.id, next).catch((e: unknown) => setError(errorText(e)));
  }

  if (!project) {
    return (
      <div className="ws-chat">
        <div className="ws-chat-scroll">
          <div className="ws-chat-empty">
            <FolderPlus size={36} className="ws-icon-muted" />
            <h2>Open a project to get started</h2>
            <p className="ws-muted">Patchwork runs agents inside a project folder.</p>
            <button className="btn btn-primary btn-lg" onClick={onOpenFolder}>
              Open folder…
            </button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="ws-chat">
      <div className="ws-chat-scroll" ref={scrollRef} onScroll={onScroll}>
        {thread && !empty ? (
          <Messages
            thread={thread}
            changes={changes}
            busy={working}
            onOpenCanvas={onOpenCanvas}
            onRetry={retry}
          />
        ) : (
          <div className="ws-chat-empty">
            <AgentIcon kind={agent} size={40} />
            <h2>What should we build in {project.name}?</h2>
            <div className="ws-suggestions">
              {SUGGESTIONS.map((s) => (
                <button key={s.label} className="ws-chip" onClick={() => setDraft(s.prefill)}>
                  {s.label}
                </button>
              ))}
            </div>
          </div>
        )}
      </div>
      <div className="ws-composer-wrap">
        <Composer
          value={draft}
          onChange={setDraft}
          onSubmit={submit}
          onStop={stop}
          working={working}
          error={error}
          agent={agent}
          model={model}
          canPickAgent={empty}
          agents={agents}
          onAgentChange={changeAgent}
          onModelChange={changeModel}
        />
      </div>
    </div>
  );
}
