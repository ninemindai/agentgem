// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
import { describe, it, expect } from "vitest";
import { builtinRubrics, type Rubric, type RubricScope } from "@agentgem/insight";
import { rubricToken, resolveRubric, listRubrics, listRubricsWithMeta } from "../rubricCore.js";

const hygiene = builtinRubrics().find((r) => r.id === "hygiene")!;
const project: RubricScope = { kind: "project", root: "/p" };

describe("rubricToken (content-hash cache key, E2)", () => {
  it("is stable for identical inputs", () => {
    expect(rubricToken(project, [], hygiene)).toBe(rubricToken(project, [], hygiene));
  });

  it("changes when the rubric BODY changes, even with the same id (the A1/E2 fix)", () => {
    const edited: Rubric = { ...hygiene, factors: [{ factor: "retry-storm", weight: 2 }] };
    expect(rubricToken(project, [], edited)).not.toBe(rubricToken(project, [], hygiene));
  });

  it("changes with scope kind and with the session id", () => {
    const all: RubricScope = { kind: "all" };
    const sessA: RubricScope = { kind: "session", root: "/p", sessionId: "A" };
    const sessB: RubricScope = { kind: "session", root: "/p", sessionId: "B" };
    expect(rubricToken(all, [], hygiene)).not.toBe(rubricToken(project, [], hygiene));
    expect(rubricToken(sessA, [], hygiene)).not.toBe(rubricToken(sessB, [], hygiene));
  });
});

describe("resolveRubric / listRubrics", () => {
  it("resolves the built-in hygiene rubric and lists it", () => {
    expect(resolveRubric("hygiene")?.id).toBe("hygiene");
    expect(resolveRubric("nope")).toBeNull();
    expect(listRubrics().map((r) => r.id)).toContain("hygiene");
  });

  it("listRubricsWithMeta tags each rubric with builtin + granularity for the picker", () => {
    const meta = listRubricsWithMeta().find((r) => r.id === "hygiene")!;
    expect(meta.builtin).toBe(true);
    // hygiene is detector-based; every factor is session-granular, so it may run
    // at session scope — the signal the Rubrics page gates its session picker on.
    expect(meta.granularity).toBe("session");
  });
});
