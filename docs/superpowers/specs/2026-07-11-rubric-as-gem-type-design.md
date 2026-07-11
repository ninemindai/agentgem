# Rubric as a Gem type — design

**Date:** 2026-07-11
**Status:** Phase 1 approved for planning; Phases 2–3 named follow-ons.

## Problem

A rubric today is a standalone concept in `@agentgem/insight`: declarative JSON
(`{ id, title, target, factors[], criteria? }`) stored as `~/.agentgem/rubrics/*.json`,
plus two built-ins in code. It is authored, evaluated, and displayed by its own
machinery (`rubricCore.ts`, the Rubrics console panel) and lives entirely outside
the Gem/artifact framework.

We want a rubric to be **a category of gem** so it can be created, shared,
distributed, and (eventually) evolved on the same rails as every other gem
artifact — and so the console can eventually present "one authorable unit"
concept instead of two parallel systems (skills vs rubrics).

### Why not literally merge rubric into `SkillArtifact`?

A skill and a rubric point in **opposite directions**: a skill is content
*installed into* an agent to change future behavior; a rubric is declarative data
*applied over* sessions to evaluate past behavior and produce a report. Collapsing
them would produce a leaky, one-consumer abstraction. Instead we keep them
distinct concepts that **share the Gem distribution mechanism**. A "rubric" is a
Gem whose centerpiece is a `RubricArtifact`, optionally bundling skill artifacts
(e.g. a remediation skill, or a skill that supplies an LLM criterion's prose) —
the relationship is not fixed; it is just a Gem = manifest + `artifacts[]`.

## Phasing (decomposition)

This is deliberately split so the first slice ships value with zero dependency on
the heavier pieces:

- **Phase 1 (this spec):** Rubric becomes a Gem type. Model + (de)serialization +
  export/install wiring, at the serialization boundary only. No engine, catalog,
  API, or UI change.
- **Phase 2 (follow-on):** Share / distribute / console. Rubric-gems ride the
  existing publish/install/library rails; the console surfaces rubrics as a
  category in the unified library while keeping the run-and-report surface
  (skills have no "run"). Delivers the "one authorable unit" simplification.
- **Phase 3 (follow-on):** Effectiveness-weighted evolve. Rubric run outcomes feed
  the **universal** confidence-weighted per-gem effectiveness spine so low-signal
  factors get flagged/downweighted over time.

### Phase 3 constraint (recorded now so it can't drift)

The effectiveness spine is **not** a rubric feature. It is one scoring substrate
that every evaluable unit plugs into — skills, rubrics, MCP servers, benchmarks,
evals. Today's effectiveness work is named **SkillGem** effectiveness; step one of
Phase 3 is to confirm it is keyed on a generic gem/artifact identity (or
generalize it), which benefits skills/benchmarks/evals too. Only the
emit-outcomes / read-weights plug-in is rubric-specific. A spine shaped around
rubric *factors* would be the wrong abstraction.

---

## Phase 1 design

Two facts from the code shape everything:

1. **Dependency direction.** `@agentgem/insight` imports from `@agentgem/model`
   (`packages/insight/src/rubrics.ts:20`), never the reverse. The `GemArtifact`
   union lives in **model** (`packages/model/src/types.ts:145`); the rubric
   payload types (`RubricFactorRef`, `LlmCriterion`, `RubricScopeKind`) live in
   **insight**. A `RubricArtifact` in the union therefore cannot reference
   insight's types without creating a cycle.
2. **`GameArtifact` already carries both `name` and `title`**
   (`src/schemas.ts:112-113`) — precedent for a rubric artifact keeping a display
   `title` while using `name` as its kebab identity like every other artifact.

Prior art to reuse: `docs/superpowers/specs/2026-06-30-gem-types-extension-point-design.md`
(how new gem/artifact types plug in) — the plan should follow that extension point
where it applies.

### A. The type (in `@agentgem/model`)

Define the rubric payload shapes **directly in `model/types.ts`** — mirroring
insight's shapes structurally rather than relocating them. `insight`'s
`Rubric`, `RubricFactorRef`, and `LlmCriterion` stay exactly where they are; the
adapters (§B) compile because the shapes are structurally identical (TypeScript
structural typing).

Rationale for mirroring over relocating: `LlmCriterion.severity` is typed
`DetectorSeverity`, which is defined in **insight** (`detectors.ts:19`, `= "info"
| "warn"`). Relocating `LlmCriterion` into model would drag `DetectorSeverity`
(or force a re-import) backwards across the package boundary. Model instead
inlines `severity?: "info" | "warn"` — zero coupling, same no-cycle outcome, and
no edits to insight's engine files. The adapter round-trip test (§B / Task 3) is
the drift guard: if the two shapes ever diverge, the adapters stop compiling.

Add to `model/types.ts`:

```ts
export type RubricScopeKind = "session" | "project" | "all";
export type RubricGranularity = "session" | "aggregate";
export interface RubricFactorRef { factor: string; weight?: number }
export interface LlmCriterion {
  id: string; title: string; question: string;
  severity?: "info" | "warn"; advice: string; granularity?: RubricGranularity;
}
```

Then add the artifact:

```ts
export type ArtifactType =
  "skill" | "mcp_server" | "instructions" | "hook" | "channel" | "subagent" | "game" | "rubric"; // +rubric

export interface RubricArtifact {
  type: "rubric";
  name: string;                    // kebab identity (was Rubric.id) — matches every other artifact
  title: string;                   // display (was Rubric.title) — GameArtifact precedent
  target: string;
  naturalScope?: RubricScopeKind;
  factors: RubricFactorRef[];
  criteria?: LlmCriterion[];
}
```

- Add `RubricArtifact` to the `GemArtifact` union (`types.ts:145`).
- Add `"rubric"` to `ReferenceArtifact.refKind` (`types.ts:141`) and to the
  matching `ReferenceArtifactSchema.refKind` enum (`src/schemas.ts:95`).

### B. The engine does not move

`Rubric` (insight) keeps its `id`/`title` field names, so `evaluateRubric`,
`computeRubric`, the catalog functions in `rubricCore.ts` (`listRubrics`,
`resolveRubric`, `saveRubric`, …), the `/api/rubrics` route, and the Rubrics
console panel are **untouched**.

Bridge with a trivial adapter pair (new, small; lives where the gem build/install
code can reach both types — likely `@agentgem/model` alongside the type, or a
small module in root `src/`; pinned in the plan):

```ts
rubricToArtifact(r: Rubric): RubricArtifact   // { ...r, type: "rubric", name: r.id }  (drop id)
artifactToRubric(a: RubricArtifact): Rubric   // { ...a, id: a.name }                  (drop type)
```

Every other field is identical, so the adapters are ~5 lines each.

### C. The store stays JSON — the "legacy shim"

A rubric-gem needs **no** new catalog path. It routes through the existing JSON
store so a rubric-gem and a hand-authored `~/.agentgem/rubrics/*.json` are
indistinguishable to the engine:

- **Export:** a `Rubric` (built-in or user file) → `rubricToArtifact` → placed in a
  `Gem`'s `artifacts[]` at build time (in the gem-build path, `buildGem` / the
  selection→gem seam — pinned in the plan).
