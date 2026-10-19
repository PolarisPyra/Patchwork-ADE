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
    <div className="ws-palette-backdrop" onMouseDown={onClose}>
      <div
        className="ws-palette"
        role="dialog"
        aria-label="Command palette"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="ws-palette-input">
          <MagnifyingGlassIcon size={15} />
          <input
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
        <div className="ws-palette-list">
          {matches.length === 0 && <div className="ws-muted-note">No matches</div>}
          {groups.map((group) => (
            <div key={group}>
              <div className="ws-palette-group">{group}</div>
              {matches.map((it, i) =>
                it.group !== group ? null : (
                  <button
                    key={it.id}
                    className={`ws-palette-item${i === active ? " active" : ""}`}
                    onMouseMove={() => setIndex(i)}
                    onClick={() => choose(it)}
                  >
                    <span className="ws-palette-label">{it.label}</span>
                    {it.hint && <span className="ws-palette-hint">{it.hint}</span>}
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
