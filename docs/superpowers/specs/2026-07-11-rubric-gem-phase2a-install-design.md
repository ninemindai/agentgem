# Rubric-gem Phase 2A — install-back wiring — design

**Date:** 2026-07-11
**Status:** Approved for planning.
**Predecessor:** Phase 1 (PR #343, merged) added `RubricArtifact`, the `.gem` archive
read/write for rubrics, and `installRubricGem(gem, dir?)` in `src/rubricCore.ts` —
but `installRubricGem` is **called from nowhere** except its own test.

## Problem

A `.gem` archive can now *carry* a rubric, but no install path installs it. When a
rubric-gem is received (import a `.gem`, redeem a transfer, install from the hosted
aggregator or the GitHub registry), its rubric is **silently discarded** —
`gemToInventory` (`packages/run/src/runGem.ts:156`) has no `rubric` branch and the
three install handlers never touch the rubric store. Phase 2A closes that: a
received rubric-gem's rubric lands in `~/.agentgem/rubrics/` and shows up in the
Rubrics picker.

This is the smallest, most self-contained Phase 2 slice: **no inventory-model
change, no `GemSelection` change, no console UI, no `capture→insight` dependency**
(all of which belong to the later "bundle & publish" slice 2B).

## Decision: install at receive-time, on all three paths

A rubric lives at `~/.agentgem/rubrics/` (**global**) and has no per-target home —
no target's materializer emits it. So it installs the moment a gem enters the
setup, on every receive path:

- `applyGem` (`src/gem.controller.ts:901`) — `.gem` import / transfer redeem →
  `materializeGemToTestbed`.
- `installHosted` (`src/gem.controller.ts:664`) — zero-config hosted install →
  `createWorkspace`.
- `registryInstall` (`src/gem.controller.ts:1285`) — GitHub registry, both
  `workspace` and `materialize` modes.

### The deliberate asymmetry (documented, not a bug)

`installHosted`/`registryInstall(workspace)` call `createWorkspace`, which only
*stashes* the gem archive — a bundled **skill** isn't installed anywhere until the
workspace is later rendered to a target. A **rubric** is global with no render
step, so it installs *immediately* at receive-time. This asymmetry is inherent to
rubrics being global; it is the chosen behavior, and the spec calls it out so it
doesn't read as inconsistent.

## Design

### 1. Call `installRubricGem` in each handler

`installRubricGem(gem)` (default dir = `defaultRubricsDir()` = `~/.agentgem/rubrics`)
runs once per handler, after the gem is verified/available:

- `applyGem`: after `importGem`.
- `installHosted`: **after** the consent gate and `createWorkspace` (so a refused
  install writes nothing).
- `registryInstall`: after `resolveInstall` yields `gem`, before returning, in
  both modes.

`installRubricGem` already: filters `type === "rubric"`, runs each through
`validateRubric`, **skips built-in ids** (`hygiene`, `context-hygiene`) and invalid
rubrics, writes valid ones to `<dir>/<id>.json`, returns `{ installed, skipped }`.

### 2. Consent gate is unaffected

Rubrics are declarative data — `executableArtifacts` (`src/gem/hostedInstall.ts:11`)
filters only `mcp_server`/`hook`, so a rubric never counts as executable and a
**rubric-only gem installs without a consent prompt**. No change to the gate;
the spec records this as a verified invariant (a test asserts it).

### 3. Surface `{ installed, skipped }` in each response

Add an additive **optional** field to each response schema and its console-route
mirror, populated from `installRubricGem`'s return (omitted/empty when the gem
carries no rubric):

```ts
rubrics: z.object({ installed: z.array(z.string()), skipped: z.array(z.string()) }).optional()
```

- `GemApplyResponseSchema` (`src/schemas.ts:776`) + `gemApplyRoute` response
  (`packages/console/src/api/routes.ts:418`).
- `InstallHostedResult` (inline, `src/gem.controller.ts:16`) + `installHostedRoute`
  response (`routes.ts:809`).
- `RegistryInstallResponseSchema` (`src/schemas.ts:980`) + `registryInstallRoute`
  response (`routes.ts:298`).

### 4. `gemToInventory` — document, don't change

`gemToInventory` (`runGem.ts:156`) partitions a gem into the `ConfigInventory`
shape used for **testbed materialization** of skills/mcp/hooks/etc. A rubric is not
a per-project testbed artifact, so it correctly does not belong there — that field
is slice 2B. Add a one-line comment noting rubrics are installed globally by
`installRubricGem`, so the omission reads as intentional. **No `ConfigInventory`
change in 2A** (that is the `capture→insight` dependency decision, deferred).

## Non-goals (later slices)

- **2B:** producing a rubric-gem — `rubrics` on `ConfigInventory`/`GemSelection`,
  `introspectConfig` loading rubrics, `buildGem` resolving them, the Curate
  "Rubrics" category.
- **2C:** console unification — `RubricLibrary` vs the unified library,
  `WorkspaceSummary.artifactCounts`/chips gaining a `rubric` bucket.
- No change to the eval engine, catalog, `/api/rubrics`, or the Rubrics/RubricLibrary panels.

## Testing

Root `src/**/__tests__` (CI-gated; suite = `tsc -b && vitest run` against `dist/`):

- **Per handler** (`applyGem`, `installHosted`, `registryInstall`): a gem carrying a
  rubric → call the handler → `loadRubrics(store)` lists the rubric **and** the
  response's `rubrics.installed` names it.
- **Built-in collision:** a gem whose rubric id is `hygiene` → `rubrics.skipped`
  contains it, `installed` does not, and the built-in file is untouched.
- **Non-rubric gem:** an existing skill-only gem installs exactly as before;
  `rubrics` is empty/absent (no behavior change).
- **Consent:** a rubric-only gem does **not** trigger `installHosted`'s
  `consent_required` 409.

Isolate the rubric store per test with the existing `AGENTGEM_HOME` seam: the
handlers call `installRubricGem(gem)` with the **default** dir
(`defaultRubricsDir()` → `agentgemHome()`, which honors `AGENTGEM_HOME`,
`packages/model/src/resolveDir.ts:28`). Tests set `process.env.AGENTGEM_HOME` to a
`mkdtempSync` temp dir in `beforeEach`/restore in `afterEach` — the same pattern as
`src/__tests__/gemTools.share.test.ts:15` and `chatStudio.test.ts:10`. No wire
contract is widened for testing and no `dir` is injected through the controller.

## Success criteria

Receiving a rubric-gem through any of the three install paths lands its rubric in
`~/.agentgem/rubrics/`, where `loadRubrics`/`resolveRubric` already read, so it
appears in the Rubrics picker — and each install response reports which rubric ids
were installed vs skipped. No existing non-rubric install changes behavior.
