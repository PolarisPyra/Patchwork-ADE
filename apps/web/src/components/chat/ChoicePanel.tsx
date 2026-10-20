import { useEffect } from "react";

interface ChoicePanelProps {
  /** The options the agent offered. */
  options: string[];
  /** Sends the chosen option as the next message. */
  onPick: (option: string) => void;
  /** Hides the panel and moves the focus to the composer to write an answer. */
  onOwn: () => void;
  /** Number keys choose only while the draft is empty, so they still type digits. */
  draftEmpty: boolean;
}

/** Numbered options above the composer. Keys 1 to N choose an option; the last one writes an answer. */
export default function ChoicePanel({ options, onPick, onOwn, draftEmpty }: ChoicePanelProps) {
  const own = options.length + 1;

  useEffect(() => {
    if (!draftEmpty) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.ctrlKey || e.metaKey || e.altKey || e.shiftKey) return;
      // A field the user is typing in keeps its digits.
      const target = e.target as HTMLElement | null;
      if (target?.matches?.("input, textarea, select")) return;
      const n = Number(e.key);
      if (!Number.isInteger(n) || n < 1 || n > own) return;
      e.preventDefault();
      if (n === own) onOwn();
      else onPick(options[n - 1]);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [draftEmpty, options, onPick, onOwn, own]);

  const rowClass =
    "flex w-full cursor-pointer items-center gap-3 rounded-[var(--radius-sm)] border-none bg-transparent px-2.5 py-1.5 text-left text-[length:var(--fs-md)] text-fg hover:bg-hover";

  return (
    <div
      role="group"
      aria-label="Choose a reply"
      className="mb-1.5 flex flex-col gap-px rounded-[var(--radius)] border border-border bg-panel p-1"
    >
      {options.map((option, i) => (
        <button key={option} className={rowClass} onClick={() => onPick(option)}>
          <kbd className="kbd flex-none">{i + 1}</kbd>
          <span className="min-w-0 flex-1 truncate">{option}</span>
        </button>
      ))}
      <button className={rowClass} onClick={onOwn}>
        <kbd className="kbd flex-none">{own}</kbd>
        <span className="min-w-0 flex-1 truncate text-fg-muted">Submit my own response</span>
      </button>
    </div>
  );
}
