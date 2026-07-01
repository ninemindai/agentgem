// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
import { describe, it, expect } from "vitest";
import { getWarmStatus } from "../warm/orchestrator.js";

describe("warm status shape", () => {
  it("exposes running + last fields consumed by the /api/warm/status route", () => {
    const s = getWarmStatus();
    expect(s).toHaveProperty("running");
    expect(s).toHaveProperty("last");
    expect(typeof s.running).toBe("boolean");
  });
});
