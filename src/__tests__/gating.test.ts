import { afterEach, describe, it, expect } from "vitest";
import { ANON_POINTS, KEYED_POINTS, anonRateLimitOptions, keyedRateLimitOptions, posIntEnv } from "../gating.js";

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

  it("skips admin paths (originalUrl: /api/aggregator/keys)", () => {
    const o = anonRateLimitOptions();
    const adminKey = { originalUrl: "/api/aggregator/keys", gemTier: "anonymous" } as any;
    expect(o.skip(adminKey)).toBe(true);
  });

  it("skips admin paths (originalUrl: /api/aggregator/sweep)", () => {
    const o = anonRateLimitOptions();
    const adminSweep = { originalUrl: "/api/aggregator/sweep", gemTier: "anonymous" } as any;
    expect(o.skip(adminSweep)).toBe(true);
  });

  it("does NOT skip non-admin anon read paths", () => {
    const o = anonRateLimitOptions();
    const read = { originalUrl: "/api/aggregator/overview", ip: "1.2.3.4", gemTier: "anonymous" } as any;
    expect(o.skip(read)).toBe(false);
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

  it("skips admin paths (originalUrl: /api/aggregator/keys)", () => {
    const o = keyedRateLimitOptions();
    const adminKey = { originalUrl: "/api/aggregator/keys", gemTier: "anonymous" } as any;
    expect(o.skip(adminKey)).toBe(true);
  });

  it("skips admin paths (originalUrl: /api/aggregator/sweep)", () => {
    const o = keyedRateLimitOptions();
    const adminSweep = { originalUrl: "/api/aggregator/sweep", gemTier: "anonymous" } as any;
    expect(o.skip(adminSweep)).toBe(true);
  });
});

describe("posIntEnv", () => {
  afterEach(() => {
    delete process.env.AGG_ANON_POINTS;
  });

  it("returns the default for a non-numeric env value", () => {
    expect(posIntEnv("AGG_ANON_POINTS_TEST_NOTSET", 60)).toBe(60);
    process.env.AGG_ANON_POINTS = "notanumber";
    expect(posIntEnv("AGG_ANON_POINTS", 60)).toBe(60);
  });

  it("returns the default for zero or negative values", () => {
    expect(posIntEnv("AGG_ANON_POINTS_TEST_NOTSET", 60)).toBe(60);
  });

  it("returns the parsed value for a valid positive integer string", () => {
    process.env.AGG_ANON_POINTS = "120";
    expect(posIntEnv("AGG_ANON_POINTS", 60)).toBe(120);
  });
});
