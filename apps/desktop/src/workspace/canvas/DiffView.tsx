import { useMemo } from "react";

interface DiffRow {
  kind: "hunk" | "add" | "del" | "ctx";
  text: string;
  oldNo?: number;
  newNo?: number;
}

const HUNK_RE = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/;

/** Parses a single-file unified diff. Header lines before the first hunk are dropped. */
function parseDiff(diff: string): DiffRow[] {
  const rows: DiffRow[] = [];
  let oldNo = 0;
  let newNo = 0;
  let inHunk = false;
  for (const line of diff.split("\n")) {
    const hunk = HUNK_RE.exec(line);
    if (hunk) {
      oldNo = Number(hunk[1]);
      newNo = Number(hunk[2]);
      inHunk = true;
      rows.push({ kind: "hunk", text: line });
    } else if (!inHunk) {
      continue;
    } else if (line.startsWith("+")) {
      rows.push({ kind: "add", text: line.slice(1), newNo });
      newNo += 1;
    } else if (line.startsWith("-")) {
      rows.push({ kind: "del", text: line.slice(1), oldNo });
      oldNo += 1;
    } else if (line.startsWith(" ")) {
      rows.push({ kind: "ctx", text: line.slice(1), oldNo, newNo });
      oldNo += 1;
      newNo += 1;
    }
    // "\ No newline at end of file" and trailing blank lines fall through.
  }
  return rows;
}

const MARKERS: Record<Exclude<DiffRow["kind"], "hunk">, string> = {
  add: "+",
  del: "−",
  ctx: " ",
};

export default function DiffView({ diff }: { diff: string }) {
  const rows = useMemo(() => parseDiff(diff), [diff]);

  if (rows.length === 0) {
    return <div className="cv-center cv-muted">No changes in this file.</div>;
  }

  return (
    <div className="cv-diff">
      {rows.map((row, i) =>
        row.kind === "hunk" ? (
          <div className="cv-diff-hunk" key={i}>
            {row.text}
          </div>
        ) : (
          <div className={`cv-diff-row cv-diff-${row.kind}`} key={i}>
            <span className="cv-gutter">{row.oldNo ?? ""}</span>
            <span className="cv-gutter">{row.newNo ?? ""}</span>
            <span className="cv-marker">{MARKERS[row.kind]}</span>
            <span className="cv-text">{row.text}</span>
          </div>
        ),
      )}
    </div>
  );
}
