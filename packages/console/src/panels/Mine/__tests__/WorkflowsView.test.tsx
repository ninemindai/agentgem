import { describe, it, expect, afterEach, vi } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";

afterEach(cleanup);
import { WorkflowsView } from "../WorkflowsView.js";
import type { ScorecardStreamEvent } from "../scorecardStream.js";
import type { Scorecard } from "../../../api/routes.js";
import * as rubricShortcuts from "../../../rubricShortcuts.js";

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
        { key: "wf-a", name: "Deploy workflow", confidence: "high", portable: true, sessions: 4, lastSeenMs: 0 },
        { key: "wf-b", name: "Test workflow", confidence: "low", portable: false, sessions: 1, lastSeenMs: 0 },
      ],
    },
  ],
};

const EMPTY_SCORECARD: Scorecard = {
  breadth: 0, battleTested: 0, portable: 0, gaps: [], degraded: false, generatedAtMs: 0,
  projects: [],
};

// openStream that emits nothing — panel stays in loading/skeleton state.
const silentStream = (_client: unknown, _onEvent: (e: ScorecardStreamEvent) => void) => () => {};

// openStream that synchronously fires a sequence of events.
function syncStream(events: ScorecardStreamEvent[]) {
  return (_client: unknown, onEvent: (e: ScorecardStreamEvent) => void) => {
    for (const e of events) onEvent(e);
    return () => {};
  };
}

