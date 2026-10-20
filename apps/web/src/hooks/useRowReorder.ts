import { useState, type DragEvent } from "react";

/** Drag handlers and drop-line class for one sidebar row. */
export interface RowDrag {
  attrs: {
    draggable: true;
    onDragStart: (e: DragEvent<HTMLElement>) => void;
    onDragOver: (e: DragEvent<HTMLElement>) => void;
    onDragLeave: () => void;
    onDrop: (e: DragEvent<HTMLElement>) => void;
    onDragEnd: () => void;
  };
  /** Class that draws the drop line above or below this row, or "" when it is not the target. */
  edge: string;
  dragging: boolean;
}

/**
 * Drag-to-reorder for sidebar rows. Rows only reorder within their own `group`
 * (chats, projects, or one project's tasks). `onReorder` gets the group's ids in their new order.
 */
export function useRowReorder(onReorder: (group: string, ids: string[]) => void) {
  const [drag, setDrag] = useState<{ group: string; id: string } | null>(null);
  const [target, setTarget] = useState<{ id: string; after: boolean } | null>(null);

  const end = () => {
    setDrag(null);
    setTarget(null);
  };

  return (group: string, id: string, ids: string[]): RowDrag => {
    const isBelowMiddle = (e: DragEvent<HTMLElement>) => {
      const box = e.currentTarget.getBoundingClientRect();
      return e.clientY > box.top + box.height / 2;
    };
    const accepts = () => drag !== null && drag.group === group && drag.id !== id;

    return {
      attrs: {
        draggable: true,
        onDragStart: (e) => {
          e.dataTransfer.effectAllowed = "move";
          // Firefox and WebKit will not start a drag without some data set.
          e.dataTransfer.setData("text/plain", id);
          setDrag({ group, id });
        },
        onDragOver: (e) => {
          if (!accepts()) return;
          e.preventDefault();
          e.dataTransfer.dropEffect = "move";
          const next = { id, after: isBelowMiddle(e) };
          setTarget((cur) => (cur?.id === next.id && cur.after === next.after ? cur : next));
        },
        onDragLeave: () => setTarget(null),
        onDrop: (e) => {
          if (!drag || !accepts()) return;
          e.preventDefault();
          const rest = ids.filter((other) => other !== drag.id);
          rest.splice(rest.indexOf(id) + (isBelowMiddle(e) ? 1 : 0), 0, drag.id);
          onReorder(group, rest);
          end();
        },
        onDragEnd: end,
      },
      edge:
        target?.id === id
          ? target.after
            ? "shadow-[inset_0_-2px_0_0_var(--accent)]"
            : "shadow-[inset_0_2px_0_0_var(--accent)]"
          : "",
      dragging: drag?.id === id,
    };
  };
}
