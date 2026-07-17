import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, fireEvent, cleanup, within } from "@testing-library/react";

afterEach(cleanup);
import { WorkflowsView } from "../WorkflowsView.js";
import type { ScorecardStreamEvent } from "../scorecardStream.js";
import type { Scorecard, Inventory, Usage } from "../../../api/routes.js";
import * as routes from "../../../api/routes.js";
import * as rubricShortcuts from "../../../rubricShortcuts.js";
import * as activity from "../../../notify/ActivityProvider.js";
import * as rubricStreamModule from "../../Rubrics/rubricStream.js";

const EMPTY_INVENTORY: Inventory = { skills: [], subagents: [], mcpServers: [], instructions: [], hooks: [], rubrics: [] };
const EMPTY_USAGE: Usage = { artifacts: [] };

// Every WorkflowsView render now also fetches inventory + usage + miniapps
// (composed client-side alongside the scorecard's workflows). Default them to
// empty so tests that don't care about the extra sources see the same behavior
// as before; tests that DO care override the mock per-test.
function stubUnifiedSources(overrides: { inventory?: Inventory; usage?: Usage; miniapps?: { name: string; title: string; genre: string }[] } = {}) {
  vi.spyOn(routes.inventoryRoute, "call").mockResolvedValue(overrides.inventory ?? EMPTY_INVENTORY);
  vi.spyOn(routes.usageRoute, "call").mockResolvedValue(overrides.usage ?? EMPTY_USAGE);
  vi.spyOn(routes.playMiniappsRoute, "call").mockResolvedValue({
    miniapps: (overrides.miniapps ?? []).map((m) => ({ ...m, needs: [] })),
  });
}

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
  const ORIGINAL_HASH = window.location.hash;
  beforeEach(() => {
    window.location.hash = "";
    stubUnifiedSources();
    vi.spyOn(activity, "useActivity").mockReturnValue({ runs: [] });
  });
  afterEach(() => { window.location.hash = ORIGINAL_HASH; vi.restoreAllMocks(); });

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
    expect(screen.getByText(/your workflows/i)).toBeTruthy();
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

  it("done with workflows renders the Group by switcher with Value active", () => {
    const stream = syncStream([{ type: "done", scorecard: SCORECARD_WITH_WORKFLOWS, cached: false, updatedAt: null }]);
    render(<WorkflowsView apiBase="http://localhost:0" scope="*" openStream={stream} />);
    expect(screen.getByText("Group by")).toBeTruthy();
    const value = screen.getByRole("button", { name: "Value" });
    expect(value.getAttribute("aria-pressed")).toBe("true");
  });

  it("renders all three Group by segments (Value/Type/Maturity)", () => {
    const stream = syncStream([{ type: "done", scorecard: SCORECARD_WITH_WORKFLOWS, cached: false, updatedAt: null }]);
    render(<WorkflowsView apiBase="http://localhost:0" scope="*" openStream={stream} />);
    expect(screen.getByRole("button", { name: "Value" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Type" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Maturity" })).toBeTruthy();
  });

  it("clicking Type sets ?group=type and re-groups the unified set by type", async () => {
    stubUnifiedSources({
      inventory: { ...EMPTY_INVENTORY, skills: [{ name: "pdf-skill" }] },
      usage: { artifacts: [{ type: "skill", name: "pdf-skill", invocations: 2, lastUsedMs: 10 }] },
    });
    const stream = syncStream([{ type: "done", scorecard: SCORECARD_WITH_WORKFLOWS, cached: false, updatedAt: null }]);
    render(<WorkflowsView apiBase="http://localhost:0" scope="*" openStream={stream} />);
    // The unified-sources fetch is async; wait for the skill gem to fold in before switching axes.
    await screen.findByText("pdf-skill");

    fireEvent.click(screen.getByRole("button", { name: "Type" }));

    expect(window.location.hash).toContain("group=type");
    expect(screen.getByText("Workflows")).toBeTruthy();
    expect(screen.getByText("Skills")).toBeTruthy();
  });

  it("Mine is not empty when only inventory/miniapps are present (no workflows)", async () => {
    stubUnifiedSources({ miniapps: [{ name: "wordle-clone", title: "Wordle Clone", genre: "puzzle" }] });
    const stream = syncStream([{ type: "done", scorecard: EMPTY_SCORECARD, cached: false, updatedAt: null }]);
    render(<WorkflowsView apiBase="http://localhost:0" scope="*" openStream={stream} />);
    expect(await screen.findByText("wordle-clone")).toBeTruthy();
    expect(screen.queryByText(/no gems mined here yet/i)).toBeNull();
  });

  it("does not render the Group by switcher in the empty doorway state", () => {
    const stream = syncStream([{ type: "done", scorecard: EMPTY_SCORECARD, cached: false, updatedAt: null }]);
    render(<WorkflowsView apiBase="http://localhost:0" scope="*" openStream={stream} />);
    expect(screen.getByText(/no gems mined here yet/i)).toBeTruthy();
    expect(screen.queryByText("Group by")).toBeNull();
  });

  it("clicking Value normalizes the hash to include group=value", () => {
    window.location.hash = "#/mine";
    const stream = syncStream([{ type: "done", scorecard: SCORECARD_WITH_WORKFLOWS, cached: false, updatedAt: null }]);
    render(<WorkflowsView apiBase="http://localhost:0" scope="*" openStream={stream} />);
    fireEvent.click(screen.getByRole("button", { name: "Value" }));
    expect(window.location.hash).toContain("group=value");
  });

  // ── Jobs strip + per-card hygiene back-fill ─────────────────────────────────

  describe("jobs strip + hygiene score back-fill", () => {
    it("with no rubric runs, the strip is absent and cards show Run hygiene (existing behavior)", () => {
      const stream = syncStream([{ type: "done", scorecard: SCORECARD_WITH_WORKFLOWS, cached: false, updatedAt: null }]);
      render(<WorkflowsView apiBase="http://localhost:0" scope="*" openStream={stream} />);
      expect(screen.queryByRole("status")).toBeNull();
      const card = screen.getByText("Deploy workflow").closest("li")!;
      expect(within(card).getByRole("button", { name: /run hygiene/i })).toBeTruthy();
    });

    it("a running context-hygiene run for /projects/alpha shows the jobs strip and re-scoring state on its card", () => {
      vi.spyOn(activity, "useActivity").mockReturnValue({
        runs: [{ id: "r1", kind: "rubric", paramsKey: "context-hygiene:project:/projects/alpha:", status: "running", phase: "scanning", startedAt: Date.now() }],
      });
      const stream = syncStream([{ type: "done", scorecard: SCORECARD_WITH_WORKFLOWS, cached: false, updatedAt: null }]);
      render(<WorkflowsView apiBase="http://localhost:0" scope="*" openStream={stream} />);

      const strip = screen.getByRole("status");
      expect(strip).toBeTruthy();
      expect(within(strip).getByRole("link", { name: /view queue/i }).getAttribute("href")).toBe("#/rubrics");

      const card = screen.getByText("Deploy workflow").closest("li")!;
      expect(within(card).getByText(/re-scoring/i)).toBeTruthy();
      expect(within(card).queryByText(/run hygiene/i)).toBeNull();
    });

    it("a done context-hygiene run for /projects/alpha fills the alpha card's score slot from the rubric stream", () => {
      vi.spyOn(activity, "useActivity").mockReturnValue({
        runs: [{ id: "r1", kind: "rubric", paramsKey: "context-hygiene:project:/projects/alpha:", status: "done", phase: "", startedAt: 1 }],
      });
      vi.spyOn(rubricStreamModule, "openRubricStream").mockImplementation((_client, _params, onEvent) => {
        onEvent({ type: "done", report: { hygiene: { score: 84, verdict: "bounded" } } as any, cached: true, updatedAt: 1 });
        return () => {};
      });
      const stream = syncStream([{ type: "done", scorecard: SCORECARD_WITH_WORKFLOWS, cached: false, updatedAt: null }]);
      render(<WorkflowsView apiBase="http://localhost:0" scope="*" openStream={stream} />);

      expect(screen.queryByRole("status")).toBeNull(); // run is done, not running — no strip
      const card = screen.getByText("Deploy workflow").closest("li")!;
      expect(within(card).getByText("84")).toBeTruthy();
      expect(within(card).getByText("hygiene")).toBeTruthy();
      expect(within(card).queryByText(/run hygiene/i)).toBeNull();
    });
  });
});
