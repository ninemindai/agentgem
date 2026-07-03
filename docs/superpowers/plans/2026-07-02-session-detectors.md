# Pluggable Session-Behavior Detectors Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A pluggable detector layer that scans session verb spines for problematic programmer behaviors (retry storms, thrash loops, unverified finishes), supports user-defined declarative rules, and surfaces categorized findings + advice through the insights payload.

**Architecture:** A `DetectorSpec[]` registry in `packages/insight` (same house pattern as `WARMABLES` in `src/warm/registry.ts` and `TargetSpec` in `src/gem/targets.ts`). Detectors are pure functions over the already-scrubbed `SessionSequence` steps produced by `scanWorkflow`. A separate rule-loader module compiles declarative JSON rules from `~/.agentgem/detectors/` into `DetectorSpec`s (data, not code — nothing to sandbox). `computeInsights` in `src/insightsCore.ts` runs detectors after the scan and adds `findings` + `detectorSummary` to `InsightsPayload`.

**Tech Stack:** TypeScript (ESM, strict), vitest (runs COMPILED tests from `dist/`), pnpm workspace, no new dependencies.

## Global Constraints

- Node >= 24; ESM only; all imports of local files use `.js` extensions (compiled output convention).
- **Tests run from compiled `dist/`**: vitest include is `dist/**/__tests__/**/*.test.js`. Always `pnpm build` before running tests. Test SOURCE files live in `src/gem/__tests__/*.test.ts` (yes, in root `src/`, even for `packages/insight` code — see `src/gem/__tests__/facets.test.ts`) and import from `@agentgem/insight`.
- Every new source file starts with the two-line header:
  `// Copyright (c) 2026 NineMind, Inc.` / `// SPDX-License-Identifier: MIT` followed by a `// <path>` line and a short module comment.
- **Never-throw contract**: analysis-path code degrades (empty result + `console.error`), it never throws to the caller. Mirrors `judgeSession.ts` / `loadRuleDetectors` must survive missing dirs, bad JSON, bad rules.
- **Detector `id` is an open `string`, NOT a string-literal union** (lesson from the channel-artifact closed-union dispatch pain — third-party detectors must not require touching dispatch sites).
- **No raw user text in findings**: `detail` strings are built only from low-cardinality verbs and counts, never from `arg` values (args may contain paths). Evidence is coordinates only (`msgIndices`), mirroring `Provenance` in `distillTypes.ts`.
- Work in a dedicated worktree branched off freshly fetched `origin/main` (repo rule — see CLAUDE.md). Repo integration is REBASE-ONLY.
- Commit author must be Raymond Feng <raymond@ninemind.ai>.

## Reference: existing types detectors consume (do not redefine — import from `@agentgem/insight`)

```ts
// packages/insight/src/workflowScan.ts (already exists)
export interface ProcedureStep { tool: string; verb: string; arg: string; msgIndex: number }
export interface MissionHint { task: string; outcome: string }
export interface SessionSequence { steps: ProcedureStep[]; missionHint?: MissionHint; sessionId: string; transcript: string; atMs: number; model?: string }
export interface WorkflowSignal { root: string; flavor: "claude" | "codex"; sessions: {...}; artifacts: [...]; models: [...]; unresolved: [...]; coOccurrence: [...]; sequences?: { root: string; sessions: SessionSequence[] }; procedures?: [...]; shapes: [...]; notes: string[] }
```

Verb vocabulary (from `scrubStep` in `packages/insight/src/scrub.ts`): Bash steps get `Bash:<first-word>` (e.g. `Bash:npm`, `Bash:git`); Edit/Write/NotebookEdit/Read/Grep/Glob keep the tool name as verb; `arg` is the scrubbed command/path.

---

### Task 1: Workspace setup

**Files:** none created — worktree + baseline only.

**Interfaces:**
- Consumes: nothing.
- Produces: a clean worktree at `../agentgem-detectors` on branch `feat/session-detectors`, green baseline build+tests. All later tasks run inside this worktree.

- [ ] **Step 1: Create the worktree off freshly fetched origin/main**

```bash
cd /Users/rfeng/Projects/ninemind/agentgem
git fetch origin
git worktree add ../agentgem-detectors -b feat/session-detectors origin/main
cd ../agentgem-detectors
```

- [ ] **Step 2: Install and build**

```bash
pnpm install
pnpm build
```
Expected: tsc completes with no errors.

- [ ] **Step 3: Baseline test run**

