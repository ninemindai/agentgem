# Trigger Quality: structured trigger contracts, route-confusion evals, and an evolving skill scorecard

Date: 2026-07-02
Status: Design — approved for planning
Branch: `feat/trigger-quality` (worktree off `origin/main`)

## North star

Turn messy, repetitive session work into assets that are worth keeping in one of two
shapes:

1. **An evolvable skill package** — a Gem that measures itself and gets better over time.
2. **A standalone Agent** — the same Gem compiled to a runnable agent via the existing
   materialize targets (Eve / Flue / A2A / Bedrock / OpenAI Sandbox).

The missing ingredient for both is a *structured, testable notion of when a skill should
fire*. Today a `SkillArtifact` carries `description?: string` — freeform prose you cannot
evaluate. This design gives each skill a structured **trigger contract**, makes
"does the right skill fire?" a computable **route-confusion eval**, and projects the
result into an **evidence-backed scorecard** that feeds the Gem's grade — the feedback
loop that makes a skill package *evolvable* rather than a dead snapshot.

The ideas are borrowed from [`yao-meta-skill`](https://github.com/yaojingang/yao-meta-skill)'s
"Skill IR" and its route-confusion evaluation rigor. AgentGem already owns the compiler
(Gem archive → materialize targets) and the eval spine (`GemCheck` → `CheckResult` →
`GemVerificationReport`); this proposal lands yao's ideas as *additions to that spine*,
not a parallel system.

## Scope

Selected ideas (all four): structured trigger surface, trigger-routing evals, skill
quality scorecard, drift monitoring. Primary job: **both author-quality and
discovery-routing, author-first** — model for both, ship local authoring quality first.
Contract production: **LLM-distilled, author-reviewed**. Enforcement posture:
**advisory / never-throw** (matches the recommend-only culture of the Optimize/Discover
work) — nothing here can fail a build or block a publish.

## Design decision (chosen approach)

**Approach A — extend in place.** Ride every existing seam rather than build new
infrastructure:

- A new optional field on `SkillArtifact`, not a sidecar type.
- Route-confusion as a new **`ExternalCheck` runner id**, not a separate eval module.
- The scorecard as a **read-model over `CheckResult[]`**, not new persistence.

Rejected: Approach B (sidecar contract + dedicated eval subsystem — duplicates the
check/report machinery; second-system risk) and Approach C (Gem-level trigger only —
does not enrich `SkillArtifact`, the actual gap, and discards per-skill fidelity).

## Section 1 — Data model: `TriggerContract`

Additive, optional, backward-compatible. Every existing Gem stays valid and grades
exactly as it does today until a contract is distilled.

```ts
// packages/model/src/types.ts — new, additive
export interface TriggerContract {
  intent: string;          // one-line: what this skill is for
  triggers: string[];      // positive signals — when it SHOULD fire
  antiTriggers: string[];  // boundaries — when it must NOT fire
  inputs?: string[];       // optional: what it expects to be present
  outputs?: string[];      // optional: what it produces
}

export interface SkillArtifact {
  type: "skill";
  name: string;
  description?: string;
  source: string;
  content: string;
  trigger?: TriggerContract;   // ← additive, optional
}
```

`triggers` + `antiTriggers` as **separate arrays** is the load-bearing choice: route
confusion is "does skill A fire on skill B's territory?", which is uncomputable from
prose but computable from a positive set vs. a boundary set. This is the one field yao's
IR has that the captured-payload model lacks.

Deliberately **not** imported: yao's "evidence requirements" field — no consumer for it
yet (YAGNI).

## Section 2 — Producing the contract (distill → review → fold)

The contract rides the existing distillation seam (`src/distill/`, the accept/
fold-into-build review flow).

```
skill content ──▶ extractor emits TriggerContract (LLM) ──▶ review UI section ──▶ folded into SkillArtifact on accept
```

- **Extractor:** a new emit step produces `{ intent, triggers[], antiTriggers[] }` from
  the skill's `content`. If the LLM is unavailable the field is simply absent — the skill
  still builds. No heuristic parser this phase (contract production is LLM-distilled).
- **Review UI:** the existing accept/fold review surface gains one per-skill "Triggers"
  section the author edits before accepting. This is where authoring quality happens —
  the author sees and sharpens the boundaries.

Net new: one extractor emit + one UI section. The accept/fold pipeline is untouched.

## Section 3 — Route-confusion as an `ExternalCheck` runner

The eval is a new entry in `RUNNER_REGISTRY` (`packages/build/src/checks.ts`) — the
registry holds *declarations only*; the adapter that executes lives in the platform
runner, exactly like `skillspector`.

```ts
// packages/build/src/checks.ts
export const RUNNER_REGISTRY = {
  skillspector: { /* …existing… */ },
  "route-confusion": {
    id: "route-confusion",
    consumes: "gem-as-directory",
    resultShape: "score+findings",     // same shape CheckResult already carries
    defaultWith: { corpus: "in-gem" }, // author-first: siblings + small seed set
  },
} as const;
```

`scaffoldChecks(gem)` pushes a `{ kind: "external", runner: "route-confusion", … }`
whenever any skill carries a `trigger` contract. The adapter computes the matrix:

- For each of a skill's `triggers`, does it route to *this* skill or collide with a
  sibling's territory? For each `antiTriggers`, does it correctly *not* fire?
- **Score = trigger precision − collision rate**, with colliding pairs listed in
  `findings`. Output is a normal `CheckResult` → flows through `GemVerificationReport`
  with zero new plumbing.
- **Corpus is pluggable via `with.corpus`**: `"in-gem"` (siblings + seed) now;
  `"catalog"` (aggregator, whole marketplace) is the Phase-2 flip of one field — the
  reason the model is designed for both.

The key reuse: the eval is **not new infrastructure, it is a new runner id.** `GemCheck`,
`CheckResult`, `GemVerificationReport`, and the platform-runner adapter contract already
exist.

## Section 4 — Scorecard + grade wiring

Not a new store — a read-model over the `CheckResult[]` already collected in
`GemVerificationReport`.

- A pure `triggerScorecard(report)` view surfaces three things already present or cheap:
  the **net route score** (precision − collision, from the route-confusion
  `CheckResult.score`), **collision list** (from `CheckResult.findings`), and **context
  budget** (token size of `trigger` + `content` — a `string.length`-class measure, no
  LLM).
- **Grade integration:** `Gem.grade` (the 1..3 floor, baked at build) gains the
  route-confusion score as *one input*. Advisory — a weak contract lowers the floor but
  never blocks a build or publish. A Gem with no `trigger` contract grades exactly as it
  does today.

Net new: one pure view function + one input to the existing grade calc. No new
persistence.

## Section 5 — Phasing

Phase 1 delivers all four selected ideas in local, author-first form. Phases 2–3 are the
"server" and "drift" halves — documented here, out of the first implementation plan so
the spec stays coherent.

| Phase | Ships | New surface |
|---|---|---|
| **1 — this plan** | `TriggerContract` type · extractor emit · review UI section · `route-confusion` runner + in-gem adapter · scorecard view · grade input | 1 field, 1 emit, 1 UI section, 1 runner, 1 view |
| **2 — follow-up** | Catalog-wide routing at the aggregator | flip `with.corpus` → `"catalog"`; server adapter |
| **3 — follow-up** | Drift monitoring: re-run route-confusion on published Gems on a schedule, flag regressions | rides the warm-precompute daemon / cron |

Phase 3 is what makes the skill package genuinely *evolvable*: a shipped Gem is re-scored
over time and flagged when its triggers stop discriminating (the catalog around it
shifted, or its own content drifted).

## Error handling

Uniformly advisory / never-throw:

- LLM down during distill → `trigger` absent, skill builds normally.
- Route-confusion adapter errors → `CheckResult` with `error` set; grade falls back to
  the existing floor.
- No path in this feature can fail a build or block a publish.

## Testing (TDD)

- Zod schema round-trip for `TriggerContract`, **and** that a `SkillArtifact` without it
  still parses (the backward-compat guard).
- `scaffoldChecks`: pushes `route-confusion` when a skill has a contract; omits it when
  none do.
- Route-confusion **scoring as a pure function** — `(ownContract, corpus) → { score,
  findings }` with a *fake* judge, so it is deterministic and offline.
- `triggerScorecard` view over synthetic `CheckResult[]`.
- Guard: tests must **not** scan the real `~/.claude` (real-FS scan tests flake under
  full-suite concurrency) — feed fixtures.

## Files touched (Phase 1)

- `packages/model/src/types.ts` — `TriggerContract` + `SkillArtifact.trigger` (+ Zod schema wherever `SkillArtifact` is validated).
- `packages/build/src/checks.ts` — `route-confusion` registry entry + `scaffoldChecks` emit.
- `src/distill/*` — extractor emit step for the trigger contract.
- `packages/console/*` — review-UI "Triggers" section.
- New: `triggerScorecard` view + grade-input wiring (location follows the existing grade calc).
- Platform runner — `route-confusion` adapter (mirrors the `skillspector` adapter contract).

## Non-goals

- No hard publish gate (advisory only).
- No "evidence requirements" IR field.
- No catalog-wide routing or drift monitoring in Phase 1 (Phases 2–3).
- No change to the Gem archive format or any materialize target output.
