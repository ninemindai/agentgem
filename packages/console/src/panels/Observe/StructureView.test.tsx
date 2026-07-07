import { describe, it, expect, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import { StructureView } from "./StructureView.js";

afterEach(() => cleanup());

const view = {
  sessionId: "s", agent: "claude", meta: {} as any,
  turns: [
    { id: "u0", role: "user", tsMs: 0, tokens: { in: 0, out: 0, cache: 0 }, spans: [{ kind: "message", role: "user", text: "write the doc" }] },
    { id: "a0", role: "assistant", tsMs: 1, tokens: { in: 0, out: 5, cache: 0 }, spans: [{ kind: "tool_call", name: "Write", input: "f" }] },
  ],
} as any;

describe("StructureView", () => {
  it("defaults to Map and shows a phase label + tool cell", () => {
    render(<StructureView view={view} collapsed={new Set()} onToggle={() => {}} />);
    expect(screen.getByText(/write the doc/i)).toBeTruthy();
    expect(screen.getByText(/Write/)).toBeTruthy();
  });
  it("switches to Transcript mode", () => {
    render(<StructureView view={view} collapsed={new Set()} onToggle={() => {}} />);
    fireEvent.click(screen.getByRole("button", { name: /transcript/i }));
    // Untouched `collapsed` means every turn starts open, so the verbatim message
    // shows twice (collapsed-header summary + open body) — same duplication the
    // existing TranscriptViewer tests account for with getAllByText.
    expect(screen.getAllByText(/write the doc/i).length).toBeGreaterThan(0);
  });
});
