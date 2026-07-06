// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
// src/gem/__tests__/contextHygiene.test.ts
import { describe, it, expect } from "vitest";
import { contextCap } from "@agentgem/insight";

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
