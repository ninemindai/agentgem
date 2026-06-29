import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { Mine } from "../index.js";
import type { ScorecardStreamEvent } from "../scorecardStream.js";
import type { Scorecard } from "../../../api/routes.js";

const FAKE_SCORECARD: Scorecard = {
  breadth: 10, battleTested: 5, portable: 3,
  gaps: [], projects: [], degraded: false, generatedAtMs: 0,
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
});
