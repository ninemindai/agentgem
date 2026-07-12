# Rubric-gem Phase 2C — console polish & "one authorable unit" — design

**Date:** 2026-07-12
**Status:** Approved for planning (autonomous goal).
**Predecessors:** 2A install-back (#354), 2B bundle/publish (#364) — both merged.

## Problem

2B made rubrics bundleable, but three console rough edges remain:
1. A bundled rubric is **invisible in the workspace surface** — `countArtifacts`
   has no `rubric` bucket, so the "Yours" workspace cards never chip it.
2. Curate lists a rubric by its **kebab `name`** (`team-hygiene`), not its human
   `title` (`Team hygiene`) — inconsistent with `RubricLibrary`, which shows the title.
3. `RubricLibrary` (authoring) and the unified Curate library are **disconnected** —
   no way to go from "I authored a rubric" to "bundle it into a gem" without
   manually finding it in Curate. This is the "one authorable unit" gap.

2C closes all three. It is console-only + one small server count field — no engine,
`buildGem`, or wire-selection change (2B already carries the selection).

## Design

### Piece 1 — Workspace rubric chip

- `packages/base/src/workspaces.ts`: add `rubric: number` to
  `WorkspaceSummary.artifactCounts` (the interface, line ~23) and to
  `countArtifacts`'s seed object (line ~57). It's **required** (a count is always
  present); `countArtifacts` already only increments keys present in its seed, so a
  bundled rubric now counts.
- `packages/console/src/api/routes.ts`: add `rubric: z.number()` to
  `WorkspaceSummarySchema.artifactCounts` (line ~114).
- `packages/console/src/panels/Workspaces/index.tsx`: add
  `{ label: "rubrics", n: c.rubric }` to `countChips` (line ~10, before `checks`).
- **Fixture updates** (required-field ripple): add `rubric: 0` to the
  `artifactCounts` literals in `Workspaces.test.tsx:23`,
  `ActiveGemSwitcher.test.tsx:13,15`, `Publish/index.test.tsx:7`.

### Piece 2 — Curate shows the rubric title

The server already sends `title` end-to-end (`RubricArtifact.title` →
`InventorySchema.rubrics`); only the console type drops it.
- `packages/console/src/api/routes.ts`: add `title: z.string().optional()` to the
  loose `ArtifactSchema` (line ~8). (Runtime already passes it through; this makes
  it typed.)
- `packages/console/src/panels/Curate/data.ts`: add `title?: string` to `LedgerItem`
  (line ~3); in `groupInventory`'s item map, add `title: a.title`.
- The Curate row render: show `item.title ?? item.name` (so non-rubric categories,
  which have no title, still show `name` unchanged). Locate the row-label JSX in
  `Curate/index.tsx` and swap `item.name` → `item.title ?? item.name` **only** at
  the display label (keep `name` as the selection key / identity everywhere else).

### Piece 3 — RubricLibrary "Bundle into gem" button

Reuse the exact pattern Workspaces' "Open" button already uses
(`Workspaces/index.tsx:125`: `setKeys(new Set(includeToKeys(...)))` +
`window.location.hash = "#/curate"`).
- `packages/console/src/panels/RubricLibrary/index.tsx`: add a "Bundle" action to
  each `RubricRow` (alongside Edit/Delete/Run) that does:
  ```ts
  setKeys(new Set([...getKeys(), selKey("rubrics", r.id)]));
  window.location.hash = "#/curate";
  ```
  importing `setKeys, getKeys` from the `activeGem` store and `selKey` from
  `Curate/selection.js`. This lands the rubric pre-checked in Curate's Rubrics
  category, where the user saves/publishes via the existing 2B path. **Additive**
  to the existing selection (union with `getKeys()`), not a replace, so it composes
  with an in-progress Curate selection.

## Non-goals

- No full merge of `RubricLibrary` authoring INTO Curate — the "Bundle" button is
  the bridge; authoring stays in `RubricLibrary`. (A bigger unification is out of
  scope.)
- No change to the eval engine, `/api/rubrics`, `buildGem`, or the wire selection.

## Testing

- **CI-gated (root):** `src/__tests__/gem.controller.test.ts` — create a workspace
  from a rubric-carrying gem (or `/api/workspaces` from a `{rubrics:["team"]}`
  selection with a seeded user rubric), then `GET /api/workspaces` and assert the
  summary's `artifactCounts.rubric === 1`. This gates the count end-to-end.
- **Console (local-only, not CI):**
  - `Workspaces.test.tsx`: `countChips` includes `{ label: "rubrics", n }`.
  - Curate test: a rubric inventory item renders its `title`.
  - New `RubricLibrary` test: clicking "Bundle" adds `selKey("rubrics", id)` to the
    `activeGem` keys and navigates to `#/curate` (mock the store + `location.hash`).
- New `packages/base` `workspaces.test.ts` for `countArtifacts` (not in CI) is
  optional; the controller test is the CI gate.

## Success criteria

A rubric authored in `RubricLibrary` can be bundled into a gem in one click; the
Curate library shows it by its title; and a workspace built with a rubric shows a
"1 rubrics" chip — the rubric is a fully first-class, visible member of the gem
authoring surface.
