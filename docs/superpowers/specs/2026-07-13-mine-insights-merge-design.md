# Mine + Insights → one tab, two views

**Date:** 2026-07-13
**Status:** Design approved; ready to plan
**Scope:** `packages/console` (nav shell + Mine/Insights panels), one client-stream signature change

## Problem

The console exposes **Mine** and **Insights** as two separate Observe-phase tabs
that answer two halves of the same question — *"what in my agent history is worth
publishing?"*

- **Mine** (`src/gem/scorecard.ts`, `panels/Mine`): a **deterministic, per-project**
  inventory of reusable workflows. Auto-streams a scorecard on open (SWR-cached,
  cheap, glanceable). Metrics: `breadth` / `battleTested` / `portable`.
- **Insights** (`packages/insight/insightsReport.ts`, `panels/Insights`): an
  **LLM-judged, per-session** outcome report. You pick a project, then it drives a
  local ACP Claude agent over that project's sessions (expensive, on-demand).
  Metrics: outcome totals, per-model breakdown, friction, publish candidates.

They currently sit in different sidebar categories (Mine = `projects`, Insights =
`usage`), so Insights renders *above* Mine with the Sessions items wedged between.
The concepts are one job split across two crowded tabs.

## Decision

Merge them into a **single 💎 Mine tab with two views** behind a segmented control,
sharing one project selector.

Decisions locked during brainstorming:

1. **One tab, two views** (not adjacency, not status quo).
2. **Shared project context**: a single project selector at the top of the tab;
   both views respect it.
3. **Outcomes runs on explicit action**: the expensive LLM report never auto-runs
   on segment switch or scope change — it fires only on a **Generate/Refresh**
   click. A cached report paints instantly via SWR.
4. **Tab name stays "Mine."**

## UX & behavior

```
💎 Mine        [ All projects ▾ ]        ← shared project selector (default: All projects)
┌───────────┬──────────┐
│ ▸Workflows │ Outcomes │                 ← segmented control (default: Workflows)
└───────────┴──────────┘
```

