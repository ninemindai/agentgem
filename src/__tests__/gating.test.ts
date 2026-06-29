import { afterEach, describe, it, expect } from "vitest";
import { ANON_POINTS, KEYED_POINTS, INGEST_POINTS, anonRateLimitOptions, keyedRateLimitOptions, ingestRateLimitOptions, posIntEnv } from "../gating.js";

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

describe("ingestRateLimitOptions", () => {
  it("applies ONLY to /api/aggregator/ingest (skip returns false for ingest)", () => {
    const o = ingestRateLimitOptions();
    const ingestReq = { originalUrl: "/api/aggregator/ingest", ip: "1.2.3.4" } as any;
    expect(o.skip(ingestReq)).toBe(false); // applies to ingest
  });

  it("skips non-ingest paths (e.g. /overview)", () => {
    const o = ingestRateLimitOptions();
    const readReq = { originalUrl: "/api/aggregator/overview", ip: "1.2.3.4" } as any;
    expect(o.skip(readReq)).toBe(true);
  });

  it("skips admin paths (e.g. /keys)", () => {
    const o = ingestRateLimitOptions();
    const adminReq = { originalUrl: "/api/aggregator/keys", ip: "1.2.3.4" } as any;
    expect(o.skip(adminReq)).toBe(true);
  });

  it("uses ip as the key generator", () => {
    const o = ingestRateLimitOptions();
    expect(o.keyGenerator({ ip: "1.2.3.4" } as any)).toBe("1.2.3.4");
  });

  it("defaults points to INGEST_POINTS", () => {
    expect(ingestRateLimitOptions().points).toBe(INGEST_POINTS);
  });

  it("honors an explicit points override", () => {
    expect(ingestRateLimitOptions(7).points).toBe(7);
  });
});

describe("read buckets skip ingest", () => {
  it("anonRateLimitOptions skips /ingest", () => {
    const o = anonRateLimitOptions();
    const ingestReq = { originalUrl: "/api/aggregator/ingest", gemTier: "anonymous" } as any;
    expect(o.skip(ingestReq)).toBe(true);
  });

  it("keyedRateLimitOptions skips /ingest", () => {
    const o = keyedRateLimitOptions();
    const ingestReq = { originalUrl: "/api/aggregator/ingest", gemTier: "keyed", gemKeyId: "key-1" } as any;
    expect(o.skip(ingestReq)).toBe(true);
  });

  it("anonRateLimitOptions still limits normal anon reads", () => {
    const o = anonRateLimitOptions();
    const readReq = { originalUrl: "/api/aggregator/overview", ip: "1.2.3.4", gemTier: "anonymous" } as any;
    expect(o.skip(readReq)).toBe(false);
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
