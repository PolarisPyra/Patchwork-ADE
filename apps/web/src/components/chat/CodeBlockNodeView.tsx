import { useEffect, useRef, useState } from "react";
import { NodeViewContent, NodeViewWrapper, type NodeViewProps } from "@tiptap/react";
import { SYNTAX_CLASSES } from "~/components/canvas/syntaxClasses";
import { CODE_LANGUAGES } from "~/components/chat/codeLanguages";

const PLAIN_TEXT = "Plain text";

/** A code block with its language in a header, and a filterable popup to pick another. */
export default function CodeBlockNodeView({ node, updateAttributes, editor }: NodeViewProps) {
  const language: string = node.attrs.language || "";
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (open) inputRef.current?.focus();
  }, [open]);

  const q = query.toLowerCase();
  const matches = CODE_LANGUAGES.filter((id) => (id || PLAIN_TEXT).toLowerCase().includes(q));

  function close() {
    setOpen(false);
    editor.commands.focus();
  }

  function choose(id: string) {
    updateAttributes({ language: id });
    close();
  }

  return (
    <NodeViewWrapper className="relative">
      <div contentEditable={false} className="flex h-6 items-center">
        <button
          type="button"
          className="cursor-pointer rounded-[var(--radius-sm)] border-none bg-transparent px-1.5 py-0 font-[family-name:var(--font-mono)] text-[12px] text-fg-muted hover:bg-hover hover:text-fg"
          aria-haspopup="listbox"
          aria-expanded={open}
          onClick={() => {
            setQuery("");
            setOpen(!open);
          }}
        >
          {language || PLAIN_TEXT}
        </button>
      </div>
      {open && (
        <div
          contentEditable={false}
          className="absolute top-7 left-0 z-10 flex w-48 flex-col gap-1 rounded-[var(--radius)] border border-border bg-panel p-1 shadow-[var(--shadow-popup)]"
          onKeyDown={(e) => {
            if (e.key === "Escape") close();
          }}
        >
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Filter languages"
            aria-label="Filter languages"
            className="rounded-[var(--radius-sm)] border border-border bg-editor px-2 py-1 text-[length:var(--fs-sm)] text-fg outline-none focus:border-accent"
          />
          <div className="flex max-h-56 flex-col gap-px overflow-y-auto">
            {matches.length === 0 && (
              <div className="px-2 py-1.5 text-[length:var(--fs-sm)] text-fg-muted">
                No matching languages
              </div>
            )}
            {matches.map((id) => (
              <button
                key={id || "plain"}
                type="button"
                className={`flex w-full cursor-pointer items-baseline rounded-[var(--radius)] border-none px-2 py-1.5 text-left font-[family-name:var(--font-mono)] text-[length:var(--fs-sm)] text-fg ${id === language ? "bg-selected" : "bg-transparent hover:bg-hover"}`}
                // Keeps the focus in the editor.
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => choose(id)}
              >
                {id || PLAIN_TEXT}
              </button>
            ))}
          </div>
        </div>
      )}
      <pre>
        <NodeViewContent<"code"> as="code" className={SYNTAX_CLASSES} />
      </pre>
    </NodeViewWrapper>
  );
}
