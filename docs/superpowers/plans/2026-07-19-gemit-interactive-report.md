# gemit Interactive Report (Training Grounds) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The gemit rpg report becomes interactive — a Training Grounds what-if simulator with draggable projected bars, a quest log whose actions nudge the projection, and a juice pass (count-up, stagger, stamp, confetti) — per `docs/superpowers/specs/2026-07-19-gemit-interactive-report-design.md`.

**Architecture:** Pure simulation math in new `src/gemit/themeRpgSim.ts`, serialized into the page via `Function.prototype.toString()` (plain tsc output, revival-tested). `score.ts` gains two additive payload fields + exported weight constants. All template/runtime/CSS work stays in `src/gemit/themeRpg.ts`; one inline `<script>` wires everything, omitted entirely on the insufficient-data doorway (it carries tier names, which the doorway must not).

**Tech Stack:** TS string-builder template, vanilla inline JS (pointer events, rAF), root vitest via compiled dist.

## Global Constraints

- Self-contained: no external URLs anywhere (existing test: `not.toMatch(/https?:\/\//)`) — remedies/commands must be URL-free.
- Measured score immutable on screen; interactivity only on the projected layer; what-if values clamp to `[measured, 100]`.
- Exact effect chips only where payload determines them (setup); otherwise labeled assumed (`~`).
- `prefers-reduced-motion` disables every animation + confetti; count-up renders final value.
- Existing test invariants that MUST keep passing: island JSON `toEqual` the full payload; doorway contains no tier name and no `RANK 0`; near-miss line text (`"1 pt from Master Lapidary"`) still a contiguous substring.
- Serialized sim functions: no imports/module refs/closures; may call each other by name (revived into one scope; revival test enforces).
- Root tests in `src/__tests__/`, dist-test convention: `npx tsc -b` then `npx vitest run dist/__tests__/<file>.js`. Worktree: `../agentgem-worktrees/gemit-pr4`, branch `feat/gemit-interactive`.

---

### Task 1: score.ts — weight constants + session-share payload fields

**Files:**
- Modify: `src/gemit/score.ts`
- Test: `src/__tests__/gemitScore.test.ts` (append), plus fixture updates in `src/__tests__/gemitCli.test.ts` (`fakeData`) and `src/__tests__/gemitTheme.test.ts` (`data`) — TS compile forces them.

**Interfaces (produces):**
- `export const COMPOSITE_WEIGHTS = { ctx: 0.4, proc: 0.4, setup: 0.2 } as const;`
- `export const SETUP_WEIGHTS = { sessions: 0.45, subSessions: 0.25, variety: 0.15, subVariety: 0.15 } as const;`
- `GemitData` gains `skillSessionsPct: number; subagentSessionsPct: number;` (0–100 ints; 0 on insufficient).

- [ ] **Step 1: failing tests** — append to `gemitScore.test.ts` (reuse its existing session/scored fixture helpers):

