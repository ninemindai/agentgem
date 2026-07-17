# Distilled gems land in a workspace (Mine → Distill → Gem persistence)

**Date:** 2026-07-17
**Status:** Draft — awaiting review (run `/plan-eng-review` before implementing)
**Scope:** small server change (`/api/scorecard/build`) + console wiring. Reuses the
existing workspace store end-to-end; no new storage layer.

## Problem

`Distill → Gem` on `#/mine` assembles a real gem — but only in memory.
`POST /api/scorecard/build` (`gem.controller.ts:996`) returns the gem JSON and
persists nothing; the console shows a "✓ Built" banner with an inline SKILL.md
viewer (added 2026-07-17), and then the gem is garbage. Consequences:

- The banner's viewer is the **only** window onto the built gem; navigate away
  and it's gone. There is still nothing durable to open, share, render to a
  target, or install.
- The Mine card grid's **"Distilled" maturity stage is inference, not state** —
  nothing records that a workflow was ever distilled. Same root cause as the
  redesign's deferred `publishedNames` follow-up ("Shared" stage dormant).
- `src/goldmine/draftGem.ts:9`: *"There is no persistent 'Curate draft store' in
  this repo."*

## Grounding — the store already exists (do NOT build a new one)

- `packages/base/src/workspaces.ts` — `createWorkspace(name, gem)` writes a
  **lock-verified gem archive** (`gem.json` + artifact files via
  `writeGemArchive`/`writeArchiveDir`) under `AGENTGEM_HOME/workspaces/<name>/`;
  `listWorkspaces()` / `readWorkspace()` / delete + render-to-target routes and
  the console **Workspaces panel** (`panels/Workspaces/index.tsx`) already
  consume it, including "Open → re-curate" reconstruction from the artifact
  list.
- Precedent for dual-writing: `packages/play/src/miniapps.ts:4-5` — every
  miniapp save already dual-writes a one-artifact `game` gem **via
  `createWorkspace`** so a miniapp is simultaneously a file and a gem.

So the design is: **`Distill → Gem` dual-writes through the same seam.**

## Design

### 1. Server: `/api/scorecard/build` gains `stash` (opt-in dual-write)

`ScorecardBuildRequestSchema` adds `stash: z.boolean().optional()`. When true,
after `buildGem(...)`:

```ts
const wsName = freshWorkspaceName(gem.name);   // gem-name, gem-name-2, … (see §Naming)
createWorkspace(wsName, gem);
return { ...gem, workspace: wsName };
```

`GemSchema`'s response gains `workspace: z.string().optional()` (server AND the
hand-written console mirror — the client parse strips undeclared keys, so the
console schema must declare it; drift-guard with a key-set assertion, not bare
`safeParse`).

**Naming:** `createWorkspace` throws on an existing dir (mkdir-as-claim).
`freshWorkspaceName` probes `name`, `name-2`, `name-3`, … against
`workspaceDir(name)` existence — mirroring the miniapp create path's
collision behavior rather than upserting: re-distilling after more sessions
should produce a **new** workspace, never silently overwrite one the user may
have rendered or edited.

**Compat:** `stash` omitted → behavior exactly as today (assemble + return).
The console always sends `stash: true`; the flag exists so `agentgem` CLI /
API callers keep pure-assembly semantics.

### 2. Console: "✓ Built" links to the workspace

- `WorkflowsView.onBuild` sends `stash: true` and keeps `workspace` in
  `buildResult`.
