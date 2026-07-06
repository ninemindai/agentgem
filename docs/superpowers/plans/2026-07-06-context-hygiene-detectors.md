# Context-Hygiene Detectors Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a retrospective, mostly-deterministic detector family to `@agentgem/insight` that flags sessions dragging many unrelated tasks into one ever-growing context window (vs. bounded-but-long, which is healthy), surfaced through the existing detector → rubric report path.

**Architecture:** Five new `DetectorSpec`s appended to the existing `DETECTORS` registry. Three run on the scrubbed verb spine that `scanWorkflow` already retains (`task-sprawl`, `task-pingpong`, `reread-churn`); two need per-turn token accounting, delivered by a new optional `SessionSequence.contextSeries` populated in `scanWorkflow`'s assistant branch (`context-pinned`, `cache-churn-late`). A pure `hygieneScore()` aggregates the five findings into one headline verdict for the rubric report. Every detector is pure and degrades to `[]` on missing data, exactly like the shipped `retry-storm`.

**Tech Stack:** TypeScript (ESM, `.js` import specifiers), Vitest (root `tsc -b && vitest run`, tests compiled to `dist/` and globbed from `dist/**/__tests__/**/*.test.js`). No new dependencies.

## Global Constraints

- **Copyright header** on every new `.ts` file, verbatim:
  ```
  // Copyright (c) 2026 NineMind, Inc.
  // SPDX-License-Identifier: MIT
  // <repo-relative path>
  ```
- **ESM import specifiers end in `.js`** even for `.ts` sources (e.g. `from "./contextCap.js"`).
- **Privacy contract:** a `DetectorFinding.detail` is built from counts and low-cardinality verbs ONLY — never from `arg` (args can carry paths). Assert `detail` does not contain a path in tests, mirroring `detectors.test.ts`.
- **Detector IDs** are kebab-case, unique across built-ins and rules, matching `/^[a-z0-9][a-z0-9-]{0,63}$/`.
- **Tests live at repo root** `src/gem/__tests__/`, NOT inside the package. They import from `@agentgem/insight`.
- **Detectors never throw** to the caller: `runDetectors` try/catches each, but a detector should still guard its own inputs and return `[]` when data is absent.
- **`grep -a`** when searching `packages/insight/src/workflowScan.ts` — it carries a control byte that makes plain grep skip it as binary.
- **Commit identity:** `Raymond Feng <raymond@ninemind.ai>`; end commit messages with the `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>` trailer.
- **Branch:** work on `feat/context-hygiene-detectors` (already created off `origin/main`; the spec + mockups are its first commit).

---

## File Structure

- **Create** `packages/insight/src/contextCap.ts` — `contextCap(model?)` → context-window size. (Task 1)
- **Create** `packages/insight/src/taskCluster.ts` — `clusterOf(arg)` → low-cardinality task bucket. (Task 3)
- **Create** `packages/insight/src/contextHygiene.ts` — the five `DetectorSpec`s, exported threshold constants, and `hygieneScore()`. (Tasks 4, 5, 6)
- **Modify** `packages/insight/src/workflowScan.ts` — add `TurnUsage` interface + `contextTokens()` helper + `contextSeries?` field (Task 2); populate it in `scanWorkflow` (Task 7).
- **Modify** `packages/insight/src/detectors.ts:198` — append the five specs to `DETECTORS`. (Tasks 4, 5)
- **Modify** `packages/insight/src/index.ts` — re-export the new modules. (Tasks 1, 3, 4)
- **Modify** `packages/insight/src/rubricReport.ts` — attach `hygieneScore()` to `RubricReport`. (Task 6)
- **Create** `src/gem/__tests__/contextHygiene.test.ts` — all unit tests for the above. (Tasks 1–6)
- **Create** `src/gem/__tests__/contextSeriesScan.test.ts` — integration test for the scan attachment. (Task 7)

**Run commands** (from repo root `/Users/rfeng/Projects/ninemind/agentgem`):
- Build once: `tsc -b`
- Single test file: `tsc -b && npx vitest run dist/gem/__tests__/contextHygiene.test.js`
- Full suite: `npm test`

---

## Task 1: Context-window cap lookup

**Files:**
- Create: `packages/insight/src/contextCap.ts`
- Modify: `packages/insight/src/index.ts` (add `export * from "./contextCap.js";`)
- Test: `src/gem/__tests__/contextHygiene.test.ts`

