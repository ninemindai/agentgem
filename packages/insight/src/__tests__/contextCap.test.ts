// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
import { describe, it, expect } from "vitest";
import { contextCap } from "../contextCap.js";

describe("contextCap", () => {
  it("returns 200k for unknown models and no model", () => {
    expect(contextCap(undefined)).toBe(200_000);
    expect(contextCap("claude-haiku-4-5")).toBe(200_000);
    expect(contextCap("claude-haiku-4-5-20251001")).toBe(200_000);
    expect(contextCap("some-other-model")).toBe(200_000);
  });

  it("honors the explicit 1M opt-in markers", () => {
    expect(contextCap("claude-sonnet-4-5[1m]")).toBe(1_000_000);
    expect(contextCap("claude-sonnet-4-5-1m")).toBe(1_000_000);
  });

  it("returns 1M for families whose window is 1M by default", () => {
    // A real Fable transcript turn carries ctxTokens > 200k — the old 200k
    // default read every Fable session as pinned over the cap from turn one.
    expect(contextCap("claude-fable-5")).toBe(1_000_000);
    expect(contextCap("claude-mythos-5")).toBe(1_000_000);
    expect(contextCap("claude-opus-4-6")).toBe(1_000_000);
    expect(contextCap("claude-opus-4-7")).toBe(1_000_000);
    expect(contextCap("claude-opus-4-8")).toBe(1_000_000);
    expect(contextCap("claude-sonnet-4-6")).toBe(1_000_000);
    expect(contextCap("claude-sonnet-5")).toBe(1_000_000);
  });

  it("matches date-suffixed and provider-prefixed ids by family substring", () => {
    expect(contextCap("claude-opus-4-6-20260115")).toBe(1_000_000);
    expect(contextCap("anthropic.claude-fable-5")).toBe(1_000_000);
  });

  it("keeps pre-4.6 families on the 200k default without the marker", () => {
    expect(contextCap("claude-sonnet-4-5")).toBe(200_000);
    expect(contextCap("claude-opus-4-5")).toBe(200_000);
  });
});
