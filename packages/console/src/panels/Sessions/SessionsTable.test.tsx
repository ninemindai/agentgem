import { describe, it, expect, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import { SessionsTable } from "./SessionsTable.js";
import type { SessionActivity } from "./SessionSummaryPopover.js";
import type { ObservePayload } from "../../api/routes.js";

afterEach(() => { cleanup(); window.location.hash = ""; });

const payload: ObservePayload = {
  pulse: { sessions: 2, msgs: 12, tokens: 1_200_000, activeMs: 2.1 * 3_600_000 },
  daily: [{ date: "2026-06-28", sessions: 2, msgs: 12, tokensIn: 800_000, tokensOut: 300_000, tokensCache: 100_000 }],
  sessions: [{
    agent: "claude", sessionId: "s1", project: "agentgem", model: "claude-opus-4-8",
    startMs: 1_750_000_000_000, endMs: 1_750_010_000_000, durationMs: 10_000_000,
    msgs: 8, tokens: 900_000,
    tokensIn: 700_000, tokensOut: 150_000, tokensCache: 50_000, gitBranch: "main",
  }],
  models: [{ model: "claude-opus-4-8", agent: "claude", sessions: 2, tokens: 1_200_000 }],
  byTool: [], bySkill: [], bySubagent: [], usageDaily: [],
  facets: { agents: ["claude"], projects: ["agentgem"], models: ["claude-opus-4-8"] },
  range: "7d",
};

const activity = new Map<string, SessionActivity>([
  ["claude:s1", { tools: { Edit: 4, Bash: 2 }, skills: { insights: 1 }, subagents: {} }],
]);
const emptyActivity = new Map<string, SessionActivity>();

const rowOf = (c: HTMLElement) => c.querySelector('tr[role="button"]') as HTMLElement;

describe("SessionsTable", () => {
  it("clicking a session row opens its transcript", () => {
    window.location.hash = "";
    const { container } = render(<SessionsTable data={payload} activity={activity} />);
    fireEvent.click(rowOf(container));
    expect(window.location.hash).toBe("#/sessions/claude/s1");
  });

  it("Enter and Space on a row open its transcript", () => {
    const { container } = render(<SessionsTable data={payload} activity={activity} />);
    const row = rowOf(container);
    window.location.hash = "";
    fireEvent.keyDown(row, { key: "Enter" });
    expect(window.location.hash).toBe("#/sessions/claude/s1");
    window.location.hash = "";
    fireEvent.keyDown(row, { key: " " });
    expect(window.location.hash).toBe("#/sessions/claude/s1");
  });

  it("no longer renders an inline expand detail row", () => {
    const { container } = render(<SessionsTable data={payload} activity={activity} />);
    fireEvent.click(rowOf(container));
    expect(container.querySelector(".obs-detail")).toBeNull();
    expect(screen.queryByText(/Open transcript/)).toBeNull();
  });

  it("hovering a row shows its activity skeleton", () => {
    const { container } = render(<SessionsTable data={payload} activity={activity} />);
    const row = rowOf(container);
    expect(screen.queryByRole("tooltip")).toBeNull();
    fireEvent.mouseEnter(row);
    expect(screen.getByRole("tooltip").textContent).toContain("Edit×4 · Bash×2 · 1 skill");
    fireEvent.mouseLeave(row);
    expect(screen.queryByRole("tooltip")).toBeNull();
  });

  it("focus also reveals the popover", () => {
    const { container } = render(<SessionsTable data={payload} activity={activity} />);
    fireEvent.focus(rowOf(container));
    expect(screen.getByRole("tooltip")).toBeDefined();
  });

  it("shows a fallback when the row has no recorded activity", () => {
    const { container } = render(<SessionsTable data={payload} activity={emptyActivity} />);
    fireEvent.mouseEnter(rowOf(container));
    expect(screen.getByText("No recorded tool activity")).toBeDefined();
  });

  it("renders a flame badge for the hottest session", () => {
    const { container } = render(<SessionsTable data={payload} activity={activity} />);
    const flameBadge = container.querySelector(".obs-flame");
    expect(flameBadge).not.toBeNull();
    expect(flameBadge!.textContent).toContain("🔥");
  });

  it("shows N-of-M hint when pulse.sessions > visible rows", () => {
    render(<SessionsTable data={{ ...payload, pulse: { ...payload.pulse, sessions: 500 } }} activity={activity} />);
    expect(screen.getByText(/Showing 1 of 500 sessions/)).toBeDefined();
  });

  it("does not show N-of-M hint when pulse.sessions equals visible rows", () => {
    render(<SessionsTable data={{ ...payload, pulse: { ...payload.pulse, sessions: 1 } }} activity={activity} />);
    expect(screen.queryByText(/Showing \d+ of \d+ sessions/)).toBeNull();
  });
});
