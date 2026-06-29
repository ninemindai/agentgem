import { describe, it, expect, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";

afterEach(cleanup);
import { Dashboard } from "./Dashboard.js";
import type { ObservePayload } from "../../api/routes.js";

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

describe("Observe Dashboard", () => {
  it("renders the pulse and a session row", () => {
    render(<Dashboard data={payload} range="7d" onRange={() => {}} filter={{}} onFilter={() => {}} />);
    expect(screen.getByText("1.2M")).toBeDefined();                    // pulse tokens
    expect(screen.getAllByText("agentgem").length).toBeGreaterThan(0); // session row project (also in dropdown)
  });

  it("renders filter controls with facet values", () => {
    render(<Dashboard data={payload} range="7d" onRange={() => {}} filter={{}} onFilter={() => {}} />);
    expect(screen.getByLabelText(/agent/i)).toBeDefined();              // agent dropdown
    expect(screen.getByLabelText(/model/i)).toBeDefined();             // model dropdown
    expect(screen.getAllByText("claude-opus-4-8").length).toBeGreaterThan(0); // model option present
  });

  it("clicking a session row reveals detail; clicking again hides it", () => {
    const { container } = render(<Dashboard data={payload} range="7d" onRange={() => {}} filter={{}} onFilter={() => {}} />);

    // detail row not visible initially
    expect(screen.queryByText(/branch/)).toBeNull();

    // click the row (role=button)
    const rowBtn = container.querySelector('tr[role="button"]') as HTMLElement;
    expect(rowBtn).not.toBeNull();
    fireEvent.click(rowBtn);

    // detail row should appear with branch and model info
    expect(screen.getByText(/branch/)).toBeDefined();
    expect(screen.getByText(/main/)).toBeDefined();
    expect(screen.getAllByText(/claude-opus-4-8/).length).toBeGreaterThan(0);

    // click again to close
    fireEvent.click(rowBtn);
    expect(screen.queryByText(/branch/)).toBeNull();
  });

  it("renders a flame badge for the hottest session", () => {
    const { container } = render(<Dashboard data={payload} range="7d" onRange={() => {}} filter={{}} onFilter={() => {}} />);
    const flameBadge = container.querySelector(".obs-flame");
    expect(flameBadge).not.toBeNull();
    // only 1 session and it's the max → level 3 → three flames
    expect(flameBadge!.textContent).toContain("🔥"); // 🔥
  });

  it("renders at least one heatmap cell", () => {
    const { container } = render(<Dashboard data={payload} range="7d" onRange={() => {}} filter={{}} onFilter={() => {}} />);
    const cell = container.querySelector(".obs-heat-cell");
    expect(cell).not.toBeNull();
  });

  it("keyboard Enter on session row toggles detail", () => {
    const { container } = render(<Dashboard data={payload} range="7d" onRange={() => {}} filter={{}} onFilter={() => {}} />);
    const rowBtn = container.querySelector('tr[role="button"]') as HTMLElement;
    fireEvent.keyDown(rowBtn, { key: "Enter" });
    expect(screen.getByText(/branch/)).toBeDefined();
    fireEvent.keyDown(rowBtn, { key: "Enter" });
    expect(screen.queryByText(/branch/)).toBeNull();
  });
});