**Interfaces:**
- Produces: `export function contextCap(model?: string): number` — returns `1_000_000` when the model id signals a 1M window (contains `[1m]` or `-1m`), else `200_000` (safe default for Claude/others).

- [ ] **Step 1: Write the failing test**

Create `src/gem/__tests__/contextHygiene.test.ts`:

```ts
// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
// src/gem/__tests__/contextHygiene.test.ts
import { describe, it, expect } from "vitest";
import { contextCap } from "@agentgem/insight";

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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `tsc -b && npx vitest run dist/gem/__tests__/contextHygiene.test.js`
Expected: FAIL — `contextCap` is not exported from `@agentgem/insight`.

- [ ] **Step 3: Write minimal implementation**

Create `packages/insight/src/contextCap.ts`:

```ts
// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
// packages/insight/src/contextCap.ts
//
// Context-window size for a model id. The "pinned" hygiene signal is a fraction
// of this cap, so the number lives in one place — never hardcoded in a detector.
// The 1M window is opt-in and shows up in the id as `[1m]` or `-1m`; everything
// else uses the conservative 200k default.

const ONE_MILLION = 1_000_000;
const DEFAULT_CAP = 200_000;

export function contextCap(model?: string): number {
  if (model && (/\[1m\]/i.test(model) || /-1m\b/i.test(model))) return ONE_MILLION;
  return DEFAULT_CAP;
}
```

Add to `packages/insight/src/index.ts` (alongside the other `export *` lines):

```ts
export * from "./contextCap.js";
```

- [ ] **Step 4: Run test to verify it passes**

Run: `tsc -b && npx vitest run dist/gem/__tests__/contextHygiene.test.js`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/insight/src/contextCap.ts packages/insight/src/index.ts src/gem/__tests__/contextHygiene.test.ts
git -c user.name="Raymond Feng" -c user.email="raymond@ninemind.ai" commit -m "feat(insight): model->context-window cap lookup

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 2: `TurnUsage` type, `contextTokens` helper, and `SessionSequence.contextSeries`

**Files:**
- Modify: `packages/insight/src/workflowScan.ts` (lines 28–32: types; add helper near top)
- Test: `src/gem/__tests__/contextHygiene.test.ts` (append)

**Interfaces:**
- Produces:
  - `export interface TurnUsage { turn: number; msgIndex: number; ctxTokens: number; cacheCreation: number; outTokens: number }`
  - `SessionSequence` gains `contextSeries?: TurnUsage[]`
  - `export function contextTokens(usage: Record<string, number> | undefined): number` — sum of `input_tokens + cache_read_input_tokens + cache_creation_input_tokens` (0 when absent). This is the single definition of "context size", matching the fields `observeScan.ts:59-61` and `inspectSession.ts:81-84` already trust.

- [ ] **Step 1: Write the failing test** (append to `contextHygiene.test.ts`)

```ts
import { contextTokens } from "@agentgem/insight";
import type { TurnUsage } from "@agentgem/insight";

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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `tsc -b && npx vitest run dist/gem/__tests__/contextHygiene.test.js`
Expected: FAIL — `contextTokens` / `TurnUsage` not exported.

- [ ] **Step 3: Write minimal implementation**

In `packages/insight/src/workflowScan.ts`, replace the `SessionSequence` interface (line 32) and add the new type + helper immediately after `ProcedureStep` (line 28). Use `grep -an "export interface SessionSequence" packages/insight/src/workflowScan.ts` to confirm the line first.

```ts
// per-assistant-turn token accounting — the bloat curve. Optional: only present
// when retainSequences is on (see scanWorkflow). `ctxTokens` is the full window
// size sent that turn; `cacheCreation` alone is the churn signal.
export interface TurnUsage { turn: number; msgIndex: number; ctxTokens: number; cacheCreation: number; outTokens: number }

export function contextTokens(usage: Record<string, number> | undefined): number {
  if (!usage) return 0;
  return (usage.input_tokens ?? 0) + (usage.cache_read_input_tokens ?? 0) + (usage.cache_creation_input_tokens ?? 0);
}
```

Then extend `SessionSequence` (add the optional field to the existing one-line interface at line 32):

