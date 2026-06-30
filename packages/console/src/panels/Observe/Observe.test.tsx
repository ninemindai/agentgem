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

  it("shows 'Updating…' pill when pending=true, hides it when pending=false", () => {
    const { rerender } = render(<Dashboard data={payload} range="7d" onRange={() => {}} filter={{}} onFilter={() => {}} pending={true} />);
    expect(screen.getByText("Updating…")).toBeDefined();
    rerender(<Dashboard data={payload} range="7d" onRange={() => {}} filter={{}} onFilter={() => {}} pending={false} />);
    expect(screen.queryByText("Updating…")).toBeNull();
  });

  it("shows N-of-M hint when pulse.sessions > visible rows", () => {
    const bigPayload = {
      ...payload,
      pulse: { ...payload.pulse, sessions: 500 },
    };
    render(<Dashboard data={bigPayload} range="7d" onRange={() => {}} filter={{}} onFilter={() => {}} />);
    // 1 session row, pulse.sessions=500
    expect(screen.getByText(/Showing 1 of 500 sessions/)).toBeDefined();
  });

  it("does not show N-of-M hint when pulse.sessions equals visible rows", () => {
    const exactPayload = {
      ...payload,
      pulse: { ...payload.pulse, sessions: 1 },
    };
    render(<Dashboard data={exactPayload} range="7d" onRange={() => {}} filter={{}} onFilter={() => {}} />);
    // pulse.sessions=1, rows.length=1 → no hint
    expect(screen.queryByText(/Showing \d+ of \d+ sessions/)).toBeNull();
  });

  it("keyboard Enter on session row toggles detail", () => {
    const { container } = render(<Dashboard data={payload} range="7d" onRange={() => {}} filter={{}} onFilter={() => {}} />);
    const rowBtn = container.querySelector('tr[role="button"]') as HTMLElement;
    fireEvent.keyDown(rowBtn, { key: "Enter" });
    expect(screen.getByText(/branch/)).toBeDefined();
    fireEvent.keyDown(rowBtn, { key: "Enter" });
    expect(screen.queryByText(/branch/)).toBeNull();
  });

  it("renders weekday Y-axis label Mon", () => {
    render(<Dashboard data={payload} range="7d" onRange={() => {}} filter={{}} onFilter={() => {}} />);
    expect(screen.getAllByText("Mon").length).toBeGreaterThan(0);
  });

  it("renders heatmap legend with Less and More", () => {
    render(<Dashboard data={payload} range="7d" onRange={() => {}} filter={{}} onFilter={() => {}} />);
    expect(screen.getByText("Less")).toBeDefined();
    expect(screen.getByText("More")).toBeDefined();
  });

  it("'Open transcript' in the expanded row navigates to the drill-down sub-route", () => {
    window.location.hash = "";
    const { container } = render(<Dashboard data={payload} range="7d" onRange={() => {}} filter={{}} onFilter={() => {}} />);
    fireEvent.click(container.querySelector('tr[role="button"]') as HTMLElement); // expand detail
    fireEvent.click(screen.getByText(/Open transcript/));
    expect(window.location.hash).toBe("#/inspect/claude/s1");
  });

  it("min-msgs filter input shows value 100 when filter.minMsgs is 100", () => {
    render(<Dashboard data={payload} range="7d" onRange={() => {}} filter={{ minMsgs: 100 }} onFilter={() => {}} />);
    const input = screen.getByLabelText(/minimum messages/i) as HTMLInputElement;
    expect(input.value).toBe("100");
  });
});
