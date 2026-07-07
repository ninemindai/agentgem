# Context-Hygiene Boundary Segmentation (deterministic) — design

**Date:** 2026-07-07
**Status:** Draft for review
**Depends on:** PR #153 + #161 (merged) — the detectors, `buildHygieneReport`, the `HygieneReport` type + `/inspect/session/hygiene` endpoint, the per-session report UI, and the shared `_shared/BloatCurve`. Standalone branch `feat/hygiene-boundary-judge` off `origin/main`.

## Problem

The hygiene tiers prove a session's window *bloated* and that work *repeated*, but not **where** the clean break should have been. The first #153 insight reserved a `cost:"llm"` confirmer for "these K clusters were really N tasks — cut at turn 40." But most of that is **deterministic**: the session's task episodes and the best cut point are a change-point pass over the cluster sequence (`clusterOf(arg)`) the detectors already compute, aligned to the bloat curve. The only irreducibly-LLM part is judging whether two *structurally* distinct clusters were *semantically* one task — a refinement, not a prerequisite. This ships the deterministic answer; the LLM confirmer is explicitly deferred.

## Goal

In the #161 **Inspect → Session** report, when a session sprawled across ≥2 task areas, automatically show its **task-episode segmentation** (turn ranges → the area each touched) and the **single best cut point**, rendered as a marker + band shading on the same bloat curve the report already draws. No LLM, no new endpoint, no button — it rides the existing hygiene report.

**Non-goals (this spec):** the LLM confirm/refute + natural-language episode labels (deferred Tier-2 — see Deferred); batch/leaderboard boundary analysis; acting on the recommendation (it's advisory about a past session); any non-Claude session (rides #161's Claude-only report).

## Architecture

One pure function + additive plumbing. The scan, `buildHygieneReport`, the endpoint, and the curve are all reused; nothing new server-side except the pure segmenter.

### 1. `boundarySegments(session)` — the one new unit (`packages/insight/src/boundarySegments.ts`)

Pure: `SessionSequence → { segments, cutTurn }`. No fs, no LLM, no I/O. Testable with hand-built sessions.

```ts
export interface BoundarySegment { fromTurn: number; toTurn: number; label: string }   // label = cluster id, e.g. "pkg:insight"
export interface SessionBoundary { segments: BoundarySegment[]; cutTurn: number | null }

export function boundarySegments(session: SessionSequence): SessionBoundary;
```

