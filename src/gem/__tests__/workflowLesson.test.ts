// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
// src/gem/__tests__/workflowLesson.test.ts
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { GemController } from "../../gem.controller.js";
import { useHermeticHome } from "../../__tests__/support/hermeticHome.js";

let restoreHome: () => void;
beforeAll(() => { restoreHome = useHermeticHome(); });
afterAll(() => restoreHome());

const lesson = (name: string) => ({ name, body: "Rebuild dist before vitest.", importance: "high" as const,
  status: "draft" as const, evidence: { sessions: 2, root: "/r", provenance: { occurrences: [] } } });

describe("POST /api/workflow/lesson", () => {
  it("writes the lesson under the (hermetic) home and returns its path", async () => {
    const c = new GemController();
    const { path } = await c.writeWorkflowLesson({ body: lesson("rebuild-dist-before-vitest") });
    expect(path.endsWith("/.agentgem/distilled/lessons/rebuild-dist-before-vitest.md")).toBe(true);
    expect(existsSync(path)).toBe(true);
    expect(readFileSync(path, "utf8")).toContain("Rebuild dist before vitest");
  });
  it("rejects a non-kebab name", async () => {
    const c = new GemController();
    await expect(c.writeWorkflowLesson({ body: lesson("Bad Name!") })).rejects.toThrow(/invalid lesson name/);
  });
});
