import { useState, type ReactNode } from "react";
import { Check, Copy } from "lucide-react";

// Small, safe Markdown subset rendered to React elements (no HTML injection).
type Block =
  | { kind: "heading"; level: number; text: string }
  | { kind: "code"; lang: string; code: string }
  | { kind: "list"; ordered: boolean; items: string[] }
  | { kind: "paragraph"; text: string };

const FENCE = /^```\s*([\w+.-]*)/;
const HEADING = /^(#{1,3})\s+(.*)$/;
const BULLET = /^\s*[-*+]\s+(.*)$/;
const NUMBERED = /^\s*\d+[.)]\s+(.*)$/;
const INLINE =
  /`([^`\n]+)`|\*\*([^*\n]+)\*\*|\*([^*\s][^*\n]*)\*|\[([^\]\n]+)\]\(([^)\s]+)\)/g;

function startsBlock(line: string): boolean {
  return FENCE.test(line) || HEADING.test(line) || BULLET.test(line) || NUMBERED.test(line);
}

function parseBlocks(source: string): Block[] {
  const lines = source.replace(/\r\n/g, "\n").split("\n");
  const blocks: Block[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    const fence = FENCE.exec(line);
    const heading = HEADING.exec(line);
    if (fence) {
      const code: string[] = [];
      for (i++; i < lines.length && !lines[i].startsWith("```"); i++) code.push(lines[i]);
      i++; // closing fence, or end of input while still streaming
      blocks.push({ kind: "code", lang: fence[1], code: code.join("\n") });
    } else if (heading) {
      blocks.push({ kind: "heading", level: heading[1].length, text: heading[2] });
      i++;
    } else if (BULLET.test(line) || NUMBERED.test(line)) {
      const ordered = NUMBERED.test(line);
      const item = ordered ? NUMBERED : BULLET;
      const items: string[] = [];
      for (; i < lines.length; i++) {
        const m = item.exec(lines[i]);
        if (!m) break;
        items.push(m[1]);
      }
      blocks.push({ kind: "list", ordered, items });
    } else if (line.trim() === "") {
      i++;
    } else {
      const para: string[] = [];
      for (; i < lines.length && lines[i].trim() !== "" && !startsBlock(lines[i]); i++) {
        para.push(lines[i]);
      }
      blocks.push({ kind: "paragraph", text: para.join("\n") });
    }
  }
  return blocks;
}

function renderInline(text: string): ReactNode[] {
  const out: ReactNode[] = [];
  let last = 0;
  for (const m of text.matchAll(INLINE)) {
    const at = m.index ?? 0;
    if (at > last) out.push(text.slice(last, at));
    if (m[1] !== undefined) out.push(<code key={at} className="ws-inline-code">{m[1]}</code>);
    else if (m[2] !== undefined) out.push(<strong key={at}>{m[2]}</strong>);
    else if (m[3] !== undefined) out.push(<em key={at}>{m[3]}</em>);
    else out.push(<span key={at} className="ws-link" title={m[5]}>{m[4]}</span>);
    last = at + m[0].length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

function renderBlock(block: Block, key: number): ReactNode {
  switch (block.kind) {
    case "heading": {
      const Tag = block.level === 1 ? "h3" : block.level === 2 ? "h4" : "h5";
      return <Tag key={key} className="ws-md-heading">{renderInline(block.text)}</Tag>;
    }
    case "code":
      return <CodeBlock key={key} lang={block.lang} code={block.code} />;
    case "list": {
      const Tag = block.ordered ? "ol" : "ul";
      return (
        <Tag key={key} className="ws-md-list">
          {block.items.map((item, j) => (
            <li key={j}>{renderInline(item)}</li>
          ))}
        </Tag>
      );
    }
    case "paragraph":
      return <p key={key}>{renderInline(block.text)}</p>;
  }
}

export default function Markdown({ text }: { text: string }) {
  return (
    <div className="ws-markdown selectable">
      {parseBlocks(text).map((block, i) => renderBlock(block, i))}
    </div>
  );
}

export function CopyButton({ text, className = "ws-action" }: { text: string; className?: string }) {
  const [copied, setCopied] = useState(false);
  const copy = () => {
    navigator.clipboard.writeText(text).then(
      () => {
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
      },
      () => undefined,
    );
  };
  return (
    <button className={className} onClick={copy} title="Copy">
      {copied ? <Check size={13} /> : <Copy size={13} />}
      {copied ? "Copied" : "Copy"}
    </button>
  );
}

function CodeBlock({ lang, code }: { lang: string; code: string }) {
  return (
    <div className="ws-code">
      <div className="ws-code-head">
        <span>{lang || "text"}</span>
        <CopyButton text={code} />
      </div>
      <pre>
        <code>{code}</code>
      </pre>
    </div>
  );
}
