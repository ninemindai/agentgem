// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
// src/gem/__tests__/contextHygiene.test.ts
import { describe, it, expect } from "vitest";
import { contextCap, contextTokens, clusterOf, runDetectors, SPRAWL_MIN, SWITCH_MIN, REREAD_MIN, PIN_LEVEL, PIN_FRACTION, CHURN_RATIO, hygieneScore, assessesHygiene } from "@agentgem/insight";
import type { TurnUsage, ProcedureStep, SessionSequence, WorkflowSignal, DetectorSummary } from "@agentgem/insight";

describe("contextCap", () => {
  it("returns 1M for a model id that signals a 1M window", () => {
    expect(contextCap("claude-opus-4-8[1m]")).toBe(1_000_000);
    expect(contextCap("claude-sonnet-5-1m")).toBe(1_000_000);
  });
  it("defaults to 200k for a normal model id or when unknown", () => {
    expect(contextCap("claude-sonnet-5")).toBe(200_000);
    expect(contextCap(undefined)).toBe(200_000);
    expect(contextCap("")).toBe(200_000);
  });
});

describe("contextTokens", () => {
  it("sums input + cache_read + cache_creation", () => {
    expect(contextTokens({ input_tokens: 100, cache_read_input_tokens: 900_000, cache_creation_input_tokens: 5000 }))
      .toBe(905_100);
  });
  it("is 0 when usage is absent or empty", () => {
    expect(contextTokens(undefined)).toBe(0);
    expect(contextTokens({})).toBe(0);
  });
  it("TurnUsage is constructible (type smoke)", () => {
    const t: TurnUsage = { turn: 0, msgIndex: 4, ctxTokens: 905_100, cacheCreation: 5000, outTokens: 42 };
    expect(t.ctxTokens).toBe(905_100);
  });
});

describe("clusterOf", () => {
  it("buckets a packages/<x> path to pkg:<x>", () => {
    expect(clusterOf("packages/console/src/app.ts")).toBe("pkg:console");
    expect(clusterOf("/repo/packages/insight/src/x.ts")).toBe("pkg:insight");
  });
  it("buckets other paths to their first segment", () => {
    expect(clusterOf("src/gem/scorecard.ts")).toBe("dir:src");
    expect(clusterOf("docs/readme.md")).toBe("dir:docs");
  });
  it("does not match 'packages/' as a bare substring inside another segment", () => {
    expect(clusterOf("src/mypackages/x.ts")).toBe("dir:src");
  });
  it("returns null for non-path args and empties", () => {
    expect(clusterOf("npm test")).toBeNull();
    expect(clusterOf("")).toBeNull();
    expect(clusterOf(undefined)).toBeNull();
  });
});

function step(tool: string, verb: string, arg: string, msgIndex: number): ProcedureStep {
  return { tool, verb, arg, msgIndex };
}
function sess(steps: ProcedureStep[], series?: TurnUsage[], id = "s1"): SessionSequence {
  return { steps, sessionId: id, transcript: `${id}.jsonl`, atMs: 100, ...(series ? { contextSeries: series } : {}) };
}
function signalWith(sessions: SessionSequence[]): WorkflowSignal {
  return {
    root: "/r", flavor: "claude",
    sessions: { scanned: sessions.length, firstMs: 0, lastMs: 0, spanDays: 0 },
    models: [], artifacts: [], unresolved: [], coOccurrence: [], shapes: [], notes: [],
    sequences: { root: "/r", sessions },
  };
}
const fire = (sig: WorkflowSignal, id: string) => runDetectors(sig).filter((f) => f.detectorId === id);

describe("task-sprawl detector", () => {
  it("fires when a session touches SPRAWL_MIN or more distinct clusters", () => {
    const steps = Array.from({ length: SPRAWL_MIN }, (_, i) =>
      step("Read", "Read", `packages/p${i}/src/f.ts`, i));
    const f = fire(signalWith([sess(steps)]), "task-sprawl");
    expect(f).toHaveLength(1);
    expect(f[0].severity).toBe("warn");
    expect(f[0].detail).toContain(String(SPRAWL_MIN));
    expect(f[0].detail).not.toContain("packages/p0/src/f.ts"); // args never leak
  });
  it("stays quiet for a bounded session below the cluster threshold", () => {
    const steps = Array.from({ length: SPRAWL_MIN - 1 }, (_, i) =>
      step("Read", "Read", `packages/p${i}/src/f.ts`, i));
    expect(fire(signalWith([sess(steps)]), "task-sprawl")).toHaveLength(0);
  });
});

describe("task-pingpong detector", () => {
  it("fires when cluster transitions reach SWITCH_MIN", () => {
    // alternate between two clusters -> a switch on every step after the first
    const steps = Array.from({ length: SWITCH_MIN + 1 }, (_, i) =>
      step("Read", "Read", `packages/${i % 2 ? "a" : "b"}/f.ts`, i));
    const f = fire(signalWith([sess(steps)]), "task-pingpong");
    expect(f).toHaveLength(1);
    expect(f[0].detail).not.toContain("packages/a"); // args never leak
  });
  it("stays quiet when work stays in one cluster", () => {
    const steps = Array.from({ length: SWITCH_MIN + 5 }, (_, i) =>
      step("Read", "Read", `packages/a/f${i}.ts`, i));
    expect(fire(signalWith([sess(steps)]), "task-pingpong")).toHaveLength(0);
  });
});

