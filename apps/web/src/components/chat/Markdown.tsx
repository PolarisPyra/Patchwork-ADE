import { Children, useEffect, useState, type ReactElement, type ReactNode } from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import { SYNTAX_CLASSES } from "~/components/canvas/syntaxClasses";
import { CopyButton } from "~/components/chat/CopyButton";
import { CHOICES_LANG } from "~/components/chat/choices";

/** Links are shown as text unless they use one of these protocols. Nothing is opened from a reply. */
const SAFE_LINK = /^(https?:|mailto:)/i;

const components: Components = {
  h1: ({ children }) => (
    <h3 className="mt-3 mb-1.5 text-[length:var(--fs-lg)] font-semibold">{children}</h3>
  ),
  h2: ({ children }) => (
    <h4 className="mt-3 mb-1.5 text-[length:var(--fs-md)] font-semibold">{children}</h4>
  ),
  h3: ({ children }) => (
    <h5 className="mt-3 mb-1.5 text-[length:var(--fs-md)] font-semibold">{children}</h5>
  ),
  h4: ({ children }) => (
    <h5 className="mt-3 mb-1.5 text-[length:var(--fs-md)] font-semibold">{children}</h5>
  ),
  h5: ({ children }) => (
    <h5 className="mt-3 mb-1.5 text-[length:var(--fs-md)] font-semibold">{children}</h5>
  ),
  h6: ({ children }) => (
    <h5 className="mt-3 mb-1.5 text-[length:var(--fs-md)] font-semibold">{children}</h5>
  ),
  ul: ({ children }) => <ul className="mt-0 mb-2 pl-[22px]">{children}</ul>,
  ol: ({ children }) => <ol className="mt-0 mb-2 pl-[22px]">{children}</ol>,
  blockquote: ({ children }) => (
    <blockquote className="my-2 border-l-2 border-border pl-3 text-fg-muted">{children}</blockquote>
  ),
  hr: () => <hr className="my-3 border-border" />,
  table: ({ children }) => (
    <div className="my-2 overflow-x-auto">
      <table className="border-collapse text-[length:var(--fs-sm)]">{children}</table>
    </div>
  ),
  th: ({ children }) => (
    <th className="border border-border px-2 py-1 text-left font-semibold">{children}</th>
  ),
  td: ({ children }) => <td className="border border-border px-2 py-1">{children}</td>,
  // Inline code only: fenced blocks are handled by `pre` below.
  code: ({ children }) => (
    <code className="rounded-[4px] bg-selected-muted px-[5px] py-px font-[family-name:var(--font-mono)] text-[12px]">
      {children}
    </code>
  ),
  pre: ({ children }) => {
    // remark always gives a fenced block one <code> child, with its language as a class.
    const child = Children.only(children) as ReactElement<{
      className?: string;
      children?: ReactNode;
    }>;
    const lang = /language-([\w+.-]+)/.exec(child.props.className ?? "")?.[1] ?? "";
    // A choices block is shown as a panel above the composer, not as code.
    if (lang === CHOICES_LANG) return null;
    const code = String(child.props.children ?? "").replace(/\n$/, "");
    return <CodeBlock lang={lang} code={code} />;
  },
  a: ({ href, children }) =>
    href && SAFE_LINK.test(href) ? (
      <span className="cursor-text text-accent-text" title={href}>
        {children}
      </span>
    ) : (
      <span>{children}</span>
    ),
  // Remote images are not loaded from a reply; the alt text stands in for them.
  img: ({ alt }) => <span className="text-fg-muted">{alt || "Image"}</span>,
};

export default function Markdown({ text }: { text: string }) {
  return (
    <div className="min-w-0 leading-[1.6] [word-break:break-word] selectable [&>:last-child]:mb-0 [&_p]:mt-0 [&_p]:mb-2">
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={components} skipHtml>
        {text}
      </ReactMarkdown>
    </div>
  );
}

function CodeBlock({ lang, code }: { lang: string; code: string }) {
  // Highlighting loads on demand, so the chat does not pull every grammar up front.
  const [html, setHtml] = useState<string | null>(null);
  useEffect(() => {
    let current = true;
    void import("~/components/canvas/highlight").then(({ highlightBlock }) => {
      if (current) setHtml(highlightBlock(code, lang));
    });
    return () => {
      current = false;
    };
  }, [code, lang]);
  return (
    <div className="my-2 overflow-hidden rounded-[var(--radius)] border border-border bg-panel">
      <div className="flex items-center justify-between border-b border-border py-0.5 pr-1 pl-2.5 text-[length:var(--fs-xs)] text-fg-subtle">
        <span>{lang || "text"}</span>
        <CopyButton text={code} />
      </div>
      <pre className="m-0 overflow-x-auto px-3 py-2.5 text-[12px] leading-[1.5]">
        {html === null ? (
          <code>{code}</code>
        ) : (
          // hljs output escapes the source text, so this HTML is safe.
          <code className={SYNTAX_CLASSES} dangerouslySetInnerHTML={{ __html: html }} />
        )}
      </pre>
    </div>
  );
}
