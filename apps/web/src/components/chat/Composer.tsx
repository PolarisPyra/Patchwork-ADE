import { useEffect, useRef, useState } from "react";
import { ArrowUpIcon, SquareIcon } from "@phosphor-icons/react";
import { EditorContent, useEditor } from "@tiptap/react";
import { api, type AccessMode, type AgentKind, type Attachment, type ModelOption } from "~/api";
import AccessPicker from "~/components/chat/AccessPicker";
import AttachmentChip from "~/components/chat/AttachmentChip";
import {
  composerExtensions,
  keepDraftText,
  type MentionSuggestion,
} from "~/components/chat/composerExtensions";
import ModelPicker from "~/components/chat/ModelPicker";

interface ComposerProps {
  /** The draft as Markdown. */
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
  /** Project files an @ mention can refer to, relative to the project root. */
  files: string[];
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

/** An entry in the @ menu. */
interface MentionItem {
  id: string;
  label: string;
}

interface MentionMenu {
  items: MentionItem[];
  index: number;
}

/** Most files the @ menu offers at once. */
const MENTION_LIMIT = 8;

const EDITOR_CLASS =
  "min-h-16 max-h-[280px] overflow-y-auto whitespace-pre-wrap break-words px-1.5 text-fg text-[length:var(--fs-md)] leading-[20px] outline-none selectable [&_p]:m-0 [&_ul]:my-0 [&_ol]:my-0 [&_ul]:pl-5 [&_ol]:pl-5 [&_pre]:my-1 [&_pre]:rounded-[var(--radius-sm)] [&_pre]:bg-panel [&_pre]:px-2.5 [&_pre]:py-1.5 [&_pre]:font-[family-name:var(--font-mono)] [&_pre]:text-[12px] [&_code]:font-[family-name:var(--font-mono)] [&_code]:text-[12px]";

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
  files,
}: ComposerProps) {
  const models = useModels(agents);
  // The slash menu lists commands for a draft that is still one "/word"; Escape hides it
  // until the draft changes again.
  const [menuClosed, setMenuClosed] = useState(false);
  const slash = agent !== "gemini" && /^\/\S*$/.test(value) ? value.toLowerCase() : null;
  const matches = COMMANDS.filter((c) => slash !== null && c.name.startsWith(slash));
  const menuOpen = !menuClosed && matches.length > 0;

  // The @ menu lists project files. Its handlers run inside the editor, so state they touch
  // lives in refs as well as in React state, and the editor always sees the current values.
  const filesRef = useRef(files);
  filesRef.current = files;
  const [mention, setMention] = useState<MentionMenu | null>(null);
  const mentionItems = useRef<MentionItem[]>([]);
  const mentionIndex = useRef(0);
  const mentionOpen = useRef(false);
  const mentionPick = useRef<(item: MentionItem) => void>(() => undefined);

  function showMention(items: MentionItem[], pick: (item: MentionItem) => void) {
    mentionItems.current = items;
    mentionPick.current = pick;
    setMention({ items, index: mentionIndex.current });
  }
  function moveMention(index: number) {
    mentionIndex.current = index;
    setMention((prev) => (prev ? { ...prev, index } : prev));
  }
  function closeMention() {
    mentionOpen.current = false;
    setMention(null);
  }

  const mentionSuggestion: MentionSuggestion = {
    char: "@",
    items: ({ query }) => {
      const q = query.toLowerCase();
      return filesRef.current
        .filter((path) => path.toLowerCase().includes(q))
        .sort(
          (a, b) => Number(!a.toLowerCase().startsWith(q)) - Number(!b.toLowerCase().startsWith(q)),
        )
        .slice(0, MENTION_LIMIT)
        .map((path) => ({ id: path, label: path }));
    },
    render: () => ({
      onStart: (props) => {
        mentionOpen.current = true;
        mentionIndex.current = 0;
        showMention(props.items, props.command);
      },
      onUpdate: (props) => {
        mentionIndex.current = 0;
        showMention(props.items, props.command);
      },
      onKeyDown: ({ event }) => {
        const count = mentionItems.current.length;
        if (event.key === "ArrowDown" && count > 0) {
          moveMention((mentionIndex.current + 1) % count);
          return true;
        }
        if (event.key === "ArrowUp" && count > 0) {
          moveMention((mentionIndex.current + count - 1) % count);
          return true;
        }
        if ((event.key === "Enter" || event.key === "Tab") && count > 0) {
          const item = mentionItems.current[mentionIndex.current];
          if (item) mentionPick.current(item);
          return true;
        }
        if (event.key === "Escape") {
          closeMention();
          return true;
        }
        return false;
      },
      onExit: closeMention,
    }),
  };

  // Event handlers are read through refs, so the editor always calls the current ones.
  const changed = useRef(onChange);
  changed.current = onChange;
  const keyDown = useRef<(event: KeyboardEvent) => boolean>(() => false);

  const editor = useEditor({
    extensions: composerExtensions("Reply or describe the next change…", mentionSuggestion),
    content: value,
    contentType: "markdown",
    immediatelyRender: false,
    editorProps: {
      attributes: { class: EDITOR_CLASS },
      handleKeyDown: (_view, event) => keyDown.current(event),
    },
    onCreate: ({ editor }) => {
      if (editor.markdown) keepDraftText(editor.markdown);
    },
    onUpdate: ({ editor }) => {
      setMenuClosed(false);
      changed.current(editor.getMarkdown());
    },
  });

  // A draft changed from outside (history, a completed command, sending) loads into the editor.
  // Edits the user typed already match, so typing never reloads the document.
  useEffect(() => {
    if (!editor || editor.getMarkdown() === value) return;
    editor.commands.setContent(value, { contentType: "markdown", emitUpdate: false });
    if (editor.isFocused) editor.commands.focus("end");
  }, [editor, value]);

  const recalled = useRef<Recalled | null>(null);

  function complete(name: string) {
    if (!editor) return;
    // The menu only shows for a bare "/word", so the whole draft is replaced by the command.
    editor
      .chain()
      .focus()
      .selectAll()
      .deleteSelection()
      .insertContent(
        name === "/goal" ? [{ type: "goalCommand" }, { type: "text", text: " " }] : `${name} `,
      )
      .run();
    changed.current(editor.getMarkdown());
  }

  /** Up from the first line recalls the previous message, Down the next; past the newest, the
   * draft empties. Editing a recalled message leaves the history. */
  function stepHistory(event: KeyboardEvent, ed: NonNullable<typeof editor>): boolean {
    const back = event.key === "ArrowUp";
    if (
      (!back && event.key !== "ArrowDown") ||
      event.shiftKey ||
      event.altKey ||
      event.metaKey ||
      event.ctrlKey
    ) {
      return false;
    }
    if (attachments.length > 0) return false;
    const { selection, doc } = ed.state;
    if (!selection.empty) return false;
    // Within a multi-line draft the arrows move between its lines first.
    const pos = selection.from;
    const lines = back
      ? doc.textBetween(0, pos, "\n", "\n")
      : doc.textBetween(pos, doc.content.size, "\n", "\n");
    if (lines.includes("\n")) return false;

    const at = recalled.current?.text === value ? recalled.current : null;
    const index = at ? history.findIndex((h) => h.id === at.id) : -1;
    if (index < 0 && (value.length > 0 || !back)) return false;
    const next = back ? history[index < 0 ? history.length - 1 : index - 1] : history[index + 1];
    if (back && !next) return false;
    recalled.current = next ?? null;
    changed.current(next?.text ?? "");
    return true;
  }

  function handleKey(event: KeyboardEvent): boolean {
    if (!editor || event.isComposing) return false;
    // While the @ menu is open, the editor's suggestion handler gets the keys.
    if (mentionOpen.current) return false;
    if (!menuOpen && stepHistory(event, editor)) return true;
    if (menuOpen) {
      if (event.key === "Escape") {
        setMenuClosed(true);
        return true;
      }
      // Enter on a command typed in full sends it (a bare "/goal" shows the goal).
      const typed = value.toLowerCase() === matches[0].name;
      if (event.key === "Tab" || (event.key === "Enter" && !typed && !event.shiftKey)) {
        complete(matches[0].name);
        return true;
      }
    }
    // Enter sends; Shift+Enter starts a new line (the editor's default).
    if (event.key === "Enter" && !event.shiftKey) {
      onSubmit();
      return true;
    }
    return false;
  }
  keyDown.current = handleKey;

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
              // Keeps the focus in the editor.
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => complete(c.name)}
            >
              <span className="font-[family-name:var(--font-mono)] text-fg">{c.name}</span>
              <span className="text-[length:var(--fs-sm)] text-fg-muted">{c.description}</span>
            </button>
          ))}
        </div>
      )}
      {mention && (
        <div className="absolute right-0 bottom-full left-0 mb-1.5 flex flex-col gap-px rounded-[var(--radius)] border border-border bg-panel p-1 shadow-[var(--shadow-popup)]">
          {mention.items.length === 0 && (
            <div className="px-2 py-1.5 text-[length:var(--fs-sm)] text-fg-muted">
              No matching files
            </div>
          )}
          {mention.items.map((item, i) => (
            <button
              key={item.id}
              className={`flex w-full cursor-pointer items-baseline rounded-[var(--radius)] border-none px-2 py-1.5 text-left font-[family-name:var(--font-mono)] text-[length:var(--fs-sm)] text-fg ${i === mention.index ? "bg-selected" : "bg-transparent hover:bg-hover"}`}
              // Keeps the focus in the editor.
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => mentionPick.current(item)}
            >
              {item.label}
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
      <EditorContent editor={editor} className="composer-editor min-w-0" />
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