```bash
pnpm test
```
Expected: green. KNOWN FLAKE (do not chase): `observeScan` / `scorecard` / `observe.controller` tests can time out at 15s under full-suite concurrency because they scan the real `~/.claude`. If one times out, re-run just that file in isolation to confirm it passes, then proceed.

---

### Task 2: Detector core — types, `runDetectors`, and the `retry-storm` built-in

**Files:**
- Create: `packages/insight/src/detectors.ts`
- Modify: `packages/insight/src/index.ts` (add one export line)
- Test: `src/gem/__tests__/detectors.test.ts`

**Interfaces:**
- Consumes: `ProcedureStep`, `SessionSequence`, `WorkflowSignal` from `./workflowScan.js`.
- Produces (later tasks rely on these exact names):
  - `type DetectorSeverity = "info" | "warn"`
  - `interface DetectorFinding { detectorId: string; sessionId: string; transcript: string; atMs: number; severity: DetectorSeverity; detail: string; evidence: { msgIndices: number[] } }`
  - `interface DetectorSpec { id: string; title: string; cost: "cheap" | "llm"; severity: DetectorSeverity; advice: string; detect(session: SessionSequence, signal: WorkflowSignal): DetectorFinding[] }`
  - `const DETECTORS: DetectorSpec[]`
  - `function runDetectors(signal: WorkflowSignal, extra?: DetectorSpec[]): DetectorFinding[]`
  - `const RETRY_STORM_MIN = 3`

- [ ] **Step 1: Write the failing tests**

Create `src/gem/__tests__/detectors.test.ts`:

```ts
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
```

- [ ] **Step 2: Run to verify failure**

```bash
pnpm build 2>&1 | head -20
```
Expected: tsc FAILS — `@agentgem/insight` has no exported member `runDetectors`. (Compile failure IS the red step here, since tests run from dist.)

- [ ] **Step 3: Implement `packages/insight/src/detectors.ts`**

```ts
// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
// packages/insight/src/detectors.ts
//
// Pluggable session-behavior detectors: a registry of typed specs (the same
// house pattern as WARMABLES / TargetSpec) run over the scrubbed verb spines
// that scanWorkflow retains. Pure — no fs, no LLM. Each detector is a pure
// function SessionSequence -> findings; a broken detector degrades to [] and
// never kills the scan. `id` is an open string on purpose: third-party
// detectors (declarative rules, future Gem packs) must not require touching
// a closed union at every dispatch site.
import type { ProcedureStep, SessionSequence, WorkflowSignal } from "./workflowScan.js";

export type DetectorSeverity = "info" | "warn";

// Coordinates-only evidence (msgIndices into the session transcript), mirroring
// distillTypes.Occurrence. `detail` is built from low-cardinality verbs and
// counts ONLY — never from `arg` (args can carry paths).
export interface DetectorFinding {
  detectorId: string;
  sessionId: string;
  transcript: string;                 // basename provenance — backfilled from the session
  atMs: number;
  severity: DetectorSeverity;
  detail: string;
  evidence: { msgIndices: number[] };
}

export interface DetectorSpec {
  id: string;                         // open string — see module comment
  title: string;
  cost: "cheap" | "llm";              // cheap = pure spine scan; llm reserved for future agent-judged detectors
  severity: DetectorSeverity;
  advice: string;                     // the one canonical improvement suggestion for this pattern
  detect(session: SessionSequence, signal: WorkflowSignal): DetectorFinding[];
}

function mkFinding(
  spec: Pick<DetectorSpec, "id" | "severity">, session: SessionSequence,
  detail: string, msgIndices: number[],
): DetectorFinding {
  return {
    detectorId: spec.id, sessionId: session.sessionId, transcript: session.transcript,
    atMs: session.atMs, severity: spec.severity, detail, evidence: { msgIndices },
  };
}

function sameStep(a: ProcedureStep, b: ProcedureStep): boolean {
  return a.tool === b.tool && a.verb === b.verb && a.arg === b.arg;
}

// The same exact command re-run this many times back-to-back reads as retrying
// without changing anything (steps carry no exit codes, so identical repetition
// is the honest proxy for "retried unchanged").
export const RETRY_STORM_MIN = 3;

const retryStorm: DetectorSpec = {
  id: "retry-storm",
  title: "Same command repeated back-to-back",
  cost: "cheap",
  severity: "warn",
  advice: "When a command doesn't do what you expected, read its full output before re-running it — change one thing per attempt instead of retrying unchanged.",
  detect(session) {
    const out: DetectorFinding[] = [];
    const steps = session.steps;
    let i = 0;
    while (i < steps.length) {
      let j = i + 1;
      while (j < steps.length && sameStep(steps[i], steps[j])) j++;
      if (j - i >= RETRY_STORM_MIN) {
        out.push(mkFinding(retryStorm, session,
          `${steps[i].verb} repeated ${j - i}x back-to-back`,
          steps.slice(i, j).map((s) => s.msgIndex)));
      }
      i = j;
    }
    return out;
  },
};

export const DETECTORS: DetectorSpec[] = [retryStorm];

/**
 * Run every registered detector (plus any extras — e.g. compiled declarative
 * rules) over each retained session. Never throws: a failing detector logs and
 * contributes nothing. Returns findings in (session order, detector order).
 */
export function runDetectors(signal: WorkflowSignal, extra: DetectorSpec[] = []): DetectorFinding[] {
  const sessions = signal.sequences?.sessions ?? [];
  const specs = [...DETECTORS, ...extra];
  const out: DetectorFinding[] = [];
  for (const session of sessions) {
    for (const spec of specs) {
      try { out.push(...spec.detect(session, signal)); }
      catch (err) { console.error(`detector ${spec.id} failed:`, (err as Error).message); }
    }
  }
  return out;
}
```

