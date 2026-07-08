# Optimize + Setup: global-vs-project scope

**Date:** 2026-07-08
**Status:** Approved design, ready for planning
**Branch:** `feat/optimize-project-scope`

## Problem

Optimize and Setup are **config/setup** tabs — they render the skills / MCP servers /
rules your agents run with. That config lives on **two layers**: machine-wide
`~/.claude` (global) and per-project `<root>/.claude` (project). Today both tabs only
ever show the global layer (the console never passes a `dir`/`root`), so you can't
inspect or tune a specific project's setup — even though the data model already
distinguishes the layers (`introspectProject` tags artifacts `source:"project"`, and
the Optimize Dashboard already treats project-source rows as prune-ineligible).

This is a **config axis (global ⟷ project)** — distinct from the activity axis
(session ⊂ project ⊂ all) that Overview/History/Insights live on. The fix is a scope
switch on the two config tabs, not an activity filter.

## Goal

Add a `Global | Project ▾` scope switch to **Optimize** (view + Disable/Re-enable
actions) and **Setup** (read-only inventory), sharing one project picker. In project
scope both tabs show the **effective** config a session in that repo runs with —
global ⊕ project, layer-tagged.

Non-goals: no changes to activity tabs; no project-level *override* mechanism that
shadows a global skill within one project (global rows in project scope are advisory
only); no scope switch on any other tab.

## Scope model

One scope value, shared by both tabs:

```
Scope = { kind: "global" }                 // default — today's behavior
      | { kind: "project", root: string }  // absolute project path
```

On the wire: an optional `root=<abs path>` query param. **Presence of `root` means
project/effective scope.** Absence = global. Fully backward-compatible: existing
callers omit `root` and get today's behavior.

Project picker: reuse the existing project list from `GET /api/testbed/projects`
(discovered) + `GET /api/testbed/recents` (recents), the same source Insights and
Rubrics already use. Extract a shared `panels/_shared/ScopePicker.tsx` used by both
tabs (a `Global` button + a searchable recents/candidates list capped at ~40, led by
the currently-selected project).

## The effective/merged model + the safety rule (crux)

In project scope, the inventory shown is the **effective** config for that repo:

```
effective(root) = introspectConfig()          // global layer
                ⊕ introspectProject(root)      // project layer
```

Every artifact row carries `layer: "global" | "project"`.

**Safety invariant — you can only prune the layer the current scope owns:**

| Scope | prunable layer | advisory layer |
|-------|----------------|----------------|
| Global | `global` rows | `project` rows (already ineligible today) |
| Project | `project` rows | `global` rows |

So a **project view can never prune a global skill** — closing the exact hazard the
merged view introduces (pruning a global skill from a project context would silently
affect every other project). Enforcement is server-side: `buildOptimizePayload` sets
`prune=false` for any row not in the scope's owned layer. The UI renders advisory rows
with a "global — manage in Global scope" note and no Disable button.

## Usage semantics

- **Global scope:** usage scanned across all transcripts (unchanged).
- **Project scope:** usage scanned within **that project's** transcripts only —
  answers "am I actually using this *here*". Reuse the existing per-project transcript
  scan (the mechanism Insights `computeInsights(root)` / Mine's scorecard already use
  to resolve a project root to its Claude transcript set). Advisory global rows in a
  project view show project-scoped usage too — informational only, since they're not
  prunable there.

Project-local skills physically cannot run outside their repo, so project-scoped usage
is both correct and non-surprising for the prunable (project) layer.

## API changes (all additive, backward-compatible)

### `GET /api/optimize`
- Add optional query `root?: string`.
- `root` present → inventory = `effective(root)` (layered); usage = project-scoped;
  `disabled` = `listDisabled` scoped to the project (`DisableOptions` targeting
  `<root>/.claude` etc.).
- `OptimizeArtifact` gains `layer: "global" | "project"`. `prune` already reflects
  owned-layer eligibility.
- `change: {file, key}` for **project-layer** rows points at `<root>/.claude/...`
  (project paths) instead of `~/.claude/...`. New `changeHint` variant parameterized
  by a root (global keeps `~/...`).

