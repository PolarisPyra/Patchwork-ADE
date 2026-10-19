import { useMemo } from "react";
import { describeFile, highlightLines, MAX_HIGHLIGHT_LINES, splitLines } from "~/components/canvas/highlight";

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
    return <div className="cv-center cv-muted">This file is empty.</div>;
  }

  return (
    <div className="cv-code">
      {lines.map((line, i) => (
        <div className="cv-line" key={i}>
          <span className="cv-gutter">{i + 1}</span>
          {highlighted ? (
            // hljs output escapes the source text, so this HTML is safe.
            <span className="cv-text" dangerouslySetInnerHTML={{ __html: highlighted[i] }} />
          ) : (
            <span className="cv-text">{line}</span>
          )}
        </div>
      ))}
    </div>
  );
}