describe("WorkflowsView", () => {
  it("shows the scoring skeleton before any event", () => {
    render(<WorkflowsView apiBase="http://localhost:0" scope="*" openStream={silentStream} />);
    expect(screen.getByText(/scoring your goldmine/i)).toBeTruthy();
  });

  it("loading state shows GemCardSkeleton placeholders, not a bare spinner", () => {
    render(<WorkflowsView apiBase="http://localhost:0" scope="*" openStream={silentStream} />);
    expect(document.querySelectorAll(".gem-card--skeleton").length).toBeGreaterThan(0);
  });

  it("shows scanning progress after start + progress events, with skeleton placeholders", () => {
    const stream = syncStream([
      { type: "start", total: 3 },
      { type: "progress", done: 2, total: 3, label: "proj-a", partial: { breadth: 7, battleTested: 3, portable: 1 } },
    ]);
    render(<WorkflowsView apiBase="http://localhost:0" scope="*" openStream={stream} />);
    expect(screen.getByText(/7 reusable workflows/i)).toBeTruthy();
    expect(screen.getByText(/2\/3/)).toBeTruthy();
    expect(document.querySelectorAll(".gem-card--skeleton").length).toBeGreaterThan(0);
  });

  it("shows the hero after done event", () => {
    const stream = syncStream([
      { type: "start", total: 3 },
      { type: "progress", done: 2, total: 3, label: "proj-a", partial: { breadth: 7, battleTested: 3, portable: 1 } },
      { type: "done", scorecard: FAKE_SCORECARD, cached: false, updatedAt: null },
    ]);
    render(<WorkflowsView apiBase="http://localhost:0" scope="*" openStream={stream} />);
    expect(screen.getByText(/10 reusable workflows/i)).toBeTruthy();
    expect(screen.getByText(/pick workflows to distill into a gem/i)).toBeTruthy();
  });

  it("SWR: a stale event shows the hero immediately with an 'updating…' pill", () => {
    const stream = syncStream([
      { type: "start", total: 3 },
      { type: "stale", scorecard: FAKE_SCORECARD, updatedAt: 123 },
    ]);
    render(<WorkflowsView apiBase="http://localhost:0" scope="*" openStream={stream} />);
    expect(screen.getByText(/10 reusable workflows/i)).toBeTruthy(); // hero shown from last-good data
    expect(screen.getByText("updating…")).toBeTruthy();               // ...with the revalidating pill
  });

  it("SWR: the fresh done supersedes the stale scorecard and clears the pill", () => {
    const stream = syncStream([
      { type: "start", total: 3 },
      { type: "stale", scorecard: FAKE_SCORECARD, updatedAt: 123 },        // breadth 10
      { type: "progress", done: 1, total: 3, label: "p", partial: { breadth: 1, battleTested: 0, portable: 0 } },
      { type: "done", scorecard: SCORECARD_WITH_WORKFLOWS, cached: false, updatedAt: 456 }, // breadth 3
    ]);
    render(<WorkflowsView apiBase="http://localhost:0" scope="*" openStream={stream} />);
    expect(screen.getByText(/3 reusable workflows/i)).toBeTruthy();   // fresh result
    expect(screen.queryByText(/10 reusable workflows/i)).toBeNull();  // stale replaced
    expect(screen.queryByText("updating…")).toBeNull();               // pill cleared
  });

  it("done with a zero-workflow scorecard shows the empty doorway", () => {
    const spy = vi.spyOn(rubricShortcuts, "launchRubricRun").mockImplementation(() => {});
    const stream = syncStream([{ type: "done", scorecard: EMPTY_SCORECARD, cached: false, updatedAt: null }]);
    render(<WorkflowsView apiBase="http://localhost:0" scope="/projects/alpha" openStream={stream} />);
    expect(screen.getByText(/no gems mined here yet/i)).toBeTruthy();
    const cta = screen.getByRole("button", { name: /run a hygiene rubric/i });
    fireEvent.click(cta);
    expect(spy).toHaveBeenCalledWith({ rubric: "context-hygiene", scope: "project", root: "/projects/alpha" });
    spy.mockRestore();
  });

  it("empty doorway CTA targets scope 'all' when no project is selected", () => {
    const spy = vi.spyOn(rubricShortcuts, "launchRubricRun").mockImplementation(() => {});
    const stream = syncStream([{ type: "done", scorecard: EMPTY_SCORECARD, cached: false, updatedAt: null }]);
    render(<WorkflowsView apiBase="http://localhost:0" scope="*" openStream={stream} />);
    fireEvent.click(screen.getByRole("button", { name: /run a hygiene rubric/i }));
    expect(spy).toHaveBeenCalledWith({ rubric: "context-hygiene", scope: "all", root: undefined });
    spy.mockRestore();
  });

  it("shows error state with the failure message after a failed event", () => {
    const stream = syncStream([{ type: "failed", message: "oops" }]);
    render(<WorkflowsView apiBase="http://localhost:0" scope="*" openStream={stream} />);
    expect(screen.getByText(/couldn't compute/i)).toBeTruthy();
    expect(screen.getByText(/oops/i)).toBeTruthy();
  });

  it("failed state Retry button re-invokes the stream", () => {
    let calls = 0;
    const stream = (_client: unknown, onEvent: (e: ScorecardStreamEvent) => void) => {
      calls += 1;
      onEvent({ type: "failed", message: "oops" });
      return () => {};
    };
    render(<WorkflowsView apiBase="http://localhost:0" scope="*" openStream={stream} />);
    expect(calls).toBe(1);
    fireEvent.click(screen.getByRole("button", { name: /retry/i }));
    expect(calls).toBe(2);
  });

  it("done with workflows renders the grouped cards and the slim ScorecardHero summary", () => {
    const stream = syncStream([{ type: "done", scorecard: SCORECARD_WITH_WORKFLOWS, cached: false, updatedAt: null }]);
    render(<WorkflowsView apiBase="http://localhost:0" scope="*" openStream={stream} />);
    // slim hero summary
    expect(screen.getByText(/3 reusable workflows/i)).toBeTruthy();
    expect(screen.getByText("Share my goldmine")).toBeTruthy();
    // grouped gem cards
    expect(screen.getByText("Deploy workflow")).toBeTruthy();
    expect(screen.getByText("Test workflow")).toBeTruthy();
  });
});
