// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
import { describe, it, expect } from "vitest";
import { signState, verifyState } from "../auth/state.js";

const SECRET = "test-secret";
describe("auth state (HMAC + TTL)", () => {
  it("round-trips returnTo and verifies within the TTL", () => {
    const s = signState({ returnTo: "https://explore.agentgem.ai/gems" }, SECRET, 1000);
    expect(verifyState(s, SECRET, 1500, 60_000)).toEqual({ returnTo: "https://explore.agentgem.ai/gems" });
  });
  it("rejects a tampered state", () => {
    const s = signState({ returnTo: "https://explore.agentgem.ai" }, SECRET, 1000);
    expect(verifyState(s + "x", SECRET, 1500, 60_000)).toBeNull();
  });
  it("rejects a wrong secret", () => {
    const s = signState({ returnTo: "https://explore.agentgem.ai" }, SECRET, 1000);
    expect(verifyState(s, "other", 1500, 60_000)).toBeNull();
  });
  it("rejects an expired state", () => {
    const s = signState({ returnTo: "https://explore.agentgem.ai" }, SECRET, 1000);
    expect(verifyState(s, SECRET, 1000 + 70_000, 60_000)).toBeNull();
  });
  it("rejects a state issued in the future (clock skew / replay guard)", () => {
    const s = signState({ returnTo: "https://explore.agentgem.ai" }, SECRET, 10_000);
    expect(verifyState(s, SECRET, 5_000, 60_000)).toBeNull(); // now < iat
  });
});
