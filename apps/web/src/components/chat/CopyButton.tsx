import { useState } from "react";
import { CheckIcon, CopyIcon } from "@phosphor-icons/react";

export const ACTION_CLASS =
  "inline-flex h-6 cursor-pointer items-center gap-1 rounded-[var(--radius-sm)] border-none bg-transparent px-1.5 text-[length:var(--fs-xs)] text-fg-muted enabled:hover:bg-hover enabled:hover:text-fg disabled:cursor-default disabled:opacity-50";

export function CopyButton({
  text,
  className = ACTION_CLASS,
}: {
  text: string;
  className?: string;
}) {
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
      {copied ? <CheckIcon size={13} /> : <CopyIcon size={13} />}
      {copied ? "Copied" : "Copy"}
    </button>
  );
}
