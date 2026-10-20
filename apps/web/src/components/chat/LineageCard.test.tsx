import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import LineageCard from "~/components/chat/LineageCard";
import { assistant, thread, tool } from "~/test/fixtures";

const explore = tool({
  id: "agent-1",
  name: "Agent",
  status: "running",
  subagent: { kind: "Explore", description: "map auth", model: "haiku" },
});

describe("LineageCard", () => {
  it("renders nothing when no subagent was started", () => {
    const { container } = render(
      <LineageCard thread={thread([assistant({ tools: [tool({ id: "b1" })] })])} working={false} />,
    );
    expect(container.firstChild).toBeNull();
  });

  it("shows the parent and each subagent's type, model and description", () => {
    const t = thread([assistant({ tools: [explore] })]);
    render(<LineageCard thread={t} working={true} />);
    expect(screen.getByText("1 subagents")).toBeTruthy();
    expect(screen.getByText("opus")).toBeTruthy();
    expect(screen.getByText("Explore")).toBeTruthy();
    expect(screen.getByText("haiku")).toBeTruthy();
    expect(screen.getByText("map auth")).toBeTruthy();
  });

  it("lists a subagent's own actions and summarises the rest", () => {
    const inner = Array.from({ length: 6 }, (_, i) =>
      tool({ id: `r${i}`, name: "Read", summary: `file${i}.ts`, parent: "agent-1" }),
    );
    render(
      <LineageCard thread={thread([assistant({ tools: [explore, ...inner] })])} working={false} />,
    );
    expect(screen.getByText("file0.ts")).toBeTruthy();
    expect(screen.getByText("file3.ts")).toBeTruthy();
    expect(screen.queryByText("file4.ts")).toBeNull();
    expect(screen.getByText("+2 more")).toBeTruthy();
  });
});
