// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
// Golden tests for the gemit scoring core: pure inputs → exact card payload.
import { describe, expect, it } from "vitest";
import {
  SKILL_VARIETY_CAP, SUBAGENT_VARIETY_CAP, varietyScore,
  computeGemitData, tierLevelFor, COMPOSITE_WEIGHTS, MIN_SESSIONS, SETUP_WEIGHTS,
  type GemitScoredInput, type GemitSessionInput,
} from "../gemit/score.js";

const NOW = Date.UTC(2026, 6, 18); // 2026-07-18
const DAY = 24 * 3600 * 1000;

function session(over: Partial<GemitSessionInput> = {}): GemitSessionInput {
  return {
    sessionId: "s-" + Math.abs(over.endMs ?? NOW).toString(36),
    agent: "claude",
    endMs: NOW - DAY,
    msgs: 20,
    tokensOut: 1000,
    skillNames: [],
    subagentNames: [],
    projectKey: "/p/one",
    ...over,
  };
}

function scoredOf(s: GemitSessionInput, over: Partial<GemitScoredInput> = {}): GemitScoredInput {
  return {
    session: s,
    hygieneScore: 100, hygieneVerdict: "bounded",
    processScore: 80, processLabel: "disciplined",
    findings: [], verifications: 1,
    ...over,
  };
}

describe("tierLevelFor", () => {
  it("maps boundary values to levels", () => {
    expect(tierLevelFor(49)).toBe(1);
    expect(tierLevelFor(50)).toBe(2);
    expect(tierLevelFor(64)).toBe(2);
    expect(tierLevelFor(65)).toBe(3);
    expect(tierLevelFor(79)).toBe(3);
    expect(tierLevelFor(80)).toBe(4);
  });
});

describe("session-share payload fields", () => {
  it("exposes skill/subagent session shares as rounded percents", () => {
    const qualifying = [
      session({ skillNames: ["a"], endMs: NOW - DAY }),
      session({ skillNames: ["b"], endMs: NOW - 2 * DAY }),
      session({ skillNames: ["a"], subagentNames: ["x"], endMs: NOW - 3 * DAY }),
      session({ endMs: NOW - 4 * DAY }),
      session({ endMs: NOW - 5 * DAY }),
      session({ endMs: NOW - 6 * DAY }),
    ];
    const d = computeGemitData(qualifying, [], NOW);
    expect(d.skillSessionsPct).toBe(50);    // 3 of 6
    expect(d.subagentSessionsPct).toBe(17); // 1 of 6, rounded
  });

  it("zeroes the shares on insufficient data", () => {
    const d = computeGemitData([session()], [], NOW);
    expect(d.insufficient).toBe(true);
    expect(d.skillSessionsPct).toBe(0);
    expect(d.subagentSessionsPct).toBe(0);
  });

  it("exports the weights the composite actually uses", () => {
    expect(COMPOSITE_WEIGHTS.ctx + COMPOSITE_WEIGHTS.proc + COMPOSITE_WEIGHTS.setup).toBeCloseTo(1);
    expect(SETUP_WEIGHTS.sessions + SETUP_WEIGHTS.subSessions + SETUP_WEIGHTS.variety + SETUP_WEIGHTS.subVariety).toBeCloseTo(1);
    const qualifying = Array.from({ length: 6 }, (_, i) => session({ skillNames: ["a"], endMs: NOW - (i + 1) * DAY }));
    const d = computeGemitData(qualifying, qualifying.map((s) => scoredOf(s)), NOW);
    expect(d.composite).toBe(Math.round(
      COMPOSITE_WEIGHTS.ctx * d.ctx + COMPOSITE_WEIGHTS.proc * d.proc + COMPOSITE_WEIGHTS.setup * d.setup));
  });
});