describe("reread-churn detector", () => {
  it("fires when the same file is Read REREAD_MIN+ times", () => {
    const steps = Array.from({ length: REREAD_MIN }, (_, i) =>
      step("Read", "Read", "packages/a/big.ts", i * 10));
    const f = fire(signalWith([sess(steps)]), "reread-churn");
    expect(f).toHaveLength(1);
    expect(f[0].detail).not.toContain("big.ts"); // path never leaks
  });
  it("ignores files read fewer than REREAD_MIN times", () => {
    const steps = [step("Read", "Read", "packages/a/x.ts", 1), step("Read", "Read", "packages/a/x.ts", 2)];
    expect(fire(signalWith([sess(steps)]), "reread-churn")).toHaveLength(0);
  });
});

function turn(i: number, ctx: number, cacheCreation = 0): TurnUsage {
  return { turn: i, msgIndex: i, ctxTokens: ctx, cacheCreation, outTokens: 10 };
}
function sessM(steps: ProcedureStep[], series: TurnUsage[], model: string): SessionSequence {
  return { steps, sessionId: "s1", transcript: "s1.jsonl", atMs: 100, model, contextSeries: series };
}

describe("context-pinned detector", () => {
  it("fires when >=PIN_FRACTION of turns sit above PIN_LEVEL of the cap", () => {
    const cap = 1_000_000; const hi = cap * 0.95;
    const series = Array.from({ length: 20 }, (_, i) => turn(i, hi));
    const sig = signalWith([sessM([step("Read", "Read", "packages/a/f.ts", 0)], series, "opus[1m]")]);
    const f = fire(sig, "context-pinned");
    expect(f).toHaveLength(1);
    expect(f[0].severity).toBe("warn");
    expect(f[0].detail).toContain("85%");
  });
  it("does NOT fire for a long but un-pinned session (the bounded control)", () => {
    // 200k-cap model, window hovering ~120k — long, healthy, must stay quiet
    const series = Array.from({ length: 40 }, (_, i) => turn(i, 120_000));
    const sig = signalWith([sessM([step("Read", "Read", "packages/a/f.ts", 0)], series, "claude-sonnet-5")]);
    expect(fire(sig, "context-pinned")).toHaveLength(0);
  });
  it("degrades to [] when there is no contextSeries", () => {
    expect(fire(signalWith([sess([step("Read", "Read", "packages/a/f.ts", 0)])]), "context-pinned")).toHaveLength(0);
  });
});

describe("cache-churn-late detector", () => {
  it("fires when late-half cache creation is >= CHURN_RATIO x the early half", () => {
    const early = Array.from({ length: 10 }, (_, i) => turn(i, 500_000, 1_000));
    const late = Array.from({ length: 10 }, (_, i) => turn(10 + i, 900_000, 3_000)); // 3x
    const sig = signalWith([sessM([step("Read", "Read", "packages/a/f.ts", 0)], [...early, ...late], "opus[1m]")]);
    const f = fire(sig, "cache-churn-late");
    expect(f).toHaveLength(1);
    expect(f[0].severity).toBe("warn");
  });
  it("stays quiet when churn is even across halves", () => {
    const series = Array.from({ length: 20 }, (_, i) => turn(i, 500_000, 1_000));
    const sig = signalWith([sessM([step("Read", "Read", "packages/a/f.ts", 0)], series, "opus[1m]")]);
    expect(fire(sig, "cache-churn-late")).toHaveLength(0);
  });
});

const row = (id: string, count: number): DetectorSummary =>
  ({ id, title: id, advice: "", severity: "warn", count, sessions: count ? 1 : 0 });

describe("hygieneScore", () => {
  it("scores a clean session bounded (all hygiene factors zero)", () => {
    const s = ["task-sprawl", "task-pingpong", "reread-churn", "context-pinned", "cache-churn-late"].map((id) => row(id, 0));
    const v = hygieneScore(s);
    expect(v.verdict).toBe("bounded");
    expect(v.score).toBeGreaterThanOrEqual(72);
  });
  it("scores a heavily-flagged session bloated", () => {
    const s = [row("task-sprawl", 1), row("task-pingpong", 1), row("reread-churn", 1), row("context-pinned", 1), row("cache-churn-late", 1)];
    const v = hygieneScore(s);
    expect(v.verdict).toBe("bloated");
    expect(v.score).toBeLessThan(48);
  });
  it("is monotonic: more flags never scores higher", () => {
    const few = [row("task-sprawl", 1)];
    const many = [row("task-sprawl", 1), row("context-pinned", 1), row("cache-churn-late", 1)];
    expect(hygieneScore(many).score).toBeLessThanOrEqual(hygieneScore(few).score);
  });
});

describe("assessesHygiene", () => {
  it("is true when a hygiene factor is present", () => {
    expect(assessesHygiene([row("context-pinned", 0)])).toBe(true);
  });
  it("is false when no hygiene factor is present", () => {
    expect(assessesHygiene([row("retry-storm", 0)])).toBe(false);
  });
});
