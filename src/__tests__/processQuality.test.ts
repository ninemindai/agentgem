// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
import { describe, it, expect } from "vitest";
import type { ProcedureStep, SessionSequence, WorkflowSignal } from "@agentgem/insight";
import { stageOf, stageProfile, runDetectors, REGRESSION_MIN } from "@agentgem/insight";
import { sessionProcessQuality, processQualityReport } from "@agentgem/insight";

let mi = 0;
const step = (verb: string, arg: string, tool = verb.startsWith("Bash:") ? "Bash" : verb): ProcedureStep =>
  ({ tool, verb, arg, msgIndex: mi++ });
const read = (f: string) => step("Read", f);
const edit = (f: string) => step("Edit", f);
const test_ = () => step("Bash:pnpm", "pnpm test");
const task = () => step("Task", "explore the codebase");
const session = (steps: ProcedureStep[], sessionId = "s1"): SessionSequence =>
  ({ steps, sessionId, transcript: "t.jsonl", atMs: 1000 });
const signalOf = (...sessions: SessionSequence[]): WorkflowSignal =>
  ({ sequences: { root: "/tmp/p", sessions } } as unknown as WorkflowSignal);

describe("stageLabels", () => {
  it("classifies steps into the four AgentLens intent stages", () => {
    expect(stageOf(read("src/a.ts"))).toBe("exploration");
    expect(stageOf(step("Grep", "foo"))).toBe("exploration");
    expect(stageOf(step("Bash:ls", "ls -la src"))).toBe("exploration");
    expect(stageOf(edit("src/a.ts"))).toBe("implementation");
    expect(stageOf(step("Write", "src/b.ts"))).toBe("implementation");
    expect(stageOf(test_())).toBe("verification");
    expect(stageOf(step("Bash:tsc", "tsc --noEmit"))).toBe("verification");
    expect(stageOf(task())).toBe("orchestration");
    expect(stageOf(step("Bash:curl", "curl example.com"))).toBe("other");
  });

  it("profiles a session's stage mix", () => {
    const p = stageProfile([read("a"), read("b"), edit("a"), test_(), task()]);
    expect(p).toEqual({ exploration: 2, implementation: 1, verification: 1, orchestration: 1, other: 0 });
  });
});

const byId = <T extends { detectorId: string }>(findings: T[], id: string) => findings.filter((f) => f.detectorId === id);

describe("regression-cycle", () => {
  it("fires when a completed file is reworked repeatedly", () => {
    const s = session([
      edit("src/a.ts"), test_(),            // a.ts completed
      edit("src/b.ts"), test_(),            // move on (b.ts completed)
      edit("src/a.ts"), test_(),            // rework 1
      edit("src/a.ts"), test_(),            // rework 2 → fires (REGRESSION_MIN = 2)
    ]);
    const found = byId(runDetectors(signalOf(s)), "regression-cycle");
    expect(found).toHaveLength(1);
    expect(found[0].detail).toContain("2x");
    expect(found[0].evidence.msgIndices.length).toBeGreaterThanOrEqual(REGRESSION_MIN);
  });

  it("does not fire for iterative work that never verified in between, or single rework", () => {
    // never completed → edits to a.ts are iteration, not regression
    const iterating = session([edit("a.ts"), edit("a.ts"), edit("a.ts"), test_()]);
    expect(byId(runDetectors(signalOf(iterating)), "regression-cycle")).toHaveLength(0);
    // one rework only → below threshold
    const once = session([edit("a.ts"), test_(), edit("a.ts"), test_()]);
    expect(byId(runDetectors(signalOf(once)), "regression-cycle")).toHaveLength(0);
  });
});

describe("unverified-tail", () => {
  it("fires when edits continue after the last verification", () => {
    const s = session([edit("a.ts"), test_(), edit("a.ts"), edit("b.ts")]);
    const found = byId(runDetectors(signalOf(s)), "unverified-tail");
    expect(found).toHaveLength(1);
    expect(found[0].detail).toContain("2 edit");
    expect(found[0].severity).toBe("info");
  });

  it("stays quiet when the session ends verified, or never verified at all", () => {
    const clean = session([edit("a.ts"), test_()]);
    expect(byId(runDetectors(signalOf(clean)), "unverified-tail")).toHaveLength(0);
    const neverVerified = session([edit("a.ts"), edit("b.ts")]);   // no-verify-finish's territory
    expect(byId(runDetectors(signalOf(neverVerified)), "unverified-tail")).toHaveLength(0);
  });
});

describe("processQuality", () => {
  it("scores a clean session as disciplined with a full stage profile", () => {
    const s = session([read("a.ts"), edit("a.ts"), test_()], "clean");
    const q = sessionProcessQuality(s, []);
    expect(q).toMatchObject({ sessionId: "clean", score: 100, label: "disciplined" });
    expect(q.stages).toMatchObject({ exploration: 1, implementation: 1, verification: 1 });
  });

  it("deducts per finding severity and floors at 0", () => {
    const s = session([edit("a.ts")], "messy");
    const finding = (severity: "warn" | "info") => ({
      detectorId: "x", sessionId: "messy", transcript: "t.jsonl", atMs: 0,
      severity, detail: "", evidence: { msgIndices: [] },
    });
    expect(sessionProcessQuality(s, [finding("warn")]).score).toBe(80);
    expect(sessionProcessQuality(s, [finding("warn"), finding("info")]).label).toBe("loose"); // 70
    expect(sessionProcessQuality(s, Array(8).fill(finding("warn"))).score).toBe(0);
    // findings for OTHER sessions do not count
    expect(sessionProcessQuality(s, [{ ...finding("warn"), sessionId: "other" }]).score).toBe(100);
  });

  it("reports across a signal end-to-end with real detectors", () => {
    const messy = session([
      edit("a.ts"), test_(), edit("b.ts"), test_(),
      edit("a.ts"), test_(), edit("a.ts"), test_(),  // regression-cycle (warn)
      edit("c.ts"),                                   // unverified-tail (info)
    ], "messy");
    const clean = session([read("a.ts"), edit("a.ts"), test_()], "clean");
    const signal = signalOf(messy, clean);
    const findings = runDetectors(signal);
    const report = processQualityReport(signal, findings);
    expect(report.sessions).toHaveLength(2);
    const byIdMap = Object.fromEntries(report.sessions.map((q) => [q.sessionId, q]));
    expect(byIdMap.clean.label).toBe("disciplined");
    // −20 regression-cycle (warn), −10 unverified-tail (info), −10 no-verify-finish
    // (info — the trailing edit is also never verified, so the pre-existing detector
    // fires too): 100 − 40 = 60.
    expect(byIdMap.messy.score).toBe(60);
    expect(byIdMap.messy.label).toBe("loose");
    expect(report.atRiskRate).toBe(0.5);
  });
});
