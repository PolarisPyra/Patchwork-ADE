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
    <div className="relative inline-flex min-w-0" ref={ref}>
      {trigger({ open, toggle: () => setOpen((o) => !o) })}
      {open && (
        <div
          className={`absolute left-0 z-20 flex min-w-[200px] flex-col rounded-[var(--radius)] border border-border-strong bg-elevated p-1 shadow-[var(--shadow-popup)] ${up ? "bottom-[calc(100%_+_4px)]" : "top-[calc(100%_+_4px)]"}`}
          role="menu"
        >
          {children(() => setOpen(false))}
        </div>
      )}
    </div>
  );
}
