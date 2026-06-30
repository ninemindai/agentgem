// src/transfer/__tests__/natsTtl.test.ts
// Pure unit test of the TTL conversion. Importing natsObjectStore does not open a
// connection, so this stays hermetic; the broker-side application of `ttl` is
// covered by the gated integration test.
import { describe, it, expect } from "vitest";
import { ttlNanos, DEFAULT_TTL_HOURS } from "@agentgem/transfer";

describe("ttlNanos", () => {
  it("converts hours to nanoseconds", () => {
    expect(ttlNanos(1)).toBe(3_600_000_000_000);
    expect(ttlNanos(24)).toBe(86_400_000_000_000);
  });
  it("treats non-positive as no expiry (0)", () => {
    expect(ttlNanos(0)).toBe(0);
    expect(ttlNanos(-5)).toBe(0);
  });
  it("default TTL is 24h and stays a safe integer", () => {
    expect(DEFAULT_TTL_HOURS).toBe(24);
    expect(Number.isSafeInteger(ttlNanos(DEFAULT_TTL_HOURS))).toBe(true);
  });
});
