# Trigger Quality — Phase 1 (Backend Spine) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give a skill a structured, testable trigger contract and make "does the right skill fire?" a computable route-confusion eval that feeds an advisory scorecard and grade.

**Architecture:** Additions to the existing Gem/GemCheck spine (Approach A from the design). `SkillArtifact` gains an optional `TriggerContract`; route-confusion becomes a new `ExternalCheck` runner id; a pure scorer and a read-model over `CheckResult[]` project the result into `Gem.grade`. No new persistence, no parallel eval system.

**Tech Stack:** TypeScript, Zod, Vitest, pnpm workspaces (`@agentgem/model`, `@agentgem/build`).

**Spec:** `docs/superpowers/specs/2026-07-02-trigger-quality-design.md`

## Global Constraints

- Node floor `>=24` (repo-wide).
- Everything here is **advisory / never-throw**: no code path may fail a build or block a publish.
- **Additive & backward-compatible**: a Gem with no `trigger` contract must parse, build, and grade exactly as it does today.
- Copyright header on every new file (copy verbatim):
  `// Copyright (c) 2026 NineMind, Inc.` / `// SPDX-License-Identifier: MIT`
- Test command: `pnpm test` (runs `tsc -b && vitest run`). To filter one test after a build: `npx vitest run -t "<test name>"`.
- Package tests live under root `src/**/__tests__/`, not co-located in `packages/*`.
- This plan is the **backend spine**. The surfacing layer (distill extractor emit in `@agentgem/insight`, console review UI, platform-runner adapter) is **Plan 2** — see "Deferred to Plan 2" at the end. Do not implement it here.

---

### Task 1: `TriggerContract` type + Zod schema

**Files:**
- Modify: `packages/model/src/types.ts` (add `TriggerContract`; add `trigger?` to `SkillArtifact`, currently line 11)
- Modify: `packages/model/src/index.ts` (export `TriggerContract` if the file re-exports named types; if it does `export * from "./types"`, no change needed — verify)
- Modify: `src/schemas.ts` (add `TriggerContractSchema`; wire into `SkillArtifactSchema`, currently lines 11-17)
- Test: `src/__tests__/schemas.test.ts` (extend)

**Interfaces:**
- Produces: `interface TriggerContract { intent: string; triggers: string[]; antiTriggers: string[]; inputs?: string[]; outputs?: string[] }` and `SkillArtifact.trigger?: TriggerContract`. Zod: `TriggerContractSchema`.

- [ ] **Step 1: Write the failing test**

Add to `src/__tests__/schemas.test.ts` (near the existing `SkillArtifactSchema`/`GemArtifactSchema` cases):

```ts
import { SkillArtifactSchema, TriggerContractSchema } from "../schemas";

describe("TriggerContract", () => {
  it("parses a full trigger contract", () => {
    const c = TriggerContractSchema.parse({
      intent: "distill a session into a shareable skill",
      triggers: ["user asks to save this workflow", "repeated manual steps"],
      antiTriggers: ["one-off throwaway command"],
      inputs: ["a transcript"],
      outputs: ["a SkillArtifact"],
    });
    expect(c.triggers).toHaveLength(2);
    expect(c.inputs).toEqual(["a transcript"]);
  });

  it("accepts a skill artifact WITHOUT a trigger (backward-compat)", () => {
    const s = SkillArtifactSchema.parse({
      type: "skill", name: "x", source: "s", content: "c",
    });
    expect(s.trigger).toBeUndefined();
  });

  it("accepts a skill artifact WITH a trigger", () => {
    const s = SkillArtifactSchema.parse({
      type: "skill", name: "x", source: "s", content: "c",
      trigger: { intent: "i", triggers: ["t"], antiTriggers: [] },
    });
    expect(s.trigger?.intent).toBe("i");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test`
Expected: FAIL — `TriggerContractSchema` is not exported / `trigger` stripped from parse.

- [ ] **Step 3: Add the type in `packages/model/src/types.ts`**

Insert directly above `export interface SkillArtifact` (line 11):

```ts
export interface TriggerContract {
  intent: string;          // one-line: what this skill is for
  triggers: string[];      // positive signals — when it SHOULD fire
  antiTriggers: string[];  // boundaries — when it must NOT fire
  inputs?: string[];       // optional: what it expects to be present
  outputs?: string[];      // optional: what it produces
}
```

