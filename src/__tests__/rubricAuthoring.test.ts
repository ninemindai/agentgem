// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { validateRubricInput, saveRubric, deleteRubric, resolveFactorKinds, resolveRubric } from "../rubricCore.js";
import { defaultRubricsDir, type Rubric } from "@agentgem/insight";

const orig = process.env.AGENTGEM_HOME;
let tmp: string | undefined;
afterEach(() => {
  if (orig === undefined) delete process.env.AGENTGEM_HOME; else process.env.AGENTGEM_HOME = orig;
  if (tmp) { rmSync(tmp, { recursive: true, force: true }); tmp = undefined; }
});
function useTmpHome() { tmp = mkdtempSync(join(tmpdir(), "rub-auth-")); process.env.AGENTGEM_HOME = tmp; }

const GOOD = { id: "my-lens", title: "My lens", target: "overview", naturalScope: "project", factors: [{ factor: "retry-storm" }] };

describe("validateRubricInput", () => {
  it("accepts a good rubric and classifies its factors", () => {
    const v = validateRubricInput(GOOD);
    expect(v.valid).toBe(true);
    expect(v.factors).toEqual([{ factor: "retry-storm", kind: "detector" }]);
    expect(v.unknownFactors).toEqual([]);
  });
  it("rejects a built-in id and structurally invalid input", () => {
    expect(validateRubricInput({ ...GOOD, id: "hygiene" }).valid).toBe(false);
    expect(validateRubricInput({ ...GOOD, id: "Bad Id" }).valid).toBe(false);
    expect(validateRubricInput({ ...GOOD, factors: [] }).valid).toBe(false);
  });
  it("is valid but flags unknown factors (skipped at run, not a hard error)", () => {
    const v = validateRubricInput({ ...GOOD, factors: [{ factor: "retry-storm" }, { factor: "not-a-real-factor" }] });
    expect(v.valid).toBe(true);
    expect(v.unknownFactors).toEqual(["not-a-real-factor"]);
  });
  it("classifies an inline criterion as kind 'criterion'", () => {
    const v = validateRubricInput({
      ...GOOD, id: "rigor", factors: [{ factor: "c1" }],
      criteria: [{ id: "c1", title: "Verified?", question: "did they?", advice: "verify" }],
    });
    expect(v.valid).toBe(true);
    expect(v.factors).toEqual([{ factor: "c1", kind: "criterion" }]);
  });
});

describe("saveRubric / deleteRubric round-trip", () => {
  it("writes a user rubric that resolveRubric then finds, and deletes it", () => {
    useTmpHome();
    const saved = saveRubric(GOOD);
    expect(saved.saved).toBe(true);
    expect(existsSync(join(defaultRubricsDir(), "my-lens.json"))).toBe(true);
    expect(resolveRubric("my-lens")?.title).toBe("My lens");

    const del = deleteRubric("my-lens");
    expect(del.deleted).toBe(true);
    expect(resolveRubric("my-lens")).toBeNull();
  });
  it("refuses to save over a built-in id and refuses to delete a built-in", () => {
    useTmpHome();
    expect(saveRubric({ ...GOOD, id: "hygiene" }).saved).toBe(false);
    expect(deleteRubric("hygiene").deleted).toBe(false);
    expect(deleteRubric("does-not-exist").deleted).toBe(false);
  });
});

describe("resolveFactorKinds", () => {
  it("labels detector, criterion, and unknown refs", () => {
    const r: Rubric = {
      id: "mix", title: "m", target: "overview",
      factors: [{ factor: "retry-storm" }, { factor: "c1" }, { factor: "ghost" }],
      criteria: [{ id: "c1", title: "t", question: "q?", advice: "a" }],
    };
    expect(resolveFactorKinds(r)).toEqual([
      { factor: "retry-storm", kind: "detector" },
      { factor: "c1", kind: "criterion" },
      { factor: "ghost", kind: "unknown" },
    ]);
  });
});
