import { describe, it, expect } from "vitest";
import { buildTimeline } from "./ctxTimeline.js";

const curve = [
  { turn: 0, msgIndex: 1, ctxTokens: 1000, cacheCreation: 500, outTokens: 10 },
  { turn: 1, msgIndex: 4, ctxTokens: 5000, cacheCreation: 4000, outTokens: 20 },
  { turn: 2, msgIndex: 7, ctxTokens: 5200, cacheCreation: 100, outTokens: 5 },
];
const events = [{ msgIndex: 4, kind: "skill" as const, name: "review" }];

describe("buildTimeline", () => {
  it("ranks jumps by delta and attributes the skill cause", () => {
    const m = buildTimeline(curve, events, 1_000_000);
    expect(m.n).toBe(3);
    expect(m.jumps[0]).toMatchObject({ turn: 1, delta: 4000, category: "skill" });
    expect(m.jumps[0].cause).toMatch(/review/);
  });
  it("places a marker at the skill's turn position", () => {
    const m = buildTimeline(curve, events, 1_000_000);
    expect(m.markers).toEqual([{ x: 0.5, kind: "skill", name: "review" }]);
  });
  it("returns an empty model for a curve shorter than 2", () => {
    expect(buildTimeline([curve[0]], [], 1000).jumps).toEqual([]);
  });
});
