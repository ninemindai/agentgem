import { describe, it, expect } from "vitest";
import { groupWorkflowsByValue } from "../groupWorkflows.js";
import type { Scorecard } from "../../../api/routes.js";

describe("groupWorkflowsByValue", () => {
  it("puts a portable workflow in worth-sharing, not battle-tested", () => {
    const scorecard: Scorecard = {
      breadth: 1, battleTested: 1, portable: 1, gaps: [], degraded: false, generatedAtMs: 0,
      projects: [
        {
          root: "/projects/alpha", label: "alpha",
          breadth: 1, battleTested: 1, portable: 1,
          workflows: [
            { key: "wf-a", name: "Deploy workflow", confidence: "high", portable: true, sessions: 5, lastSeenMs: 100 },
          ],
        },
      ],
    };
    const groups = groupWorkflowsByValue(scorecard);
    const worthSharing = groups.find((g) => g.key === "worth-sharing");
    const battleTested = groups.find((g) => g.key === "battle-tested");
    expect(worthSharing && "items" in worthSharing ? worthSharing.items.map((i) => i.key) : []).toEqual(["wf-a"]);
    expect(battleTested).toBeUndefined();
  });

  it("puts a high-confidence non-portable workflow in battle-tested", () => {
    const scorecard: Scorecard = {
      breadth: 1, battleTested: 1, portable: 0, gaps: [], degraded: false, generatedAtMs: 0,
      projects: [
        {
          root: "/projects/alpha", label: "alpha",
          breadth: 1, battleTested: 1, portable: 0,
          workflows: [
            { key: "wf-b", name: "Test workflow", confidence: "high", portable: false, sessions: 3, lastSeenMs: 200 },
          ],
        },
      ],
    };
    const groups = groupWorkflowsByValue(scorecard);
    const battleTested = groups.find((g) => g.key === "battle-tested");
    expect(battleTested && "items" in battleTested ? battleTested.items.map((i) => i.key) : []).toEqual(["wf-b"]);
    expect(groups.find((g) => g.key === "worth-sharing")).toBeUndefined();
  });

  it("puts medium and low confidence workflows in reusable", () => {
    const scorecard: Scorecard = {
      breadth: 2, battleTested: 0, portable: 0, gaps: [], degraded: false, generatedAtMs: 0,
      projects: [
        {
          root: "/projects/alpha", label: "alpha",
          breadth: 2, battleTested: 0, portable: 0,
          workflows: [
            { key: "wf-c", name: "Lint workflow", confidence: "medium", portable: false, sessions: 1, lastSeenMs: 10 },
            { key: "wf-d", name: "Format workflow", confidence: "low", portable: false, sessions: 1, lastSeenMs: 20 },
          ],
        },
      ],
    };
    const groups = groupWorkflowsByValue(scorecard);
    const reusable = groups.find((g) => g.key === "reusable");
    expect(reusable && "items" in reusable ? reusable.items.map((i) => i.key) : []).toEqual(["wf-c", "wf-d"]);
  });

  it("carries projectLabel and root from the owning project onto each card", () => {
    const scorecard: Scorecard = {
      breadth: 1, battleTested: 0, portable: 0, gaps: [], degraded: false, generatedAtMs: 0,
      projects: [
        {
          root: "/projects/alpha", label: "alpha-label",
          breadth: 1, battleTested: 0, portable: 0,
          workflows: [
            { key: "wf-e", name: "Some workflow", confidence: "low", portable: false, sessions: 1, lastSeenMs: 1 },
          ],
        },
      ],
    };
    const groups = groupWorkflowsByValue(scorecard);
    const reusable = groups.find((g) => g.key === "reusable");
    expect(reusable && "items" in reusable ? reusable.items[0] : undefined).toMatchObject({
      root: "/projects/alpha",
      projectLabel: "alpha-label",
      key: "wf-e",
      name: "Some workflow",
      confidence: "low",
      portable: false,
      sessions: 1,
      lastSeenMs: 1,
    });
  });

  it("flattens workflows from multiple projects into shared groups", () => {
    const scorecard: Scorecard = {
      breadth: 2, battleTested: 1, portable: 0, gaps: [], degraded: false, generatedAtMs: 0,
      projects: [
        {
          root: "/projects/alpha", label: "alpha",
          breadth: 1, battleTested: 1, portable: 0,
          workflows: [
            { key: "wf-a", name: "Alpha high", confidence: "high", portable: false, sessions: 1, lastSeenMs: 1 },
          ],
        },
        {
          root: "/projects/beta", label: "beta",
          breadth: 1, battleTested: 0, portable: 0,
          workflows: [
            { key: "wf-b", name: "Beta high", confidence: "high", portable: false, sessions: 1, lastSeenMs: 1 },
          ],
        },
      ],
    };
    const groups = groupWorkflowsByValue(scorecard);
    const battleTested = groups.find((g) => g.key === "battle-tested");
    expect(battleTested && "items" in battleTested ? battleTested.items.map((i) => i.key) : []).toEqual(["wf-a", "wf-b"]);
  });

  it("populates the gaps group from scorecard.gaps", () => {
    const scorecard: Scorecard = {
      breadth: 0, battleTested: 0, portable: 0, gaps: ["repeated manual deploys", "no test coverage"], degraded: false, generatedAtMs: 0,
      projects: [],
    };
    const groups = groupWorkflowsByValue(scorecard);
    const gaps = groups.find((g) => g.key === "gaps");
    expect(gaps && "gaps" in gaps ? gaps.gaps : []).toEqual(["repeated manual deploys", "no test coverage"]);
  });

  it("omits the gaps group when gaps is empty", () => {
    const scorecard: Scorecard = {
      breadth: 0, battleTested: 0, portable: 0, gaps: [], degraded: false, generatedAtMs: 0,
      projects: [],
    };
    const groups = groupWorkflowsByValue(scorecard);
    expect(groups.find((g) => g.key === "gaps")).toBeUndefined();
  });

  it("omits empty groups and returns groups in fixed display order", () => {
    const scorecard: Scorecard = {
      breadth: 3, battleTested: 1, portable: 1, gaps: ["a gap"], degraded: false, generatedAtMs: 0,
      projects: [
        {
          root: "/projects/alpha", label: "alpha",
          breadth: 3, battleTested: 1, portable: 1,
          workflows: [
            { key: "wf-a", name: "Portable one", confidence: "high", portable: true, sessions: 1, lastSeenMs: 1 },
            { key: "wf-b", name: "Battle tested one", confidence: "high", portable: false, sessions: 1, lastSeenMs: 1 },
            { key: "wf-c", name: "Reusable one", confidence: "medium", portable: false, sessions: 1, lastSeenMs: 1 },
          ],
        },
      ],
    };
    const groups = groupWorkflowsByValue(scorecard);
    expect(groups.map((g) => g.key)).toEqual(["battle-tested", "worth-sharing", "reusable", "gaps"]);
  });

  it("returns an empty array when there are no workflows and no gaps", () => {
    const scorecard: Scorecard = {
      breadth: 0, battleTested: 0, portable: 0, gaps: [], degraded: false, generatedAtMs: 0,
      projects: [],
    };
    expect(groupWorkflowsByValue(scorecard)).toEqual([]);
  });

  it("attaches correct labels and hints per group", () => {
    const scorecard: Scorecard = {
      breadth: 1, battleTested: 1, portable: 0, gaps: ["gap"], degraded: false, generatedAtMs: 0,
      projects: [
        {
          root: "/projects/alpha", label: "alpha",
          breadth: 1, battleTested: 1, portable: 0,
          workflows: [
            { key: "wf-a", name: "A", confidence: "high", portable: false, sessions: 1, lastSeenMs: 1 },
          ],
        },
      ],
    };
    const groups = groupWorkflowsByValue(scorecard);
    const battleTested = groups.find((g) => g.key === "battle-tested");
    expect(battleTested?.label).toBe("Battle-tested");
    expect(battleTested?.hint).toBe("proven across many sessions");
    const gaps = groups.find((g) => g.key === "gaps");
    expect(gaps?.label).toBe("Gaps");
    expect(gaps?.hint).toBe("recurring pain, not yet distilled");
  });
});
