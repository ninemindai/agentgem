import { describe, it, expect, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import { SessionsTable } from "./SessionsTable.js";
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
  facets: { agents: ["claude"], projects: ["agentgem"], models: ["claude-opus-4-8"] },
  range: "7d",
};

describe("SessionsTable", () => {
  it("clicking a session row reveals detail; clicking again hides it", () => {
    const { container } = render(<SessionsTable data={payload} />);
    expect(screen.queryByText(/branch/)).toBeNull();
    const rowBtn = container.querySelector('tr[role="button"]') as HTMLElement;
    expect(rowBtn).not.toBeNull();
    fireEvent.click(rowBtn);
    expect(screen.getByText(/branch/)).toBeDefined();
    expect(screen.getByText(/main/)).toBeDefined();
    fireEvent.click(rowBtn);
    expect(screen.queryByText(/branch/)).toBeNull();
  });

  it("renders a flame badge for the hottest session", () => {
    const { container } = render(<SessionsTable data={payload} />);
    const flameBadge = container.querySelector(".obs-flame");
    expect(flameBadge).not.toBeNull();
    expect(flameBadge!.textContent).toContain("🔥");
  });

  it("shows N-of-M hint when pulse.sessions > visible rows", () => {
    render(<SessionsTable data={{ ...payload, pulse: { ...payload.pulse, sessions: 500 } }} />);
    expect(screen.getByText(/Showing 1 of 500 sessions/)).toBeDefined();
  });

  it("does not show N-of-M hint when pulse.sessions equals visible rows", () => {
    render(<SessionsTable data={{ ...payload, pulse: { ...payload.pulse, sessions: 1 } }} />);
    expect(screen.queryByText(/Showing \d+ of \d+ sessions/)).toBeNull();
  });

  it("keyboard Enter on session row toggles detail", () => {
    const { container } = render(<SessionsTable data={payload} />);
    const rowBtn = container.querySelector('tr[role="button"]') as HTMLElement;
    fireEvent.keyDown(rowBtn, { key: "Enter" });
    expect(screen.getByText(/branch/)).toBeDefined();
    fireEvent.keyDown(rowBtn, { key: "Enter" });
    expect(screen.queryByText(/branch/)).toBeNull();
  });

  it("'Open transcript' navigates to the Sessions drill-down sub-route", () => {
    window.location.hash = "";
    const { container } = render(<SessionsTable data={payload} />);
    fireEvent.click(container.querySelector('tr[role="button"]') as HTMLElement); // expand
    fireEvent.click(screen.getByText(/Open transcript/));
    expect(window.location.hash).toBe("#/sessions/claude/s1");
  });
});