```ts
export interface SessionSequence { steps: ProcedureStep[]; missionHint?: MissionHint; sessionId: string; transcript: string; atMs: number; model?: string; contextSeries?: TurnUsage[] }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `tsc -b && npx vitest run dist/gem/__tests__/contextHygiene.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/insight/src/workflowScan.ts src/gem/__tests__/contextHygiene.test.ts
git -c user.name="Raymond Feng" -c user.email="raymond@ninemind.ai" commit -m "feat(insight): TurnUsage type + contextTokens helper + SessionSequence.contextSeries

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 3: Task-cluster bucketing helper

**Files:**
- Create: `packages/insight/src/taskCluster.ts`
- Modify: `packages/insight/src/index.ts` (add `export * from "./taskCluster.js";`)
- Test: `src/gem/__tests__/contextHygiene.test.ts` (append)

**Interfaces:**
- Produces: `export function clusterOf(arg: string | undefined): string | null` — buckets a scrubbed step `arg` into a low-cardinality task label: `packages/<x>` → `pkg:<x>`, else first path segment → `dir:<seg>`, else `null` for non-path args (Bash command / pattern args, which the scrub prefixes with `cmd:`-style content — treat anything without a `/` as `null`).

- [ ] **Step 1: Write the failing test** (append)

```ts
import { clusterOf } from "@agentgem/insight";

describe("clusterOf", () => {
  it("buckets a packages/<x> path to pkg:<x>", () => {
    expect(clusterOf("packages/console/src/app.ts")).toBe("pkg:console");
    expect(clusterOf("/repo/packages/insight/src/x.ts")).toBe("pkg:insight");
  });
  it("buckets other paths to their first segment", () => {
    expect(clusterOf("src/gem/scorecard.ts")).toBe("dir:src");
    expect(clusterOf("docs/readme.md")).toBe("dir:docs");
  });
  it("returns null for non-path args and empties", () => {
    expect(clusterOf("npm test")).toBeNull();
    expect(clusterOf("")).toBeNull();
    expect(clusterOf(undefined)).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `tsc -b && npx vitest run dist/gem/__tests__/contextHygiene.test.js`
Expected: FAIL — `clusterOf` not exported.

- [ ] **Step 3: Write minimal implementation**

Create `packages/insight/src/taskCluster.ts`:

```ts
// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
// packages/insight/src/taskCluster.ts
//
// Low-cardinality "what task is this step touching" bucket, derived from a
// scrubbed step arg. Shared by the task-sprawl and task-pingpong detectors so
// they agree on what a task boundary is. Pure; returns null when the arg is not
// a filesystem path (e.g. a Bash command), which those detectors ignore.

export function clusterOf(arg: string | undefined): string | null {
  if (!arg) return null;
  const pkg = /packages\/([\w.-]+)/.exec(arg);
  if (pkg) return `pkg:${pkg[1]}`;
  const seg = /^\/?([\w.-]+)\//.exec(arg);
  if (seg) return `dir:${seg[1]}`;
  return null;
}
```

Add to `packages/insight/src/index.ts`:

```ts
export * from "./taskCluster.js";
```

- [ ] **Step 4: Run test to verify it passes**

Run: `tsc -b && npx vitest run dist/gem/__tests__/contextHygiene.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/insight/src/taskCluster.ts packages/insight/src/index.ts src/gem/__tests__/contextHygiene.test.ts
git -c user.name="Raymond Feng" -c user.email="raymond@ninemind.ai" commit -m "feat(insight): task-cluster bucketing helper

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 4: Spine detectors — `task-sprawl`, `task-pingpong`, `reread-churn`

**Files:**
- Create: `packages/insight/src/contextHygiene.ts`
- Modify: `packages/insight/src/detectors.ts:198` (append the three specs to `DETECTORS`)
- Modify: `packages/insight/src/index.ts` (add `export * from "./contextHygiene.js";`)
- Test: `src/gem/__tests__/contextHygiene.test.ts` (append)

**Interfaces:**
- Consumes: `DetectorSpec`, `DetectorFinding`, `SessionSequence`, `ProcedureStep` from `./detectors.js` / `./workflowScan.js`; `clusterOf` from `./taskCluster.js`.
- Produces (exported): `SPRAWL_MIN = 5`, `SWITCH_MIN = 12`, `REREAD_MIN = 3`, and `DetectorSpec`s `taskSprawl`, `taskPingpong`, `rereadChurn`.
- The `DETECTORS` array in `detectors.ts` gains these three ids: `task-sprawl`, `task-pingpong`, `reread-churn`.

