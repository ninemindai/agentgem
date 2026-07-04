// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  validateRubric, loadRubrics, builtinRubrics, rubricGranularity, scopeAllowed,
  type Rubric,
} from "@agentgem/insight";

const HYGIENE: Rubric = {
  id: "hygiene", title: "Session hygiene", target: "overview", naturalScope: "project",
  factors: [{ factor: "retry-storm" }, { factor: "thrash-loop" }, { factor: "no-verify-finish" }],
};

describe("validateRubric", () => {
  it("accepts a well-formed cheap-factor rubric", () => {
    expect(validateRubric(HYGIENE)).toEqual(HYGIENE);
  });

  it("rejects bad id, empty factors, and bad naturalScope", () => {
    expect(validateRubric({ ...HYGIENE, id: "Bad Id" })).toBeNull();
    expect(validateRubric({ ...HYGIENE, factors: [] })).toBeNull();
    expect(validateRubric({ ...HYGIENE, naturalScope: "galaxy" })).toBeNull();
    expect(validateRubric({ ...HYGIENE, factors: [{ factor: "x", weight: -1 }] })).toBeNull();
  });

  it("rejects an inline criterion whose id collides with a reserved factor id (A2)", () => {
    const withColliding: Rubric = {
      ...HYGIENE, id: "collide",
      criteria: [{ id: "retry-storm", title: "t", question: "q?", advice: "a" }],
    };
    // "retry-storm" is a built-in detector id → reserved by default.
    expect(validateRubric(withColliding)).toBeNull();
  });

  it("rejects duplicate inline criterion ids within one rubric", () => {
    const dup: Rubric = {
      ...HYGIENE, id: "dup",
      criteria: [
        { id: "c1", title: "t", question: "q?", advice: "a" },
        { id: "c1", title: "t2", question: "q2?", advice: "a2" },
      ],
    };
    expect(validateRubric(dup)).toBeNull();
  });

  it("accepts a valid inline criterion and trims its fields", () => {
    const withCrit = validateRubric({
      ...HYGIENE, id: "crit",
      factors: [{ factor: "c1" }],
      criteria: [{ id: "c1", title: " Verify ", question: " did they verify? ", advice: " run tests ", granularity: "aggregate" }],
    });
    expect(withCrit?.criteria?.[0]).toMatchObject({ id: "c1", title: "Verify", question: "did they verify?", advice: "run tests", granularity: "aggregate" });
  });
});

describe("builtinRubrics + granularity", () => {
  it("ships hygiene wired to the three built-in detectors, session-granular", () => {
    const hygiene = builtinRubrics().find((r) => r.id === "hygiene");
    expect(hygiene?.factors.map((f) => f.factor)).toEqual(["retry-storm", "thrash-loop", "no-verify-finish"]);
    expect(rubricGranularity(hygiene!)).toBe("session");
  });

  it("an aggregate inline criterion makes the rubric aggregate", () => {
    const agg: Rubric = {
      id: "breadthish", title: "b", target: "overview",
      factors: [{ factor: "c1" }],
      criteria: [{ id: "c1", title: "t", question: "q?", advice: "a", granularity: "aggregate" }],
    };
    expect(rubricGranularity(agg)).toBe("aggregate");
    expect(scopeAllowed(agg, "session")).toBe(false);   // hard rule: no aggregate-only at session scope
    expect(scopeAllowed(agg, "project")).toBe(true);
    expect(scopeAllowed(HYGIENE, "session")).toBe(true);
  });
});

describe("loadRubrics", () => {
  const orig = process.env.AGENTGEM_HOME;
  let tmp: string | undefined;
  afterEach(() => {
    if (orig === undefined) delete process.env.AGENTGEM_HOME; else process.env.AGENTGEM_HOME = orig;
    if (tmp) { rmSync(tmp, { recursive: true, force: true }); tmp = undefined; }
  });

  it("returns [] when the rubrics dir does not exist", () => {
    tmp = mkdtempSync(join(tmpdir(), "rub-"));
    process.env.AGENTGEM_HOME = tmp;   // no .agentgem/rubrics inside
    expect(loadRubrics()).toEqual([]);
  });

  it("loads valid rubrics, skips bad JSON and builtin-id collisions", () => {
    tmp = mkdtempSync(join(tmpdir(), "rub-"));
    process.env.AGENTGEM_HOME = tmp;
    const dir = join(tmp, ".agentgem", "rubrics");
    mkdirSync(dir, { recursive: true });
    const custom = { id: "custom", title: "Custom", target: "overview", factors: [{ factor: "retry-storm" }] };
    writeFileSync(join(dir, "a-custom.json"), JSON.stringify(custom));
    writeFileSync(join(dir, "b-broken.json"), "{ not json");
    writeFileSync(join(dir, "c-collide.json"), JSON.stringify({ ...custom, id: "hygiene" }));  // collides with builtin
    const loaded = loadRubrics();
    expect(loaded.map((r) => r.id)).toEqual(["custom"]);   // broken skipped, hygiene-collision skipped
  });
});
