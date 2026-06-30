import { describe, it, expect, afterEach, vi } from "vitest";
import { render, screen, cleanup, fireEvent, waitFor } from "@testing-library/react";
import { TranscriptDiff } from "./TranscriptDiff.js";
import * as routes from "../../api/routes.js";
import type { TranscriptView } from "../../api/routes.js";

afterEach(() => { cleanup(); vi.restoreAllMocks(); });

const mkView = (id: string, project: string, lastText: string): TranscriptView => ({
  sessionId: id, agent: "claude",
  meta: {
    agent: "claude", sessionId: id, project, model: "claude-opus-4-8", gitBranch: "main",
    startMs: 0, endMs: 1000, msgs: 2, tokensIn: 0, tokensOut: 0, tokensCache: 0,
  },
  turns: [
    { id: id + "-1", role: "user", tsMs: 0, tokens: { in: 0, out: 0, cache: 0 },
      spans: [{ kind: "message", role: "user", text: "shared start" }] },
    // Same message head + same tool name => same signature; differ only in tool
    // input so the row aligns as "changed", not removed+added.
    { id: id + "-2", role: "assistant", tsMs: 100, tokens: { in: 0, out: 0, cache: 0 },
      spans: [
        { kind: "message", role: "assistant", text: "wrap up" },
        { kind: "tool_call", name: "Bash", input: lastText },
      ] },
  ],
});

describe("TranscriptDiff", () => {
  it("loads both sessions and renders aligned rows with a legend", async () => {
    const a = mkView("aaa", "proj-a", "ending one");
    const b = mkView("bbb", "proj-b", "ending two");
    vi.spyOn(routes.inspectSessionRoute, "call")
      .mockResolvedValueOnce(a)   // A
      .mockResolvedValueOnce(b);  // B
    render(<TranscriptDiff apiBase="" a={{ agent: "claude", sessionId: "aaa" }} b={{ agent: "claude", sessionId: "bbb" }} onBack={() => {}} />);

    await waitFor(() => expect(screen.getByText(/1 changed/)).toBeTruthy()); // shared start = same, endings = changed
    expect(screen.getByText(/1 same/)).toBeTruthy();
    expect(screen.getByText("proj-a")).toBeTruthy();
    expect(screen.getByText("proj-b")).toBeTruthy();
  });

  it("calls onBack from the back affordance", async () => {
    const v = mkView("aaa", "proj-a", "x");
    vi.spyOn(routes.inspectSessionRoute, "call").mockResolvedValue(v);
    const onBack = vi.fn();
    render(<TranscriptDiff apiBase="" a={{ agent: "claude", sessionId: "aaa" }} b={{ agent: "claude", sessionId: "bbb" }} onBack={onBack} />);
    await waitFor(() => expect(screen.getByText("Compare runs")).toBeTruthy());
    fireEvent.click(screen.getByText("← Inspect"));
    expect(onBack).toHaveBeenCalled();
  });

  it("surfaces a load error", async () => {
    vi.spyOn(routes.inspectSessionRoute, "call").mockRejectedValue(new Error("boom"));
    render(<TranscriptDiff apiBase="" a={{ agent: "claude", sessionId: "aaa" }} b={{ agent: "claude", sessionId: "bbb" }} onBack={() => {}} />);
    await waitFor(() => expect(screen.getByText(/Couldn't load comparison/)).toBeTruthy());
  });
});
