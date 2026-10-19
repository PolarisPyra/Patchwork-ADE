import { useEffect, useRef } from "react";
import type { Icon } from "@phosphor-icons/react";

export interface MenuItem {
  label: string;
  Icon: Icon;
  danger?: boolean;
  onSelect: () => void;
}

/** Menu opened at a point, e.g. by right-clicking a row. Closes on outside click, Escape, or a choice. */
export default function ContextMenu({
  x,
  y,
  items,
  onClose,
}: {
  x: number;
  y: number;
  items: MenuItem[];
  onClose: () => void;
}) {
  const panel = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const outside = (e: PointerEvent) => {
      if (!panel.current?.contains(e.target as Node)) onClose();
    };
    const key = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("pointerdown", outside);
    document.addEventListener("keydown", key);
    window.addEventListener("resize", onClose);
    return () => {
      document.removeEventListener("pointerdown", outside);
      document.removeEventListener("keydown", key);
      window.removeEventListener("resize", onClose);
    };
  }, [onClose]);

  return (
    <div ref={panel} className="ws-menu ws-context-menu" role="menu" style={{ left: x, top: y }}>
      {items.map(({ label, Icon, danger, onSelect }) => (
        <button
          key={label}
          role="menuitem"
          className={`ws-menu-item${danger ? " ws-menu-danger" : ""}`}
          onClick={() => {
            onClose();
            onSelect();
          }}
        >
          <Icon size={14} />
          {label}
        </button>
      ))}
    </div>
  );
}
