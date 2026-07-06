// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
// src/gem/__tests__/contextHygiene.test.ts
import { describe, it, expect } from "vitest";
import { contextCap, contextTokens } from "@agentgem/insight";
import type { TurnUsage } from "@agentgem/insight";

describe("contextCap", () => {
  it("returns 1M for a model id that signals a 1M window", () => {
    expect(contextCap("claude-opus-4-8[1m]")).toBe(1_000_000);
    expect(contextCap("claude-sonnet-5-1m")).toBe(1_000_000);
  });
  it("defaults to 200k for a normal model id or when unknown", () => {
    expect(contextCap("claude-sonnet-5")).toBe(200_000);
    expect(contextCap(undefined)).toBe(200_000);
    expect(contextCap("")).toBe(200_000);
  });
});

describe("contextTokens", () => {
  it("sums input + cache_read + cache_creation", () => {
    expect(contextTokens({ input_tokens: 100, cache_read_input_tokens: 900_000, cache_creation_input_tokens: 5000 }))
      .toBe(905_100);
  });
  it("is 0 when usage is absent or empty", () => {
    expect(contextTokens(undefined)).toBe(0);
    expect(contextTokens({})).toBe(0);
  });
  it("TurnUsage is constructible (type smoke)", () => {
    const t: TurnUsage = { turn: 0, msgIndex: 4, ctxTokens: 905_100, cacheCreation: 5000, outTokens: 42 };
    expect(t.ctxTokens).toBe(905_100);
  });
});