- [ ] **Step 1: Write the failing test** (append). Reuse the `step`/`sess`/`signalWith` helpers — define them once at the top of the file if not already present (copy from `detectors.test.ts:8-21`):

```ts
import { runDetectors, SPRAWL_MIN, SWITCH_MIN, REREAD_MIN } from "@agentgem/insight";
import type { ProcedureStep, SessionSequence, WorkflowSignal, TurnUsage } from "@agentgem/insight";

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
    expect(fire(signalWith([sess(steps)]), "task-pingpong")).toHaveLength(1);
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `tsc -b && npx vitest run dist/gem/__tests__/contextHygiene.test.js`
Expected: FAIL — constants/specs not exported; the three ids never fire.

- [ ] **Step 3: Write minimal implementation**

Create `packages/insight/src/contextHygiene.ts`:

```ts
// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
// packages/insight/src/contextHygiene.ts
//
// Context-hygiene detector family: flags a session dragging many unrelated tasks
// into one ever-growing window (vs. a bounded-but-long session, which is fine).
// Same house pattern as the shipped detectors — pure SessionSequence -> findings,
// degrade to [] on missing data, detail from counts/verbs only (never arg).
import type { DetectorSpec, DetectorFinding } from "./detectors.js";
import type { SessionSequence } from "./workflowScan.js";
import { clusterOf } from "./taskCluster.js";
import { contextCap } from "./contextCap.js";

function finding(
  id: string, severity: "info" | "warn", session: SessionSequence,
  detail: string, msgIndices: number[],
): DetectorFinding {
  return {
    detectorId: id, sessionId: session.sessionId, transcript: session.transcript,
    atMs: session.atMs, severity, detail, evidence: { msgIndices },
  };
}

// Distinct file-touching clusters in one session at/above this reads as sprawl.
export const SPRAWL_MIN = 5;
// Cluster transitions (ping-pong between tasks) at/above this reads as thrash.
export const SWITCH_MIN = 12;
// Same file re-read this many times = it fell out of context and got re-fetched.
export const REREAD_MIN = 3;

export const taskSprawl: DetectorSpec = {
  id: "task-sprawl", title: "Many tasks in one session", cost: "cheap", severity: "warn",
  advice: "This session touched several unrelated areas. Splitting each into its own session keeps every window lean.",
  detect(session) {
    const clusters = new Set<string>();
    const idx: number[] = [];
    for (const s of session.steps) {
      const c = clusterOf(s.arg);
      if (c) { clusters.add(c); idx.push(s.msgIndex); }
    }
    if (clusters.size < SPRAWL_MIN) return [];
    return [finding("task-sprawl", "warn", session,
      `${clusters.size} task clusters in one session`, idx.slice(0, 20))];
  },
};

export const taskPingpong: DetectorSpec = {
  id: "task-pingpong", title: "Ping-ponging between tasks", cost: "cheap", severity: "info",
  advice: "Work bounced between areas repeatedly. Finishing one before starting the next avoids re-loading context each switch.",
  detect(session) {
    const seq: { c: string; i: number }[] = [];
    for (const s of session.steps) { const c = clusterOf(s.arg); if (c) seq.push({ c, i: s.msgIndex }); }
    let switches = 0; const at: number[] = [];
    for (let k = 1; k < seq.length; k++) if (seq[k].c !== seq[k - 1].c) { switches++; at.push(seq[k].i); }
    if (switches < SWITCH_MIN) return [];
    const clusters = new Set(seq.map((e) => e.c)).size;
    return [finding("task-pingpong", "info", session,
      `${switches} switches across ${clusters} clusters`, at.slice(0, 20))];
  },
};

