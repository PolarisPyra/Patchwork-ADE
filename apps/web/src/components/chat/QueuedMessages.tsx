import { PencilSimpleIcon, XIcon } from "@phosphor-icons/react";
import type { Message } from "~/api";

const ICON_BUTTON =
  "grid h-6 w-6 flex-none cursor-pointer place-items-center rounded-[var(--radius)] border-none bg-transparent text-fg-subtle hover:bg-hover hover:text-fg disabled:cursor-default disabled:opacity-40 disabled:hover:bg-transparent disabled:hover:text-fg-subtle";

/**
 * Messages sent while the agent was busy, waiting for its turn to end. The agent has not seen
 * them yet, so each can be taken back to edit or dropped.
 */
export default function QueuedMessages({
  messages,
  canEdit,
  onEdit,
  onRemove,
}: {
  messages: Message[];
  /** Editing puts the text back in the composer, so it needs the composer to be empty. */
  canEdit: boolean;
  onEdit: (message: Message) => void;
  onRemove: (message: Message) => void;
}) {
  if (messages.length === 0) return null;
  return (
    <div className="mb-1.5 flex flex-col gap-0.5 px-2 text-[length:var(--fs-sm)]">
      {messages.map((message) => (
        <div key={message.id} className="flex min-w-0 items-center gap-2">
          <span className="flex-none font-semibold text-fg-subtle">Queued</span>
          <span className="min-w-0 flex-1 truncate text-fg-muted">
            {message.text || "Attachments only"}
          </span>
          <button
            className={ICON_BUTTON}
            onClick={() => onEdit(message)}
            disabled={!canEdit}
            title={canEdit ? "Edit queued message" : "Clear the composer to edit"}
            aria-label="Edit queued message"
          >
            <PencilSimpleIcon size={12} />
          </button>
          <button
            className={ICON_BUTTON}
            onClick={() => onRemove(message)}
            title="Remove queued message"
            aria-label="Remove queued message"
          >
            <XIcon size={12} />
          </button>
        </div>
      ))}
    </div>
  );
}
