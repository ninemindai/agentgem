# Rubric-gem Phase 2B — bundle & publish (producer side) — design

**Date:** 2026-07-12
**Status:** Approved for planning (autonomous goal: 2B/2C plan→review→impl→PR).
**Predecessors:** Phase 1 (#343) `RubricArtifact` + adapters; Phase 2A (#354) install-back wiring.

## Problem

Phase 2A made a *received* rubric-gem install. But you still can't *produce* one:
`buildGem` has no `rubrics` branch and `ConfigInventory` has no `rubrics` field, so
a rubric can never enter a gem through the app. 2B is the producer side — select a
user rubric in the console's Curate library and bundle/publish it as a rubric-gem.

## Key facts that shape the design

- **No dependency landmine.** `@agentgem/capture` *already* depends on
  `@agentgem/insight` (`packages/capture/package.json:20`), and insight does not
  depend on capture — so `introspectConfig` can load rubrics via
  `loadRubrics`/`rubricToArtifact` with no new dependency and no cycle.
- **Rubrics are global**, not per-project (`~/.agentgem/rubrics`). So the field goes
  on `ConfigInventory`, never `ProjectInventory`; the selection lives on the
  top-level `GemSelection`, never `ProjectSelection`.
- **User rubrics only.** The inventory offers `loadRubrics()` (user files) — NOT
  `builtinRubrics()`. Built-ins are code-defined everywhere and `installRubricGem`
  refuses their ids, so bundling them is pointless.
- **Optional field.** `ConfigInventory.rubrics?: RubricArtifact[]` is optional
  (mirrors the existing `projects?` precedent). A required field would break the
  `ConfigInventory` literal at `packages/run/src/runGem.ts:157` and ~25 test
  literals; optional breaks none.

## Design (edit sites)

### 1. Model — `packages/model/src/types.ts`
Add to `ConfigInventory` (after `subagents`, before `projects?`):
```ts
rubrics?: RubricArtifact[];   // global user rubrics available to bundle (2B). Optional: not every inventory has them.
```
`RubricArtifact` is already defined in this file. `ProjectInventory` is unchanged.

### 2. Capture — `packages/capture/src/introspect.ts`
Import `loadRubrics, rubricToArtifact` from `@agentgem/insight` (already a dep).
In `introspectConfig`'s return literal (line 286), add
`rubrics: loadRubrics().map(rubricToArtifact)`. This surfaces the user's rubric
files as `RubricArtifact[]` in the global inventory. `introspectProject` is
unchanged (rubrics are global).

### 3. Build — `packages/build/src/buildGem.ts`
- `GemSelection`: add `rubrics?: string[]` to the non-`all` object variant (top
  level only, not `ProjectSelection`).
- `{all:true}` case: append `...(inventory.rubrics ?? [])` to the global push.
- Add a resolution loop mirroring `skills` exactly (against `inventory.rubrics ?? []`,
  `InvalidInputError` on a missing name), among the global-category loops. The
  redaction guard only touches mcp/hook, so a rubric passes through untouched.

### 4. Server schemas — `src/schemas.ts`
- `InventorySchema` (line 212): add `rubrics: z.array(RubricArtifactSchema).optional()`
  (`RubricArtifactSchema` already exists from Phase 1). Required so `/api/inventory`'s
  response validation doesn't strip the field.
- `GemSelectionSchema` (line 247, the object variant): add
  `rubrics: z.array(z.string()).optional()`. `ProjectSelectionSchema` unchanged.

### 5. `/api/inventory` handler — `src/gem.controller.ts`
No handler code change needed: `introspectAll` → `introspectConfig` now returns
`rubrics`, and `decorateInventory` leaves it untouched (rubrics aren't in
`BODY_COLLECTIONS` — they have no `content` body / entity path, matching the
mcp/hook precedent). The field flows through once `InventorySchema` (step 4)
declares it.

### 6. Console — `packages/console/src/api/routes.ts`
- `InventorySchema` (line 22): add `rubrics: z.array(ArtifactSchema).optional()`
  (the loose `ArtifactSchema` accepts a rubric artifact — it has `name`).
- `GemSelectionSchema` (line 96, object variant): add
  `rubrics: z.array(z.string()).optional()`.

### 7. Console Curate — `packages/console/src/panels/Curate/`
- `data.ts`: add `"rubrics"` to the `InventoryCategory` union and
  `{ key: "rubrics", type: "rubric", label: "Rubrics" }` to `CATEGORIES`.
  `groupInventory` renders it through the existing loop (rubric items show `name`).
- `selection.ts`: add `rubrics?: string[]` to the panel `GemSelection`,
  `rubric: "rubrics"` to `GROUP_OF`, and a `byGroup.rubrics` branch to
  `buildSelection`.

## Non-goals (2C / later)

- `WorkspaceSummary.artifactCounts`/chips gaining a `rubric` bucket, and the
  `RubricLibrary`-vs-unified-library reconciliation → **2C**.
- Showing the rubric's `title` (vs `name`) in the Curate row → 2C polish (2B lists
  by `name`, like every other category).
- No change to the eval engine, `/api/rubrics`, the run-and-report surface, or
  `installRubricGem` (2A).

## Testing

- **buildGem** (`packages/build` → root test): a `ConfigInventory` with a
  `rubrics` entry + a selection `{ rubrics: ["x"] }` yields a `Gem` whose
  `artifacts` contains the rubric; `{ all: true }` includes it; a missing name
  throws `InvalidInputError`.
- **introspectConfig** (capture → root test): with `AGENTGEM_HOME` pointing at a
  temp dir holding `~/.agentgem/rubrics/x.json`, `introspectConfig().rubrics`
  contains `x` as a `RubricArtifact`; built-ins are absent.
- **API** (`gem.controller.test.ts`): `GET /api/inventory` returns the user rubric
  under `rubrics`; `POST /api/archive` with `{ rubrics: ["x"] }` produces an
  archive carrying the rubric artifact (read it back with `readGemArchive`).
- **Console** (Curate.test.tsx, local-only — console tests aren't in CI): the
  "Rubrics" group renders and a checked rubric round-trips into `buildSelection`'s
  `rubrics`.

Tests that must gate in CI live under root `src/**/__tests__`.

## Success criteria

A user rubric appears as a "Rubrics" category in the Curate library; selecting it
and saving/publishing produces a gem whose archive carries the `RubricArtifact`,
which (via 2A) installs into the picker on the other side — the full
author→share→install loop closed.