Add to `packages/insight/src/index.ts` (alongside the existing `export * from "./facets.js";` block, keeping alphabetical-ish neighborhood):

```ts
export * from "./detectors.js";
```

- [ ] **Step 4: Build and run the tests**

```bash
pnpm build && npx vitest run dist/gem/__tests__/detectors.test.js
```
Expected: PASS (all tests).

- [ ] **Step 5: Commit**

```bash
git add packages/insight/src/detectors.ts packages/insight/src/index.ts src/gem/__tests__/detectors.test.ts
git commit -m "feat(insight): pluggable DetectorSpec registry + retry-storm detector"
```

---

### Task 3: `thrash-loop` and `no-verify-finish` built-ins

**Files:**
- Modify: `packages/insight/src/detectors.ts`
- Test: `src/gem/__tests__/detectors.test.ts` (append)

**Interfaces:**
- Consumes: `mkFinding`, `DetectorSpec`, `DETECTORS` from Task 2 (same file).
- Produces: exported `THRASH_MIN_CYCLES = 4`; detector ids `"thrash-loop"` and `"no-verify-finish"` registered in `DETECTORS`.

- [ ] **Step 1: Write the failing tests** (append to `src/gem/__tests__/detectors.test.ts`; reuses the `step`/`sess`/`signalWith` helpers from Task 2)

```ts
import { THRASH_MIN_CYCLES } from "@agentgem/insight";

// One edit→verify cycle on the same file with the same command.
function cycle(file: string, cmd: string, at: number): ProcedureStep[] {
  return [step("Edit", "Edit", file, at), step("Bash", "Bash:npm", cmd, at + 1)];
}

describe("thrash-loop detector", () => {
  it("fires after THRASH_MIN_CYCLES same-file same-command edit→verify cycles", () => {
    const steps = Array.from({ length: THRASH_MIN_CYCLES }, (_, i) =>
      cycle("/a.ts", "npm test", i * 10)).flat();
    const hits = runDetectors(signalWith([sess(steps)])).filter((f) => f.detectorId === "thrash-loop");
    expect(hits).toHaveLength(1);
    expect(hits[0].severity).toBe("warn");
    expect(hits[0].detail).toContain(`${THRASH_MIN_CYCLES}x`);
    expect(hits[0].detail).not.toContain("/a.ts");           // no args in detail
    expect(hits[0].evidence.msgIndices).toHaveLength(THRASH_MIN_CYCLES * 2);
  });

  it("does not fire for healthy multi-file progress or below threshold", () => {
    const multiFile = Array.from({ length: THRASH_MIN_CYCLES }, (_, i) =>
      cycle(`/f${i}.ts`, "npm test", i * 10)).flat();
    const below = Array.from({ length: THRASH_MIN_CYCLES - 1 }, (_, i) =>
      cycle("/a.ts", "npm test", i * 10)).flat();
    expect(runDetectors(signalWith([sess(multiFile)]))
      .filter((f) => f.detectorId === "thrash-loop")).toHaveLength(0);
    expect(runDetectors(signalWith([sess(below)]))
      .filter((f) => f.detectorId === "thrash-loop")).toHaveLength(0);
  });
});

describe("no-verify-finish detector", () => {
  it("fires when a session edits but never verifies afterwards", () => {
    const steps = [
      step("Bash", "Bash:git", "git status", 1),
      step("Edit", "Edit", "/a.ts", 2),
      step("Write", "Write", "/b.ts", 3),
      step("Bash", "Bash:git", "git commit", 4),
    ];
    const hits = runDetectors(signalWith([sess(steps)])).filter((f) => f.detectorId === "no-verify-finish");
    expect(hits).toHaveLength(1);
    expect(hits[0].severity).toBe("info");
    expect(hits[0].detail).toContain("2 edit");
    expect(hits[0].evidence.msgIndices).toEqual([3]);        // the last edit
  });

  it("stays quiet when a verify step follows the last edit, or with no edits", () => {
    const verified = [
      step("Edit", "Edit", "/a.ts", 1),
      step("Bash", "Bash:npx", "npx vitest run", 2),
    ];
    const noEdits = [step("Bash", "Bash:git", "git log", 1)];
    expect(runDetectors(signalWith([sess(verified)]))
      .filter((f) => f.detectorId === "no-verify-finish")).toHaveLength(0);
    expect(runDetectors(signalWith([sess(noEdits)]))
      .filter((f) => f.detectorId === "no-verify-finish")).toHaveLength(0);
  });

  it("verify BEFORE the last edit does not count", () => {
    const steps = [
      step("Bash", "Bash:npm", "npm test", 1),
      step("Edit", "Edit", "/a.ts", 2),
    ];
    expect(runDetectors(signalWith([sess(steps)]))
      .filter((f) => f.detectorId === "no-verify-finish")).toHaveLength(1);
  });
});
```

