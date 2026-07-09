import { describe, it, expect } from "vitest";
import { mapPool } from "../concurrency.js";

describe("mapPool", () => {
  it("preserves input order regardless of completion order", async () => {
    // Longest delay first → if order were completion-based, 0 would land last.
    const delays = [30, 5, 20, 1, 15];
    const out = await mapPool(delays, 3, async (d, i) => {
      await new Promise((r) => setTimeout(r, d));
      return i;
    });
    expect(out).toEqual([0, 1, 2, 3, 4]);
  });

  it("never runs more than `limit` tasks at once, but does parallelize", async () => {
    let active = 0;
    let peak = 0;
    await mapPool(Array.from({ length: 12 }, (_, i) => i), 4, async () => {
      active++;
      peak = Math.max(peak, active);
      await new Promise((r) => setTimeout(r, 5));
      active--;
    });
    expect(peak).toBeLessThanOrEqual(4);
    expect(peak).toBeGreaterThan(1);
  });

  it("handles empty input without spawning work", async () => {
    let calls = 0;
    const out = await mapPool([], 4, async () => { calls++; return 1; });
    expect(out).toEqual([]);
    expect(calls).toBe(0);
  });

  it("clamps concurrency to item count", async () => {
    const out = await mapPool([1, 2], 100, async (n) => n * 2);
    expect(out).toEqual([2, 4]);
  });
});