- **Workflows** (today's scorecard): auto-streams on open and reacts to the shared
  scope.
  - Scope = **All projects** → today's cross-project scorecard (top-12 MRU, no
    behavior change — Mine's native strength).
  - Scope = **one project** → that project's card only. The server already supports
    this (`selectScorecardRoots` honors an explicit `projects` list and bypasses the
    12-project cap).
- **Outcomes** (today's Insights): shows the scoped project plus a **Generate
  report** button; the LLM fires only on click. If a cached report exists for that
  project it paints instantly (SWR) and the button reads **Refresh**.

"All projects" maps cleanly to both views: Workflows omits the `projects` param
(native discover-all), Outcomes passes `root="*"` (its existing cross-project mode).

## Architecture & components

This is a **shell-and-extract refactor**, not new domain logic. Both server streams
already accept a project scope, so the shared selector is wiring, not surgery.

### New / changed components (all under `packages/console/src`)

- **`panels/Mine/index.tsx`** — becomes a thin **shell**. Owns two pieces of state:
  - `scope: string` — selected project path, or `"*"` for All projects.
  - `view: "workflows" | "outcomes"` — the active segment.

  Renders: `ProjectScope` → segmented control → the active view. Reads the initial
  `view` from the hash query (`?view=`) and writes it back on switch.

- **`panels/Mine/ProjectScope.tsx`** — the shared selector. Reuses the exact data
  Insights already fetches: `testbedProjectsRoute` + `testbedRecentsRoute`, with
  "All projects" (`"*"`) leading the list. Emits `onChange(scope)`.

- **`panels/Mine/Workflows.tsx`** — today's Mine scorecard body, extracted into a
  view taking `{ apiBase, scope }`. When `scope !== "*"`, it passes `projects:[scope]`
  to the stream.

- **`panels/Mine/Outcomes.tsx`** — today's Insights report body, taking
  `{ apiBase, scope }`, **minus its own project picker** (now shared). Keeps the
  explicit generate/refresh flow, `openInsightsStream`, `InsightsCharts`,
  `InsightsReportCard`, and `ReportActions`.

### Client stream change

- **`panels/Mine/scorecardStream.ts`** — `openScorecardStream` gains an optional
  `projects?: string[]` in its `opts`. When present, it JSON-encodes them into the
  `projects` query param the server's `streamScorecard` already parses
  (`parseProjects`). No server change required.

### Removed

- **`panels/Insights/index.tsx`** (the standalone page + embedded picker). Its
  report/stream/chart modules (`insightsStream.ts`, `InsightsCharts.tsx`,
  `InsightsReportCard.tsx`) move under `panels/Mine/` (or are imported from their
  current location by `Outcomes.tsx` — implementation's call, favor fewest moves).
- `insightsPage` entry in `panels/Insights/index.tsx` and its import/array-entry in
  `pages.tsx`.

## Routing & nav

- The merged tab stays at Mine's current slot: `phase: "observe"`,
  `category: "projects"`, `order: 10`, `id: "mine"`, `icon: "💎"`,
  `title: "Mine"`.
- **Segment is reflected in the hash**: `#/mine?view=workflows|outcomes`
  (default `workflows` when absent).
- **Legacy redirect**: `#/insights` → `#/mine?view=outcomes` via the existing
  `LEGACY_ROUTES` table + `normalizeHash` in `registry.ts` (the mechanism built for
  the Gems merge). This preserves old links and the `notify/events.ts` deep-links
  for free.
- **Project scope stays in-component state** (not the hash), matching Insights'
  current behavior. YAGNI on project deep-links.

## Data flow

```
Mine shell (scope, view)
  │
  ├─ ProjectScope ──onChange(scope)──▶ shell.setScope
  │      (testbedProjectsRoute + testbedRecentsRoute, "All projects" leads)
  │
  ├─ view==="workflows" ─▶ Workflows({apiBase, scope})
  │        └─ openScorecardStream(apiBase, onEvent,
  │              { projects: scope === "*" ? undefined : [scope] })
  │              └─▶ GET /api/scorecard/stream?projects=[...]  (server already parses)
  │
  └─ view==="outcomes"  ─▶ Outcomes({apiBase, scope})
           └─ [Generate/Refresh] ─▶ openInsightsStream(apiBase, scope, onEvent, fresh)
                 └─▶ GET /api/insights/stream?root=<scope>  (unchanged)
```

## Error handling

- Unchanged per-stream: both `openScorecardStream` and `openInsightsStream` already
  emit a `failed` event and close on connection error; the views already surface it.
- `ProjectScope`: if `testbedProjectsRoute`/`testbedRecentsRoute` fail, fall back to
  `[{ path: "*", label: "All projects" }]` (mirrors Insights' current `.catch(() => [])`).
- Switching segments while a Workflows stream is mid-flight must close it
  (`closeRef` cleanup already present in both panels) so the two views never stream
  concurrently against a stale scope.

## Testing

- **`registry.test.ts`** (or wherever `normalizeHash` is tested): `#/insights` →
  `#/mine?view=outcomes`; existing `#/mine` and `#/mine?view=...` pass through.
- **Shell** (`panels/Mine/__tests__`): segment switch flips `view` and updates the
  hash; scope change propagates to the mounted child; only one view mounts at a time.
- **`scorecardStream.test.ts`** (extend): `openScorecardStream` includes the
  `projects` query param when scoped to a project; omits it for `"*"`/undefined.
- **Outcomes** (extend `insightsStream` coverage): does **not** auto-run on
  mount/segment-switch; Generate triggers exactly one `openInsightsStream`; Refresh
  passes `fresh`.
- Reuse existing `card.test.ts` / `InsightsCharts.test.tsx` /
  `InsightsReportCard.test.tsx` against the extracted view components.

> Note: `packages/console` tests are **not** in CI (see memory `ci-skips-console-tests`).
> Run `pnpm --filter @agentgem/console test` and typecheck locally before finishing.

## CSS

The marketplace has no CSS framework, but the **console** does carry its own styles.
Reuse existing classes (`warming-pill`, `obs-head`/`obs-title`, `analyze-*`,
`targets-label`, `ws-chip`, segmented-control classes if present). Any **new**
`ex-*`/class name needs a matching rule in the same change — grep before finishing.

## Out of scope (YAGNI)

- Unifying the two reports into a single combined view.
- Project deep-links in the hash.
- Changing either scan's underlying algorithm or the server routes.
- Cross-model outcome view for Workflows (Outcomes owns `by_model`).
