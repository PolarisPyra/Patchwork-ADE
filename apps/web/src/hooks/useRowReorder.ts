import { useState, type DragEvent } from "react";

/** Drop handlers and the class that marks a sidebar element as a drop target. */
export interface DropTarget {
  attrs: {
    onDragOver: (e: DragEvent<HTMLElement>) => void;
    onDragLeave: (e: DragEvent<HTMLElement>) => void;
    onDrop: (e: DragEvent<HTMLElement>) => void;
    onDragEnd: () => void;
  };
  /** Class that marks this element as a drop target, or "" when it is not one. */
  edge: string;
}

/** Drag and drop handlers for one draggable sidebar row. */
export interface RowDrag extends DropTarget {
  attrs: DropTarget["attrs"] & {
    draggable: true;
    onDragStart: (e: DragEvent<HTMLElement>) => void;
  };
  dragging: boolean;
}

// A bar in the gap between rows, so it reads as a line between items rather than an edge.
const LINE =
  "relative before:pointer-events-none before:absolute before:inset-x-0 before:h-0.5 before:rounded-full before:bg-accent before:content-['']";
const LINE_ABOVE = `${LINE} before:-top-[3px]`;
const LINE_BELOW = `${LINE} before:-bottom-[3px]`;
const OUTLINE = "shadow-[inset_0_0_0_1px_var(--accent)]";

/**
 * Drag-to-reorder for sidebar rows. Rows reorder within their own `group`, which can
 * span folders (all of a project's tasks). `onReorder` gets the destination list's ids
 * in their new order, and the folder that list belongs to (null: the top level).
 */
export function useRowReorder(
  onReorder: (group: string, ids: string[], folderId: string | null) => void,
) {
  const [drag, setDrag] = useState<{ group: string; id: string } | null>(null);
  const [target, setTarget] = useState<{ key: string; after: boolean } | null>(null);

  // Clears the drop line only when the pointer leaves the element, not when it moves onto a child.
  const leave = (e: DragEvent<HTMLElement>) => {
    if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setTarget(null);
  };

  const end = () => {
    setDrag(null);
    setTarget(null);
  };

  /** Handlers for a row. A drop puts the dragged row beside this one, in this row's list. */
  const row = (group: string, id: string, ids: string[], folderId: string | null): RowDrag => {
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
          const next = { key: id, after: isBelowMiddle(e) };
          setTarget((cur) => (cur?.key === next.key && cur.after === next.after ? cur : next));
        },
        onDragLeave: leave,
        onDrop: (e) => {
          if (!drag || !accepts()) return;
          e.preventDefault();
          const rest = ids.filter((other) => other !== drag.id);
          rest.splice(rest.indexOf(id) + (isBelowMiddle(e) ? 1 : 0), 0, drag.id);
          onReorder(group, rest, folderId);
          end();
        },
        onDragEnd: end,
      },
      edge: target?.key === id ? (target.after ? LINE_BELOW : LINE_ABOVE) : "",
      dragging: drag?.id === id,
    };
  };

  /** Handlers for a folder header. A drop appends the dragged row to the folder's list `ids`. */
  const folder = (group: string, key: string, ids: string[], folderId: string): DropTarget => {
    const accepts = () => drag !== null && drag.group === group;

    return {
      attrs: {
        onDragOver: (e) => {
          if (!accepts()) return;
          e.preventDefault();
          e.dataTransfer.dropEffect = "move";
          setTarget((cur) => (cur?.key === key ? cur : { key, after: false }));
        },
        onDragLeave: leave,
        onDrop: (e) => {
          if (!drag || !accepts()) return;
          e.preventDefault();
          onReorder(group, [...ids.filter((other) => other !== drag.id), drag.id], folderId);
          end();
        },
        onDragEnd: end,
      },
      edge: target?.key === key ? OUTLINE : "",
    };
  };

  /**
   * Handlers for the empty space above a list's first row (the list element itself, not
   * its rows). A drop there puts the dragged row first in the list `ids`.
   */
  const start = (
    group: string,
    firstId: string | undefined,
    ids: string[],
    folderId: string | null,
  ): DropTarget => {
    // Only the space above the first row counts; the gaps between rows belong to the list too.
    const aboveFirst = (e: DragEvent<HTMLElement>) => {
      const first = e.currentTarget.firstElementChild;
      return first !== null && e.clientY < first.getBoundingClientRect().top;
    };
    const accepts = (e: DragEvent<HTMLElement>) =>
      drag !== null &&
      drag.group === group &&
      drag.id !== firstId &&
      e.target === e.currentTarget &&
      aboveFirst(e);

    return {
      attrs: {
        onDragOver: (e) => {
          if (!accepts(e) || firstId === undefined) return;
          e.preventDefault();
          e.dataTransfer.dropEffect = "move";
          setTarget((cur) =>
            cur?.key === firstId && !cur.after ? cur : { key: firstId, after: false },
          );
        },
        onDragLeave: leave,
        onDrop: (e) => {
          if (!drag || !accepts(e)) return;
          e.preventDefault();
          onReorder(group, [drag.id, ...ids.filter((other) => other !== drag.id)], folderId);
          end();
        },
        onDragEnd: end,
      },
      edge: "",
    };
  };

  return { row, folder, start };
}
