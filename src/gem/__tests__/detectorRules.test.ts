// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
// src/gem/__tests__/detectorRules.test.ts
import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { validateRule, compileRule, loadRuleDetectors } from "@agentgem/insight";
import type { ProcedureStep, SessionSequence, WorkflowSignal } from "@agentgem/insight";

function step(tool: string, verb: string, arg: string, msgIndex: number): ProcedureStep {
  return { tool, verb, arg, msgIndex };
}
function sess(steps: ProcedureStep[]): SessionSequence {
  return { steps, sessionId: "s1", transcript: "s1.jsonl", atMs: 100 };
}
function signalWith(sessions: SessionSequence[]): WorkflowSignal {
  return {
    root: "/r", flavor: "claude",
    sessions: { scanned: sessions.length, firstMs: 0, lastMs: 0, spanDays: 0 },
    models: [], artifacts: [], unresolved: [], coOccurrence: [], shapes: [], notes: [],
    sequences: { root: "/r", sessions },
  };
}

const RULE = { id: "force-push", title: "Force push", advice: "Prefer a clean rebase.", pattern: ["Bash:git"], minRepeats: 2 };

describe("validateRule", () => {
  it("accepts a well-formed rule and defaults optionals", () => {
    const r = validateRule({ id: "my-rule", title: "T", advice: "A", pattern: ["Edit"] });
    expect(r).toEqual({ id: "my-rule", title: "T", advice: "A", severity: undefined, pattern: ["Edit"], minRepeats: undefined });
  });

  it("rejects bad ids, empty pattern, bad severity, bad minRepeats, non-objects", () => {
    expect(validateRule(null)).toBeNull();
    expect(validateRule({ id: "Bad Id!", title: "T", advice: "A", pattern: ["Edit"] })).toBeNull();
    expect(validateRule({ id: "x", title: "T", advice: "A", pattern: [] })).toBeNull();
    expect(validateRule({ id: "x", title: "T", advice: "A", pattern: ["Edit"], severity: "fatal" })).toBeNull();
    expect(validateRule({ id: "x", title: "T", advice: "A", pattern: ["Edit"], minRepeats: 0 })).toBeNull();
    expect(validateRule({ id: "x", title: "", advice: "A", pattern: ["Edit"] })).toBeNull();
  });
});

describe("compileRule", () => {
  it("fires once per session when non-overlapping matches reach minRepeats", () => {
    const spec = compileRule({ ...RULE, pattern: ["Edit", "Bash:npm"], minRepeats: 2 });
    const steps = [
      step("Edit", "Edit", "/a.ts", 1), step("Bash", "Bash:npm", "npm test", 2),
      step("Bash", "Bash:git", "git diff", 3),
      step("Edit", "Edit", "/a.ts", 4), step("Bash", "Bash:npm", "npm test", 5),
    ];
    const findings = spec.detect(sess(steps), signalWith([sess(steps)]));
    expect(findings).toHaveLength(1);
    expect(findings[0].detectorId).toBe("force-push");
    expect(findings[0].severity).toBe("info");               // default
    expect(findings[0].evidence.msgIndices).toEqual([1, 2, 4, 5]);
  });

  it("stays quiet below minRepeats", () => {
    const spec = compileRule({ ...RULE, pattern: ["Edit"], minRepeats: 3 });
    const steps = [step("Edit", "Edit", "/a.ts", 1), step("Edit", "Edit", "/b.ts", 2)];
    expect(spec.detect(sess(steps), signalWith([sess(steps)]))).toHaveLength(0);
  });
});

describe("loadRuleDetectors", () => {
  let dir: string | undefined;
  afterEach(() => { if (dir) { rmSync(dir, { recursive: true, force: true }); dir = undefined; } });

  it("returns [] when the directory does not exist", () => {
    expect(loadRuleDetectors("/nonexistent/detectors")).toEqual([]);
  });

  it("loads valid rules (single object and array files), skips bad JSON, bad rules, and built-in id collisions", () => {
    dir = mkdtempSync(join(tmpdir(), "det-rules-"));
    writeFileSync(join(dir, "a.json"), JSON.stringify(RULE));
    writeFileSync(join(dir, "b.json"), JSON.stringify([
      { id: "two", title: "T2", advice: "A2", pattern: ["Write"], severity: "warn" },
      { id: "retry-storm", title: "Collides with built-in", advice: "x", pattern: ["Edit"] },
      { id: "BAD ID", title: "x", advice: "x", pattern: ["Edit"] },
    ]));
    writeFileSync(join(dir, "c.json"), "{not json");
    writeFileSync(join(dir, "ignored.txt"), "not a rule file");

    const specs = loadRuleDetectors(dir);
    expect(specs.map((s) => s.id).sort()).toEqual(["force-push", "two"]);
    expect(specs.find((s) => s.id === "two")!.severity).toBe("warn");
    expect(specs.every((s) => s.cost === "cheap")).toBe(true);
  });

  it("skips duplicate rule ids across files (first wins)", () => {
    dir = mkdtempSync(join(tmpdir(), "det-rules2-"));
    writeFileSync(join(dir, "1.json"), JSON.stringify(RULE));
    writeFileSync(join(dir, "2.json"), JSON.stringify({ ...RULE, title: "Duplicate" }));
    const specs = loadRuleDetectors(dir);
    expect(specs).toHaveLength(1);
    expect(specs[0].title).toBe("Force push");
  });
});
