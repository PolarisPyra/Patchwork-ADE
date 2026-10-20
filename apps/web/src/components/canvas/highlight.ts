// Syntax highlighting and file-type helpers for the Canvas panel.
import hljs from "highlight.js/lib/core";
import bash from "highlight.js/lib/languages/bash";
import css from "highlight.js/lib/languages/css";
import go from "highlight.js/lib/languages/go";
import ini from "highlight.js/lib/languages/ini";
import javascript from "highlight.js/lib/languages/javascript";
import json from "highlight.js/lib/languages/json";
import markdown from "highlight.js/lib/languages/markdown";
import python from "highlight.js/lib/languages/python";
import rust from "highlight.js/lib/languages/rust";
import typescript from "highlight.js/lib/languages/typescript";
import xml from "highlight.js/lib/languages/xml";
import yaml from "highlight.js/lib/languages/yaml";

hljs.registerLanguage("bash", bash);
hljs.registerLanguage("css", css);
hljs.registerLanguage("go", go);
hljs.registerLanguage("ini", ini);
hljs.registerLanguage("javascript", javascript);
hljs.registerLanguage("json", json);
hljs.registerLanguage("markdown", markdown);
hljs.registerLanguage("python", python);
hljs.registerLanguage("rust", rust);
hljs.registerLanguage("typescript", typescript);
hljs.registerLanguage("xml", xml);
hljs.registerLanguage("yaml", yaml);

/** Files longer than this are shown without highlighting. */
export const MAX_HIGHLIGHT_LINES = 5000;

export interface FileKind {
  label: string;
  /** Registered highlight.js grammar, if any. */
  grammar?: string;
}

const KINDS: Record<string, FileKind | undefined> = {
  css: { label: "CSS", grammar: "css" },
  ts: { label: "TypeScript", grammar: "typescript" },
  tsx: { label: "TypeScript", grammar: "typescript" },
  js: { label: "JavaScript", grammar: "javascript" },
  jsx: { label: "JavaScript", grammar: "javascript" },
  rs: { label: "Rust", grammar: "rust" },
  py: { label: "Python", grammar: "python" },
  json: { label: "JSON", grammar: "json" },
  md: { label: "Markdown", grammar: "markdown" },
  html: { label: "HTML", grammar: "xml" },
  toml: { label: "TOML", grammar: "ini" },
  yml: { label: "YAML", grammar: "yaml" },
  yaml: { label: "YAML", grammar: "yaml" },
  sh: { label: "Shell", grammar: "bash" },
  go: { label: "Go", grammar: "go" },
};

export function describeFile(path: string): FileKind {
  const name = path.split("/").pop() ?? path;
  const dot = name.lastIndexOf(".");
  const ext = dot > 0 ? name.slice(dot + 1).toLowerCase() : "";
  return KINDS[ext] ?? { label: ext ? ext.toUpperCase() : "Text" };
}

/** Lines of a file; a single trailing newline does not start a new line. */
export function splitLines(content: string): string[] {
  if (content === "") return [];
  const text = content.endsWith("\n") ? content.slice(0, -1) : content;
  return text.split("\n");
}

const TOKEN_RE = /<[^>]+>|[^<]+/g;

/**
 * Highlights the lines with highlight.js and returns one HTML string per line.
 * hljs escapes the source text, so the output is safe to inject. Spans that
 * cross a line break are closed at the break and re-opened on the next line.
 */
export function highlightLines(lines: string[], grammar: string): string[] {
  const html = hljs.highlight(lines.join("\n"), { language: grammar, ignoreIllegals: true }).value;
  const out: string[] = [];
  const open: string[] = [];
  let current = "";
  for (const token of html.match(TOKEN_RE) ?? []) {
    if (token.startsWith("</")) {
      open.pop();
      current += token;
    } else if (token.startsWith("<")) {
      open.push(token);
      current += token;
    } else {
      token.split("\n").forEach((part, i) => {
        if (i > 0) {
          out.push(current + "</span>".repeat(open.length));
          current = open.join("");
        }
        current += part;
      });
    }
  }
  out.push(current + "</span>".repeat(open.length));
  return out;
}

/** Highlighted HTML for a whole code block, or null when the language is not registered. */
export function highlightBlock(code: string, lang: string): string | null {
  if (!hljs.getLanguage(lang)) return null;
  return hljs.highlight(code, { language: lang, ignoreIllegals: true }).value;
}