- [ ] **Step 2: Run to verify failure**

```bash
pnpm build 2>&1 | head -20
```
Expected: tsc FAILS — no exported member `THRASH_MIN_CYCLES`.

- [ ] **Step 3: Implement both detectors** (add to `packages/insight/src/detectors.ts`, above the `DETECTORS` array; update the array)

```ts
const EDIT_RE = /^(Edit|Write|NotebookEdit)$/;
// "Did they check their work?" — matched against `${verb} ${arg}` of Bash steps.
const VERIFY_RE = /\b(tests?|vitest|jest|pytest|tsc|build|lint|typecheck|check)\b/i; // word-bounded: "latest"/"checkout" must not read as verification

function isEdit(s: ProcedureStep): boolean { return EDIT_RE.test(s.verb); }
function isVerify(s: ProcedureStep): boolean {
  return s.verb.startsWith("Bash:") && VERIFY_RE.test(`${s.verb} ${s.arg}`);
}

// Same file edited + same command re-run this many consecutive cycles reads as
// grinding on one spot. Healthy TDD moves across files/tests; thrash doesn't.
export const THRASH_MIN_CYCLES = 4;

const thrashLoop: DetectorSpec = {
  id: "thrash-loop",
  title: "Edit→verify ground loop on one file",
  cost: "cheap",
  severity: "warn",
  advice: "After a few failed edit→test rounds on the same file, stop editing: reproduce the failure in isolation, read the full error, and re-state your hypothesis before the next change.",
  detect(session) {
    interface Cycle { file: string; cmd: string; msgIndices: [number, number] }
    const cycles: Cycle[] = [];
    let pendingEdit: ProcedureStep | null = null;
    for (const s of session.steps) {
      if (isEdit(s)) pendingEdit = s;
      else if (pendingEdit && isVerify(s)) {
        cycles.push({ file: pendingEdit.arg, cmd: `${s.verb} ${s.arg}`, msgIndices: [pendingEdit.msgIndex, s.msgIndex] });
        pendingEdit = null;
      }
    }
    const out: DetectorFinding[] = [];
    let i = 0;
    while (i < cycles.length) {
      let j = i + 1;
      while (j < cycles.length && cycles[j].file === cycles[i].file && cycles[j].cmd === cycles[i].cmd) j++;
      if (j - i >= THRASH_MIN_CYCLES) {
        out.push(mkFinding(thrashLoop, session,
          `edit→verify on one file repeated ${j - i}x without progress elsewhere`,
          cycles.slice(i, j).flatMap((c) => c.msgIndices)));
      }
      i = j;
    }
    return out;
  },
};

const noVerifyFinish: DetectorSpec = {
  id: "no-verify-finish",
  title: "Edits with no verification afterwards",
  cost: "cheap",
  severity: "info",
  advice: "End sessions that changed code with a verification step — run the tests or build so the change is confirmed working, not assumed working.",
  detect(session) {
    let lastEditIdx = -1;
    let edits = 0;
    session.steps.forEach((s, idx) => { if (isEdit(s)) { edits++; lastEditIdx = idx; } });
    if (edits === 0) return [];
    const verifiedAfter = session.steps.some((s, idx) => idx > lastEditIdx && isVerify(s));
    if (verifiedAfter) return [];
    return [mkFinding(noVerifyFinish, session,
      `${edits} edit step(s) with no test/build run afterwards`,
      [session.steps[lastEditIdx].msgIndex])];
  },
};
```