Add the field to `SkillArtifact` (after `content: string;`):

```ts
  trigger?: TriggerContract;
```

- [ ] **Step 4: Add the Zod schema in `src/schemas.ts`**

Insert above `SkillArtifactSchema` (line 11):

```ts
export const TriggerContractSchema = z.object({
  intent: z.string(),
  triggers: z.array(z.string()),
  antiTriggers: z.array(z.string()),
  inputs: z.array(z.string()).optional(),
  outputs: z.array(z.string()).optional(),
});
```

Add the field inside `SkillArtifactSchema` (after `content: z.string(),`):

```ts
  trigger: TriggerContractSchema.optional(),
```

- [ ] **Step 5: Verify the model export**

Open `packages/model/src/index.ts`. If it re-exports with `export * from "./types";`, nothing to do. If it lists named exports, add `TriggerContract`.

- [ ] **Step 6: Run tests to verify they pass**

Run: `pnpm test`
Expected: PASS (all three new cases).

- [ ] **Step 7: Commit**

```bash
git add packages/model/src/types.ts packages/model/src/index.ts src/schemas.ts src/__tests__/schemas.test.ts
git commit -m "feat(model): add optional TriggerContract to SkillArtifact"
```

---

### Task 2: `route-confusion` runner + `scaffoldChecks` emit

**Files:**
- Modify: `packages/build/src/checks.ts` (add registry entry; emit check when a skill carries a contract)
- Test: `src/gem/__tests__/checks.test.ts` (extend)

**Interfaces:**
- Consumes: `Gem`, `SkillArtifact.trigger` (Task 1).
- Produces: `RUNNER_REGISTRY["route-confusion"]`; `scaffoldChecks` now emits `{ kind: "external", name: "route-confusion", runner: "route-confusion", with: { corpus: "in-gem" } }` iff ≥1 skill has a `trigger`. Because `ExternalCheckSchema.runner` is `z.enum(Object.keys(RUNNER_REGISTRY))` (`src/schemas.ts:107-112`), adding the registry key is what makes the id valid — no schema edit needed.

- [ ] **Step 1: Write the failing test**

Add to `src/gem/__tests__/checks.test.ts`:

```ts
it("emits a route-confusion check when a skill has a trigger contract", () => {
  const gem = {
    name: "g", createdFrom: "t", artifacts: [
      { type: "skill", name: "s", source: "x", content: "c",
        trigger: { intent: "i", triggers: ["t"], antiTriggers: [] } },
    ], checks: [], requiredSecrets: [],
  } as any;
  const checks = scaffoldChecks(gem);
  const rc = checks.find((c) => c.kind === "external" && c.runner === "route-confusion");
  expect(rc).toBeTruthy();
  expect(rc && rc.kind === "external" && rc.with).toEqual({ corpus: "in-gem" });
});

it("omits route-confusion when no skill has a trigger contract", () => {
  const gem = {
    name: "g", createdFrom: "t", artifacts: [
      { type: "skill", name: "s", source: "x", content: "c" },
    ], checks: [], requiredSecrets: [],
  } as any;
  const checks = scaffoldChecks(gem);
  expect(checks.some((c) => c.kind === "external" && c.runner === "route-confusion")).toBe(false);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test`
Expected: FAIL — no `route-confusion` check emitted.

- [ ] **Step 3: Add the registry entry**

In `packages/build/src/checks.ts`, extend `RUNNER_REGISTRY`:

```ts
export const RUNNER_REGISTRY = {
  skillspector: {
    id: "skillspector",
    consumes: "gem-as-directory",
    resultShape: "score+findings",
    defaultWith: { failAboveRisk: 40 },
  },
  "route-confusion": {
    id: "route-confusion",
    consumes: "gem-as-directory",
    resultShape: "score+findings",
    defaultWith: { corpus: "in-gem" },
  },
} as const;
```

- [ ] **Step 4: Emit the check in `scaffoldChecks`**

Inside `scaffoldChecks`, after the `if (skills.length) { … skillspector … }` block, add:

