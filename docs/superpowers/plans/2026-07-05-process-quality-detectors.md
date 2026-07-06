# Process-Quality Detectors (AgentLens-style) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Grade *how* a session got to its outcome, not just that it finished — intent-stage labeling (exploration / implementation / verification / orchestration), two new deterministic detectors (`regression-cycle`, `unverified-tail`), and a per-session `ProcessQuality` score, following AgentLens (arXiv:2605.12925), which found 10.7% of passing SWE-agent trajectories were "Lucky Passes" (regression cycles, blind retries, missing verification, disordered stages).

**Architecture:** A new pure `stageLabels.ts` module owns the step-classification predicates (moving `EDIT_RE`/`VERIFY_RE` out of `detectors.ts` so both share one definition). The two new detectors join the existing `DETECTORS` registry, so every current consumer (`src/insightsCore.ts`, `src/goldmine/behaviorFindings.ts`, `packages/insight/src/rubricReport.ts`) surfaces them with zero wiring. `processQuality.ts` folds findings + stage profile into a 0–100 score per session. Everything is pure spine-scan (`cost: "cheap"`), coordinates-only evidence, no fs, no LLM — the existing detector contract.

**Tech Stack:** TypeScript ESM (Node ≥24), Vitest. No new dependencies.

## Global Constraints

- Detectors are pure functions `SessionSequence -> DetectorFinding[]`; a broken detector degrades to `[]` and never kills the scan (module contract at the top of `detectors.ts`).
- `DetectorFinding.detail` is built from low-cardinality verbs and counts ONLY — never from `arg` (args can carry paths).
- Existing detector semantics must not change: `retry-storm`, `thrash-loop`, `no-verify-finish` keep their exact behavior (the refactor in Task 1 is a pure move).
- File headers: `// Copyright (c) 2026 NineMind, Inc.` + `// SPDX-License-Identifier: MIT`.
- Tests live in `src/__tests__/` at the repo root and import the built package, so every test run is `pnpm exec tsc -b && pnpm exec vitest run <file>` from the repo root.

## Shared test fixtures (used by every task — define once in the new test file)

```ts
// src/__tests__/processQuality.test.ts
// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
import { describe, it, expect } from "vitest";
import type { ProcedureStep, SessionSequence, WorkflowSignal } from "@agentgem/insight";

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
```

(`runDetectors` only touches `signal.sequences?.sessions`, so the cast-built signal is sufficient — same trick the detectors themselves rely on.)

---

### Task 1: `stageLabels.ts` — intent stages + shared predicates (pure refactor of detectors' regexes)

**Files:**
- Create: `packages/insight/src/stageLabels.ts`
- Modify: `packages/insight/src/detectors.ts` (delete local `EDIT_RE`/`VERIFY_RE`/`isEdit`/`isVerify`, import them instead)
- Modify: `packages/insight/src/index.ts` (one export line)
- Test: `src/__tests__/processQuality.test.ts` (new, with the shared fixtures above)

**Interfaces:**
- Consumes: `ProcedureStep` from `./workflowScan.js`.
- Produces (exact names later tasks use): `type IntentStage = "exploration" | "implementation" | "verification" | "orchestration" | "other"`; `interface StageProfile { exploration: number; implementation: number; verification: number; orchestration: number; other: number }`; `isEdit(s: ProcedureStep): boolean`; `isVerify(s: ProcedureStep): boolean`; `stageOf(s: ProcedureStep): IntentStage`; `stageProfile(steps: ProcedureStep[]): StageProfile`.

- [ ] **Step 1: Write the failing tests**

```ts
import { stageOf, stageProfile } from "@agentgem/insight";

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
```

- [ ] **Step 2: Run to verify failure**

Run: `cd /Users/rfeng/Projects/ninemind/agentgem && pnpm exec tsc -b 2>&1 | head -5`
Expected: FAIL — `@agentgem/insight` has no export `stageOf`.

- [ ] **Step 3: Write the implementation**

