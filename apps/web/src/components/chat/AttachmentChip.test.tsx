import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import AttachmentChip from "~/components/chat/AttachmentChip";
import { api, type Attachment } from "~/api";

vi.mock("~/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("~/api")>();
  return { ...actual, api: { allowPreview: vi.fn(async () => {}) } };
});
vi.mock("@tauri-apps/api/core", () => ({
  convertFileSrc: (path: string) => `asset://localhost/${path}`,
}));

afterEach(() => {
  vi.clearAllMocks();
});

const notes: Attachment = { kind: "file", path: "/abs/notes.md", name: "notes.md" };
const shot: Attachment = { kind: "image", path: "/abs/shot.png", name: "shot.png" };

describe("AttachmentChip", () => {
  it("shows the name and kind, and removes on the × button", () => {
    const onRemove = vi.fn();
    render(<AttachmentChip attachment={notes} onRemove={onRemove} />);
    expect(screen.getByText("notes.md")).toBeTruthy();
    expect(screen.getByText("file")).toBeTruthy();
    fireEvent.click(screen.getByLabelText("Remove notes.md"));
    expect(onRemove).toHaveBeenCalledTimes(1);
  });

  it("shows a thumbnail for an image once the backend allows the file", async () => {
    const { container } = render(<AttachmentChip attachment={shot} />);
    expect(api.allowPreview).toHaveBeenCalledWith("/abs/shot.png");
    await waitFor(() => expect(container.querySelector("img")).not.toBeNull());
    expect(container.querySelector("img")?.getAttribute("src")).toBe(
      "asset://localhost//abs/shot.png",
    );
  });

  it("does not ask for a preview of a non-image", () => {
    render(<AttachmentChip attachment={notes} />);
    expect(api.allowPreview).not.toHaveBeenCalled();
  });
});
