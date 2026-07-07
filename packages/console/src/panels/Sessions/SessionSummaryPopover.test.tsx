import { describe, it, expect, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import { SessionSummaryPopover, formatActivity } from "./SessionSummaryPopover.js";

afterEach(() => cleanup());

describe("formatActivity", () => {
  it("orders tools by count desc then name asc, capping at 5", () => {
    const parts = formatActivity({
      tools: { Edit: 20, Bash: 8, Read: 20, Grep: 1, Write: 3, Glob: 2, Task: 9 },
      skills: {}, subagents: {},
    });
    // Edit and Read tie at 20 → name asc puts Edit first; only the top 5 survive.
    expect(parts).toEqual(["Edit×20", "Read×20", "Task×9", "Bash×8", "Write×3"]);
  });

  it("appends distinct skill/subagent counts with singular/plural", () => {
    expect(formatActivity({ tools: {}, skills: { a: 3 }, subagents: { x: 1, y: 2 } }))
      .toEqual(["1 skill", "2 subagents"]);
  });

  it("returns [] when nothing was recorded", () => {
    expect(formatActivity({ tools: {}, skills: {}, subagents: {} })).toEqual([]);
  });
});

describe("SessionSummaryPopover", () => {
  it("renders the formatted skeleton", () => {
    render(<SessionSummaryPopover activity={{ tools: { Edit: 2 }, skills: { s: 1 }, subagents: {} }} />);
    expect(screen.getByRole("tooltip").textContent).toContain("Edit×2 · 1 skill");
  });

  it("shows a fallback when there is no recorded activity", () => {
    render(<SessionSummaryPopover activity={{ tools: {}, skills: {}, subagents: {} }} />);
    expect(screen.getByText("No recorded tool activity")).toBeDefined();
  });
});