```ts
// packages/insight/src/stageLabels.ts
// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
//
// AgentLens-style intent stages over verb spines (arXiv:2605.12925 labels agent
// actions Exploration / Implementation / Verification / Orchestration). Pure —
// the single home of the step-classification predicates; detectors.ts imports
// isEdit/isVerify from here so both layers agree on what "an edit" is.
import type { ProcedureStep } from "./workflowScan.js";

export type IntentStage = "exploration" | "implementation" | "verification" | "orchestration" | "other";
export interface StageProfile { exploration: number; implementation: number; verification: number; orchestration: number; other: number }

export const EDIT_RE = /^(Edit|Write|NotebookEdit)$/;
// "Did they check their work?" — matched against `${verb} ${arg}` of Bash steps.
export const VERIFY_RE = /\b(tests?|vitest|jest|pytest|tsc|build|lint|typecheck|check)\b/i;

const EXPLORE_TOOL_RE = /^(Read|Grep|Glob|LS|NotebookRead|WebFetch|WebSearch)$/;
const EXPLORE_BASH_RE = /\b(ls|cat|head|tail|grep|rg|find|tree|git (log|show|diff|status|blame))\b/;
const ORCHESTRATE_RE = /^(Task|Agent)$/;

export function isEdit(s: ProcedureStep): boolean { return EDIT_RE.test(s.verb); }
export function isVerify(s: ProcedureStep): boolean {
  return s.verb.startsWith("Bash:") && VERIFY_RE.test(`${s.verb} ${s.arg}`);
}

export function stageOf(s: ProcedureStep): IntentStage {
  if (ORCHESTRATE_RE.test(s.verb)) return "orchestration";
  if (isEdit(s)) return "implementation";
  if (isVerify(s)) return "verification";
  if (EXPLORE_TOOL_RE.test(s.verb)) return "exploration";
  if (s.verb.startsWith("Bash:") && EXPLORE_BASH_RE.test(`${s.verb} ${s.arg}`)) return "exploration";
  return "other";
}

export function stageProfile(steps: ProcedureStep[]): StageProfile {
  const p: StageProfile = { exploration: 0, implementation: 0, verification: 0, orchestration: 0, other: 0 };
  for (const s of steps) p[stageOf(s)]++;
  return p;
}
```

In `packages/insight/src/detectors.ts`: delete the local block (lines ~84–91):

```ts
const EDIT_RE = /^(Edit|Write|NotebookEdit)$/;
// "Did they check their work?" — matched against `${verb} ${arg}` of Bash steps.
const VERIFY_RE = /\b(tests?|vitest|jest|pytest|tsc|build|lint|typecheck|check)\b/i;

function isEdit(s: ProcedureStep): boolean { return EDIT_RE.test(s.verb); }
function isVerify(s: ProcedureStep): boolean {
  return s.verb.startsWith("Bash:") && VERIFY_RE.test(`${s.verb} ${s.arg}`);
}
```

and add to the imports at the top:

```ts
import { isEdit, isVerify } from "./stageLabels.js";
```

Then add to `packages/insight/src/index.ts` (next to `export * from "./detectors.js";`):

```ts
export * from "./stageLabels.js";
```

- [ ] **Step 4: Run new tests AND the full suite (the refactor must not shift existing detector behavior)**

Run: `pnpm exec tsc -b && pnpm exec vitest run src/__tests__/processQuality.test.ts`
Expected: PASS.
Run: `pnpm test`
Expected: PASS — especially `src/__tests__/insightsCore.test.ts` and `src/__tests__/rubrics.test.ts`.

- [ ] **Step 5: Commit**

```bash
git add packages/insight/src/stageLabels.ts packages/insight/src/detectors.ts packages/insight/src/index.ts src/__tests__/processQuality.test.ts
git commit -m "feat(insight): intent-stage labeling; hoist edit/verify predicates to stageLabels"
```

---

### Task 2: `regression-cycle` detector