**Algorithm** (all inputs already on the `SessionSequence` from #153/#161 — `steps` for clusters, `contextSeries` for turn alignment + the curve):

1. **Turn → cluster.** For each `ProcedureStep`, find its turn = the `contextSeries` entry with the largest `msgIndex ≤ step.msgIndex` (the assistant turn that emitted it); its cluster = `clusterOf(step.arg)`. Per turn, take the last non-null cluster (most recent action). Turns with no clustered step carry forward the previous cluster. Yields `turnCluster: (string|null)[]` of length `contextSeries.length`.

   **Clustering source (a deliberate, documented property).** `clusterOf(step.arg)` is the same bucketing the sprawl detector uses. The primary cluster source is the **file-path-bearing steps** — `Read`/`Edit`/`Write`/`Grep`/`Glob`, whose `arg` *is* the path (from `scrubStep`), so both `pkg:x` and `dir:x` resolve. A **Bash** step keeps its full command as `arg` (`scrubStep` → `arg: scrubText(command)`), but `clusterOf` derives a cluster from it **only when the command text contains `packages/<x>`** (e.g. `cd packages/insight`) — its `dir:` branch is start-anchored and never fires on a command that begins with the program name. So pathless commands (`npm test`, `git status`) and non-`packages/` path references in commands are **cluster-neutral** and carry forward the previous file-derived cluster. This is intended: a task *area* is defined by the files you touch; test/build/git commands are cross-cutting, not a new episode. The segmenter needs no Bash special-casing — `clusterOf` already yields this behavior.
2. **Smooth** out ping-pong blips: replace each turn's cluster with the dominant (mode) cluster in a window of ±`SMOOTH_W` (=2). This collapses single-turn detours so episodes are real stretches, not noise.
3. **Run-length encode** the smoothed sequence into contiguous episodes `{fromTurn, toTurn, label}`. Merge any episode shorter than `MIN_EPISODE` (=3 turns) into whichever neighbor it's closer to (or the previous), so tiny fragments don't clutter.
4. **Cut point.** If ≤1 episode → `cutTurn = null` (nothing to cut). Else, `cutTurn` = the episode boundary (a `fromTurn`) that maximizes the **context climb across it** — mean `ctxTokens` of the post-boundary episode minus mean of the pre-boundary episode. This puts the recommended cut where a new task area took over *and* the window grew most. Tie-break: earliest boundary.

Exported constants `SMOOTH_W`, `MIN_EPISODE` (like `RETRY_STORM_MIN`), tunable in one place.

### 2. Attach to the report (`packages/insight/src/sessionHygieneCore.ts`)

`buildHygieneReport(signal)` (from #161) gains one additive field, computed only when it's meaningful:

```ts
export interface HygieneReport {
  // ...existing: meta, curve, factors, hygiene
  boundary?: SessionBoundary;   // present only when the session has ≥2 task episodes
}
```

In `buildHygieneReport`, after building the rest: `const b = session ? boundarySegments(session) : undefined;` and attach `boundary: b` only when `b && b.segments.length >= 2`. No new endpoint — this flows through the existing `GET /inspect/session/hygiene` (#161) automatically. The `HygieneReportSchema` (server + client mirror) gains the optional `boundary`.

### 3. UI — `BloatCurve` overlays + report rendering

- **`packages/console/src/panels/_shared/BloatCurve.tsx`** — add two OPTIONAL props: `cutTurn?: number | null` (a dashed vertical marker at that turn) and `segments?: BoundarySegmentView[]` (faint alternating band shading behind the curve). Both default absent → the existing #161/#176 call sites are byte-compatible.
- **`packages/console/src/panels/Observe/HygieneReport.tsx`** — when `report.boundary` is present, pass `cutTurn`/`segments` to the `BloatCurve` it already renders, and show a small episode list below it: `fromTurn–toTurn: label` rows, with a one-line reading ("Looked like N task areas; a clean break around turn K would have kept each window lean."). Absent `boundary` → the report renders exactly as it does today (no new section).

## Data flow

```
Inspect → Session opens (existing #161 auto-load)
   ▼
GET /inspect/session/hygiene  →  buildHygieneReport(signal)
   │   ...curve, factors, hygiene (unchanged)
   │   + boundarySegments(session)  →  boundary? { segments, cutTurn }   [only when ≥2 episodes]
   ▼
HygieneReport.tsx: BloatCurve(curve, cutTurn, segments) + episode list + one-line reading
```

## Privacy

`boundarySegments` runs on the already-scrubbed `SessionSequence`; `label` is a low-cardinality **cluster id** (`pkg:x` / `dir:x`) — the same buckets the sprawl detector emits, never a raw `arg`/path. The report carries turn *indices* + cluster labels only. No new privacy surface (and no transcript content sent anywhere — the deferred LLM path is what would have needed that).

## Testing

- **Server (in CI, `src/gem/__tests__/`):**
  - `boundarySegments` — pure table over hand-built `SessionSequence`s: a two-cluster session (steps in `pkg:a` turns 0–N then `pkg:b`) → two episodes + a `cutTurn` at the transition; a single-cluster session → one episode, `cutTurn: null`; a ping-pong blip (one stray `pkg:b` step amid `pkg:a`) is smoothed away (still one episode); the `cutTurn` lands on the boundary with the larger context climb when two boundaries compete; **pathless Bash carry-forward** — a `Read packages/a/…` turn followed by several pathless `Bash` (`npm test`) turns then more `pkg:a` reads yields ONE `pkg:a` episode (the Bash turns don't fragment it), and a `Bash cd packages/b/…` turn DOES start a `pkg:b` episode; a session with no `contextSeries` degrades to `[]`/`null` without throwing.
  - `buildHygieneReport` — a ≥2-cluster fixture attaches `boundary` with the expected segments/cutTurn; a single-cluster fixture omits `boundary`.
  - `HygieneReportSchema` roundtrips a report carrying `boundary` (server↔client shape parity).
- **Client (local, not in root CI):** `HygieneReport` renders the episode list + passes `cutTurn`/`segments` to `BloatCurve` when `boundary` is present, and renders unchanged (no episode section) when absent. `BloatCurve` smoke: renders with the new props absent (backward-compat) and with a `cutTurn`/`segments` present.

## Files

- **Create** `packages/insight/src/boundarySegments.ts` — `boundarySegments` + types + `SMOOTH_W`/`MIN_EPISODE`.
- **Modify** `packages/insight/src/index.ts` — export the module.
- **Modify** `packages/insight/src/sessionHygieneCore.ts` — add `boundary?` to `HygieneReport`; compute + attach it (gated ≥2 episodes) in `buildHygieneReport`.
- **Modify** `src/gem.controller.ts` — add optional `boundary` to `HygieneReportSchema`.
- **Modify** `packages/console/src/api/routes.ts` — mirror `boundary?` (+ `BoundarySegmentView`) on the client `HygieneReport` schema/type.
- **Modify** `packages/console/src/panels/_shared/BloatCurve.tsx` — optional `cutTurn` + `segments` props.
- **Modify** `packages/console/src/panels/Observe/HygieneReport.tsx` — render the overlay + episode list when `boundary` present.
- **Create** `src/gem/__tests__/boundarySegments.test.ts` — server tests (CI).
- **Modify** `packages/console/src/panels/Observe/HygieneReport.test.tsx` — extend for the boundary-present/absent render (local).

## Constraints

- ESM `.js` import specifiers; 3-line copyright header on new files.
- **No LLM, no ACP, no new endpoint, no network** — `boundarySegments` is pure and rides the existing #161 hygiene report. This is the deterministic-first mandate.
- Reuse `clusterOf`, `buildHygieneReport`, the shared `BloatCurve`, and `contextSeries`/`steps` verbatim — no re-implemented clustering/scan/scoring.
- Additive: `boundary?` is optional; a session without ≥2 episodes and every existing report consumer are unaffected.
- Privacy: labels are low-cardinality cluster ids only, never a raw `arg`/path; the report carries indices + labels.
- Constants (`SMOOTH_W`, `MIN_EPISODE`) exported and tunable in one place.
- Server tests in `src/gem/__tests__/` (CI); console tests local-only.
- Commit identity Raymond Feng <raymond@ninemind.ai> with the `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>` trailer.

## Deferred: the LLM confirmer (a later, optional Tier-2)

Explicitly out of scope, to be its own spec if the deterministic version proves too coarse:
- **Semantic confirm/refute** — was a 2-cluster split *really* two tasks, or one task legitimately spanning two packages (a refactor)? Only intent-reading answers this. Would gate on the deterministic `boundary` being present, invoke the local ACP Claude agent (`criterionJudge` pattern) on the scrubbed transcript, and either confirm the cut or collapse the segments — on-demand, degrade-on-offline.
- **Natural-language episode labels** ("the API refactor" vs `pkg:insight`).
- Batch boundary-judging across the leaderboard; streaming.

The deterministic `boundary` field and the `BloatCurve` overlays are designed so this later layer slots in behind the same UI without reshaping either.