```ts
  if (skills.some((s) => s.trigger)) {
    const reg = RUNNER_REGISTRY["route-confusion"];
    checks.push({ kind: "external", name: "route-confusion", runner: reg.id, with: { ...reg.defaultWith } });
  }
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `pnpm test`
Expected: PASS (both new cases; existing `checks.test.ts` cases still green).

- [ ] **Step 6: Commit**

```bash
git add packages/build/src/checks.ts src/gem/__tests__/checks.test.ts
git commit -m "feat(build): scaffold a route-confusion check for skills with trigger contracts"
```

---

### Task 3: `scoreRouteConfusion` pure scorer

**Files:**
- Create: `packages/build/src/routeConfusion.ts`
- Modify: `packages/build/src/index.ts` (export the new module)
- Test: `src/gem/__tests__/routeConfusion.test.ts` (create)

**Interfaces:**
- Consumes: `TriggerContract` (Task 1).
- Produces:
  - `type RouteJudge = (phrase: string, candidates: { name: string; contract: TriggerContract }[]) => string` — returns the `name` the phrase routes to.
  - `interface RouteConfusionResult { score: number; findings: { severity: string; title: string; detail?: string }[] }`
  - `function scoreRouteConfusion(own: { name: string; contract: TriggerContract }, corpus: { name: string; contract: TriggerContract }[], judge: RouteJudge): RouteConfusionResult`

This is the pure core the platform-runner adapter (Plan 2) will call with a real LLM judge. Kept offline and deterministic here via an injected judge.

- [ ] **Step 1: Write the failing test**

Create `src/gem/__tests__/routeConfusion.test.ts`:

```ts
// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
import { describe, it, expect } from "vitest";
import { scoreRouteConfusion, type RouteJudge } from "@agentgem/build";
import type { TriggerContract } from "@agentgem/model";

const own = {
  name: "distill",
  contract: {
    intent: "distill a session into a skill",
    triggers: ["save this workflow", "repeated steps"],
    antiTriggers: ["one-off command"],
  } as TriggerContract,
};
const sibling = {
  name: "runGem",
  contract: { intent: "run a gem", triggers: ["execute the gem"], antiTriggers: [] } as TriggerContract,
};

it("perfect routing scores 1 with no findings", () => {
  // judge routes every own-trigger to `distill` and the anti-trigger elsewhere
  const judge: RouteJudge = (phrase) => (phrase === "one-off command" ? "runGem" : "distill");
  const r = scoreRouteConfusion(own, [sibling], judge);
  expect(r.score).toBe(1);
  expect(r.findings).toHaveLength(0);
});

it("a mis-routed trigger lowers precision and is reported", () => {
  const judge: RouteJudge = (phrase) =>
    phrase === "repeated steps" ? "runGem" : phrase === "one-off command" ? "runGem" : "distill";
  const r = scoreRouteConfusion(own, [sibling], judge);
  // precision = 1/2, collisionRate = 0 -> score 0.5
  expect(r.score).toBeCloseTo(0.5);
  expect(r.findings.some((f) => f.title.includes("repeated steps"))).toBe(true);
});

