// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
// src/gem/__tests__/sessionHygiene.test.ts
import { describe, it, expect } from "vitest";
import { HYGIENE_FACTOR_IDS, summariesForSpecs, DETECTORS } from "@agentgem/insight";

describe("HYGIENE_FACTOR_IDS", () => {
  it("is exactly the five context-hygiene detector ids", () => {
    expect([...HYGIENE_FACTOR_IDS].sort()).toEqual(
      ["cache-churn-late", "context-pinned", "reread-churn", "task-pingpong", "task-sprawl"]);
  });
});

describe("summariesForSpecs (now exported)", () => {
  it("returns one row per spec with count 0 when unfired", () => {
    const specs = DETECTORS.filter((d) => HYGIENE_FACTOR_IDS.has(d.id));
    const rows = summariesForSpecs(specs, []);
    expect(rows).toHaveLength(5);
    expect(rows.every((r) => r.count === 0)).toBe(true);
    expect(rows.map((r) => r.id).sort()).toEqual([...HYGIENE_FACTOR_IDS].sort());
  });
});
