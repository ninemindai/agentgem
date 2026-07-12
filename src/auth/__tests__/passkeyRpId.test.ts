// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
import { describe, it, expect } from "vitest";
import { deriveRpId } from "../passkeyRpId.js";

describe("deriveRpId", () => {
  it("prefers an explicit RP ID", () => {
    expect(deriveRpId("passkeys.agentgem.ai", ".agentgem.ai")).toBe("passkeys.agentgem.ai");
  });
  it("derives from the cookie domain, stripping a leading dot", () => {
    expect(deriveRpId(undefined, ".agentgem.ai")).toBe("agentgem.ai");
    expect(deriveRpId(undefined, "agentgem.ai")).toBe("agentgem.ai");
  });
  it("falls back to localhost when nothing is configured", () => {
    expect(deriveRpId(undefined, undefined)).toBe("localhost");
    expect(deriveRpId(undefined, "")).toBe("localhost");
  });
});