// SETUP's variety terms used to be `min(1, count / cap)` with caps of 10 skills and 5
// subagents. Linear is the wrong shape (3 -> 10 skills is a change in how you work; 30 -> 37
// is noise) and the caps were low enough that a real operator with 61 skills and 7 subagents
// pinned BOTH terms at 100%, so 30% of the score stopped saying anything.
describe("varietyScore", () => {
  it("rewards the first tools most and tapers after", () => {
    const first = varietyScore(2, SKILL_VARIETY_CAP) - varietyScore(1, SKILL_VARIETY_CAP);
    const later = varietyScore(21, SKILL_VARIETY_CAP) - varietyScore(20, SKILL_VARIETY_CAP);
    expect(first).toBeGreaterThan(later * 4);
  });

  it("no longer pins at the old caps, so breadth keeps discriminating", () => {
    expect(varietyScore(10, SKILL_VARIETY_CAP)).toBeLessThan(1);   // old formula: exactly 1
    expect(varietyScore(5, SUBAGENT_VARIETY_CAP)).toBeLessThan(1); // old formula: exactly 1
    expect(varietyScore(25, SKILL_VARIETY_CAP)).toBe(1);
    expect(varietyScore(61, SKILL_VARIETY_CAP)).toBe(1);           // bounded above
  });

  it("is monotonic and zero at zero", () => {
    expect(varietyScore(0, SKILL_VARIETY_CAP)).toBe(0);
    let prev = 0;
    for (const n of [1, 2, 3, 5, 8, 13, 21]) {
      const v = varietyScore(n, SKILL_VARIETY_CAP);
      expect(v).toBeGreaterThan(prev);
      prev = v;
    }
  });

  // Coverage is 70% of SETUP. Owning every tool and never reaching for one must still score
  // badly, or the metric rewards hoarding.
  it("cannot rescue a score when nothing is ever used", () => {
    const hoarder = computeGemitData(
      Array.from({ length: 10 }, (_, i) => session({ sessionId: `h${i}`, skillNames: [], subagentNames: [] })),
      [], NOW);
    expect(hoarder.setup).toBeLessThan(35);
  });
});

