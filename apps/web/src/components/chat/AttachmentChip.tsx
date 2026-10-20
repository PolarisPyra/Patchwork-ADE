import { FileIcon, FolderIcon, ImageIcon, XIcon } from "@phosphor-icons/react";
import type { Attachment, AttachmentKind } from "~/api";

const ICONS: Record<AttachmentKind, typeof FileIcon> = {
  image: ImageIcon,
  file: FileIcon,
  folder: FolderIcon,
};

interface AttachmentChipProps {
  attachment: Attachment;
  /** Shows a remove button; omitted for attachments already sent. */
  onRemove?: () => void;
}

/** A dropped file, folder, or image, shown as a badge with its full path on hover. */
export default function AttachmentChip({ attachment, onRemove }: AttachmentChipProps) {
  const Icon = ICONS[attachment.kind];
  return (
    <span
      className="inline-flex max-w-[280px] items-center gap-1.5 rounded-[var(--radius)] border border-border-strong bg-panel py-0.5 pr-1 pl-2 text-[length:var(--fs-sm)] text-fg"
      title={attachment.path}
    >
      <Icon size={13} className="flex-none text-fg-muted" />
      <span className="truncate">{attachment.name}</span>
      <span className="flex-none text-[length:var(--fs-xs)] text-fg-subtle uppercase">
        {attachment.kind}
      </span>
      {onRemove && (
        <button
          className="grid h-4 w-4 flex-none cursor-pointer place-items-center rounded-full border-none bg-transparent p-0 text-fg-muted hover:bg-hover hover:text-fg"
          onClick={onRemove}
          title="Remove"
          aria-label={`Remove ${attachment.name}`}
        >
          <XIcon size={10} />
        </button>
      )}
    </span>
  );
}