export const rereadChurn: DetectorSpec = {
  id: "reread-churn", title: "Re-reading files that fell out of context", cost: "cheap", severity: "info",
  advice: "Files were read repeatedly, a sign the window grew past what it can hold. A cleaner cut keeps them resident.",
  detect(session) {
    const counts = new Map<string, number[]>();
    for (const s of session.steps) {
      if (s.tool !== "Read" || !s.arg) continue;
      (counts.get(s.arg) ?? counts.set(s.arg, []).get(s.arg)!).push(s.msgIndex);
    }
    let files = 0, redundant = 0; const idx: number[] = [];
    for (const [, hits] of counts) if (hits.length >= REREAD_MIN) { files++; redundant += hits.length - 1; idx.push(...hits); }
    if (files === 0) return [];
    return [finding("reread-churn", "info", session,
      `${files} file(s) re-read ${REREAD_MIN}+ times (${redundant} redundant reads)`, idx.slice(0, 20))];
  },
};
```

In `packages/insight/src/detectors.ts`, extend the registry at line 198. First add the import near the other imports at the top of the file:

```ts
import { taskSprawl, taskPingpong, rereadChurn } from "./contextHygiene.js";
```

Then change line 198 from:

```ts
export const DETECTORS: DetectorSpec[] = [retryStorm, thrashLoop, noVerifyFinish, regressionCycle, unverifiedTail];
```

to:

```ts
export const DETECTORS: DetectorSpec[] = [
  retryStorm, thrashLoop, noVerifyFinish, regressionCycle, unverifiedTail,
  taskSprawl, taskPingpong, rereadChurn,
];
```

Add to `packages/insight/src/index.ts`:

```ts
export * from "./contextHygiene.js";
```

> Note: `contextHygiene.ts` imports from `detectors.js` (types only) and `detectors.ts` imports the specs from `contextHygiene.js` — a values-and-types cycle. This is safe because `contextHygiene`'s imports from `detectors` are `import type` (erased at compile time), so there is no runtime initialization cycle. Keep them as `import type`.

- [ ] **Step 4: Run test to verify it passes**

Run: `tsc -b && npx vitest run dist/gem/__tests__/contextHygiene.test.js`
Expected: PASS. Also run the existing detector suite to confirm no regression:
`npx vitest run dist/gem/__tests__/detectors.test.js` → PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/insight/src/contextHygiene.ts packages/insight/src/detectors.ts packages/insight/src/index.ts src/gem/__tests__/contextHygiene.test.ts
git -c user.name="Raymond Feng" -c user.email="raymond@ninemind.ai" commit -m "feat(insight): spine detectors task-sprawl, task-pingpong, reread-churn

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 5: Series detectors — `context-pinned`, `cache-churn-late`

**Files:**
- Modify: `packages/insight/src/contextHygiene.ts` (add two specs + constants)
- Modify: `packages/insight/src/detectors.ts:198` (append the two ids)
- Test: `src/gem/__tests__/contextHygiene.test.ts` (append)

**Interfaces:**
- Consumes: `SessionSequence.contextSeries` (`TurnUsage[]`), `contextCap` from `./contextCap.js`.
- Produces (exported): `PIN_LEVEL = 0.85`, `PIN_FRACTION = 0.9`, `CHURN_RATIO = 1.8`, and `DetectorSpec`s `contextPinned`, `cacheChurnLate`.
- `DETECTORS` gains ids `context-pinned`, `cache-churn-late`.
- **Degrade-to-`[]` contract:** both return `[]` when `contextSeries` is `undefined` or too short (`< 4` turns for the early/late split).

- [ ] **Step 1: Write the failing test** (append)

```ts
import { PIN_LEVEL, PIN_FRACTION, CHURN_RATIO } from "@agentgem/insight";

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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `tsc -b && npx vitest run dist/gem/__tests__/contextHygiene.test.js`
Expected: FAIL — constants/specs not exported.

- [ ] **Step 3: Write minimal implementation** (append to `contextHygiene.ts`)

