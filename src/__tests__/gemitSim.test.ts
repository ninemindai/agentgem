// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
// Training Grounds sim math: pure projection functions, the serialization revival
// the report page performs, and the setup-formula mirror cross-checked against the
// real scoring core.
import { describe, expect, it } from "vitest";
import { autoSolvePath, projectComposite, setupScoreFrom, tierFor } from "../gemit/themeRpgSim.js";
import { SETUP_WEIGHTS, computeGemitData, type GemitSessionInput } from "../gemit/score.js";

const W = { ctx: 0.4, proc: 0.4, setup: 0.2 };
const TH = [50, 65, 80] as const;

describe("projectComposite / tierFor", () => {
  it("rounds the weighted sum", () => {
    expect(projectComposite(99, 81, 33, W)).toBe(79); // 78.6 rounds up
    expect(projectComposite(100, 100, 100, W)).toBe(100);
  });
  it("tiers at the exact thresholds", () => {
    expect(tierFor(49, TH)).toBe(1);
    expect(tierFor(50, TH)).toBe(2);
    expect(tierFor(64, TH)).toBe(2);
    expect(tierFor(65, TH)).toBe(3);
    expect(tierFor(79, TH)).toBe(3);
    expect(tierFor(80, TH)).toBe(4);
  });
});

describe("autoSolvePath", () => {
  it("reaches the target tier spending ctx/proc before setup", () => {
    const out = autoSolvePath({ ctx: 79, proc: 79, setup: 33 }, 4, W, TH);
    expect(tierFor(projectComposite(out.ctx, out.proc, out.setup, W), TH)).toBe(4);
    expect(out.setup).toBe(33); // ctx/proc headroom was enough — cheap axes first
    expect(out.ctx).toBeGreaterThanOrEqual(79);
  });
  it("moves to the next axis when the cheapest is already full", () => {
    const out = autoSolvePath({ ctx: 100, proc: 60, setup: 20 }, 4, W, TH);
    expect(tierFor(projectComposite(out.ctx, out.proc, out.setup, W), TH)).toBe(4);
    expect(out.ctx).toBe(100);
    expect(out.proc).toBeGreaterThan(60);
    expect(out.setup).toBe(20);
  });
  it("spills into setup when ctx/proc alone can't reach a (custom) threshold", () => {
    const HIGH = [50, 65, 95] as const;
    const out = autoSolvePath({ ctx: 100, proc: 100, setup: 10 }, 4, W, HIGH);
    expect(tierFor(projectComposite(out.ctx, out.proc, out.setup, W), HIGH)).toBe(4);
    expect(out.setup).toBeGreaterThan(10);
  });
  it("is a no-op at the target already", () => {
    expect(autoSolvePath({ ctx: 90, proc: 90, setup: 90 }, 4, W, TH)).toEqual({ ctx: 90, proc: 90, setup: 90 });
  });
  it("clamps at all-100 when the target is unreachable", () => {
    expect(autoSolvePath({ ctx: 100, proc: 100, setup: 100 }, 4, W, TH))
      .toEqual({ ctx: 100, proc: 100, setup: 100 });
  });
});

describe("serialization revival (the page does exactly this)", () => {
  it("revives the three sim functions into one scope and gets identical results", () => {
    // new Function over OUR OWN functions' toString() — trusted module source, never
    // user input. This mirrors how renderRpgTheme inlines them into the report page.
    const src = [projectComposite, tierFor, autoSolvePath].map((f) => f.toString()).join("\n");
    const revived = new Function(`${src}; return { projectComposite, tierFor, autoSolvePath };`)() as {
      projectComposite: typeof projectComposite; tierFor: typeof tierFor; autoSolvePath: typeof autoSolvePath;
    };
    expect(revived.projectComposite(99, 81, 33, W)).toBe(projectComposite(99, 81, 33, W));
    expect(revived.tierFor(79, TH)).toBe(3);
    expect(revived.autoSolvePath({ ctx: 79, proc: 79, setup: 33 }, 4, W, TH))
      .toEqual(autoSolvePath({ ctx: 79, proc: 79, setup: 33 }, 4, W, TH));
  });
});

describe("setupScoreFrom mirrors score.ts", () => {
  it("matches computeGemitData's setup when the percents are exact", () => {
    // 10 sessions: 5 with skills (3 types total), 2 with subagents (2 types) → exact 50%/20%.
    const mk = (i: number, skills: string[], subs: string[]): GemitSessionInput => ({
      sessionId: `s${i}`, agent: "claude", endMs: Date.UTC(2026, 6, 19) - (i + 1) * 3600_000, msgs: 20,
      tokensOut: 100, skillNames: skills, subagentNames: subs, projectKey: "p",
    });
    const qualifying = [
      mk(0, ["a"], []), mk(1, ["b"], ["x"]), mk(2, ["c"], []), mk(3, ["a"], ["y"]), mk(4, ["b"], []),
      mk(5, [], []), mk(6, [], []), mk(7, [], []), mk(8, [], []), mk(9, [], []),
    ];
    const d = computeGemitData(qualifying, [], Date.UTC(2026, 6, 19));
    expect(d.skillSessionsPct).toBe(50);
    expect(d.subagentSessionsPct).toBe(20);
    expect(setupScoreFrom(d, SETUP_WEIGHTS)).toBe(d.setup);
  });
});
