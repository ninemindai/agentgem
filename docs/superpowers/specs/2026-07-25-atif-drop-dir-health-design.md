# ATIF drop-dir health panel — design

**Date:** 2026-07-25
**Status:** approved (design)
**Builds on:** PR #538 (ATIF import diagnostics)

## Problem

The ATIF drop dir (`~/.agentgem/atif`) is AgentGem's interchange on-ramp — the one
ingestion surface whose input is authored by someone other than us (Harbor
converters, third-party exporters). PR #538 gave the parser a diagnostics channel
so a rejected or lossy file is no longer silent, but those diagnostics currently
reach only a server log line at scan time.

The failure mode this leaves open: a user drops converter output into the drop
dir, opens Watch expecting the imported sessions, and sees nothing — because the
files that *failed to parse never appear in the Active-sessions list at all*.
There is no in-product way to learn which files failed or why.

This design surfaces those diagnostics as a debugging panel: **which files failed,
and why**, so the user can fix the converter or the file.

## Goal / non-goals

**Goal:** an actionable debug panel in the Watch tab that lists ATIF import
failures grouped by reason, with the offending file names, visible only when
there is something to debug.

**Non-goals (YAGNI until asked):**
- No dismiss / acknowledge / mute.
- No per-file re-scan button, no delete-bad-files action.
- No polling — fetch on mount and on the existing Refresh only.
- No positive "everything imported" confirmation. The panel is invisible when
  the drop dir is clean or empty (decided: hide unless there are issues).

## Architecture

Three layers, each testable in isolation. FS work stays in `@agentgem/insight`
(the Node layer); the app route is one line; the console component is dumb.

### Layer 1 — Insight: one pure grouping helper + one FS entry point

Reuses the existing `scanAtifSessions`, which since #538 already returns
`{ stats, diagnostics }`.

```ts
// packages/insight/src/atif/atifDiagnostics.ts — pure, no FS
export interface AtifHealthFile {
  /** basename only — never an absolute path (see Privacy). */
  name: string;
  /** e.g. "step 2" for step-scoped codes; absent for whole-file rejections. */
  detail?: string;
}
export interface AtifHealthGroup {
  code: AtifDiagnosticCode;
  /** isFileRejection(code) — drives red (rejected) vs amber (degraded) in the UI. */
  rejection: boolean;
  /** sum of per-diagnostic counts within this code. */
  occurrences: number;
  /** distinct offending files, by basename. */
  files: AtifHealthFile[];
}
export function groupDiagnostics(diags: AtifDiagnostics): AtifHealthGroup[];
```

```ts
// packages/insight/src/sources/atif.ts — FS, next to scanAtifSessions
export interface AtifHealth {
  totalFiles: number;   // *.json in the drop dir
  imported: number;     // stats.length
  groups: AtifHealthGroup[];  // empty when clean
}
export async function scanAtifHealth(env?: SourceEnv): Promise<AtifHealth>;
```

`scanAtifHealth` resolves the drop root exactly as the source does
(`atifSource.roots(env)` → `listFiles(root, ".json")`), calls `scanAtifSessions`,
and returns `{ totalFiles, imported: stats.length, groups: groupDiagnostics(diagnostics) }`.