```ts
// A turn is "pinned" above this fraction of the model's context cap.
export const PIN_LEVEL = 0.85;
// A session is flagged when at least this fraction of turns are pinned.
export const PIN_FRACTION = 0.9;
// Late-half cache re-creation this many times the early half = churn late.
export const CHURN_RATIO = 1.8;

export const contextPinned: DetectorSpec = {
  id: "context-pinned", title: "Window pinned at the context cap", cost: "cheap", severity: "warn",
  advice: "The window sat against its cap for most of the session, re-processing the whole history every turn. Cutting earlier keeps each turn cheap and sharp.",
  detect(session) {
    const series = session.contextSeries;
    if (!series || series.length < 4) return [];
    const cap = contextCap(session.model);
    const level = cap * PIN_LEVEL;
    const pinned = series.filter((t) => t.ctxTokens >= level);
    if (pinned.length / series.length < PIN_FRACTION) return [];
    return [finding("context-pinned", "warn", session,
      `pinned ${pinned.length}/${series.length} turns at ≥${Math.round(PIN_LEVEL * 100)}% cap`,
      pinned.slice(0, 20).map((t) => t.msgIndex))];
  },
};

export const cacheChurnLate: DetectorSpec = {
  id: "cache-churn-late", title: "Context churning hardest when fullest", cost: "cheap", severity: "warn",
  advice: "The window was torn down and rebuilt far more in the back half than the front, a degradation signature. A cleaner cut resets it.",
  detect(session) {
    const series = session.contextSeries;
    if (!series || series.length < 4) return [];
    const half = Math.floor(series.length / 2);
    const sum = (arr: typeof series) => arr.reduce((a, t) => a + t.cacheCreation, 0);
    const early = sum(series.slice(0, half));
    const late = sum(series.slice(half));
    if (early <= 0) return [];
    const ratio = late / early;
    if (ratio < CHURN_RATIO) return [];
    return [finding("cache-churn-late", "warn", session,
      `late cache re-creation ${ratio.toFixed(1)}× early`,
      series.slice(half).slice(0, 20).map((t) => t.msgIndex))];
  },
};
```

In `packages/insight/src/detectors.ts`, extend the import and the `DETECTORS` array:

```ts
import { taskSprawl, taskPingpong, rereadChurn, contextPinned, cacheChurnLate } from "./contextHygiene.js";
```
```ts
export const DETECTORS: DetectorSpec[] = [
  retryStorm, thrashLoop, noVerifyFinish, regressionCycle, unverifiedTail,
  taskSprawl, taskPingpong, rereadChurn, contextPinned, cacheChurnLate,
];
```

- [ ] **Step 4: Run test to verify it passes**

Run: `tsc -b && npx vitest run dist/gem/__tests__/contextHygiene.test.js`
Expected: PASS. The "bounded control" test is the guard for the core thesis — it MUST pass (long ≠ flagged).

- [ ] **Step 5: Commit**

```bash
git add packages/insight/src/contextHygiene.ts packages/insight/src/detectors.ts src/gem/__tests__/contextHygiene.test.ts
git -c user.name="Raymond Feng" -c user.email="raymond@ninemind.ai" commit -m "feat(insight): series detectors context-pinned, cache-churn-late

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 6: Hygiene score + rubric-report surfacing

**Files:**
- Modify: `packages/insight/src/contextHygiene.ts` (add `hygieneScore`)
- Modify: `packages/insight/src/rubricReport.ts` (attach score to `RubricReport`)
- Test: `src/gem/__tests__/contextHygiene.test.ts` (append)

**Interfaces:**
- Produces:
  - `export interface HygieneVerdict { score: number; verdict: "bounded" | "mixed" | "bloated" }`
  - `export function hygieneScore(summaries: DetectorSummary[]): HygieneVerdict` — pure, 0–100 from the five hygiene `DetectorSummary` rows (uses `.count`/`.sessions`), verdict `bounded` ≥72, `mixed` ≥48, else `bloated`.
- `RubricReport` gains `hygiene?: HygieneVerdict`, computed from its own `factors`.

- [ ] **Step 1: Write the failing test** (append)

```ts
import { hygieneScore } from "@agentgem/insight";
import type { DetectorSummary } from "@agentgem/insight";

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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `tsc -b && npx vitest run dist/gem/__tests__/contextHygiene.test.js`
Expected: FAIL — `hygieneScore` not exported.

- [ ] **Step 3: Write minimal implementation** (append to `contextHygiene.ts`)

```ts
import type { DetectorSummary } from "./detectors.js";

export interface HygieneVerdict { score: number; verdict: "bounded" | "mixed" | "bloated" }

// Weights: pinning and late churn are the strongest window-health signals;
// sprawl next; pingpong/reread are softer. Any fire deducts its weight once
// (this is a per-report roll-up over DetectorSummary, not per-occurrence).
const WEIGHTS: Record<string, number> = {
  "context-pinned": 22, "cache-churn-late": 18, "task-sprawl": 18, "task-pingpong": 12, "reread-churn": 8,
};

export function hygieneScore(summaries: DetectorSummary[]): HygieneVerdict {
  let score = 100;
  for (const s of summaries) if (s.count > 0 && WEIGHTS[s.id]) score -= WEIGHTS[s.id];
  score = Math.max(0, score);
  const verdict = score >= 72 ? "bounded" : score >= 48 ? "mixed" : "bloated";
  return { score, verdict };
}
```

