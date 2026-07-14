// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
import { describe, it, expect } from "vitest";
import { wilsonLowerBound, outcomeScore, outcomeCredit, PARTIAL_CREDIT } from "../outcomeScore.js";

describe("wilsonLowerBound", () => {
  it("returns 0 for n = 0 (never NaN)", () => {
    expect(wilsonLowerBound(0, 0)).toBe(0);
  });
  it("shrinks small samples: 2/2 scores below 40/45", () => {
    const small = wilsonLowerBound(2, 2);   // naive 1.0
    const big = wilsonLowerBound(40, 45);   // naive 0.89
    expect(small).toBeGreaterThan(0.3);
    expect(small).toBeLessThan(0.4);        // ~0.34
    expect(big).toBeGreaterThan(0.7);       // ~0.77
    expect(small).toBeLessThan(big);        // the inversion that matters
  });
});

describe("outcomeCredit", () => {
  it("maps outcomes to credit: mostly=1, partial=0.5, not=0", () => {
    expect(outcomeCredit("mostly_achieved")).toBe(1);
    expect(outcomeCredit("partially_achieved")).toBe(PARTIAL_CREDIT);
    expect(outcomeCredit("partially_achieved")).toBe(0.5);
    expect(outcomeCredit("not_achieved")).toBe(0);
  });
});

describe("outcomeScore", () => {
  it("returns 0 for an empty history", () => {
    expect(outcomeScore([])).toBe(0);
  });
  it("counts partial as half a success", () => {
    // one mostly + one partial = 1.5 successes over n=2
    const mixed = outcomeScore(["mostly_achieved", "partially_achieved"]);
    const oneOfTwo = outcomeScore(["mostly_achieved", "not_achieved"]);
    expect(mixed).toBeGreaterThan(oneOfTwo);
  });
  it("is monotonic: more successes at fixed n never lowers the score", () => {
    const a = outcomeScore(["mostly_achieved", "not_achieved", "not_achieved"]);
    const b = outcomeScore(["mostly_achieved", "mostly_achieved", "not_achieved"]);
    expect(b).toBeGreaterThanOrEqual(a);
  });
});
