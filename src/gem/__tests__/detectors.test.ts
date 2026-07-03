// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
// src/gem/__tests__/detectors.test.ts
import { describe, it, expect } from "vitest";
import { DETECTORS, runDetectors, RETRY_STORM_MIN } from "@agentgem/insight";
import type { DetectorSpec, ProcedureStep, SessionSequence, WorkflowSignal } from "@agentgem/insight";

function step(tool: string, verb: string, arg: string, msgIndex: number): ProcedureStep {
  return { tool, verb, arg, msgIndex };
}
function sess(steps: ProcedureStep[], id = "s1"): SessionSequence {
  return { steps, sessionId: id, transcript: `${id}.jsonl`, atMs: 100 };
}
function signalWith(sessions: SessionSequence[]): WorkflowSignal {
  return {
    root: "/r", flavor: "claude",
    sessions: { scanned: sessions.length, firstMs: 0, lastMs: 0, spanDays: 0 },
    models: [], artifacts: [], unresolved: [], coOccurrence: [], shapes: [], notes: [],
    sequences: { root: "/r", sessions },
  };
}

describe("retry-storm detector", () => {
  it("fires when the same step repeats RETRY_STORM_MIN times back-to-back", () => {
    const steps = Array.from({ length: RETRY_STORM_MIN }, (_, i) =>
      step("Bash", "Bash:npm", "npm test", 10 + i));
    const findings = runDetectors(signalWith([sess(steps)]));
    const storm = findings.filter((f) => f.detectorId === "retry-storm");
    expect(storm).toHaveLength(1);
    expect(storm[0].sessionId).toBe("s1");
    expect(storm[0].severity).toBe("warn");
    expect(storm[0].evidence.msgIndices).toEqual([10, 11, 12]);
    expect(storm[0].detail).toContain("Bash:npm");
    expect(storm[0].detail).not.toContain("npm test"); // args never leak into detail
  });

  it("stays quiet below the threshold and when args differ", () => {
    const below = [step("Bash", "Bash:npm", "npm test", 1), step("Bash", "Bash:npm", "npm test", 2)];
    const differing = [
      step("Bash", "Bash:git", "git add a", 1),
      step("Bash", "Bash:git", "git add b", 2),
      step("Bash", "Bash:git", "git add c", 3),
    ];
    expect(runDetectors(signalWith([sess(below)]))
      .filter((f) => f.detectorId === "retry-storm")).toHaveLength(0);
    expect(runDetectors(signalWith([sess(differing)]))
      .filter((f) => f.detectorId === "retry-storm")).toHaveLength(0);
  });

  it("reports two separate storms in one session independently", () => {
    const steps = [
      ...Array.from({ length: 3 }, (_, i) => step("Bash", "Bash:npm", "npm test", i)),
      step("Edit", "Edit", "/f.ts", 3),
      ...Array.from({ length: 4 }, (_, i) => step("Bash", "Bash:cargo", "cargo build", 4 + i)),
    ];
    const storms = runDetectors(signalWith([sess(steps)])).filter((f) => f.detectorId === "retry-storm");
    expect(storms).toHaveLength(2);
    expect(storms[1].evidence.msgIndices).toEqual([4, 5, 6, 7]);
  });
});

describe("runDetectors", () => {
  it("returns [] when the signal has no sequences (retainSequences off)", () => {
    const sig = signalWith([]);
    delete sig.sequences;
    expect(runDetectors(sig)).toEqual([]);
  });

  it("survives a throwing detector and still returns other findings", () => {
    const bomb: DetectorSpec = {
      id: "bomb", title: "Bomb", cost: "cheap", severity: "info", advice: "n/a",
      detect() { throw new Error("boom"); },
    };
    const steps = Array.from({ length: 3 }, (_, i) => step("Bash", "Bash:npm", "npm test", i));
    const findings = runDetectors(signalWith([sess(steps)]), [bomb]);
    expect(findings.some((f) => f.detectorId === "retry-storm")).toBe(true);
  });

  it("every built-in has a non-empty id, title, and advice", () => {
    for (const d of DETECTORS) {
      expect(d.id).toMatch(/^[a-z0-9-]+$/);
      expect(d.title.length).toBeGreaterThan(0);
      expect(d.advice.length).toBeGreaterThan(0);
    }
  });
});