**Files:**
- Modify: `packages/insight/src/detectors.ts` (new spec + registry entry)
- Test: `src/__tests__/processQuality.test.ts` (append)

**Interfaces:**
- Consumes: `isEdit`, `isVerify` (Task 1); existing `mkFinding`, `DetectorSpec`, `DETECTORS` in `detectors.ts`.
- Produces: exported `REGRESSION_MIN = 2`; detector id `"regression-cycle"` registered in `DETECTORS`.

Semantics (the honest spine-level proxy for AgentLens "regression cycles"): a file is **completed** when an edit to it is later followed by a verification step. Each *subsequent* edit to an already-completed file counts as a rework. Fire once per file with ≥ `REGRESSION_MIN` reworks — "the agent kept going back to redo finished work."

- [ ] **Step 1: Write the failing tests (append)**

```ts
import { runDetectors, REGRESSION_MIN } from "@agentgem/insight";

const byId = (findings: { detectorId: string }[], id: string) => findings.filter((f) => f.detectorId === id);

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
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm exec tsc -b 2>&1 | head -5`
Expected: FAIL — no export `REGRESSION_MIN`.

- [ ] **Step 3: Write the implementation (insert in `detectors.ts` after the `thrashLoop` spec)**

```ts
// A file whose edit was followed by a verify step is "completed"; this many
// LATER edits to it read as regressing on finished work (AgentLens regression
// cycles, arXiv:2605.12925 — steps carry no test results, so completed-then-
// re-edited is the honest spine-level proxy).
export const REGRESSION_MIN = 2;

const regressionCycle: DetectorSpec = {
  id: "regression-cycle",
  title: "Completed file reworked again later",
  cost: "cheap",
  severity: "warn",
  advice: "When you return to a file you already finished and verified, first re-read it and state what the earlier change missed — repeated rework of completed files usually means the verification was too shallow the first time.",
  detect(session) {
    const completed = new Set<string>();
    const editedSinceVerify = new Set<string>();
    const reworks = new Map<string, number[]>();   // file -> msgIndices of reworking edits
    for (const s of session.steps) {
      if (isEdit(s)) {
        if (completed.has(s.arg)) {
          const list = reworks.get(s.arg) ?? [];
          list.push(s.msgIndex);
          reworks.set(s.arg, list);
        }
        editedSinceVerify.add(s.arg);
      } else if (isVerify(s)) {
        for (const f of editedSinceVerify) completed.add(f);
        editedSinceVerify.clear();
      }
    }
    const out: DetectorFinding[] = [];
    for (const [, msgIndices] of reworks) {
      if (msgIndices.length >= REGRESSION_MIN) {
        out.push(mkFinding(regressionCycle, session,
          `completed file reworked ${msgIndices.length}x after verification`, msgIndices));
      }
    }
    return out;
  },
};
```

and change the registry line to:

```ts
export const DETECTORS: DetectorSpec[] = [retryStorm, thrashLoop, noVerifyFinish, regressionCycle];
```

- [ ] **Step 4: Run to verify pass**

Run: `pnpm exec tsc -b && pnpm exec vitest run src/__tests__/processQuality.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/insight/src/detectors.ts src/__tests__/processQuality.test.ts
git commit -m "feat(insight): regression-cycle detector (AgentLens regression cycles)"
```

---

### Task 3: `unverified-tail` detector

**Files:**
- Modify: `packages/insight/src/detectors.ts` (new spec + registry entry)
- Test: `src/__tests__/processQuality.test.ts` (append)

**Interfaces:**
- Consumes: `isEdit`, `isVerify` (Task 1); `mkFinding`.
- Produces: detector id `"unverified-tail"` registered in `DETECTORS`.

Semantics: the session *did* verify at some point, but then kept editing after the **last** verification — the tail edits shipped unchecked. Complements `no-verify-finish` (which covers the zero-verification case) and is the spine-level proxy for AgentLens "temporally disordered implementation/verification".

- [ ] **Step 1: Write the failing tests (append)**

