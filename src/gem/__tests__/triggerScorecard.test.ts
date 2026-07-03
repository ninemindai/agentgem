// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
import { describe, it, expect } from "vitest";
import { triggerScorecard } from "@agentgem/build";
import { scorecardFloor } from "@agentgem/model";

const gem = {
  name: "g", createdFrom: "t",
  artifacts: [
    { type: "skill", name: "s", source: "x", content: "abcde", // 5 chars
      trigger: { intent: "i", triggers: ["t"], antiTriggers: [] } },
  ],
  checks: [], requiredSecrets: [],
} as any;

const report = {
  gemName: "g", createdFrom: "t", passed: true,
  results: [
    { checkName: "route-confusion", kind: "external", passed: true, runner: "route-confusion",
      score: 0.4, findings: [{ severity: "warn", title: "trigger mis-routes: \"t\"" }], durationMs: 1 },
  ],
} as any;

describe("triggerScorecard", () => {
  it("projects precision, collisions and context budget from the report", () => {
    const sc = triggerScorecard(report, gem);
    expect(sc.routeScore).toBe(0.4);
    expect(sc.collisions).toEqual(["trigger mis-routes: \"t\""]);
    // content (5) + JSON of the trigger contract (> 0)
    expect(sc.contextBudgetChars).toBeGreaterThan(5);
  });

  it("routeScore is null when no route-confusion result is present", () => {
    const sc = triggerScorecard({ ...report, results: [] } as any, gem);
    expect(sc.routeScore).toBeNull();
  });

  it("advisory grade: low trigger precision caps the floor at the minimum", () => {
    const axes = { breadth: 5, battleTested: 1, portable: 1 }; // would floor at 3
    expect(scorecardFloor(axes)).toBe(3);
    expect(scorecardFloor({ ...axes, routeScore: 0.4 })).toBe(1);
    expect(scorecardFloor({ ...axes, routeScore: 0.9 })).toBe(3);
    expect(scorecardFloor({ ...axes, routeScore: 0.5 })).toBe(3); // boundary: < 0.5 only, 0.5 keeps the floor
  });
});
