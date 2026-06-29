import { describe, it, expect } from "vitest";
import { trophyLines } from "../trophy.js";
import type { Scorecard } from "../../../api/routes.js";

const sc: Scorecard = {
  breadth: 14, battleTested: 3, portable: 5, gaps: [], generatedAtMs: 0, degraded: false,
  projects: [{ root: "/secret/repo", label: "secret-repo", breadth: 14, battleTested: 3, portable: 5, topCandidates: [{ name: "deploy-flow", confidence: "high" }] }],
};

describe("trophyLines", () => {
  it("renders aggregate counts only", () => {
    const t = trophyLines(sc);
    expect(t.counts).toEqual(["14 reusable workflows", "3 battle-tested", "5 worth sharing"]);
    expect(t.title.toLowerCase()).toContain("goldmine");
  });
  it("never leaks project names, repo paths, or workflow names", () => {
    const blob = JSON.stringify(trophyLines(sc));
    expect(blob).not.toMatch(/secret|repo|deploy-flow/);
  });
});