In `packages/insight/src/rubricReport.ts`: import `hygieneScore` + `HygieneVerdict`, add `hygiene?: HygieneVerdict` to the `RubricReport` interface (after `factors`), and set it where the report object is built (search with `grep -an "factors," packages/insight/src/rubricReport.ts` to find the return site) from the assembled `factors`:

```ts
import { hygieneScore, type HygieneVerdict } from "./contextHygiene.js";
// in RubricReport interface, after `factors: DetectorSummary[];`
  hygiene?: HygieneVerdict;
// where the report object literal is returned, add:
  hygiene: hygieneScore(factors),
```

- [ ] **Step 4: Run test to verify it passes**

Run: `tsc -b && npx vitest run dist/gem/__tests__/contextHygiene.test.js`
Then the rubric suite: `npx vitest run dist/gem/__tests__/scorecardBuild.test.js dist/gem/__tests__/scorecardRoute.test.js`
Expected: PASS (new `hygiene` field is additive/optional — existing assertions unaffected).

- [ ] **Step 5: Commit**

```bash
git add packages/insight/src/contextHygiene.ts packages/insight/src/rubricReport.ts src/gem/__tests__/contextHygiene.test.ts
git -c user.name="Raymond Feng" -c user.email="raymond@ninemind.ai" commit -m "feat(insight): hygiene score + rubric-report surfacing

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 7: Populate `contextSeries` in `scanWorkflow` (integration)

**Files:**
- Modify: `packages/insight/src/workflowScan.ts` (`scanWorkflow`, lines ~382, ~401, ~462 — confirm with `grep -an`)
- Test: `src/gem/__tests__/contextSeriesScan.test.ts`

**Interfaces:**
- Consumes: `contextTokens` (Task 2), `TurnUsage` (Task 2). No new exports.
- Produces: after this task, `scanWorkflow(paths, inv, { retainSequences: true })` returns sessions whose `contextSeries` is populated from each assistant turn's `usage`, so `context-pinned` and `cache-churn-late` fire on real scans.

- [ ] **Step 1: Write the failing test**

Create `src/gem/__tests__/contextSeriesScan.test.ts`. It writes a tiny two-assistant-turn transcript to a temp dir and scans it. (Follow the temp-fixture pattern already used by the real-FS insight tests; `os.tmpdir()` + `fs.mkdtempSync`.)

```ts
// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
// src/gem/__tests__/contextSeriesScan.test.ts
import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { scanWorkflow } from "@agentgem/insight";

const emptyInv = { project: { root: "/r", skills: [], mcpServers: [], hooks: [] }, global: { skills: [], mcpServers: [], hooks: [] } } as any;

function writeTranscript(dir: string): string {
  const lines = [
    { sessionId: "sess1", type: "user", message: { role: "user", content: "do a thing" } },
    { type: "assistant", message: { role: "assistant", content: [{ type: "tool_use", name: "Read", input: { file_path: "packages/a/f.ts" } }],
        usage: { input_tokens: 100, cache_read_input_tokens: 500_000, cache_creation_input_tokens: 2000, output_tokens: 40 } } },
    { type: "assistant", message: { role: "assistant", content: [{ type: "tool_use", name: "Read", input: { file_path: "packages/a/g.ts" } }],
        usage: { input_tokens: 100, cache_read_input_tokens: 900_000, cache_creation_input_tokens: 6000, output_tokens: 20 } } },
  ].map((o) => JSON.stringify(o)).join("\n");
  const p = join(dir, "sess1.jsonl");
  writeFileSync(p, lines);
  return p;
}