it("an anti-trigger that wrongly fires raises collision rate", () => {
  const judge: RouteJudge = () => "distill"; // everything routes to own, incl. the anti-trigger
  const r = scoreRouteConfusion(own, [sibling], judge);
  // precision = 2/2 = 1, collisionRate = 1/1 = 1 -> score clamped to 0
  expect(r.score).toBe(0);
  expect(r.findings.some((f) => f.title.includes("one-off command"))).toBe(true);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test`
Expected: FAIL — `scoreRouteConfusion` not exported from `@agentgem/build`.

- [ ] **Step 3: Write the implementation**

Create `packages/build/src/routeConfusion.ts`:

```ts
// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
// Pure route-confusion scorer. The platform-runner adapter supplies a real LLM/embedding
// judge; tests supply a fake one. No I/O, no LLM here — deterministic and offline.
import type { TriggerContract } from "@agentgem/model";

export type Candidate = { name: string; contract: TriggerContract };
export type RouteJudge = (phrase: string, candidates: Candidate[]) => string;

export interface RouteConfusionResult {
  score: number; // trigger precision − collision rate, clamped 0..1
  findings: { severity: string; title: string; detail?: string }[];
}

export function scoreRouteConfusion(own: Candidate, corpus: Candidate[], judge: RouteJudge): RouteConfusionResult {
  const candidates = [own, ...corpus];
  const findings: RouteConfusionResult["findings"] = [];

  const triggers = own.contract.triggers;
  let correct = 0;
  for (const t of triggers) {
    const routed = judge(t, candidates);
    if (routed === own.name) correct++;
    else findings.push({ severity: "warn", title: `trigger mis-routes: "${t}"`, detail: `routed to "${routed}"` });
  }
  const precision = triggers.length ? correct / triggers.length : 1;

  const anti = own.contract.antiTriggers;
  let collisions = 0;
  for (const a of anti) {
    if (judge(a, candidates) === own.name) {
      collisions++;
      findings.push({ severity: "warn", title: `anti-trigger wrongly fires: "${a}"` });
    }
  }
  const collisionRate = anti.length ? collisions / anti.length : 0;

  const score = Math.min(1, Math.max(0, precision - collisionRate));
  return { score, findings };
}
```

- [ ] **Step 4: Export from the package**

In `packages/build/src/index.ts`, add:

```ts
export * from "./routeConfusion";
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `pnpm test`
Expected: PASS (all three cases).

- [ ] **Step 6: Commit**

```bash
git add packages/build/src/routeConfusion.ts packages/build/src/index.ts src/gem/__tests__/routeConfusion.test.ts
git commit -m "feat(build): pure route-confusion scorer (precision minus collision)"
```

---

### Task 4: `triggerScorecard` read-model + advisory grade input

**Files:**
- Create: `packages/build/src/triggerScorecard.ts`
- Modify: `packages/build/src/index.ts` (export)
- Modify: `packages/model/src/gemGrade.ts` (optional `triggerPrecision` input to `scorecardFloor`)
- Test: `src/gem/__tests__/triggerScorecard.test.ts` (create)

**Interfaces:**
- Consumes: `GemVerificationReport`, `Gem`, `CheckResult` (existing model types), `scorecardFloor` (existing).
- Produces:
  - `interface TriggerScorecard { routeScore: number | null; collisions: string[]; contextBudgetChars: number }`
  - `function triggerScorecard(report: GemVerificationReport, gem: Gem): TriggerScorecard`
  - `scorecardFloor` gains optional `routeScore?: number`; when present and `< 0.5`, the floor drops to `GEM_GRADE_MIN` (advisory: a measured-but-poorly-routing gem can't float above the floor). Existing callers pass nothing → behavior unchanged.

- [ ] **Step 1: Write the failing test**

Create `src/gem/__tests__/triggerScorecard.test.ts`:

```ts
// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
import { describe, it, expect } from "vitest";
import { triggerScorecard } from "@agentgem/build";
import { scorecardFloor } from "@agentgem/model";

const gem = {
  name: "g", createdFrom: "t",
  artifacts: [
    { type: "skill", name: "s", source: "x", content: "abcde", // 5 chars
      trigger: { intent: "i", triggers: ["t"], antiTriggers: [] } },
  ],
  checks: [], requiredSecrets: [],
} as any;

const report = {
  gemName: "g", createdFrom: "t", passed: true,
  results: [
    { checkName: "route-confusion", kind: "external", passed: true, runner: "route-confusion",
      score: 0.4, findings: [{ severity: "warn", title: "trigger mis-routes: \"t\"" }], durationMs: 1 },
  ],
} as any;

it("projects precision, collisions and context budget from the report", () => {
  const sc = triggerScorecard(report, gem);
  expect(sc.precision).toBe(0.4);
  expect(sc.collisions).toEqual(["trigger mis-routes: \"t\""]);
  // content (5) + JSON of the trigger contract (> 0)
  expect(sc.contextBudgetChars).toBeGreaterThan(5);
});

it("precision is null when no route-confusion result is present", () => {
  const sc = triggerScorecard({ ...report, results: [] } as any, gem);
  expect(sc.precision).toBeNull();
});

it("advisory grade: low trigger precision caps the floor at the minimum", () => {
  const axes = { breadth: 5, battleTested: 1, portable: 1 }; // would floor at 3
  expect(scorecardFloor(axes)).toBe(3);
  expect(scorecardFloor({ ...axes, triggerPrecision: 0.4 })).toBe(1);
  expect(scorecardFloor({ ...axes, triggerPrecision: 0.9 })).toBe(3);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test`
Expected: FAIL — `triggerScorecard` not exported; `scorecardFloor` ignores `triggerPrecision`.

- [ ] **Step 3: Implement the read-model**

Create `packages/build/src/triggerScorecard.ts`:

```ts
// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
// A view over a GemVerificationReport — no persistence. Surfaces trigger precision,
// collisions, and context budget for the console scorecard (Plan 2) and grade input.
import type { Gem, GemVerificationReport } from "@agentgem/model";

export interface TriggerScorecard {
  precision: number | null; // route-confusion CheckResult.score, null if not run
  collisions: string[];     // finding titles from that result
  contextBudgetChars: number;
}

export function triggerScorecard(report: GemVerificationReport, gem: Gem): TriggerScorecard {
  const rc = report.results.find((r) => r.runner === "route-confusion");
  const contextBudgetChars = gem.artifacts
    .filter((a): a is Extract<typeof a, { type: "skill" }> => a.type === "skill")
    .reduce((n, s) => n + s.content.length + (s.trigger ? JSON.stringify(s.trigger).length : 0), 0);
  return {
    precision: rc?.score ?? null,
    collisions: (rc?.findings ?? []).map((f) => f.title),
    contextBudgetChars,
  };
}
```

- [ ] **Step 4: Export from the package**

In `packages/build/src/index.ts`, add:

```ts
export * from "./triggerScorecard";
```

- [ ] **Step 5: Wire the advisory grade input**

In `packages/model/src/gemGrade.ts`, replace the `scorecardFloor` signature/body:

```ts
export function scorecardFloor(sc: { breadth: number; battleTested: number; portable: number; triggerPrecision?: number }): number {
  let f = GEM_GRADE_MIN;
  if (sc.battleTested >= 1) f++;
  if (sc.portable >= 1) f++;
  f = Math.min(GEM_GRADE_MAX, Math.max(GEM_GRADE_MIN, f));
  // Advisory: a measured-but-poorly-routing contract can't sit above the floor.
  if (sc.triggerPrecision !== undefined && sc.triggerPrecision < 0.5) f = GEM_GRADE_MIN;
  return f;
}
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `pnpm test`
Expected: PASS (all cases; existing `gemGrade` callers unaffected since `triggerPrecision` is optional).

- [ ] **Step 7: Commit**

```bash
git add packages/build/src/triggerScorecard.ts packages/build/src/index.ts packages/model/src/gemGrade.ts src/gem/__tests__/triggerScorecard.test.ts
git commit -m "feat: trigger scorecard read-model + advisory grade input"
```

---

## Deferred to Plan 2 (surfacing layer)

Not in this plan — each needs a reliable read of files where grep currently garbles output (`@agentgem/insight`, `packages/console`, platform runner):

1. **Distill extractor emit** — extend the `@agentgem/insight` distill path (`packages/insight/src/distill.ts` / `extract.ts`) to emit a `TriggerContract` per distilled skill (LLM, author-reviewed). Absent when the LLM is unavailable.
2. **Console review UI** — a per-skill "Triggers" section in the accept/fold-into-build review surface; render `triggerScorecard` output in `packages/console/src/panels/Mine/Scorecard.tsx`.
3. **Platform-runner adapter** — the `route-confusion` executor that builds the in-gem corpus and calls `scoreRouteConfusion` with a real LLM/embedding `RouteJudge`, mirroring the `skillspector` adapter contract; returns a `CheckResult`.

## Deferred to Phases 2–3 (from the spec)

- Phase 2: catalog-wide routing (`with.corpus: "catalog"`) at the aggregator.
- Phase 3: drift monitoring — re-run route-confusion on published Gems on a schedule (rides the warm-precompute daemon / cron).

## Self-Review

- **Spec coverage:** §1 data model → Task 1. §3 route-confusion runner → Task 2. §3 scorer core → Task 3. §4 scorecard + grade → Task 4. §2 extractor + review UI → Plan 2 (explicitly deferred). §5 testing → each task is TDD; real-`~/.claude` scan avoided (all tests use in-memory fixtures). Error handling (never-throw) → optional field + optional grade param + adapter deferred.
- **Placeholder scan:** none — every step has concrete code/commands.
- **Type consistency:** `TriggerContract` (Task 1) is consumed by name in Tasks 2–4; `scoreRouteConfusion`/`RouteJudge` (Task 3) names are stable; `triggerScorecard` reads `CheckResult.runner`/`.score`/`.findings` (verified present in `packages/model/src/types.ts:124-135`) and `scorecardFloor` param extended additively (Task 4).
