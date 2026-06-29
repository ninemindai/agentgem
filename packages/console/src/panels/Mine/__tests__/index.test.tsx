import { describe, it, expect, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";

afterEach(cleanup);
import { Mine } from "../index.js";
import type { ScorecardStreamEvent } from "../scorecardStream.js";
import type { Scorecard } from "../../../api/routes.js";

const FAKE_SCORECARD: Scorecard = {
  breadth: 10, battleTested: 5, portable: 3,
  gaps: [], projects: [], degraded: false, generatedAtMs: 0,
};

const SCORECARD_WITH_WORKFLOWS: Scorecard = {
  breadth: 3, battleTested: 1, portable: 1, gaps: [], degraded: false, generatedAtMs: 0,
  projects: [
    {
      root: "/projects/alpha", label: "alpha",
      breadth: 3, battleTested: 1, portable: 1,
      workflows: [
        { key: "wf-a", name: "Deploy workflow", confidence: "high", portable: true },
        { key: "wf-b", name: "Test workflow", confidence: "low", portable: false },
      ],
    },
  ],
};

// openStream that emits nothing — panel stays in loading/skeleton state.
const silentStream = (_apiBase: string, _onEvent: (e: ScorecardStreamEvent) => void) => () => {};

// openStream that synchronously fires a sequence of events.
function syncStream(events: ScorecardStreamEvent[]) {
  return (_apiBase: string, onEvent: (e: ScorecardStreamEvent) => void) => {
    for (const e of events) onEvent(e);
    return () => {};
  };
}

describe("Mine panel", () => {
  it("shows the scoring skeleton before any event", () => {
    render(<Mine apiBase="http://localhost:0" openStream={silentStream} />);
    expect(screen.getByText(/scoring your goldmine/i)).toBeTruthy();
  });

  it("shows scanning progress after start + progress events", () => {
    const stream = syncStream([
      { type: "start", total: 3 },
      { type: "progress", done: 2, total: 3, label: "proj-a", partial: { breadth: 7, battleTested: 3, portable: 1 } },
    ]);
    render(<Mine apiBase="http://localhost:0" openStream={stream} />);
    expect(screen.getByText(/7 reusable workflows/i)).toBeTruthy();
    expect(screen.getByText(/2\/3/)).toBeTruthy();
  });

  it("shows the hero after done event", () => {
    const stream = syncStream([
      { type: "start", total: 3 },
      { type: "progress", done: 2, total: 3, label: "proj-a", partial: { breadth: 7, battleTested: 3, portable: 1 } },
      { type: "done", scorecard: FAKE_SCORECARD, cached: false },
    ]);
    render(<Mine apiBase="http://localhost:0" openStream={stream} />);
    expect(screen.getByText(/10 reusable workflows/i)).toBeTruthy();
    expect(screen.getByText(/pick workflows to distill into a gem/i)).toBeTruthy();
  });

  it("shows error state after failed event", () => {
    const stream = syncStream([{ type: "failed", message: "oops" }]);
    render(<Mine apiBase="http://localhost:0" openStream={stream} />);
    expect(screen.getByText(/couldn't compute/i)).toBeTruthy();
  });

  it("clicking a filter chip in the workflow list filters the workflow list", () => {
    const stream = syncStream([{ type: "done", scorecard: SCORECARD_WITH_WORKFLOWS, cached: false }]);
    render(<Mine apiBase="http://localhost:0" openStream={stream} />);
    // both workflows are visible before filtering
    expect(screen.getByText("Deploy workflow")).toBeTruthy();
    expect(screen.getByText("Test workflow")).toBeTruthy();
    // click the "battle-tested" chip in MineWorkflows
    fireEvent.click(screen.getByRole("button", { name: /battle-tested \(1\)/i }));
    // low-confidence workflow should now be hidden
    expect(screen.queryByText("Test workflow")).toBeNull();
    // high-confidence workflow stays visible
    expect(screen.getByText("Deploy workflow")).toBeTruthy();
  });

  it("ScorecardHero does not receive filter/onFilter — stats are plain text", () => {
    const stream = syncStream([{ type: "done", scorecard: SCORECARD_WITH_WORKFLOWS, cached: false }]);
    render(<Mine apiBase="http://localhost:0" openStream={stream} />);
    // Stats text appears in the hero as a plain paragraph (not a button)
    const statsEl = screen.getByText(/1 battle-tested · 1 worth sharing/i);
    expect(statsEl.tagName.toLowerCase()).not.toBe("button");
  });

  it("MineWorkflows receives filter, onFilter, and apiBase", () => {
    const stream = syncStream([{ type: "done", scorecard: SCORECARD_WITH_WORKFLOWS, cached: false }]);
    render(<Mine apiBase="http://localhost:0" openStream={stream} />);
    // Filter chips are rendered inside MineWorkflows
    expect(screen.getByRole("button", { name: /^all$/i })).toBeTruthy();
    expect(screen.getByRole("button", { name: /battle-tested \(1\)/i })).toBeTruthy();
    expect(screen.getByRole("button", { name: /worth sharing \(1\)/i })).toBeTruthy();
  });
});
