import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent } from "react";
import { ArrowUpIcon, SquareIcon } from "@phosphor-icons/react";
import { api, type AccessMode, type AgentKind, type Attachment, type ModelOption } from "~/api";
import AccessPicker from "~/components/chat/AccessPicker";
import AttachmentChip from "~/components/chat/AttachmentChip";
import ModelPicker from "~/components/chat/ModelPicker";

interface ComposerProps {
  value: string;
  onChange: (text: string) => void;
  onSubmit: () => void;
  onStop: () => void;
  working: boolean;
  error: string | null;
  agent: AgentKind;
  model: string | null;
  /** Agents whose models are offered (only the thread's own once it has started). */
  agents: AgentKind[];
  /** Picking another agent's model switches the agent too. */
  onPickModel: (agent: AgentKind, model: string | null) => void;
  accessMode: AccessMode;
  onPickAccess: (mode: AccessMode) => void;
  attachments: Attachment[];
  onRemoveAttachment: (index: number) => void;
  /** A drag is hovering over the chat; the composer shows where it will land. */
  dropping: boolean;
  /** The chat's earlier messages, oldest first, recalled with the arrow keys. */
  history: HistoryEntry[];
}

export interface HistoryEntry {
  id: string;
  text: string;
}

/** The recalled history entry, while the draft still holds it unchanged. */
interface Recalled {
  id: string;
  text: string;
}

/** Slash commands offered while the draft is a single "/word". */
const COMMANDS = [{ name: "/goal", description: "Keep working until a condition is met" }];

/** Models per agent, fetched once per agent kind. */
function useModels(agents: AgentKind[]): Partial<Record<AgentKind, ModelOption[]>> {
  const [models, setModels] = useState<Partial<Record<AgentKind, ModelOption[]>>>({});
  const wanted = agents.join(",");
  useEffect(() => {
    let cancelled = false;
    for (const kind of wanted.split(",") as AgentKind[]) {
      api.listModels(kind).then(
        (list) => {
          if (!cancelled) setModels((prev) => (prev[kind] ? prev : { ...prev, [kind]: list }));
        },
        () => {},
      );
    }
    return () => {
      cancelled = true;
    };
  }, [wanted]);
  return models;
}

