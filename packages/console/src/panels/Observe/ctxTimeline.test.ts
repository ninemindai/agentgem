import { describe, it, expect } from "vitest";
import { buildTimeline } from "./ctxTimeline.js";

const curve = [
  { turn: 0, msgIndex: 1, ctxTokens: 1000, cacheCreation: 500, outTokens: 10 },
  { turn: 1, msgIndex: 4, ctxTokens: 5000, cacheCreation: 4000, outTokens: 20 },
  { turn: 2, msgIndex: 7, ctxTokens: 5200, cacheCreation: 100, outTokens: 5 },
];
const events = [{ msgIndex: 4, kind: "skill" as const, name: "review" }];

describe("buildTimeline", () => {
  // NOTE: this fixture's event msgIndex (4) coincides exactly with a curve
  // point's msgIndex — the issuing turn IS a curve point here, so the jump
  // that follows it (turn 2, +200) is the one that carries the skill's actual
  // cost, not the bigger delta landing on the issuing turn itself (turn 1,
  // +4000, which has no skill-load cause and falls back to "model output").
  it("ranks jumps by delta and attributes the skill cause to the point after the issuing turn", () => {
    const m = buildTimeline(curve, events, 1_000_000);
    expect(m.n).toBe(3);
    expect(m.jumps[0]).toMatchObject({ turn: 1, delta: 4000, category: "other" });
    expect(m.jumps[0].cause).not.toMatch(/review/);
    expect(m.jumps[1]).toMatchObject({ turn: 2, delta: 200, category: "skill" });
    expect(m.jumps[1].cause).toMatch(/review/);
  });
  it("places a marker at the skill's turn position", () => {
    const m = buildTimeline(curve, events, 1_000_000);
    expect(m.markers).toEqual([{ x: 0.5, kind: "skill", name: "review" }]);
  });
  it("returns an empty model for a curve shorter than 2", () => {
    expect(buildTimeline([curve[0]], [], 1000).jumps).toEqual([]);
  });

  // Realistic spacing: the skill tool_use is issued at msgIndex 4 (a curve
  // point), but the token cost it triggers only realizes at the NEXT
  // usage-bearing point (msgIndex 7). The marker still sits at the issuing
  // turn; the jump attribution must land on the later point, not the issuing
  // one, even though the issuing turn also has a small positive delta.
  it("attributes a delayed skill-load jump to the next curve point, not the issuing turn", () => {
    const spacedCurve = [
      { turn: 0, msgIndex: 1, ctxTokens: 1000, cacheCreation: 500, outTokens: 10 },
      { turn: 1, msgIndex: 4, ctxTokens: 1050, cacheCreation: 50, outTokens: 5 },
      { turn: 2, msgIndex: 7, ctxTokens: 6000, cacheCreation: 100, outTokens: 20 },
    ];
    const spacedEvents = [{ msgIndex: 4, kind: "skill" as const, name: "review" }];
    const m = buildTimeline(spacedCurve, spacedEvents, 1_000_000);

    expect(m.jumps[0]).toMatchObject({ turn: 2, delta: 4950, category: "skill" });
    expect(m.jumps[0].cause).toMatch(/review/);

    const issuingTurnJump = m.jumps.find((j) => j.turn === 1);
    expect(issuingTurnJump).toMatchObject({ delta: 50, category: "other" });
    expect(issuingTurnJump?.cause).not.toMatch(/review/);
  });
});
