// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
import { describe, it, expect } from "vitest";
import { computeGemRubric, ORG_RUBRIC, type RubricInput } from "@agentgem/aggregator";

const base: RubricInput = {
  description: "a real gem", tags: ["frontend"], artifactKinds: ["skill"],
  grade: 2, publishedBy: "dev", stars: 1, installs: 0,
};

describe("computeGemRubric", () => {
  it("passes all five checks and scores 1 for a fully-formed gem", () => {
    const r = computeGemRubric(base);
    expect(r.checks).toHaveLength(5);
    expect(r.checks.every((c) => c.pass)).toBe(true);
    expect(r.score).toBe(1);
  });

  it("fails 'documented' with empty description or no tags", () => {
    expect(computeGemRubric({ ...base, description: "  " }).checks.find((c) => c.id === "documented")!.pass).toBe(false);
    expect(computeGemRubric({ ...base, tags: [] }).checks.find((c) => c.id === "documented")!.pass).toBe(false);
    expect(computeGemRubric({ ...base, tags: null }).checks.find((c) => c.id === "documented")!.pass).toBe(false);
  });

  it("fails 'substance' with no artifacts", () => {
    expect(computeGemRubric({ ...base, artifactKinds: [] }).checks.find((c) => c.id === "substance")!.pass).toBe(false);
    expect(computeGemRubric({ ...base, artifactKinds: null }).checks.find((c) => c.id === "substance")!.pass).toBe(false);
  });

  it("fails 'battleTested' below grade 2", () => {
    expect(computeGemRubric({ ...base, grade: 1 }).checks.find((c) => c.id === "battleTested")!.pass).toBe(false);
    expect(computeGemRubric({ ...base, grade: null }).checks.find((c) => c.id === "battleTested")!.pass).toBe(false);
  });

  it("passes 'adopted' on stars OR installs, fails when both zero", () => {
    expect(computeGemRubric({ ...base, stars: 0, installs: 5 }).checks.find((c) => c.id === "adopted")!.pass).toBe(true);
    expect(computeGemRubric({ ...base, stars: 0, installs: 0 }).checks.find((c) => c.id === "adopted")!.pass).toBe(false);
  });

  it("fails 'attributed' with no publisher", () => {
    expect(computeGemRubric({ ...base, publishedBy: null }).checks.find((c) => c.id === "attributed")!.pass).toBe(false);
  });

  it("score is fraction of passing checks", () => {
    // documented fails, other 4 pass → 4/5
    expect(computeGemRubric({ ...base, tags: [] }).score).toBeCloseTo(0.8, 5);
  });

  it("ORG_RUBRIC and every check carry a non-empty howToFix", () => {
    expect(ORG_RUBRIC).toHaveLength(5);
    for (const c of computeGemRubric({ ...base, tags: [], artifactKinds: [], grade: 1, stars: 0, installs: 0, publishedBy: null }).checks) {
      expect(c.howToFix.length).toBeGreaterThan(0);
    }
  });
});