describe("computeGemitData", () => {
  it("returns insufficient below the session floor, without throwing", () => {
    const few = Array.from({ length: MIN_SESSIONS - 1 }, () => session());
    const data = computeGemitData(few, [], NOW);
    expect(data.insufficient).toBe(true);
    expect(data.composite).toBe(0);
    expect(data.tierLevel).toBe(1);
    expect(data.qualifyingSessions).toBe(MIN_SESSIONS - 1);
  });

  it("computes a hand-checked golden score over a synthetic set", () => {
    // 8 qualifying sessions, all at the same age (weight cancels out).
    // 4 use a skill, 2 use a subagent; varieties: 2 skills, 1 subagent.
    const qualifying = [
      session({ endMs: NOW - DAY, skillNames: ["a"], skillCounts: { a: 3 } }),
      session({ endMs: NOW - DAY, skillNames: ["a"] }),
      session({ endMs: NOW - DAY, skillNames: ["b"] }),
      session({ endMs: NOW - DAY, skillNames: ["b"] }),
      session({ endMs: NOW - DAY, subagentNames: ["x"] }),
      session({ endMs: NOW - DAY, subagentNames: ["x"] }),
      session({ endMs: NOW - DAY, projectKey: "/p/two" }),
      session({ endMs: NOW - DAY, projectKey: null }),
    ];
    // Scored: two hygiene 100/80 bounded/mixed, process 90/70.
    const scored = [
      scoredOf(qualifying[0], { hygieneScore: 100, hygieneVerdict: "bounded", processScore: 90 }),
      scoredOf(qualifying[1], { hygieneScore: 80, hygieneVerdict: "mixed", processScore: 70, processLabel: "loose", verifications: 0 }),
    ];
    const data = computeGemitData(qualifying, scored, NOW);
    expect(data.insufficient).toBe(false);
    expect(data.ctx).toBe(90);   // mean(100, 80) — equal weights
    expect(data.proc).toBe(80);  // mean(90, 70)
    // SETUP: coverage 0.45*(4/8) + 0.25*(2/8) = 0.2875, then variety on a log curve —
    // 0.15*(log1p(2)/log1p(25)) + 0.15*(log1p(1)/log1p(8)) = 0.0506 + 0.0473 = 0.0979.
    // Total 0.3854 → 39. Was 35 under the old linear `min(1, n/10)` and `min(1, n/5)`;
    // this profile has few tools, and the log curve is deliberately kinder at the low end.
    expect(data.setup).toBe(39);
    // composite: 0.4*90 + 0.4*80 + 0.2*39 = 75.8 → 76, still tier 3. Moves with SETUP by
    // design: composite is a weighted mean, so rescoring a term rescores the whole.
    expect(data.composite).toBe(76);
    expect(data.tierLevel).toBe(3);
    expect(data.projects).toBe(2);
    expect(data.verdicts).toEqual({ bounded: 1, mixed: 1, bloated: 0 });
    expect(data.labels).toEqual({ disciplined: 1, loose: 1, chaotic: 0 });
    expect(data.verifyRatePct).toBe(50);
    expect(data.topSkills[0]).toBe("a"); // 3+1 invocations beats b's 2
  });

  it("drops count:0 findings and counts fired ones per session", () => {
    const q = Array.from({ length: 6 }, () => session());
    const scored = [
      scoredOf(q[0], { findings: [
        { id: "task-sprawl", title: "Sprawl", count: 0 },
        { id: "retry-storm", title: "Retry storm", count: 3 },
      ] }),
      scoredOf(q[1], { findings: [
        { id: "retry-storm", title: "Retry storm", count: 1 },
        { id: "retry-storm", title: "Retry storm", count: 2 }, // same session dedup
      ] }),
    ];
    const data = computeGemitData(q, scored, NOW);
    expect(data.firedFindings).toEqual([{ id: "retry-storm", title: "Retry storm", sessions: 2 }]);
  });

  // Counts SESSIONS per agent over the qualifying window, busiest first. Ties break by
  // name so two runs over the same window produce byte-identical payloads.
  it("aggregates coding agents by session count, busiest first, ties by name", () => {
    const q = [
      session({ agent: "codex" }), session({ agent: "codex" }),
      session({ agent: "claude" }), session({ agent: "claude" }), session({ agent: "claude" }),
      session({ agent: "amp" }), session({ agent: "zed" }),
    ];
    const data = computeGemitData(q, [], NOW);
    expect(data.agents).toEqual([
      { name: "claude", sessions: 3 },
      { name: "codex", sessions: 2 },
      { name: "amp", sessions: 1 },   // tied at 1 with zed -> alphabetical
      { name: "zed", sessions: 1 },
    ]);
  });

  it("reports no agents on the insufficient-data doorway", () => {
    expect(computeGemitData([session(), session()], [], NOW).agents).toEqual([]);
  });

  it("keeps codex sessions in qualifying/SETUP but out of CTX/PROC", () => {
    const claude = session({ endMs: NOW - DAY });
    const codex = session({ agent: "codex", endMs: NOW - DAY, skillNames: [] });
    const q = [claude, codex, session(), session(), session(), session()];
    const scored = [
      scoredOf(claude, { hygieneScore: 60, hygieneVerdict: "mixed", processScore: 40, processLabel: "chaotic" }),
      scoredOf(codex, {
        hygieneScore: null, hygieneVerdict: null,
        processScore: null, processLabel: null, verifications: null,
      }),
    ];
    const data = computeGemitData(q, scored, NOW);
    expect(data.ctx).toBe(60);   // codex null did not dilute
    expect(data.proc).toBe(40);
    expect(data.verifyRatePct).toBe(100); // only the claude row has verifications
    expect(data.scoredSessions).toBe(2);  // but codex still counts as scored/disclosed
  });

  it("weights recent sessions more than old ones", () => {
    const recent = session({ endMs: NOW - DAY });
    const old = session({ endMs: NOW - 29 * DAY });
    const q = [recent, old, session(), session(), session()];
    const scored = [
      scoredOf(recent, { hygieneScore: 100 }),
      scoredOf(old, { hygieneScore: 0, hygieneVerdict: "bloated" }),
    ];
    const data = computeGemitData(q, scored, NOW);
    expect(data.ctx).toBeGreaterThan(50); // recent 100 outweighs old 0
  });

  it("never leaks project identities into the payload", () => {
    const q = Array.from({ length: 6 }, () => session({ projectKey: "/Users/secret/project-name" }));
    const json = JSON.stringify(computeGemitData(q, [scoredOf(q[0])], NOW));
    expect(json).not.toContain("secret");
    expect(json).not.toContain("project-name");
  });

  it("tracks the longest bounded streak chronologically", () => {
    const q = Array.from({ length: 6 }, (_, i) => session({ endMs: NOW - (6 - i) * DAY }));
    const scored = [
      scoredOf(q[0], { hygieneVerdict: "bounded" }),
      scoredOf(q[1], { hygieneVerdict: "bounded" }),
      scoredOf(q[2], { hygieneVerdict: "bloated", hygieneScore: 20 }),
      scoredOf(q[3], { hygieneVerdict: "bounded" }),
    ];
    expect(computeGemitData(q, scored, NOW).boundedStreak).toBe(2);
  });
});
