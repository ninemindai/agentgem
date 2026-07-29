import { describe, it, expect } from "vitest";
import { engagedMsFromTimestamps, ENGAGED_GAP_CAP_MS } from "../observeAggregate.js";

const MIN = 60_000;

describe("engagedMsFromTimestamps", () => {
  it("returns 0 for empty or single-element input", () => {
    expect(engagedMsFromTimestamps([])).toBe(0);
    expect(engagedMsFromTimestamps([1000])).toBe(0);
  });

  it("counts a small gap in full", () => {
    expect(engagedMsFromTimestamps([0, 30_000])).toBe(30_000); // 30s < cap
  });

  it("caps a gap larger than the threshold at the cap", () => {
    expect(engagedMsFromTimestamps([0, 3 * 60 * MIN])).toBe(ENGAGED_GAP_CAP_MS); // 3h idle -> 5min
  });

  it("sums a mix of small and capped gaps", () => {
    // gaps: 30s, 3h(->cap), 20s, 8min(->cap)
    const t = [0, 30_000, 30_000 + 3 * 60 * MIN, 30_000 + 3 * 60 * MIN + 20_000,
      30_000 + 3 * 60 * MIN + 20_000 + 8 * MIN];
    expect(engagedMsFromTimestamps(t)).toBe(30_000 + ENGAGED_GAP_CAP_MS + 20_000 + ENGAGED_GAP_CAP_MS);
  });

  it("is order-independent (sorts internally)", () => {
    expect(engagedMsFromTimestamps([30_000, 0, 60_000])).toBe(60_000); // gaps 30s + 30s
  });

  it("honors a custom cap", () => {
    expect(engagedMsFromTimestamps([0, 120_000], 60_000)).toBe(60_000); // 2min gap, 1min cap
  });
});