```ts
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
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm exec tsc -b && pnpm exec vitest run src/__tests__/processQuality.test.ts 2>&1 | tail -5`
Expected: FAIL — `unverified-tail` findings empty.

- [ ] **Step 3: Write the implementation (insert after `regressionCycle`)**

```ts
const unverifiedTail: DetectorSpec = {
  id: "unverified-tail",
  title: "Edits after the last verification",
  cost: "cheap",
  severity: "info",
  advice: "Re-run the tests or build after your final round of edits — changes made after the last verification are shipped unchecked, which is how a passing session still lands a regression.",
  detect(session) {
    let lastVerifyIdx = -1;
    session.steps.forEach((s, idx) => { if (isVerify(s)) lastVerifyIdx = idx; });
    if (lastVerifyIdx < 0) return [];                    // zero-verify case belongs to no-verify-finish
    const tail = session.steps.slice(lastVerifyIdx + 1).filter(isEdit);
    if (!tail.length) return [];
    return [mkFinding(unverifiedTail, session,
      `${tail.length} edit step(s) after the last verification`, tail.map((s) => s.msgIndex))];
  },
};
```

and change the registry line to:

```ts
export const DETECTORS: DetectorSpec[] = [retryStorm, thrashLoop, noVerifyFinish, regressionCycle, unverifiedTail];
```

- [ ] **Step 4: Run to verify pass, plus the full suite (registry grew — consumers must tolerate the new ids; they do, `id` is an open string by design)**

Run: `pnpm exec tsc -b && pnpm exec vitest run src/__tests__/processQuality.test.ts`
Expected: PASS.
Run: `pnpm test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/insight/src/detectors.ts src/__tests__/processQuality.test.ts
git commit -m "feat(insight): unverified-tail detector"
```

---

### Task 4: `processQuality.ts` — per-session score + report

**Files:**
- Create: `packages/insight/src/processQuality.ts`
- Modify: `packages/insight/src/index.ts` (one export line)
- Test: `src/__tests__/processQuality.test.ts` (append)

**Interfaces:**
- Consumes: `SessionSequence`, `WorkflowSignal` from `./workflowScan.js`; `DetectorFinding` from `./detectors.js`; `stageProfile`, `StageProfile` (Task 1).
- Produces: `type ProcessLabel = "disciplined" | "loose" | "chaotic"`; `interface ProcessQuality { sessionId: string; transcript: string; score: number; label: ProcessLabel; stages: StageProfile }`; `sessionProcessQuality(session: SessionSequence, findings: DetectorFinding[]): ProcessQuality`; `processQualityReport(signal: WorkflowSignal, findings: DetectorFinding[]): { sessions: ProcessQuality[]; atRiskRate: number }`.

Scoring (deterministic, explainable — deliberately not a learned model): start at 100; −20 per `warn` finding in the session, −10 per `info`; +0 floor. Labels: ≥80 `disciplined`, ≥50 `loose`, else `chaotic`. `atRiskRate` = fraction of sessions not labeled `disciplined` — the local analog of AgentLens's lucky-rate, without claiming outcome ground truth we don't have.

- [ ] **Step 1: Write the failing tests (append)**

```ts
import { sessionProcessQuality, processQualityReport, DETECTORS } from "@agentgem/insight";

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
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm exec tsc -b 2>&1 | head -5`
Expected: FAIL — no export `sessionProcessQuality`.

- [ ] **Step 3: Write the implementation**

