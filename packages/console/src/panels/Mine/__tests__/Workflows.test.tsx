import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { render, screen, fireEvent, cleanup, waitFor, within } from "@testing-library/react";

afterEach(cleanup);
import { MineWorkflows } from "../Workflows.js";
import type { Scorecard, WorkflowDetail } from "../../../api/routes.js";
import * as routes from "../../../api/routes.js";
import { consumePendingRubricRun } from "../../../pendingAnalyze.js";

const SCORECARD: Scorecard = {
  breadth: 5, battleTested: 2, portable: 1, gaps: ["missing tests", "no CI pipeline"], degraded: false, generatedAtMs: 0,
  projects: [
    {
      root: "/projects/alpha", label: "alpha",
      breadth: 3, battleTested: 2, portable: 1,
      workflows: [
        { key: "wf-a", name: "Deploy workflow", confidence: "high", portable: true, sessions: 7, lastSeenMs: 1000 },
        { key: "wf-b", name: "Release workflow", confidence: "high", portable: false, sessions: 5, lastSeenMs: 2000 },
        { key: "wf-c", name: "Test workflow", confidence: "medium", portable: false, sessions: 2, lastSeenMs: 3000 },
      ],
    },
  ],
};

const defaultProps = {
  data: SCORECARD,
  onBuild: vi.fn(),
  building: false,
  result: null,
  error: null,
  apiBase: "http://localhost:0",
  group: "value" as const,
  inventory: [],
  miniapps: [],
};

// Find the <li class="gem-card"> that contains a given card name, for scoping queries
// to a single card instead of relying on render order across groups.
const cardFor = (name: string) => screen.getByText(name).closest("li")!;

