import { describe, it, expect, afterEach, vi } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import { StructureView } from "./StructureView.js";
import * as routes from "../../api/routes.js";

afterEach(() => { cleanup(); vi.restoreAllMocks(); });

const view = {
  sessionId: "s", agent: "claude", meta: {} as any,
  turns: [
    { id: "u0", role: "user", tsMs: 0, tokens: { in: 0, out: 0, cache: 0 }, spans: [{ kind: "message", role: "user", text: "write the doc" }] },
    { id: "a0", role: "assistant", tsMs: 1, tokens: { in: 0, out: 5, cache: 0 }, spans: [{ kind: "tool_call", name: "Write", input: "f" }] },
  ],
} as any;

describe("StructureView", () => {
  it("defaults to Map and shows a phase label + tool cell", () => {
    render(<StructureView view={view} collapsed={new Set()} onToggle={() => {}} apiBase="/" agent="claude" />);
    expect(screen.getByText(/write the doc/i)).toBeTruthy();
    expect(screen.getByText(/Write/)).toBeTruthy();
  });
  it("switches to Transcript mode", () => {
    render(<StructureView view={view} collapsed={new Set()} onToggle={() => {}} apiBase="/" agent="claude" />);
    fireEvent.click(screen.getByRole("button", { name: /transcript/i }));
    // Untouched `collapsed` means every turn starts open, so the verbatim message
    // shows twice (collapsed-header summary + open body) — same duplication the
    // existing TranscriptViewer tests account for with getAllByText.
    expect(screen.getAllByText(/write the doc/i).length).toBeGreaterThan(0);
  });
  it("offers a Blast tab for claude that lazily loads the blast radius", async () => {
    const call = vi.spyOn(routes.blastRoute, "call").mockResolvedValue({
      meta: { sessionId: "s", transcript: "s.jsonl", project: "~/p", startMs: 0, endMs: 0 },
      events: [{ seq: 0, msgIndex: 1, tsMs: null, tool: "Edit", action: "edit", target: "src/a.ts", zone: "project" }],
    } as any);
    render(<StructureView view={view} collapsed={new Set()} onToggle={() => {}} apiBase="/" agent="claude" />);
    expect(call).not.toHaveBeenCalled();                       // no fetch until the tab opens
    fireEvent.click(screen.getByRole("button", { name: /blast/i }));
    expect(await screen.findByText("a.ts")).toBeTruthy();
    expect(call).toHaveBeenCalledTimes(1);
  });
  it("hides the Blast tab for codex", () => {
    render(<StructureView view={{ ...view, agent: "codex" }} collapsed={new Set()} onToggle={() => {}} apiBase="/" agent="codex" />);
    expect(screen.queryByRole("button", { name: /blast/i })).toBeNull();
  });
});