`groupDiagnostics`:
- Groups diagnostics by `code`.
- `rejection = isFileRejection(code)` (the #538 helper).
- `occurrences` = sum of each diagnostic's `count ?? 1`.
- `files` = distinct basenames of `diagnostic.path`; `detail = "step N"` when
  `stepId` is present.

### Layer 2 — App: one thin route

```ts
// packages/app/src/appCommon.ts, beside /api/watch/sessions
server.expressApp.get("/api/watch/atif-health", originGuard, async (_req, res) =>
  res.json(await scanAtifHealth() as never));
```

`originGuard`, local-only, GET, no params — identical shape to the adjacent
`/api/watch/sessions`. All FS/grouping lives in insight, so the route is one line.

### Layer 3 — Console: a self-contained `AtifHealth` component

- New `packages/console/src/panels/Watch/AtifHealth.tsx`.
- Rendered at the top of the Watch left column, above "Active sessions".
- Fetched via a plain `fetchAtifHealth(apiBase)` added to
  `packages/console/src/panels/Watch/watchStream.ts`, matching the existing
  `fetchSessions` idiom (the Watch endpoints are consumed by plain `fetch`, not
  typed `defineRoute`). Refreshed by the same Refresh button as the session list.

**Counting (defined once to avoid ambiguity):**
- `totalFiles`, `imported` come straight from `AtifHealth`. A rejected file is
  *not* imported; a degraded file *is* imported (it parsed, just lossily). So
  `totalFiles = imported + (rejected files)`.
- `problemFiles` = the component's own count: the size of the union of every
  group's `files`. This is the honest headline number — distinct files needing
  attention — and it does not double-count a file that has multiple issues or
  inflate on a single file with many occurrences.
- A group's `occurrences` (e.g. "40×") is shown only *within* that group's row,
  never summed into the headline.

**Render rules:**
- Renders `null` unless `groups` is non-empty. A clean or empty drop dir shows
  nothing; non-ATIF users never see the panel.
- With issues: a collapsed summary line —
  `▸ ATIF drop-dir · {imported}/{totalFiles} imported · {problemFiles} with issues`
  — coloured **red** if any group has `rejection: true`, else **amber**.
- Expanded: one row per group, ordered rejections first, then degradations.
  A group with >N files elides the tail as `… (+K)`:

```
▾ ATIF drop-dir · 3/20 imported · 18 with issues
  ✗ unknown_schema_version — 12 files          (rejected)
      conv-1.json  conv-2.json  … (+10)
  ✗ no_steps — 5 files                          (rejected)
      empty-a.json  empty-b.json  …
  ⚠ orphan_tool_result — 40×, 1 file           (degraded)
      partial.json (step 2)
```

  (Self-consistent: 12 + 5 = 17 rejected files, none imported; 1 degraded file
  among the 3 imported; `totalFiles` = 3 + 17 = 20; `problemFiles` = 17 + 1 = 18.)

- Each code carries a one-line human gloss so the user knows what to fix, e.g.
  `unknown_schema_version` → "not an ATIF file — wrong or missing schema_version".

## Privacy

Carries forward the #538 invariant that diagnostics never expose transcript
content, and adds a path constraint:

- `groupDiagnostics` maps every `diagnostic.path` to its **basename**. The panel
  and the API response never receive absolute paths.
- Diagnostics already carry only a code, path, step id, count, and (regex-gated)
  schema version — no transcript content. #538's marker test guards this at the
  parser boundary.

## CSS

This is the **console** package (`packages/console`), not the marketplace, so the
CLAUDE.md `ex-*`/`styles.css` rule maps to the console's
`packages/console/src/shell/theme.css`. Reuse existing tokens and classes
(`ws-chip`, `run-badge`, `analyze-*`, `ledger-*`) and add a small
`.watch-atif-*` block mirroring the sibling `.watch-attn-banner` that already
lives there. Verified in a real browser via the `verify` skill, not just jsdom.

## Testing

- **Insight — `groupDiagnostics` (pure):** grouping by code, basename mapping,
  `occurrences` summing (including collapsed `count`), `step N` detail, rejection
  flag, and rejection-before-degradation ordering.
- **Insight — `scanAtifHealth` (FS):** a temp drop dir with a good file, a junk
  file, and a foreign-format (`trajectory-v1`) file → asserts `totalFiles`,
  `imported`, the expected groups, and that no absolute path appears anywhere in
  the output. Extends the existing `src/__tests__/atif.test.ts`.
- **Console — `AtifHealth.test.tsx` (jsdom):** renders nothing when `groups` is
  empty; collapsed summary counts; expand shows groups; rejection vs degradation
  styling; the `(+N)` file elision.
- **Browser:** `verify` skill confirms the actual appearance in the Watch tab.

## Perf note

The panel re-scans the drop dir on each fetch, but it is gated behind an explicit
Watch visit + Refresh, and `scanAtifSessions` already has the #538 incremental
parse cache, so repeat scans are cheap. Acceptable; no caching layer added.

## Files touched

| File | Change |
|---|---|
| `packages/insight/src/atif/atifDiagnostics.ts` | + `groupDiagnostics`, `AtifHealthGroup`, `AtifHealthFile` |
| `packages/insight/src/sources/atif.ts` | + `scanAtifHealth`, `AtifHealth` |
| `packages/insight/src/index.ts` | (already re-exports the atif modules) |
| `packages/app/src/appCommon.ts` | + `/api/watch/atif-health` route |
| `packages/console/src/panels/Watch/watchStream.ts` | + `fetchAtifHealth` + types |
| `packages/console/src/panels/Watch/AtifHealth.tsx` | new component |
| `packages/console/src/panels/Watch/index.tsx` | render `<AtifHealth>` above Active sessions |
| `packages/console/src/shell/theme.css` | `.watch-atif-*` block |
| `src/__tests__/atif.test.ts` | + `groupDiagnostics` / `scanAtifHealth` tests |
| `packages/console/src/panels/Watch/AtifHealth.test.tsx` | new |