export default function Composer({
  value,
  onChange,
  onSubmit,
  onStop,
  working,
  error,
  agent,
  model,
  agents,
  onPickModel,
  accessMode,
  onPickAccess,
  attachments,
  onRemoveAttachment,
  dropping,
  history,
}: ComposerProps) {
  const ref = useRef<HTMLTextAreaElement>(null);
  // Grow with the content; CSS min/max-height keep it between about 3 and 14 rows.
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${el.scrollHeight}px`;
  }, [value]);

  const models = useModels(agents);
  // The slash menu lists commands for a draft that is still one "/word"; Escape hides it
  // until the draft changes again.
  const [menuClosed, setMenuClosed] = useState(false);
  const slash = agent !== "gemini" && /^\/\S*$/.test(value) ? value.toLowerCase() : null;
  const matches = COMMANDS.filter((c) => slash !== null && c.name.startsWith(slash));
  const menuOpen = !menuClosed && matches.length > 0;

  function complete(name: string) {
    onChange(`${name} `);
  }

  const recalled = useRef<Recalled | null>(null);

  /** Up from an empty draft recalls the previous message, Down the next; past the newest,
   * the draft empties. Editing a recalled message leaves the history. */
  function stepHistory(e: KeyboardEvent<HTMLTextAreaElement>): boolean {
    const back = e.key === "ArrowUp";
    if ((!back && e.key !== "ArrowDown") || e.shiftKey || e.altKey || e.metaKey || e.ctrlKey) {
      return false;
    }
    if (e.nativeEvent.isComposing || attachments.length > 0) return false;
    const el = e.currentTarget;
    const at = recalled.current?.text === value ? recalled.current : null;
    const index = at ? history.findIndex((h) => h.id === at.id) : -1;
    if (index < 0 && (value.length > 0 || !back)) return false;
    // Within a multi-line message the arrows move between its lines first.
    if (el.selectionStart !== el.selectionEnd) return false;
    const caret = el.selectionStart;
    if (back ? value.lastIndexOf("\n", caret - 1) !== -1 : value.indexOf("\n", caret) !== -1) {
      return false;
    }
    const next = back ? history[index < 0 ? history.length - 1 : index - 1] : history[index + 1];
    if (back && !next) return false;
    recalled.current = next ?? null;
    const text = next?.text ?? "";
    onChange(text);
    requestAnimationFrame(() => ref.current?.setSelectionRange(text.length, text.length));
    return true;
  }

  function onKeyDown(e: KeyboardEvent<HTMLTextAreaElement>) {
    if (!menuOpen && stepHistory(e)) {
      e.preventDefault();
      return;
    }
    if (menuOpen) {
      if (e.key === "Escape") {
        e.preventDefault();
        setMenuClosed(true);
        return;
      }
      // Enter on a command typed in full sends it (a bare "/goal" shows the goal).
      const typed = value.toLowerCase() === matches[0].name;
      if (
        e.key === "Tab" ||
        (e.key === "Enter" && !typed && !e.shiftKey && !e.nativeEvent.isComposing)
      ) {
        e.preventDefault();
        complete(matches[0].name);
        return;
      }
    }
    if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      onSubmit();
    }
  }

  return (
    <div
      className={`relative flex flex-col gap-2 rounded-[8px] border bg-editor pt-3.5 pr-3 pb-2.5 pl-3 focus-within:border-accent ${dropping ? "border-dashed border-accent" : "border-border-strong"}`}
    >
      {menuOpen && (
        <div className="absolute right-0 bottom-full left-0 mb-1.5 flex flex-col gap-px rounded-[var(--radius)] border border-border bg-panel p-1 shadow-[var(--shadow-popup)]">
          {matches.map((c) => (
            <button
              key={c.name}
              className="flex w-full cursor-pointer items-baseline gap-2.5 rounded-[var(--radius)] border-none bg-transparent px-2 py-1.5 text-left hover:bg-hover"
              // Keeps the focus in the textarea.
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => complete(c.name)}
            >
              <span className="font-[family-name:var(--font-mono)] text-fg">{c.name}</span>
              <span className="text-[length:var(--fs-sm)] text-fg-muted">{c.description}</span>
            </button>
          ))}
        </div>
      )}
      {attachments.length > 0 && (
        <div className="flex flex-wrap gap-1.5 px-1.5">
          {attachments.map((a, i) => (
            <AttachmentChip key={a.path} attachment={a} onRemove={() => onRemoveAttachment(i)} />
          ))}
        </div>
      )}
      <textarea
        ref={ref}
        className="min-h-16 max-h-[280px] resize-none overflow-y-auto border-none bg-transparent px-1.5 py-0 text-fg text-[length:var(--fs-md)] leading-[20px] placeholder:text-fg-subtle outline-none selectable"
        rows={1}
        placeholder="Reply or describe the next change…"
        value={value}
        onChange={(e) => {
          setMenuClosed(false);
          onChange(e.target.value);
        }}
        onKeyDown={onKeyDown}
      />
      <div className="flex items-center gap-1.5">
        <ModelPicker
          agent={agent}
          model={model}
          agents={agents}
          models={models}
          onPick={onPickModel}
        />
        <AccessPicker mode={accessMode} onPick={onPickAccess} />
        <span className="flex-1" />
        {working && (
          <button
            className="grid h-8 w-8 flex-none cursor-pointer place-items-center rounded-[var(--radius)] border-none bg-selected-muted text-fg enabled:hover:bg-accent-hover"
            onClick={onStop}
            title="Stop"
            aria-label="Stop"
          >
            <SquareIcon size={12} weight="fill" />
          </button>
        )}
        {(!working || value.trim() || attachments.length > 0) && (
          <button
            className="grid h-8 w-8 flex-none cursor-pointer place-items-center rounded-[var(--radius)] border-none bg-accent text-on-accent enabled:hover:bg-accent-hover disabled:cursor-default disabled:bg-selected-muted disabled:text-fg-subtle"
            onClick={onSubmit}
            disabled={!value.trim() && attachments.length === 0}
            title={working ? "Steer the running turn" : "Send"}
            aria-label={working ? "Steer the running turn" : "Send"}
          >
            <ArrowUpIcon size={16} />
          </button>
        )}
      </div>
      {error && <div className="text-[length:var(--fs-sm)] text-danger">{error}</div>}
    </div>
  );
}
