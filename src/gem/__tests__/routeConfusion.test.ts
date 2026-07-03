// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
import { describe, it, expect } from "vitest";
import { scoreRouteConfusion, type RouteJudge } from "@agentgem/build";
import type { TriggerContract } from "@agentgem/model";

const own = {
  name: "distill",
  contract: {
    intent: "distill a session into a skill",
    triggers: ["save this workflow", "repeated steps"],
    antiTriggers: ["one-off command"],
  } as TriggerContract,
};
const sibling = {
  name: "runGem",
  contract: { intent: "run a gem", triggers: ["execute the gem"], antiTriggers: [] } as TriggerContract,
};

describe("scoreRouteConfusion", () => {
  it("perfect routing scores 1 with no findings", () => {
    // judge routes every own-trigger to `distill` and the anti-trigger elsewhere
    const judge: RouteJudge = (phrase) => (phrase === "one-off command" ? "runGem" : "distill");
    const r = scoreRouteConfusion(own, [sibling], judge);
    expect(r.score).toBe(1);
    expect(r.findings).toHaveLength(0);
  });

  it("a mis-routed trigger lowers precision and is reported", () => {
    const judge: RouteJudge = (phrase) =>
      phrase === "repeated steps" ? "runGem" : phrase === "one-off command" ? "runGem" : "distill";
    const r = scoreRouteConfusion(own, [sibling], judge);
    // precision = 1/2, collisionRate = 0 -> score 0.5
    expect(r.score).toBeCloseTo(0.5);
    expect(r.findings.some((f) => f.title.includes("repeated steps"))).toBe(true);
  });

  it("an anti-trigger that wrongly fires raises collision rate", () => {
    const judge: RouteJudge = () => "distill"; // everything routes to own, incl. the anti-trigger
    const r = scoreRouteConfusion(own, [sibling], judge);
    // precision = 2/2 = 1, collisionRate = 1/1 = 1 -> score clamped to 0
    expect(r.score).toBe(0);
    expect(r.findings.some((f) => f.title.includes("one-off command"))).toBe(true);
  });
});