- **Install / materialize:** a `RubricArtifact` inside an installed gem →
  `artifactToRubric` → written to `~/.agentgem/rubrics/<name>.json` (the dir
  `loadRubrics` already reads, `rubricCore.ts:20-23`, 107-113). It then appears in
  the picker with zero changes to catalog / engine / UI.

Built-in rubric ids remain reserved: install must not overwrite a built-in id
(reuse the existing `builtinRubrics()` collision check that `saveRubric` /
`validateRubricInput` already enforce, `rubricCore.ts:99-101,118`).

### D. Schema + drift guard

Add `RubricArtifactSchema` to the `GemArtifactSchema` discriminated union in
`src/schemas.ts:129`, mirroring `validateRubric`'s constraints:

- `name`: kebab (`/^[a-z0-9][a-z0-9-]{0,63}$/`), `title`: non-empty, `target`:
  non-empty, `naturalScope`: `session|project|all` optional, `factors`: non-empty
  array of `{ factor: kebab, weight?: number>=0 }`, `criteria?`: array of
  `LlmCriterion` with the id-collision-with-detector rejection preserved.

Update the union drift-guard test in `src/__tests__/schemas.test.ts` (this test
**is** in CI, unlike `packages/*/src/__tests__`). Keep the TS union and the Zod
union in lockstep.

### E. Non-goals (deferred, do not build in Phase 1)

- Unified console library / "one authorable unit" UX → Phase 2.
- Publish-to-Explore surface for rubric-gems → Phase 2.
- Effectiveness-weighted evolve / universal spine → Phase 3.
- No change to scoring, caching, or transcript selection in `rubricCore.ts`.
- Scope stays a run parameter (`session | project | all`) exactly as today; the
  artifact only carries `naturalScope` as a hint.

## Testing

- **Round-trip:** `artifactToRubric(rubricToArtifact(r))` deep-equals `r` for
  built-ins and a representative user rubric (with `criteria`).
- **Install → run parity:** a gem carrying a `RubricArtifact` installs, writes the
  JSON, and `computeRubric` produces a report identical to running the original
  `Rubric` object.
- **Schema:** `GemArtifactSchema` accepts a valid rubric artifact and rejects
  malformed ones (bad name case, empty factors, criterion id colliding with a
  detector id).
- **No regression:** legacy `~/.agentgem/rubrics/*.json` still loads and lists
  unchanged; built-in id collision on install is refused.
- **Drift guard:** `schemas.test.ts` confirms the TS `GemArtifact` union and the
  Zod `GemArtifactSchema` both include `rubric`.

## Success criteria

A rubric can be bundled into a Gem, serialized into a `.gem` archive, and
installed on another machine, after which it appears in the rubric picker and runs
with identical results — with no change to the evaluation engine, the rubric
catalog, the `/api/rubrics` route, or the console UI.
