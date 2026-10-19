import { useEffect, useRef, useState, type ReactNode } from "react";

interface DropdownProps {
  trigger: (state: { open: boolean; toggle: () => void }) => ReactNode;
  /** Menu body; receives `close` so items can dismiss the menu. */
  children: (close: () => void) => ReactNode;
  /** Open above the trigger instead of below it. */
  up?: boolean;
}

/** Minimal popup menu. Closes on outside click or when an item calls `close`. */
export default function Dropdown({ trigger, children, up = false }: DropdownProps) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node | null)) setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open]);

  return (
    <div className="ws-dropdown" ref={ref}>
      {trigger({ open, toggle: () => setOpen((o) => !o) })}
      {open && (
        <div className={`ws-menu${up ? " ws-menu-up" : ""}`} role="menu">
          {children(() => setOpen(false))}
        </div>
      )}
    </div>
  );
}
