import { describe, it, expect, afterEach, vi } from "vitest";
import { render, screen, cleanup, fireEvent, waitFor } from "@testing-library/react";
import { TranscriptViewer } from "./TranscriptViewer.js";
import * as routes from "../../api/routes.js";
import type { TranscriptView } from "../../api/routes.js";

afterEach(() => { cleanup(); vi.restoreAllMocks(); });

const view: TranscriptView = {
  sessionId: "s1", agent: "claude",
  meta: {
    agent: "claude", sessionId: "s1", project: "agentgem", model: "claude-opus-4-8",
    gitBranch: "main", startMs: 1000, endMs: 61000, msgs: 2,
    tokensIn: 100, tokensOut: 40, tokensCache: 15,
  },
  turns: [
    { id: "u1", role: "user", tsMs: 1000, tokens: { in: 0, out: 0, cache: 0 },
      spans: [{ kind: "message", role: "user", text: "do the thing" }] },
    { id: "a1", role: "assistant", tsMs: 6000, tokens: { in: 100, out: 40, cache: 15 },
      spans: [
        { kind: "message", role: "assistant", text: "on it" },
        { kind: "tool_call", name: "Read", input: "{ file_path: ~/x }", output: "contents here" },
      ] },
  ],
};

describe("TranscriptViewer", () => {
  it("renders turns and reveals tool I/O on expand", async () => {
    vi.spyOn(routes.inspectSessionRoute, "call").mockResolvedValue(view);
    render(<TranscriptViewer apiBase="" agent="claude" sessionId="s1" onBack={() => {}} />);

    await waitFor(() => expect(screen.getAllByText("do the thing").length).toBeGreaterThan(0));
    // tool name visible, but its output is collapsed until clicked
    expect(screen.getByText("Read")).toBeTruthy();
    expect(screen.queryByText("contents here")).toBeNull();
    fireEvent.click(screen.getByText("Read"));
    expect(screen.getByText("contents here")).toBeTruthy();
  });

  it("calls onBack when the back affordance is clicked", async () => {
    vi.spyOn(routes.inspectSessionRoute, "call").mockResolvedValue(view);
    const onBack = vi.fn();
    render(<TranscriptViewer apiBase="" agent="claude" sessionId="s1" onBack={onBack} />);
    await waitFor(() => expect(screen.getAllByText("do the thing").length).toBeGreaterThan(0));
    fireEvent.click(screen.getByText("← Inspect"));
    expect(onBack).toHaveBeenCalled();
  });

  it("surfaces a load error instead of crashing", async () => {
    vi.spyOn(routes.inspectSessionRoute, "call").mockRejectedValue(new Error("nope"));
    render(<TranscriptViewer apiBase="" agent="claude" sessionId="s1" onBack={() => {}} />);
    await waitFor(() => expect(screen.getByText(/Couldn't load session/)).toBeTruthy());
  });
});
