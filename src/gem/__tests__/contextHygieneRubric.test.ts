// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
// src/gem/__tests__/contextHygieneRubric.test.ts
import { describe, it, expect } from "vitest";
import { builtinRubrics, scopeAllowed, HYGIENE_FACTOR_IDS } from "@agentgem/insight";

describe("context-hygiene built-in rubric", () => {
  const rubric = () => builtinRubrics().find((r) => r.id === "context-hygiene")!;

  it("exists, is distinct from the 'hygiene' rubric, and references exactly the five hygiene factors", () => {
    const r = rubric();
    expect(r).toBeDefined();
    expect(r.id).not.toBe("hygiene");
    const factorIds = r.factors.map((f) => f.factor).sort();
    expect(factorIds).toEqual([...HYGIENE_FACTOR_IDS].sort());
  });

  it("is runnable at scope 'all' and 'project' (session-granular, all cheap)", () => {
    const r = rubric();
    expect(scopeAllowed(r, "all")).toBe(true);
    expect(scopeAllowed(r, "project")).toBe(true);
    expect(r.naturalScope).toBe("all");
  });

  it("leaves the pre-existing 'hygiene' rubric untouched (process-quality factors)", () => {
    const legacy = builtinRubrics().find((r) => r.id === "hygiene")!;
    expect(legacy.factors.map((f) => f.factor)).toContain("retry-storm");
    expect(legacy.factors.map((f) => f.factor)).not.toContain("context-pinned");
  });
});
