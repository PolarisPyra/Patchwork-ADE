import { useState, type KeyboardEvent } from "react";
import { MagnifyingGlassIcon } from "@phosphor-icons/react";

export interface PaletteItem {
  id: string;
  group: string;
  label: string;
  hint?: string;
  run: () => void;
}

interface CommandPaletteProps {
  items: PaletteItem[];
  onClose: () => void;
}

export default function CommandPalette({ items, onClose }: CommandPaletteProps) {
  const [query, setQuery] = useState("");
  const [index, setIndex] = useState(0);

  const needle = query.trim().toLowerCase();
  const matches = items.filter((it) => it.label.toLowerCase().includes(needle));
  const active = Math.min(index, matches.length - 1);
  const groups = [...new Set(matches.map((it) => it.group))];

  function choose(item: PaletteItem) {
    onClose();
    item.run();
  }

  function onKeyDown(e: KeyboardEvent<HTMLInputElement>) {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setIndex(Math.min(active + 1, matches.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setIndex(Math.max(active - 1, 0));
    } else if (e.key === "Enter" && matches[active]) {
      e.preventDefault();
      choose(matches[active]);
    }
  }

  return (
    <div className="fixed inset-0 z-[90] flex items-start justify-center pt-[15vh]" onMouseDown={onClose}>
      <div
        className="flex max-h-[60vh] w-[560px] max-w-[calc(100vw_-_32px)] flex-col overflow-hidden rounded-[var(--radius-lg)] border border-border-strong bg-elevated shadow-[var(--shadow-popup)]"
        role="dialog"
        aria-label="Command palette"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="flex h-11 items-center gap-2 border-b border-border px-3 text-fg-subtle">
          <MagnifyingGlassIcon size={15} />
          <input
            className="min-w-0 flex-1 select-text border-none bg-transparent text-fg text-[length:var(--fs-lg)] outline-none"
            autoFocus
            placeholder="Search actions, tasks and projects…"
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setIndex(0);
            }}
            onKeyDown={onKeyDown}
          />
        </div>
        <div className="overflow-y-auto p-1.5">
          {matches.length === 0 && (
            <div className="px-3 py-2 text-[length:var(--fs-sm)] text-fg-subtle">No matches</div>
          )}
          {groups.map((group) => (
            <div key={group}>
              <div className="px-2 pt-2 pb-1 text-[length:var(--fs-xs)] tracking-[0.06em] text-fg-subtle uppercase">
                {group}
              </div>
              {matches.map((it, i) =>
                it.group !== group ? null : (
                  <button
                    key={it.id}
                    className={`flex h-[30px] w-full cursor-pointer items-center gap-2 rounded-[var(--radius-sm)] border-none bg-transparent px-2 text-left text-fg ${i === active ? "bg-selected" : ""}`}
                    onMouseMove={() => setIndex(i)}
                    onClick={() => choose(it)}
                  >
                    <span className="min-w-0 flex-1 overflow-hidden text-ellipsis whitespace-nowrap">
                      {it.label}
                    </span>
                    {it.hint && (
                      <span className="max-w-[260px] flex-none overflow-hidden text-ellipsis whitespace-nowrap text-[length:var(--fs-xs)] text-fg-subtle">
                        {it.hint}
                      </span>
                    )}
                  </button>
                ),
              )}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