### `POST /api/optimize/disable` and `POST /api/optimize/enable`
- Body gains optional `root?: string`. When present, the handler builds
  `DisableOptions { claudeDir: <root>/.claude, agentDir: <root>/.agents,
  codexDir: <root>/.codex, hermesDir: <root>/.hermes }` so the (reversible) disable
  relocates into `<root>/.agentgem/disabled` instead of the global archive. The
  re-enable path re-scans the project inventory + project usage to rebuild rows.
- **Guard:** the server rejects a disable whose target row is not in the scope's owned
  layer (defense-in-depth behind the UI hiding the button).

### `GET /api/inventory` (Setup)
- Add optional query `root?: string`. Present → merged layered inventory
  (`introspectAll(global) ⊕ introspectProject(root)`), each item gains `layer`.
- Absent → today's global-only inventory (each item `layer:"global"`).

### Project list
No new route — reuse `GET /api/testbed/projects` + `GET /api/testbed/recents`.

## UI changes

### Optimize (`panels/Optimize/index.tsx`, `Dashboard.tsx`)
- Header gains the shared `ScopePicker` (`Global | Project ▾`). Scope state lives in
  `index.tsx` and is threaded into the `/api/optimize` fetch (adds `root`) and into
  `disable`/`enable` calls.
- Each artifact row shows a small `layer` badge (`global` / `project`).
- Prunable rows (owned layer) keep the Disable/Re-enable control. Advisory rows
  (non-owned layer) show the "manage in Global scope" note, no action.
- The instructions-health table and Discover sub-section stay global for this cut
  (Discover is skills.sh recommendations, not project config) — noted, not scoped.

### Setup (`panels/Setup/index.tsx`)
- Header gains the same `ScopePicker`. Scope threaded into the `/api/inventory` fetch.
- Each artifact card shows a `layer` badge. Read-only — no actions, so no safety rule
  to enforce; much simpler than Optimize.

## Testing

- **insight (`optimizeAnalyze`)**: merged layered inventory → project rows
  `prune`-eligible, global rows `prune=false`; correct `layer` tags; project-layer
  `change.file` uses the project root.
- **insight (`optimizeScan`)**: project scope scans only the project's transcripts
  (usage scoped); global scope unchanged.
- **capture (`disableArtifact`)**: disable with project `DisableOptions` relocates the
  skill under `<root>/.agentgem/disabled` and `listDisabled` scoped to the project
  reads it back (temp-home test).
- **server**: `GET /api/optimize?root=…` and `GET /api/inventory?root=…` return
  layered merges; `disable` with `root` round-trips against a temp project; the
  owned-layer guard rejects a global-row disable in project scope.
- **console**: `ScopePicker` renders and switches; Dashboard shows Disable on project
  rows and advisory note on global rows in project scope (Dashboard test); Setup shows
  layer badges. (Console tests run locally — not in CI.)

## Build order

1. **Optimize** end-to-end (scope model, effective merge, safety rule, project usage,
   project-targeted disable, UI).
2. **Setup** reusing the shared `ScopePicker` + `layer` badge (read-only, small).

## Feasibility notes (verified against current code)

- `introspectProject(root)` returns a full project `ProjectInventory`
  (`packages/capture/src/introspect.ts`).
- `buildOptimizePayload(inv, usage, range, now)` is already source-agnostic
  (`packages/insight/src/optimizeAnalyze.ts`); it needs the `layer` output + owned-layer
  prune rule + a root-aware `changeHint`.
- `scanArtifactUsage(inv, claudeDir)` already takes a transcript dir
  (`packages/insight/src/optimizeScan.ts`); project scope supplies the project's
  transcript set.
- `disableArtifacts` / `enableArtifacts` / `listDisabled` already accept
  `DisableOptions { claudeDir, agentDir, codexDir, hermesDir }`
  (`packages/capture/src/disableArtifact.ts`); the archive base derives from
  `dirname(claudeDir)`, so a project `claudeDir` lands the archive in the project.