```ts
// packages/insight/src/processQuality.ts
// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
//
// Per-session process-quality: detector findings + stage profile folded into a
// deterministic 0–100 score. Motivated by AgentLens (arXiv:2605.12925): outcome-
// only grading misses lucky passes, so grade the process. Deliberately NOT a
// learned model — every deduction is traceable to a finding the UI can show.
import type { SessionSequence, WorkflowSignal } from "./workflowScan.js";
import type { DetectorFinding } from "./detectors.js";
import { stageProfile, type StageProfile } from "./stageLabels.js";

export type ProcessLabel = "disciplined" | "loose" | "chaotic";

export interface ProcessQuality {
  sessionId: string;
  transcript: string;      // basename provenance, mirrors DetectorFinding
  score: number;           // 0–100
  label: ProcessLabel;     // ≥80 disciplined · ≥50 loose · else chaotic
  stages: StageProfile;
}

const WARN_COST = 20;
const INFO_COST = 10;

export function sessionProcessQuality(session: SessionSequence, findings: DetectorFinding[]): ProcessQuality {
  let score = 100;
  for (const f of findings) {
    if (f.sessionId !== session.sessionId) continue;
    score -= f.severity === "warn" ? WARN_COST : INFO_COST;
  }
  score = Math.max(0, score);
  const label: ProcessLabel = score >= 80 ? "disciplined" : score >= 50 ? "loose" : "chaotic";
  return { sessionId: session.sessionId, transcript: session.transcript, score, label, stages: stageProfile(session.steps) };
}

/** Fold a whole signal: one ProcessQuality per retained session, plus the share
 *  of sessions that are not disciplined (the local analog of AgentLens's lucky
 *  rate — process risk, with no claim about task success we cannot observe). */
export function processQualityReport(
  signal: WorkflowSignal, findings: DetectorFinding[],
): { sessions: ProcessQuality[]; atRiskRate: number } {
  const sessions = (signal.sequences?.sessions ?? []).map((s) => sessionProcessQuality(s, findings));
  const atRisk = sessions.filter((q) => q.label !== "disciplined").length;
  return { sessions, atRiskRate: sessions.length ? atRisk / sessions.length : 0 };
}
```

Then add to `packages/insight/src/index.ts` (next to the detectors export):

```ts
export * from "./processQuality.js";
```

- [ ] **Step 4: Run to verify pass, then the full suite**

Run: `pnpm exec tsc -b && pnpm exec vitest run src/__tests__/processQuality.test.ts`
Expected: PASS (all tasks' tests).
Run: `pnpm test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/insight/src/processQuality.ts packages/insight/src/index.ts src/__tests__/processQuality.test.ts
git commit -m "feat(insight): per-session ProcessQuality score + report"
```

---

### Task 5: Docs note + follow-up marker

**Files:**
- Modify: `docs/analyze.md` (or the doc that describes Insights/detectors — pick the file that lists `retry-storm`/`thrash-loop` if one does; otherwise `docs/concepts.md`)

- [ ] **Step 1: Document the two new detectors and the ProcessQuality score**: what each fires on, the −20/−10/label thresholds, and the AgentLens citation (arXiv:2605.12925 — 10.7% lucky passes) as the motivation. Note explicitly that surfacing `ProcessQuality` in the console scorecard/goldmine UI is a **follow-up proposal** (the detectors themselves already surface through the existing findings pipeline: `insightsCore`, `behaviorFindings`, `rubricReport`).

- [ ] **Step 2: Commit**

```bash
git add docs/
git commit -m "docs: process-quality detectors + score (AgentLens-motivated)"
```

---

## Self-review notes

- Spec coverage: stage labeling ✔ (Task 1), regression cycles ✔ (Task 2), disordered/unverified tail ✔ (Task 3), missing verification ✔ (pre-existing `no-verify-finish`), blind retries ✔ (pre-existing `retry-storm`), session-level grade ✔ (Task 4). AgentLens's PTA cross-session references and success-conditioned "lucky" labels are intentionally out of scope: they need pass/fail ground truth AgentGem doesn't observe locally.
- Type consistency: `isEdit`/`isVerify`/`stageProfile`/`StageProfile` defined in Task 1 are consumed under those exact names in Tasks 2–4; `REGRESSION_MIN` exported in Task 2 is referenced in its own test only.
- The Task 1 refactor is behavior-preserving by construction (same regex source strings, same function bodies); the full-suite run in Task 1 Step 4 is the guard.
