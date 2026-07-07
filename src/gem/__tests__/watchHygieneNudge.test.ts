// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
// src/gem/__tests__/watchHygieneNudge.test.ts
import { describe, it, expect } from "vitest";
import { nudgeTransition, buildTickEvents, CURVE_TAIL_MAX, type Verdict } from "../../watchHygieneNudge.js";
import type { HygieneReport } from "../../sessionHygieneCore.js";

describe("nudgeTransition", () => {
  const cases: Array<[Verdict | null, Verdict, "fire" | "silent"]> = [
    [null, "bounded", "silent"],
    [null, "mixed", "fire"],          // opens already heavy
    [null, "bloated", "fire"],
    ["bounded", "bounded", "silent"],
    ["bounded", "mixed", "fire"],
    ["bounded", "bloated", "fire"],
    ["mixed", "mixed", "silent"],     // no re-nag while heavy
    ["mixed", "bloated", "fire"],     // escalation
    ["mixed", "bounded", "silent"],   // dropped (a /clear)
    ["bloated", "bloated", "silent"],
    ["bloated", "mixed", "silent"],   // improving
    ["bloated", "bounded", "silent"], // re-armed, but the drop itself is silent
  ];
  it.each(cases)("prev=%s next=%s -> %s", (prev, next, want) => {
    expect(nudgeTransition(prev, next)).toBe(want);
  });
  it("re-arms: bloated -> bounded -> mixed fires again on the climb", () => {
    expect(nudgeTransition("bloated", "bounded")).toBe("silent");
    expect(nudgeTransition("bounded", "mixed")).toBe("fire");
  });
});

function report(verdict: Verdict, curveLen: number, firedAdvice?: string): HygieneReport {
  const curve = Array.from({ length: curveLen }, (_, i) => ({ turn: i, msgIndex: i, ctxTokens: 500_000, cacheCreation: 0, outTokens: 1 }));
  const factors = [
    { id: "context-pinned", title: "Window pinned at the context cap", advice: firedAdvice ?? "Cut earlier.", severity: "warn" as const, count: firedAdvice ? 1 : 0, sessions: firedAdvice ? 1 : 0 },
    { id: "task-sprawl", title: "Many tasks", advice: "Split them.", severity: "warn" as const, count: 0, sessions: 0 },
  ];
  return { meta: { sessionId: "s", transcript: "s.jsonl", model: "claude-opus-4-8[1m]", cap: 1_000_000 }, curve, factors, hygiene: { score: 40, verdict } };
}

describe("buildTickEvents", () => {
  it("always emits a hygiene snapshot with a downsampled curve tail and the cap", () => {
    const t = buildTickEvents("bounded", report("bounded", 300));
    expect(t.hygiene.verdict).toBe("bounded");
    expect(t.hygiene.cap).toBe(1_000_000);
    expect(t.hygiene.curveTail.length).toBe(CURVE_TAIL_MAX);     // 300 -> last 120
    expect(t.hygiene.curveTail.at(-1)!.turn).toBe(299);          // it's the TAIL
    expect(t.nudge).toBeUndefined();                             // no escalation
    expect(t.nextVerdict).toBe("bounded");
  });
  it("emits a nudge with the fired factor's advice on escalation", () => {
    const t = buildTickEvents("bounded", report("bloated", 10, "This session is heavy — take a clean break."));
    expect(t.nudge?.verdict).toBe("bloated");
    expect(t.nudge?.advice).toBe("This session is heavy — take a clean break.");
  });
  it("nudge falls back to a generic advice when no factor carries one", () => {
    const t = buildTickEvents(null, report("mixed", 5));   // no fired factor (all count 0)
    expect(t.nudge).toBeDefined();
    expect(t.nudge!.advice.length).toBeGreaterThan(0);
  });
  it("keeps the whole curve when shorter than the tail cap", () => {
    const t = buildTickEvents("bounded", report("bounded", 12));
    expect(t.hygiene.curveTail.length).toBe(12);
  });
});