```ts
describe("session-share payload fields", () => {
  it("exposes skill/subagent session shares as rounded percents", () => {
    // 6 qualifying sessions; make 3 carry skills, 2 carry subagents via the fixtures.
    const qualifying = [0, 1, 2, 3, 4, 5].map(session);
    qualifying[0].skillNames = []; qualifying[0].subagentNames = [];
    qualifying[1].skillNames = []; qualifying[1].subagentNames = [];
    qualifying[2].skillNames = []; qualifying[2].subagentNames = [];
    qualifying[3].subagentNames = []; qualifying[4].subagentNames = [];
    // now: skills in sessions 3,4,5 (3/6); subagents in session 5 only (1/6)
    const d = computeGemitData(qualifying, [], NOW);
    expect(d.skillSessionsPct).toBe(50);
    expect(d.subagentSessionsPct).toBe(17);
  });

  it("zeroes the shares on insufficient data", () => {
    const d = computeGemitData([session(0)], [], NOW);
    expect(d.insufficient).toBe(true);
    expect(d.skillSessionsPct).toBe(0);
    expect(d.subagentSessionsPct).toBe(0);
  });

  it("exports the weights the composite actually uses", () => {
    expect(COMPOSITE_WEIGHTS.ctx + COMPOSITE_WEIGHTS.proc + COMPOSITE_WEIGHTS.setup).toBeCloseTo(1);
    expect(SETUP_WEIGHTS.sessions + SETUP_WEIGHTS.subSessions + SETUP_WEIGHTS.variety + SETUP_WEIGHTS.subVariety).toBeCloseTo(1);
    const d = computeGemitData([0, 1, 2, 3, 4, 5].map(session), [0, 1, 2].map(scored), NOW);
    expect(d.composite).toBe(Math.round(
      COMPOSITE_WEIGHTS.ctx * d.ctx + COMPOSITE_WEIGHTS.proc * d.proc + COMPOSITE_WEIGHTS.setup * d.setup));
  });
});
```
(adjust fixture mutation to however that file's `session(i)` builds names — the intent is 3/6 and 1/6.)

- [ ] **Step 2: run to verify failure** — `npx tsc -b` fails on missing exports/fields. Expected.

- [ ] **Step 3: implement** in `score.ts`:

```ts
export const COMPOSITE_WEIGHTS = { ctx: 0.4, proc: 0.4, setup: 0.2 } as const;
export const SETUP_WEIGHTS = { sessions: 0.45, subSessions: 0.25, variety: 0.15, subVariety: 0.15 } as const;
```

`GemitData` additions (after `subagentVariety`):

```ts
  /** Share of qualifying sessions that invoked ≥1 skill / ≥1 subagent (0–100 ints).
   *  Ships in both variants (counts only) so the theme can recompute SETUP exactly. */
  skillSessionsPct: number;
  subagentSessionsPct: number;
```

Insufficient branch adds `skillSessionsPct: 0, subagentSessionsPct: 0`. Main path, after `skillSessions`/`subagentSessions` locals:

```ts
  const skillSessionsPct = Math.round((100 * skillSessions) / n);
  const subagentSessionsPct = Math.round((100 * subagentSessions) / n);
```

Rewrite `setup` and `composite` to use the constants (numerically identical):

```ts
  const setup = Math.round(100 * Math.min(1,
    SETUP_WEIGHTS.sessions * (skillSessions / n) + SETUP_WEIGHTS.subSessions * (subagentSessions / n) +
    SETUP_WEIGHTS.variety * Math.min(1, skillVariety / 10) + SETUP_WEIGHTS.subVariety * Math.min(1, subagentVariety / 5)));
  // …
  const composite = Math.round(COMPOSITE_WEIGHTS.ctx * ctxR + COMPOSITE_WEIGHTS.proc * procR + COMPOSITE_WEIGHTS.setup * setup);
```

Return the two new fields. Then add `skillSessionsPct: 50, subagentSessionsPct: 33,` (any ints) to `fakeData` in `gemitCli.test.ts` and `data()` in `gemitTheme.test.ts`.

- [ ] **Step 4: run** — `npx tsc -b && npx vitest run dist/__tests__/gemitScore.test.js dist/__tests__/gemitCli.test.js dist/__tests__/gemitShare.test.js dist/__tests__/gemitTheme.test.js` → ALL PASS.

- [ ] **Step 5: commit** — `git add -A src/ && git commit -m "feat(gemit): payload session-share fields + exported scoring weights"`

---

### Task 2: themeRpgSim.ts — pure, serializable simulation math

**Files:**
- Create: `src/gemit/themeRpgSim.ts`
- Test: `src/__tests__/gemitSim.test.ts`

**Interfaces (produces):**
- `projectComposite(ctx: number, proc: number, setup: number, w: SimWeights): number`
- `tierFor(composite: number, thresholds: readonly number[]): 1|2|3|4`
- `autoSolvePath(cur: {ctx,proc,setup}, targetTier: number, w: SimWeights, thresholds: readonly number[]): {ctx,proc,setup}`
- `setupScoreFrom(f: SetupFieldsShape, sw: SetupWeightsShape): number` (render-only, NOT serialized)

- [ ] **Step 1: failing tests** — create `src/__tests__/gemitSim.test.ts`:

```ts
// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
import { describe, expect, it } from "vitest";
import { autoSolvePath, projectComposite, setupScoreFrom, tierFor } from "../gemit/themeRpgSim.js";
import { COMPOSITE_WEIGHTS, SETUP_WEIGHTS, TIER_THRESHOLDS, computeGemitData, type GemitSessionInput } from "../gemit/score.js";

const W = { ctx: 0.4, proc: 0.4, setup: 0.2 };
const TH = [50, 65, 80] as const;

describe("projectComposite / tierFor", () => {
  it("rounds the weighted sum", () => {
    expect(projectComposite(99, 81, 33, W)).toBe(79); // 0.4*99+0.4*81+0.2*33 = 78.6
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
  it("spills into setup when ctx/proc cap out", () => {
    const out = autoSolvePath({ ctx: 98, proc: 98, setup: 10 }, 4, W, TH);
    expect(tierFor(projectComposite(out.ctx, out.proc, out.setup, W), TH)).toBe(4);
    expect(out.setup).toBeGreaterThan(10);
  });
  it("is a no-op at the target already", () => {
    expect(autoSolvePath({ ctx: 90, proc: 90, setup: 90 }, 4, W, TH)).toEqual({ ctx: 90, proc: 90, setup: 90 });
  });
  it("clamps at all-100 when the target is unreachable", () => {
    const out = autoSolvePath({ ctx: 100, proc: 100, setup: 100 }, 4, W, TH);
    expect(out).toEqual({ ctx: 100, proc: 100, setup: 100 });
  });
});

describe("serialization revival (the page does exactly this)", () => {
  it("revives the three sim functions into one scope and gets identical results", () => {
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
      sessionId: `s${i}`, agent: "claude", endMs: Date.UTC(2026, 6, 19) - i * 3600_000, msgs: 20,
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
```

- [ ] **Step 2: run to verify failure** — `npx tsc -b` fails: module missing. Expected.

- [ ] **Step 3: implement** `src/gemit/themeRpgSim.ts`:

```ts
// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
// src/gemit/themeRpgSim.ts
//
// Pure simulation math for the rpg theme's Training Grounds. projectComposite /
// tierFor / autoSolvePath are serialized into the report page via
// Function.prototype.toString() — we ship plain tsc output (never minified), so
// the source survives verbatim; gemitSim.test.ts revives them the same way the
// page does and asserts identical results. Serialization rules: no imports, no
// module-level refs, no closures; they MAY call each other by name (revived into
// one shared scope). setupScoreFrom is render-time only (not serialized).

export interface SimWeights { ctx: number; proc: number; setup: number }

export function projectComposite(ctx: number, proc: number, setup: number, w: SimWeights): number {
  return Math.round(w.ctx * ctx + w.proc * proc + w.setup * setup);
}

export function tierFor(composite: number, thresholds: readonly number[]): 1 | 2 | 3 | 4 {
  if (composite >= thresholds[2]) return 4;
  if (composite >= thresholds[1]) return 3;
  if (composite >= thresholds[0]) return 2;
  return 1;
}

// Smallest total axis-point increase that reaches `targetTier`, spending points on
// the highest-weight axes first (they buy the most composite per axis point).
// Clamps to 100 per axis; unreachable targets saturate at all-100.
export function autoSolvePath(
  cur: { ctx: number; proc: number; setup: number },
  targetTier: number,
  w: SimWeights,
  thresholds: readonly number[],
): { ctx: number; proc: number; setup: number } {
  const target = targetTier <= 1 ? 0 : thresholds[targetTier - 2];
  const out = { ctx: cur.ctx, proc: cur.proc, setup: cur.setup };
  const axes = (["ctx", "proc", "setup"] as Array<"ctx" | "proc" | "setup">)
    .sort((a, b) => w[b] - w[a]);
  for (const k of axes) {
    if (projectComposite(out.ctx, out.proc, out.setup, w) >= target) break;
    const raw = w.ctx * out.ctx + w.proc * out.proc + w.setup * out.setup;
    out[k] = Math.min(100, out[k] + Math.ceil((target - 0.5 - raw) / w[k]));
  }
  // round() can leave the projection a point short of the threshold — top up cheaply.
  for (const k of axes) {
    while (projectComposite(out.ctx, out.proc, out.setup, w) < target && out[k] < 100) out[k]++;
  }
  return out;
}

export interface SetupWeightsShape { sessions: number; subSessions: number; variety: number; subVariety: number }
export interface SetupFieldsShape { skillSessionsPct: number; subagentSessionsPct: number; skillVariety: number; subagentVariety: number }

// Mirrors score.ts's SETUP formula from the payload's aggregate fields; exact when the
// percents are exact (cross-checked against computeGemitData in gemitSim.test.ts).
export function setupScoreFrom(f: SetupFieldsShape, sw: SetupWeightsShape): number {
  return Math.round(100 * Math.min(1,
    sw.sessions * (f.skillSessionsPct / 100) + sw.subSessions * (f.subagentSessionsPct / 100) +
    sw.variety * Math.min(1, f.skillVariety / 10) + sw.subVariety * Math.min(1, f.subagentVariety / 5)));
}
```

- [ ] **Step 4: run** — `npx tsc -b && npx vitest run dist/__tests__/gemitSim.test.js` → PASS.

- [ ] **Step 5: commit** — `git add src/gemit/themeRpgSim.ts src/__tests__/gemitSim.test.ts && git commit -m "feat(gemit): pure Training Grounds sim math, revival-tested for in-page serialization"`

---

### Task 3: themeRpg.ts — quests, Training Grounds, runtime, juice

**Files:**
- Modify: `src/gemit/themeRpg.ts`
- Test: `src/__tests__/gemitTheme.test.ts` (append + adjust)

**Interfaces:**
- Consumes: Task 1 constants/fields; Task 2 functions.
- Produces: `questsFor(d: GemitData): Quest[]` with `Quest = { id; title; remedy; axis: "ctx"|"proc"|"setup"; delta: number; exact: boolean; meter?: { now; target; label }; cmd?: string }`.

- [ ] **Step 1: failing tests** — append to `gemitTheme.test.ts`:

```ts
describe("questsFor", () => {
  it("turns locked perks into quests with meters, exact deltas for setup perks", () => {
    const d = data({ subagentVariety: 3, skillVariety: 12, verifyRatePct: 24 });
    const quests = questsFor(d);
    const clones = quests.find((q) => q.id === "perk-shadow-clones")!;
    expect(clones.axis).toBe("setup");
    expect(clones.exact).toBe(true);
    expect(clones.delta).toBeGreaterThanOrEqual(1);
    expect(clones.meter).toEqual({ now: 3, target: 5, label: "3/5 subagent types" });
    const look = quests.find((q) => q.id === "perk-second-look")!;
    expect(look.axis).toBe("proc");
    expect(look.exact).toBe(false);
  });

  it("maps finding quests to axes with a proc fallback and caps at 3", () => {
    const quests = questsFor(data());
    const findingQs = quests.filter((q) => q.id.startsWith("finding-"));
    expect(findingQs).toHaveLength(3);
    expect(findingQs.find((q) => q.id === "finding-no-verify-finish")!.axis).toBe("proc");
    expect(findingQs.every((q) => !q.exact)).toBe(true);
  });

  it("falls back to assumed setup deltas when the share fields are absent (old cards)", () => {
    const legacy = { ...data({ subagentVariety: 3 }) } as Record<string, unknown>;
    delete legacy.skillSessionsPct; delete legacy.subagentSessionsPct;
    const clones = questsFor(legacy as never).find((q) => q.id === "perk-shadow-clones")!;
    expect(clones.exact).toBe(false);
  });
});

describe("interactive layer", () => {
  it("renders training grounds sliders, quest log, and the sim script", () => {
    const html = renderRpgTheme(data());
    expect((html.match(/role="slider"/g) ?? []).length).toBe(3);
    expect(html).toContain('id="training"');
    expect(html).toContain("Quest Log");
    expect(html).toContain("data-delta=");
    expect(html).toContain('id="confetti"');
    expect(html).toContain("function autoSolvePath");
    expect(html).toContain("GEMIT_CONST");
    expect(html).toContain("prefers-reduced-motion");
  });

  it("keeps the doorway static: no script, no training grounds", () => {
    const html = renderRpgTheme(data({ insufficient: true, qualifyingSessions: 2, composite: 0, tierLevel: 1 }));
    expect(html).not.toContain("GEMIT_CONST");
    expect(html).not.toContain('id="training"');
    expect(html).not.toContain("Quest Log");
  });

  it("counts the rank up from a span that still carries the near-miss line", () => {
    const html = renderRpgTheme(data());
    expect(html).toContain('data-n="79"');
    expect(html).toContain("1 pt from Master Lapidary");
  });
});
```
(add `questsFor` to the file's imports from `../gemit/themeRpg.js`)

- [ ] **Step 2: run to verify failure** — compile error (`questsFor` missing). Expected.

- [ ] **Step 3: implement in `themeRpg.ts`** — four edits:

**(a) imports + quest builder** (top of file):

```ts
import { COMPOSITE_WEIGHTS, SETUP_WEIGHTS, TIER_THRESHOLDS, type GemitData } from "./score.js";
import { autoSolvePath, projectComposite, setupScoreFrom, tierFor } from "./themeRpgSim.js";

export interface Quest {
  id: string; title: string; remedy: string; axis: "ctx" | "proc" | "setup";
  delta: number; exact: boolean; meter?: { now: number; target: number; label: string }; cmd?: string;
}

const FINDING_AXIS: Record<string, "ctx" | "proc"> = {
  "reread-churn": "ctx", "context-bloat": "ctx",
  "no-verify-finish": "proc", "retry-storm": "proc", "repeated-tool-error": "proc",
};
const FINDING_REMEDIES: Record<string, string> = {
  "no-verify-finish": "End with proof — run the tests or reload the page before calling it done.",
  "retry-storm": "Two failed retries means the approach is wrong. Stop and rethink; don't hammer.",
  "repeated-tool-error": "Fix the first tool error before moving on; repeats compound into noise.",
  "reread-churn": "Re-reading the same file is context leak — take notes or delegate to a subagent.",
};

// Locked perks + top fired findings become actionable quests. Setup deltas are EXACT
// (recomputed via setupScoreFrom when the share fields shipped); ctx/proc deltas are
// assumptions and rendered with a "~" chip. Old cards without the share fields degrade
// every setup quest to assumed.
export function questsFor(d: GemitData): Quest[] {
  const { locked } = perksFor(d);
  const canExact = typeof d.skillSessionsPct === "number" && typeof d.subagentSessionsPct === "number";
  const setupNow = canExact ? setupScoreFrom(d, SETUP_WEIGHTS) : 0;
  const exactDelta = (patch: Partial<GemitData>): number =>
    Math.max(1, setupScoreFrom({ ...d, ...patch }, SETUP_WEIGHTS) - setupNow);
  const quests: Quest[] = [];
  const boundedPct = d.scoredSessions ? Math.round((100 * d.verdicts.bounded) / d.scoredSessions) : 0;
  for (const p of locked) {
    if (p.name === "Shadow Clones") quests.push({
      id: "perk-shadow-clones", title: "Unlock Shadow Clones", axis: "setup",
      delta: canExact ? exactDelta({ subagentVariety: 5 }) : 3, exact: canExact,
      remedy: "Adopt more subagent types — delegate exploration, review, and bulk reads.",
      meter: { now: d.subagentVariety, target: 5, label: `${d.subagentVariety}/5 subagent types` },
      cmd: "npx -y @ninemind/agentgem",
    });
    else if (p.name === "Scroll Mastery") quests.push({
      id: "perk-scroll-mastery", title: "Unlock Scroll Mastery", axis: "setup",
      delta: canExact ? exactDelta({ skillVariety: 8 }) : 3, exact: canExact,
      remedy: "Install and invoke more skills — the book fights better than improvisation.",
      meter: { now: d.skillVariety, target: 8, label: `${d.skillVariety}/8 skills` },
      cmd: "npx -y @ninemind/agentgem",
    });
    else if (p.name === "Second Look") quests.push({
      id: "perk-second-look", title: "Unlock Second Look", axis: "proc", delta: 4, exact: false,
      remedy: "Ask for verification before accepting done — tests run, page reloaded, output shown.",
      meter: { now: d.verifyRatePct ?? 0, target: 60, label: `${d.verifyRatePct ?? 0}/60% verified` },
    });
    else if (p.name === "Shadow Step") quests.push({
      id: "perk-shadow-step", title: "Unlock Shadow Step", axis: "ctx", delta: 4, exact: false,
      remedy: "Keep sessions bounded — fresh session per task, /clear early, delegate bulk reads.",
      meter: { now: boundedPct, target: 80, label: `${boundedPct}/80% bounded` },
    });
    else if (p.name === "Clean Cut") quests.push({
      id: "perk-clean-cut", title: "Unlock Clean Cut", axis: "ctx", delta: 3, exact: false,
      remedy: "Chain bounded sessions — the streak grows one disciplined session at a time.",
      meter: { now: d.boundedStreak, target: 20, label: `${d.boundedStreak}/20 streak` },
    });
  }
  for (const f of d.firedFindings.slice(0, 3)) quests.push({
    id: `finding-${f.id}`, title: `Quiet “${f.title}”`, axis: FINDING_AXIS[f.id] ?? "proc",
    delta: 5, exact: false,
    remedy: FINDING_REMEDIES[f.id] ?? `Fired in ${f.sessions} of ${d.scoredSessions} scored sessions — make its trigger rare.`,
  });
  return quests;
}
```
(note: `perksFor` already exists above in the file; `type GemitData` import replaces the existing one.)

**(b) render helpers** (near `statBar`):

```ts
const tgStat = (label: string, axis: string, v: number): string => `
      <div class="tg-stat" data-axis="${axis}">
        <div class="stat-head"><span class="stat-name">${label}</span><span class="tg-val mono">${v}</span></div>
        <div class="tg-bar" role="slider" tabindex="0" aria-label="Projected ${label}" aria-valuemin="${v}" aria-valuemax="100" aria-valuenow="${v}">
          <i class="tg-meas" style="--w:${v}%"></i><i class="tg-proj" style="width:${v}%"></i>
        </div>
      </div>`;

const questLi = (q: Quest): string => `
        <li data-axis="${q.axis}" data-delta="${q.delta}">
          <label><input type="checkbox"><b>${escapeHtml(q.title)}<span class="chip${q.exact ? "" : " assumed"}">${q.exact ? "+" : "~+"}${q.delta} ${q.axis.toUpperCase()}</span></b></label>
          ${q.meter ? `<span class="meter"><i style="--p:${Math.min(100, Math.round((100 * q.meter.now) / q.meter.target))}%"></i></span><span class="meter-label mono">${escapeHtml(q.meter.label)}</span><br>` : ""}${escapeHtml(q.remedy)}
          ${q.cmd ? `<span class="cmd-line"><code>${escapeHtml(q.cmd)}</code><button type="button" class="cmd-copy">Copy</button></span>` : ""}
        </li>`;
```

Also give `statBar` a stagger index: `statBar(label, value, low, i)` emitting `<i style="--w:${value}%;--d:${0.15 + i * 0.12}s">` and `.bar i { animation-delay: var(--d, .15s); }` replacing the fixed `.15s` in the keyframe shorthand.

**(c) template surgery** in `renderRpgTheme`:

- `rankLine` embeds the count-up span (near-miss text intact):
  `RANK <span class="count" data-n="${data.composite}">${data.composite}</span> / 100 &mdash; …` (both branches).
- `<h1 class="rank">` → `<h1 class="rank stamp">`.
- After the Disciplines `</section>`, insert (scored branch only):

```ts
    <section id="training">
      <h2>Training Grounds</h2>
      <p class="tg-note">What if? Drag a bar or take on quests below &mdash; the measured score above never moves.</p>
      ${tgStat("Context Discipline", "ctx", data.ctx)}
      ${tgStat("Process Quality", "proc", data.proc)}
      ${tgStat("Setup Maturity", "setup", data.setup)}
      <p class="tg-rank mono">PROJECTED <span id="tg-comp">${data.composite}</span> / 100 &mdash; <span id="tg-tier">${tierName}</span></p>
      <button id="tg-solve" type="button"${data.tierLevel >= 4 ? " disabled" : ""}>${data.tierLevel >= 4 ? "You&#39;re at the summit" : `Chart my path to ${TIER_NAMES[3]}`}</button>
    </section>
```

- Replace the "Still Sealed" and "Shadows to Train" sections with one Quest Log (`const quests = questsFor(data);` computed next to `perksFor`):

```ts
    ${quests.length ? `<section><h2>Quest Log</h2><ul class="jutsu quests">${quests.map(questLi).join("")}
      </ul></section>` : ""}
```

- Before `</body>` (scored branch only — the doorway must stay script-free): `<div id="confetti"></div>` plus the script block:

```ts
  const simSrc = [projectComposite, tierFor, autoSolvePath].map((f) => f.toString()).join("\n");
  const constJson = JSON.stringify({ weights: COMPOSITE_WEIGHTS, thresholds: TIER_THRESHOLDS, tierNames: TIER_NAMES }).replace(/</g, "\\u003c");
  const script = data.insufficient ? "" : `<div id="confetti"></div>\n<script>"use strict";\nconst GEMIT_CONST=${constJson};\n${simSrc}\n${RUNTIME_JS}</script>`;
```

interpolated as `${script}` right before `</body>`.

**(d) `RUNTIME_JS`** — module-level const (verbatim, URL-free; add above `renderRpgTheme`):

```ts
// Page runtime: wires sliders/quests/confetti to the revived sim functions. Kept as a
// plain string (not serialized TS) because it touches the DOM. Count-up + bar-fill mean
// early screenshots show low numbers — same pre-delay caveat as the PR-1 stat bars.
const RUNTIME_JS = `(function () {
  var dataEl = document.getElementById("gemit-data");
  if (!dataEl) return;
  var D = JSON.parse(dataEl.textContent);
  if (D.insufficient) return;
  var W = GEMIT_CONST.weights, TH = GEMIT_CONST.thresholds, NAMES = GEMIT_CONST.tierNames;
  var reduced = window.matchMedia && matchMedia("(prefers-reduced-motion: reduce)").matches;

  var rankEl = document.querySelector(".count");
  if (rankEl && !reduced) {
    var rankTarget = +rankEl.getAttribute("data-n"), r0 = null;
    var rtick = function (t) {
      if (r0 === null) r0 = t;
      var p = Math.min(1, (t - r0) / 900);
      rankEl.textContent = String(Math.round(rankTarget * (1 - Math.pow(1 - p, 3))));
      if (p < 1) requestAnimationFrame(rtick);
    };
    rankEl.textContent = "0";
    requestAnimationFrame(rtick);
  }

  var vals = { ctx: D.ctx, proc: D.proc, setup: D.setup };
  var meas = { ctx: D.ctx, proc: D.proc, setup: D.setup };
  var lastTier = tierFor(projectComposite(vals.ctx, vals.proc, vals.setup, W), TH);

  function confetti() {
    var host = document.getElementById("confetti");
    if (!host) return;
    var colors = ["#d9a441", "#c8372e", "#e8dfc8", "#8b96ad"];
    for (var i = 0; i < 30; i++) {
      var s = document.createElement("i");
      s.style.left = (5 + Math.random() * 90) + "%";
      s.style.background = colors[i % 4];
      s.style.animationDelay = (Math.random() * 0.25) + "s";
      host.appendChild(s);
    }
    setTimeout(function () { host.innerHTML = ""; }, 1900);
  }

  function recompute() {
    var comp = projectComposite(vals.ctx, vals.proc, vals.setup, W);
    var tier = tierFor(comp, TH);
    var compEl = document.getElementById("tg-comp");
    if (compEl) compEl.textContent = String(comp);
    var tierEl = document.getElementById("tg-tier");
    if (tierEl && tier !== lastTier) {
      tierEl.textContent = NAMES[tier - 1];
      tierEl.classList.remove("flip"); void tierEl.offsetWidth; tierEl.classList.add("flip");
      if (tier > lastTier && !reduced) confetti();
      lastTier = tier;
    }
    var btn = document.getElementById("tg-solve");
    if (btn) btn.disabled = tier >= 4;
  }

  function setAxis(axis, v) {
    v = Math.max(meas[axis], Math.min(100, Math.round(v)));
    vals[axis] = v;
    var box = document.querySelector('.tg-stat[data-axis="' + axis + '"]');
    if (!box) return;
    box.querySelector(".tg-val").textContent = String(v);
    var bar = box.querySelector(".tg-bar");
    bar.setAttribute("aria-valuenow", String(v));
    bar.querySelector(".tg-proj").style.width = v + "%";
    recompute();
  }

  Array.prototype.forEach.call(document.querySelectorAll(".tg-stat"), function (box) {
    var axis = box.getAttribute("data-axis");
    var bar = box.querySelector(".tg-bar");
    var dragging = false;
    var fromEvent = function (e) {
      var r = bar.getBoundingClientRect();
      setAxis(axis, 100 * (e.clientX - r.left) / r.width);
    };
    bar.addEventListener("pointerdown", function (e) {
      dragging = true;
      if (bar.setPointerCapture) bar.setPointerCapture(e.pointerId);
      fromEvent(e); e.preventDefault();
    });
    bar.addEventListener("pointermove", function (e) { if (dragging) fromEvent(e); });
    bar.addEventListener("pointerup", function () { dragging = false; });
    bar.addEventListener("pointercancel", function () { dragging = false; });
    bar.addEventListener("keydown", function (e) {
      var step = e.shiftKey ? 5 : 1;
      if (e.key === "ArrowRight" || e.key === "ArrowUp") { setAxis(axis, vals[axis] + step); e.preventDefault(); }
      else if (e.key === "ArrowLeft" || e.key === "ArrowDown") { setAxis(axis, vals[axis] - step); e.preventDefault(); }
    });
  });

  Array.prototype.forEach.call(document.querySelectorAll(".quests input[type=checkbox]"), function (cb) {
    cb.addEventListener("change", function () {
      var li = cb.closest("li");
      var delta = +li.getAttribute("data-delta");
      setAxis(li.getAttribute("data-axis"), vals[li.getAttribute("data-axis")] + (cb.checked ? delta : -delta));
      li.classList.toggle("done", cb.checked);
    });
  });

  var solveBtn = document.getElementById("tg-solve");
  if (solveBtn) solveBtn.addEventListener("click", function () {
    var goal = autoSolvePath({ ctx: vals.ctx, proc: vals.proc, setup: vals.setup }, 4, W, TH);
    var from = { ctx: vals.ctx, proc: vals.proc, setup: vals.setup };
    if (reduced) { setAxis("ctx", goal.ctx); setAxis("proc", goal.proc); setAxis("setup", goal.setup); return; }
    var t0 = null;
    var tick = function (t) {
      if (t0 === null) t0 = t;
      var p = Math.min(1, (t - t0) / 1200), e2 = 1 - Math.pow(1 - p, 3);
      setAxis("ctx", from.ctx + (goal.ctx - from.ctx) * e2);
      setAxis("proc", from.proc + (goal.proc - from.proc) * e2);
      setAxis("setup", from.setup + (goal.setup - from.setup) * e2);
      if (p < 1) requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });

  function selectNode(node) {
    var sel = window.getSelection(), range = document.createRange();
    range.selectNodeContents(node); sel.removeAllRanges(); sel.addRange(range);
  }
  Array.prototype.forEach.call(document.querySelectorAll(".cmd-copy"), function (btn) {
    btn.addEventListener("click", function () {
      var code = btn.parentElement.querySelector("code");
      var done = function () { btn.textContent = "Copied"; setTimeout(function () { btn.textContent = "Copy"; }, 1500); };
      try { navigator.clipboard.writeText(code.textContent).then(done, function () { selectNode(code); }); }
      catch (e) { selectNode(code); }
    });
  });
})();`;
```

**(e) CSS additions** in the `<style>` block (and change `.bar i` to `animation-delay: var(--d, .15s)` form):

```css
  .tg-note { color: var(--muted); font-size: 13px; margin: 0 0 14px; }
  .tg-stat { margin: 0 0 18px; }
  .tg-bar { position: relative; height: 18px; background: var(--panel); border: 1px solid var(--line); cursor: ew-resize; touch-action: none; }
  .tg-bar:focus-visible { outline: 2px solid var(--gold); outline-offset: 2px; }
  .tg-meas, .tg-proj { position: absolute; top: 0; left: 0; bottom: 0; display: block; }
  .tg-meas { width: var(--w); background: var(--line); }
  .tg-proj { background: var(--gold); opacity: .85; transition: width .35s cubic-bezier(.25,1,.3,1); }
  .tg-rank { margin: 14px 0 10px; border: 1px dashed var(--gold); width: fit-content; padding: 7px 14px; }
  #tg-solve { font: inherit; font-size: 13.5px; padding: 9px 16px; border: 1px solid var(--gold); background: transparent; color: var(--gold); cursor: pointer; letter-spacing: .04em; }
  #tg-solve:disabled { opacity: .5; cursor: default; }
  #tg-solve:hover:not(:disabled) { background: var(--gold); color: var(--bg); }
  .flip { display: inline-block; animation: flip .5s cubic-bezier(.25,1,.3,1); }
  @keyframes flip { from { transform: rotateX(90deg); } }
  .stamp { animation: stamp .45s cubic-bezier(.25,1,.3,1) backwards; }
  @keyframes stamp { from { transform: scale(1.15); opacity: 0; } }
  #confetti { position: fixed; inset: 0; pointer-events: none; overflow: hidden; }
  #confetti i { position: absolute; top: -14px; width: 8px; height: 12px; animation: fall 1.6s ease-in forwards; }
  @keyframes fall { to { transform: translateY(105vh) rotate(540deg); opacity: .2; } }
  ul.jutsu li { transition: transform .2s; }
  ul.jutsu li:hover { transform: translateY(-1px); }
  .quests label { cursor: pointer; display: flex; gap: 8px; align-items: baseline; }
  .quests li.done { border-left-color: var(--gold); opacity: .75; }
  .quests .chip { font-family: ui-monospace, Menlo, monospace; font-size: 11px; color: var(--gold); border: 1px solid var(--line); padding: 1px 7px; margin-left: 8px; font-weight: 400; }
  .quests .chip.assumed { color: var(--muted); }
  .meter { display: inline-block; width: 90px; height: 6px; background: var(--panel2); border: 1px solid var(--line); vertical-align: middle; margin: 6px 6px 6px 0; }
  .meter i { display: block; height: 100%; width: var(--p); background: var(--accent); }
  .meter-label { font-size: 11.5px; }
  .cmd-line { margin-top: 7px; display: flex; gap: 6px; align-items: center; }
  .cmd-line code { user-select: all; -webkit-user-select: all; border: 1px solid var(--line); padding: 3px 8px; font-size: 12px; background: var(--panel2); color: var(--ink); }
  .cmd-copy { font: inherit; font-size: 11.5px; padding: 3px 9px; border: 1px solid var(--line); background: var(--panel); color: var(--ink); cursor: pointer; }
```
and extend the reduced-motion block to:
```css
  @media (prefers-reduced-motion: reduce) {
    .bar i, .stamp, .flip, #confetti i { animation: none; }
    .tg-proj { transition: none; }
    ul.jutsu li { transition: none; }
  }
```

- [ ] **Step 4: run** — `npx tsc -b && npx vitest run dist/__tests__/gemitTheme.test.js dist/__tests__/gemitSim.test.js dist/__tests__/gemitShare.test.js dist/__tests__/gemitCli.test.js dist/__tests__/gemitScore.test.js` → ALL PASS (island equality, no-URL, doorway, near-miss line included).

- [ ] **Step 5: commit** — `git add src/gemit/themeRpg.ts src/__tests__/gemitTheme.test.ts && git commit -m "feat(gemit): Training Grounds simulator, quest log, and juice pass in the rpg report"`

---

### Task 4: Verification + PR

- [ ] **Step 1:** `pnpm build && npx vitest run` (root, CI gate) → green.
- [ ] **Step 2 (real browser, local report):** `node dist/cli.js gemit --no-open`, open the written report via browser-harness; drag a slider, check a quest, click auto-solve (expect confetti + tier flip), screenshot before/after.
- [ ] **Step 3 (sealed iframe):** serve the report html through the marketplace `GamePlayer` (local vite dev, paste html as a game via the existing dogfood card after Task 5 republish — or temporarily load the .share.html file into a `srcdoc` harness page) and confirm sliders/quests work inside the sandbox and the copy button falls back to select.
- [ ] **Step 4:** commit plan doc; push `feat/gemit-interactive`; PR (mechanics-only); `gh run watch --exit-status`; `gh pr merge --rebase --delete-branch`; verify every commit's content on origin/main (grep `origin/main:src/gemit/themeRpgSim.ts`, `themeRpg.ts` for `Training Grounds`, `score.ts` for `skillSessionsPct`).

### Task 5 (post-merge ops): republish the dogfood card

- [ ] `node dist/cli.js gemit --share --yes` (same-day upsert replaces today's card) → open the live card, confirm the interactive layer works inside the marketplace sealed iframe, re-screenshot.
