import { useMemo } from "react";
import { SYNTAX_CLASSES } from "~/components/canvas/syntaxClasses";
import {
  describeFile,
  highlightLines,
  MAX_HIGHLIGHT_LINES,
  splitLines,
} from "~/components/canvas/highlight";

interface CodeViewProps {
  path: string;
  content: string;
}

export default function CodeView({ path, content }: CodeViewProps) {
  const lines = useMemo(() => splitLines(content), [content]);
  const highlighted = useMemo(() => {
    const grammar = describeFile(path).grammar;
    if (!grammar || lines.length > MAX_HIGHLIGHT_LINES) return null;
    return highlightLines(lines, grammar);
  }, [path, lines]);

  if (lines.length === 0) {
    return (
      <div className="flex items-center justify-center h-full min-h-[120px] p-6 text-center text-fg-muted">
        This file is empty.
      </div>
    );
  }

  return (
    <div
      className={`w-max min-w-full py-3 font-[family-name:var(--font-mono)] text-[length:var(--fs-md)] leading-[1.65] text-fg tab-2 select-text ${SYNTAX_CLASSES}`}
    >
      {lines.map((line, i) => (
        <div
          className="flex hover:bg-[color:color-mix(in_srgb,var(--bg-hover)_40%,transparent)]"
          key={i}
        >
          <span className="flex-none min-w-[48px] pr-4 text-right text-fg-subtle select-none tabular-nums">
            {i + 1}
          </span>
          {highlighted ? (
            // hljs output escapes the source text, so this HTML is safe.
            <span
              className="flex-[1_0_auto] whitespace-pre"
              dangerouslySetInnerHTML={{ __html: highlighted[i] }}
            />
          ) : (
            <span className="flex-[1_0_auto] whitespace-pre">{line}</span>
          )}
        </div>
      ))}
    </div>
  );
}
