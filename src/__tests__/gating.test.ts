import { describe, it, expect } from "vitest";
import { ANON_POINTS, KEYED_POINTS, anonRateLimitOptions, keyedRateLimitOptions } from "../gating.js";

const keyed = { ip: "1.2.3.4", gemTier: "keyed", gemKeyId: "key-1" } as any;
const anon = { ip: "1.2.3.4", gemTier: "anonymous" } as any;

describe("anonRateLimitOptions", () => {
  it("limits anonymous callers by IP and skips keyed ones", () => {
    const o = anonRateLimitOptions();
    expect(o.points).toBe(ANON_POINTS);
    expect(o.path).toBe("/api/aggregator");
    expect(o.skip(keyed)).toBe(true);   // keyed callers use the other bucket
    expect(o.skip(anon)).toBe(false);
    expect(o.keyGenerator(anon)).toBe("1.2.3.4");
  });
});

describe("keyedRateLimitOptions", () => {
  it("limits keyed callers by key id and skips anonymous ones", () => {
    const o = keyedRateLimitOptions();
    expect(o.points).toBe(KEYED_POINTS);
    expect(o.skip(anon)).toBe(true);
    expect(o.skip(keyed)).toBe(false);
    expect(o.keyGenerator(keyed)).toBe("key-1");
  });
  it("honors an explicit points override (for tuning)", () => {
    expect(keyedRateLimitOptions(5).points).toBe(5);
  });
});
