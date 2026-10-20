import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import Messages from "~/components/chat/Messages";
import { assistant, change, thread, tool } from "~/test/fixtures";

afterEach(() => {
  vi.clearAllMocks();
});

const noop = () => {};

describe("Messages", () => {
  it("lists only top-level actions and leaves a subagent's own actions out", () => {
    const t = thread([
      assistant({
        tools: [
          tool({ id: "b1", name: "Bash", summary: "npm test" }),
          tool({ id: "r1", name: "Read", summary: "inner-read.ts", parent: "agent-x" }),
        ],
      }),
    ]);
    render(
      <Messages
        thread={t}
        changes={[]}
        busy={false}
        onShowChanges={noop}
        onRetry={noop}
        onRespond={noop}
      />,
    );
    fireEvent.click(screen.getByText("1 action"));
    expect(screen.getByText("npm test")).toBeTruthy();
    expect(screen.queryByText("inner-read.ts")).toBeNull();
  });

  it("opens the Changes view with the reply's files", () => {
    const onShowChanges = vi.fn();
    const t = thread([assistant({ files: ["src/a.ts"] })]);
    render(
      <Messages
        thread={t}
        changes={[change("src/a.ts", { additions: 3, deletions: 1 })]}
        busy={false}
        onOpenCanvas={noop}
        onShowChanges={onShowChanges}
        onRetry={noop}
        onRespond={noop}
      />,
    );
    expect(screen.getByText("1 file changed")).toBeTruthy();
    fireEvent.click(screen.getByText("Show changes"));
    expect(onShowChanges).toHaveBeenCalledWith(["src/a.ts"]);
  });
});