Update the registry line:

```ts
export const DETECTORS: DetectorSpec[] = [retryStorm, thrashLoop, noVerifyFinish];
```

- [ ] **Step 4: Build and run the tests**

```bash
pnpm build && npx vitest run dist/gem/__tests__/detectors.test.js
```
Expected: PASS (Task 2 + Task 3 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/insight/src/detectors.ts src/gem/__tests__/detectors.test.ts
git commit -m "feat(insight): thrash-loop and no-verify-finish built-in detectors"
```

---

### Task 4: Declarative rule loader (`~/.agentgem/detectors/*.json` → `DetectorSpec`)

**Files:**
- Create: `packages/insight/src/detectorRules.ts`
- Modify: `packages/insight/src/index.ts` (add one export line)
- Test: `src/gem/__tests__/detectorRules.test.ts`

**Interfaces:**
- Consumes: `DetectorSpec`, `DetectorFinding`, `DetectorSeverity`, `DETECTORS` from `./detectors.js`; `agentgemHome` from `@agentgem/model`.
- Produces (Task 5 relies on these exact names):
  - `interface DetectorRule { id: string; title: string; advice: string; severity?: DetectorSeverity; pattern: string[]; minRepeats?: number }`
  - `function validateRule(raw: unknown): DetectorRule | null`
  - `function compileRule(rule: DetectorRule): DetectorSpec`
  - `function loadRuleDetectors(dir?: string): DetectorSpec[]` — default dir `join(agentgemHome(), ".agentgem", "detectors")`

Rule semantics: `pattern` is a sequence of verbs matched EXACTLY and contiguously (non-overlapping) against a session's step verbs. A session yields at most ONE finding per rule, fired when match count >= `minRepeats` (default 1). This is the Tier-2 "criteria as data" unit — and the future distributable payload for detector-pack Gems (Tier 3, out of scope here).

- [ ] **Step 1: Write the failing tests**

Create `src/gem/__tests__/detectorRules.test.ts`:

```ts
// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
// src/gem/__tests__/detectorRules.test.ts
import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
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
```

- [ ] **Step 2: Run to verify failure**

```bash
pnpm build 2>&1 | head -20
```
Expected: tsc FAILS — no exported member `validateRule`.

- [ ] **Step 3: Implement `packages/insight/src/detectorRules.ts`**

```ts
// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
// packages/insight/src/detectorRules.ts
//
// Tier-2 pluggability for the detector layer: user-defined criteria as DATA.
// JSON files in ~/.agentgem/detectors/ each hold one rule (or an array), which
// compiles into a DetectorSpec matching a verb sequence against session steps.
// No code execution — a rule is declarative, so there is nothing to sandbox,
// and the same format is the future distributable unit for detector-pack Gems.
// Never throws: missing dir, bad JSON, invalid rules, and id collisions all
// degrade to "rule skipped" (console.error), mirroring the analysis-path
// contract in judgeSession.ts.
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { agentgemHome } from "@agentgem/model";
import type { DetectorFinding, DetectorSeverity, DetectorSpec } from "./detectors.js";
import { DETECTORS } from "./detectors.js";

export interface DetectorRule {
  id: string;                 // kebab-case slug, unique across built-ins and rules
  title: string;
  advice: string;
  severity?: DetectorSeverity; // default "info"
  pattern: string[];           // verb sequence, matched exactly and contiguously
  minRepeats?: number;         // non-overlapping matches per session to fire (default 1)
}

const ID_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;

export function validateRule(raw: unknown): DetectorRule | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.id !== "string" || !ID_RE.test(r.id)) return null;
  if (typeof r.title !== "string" || !r.title.trim()) return null;
  if (typeof r.advice !== "string" || !r.advice.trim()) return null;
  if (!Array.isArray(r.pattern) || r.pattern.length === 0
    || !r.pattern.every((p) => typeof p === "string" && p.length > 0)) return null;
  if (r.severity !== undefined && r.severity !== "info" && r.severity !== "warn") return null;
  if (r.minRepeats !== undefined
    && (typeof r.minRepeats !== "number" || !Number.isInteger(r.minRepeats) || r.minRepeats < 1)) return null;
  return {
    id: r.id, title: r.title.trim(), advice: r.advice.trim(),
    severity: r.severity as DetectorSeverity | undefined,
    pattern: r.pattern as string[],
    minRepeats: r.minRepeats as number | undefined,
  };
}

/** Compile one validated rule into a DetectorSpec. One finding max per session. */
export function compileRule(rule: DetectorRule): DetectorSpec {
  const severity: DetectorSeverity = rule.severity ?? "info";
  return {
    id: rule.id, title: rule.title, advice: rule.advice, cost: "cheap", severity,
    detect(session) {
      if (rule.pattern.length === 0) return [];   // hand-built rule bypassing validateRule — never fires, never hangs
      const verbs = session.steps.map((s) => s.verb);
      const hits: number[][] = [];
      let i = 0;
      while (i <= verbs.length - rule.pattern.length) {
        let ok = true;
        for (let k = 0; k < rule.pattern.length; k++) {
          if (verbs[i + k] !== rule.pattern[k]) { ok = false; break; }
        }
        if (ok) {
          hits.push(session.steps.slice(i, i + rule.pattern.length).map((s) => s.msgIndex));
          i += rule.pattern.length;   // non-overlapping
        } else i++;
      }
      if (hits.length < (rule.minRepeats ?? 1)) return [];
      const finding: DetectorFinding = {
        detectorId: rule.id, sessionId: session.sessionId, transcript: session.transcript,
        atMs: session.atMs, severity,
        detail: `pattern [${rule.pattern.join(" > ")}] matched ${hits.length}x`,
        evidence: { msgIndices: hits.flat() },
      };
      return [finding];
    },
  };
}

/**
 * Load every *.json rule file from the detectors dir (default
 * ~/.agentgem/detectors, honoring AGENTGEM_HOME via agentgemHome()). Files are
 * read in sorted order; each may hold one rule object or an array. Invalid
 * entries and ids colliding with built-ins or earlier rules are skipped.
 */
export function loadRuleDetectors(dir = join(agentgemHome(), ".agentgem", "detectors")): DetectorSpec[] {
  let files: string[];
  try { files = readdirSync(dir).filter((f) => f.endsWith(".json")).sort(); }
  catch { return []; }   // no dir = no rules — the common case
  const out: DetectorSpec[] = [];
  const seen = new Set(DETECTORS.map((d) => d.id));
  for (const f of files) {
    try {
      const raw: unknown = JSON.parse(readFileSync(join(dir, f), "utf8"));
      for (const entry of Array.isArray(raw) ? raw : [raw]) {
        const rule = validateRule(entry);
        if (!rule || seen.has(rule.id)) continue;
        seen.add(rule.id);
        out.push(compileRule(rule));
      }
    } catch (err) {
      console.error(`detector rules: skipped ${f}:`, (err as Error).message);
    }
  }
  return out;
}
```

Add to `packages/insight/src/index.ts`, directly after the `./detectors.js` line from Task 2:

```ts
export * from "./detectorRules.js";
```

- [ ] **Step 4: Build and run the tests**

```bash
pnpm build && npx vitest run dist/gem/__tests__/detectorRules.test.js
```
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/insight/src/detectorRules.ts packages/insight/src/index.ts src/gem/__tests__/detectorRules.test.ts
git commit -m "feat(insight): declarative detector rules loaded from ~/.agentgem/detectors"
```

---

### Task 5: Wire detectors into `computeInsights` (+ `summarizeFindings`, cache bump)

**Files:**
- Modify: `packages/insight/src/detectors.ts` (add `summarizeFindings` + `DetectorSummary`)
- Modify: `src/insightsCore.ts` (run detectors, extend `InsightsPayload`)
- Modify: `packages/insight/src/insightsCache.ts:21` (`TOKEN_VERSION` `"iv2"` → `"iv3"`)
- Test: `src/gem/__tests__/detectors.test.ts` (append), `src/__tests__/insightsCore.test.ts` (extend one test)

**Interfaces:**
- Consumes: `runDetectors`, `loadRuleDetectors`, `DETECTORS` (Tasks 2–4).
- Produces:
  - `interface DetectorSummary { id: string; title: string; advice: string; severity: DetectorSeverity; count: number; sessions: number }`
  - `function summarizeFindings(findings: DetectorFinding[], specs?: DetectorSpec[]): DetectorSummary[]` (default specs = `DETECTORS`)
  - `InsightsPayload` gains `findings: DetectorFinding[]` and `detectorSummary: DetectorSummary[]`.

Why the cache bump: `InsightsPayload` is cached by `(root, token)`; without a token-version bump, pre-existing cache entries would be served WITHOUT the new fields. Bumping `TOKEN_VERSION` makes every old entry miss cleanly (`insightsToken` embeds it).

Why the payload carries per-finding data AND a summary: findings go over HTTP to the console, which has no access to the registry — so advice/title must travel in the payload. The summary (one row per detector id, counts + advice) is the aggregation the coaching/chat layer consumes ("thrash-loop fired 5× this week").

- [ ] **Step 1: Write the failing tests**

Append to `src/gem/__tests__/detectors.test.ts`:

```ts
import { summarizeFindings } from "@agentgem/insight";

describe("summarizeFindings", () => {
  it("aggregates counts and distinct sessions per detector, joined with spec advice, busiest first", () => {
    const steps = Array.from({ length: 3 }, (_, i) => step("Bash", "Bash:npm", "npm test", i));
    const findings = runDetectors(signalWith([sess(steps, "s1"), sess(steps, "s2")]));
    const summary = summarizeFindings(findings);
    const storm = summary.find((s) => s.id === "retry-storm")!;
    expect(storm.count).toBe(2);
    expect(storm.sessions).toBe(2);
    expect(storm.title).toBe("Same command repeated back-to-back");
    expect(storm.advice.length).toBeGreaterThan(0);
    expect(summary[0].count).toBeGreaterThanOrEqual(summary[summary.length - 1].count);
  });

  it("falls back to the id for findings whose spec is unknown", () => {
    const orphan = {
      detectorId: "ghost", sessionId: "s1", transcript: "s1.jsonl", atMs: 1,
      severity: "info" as const, detail: "d", evidence: { msgIndices: [1] },
    };
    const summary = summarizeFindings([orphan]);
    expect(summary).toEqual([{ id: "ghost", title: "ghost", advice: "", severity: "info", count: 1, sessions: 1 }]);
  });

  it("returns [] for no findings", () => {
    expect(summarizeFindings([])).toEqual([]);
  });
});
```

Extend the existing `"fresh non-degraded compute"` test in `src/__tests__/insightsCore.test.ts` — after `expect(typeof first.updatedAt).toBe("number");` add:

```ts
    // Detector wiring: a transcript with no tool steps yields empty findings,
    // but the fields must exist on a fresh payload.
    expect(first.payload.findings).toEqual([]);
    expect(first.payload.detectorSummary).toEqual([]);
```

(The tests already point `AGENTGEM_HOME` at a tmp dir, so `loadRuleDetectors()` sees no rules dir and returns `[]` — no seam needed.)

- [ ] **Step 2: Run to verify failure**

```bash
pnpm build 2>&1 | head -20
```
Expected: tsc FAILS — no exported member `summarizeFindings`, and `findings` missing on `InsightsPayload`.

- [ ] **Step 3: Implement**

Append to `packages/insight/src/detectors.ts`:

```ts
// One row per detector id that actually fired — the aggregation the coaching
// layer consumes. Carries title/advice so HTTP consumers need no registry.
export interface DetectorSummary {
  id: string;
  title: string;
  advice: string;
  severity: DetectorSeverity;
  count: number;      // total findings
  sessions: number;   // distinct sessions it fired in
}

export function summarizeFindings(findings: DetectorFinding[], specs: DetectorSpec[] = DETECTORS): DetectorSummary[] {
  const byId = new Map(specs.map((s) => [s.id, s]));
  const acc = new Map<string, { severity: DetectorSeverity; count: number; sessions: Set<string> }>();
  for (const f of findings) {
    const a = acc.get(f.detectorId) ?? { severity: f.severity, count: 0, sessions: new Set<string>() };
    a.count++;
    a.sessions.add(f.sessionId);
    acc.set(f.detectorId, a);
  }
  return [...acc.entries()]
    .map(([id, a]) => {
      const spec = byId.get(id);
      return {
        id, title: spec?.title ?? id, advice: spec?.advice ?? "",
        severity: spec?.severity ?? a.severity, count: a.count, sessions: a.sessions.size,
      };
    })
    .sort((x, y) => y.count - x.count || x.id.localeCompare(y.id));
}
```

In `src/insightsCore.ts`:

1. Extend the `@agentgem/insight` import:

```ts
import {
  claudeTranscriptsForCwd, allClaudeTranscripts, scanWorkflow,
  judgeSessions, synthesizeInsights, narrateInsights,
  insightsToken, readInsightsCacheEntry, writeInsightsCache,
  runDetectors, summarizeFindings, loadRuleDetectors, DETECTORS,
  type DetectorFinding, type DetectorSummary,
} from "@agentgem/insight";
```

2. Extend `InsightsPayload`:

```ts
export interface InsightsPayload {
  report: ReturnType<typeof synthesizeInsights>;
  facets: Awaited<ReturnType<typeof judgeSessions>>["facets"];
  findings: DetectorFinding[];
  detectorSummary: DetectorSummary[];
  degraded: boolean;
  signalSummary: { sessionsScanned: number; spanDays: number; notes: unknown };
}
```

3. After the `p?.onPhase?.("scanned", ...)` line, before `p?.onPhase?.("judging")`:

```ts
  p?.onPhase?.("detecting");
  const ruleSpecs = loadRuleDetectors();
  const findings = runDetectors(signal, ruleSpecs);
  const detectorSummary = summarizeFindings(findings, [...DETECTORS, ...ruleSpecs]);
```

4. Extend the payload construction:

```ts
  const payload: InsightsPayload = {
    report, facets, findings, detectorSummary,
    degraded: judgeDegraded || narr.degraded,
    signalSummary: { sessionsScanned: signal.sessions.scanned, spanDays: signal.sessions.spanDays, notes: signal.notes },
  };
```

5. In `packages/insight/src/insightsCache.ts` line 21, change:

```ts
const TOKEN_VERSION = "iv3"; // iv2→iv3: payload gained findings + detectorSummary
```

- [ ] **Step 4: Build and run the touched test files**

```bash
pnpm build && npx vitest run dist/gem/__tests__/detectors.test.js dist/__tests__/insightsCore.test.js
```
Expected: PASS. Note: the first insightsCore test ("returns the cached payload") writes its own cache with the CURRENT `insightsToken`, so the iv3 bump does not break it.

- [ ] **Step 5: Check for other tests pinned to the old token version**

```bash
grep -rn "iv2" src packages --include="*.ts" | grep -v dist
```
Expected: no hits outside `insightsCache.ts` history. If a test hardcodes `iv2`, update it to `iv3`.

- [ ] **Step 6: Commit**

```bash
git add packages/insight/src/detectors.ts packages/insight/src/insightsCache.ts src/insightsCore.ts src/gem/__tests__/detectors.test.ts src/__tests__/insightsCore.test.ts
git commit -m "feat(insights): run behavior detectors in computeInsights; payload gains findings + summary"
```

---

### Task 6: Full-suite verification and branch finish

**Files:** none.

**Interfaces:**
- Consumes: everything above.
- Produces: a green branch ready for rebase-integration.

- [ ] **Step 1: Full build from clean dist** (dist can hold stale compiled tests after file additions)

```bash
git clean -nX dist | head -5   # preview only — confirm it lists only dist build outputs
pnpm build
```

- [ ] **Step 2: Full test suite**

```bash
pnpm test
```
Expected: green (same known real-FS flake caveat as Task 1 — verify any timeout in isolation before treating it as a regression).

- [ ] **Step 3: Confirm the branch is ahead of origin/main only**

```bash
git fetch origin && git log --oneline origin/main..HEAD && git log --oneline HEAD..origin/main | head -5
```
Expected: your commits listed; if origin/main moved, rebase (`git rebase origin/main`) — repo policy is rebase-only integration.

- [ ] **Step 4: Finish the branch** — use superpowers:finishing-a-development-branch to choose merge/PR. Reminder from repo policy: rebase locally + push; never `gh pr update-branch`.

---

## Out of scope (explicitly deferred)

- **Tier 3 — detector packs as Gems** (a new Cut in the contributions design): the `DetectorRule` JSON format defined in Task 4 is the distributable unit; packaging/publishing comes later.
- **LLM-cost detectors** (`cost: "llm"`): the `DetectorSpec.cost` field reserves the slot; no agent-driven detector ships in this plan.
- **Console UI and chat surfacing** of `detectorSummary` — payload-only in this plan.
- **Cross-session trend history** ("fired 5× this week vs 2× last week") — needs a findings ledger; separate plan.