describe("MineWorkflows", () => {
  it("renders Value group headers with counts", () => {
    render(<MineWorkflows {...defaultProps} />);
    expect(screen.getByText("Battle-tested")).toBeTruthy();
    expect(screen.getByText("Worth sharing")).toBeTruthy();
    expect(screen.getByText("Reusable")).toBeTruthy();
  });

  it("groups a portable+high workflow under Worth sharing", () => {
    render(<MineWorkflows {...defaultProps} />);
    const group = screen.getByText("Worth sharing").closest(".mine-group") as HTMLElement;
    expect(within(group).getByText("Deploy workflow")).toBeTruthy();
  });

  it("groups a high non-portable workflow under Battle-tested", () => {
    render(<MineWorkflows {...defaultProps} />);
    const group = screen.getByText("Battle-tested").closest(".mine-group") as HTMLElement;
    expect(within(group).getByText("Release workflow")).toBeTruthy();
  });

  it("groups a medium-confidence workflow under Reusable", () => {
    render(<MineWorkflows {...defaultProps} />);
    const group = screen.getByText("Reusable").closest(".mine-group") as HTMLElement;
    expect(within(group).getByText("Test workflow")).toBeTruthy();
  });

  it("renders gaps as gap rows, not gem cards", () => {
    render(<MineWorkflows {...defaultProps} />);
    expect(screen.getByText("missing tests")).toBeTruthy();
    expect(screen.getByText("no CI pipeline")).toBeTruthy();
    expect(screen.getByText("missing tests").className).toBe("mine-gaps-row");
  });

  it("each card shows name, provenance, and the Run hygiene affordance", () => {
    render(<MineWorkflows {...defaultProps} />);
    const card = cardFor("Deploy workflow");
    expect(within(card).getByText(/distilled from 7 sessions · alpha/i)).toBeTruthy();
    expect(within(card).getByRole("button", { name: /run hygiene/i })).toBeTruthy();
  });

  it("the batch build bar and checkboxes are gone", () => {
    render(<MineWorkflows {...defaultProps} />);
    expect(screen.queryByRole("button", { name: /build gem/i })).toBeNull();
    expect(screen.queryByRole("checkbox")).toBeNull();
    expect(screen.queryByPlaceholderText(/gem name/i)).toBeNull();
  });

  it("clicking Distill calls onBuild with a single-workflow selection", () => {
    const onBuild = vi.fn();
    render(<MineWorkflows {...defaultProps} onBuild={onBuild} />);
    const card = cardFor("Deploy workflow");
    fireEvent.click(within(card).getByRole("button", { name: /distill/i }));
    expect(onBuild).toHaveBeenCalledWith(
      [{ root: "/projects/alpha", keys: ["wf-a"] }],
      "Deploy workflow",
    );
  });

  it("Distill is a no-op while a build is already in flight", () => {
    const onBuild = vi.fn();
    render(<MineWorkflows {...defaultProps} onBuild={onBuild} building />);
    const card = cardFor("Deploy workflow");
    fireEvent.click(within(card).getByRole("button", { name: /distill/i }));
    expect(onBuild).not.toHaveBeenCalled();
    expect(screen.getByText(/building/i)).toBeTruthy();
  });

  it("renders the build result in an inline banner", () => {
    render(<MineWorkflows {...defaultProps} result={{ name: "my-gem", skills: ["deploy", "lint"] }} />);
    expect(screen.getByText(/built/i)).toBeTruthy();
    expect(screen.getByText("my-gem")).toBeTruthy();
    expect(screen.getByText(/2 skills/i)).toBeTruthy();
  });

  it("renders the build error in an inline banner", () => {
    render(<MineWorkflows {...defaultProps} error="boom" />);
    expect(screen.getByText("boom")).toBeTruthy();
  });

  it("clicking Run hygiene launches the project hygiene rubric shortcut for that card's root", () => {
    render(<MineWorkflows {...defaultProps} />);
    const card = cardFor("Deploy workflow");
    fireEvent.click(within(card).getByRole("button", { name: /run hygiene/i }));
    expect(consumePendingRubricRun()).toEqual({
      rubric: "context-hygiene", scope: "project", root: "/projects/alpha", autorun: true,
    });
  });

  // ── Open / detail expansion ─────────────────────────────────────────────────

  it("clicking Open fetches and renders workflow detail", async () => {
    const detail: WorkflowDetail = {
      key: "wf-a", name: "Deploy workflow",
      description: "Automates the deploy pipeline",
      triggers: ["push to main"], tools: ["gh", "docker"],
      mutating: true, steps: ["Build image", "Push to registry", "Deploy"], sessions: 7,
      confidence: "high", portable: true,
    };
    const spy = vi.spyOn(routes.scorecardWorkflowRoute, "call").mockResolvedValue(detail);

    render(<MineWorkflows {...defaultProps} />);
    const card = cardFor("Deploy workflow");
    fireEvent.click(within(card).getByRole("button", { name: /^open$/i }));

    await waitFor(() => {
      expect(screen.getByText("Automates the deploy pipeline")).toBeTruthy();
    });
    expect(screen.getByText(/push to main/i)).toBeTruthy();
    expect(screen.getByText(/gh, docker/i)).toBeTruthy();
    expect(screen.getByText("Build image")).toBeTruthy();
    expect(screen.getByText("from 7 sessions")).toBeTruthy();

    expect(spy).toHaveBeenCalledWith(
      expect.anything(),
      { query: { root: "/projects/alpha", key: "wf-a" } },
    );
    spy.mockRestore();
  });

  it("shows inline error when detail fetch fails", async () => {
    const spy = vi.spyOn(routes.scorecardWorkflowRoute, "call").mockRejectedValue(new Error("network error"));

    render(<MineWorkflows {...defaultProps} />);
    const card = cardFor("Deploy workflow");
    fireEvent.click(within(card).getByRole("button", { name: /^open$/i }));

    await waitFor(() => {
      expect(screen.getByText("network error")).toBeTruthy();
    });
    spy.mockRestore();
  });

  it("does not refetch detail on second Open", async () => {
    const detail: WorkflowDetail = {
      key: "wf-a", name: "Deploy workflow", description: "desc",
      triggers: [], tools: [], mutating: false, steps: [], sessions: 1,
      confidence: "high", portable: true,
    };
    const spy = vi.spyOn(routes.scorecardWorkflowRoute, "call").mockResolvedValue(detail);

    render(<MineWorkflows {...defaultProps} />);
    const card = cardFor("Deploy workflow");
    const openBtn = within(card).getByRole("button", { name: /^open$/i });

    fireEvent.click(openBtn);
    await waitFor(() => { expect(screen.getByText("desc")).toBeTruthy(); });

    // Collapse then re-expand
    fireEvent.click(openBtn);
    fireEvent.click(openBtn);

    expect(spy).toHaveBeenCalledTimes(1);
    spy.mockRestore();
  });

  // ── Share ────────────────────────────────────────────────────────────────

  describe("Share", () => {
    beforeEach(() => {
      vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(null);
      vi.spyOn(HTMLCanvasElement.prototype, "toBlob").mockImplementation(function (cb) { cb(new Blob()); });
      vi.stubGlobal("URL", { createObjectURL: vi.fn().mockReturnValue("blob:mock"), revokeObjectURL: vi.fn() });
      Object.defineProperty(navigator, "share", { value: undefined, configurable: true, writable: true });
      Object.defineProperty(navigator, "canShare", { value: undefined, configurable: true, writable: true });
    });

    afterEach(() => {
      vi.restoreAllMocks();
      vi.unstubAllGlobals();
    });

    it("clicking Share mints a gem link and shows ShareLinks", async () => {
      const detail: WorkflowDetail = {
        key: "wf-a", name: "Deploy workflow", description: "desc",
        triggers: [], tools: [], mutating: false, steps: [], sessions: 5,
        confidence: "high", portable: true,
      };
      const wfSpy = vi.spyOn(routes.scorecardWorkflowRoute, "call").mockResolvedValue(detail);
      const createGemShare = vi.fn(async () => ({ id: "g1", url: "https://agentgem.ai/share/g1" }));
      render(<MineWorkflows {...defaultProps} createGemShare={createGemShare} />);

      const card = cardFor("Deploy workflow");
      fireEvent.click(within(card).getByRole("button", { name: /^share$/i }));

      await waitFor(() => expect(createGemShare).toHaveBeenCalledWith(
        expect.objectContaining({ kind: "gem", name: "Deploy workflow", provenance: "Distilled from 5 sessions" }),
      ));
      // The share route call implies the card is now expanded, since ShareLinks renders
      // inside the detail slot.
      expect(await screen.findByRole("link", { name: "X" })).toBeTruthy();
      wfSpy.mockRestore();
    });

    it("sets an inline error when the share mint fails", async () => {
      const detail: WorkflowDetail = {
        key: "wf-a", name: "Deploy workflow", description: "desc",
        triggers: [], tools: [], mutating: false, steps: [], sessions: 1,
        confidence: "high", portable: true,
      };
      const wfSpy = vi.spyOn(routes.scorecardWorkflowRoute, "call").mockResolvedValue(detail);
      const createGemShare = vi.fn(async () => { throw new Error("mint failed"); });
      render(<MineWorkflows {...defaultProps} createGemShare={createGemShare} />);

      const card = cardFor("Deploy workflow");
      fireEvent.click(within(card).getByRole("button", { name: /^share$/i }));

      await waitFor(() => expect(screen.getByText("mint failed")).toBeTruthy());
      wfSpy.mockRestore();
    });
  });

  // ── Type/Maturity grouping + cross-source composition ─────────────────────

  const INVENTORY = [
    { key: "skills", label: "Skills", items: [{ name: "pdf-skill", invocations: 3, lastUsedMs: 10 }] },
  ];
  const MINIAPPS = [{ name: "wordle-clone", title: "Wordle Clone", genre: "puzzle" }];

  describe("Type/Maturity axes", () => {
    it("group=type shows Workflows/Skills/Miniapps group headers", () => {
      render(<MineWorkflows {...defaultProps} group="type" inventory={INVENTORY} miniapps={MINIAPPS} />);
      expect(screen.getByText("Workflows")).toBeTruthy();
      expect(screen.getByText("Skills")).toBeTruthy();
      expect(screen.getByText("Miniapps")).toBeTruthy();
    });

    it("group=maturity shows Raw/Distilled group headers", () => {
      render(<MineWorkflows {...defaultProps} group="maturity" inventory={INVENTORY} miniapps={MINIAPPS} />);
      expect(screen.getByText("Raw")).toBeTruthy();     // workflows
      expect(screen.getByText("Distilled")).toBeTruthy(); // skill + miniapp
    });

    it("does not render a gaps group under Type or Maturity", () => {
      render(<MineWorkflows {...defaultProps} group="type" />);
      expect(screen.queryByText("Gaps")).toBeNull();
      expect(screen.queryByText("missing tests")).toBeNull();
    });

    it("value grouping shows no filter chips", () => {
      render(<MineWorkflows {...defaultProps} group="value" inventory={INVENTORY} miniapps={MINIAPPS} />);
      expect(screen.queryByRole("group", { name: /filter by value/i })).toBeNull();
      expect(screen.queryByRole("button", { name: "Battle-tested" })).toBeNull();
    });

    it("type grouping shows filter chips, and Battle-tested filters the set", () => {
      render(<MineWorkflows {...defaultProps} group="type" inventory={INVENTORY} miniapps={MINIAPPS} />);
      expect(screen.getByRole("button", { name: "All" })).toBeTruthy();
      // Unfiltered: every value bucket is represented.
      expect(screen.getByText("Deploy workflow")).toBeTruthy();   // worth-sharing
      expect(screen.getByText("Release workflow")).toBeTruthy();  // battle-tested
      expect(screen.getByText("pdf-skill")).toBeTruthy();         // battle-tested (3 invocations)
      expect(screen.getByText("wordle-clone")).toBeTruthy();      // reusable, not published

      fireEvent.click(screen.getByRole("button", { name: "Battle-tested" }));

      expect(screen.getByText("Release workflow")).toBeTruthy();
      expect(screen.getByText("pdf-skill")).toBeTruthy();
      expect(screen.queryByText("Deploy workflow")).toBeNull();
      expect(screen.queryByText("wordle-clone")).toBeNull();
    });

    it("maturity grouping also shows filter chips", () => {
      render(<MineWorkflows {...defaultProps} group="maturity" inventory={INVENTORY} miniapps={MINIAPPS} />);
      expect(screen.getByRole("button", { name: "Worth sharing" })).toBeTruthy();
    });
  });

  // ── Non-workflow card actions ───────────────────────────────────────────────

  describe("Non-workflow card actions", () => {
    const ORIGINAL_HASH = window.location.hash;
    beforeEach(() => { window.location.hash = ""; });
    afterEach(() => { window.location.hash = ORIGINAL_HASH; });

    it("miniapp card shows a Play button; clicking it navigates to #/play", () => {
      render(<MineWorkflows {...defaultProps} group="type" inventory={[]} miniapps={MINIAPPS} />);
      const card = cardFor("wordle-clone");
      fireEvent.click(within(card).getByRole("button", { name: "Play" }));
      expect(window.location.hash).toBe("#/play");
    });

    it("skill card's Open button navigates to #/curate", () => {
      render(<MineWorkflows {...defaultProps} group="type" inventory={INVENTORY} miniapps={[]} />);
      const card = cardFor("pdf-skill");
      fireEvent.click(within(card).getByRole("button", { name: "Open" }));
      expect(window.location.hash).toBe("#/curate");
    });

    it("skill card's Run hygiene targets scope 'all' (no project root)", () => {
      render(<MineWorkflows {...defaultProps} group="type" inventory={INVENTORY} miniapps={[]} />);
      const card = cardFor("pdf-skill");
      fireEvent.click(within(card).getByRole("button", { name: /run hygiene/i }));
      expect(consumePendingRubricRun()).toEqual({
        rubric: "context-hygiene", scope: "all", autorun: true,
      });
    });
  });
});