- The `BuildResult` banner appends: `→ saved to workspace <name>` as a link to
  `#/workspaces` (highlighting/scrolling to the named row — smallest version:
  plain link to the panel; the row is sorted most-recent-first so it's on top).
- The inline SKILL.md viewer stays — it is the zero-click confirmation; the
  workspace link is the durable address.

### 3. Mine: "Distilled" maturity becomes real state

`WorkflowsView` already fetches inventory + usage + miniapps to compose
`toUnifiedGems`. Add the (already-bulk) `workspacesRoute` to that fetch and
pass workspace summaries in; `unifiedGems.ts` marks a workflow's maturity
`distilled` when a workspace contains a `skill` artifact with the workflow's
skeleton name. This turns the maturity stage from inference into disk-backed
state, and gives the deferred `publishedNames`/"Shared" follow-up its pattern
to copy.

## Data flow

```
Mine card ── Distill → Gem ──▶ POST /api/scorecard/build {selections, name, stash:true}
                                     │
                        loadProject → candidates → skeletons
                                     │
                               buildGem(...)          AGENTGEM_HOME/workspaces/<name>/
                                     │                        ▲
                          createWorkspace(fresh name) ────────┘   (same seam as miniapp dual-write)
                                     │
                     ◀── gem JSON + workspace name ──
                                     │
        "✓ Built …" banner: inline SKILL.md viewer + link → #/workspaces
                                     │
        Workspaces panel: open / render to target / delete   (all pre-existing)
                                     │
        Mine maturity "Distilled" ← workspacesRoute summaries (skill-name match)
```

## Error handling

- `createWorkspace` fails (disk, invalid name) → the build itself succeeded;
  return the gem with `workspace` absent plus a non-fatal `stashError` string;
  banner shows the viewer and "couldn't save to a workspace: <why>" instead of
  the link. Never fail the whole request for a stash error.
- Gem names come from workflow names — run through `workspaceName`'s
  `safePathSegment` gate via `freshWorkspaceName`; a name that sanitizes
  differently is slugified first (mirror `saveMiniapp`'s stance: reject/mangle
  is resolved at the seam, tested).
- Concurrent double-click: `mkdirSync` (non-recursive) inside `createWorkspace`
  is the atomic claim; the probe loop retries on `EEXIST`.

## Testing

Server (`src/__tests__/`, temp `AGENTGEM_HOME`):
1. `stash:true` → workspace dir exists with `gem.json` + skill artifact file;
   response carries `workspace`; re-distill same name → `-2` suffix, both
   listed by `listWorkspaces()`.
2. `stash` omitted → no `workspaces/` write (assert dir absent).
3. Stash failure (pre-create the dir read-only / stub createWorkspace throw) →
   200 with `stashError`, no `workspace`.

Console (vitest/jsdom):
4. Build result renders the workspace link when `workspace` present; renders
   `stashError` copy when absent+error.
5. Drift-guard: `workspace`/`stashError` survive the client parse (key-set
   assertion).
6. `unifiedGems`: workflow whose skeleton name matches a workspace skill →
   maturity `distilled`; no match → unchanged.

Manual: distill on `#/mine` → follow the link → open the workspace → render a
target; confirm the archive round-trips (`readWorkspace` lock check passes).

## Files touched

- `src/schemas.ts` + `src/gem.controller.ts` — `stash` param, dual-write,
  `workspace`/`stashError` response fields, `freshWorkspaceName`.
- `packages/console/src/api/routes.ts` — declare new fields (strip trap).
- `packages/console/src/panels/Mine/{WorkflowsView,BuildResult}.tsx` — send
  flag, render link/error.
- `packages/console/src/panels/Mine/unifiedGems.ts` (+ WorkflowsView fetch) —
  distilled-maturity wiring.
- Tests as above.

## Out of scope

- Hosted publish / share of the stashed workspace (existing Share flows apply
  unchanged; `publishedNames`/"Shared" maturity remains the follow-up this
  spec's §3 pattern unblocks).
- A separate "gem stash" storage layer, browser, or lifecycle UI — Workspaces
  IS the stash; if workspaces need grouping/tagging later, that's its own spec.
- Auto-distill (building gems without a click) and effectiveness/benchmark
  runs on distilled gems.
- CLI flag surface for `stash` (server accepts it; CLI wiring when needed).
