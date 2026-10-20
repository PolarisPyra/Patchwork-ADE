import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import Sidebar from "~/components/sidebar/Sidebar";
import { change } from "~/test/fixtures";
import { api } from "~/api";

vi.mock("~/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("~/api")>();
  return {
    ...actual,
    api: { acceptFile: vi.fn(async () => {}), revertFile: vi.fn(async () => {}) },
  };
});
vi.mock("@tauri-apps/plugin-dialog", () => ({ confirm: vi.fn(async () => true) }));
vi.mock("~/components/usage/UsagePopover", () => ({ default: () => null }));

const project = { id: "p1", name: "Patchwork", path: "/abs/p" };
const changes = [change("src/a.ts"), change("lib/b.ts")];

function renderChanges(changeFocus: string[] | null = null) {
  return render(
    <Sidebar
      view="changes"
      agents={[]}
      project={project}
      projects={[project]}
      threads={[]}
      selectedId={null}
      changes={changes}
      onNewTask={() => {}}
      onNewChat={() => {}}
      onSelectThread={() => {}}
      onDeleteThread={() => {}}
      onRenameThread={() => {}}
      onRenameProject={() => {}}
      onRemoveProject={() => {}}
      onOpenFolder={() => {}}
      onRefreshChanges={() => {}}
      onOpenChange={() => {}}
      changeFocus={changeFocus}
      onOpenPalette={() => {}}
    />,
  );
}

describe("Changes view", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(cleanup);

  it("pins the files of the reply it was opened from", () => {
    renderChanges(["lib/b.ts"]);
    expect(screen.getByText("From this reply")).toBeTruthy();
    expect(screen.getByText("b.ts")).toBeTruthy();
    expect(screen.getByText("a.ts")).toBeTruthy();
  });

  it("applies every changed file on Apply all", async () => {
    renderChanges();
    fireEvent.click(screen.getByText("Apply all"));
    await waitFor(() => expect(api.acceptFile).toHaveBeenCalledTimes(2));
    expect(api.acceptFile).toHaveBeenCalledWith("p1", "src/a.ts");
    expect(api.acceptFile).toHaveBeenCalledWith("p1", "lib/b.ts");
  });

  it("reverts the pinned reply's files only on Reject, after confirming", async () => {
    renderChanges(["lib/b.ts"]);
    fireEvent.click(screen.getByText("Reject"));
    await waitFor(() => expect(api.revertFile).toHaveBeenCalledTimes(1));
    expect(api.revertFile).toHaveBeenCalledWith("p1", "lib/b.ts");
  });
});