describe("scanWorkflow contextSeries", () => {
  it("populates a TurnUsage per assistant turn when retainSequences is on", () => {
    const dir = mkdtempSync(join(tmpdir(), "ctxseries-"));
    const path = writeTranscript(dir);
    const signal = scanWorkflow([path], emptyInv, { retainSequences: true });
    const session = signal.sequences?.sessions?.[0];
    expect(session?.contextSeries).toBeDefined();
    expect(session!.contextSeries!).toHaveLength(2);
    expect(session!.contextSeries![0].ctxTokens).toBe(502_100);   // 100 + 500000 + 2000
    expect(session!.contextSeries![1].cacheCreation).toBe(6000);
    expect(session!.contextSeries![0].turn).toBe(0);
    expect(session!.contextSeries![1].turn).toBe(1);
  });
});
```

> Confirm the real `ScanInventory` shape first with `grep -an "interface ScanInventory\|type ScanInventory" packages/insight/src/*.ts`; adjust `emptyInv` to match (the `as any` cast keeps the test resilient, but match field names so `scanWorkflow` doesn't throw).

- [ ] **Step 2: Run test to verify it fails**

Run: `tsc -b && npx vitest run dist/gem/__tests__/contextSeriesScan.test.js`
Expected: FAIL — `contextSeries` is `undefined` (not yet populated).

- [ ] **Step 3: Write minimal implementation**

In `packages/insight/src/workflowScan.ts`, inside `scanWorkflow`'s per-session block:

1. Import the helper is unnecessary (`contextTokens` is defined in the same file from Task 2).
2. Next to `const steps: ProcedureStep[] = [];` (line ~382) add:
   ```ts
   const contextSeries: TurnUsage[] = [];
   ```
3. In the assistant branch, right after `const role = rec?.message?.role ?? rec?.role;` and `const content = rec?.message?.content;` (line ~401), add — gated on `retainSequences`, using the running assistant-turn count as `turn`:
   ```ts
   if (opts.retainSequences && role === "assistant") {
     const usage = rec?.message?.usage as Record<string, number> | undefined;
     if (usage) contextSeries.push({
       turn: contextSeries.length, msgIndex: lineIdx,
       ctxTokens: contextTokens(usage),
       cacheCreation: usage.cache_creation_input_tokens ?? 0,
       outTokens: usage.output_tokens ?? 0,
     });
   }
   ```
4. At the session push site (line ~462), include the series when non-empty. Change:
   ```ts
   const coords = { sessionId: sessionId || basename.replace(/\.jsonl$/, ""), transcript: basename, atMs: ms, model: sessionPrimaryModel(currentSessionRecords) };
   seqSessions.push(missionHint ? { steps, missionHint, ...coords } : { steps, ...coords });
   ```
   to:
   ```ts
   const coords = { sessionId: sessionId || basename.replace(/\.jsonl$/, ""), transcript: basename, atMs: ms, model: sessionPrimaryModel(currentSessionRecords), ...(contextSeries.length ? { contextSeries } : {}) };
   seqSessions.push(missionHint ? { steps, missionHint, ...coords } : { steps, ...coords });
   ```

> Edit with `Edit` on the exact strings; do not reformat surrounding lines. Remember `grep -a` when re-reading this file.

- [ ] **Step 4: Run test to verify it passes**

Run: `tsc -b && npx vitest run dist/gem/__tests__/contextSeriesScan.test.js`
Expected: PASS. Then the full insight-adjacent suites to confirm no regression:
`npx vitest run dist/gem/__tests__/detectors.test.js dist/gem/__tests__/contextHygiene.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/insight/src/workflowScan.ts src/gem/__tests__/contextSeriesScan.test.ts
git -c user.name="Raymond Feng" -c user.email="raymond@ninemind.ai" commit -m "feat(insight): populate SessionSequence.contextSeries in scanWorkflow

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Final verification

- [ ] Run the whole suite: `npm test`. Expected: all green, including the pre-existing `detectors.test.ts`, `scorecardBuild.test.ts`, `scorecardRoute.test.ts`.
- [ ] Confirm the five new ids appear in a real report: they now flow through `insightsCore.ts` (`runDetectors`) and `rubricCore.ts` (`evaluateRubric`) with no change to those files, because they only ever iterate `DETECTORS`.
- [ ] Confirm no `arg`/path strings leak into any `detail` (the privacy tests assert this per detector).

## Out of scope (Phase 2 — separate specs)

- **Tier 2 `session-boundary-judge`** (`cost:"llm"`, threshold-gated confirmer): semantic "these K clusters were really N tasks — cut at turn X" verdict.
- **Live Watch-SSE nudge + EMBER** (`mockups/ember-session-game.html`): the same five signals on a streaming buffer, nudging a break mid-session.
- **`detectorRules.ts` context-hygiene pack**: exposing the thresholds as declarative rules for user/Gem tuning.
- **Console UI** rendering of the `hygiene` verdict (the data now rides `RubricReport`; presentation is a console task).
```
