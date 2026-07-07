# Cross-Session Context-Hygiene Leaderboard — design

**Date:** 2026-07-07
**Status:** Draft for review
**Depends on:** PR #153 + #161 (both merged) — the five context-hygiene detectors, `hygieneScore`, `HYGIENE_FACTOR_IDS`, and the gated `RubricReport.hygiene`. Standalone branch off `origin/main`.

## Problem

Context hygiene is now visible **per-session** (Inspect → Session report, #161) and **live** (Watch nudge, #176). What's missing is **breadth**: "across all my sessions, which ones dragged their context worst?" A user can't yet run one scan and get a ranked list of their least-clean sessions. The engine already computes everything needed — it just isn't surfaced as a cross-session view.

## Goal

Add a built-in `context-hygiene` rubric and a **worst-first leaderboard** of the sessions that tripped a hygiene factor, in the existing Rubrics panel. Running it at scope "all" produces: an aggregate `bounded/mixed/bloated` verdict, the five factors worst-first, and a ranked table of the needs-attention sessions — each with its own verdict/score and a deep-link to its #161 per-session report.

**Non-goals:** ranking *all* scanned sessions including the clean ones (only the tripped/needs-attention sessions are enumerated; the clean count is shown in the header); any new scan or endpoint (the Rubrics panel's existing run/scope/stream plumbing is reused); the Tier-2 LLM boundary-judge; a separate leaderboard route/page.

## Naming (a required distinction)

`builtinRubrics()` already contains a rubric id'd `"hygiene"` whose factors are `retry-storm` / `thrash-loop` / `no-verify-finish` — the process-quality detectors, **not** the five context-hygiene detectors. The new rubric MUST use a distinct id `context-hygiene`; do not edit or overload `"hygiene"`.

## Architecture

Three small units; everything else (the scan, the detectors, `hygieneScore`, the panel's run/scope/stream) is reused.

### 1. The built-in rubric (`packages/insight/src/rubrics.ts`)

Add to the array returned by `builtinRubrics()`:

```ts
{
  id: "context-hygiene",
  title: "Context hygiene",
  target: "overview",
  naturalScope: "all",
  factors: [
    { factor: "task-sprawl" },
    { factor: "task-pingpong" },
    { factor: "reread-churn" },
    { factor: "context-pinned" },
    { factor: "cache-churn-late" },
  ],
}
```

All five referenced factors are `cost: "cheap"` detectors already in the `DETECTORS` registry, so the rubric runs deterministically at scope "all" with no LLM. It is session-granular (every factor is a session detector), so `scopeAllowed(rubric, "all"|"project")` is true. When it runs, `evaluateRubric` already attaches the aggregate `hygiene` verdict (from #161's `assessesHygiene`-gated field, which fires because these are the five recognized factor ids).

### 2. Per-session verdict on the report (`packages/insight/src/rubricReport.ts`)

`RubricReport.perSession` is `{ sessionId, transcript, factors: DetectorSummary[] }[]` (capped at `PER_SESSION_CAP=200`, only sessions with ≥1 finding). Add one field per entry: `hygiene?: HygieneVerdict`, computed with the already-exported `hygieneScore(entry.factors)` at the site where `perSession` is built. Additive and gated the same way the aggregate is — only attach it when the entry's factors include a hygiene factor (reuse `assessesHygiene(entry.factors)`), so non-hygiene rubrics' per-session rows are unchanged.

Interface change:
```ts
perSession?: { sessionId: string; transcript: string; factors: DetectorSummary[]; hygiene?: HygieneVerdict }[];
```

### 3. The leaderboard UI (`packages/console/src/panels/Rubrics/`)

In `RubricReportCard` (and the mirrored `RubricReportView` / `perSession` type in `rubricStream.ts`), when `perSession` entries carry a `hygiene` verdict, render a **ranked leaderboard** instead of the current bare "N sessions tripped a factor" line:

- **Header:** "`sessionsScanned` sessions scanned · `perSession.length` need attention" (+ "(showing the first 200)" when `perSessionTruncated`).
- **Rows, sorted worst-first** (ascending `hygiene.score`): transcript basename as a link to `#/inspect/claude/<sessionId>` (the #161 per-session report), a verdict chip (`bounded`/`mixed`/`bloated`, reusing the `.hyg-verdict.is-*` classes), the score, and the single highest-count fired factor's title.
- **Fallback:** when entries lack `hygiene` (any non-hygiene rubric), render the existing plain per-session summary unchanged.

The aggregate verdict badge (from `report.hygiene`) renders above the factor list when present, reusing #161's verdict styling.

## Data flow

```
Rubrics panel → pick "Context hygiene" + scope "all" → run()
   │  openRubricStream → /api/rubric/stream (existing)
   ▼
evaluateRubric(signal, context-hygiene rubric)
   │  runs the 5 cheap detectors over every scanned session
   ▼
RubricReport { factors[], hygiene{verdict,score},           ← aggregate
               perSession: [{ sessionId, transcript, factors, hygiene{verdict,score} }] }  ← per session (tripped only, +verdict)
   │
   ▼
RubricReportCard: aggregate badge + factors worst-first + ranked leaderboard (deep-links to Inspect → Session)
```

## Testing

- **Server (in CI, `src/gem/__tests__/`):**
  - `builtinRubrics()` includes `context-hygiene` with exactly the five factor ids; it is distinct from `"hygiene"`; `scopeAllowed(it, "all")` and `scopeAllowed(it, "project")` are true.
  - `evaluateRubric` over a fixture of a few scanned sessions (a clean one + a bloated one, reusing the #161/#176 fixture writers) attaches `hygiene` to each `perSession` entry via `hygieneScore`; the clean session is absent from `perSession`; the bloated one is present with `verdict: "bloated"`. A non-hygiene rubric's `perSession` entries have `hygiene` undefined.
- **Client (local, not in root CI):** `RubricReportCard` renders the leaderboard when `perSession` entries carry `hygiene` — rows sorted worst-first, verdict chips, the scanned/needs-attention header, and a deep-link `href` to `#/inspect/claude/<id>`; and renders the existing plain summary (no leaderboard) when they don't.

## Files

- **Modify** `packages/insight/src/rubrics.ts` — add the `context-hygiene` rubric to `builtinRubrics()`.
- **Modify** `packages/insight/src/rubricReport.ts` — add `hygiene?` to the `perSession` interface + compute it (gated by `assessesHygiene`) where `perSession` is built; import `hygieneScore`/`assessesHygiene`/`HygieneVerdict` from `./contextHygiene.js`.
- **Modify** `packages/console/src/panels/Rubrics/rubricStream.ts` — mirror `hygiene?` on the client `perSession`/`RubricFactorView` types.
- **Modify** `packages/console/src/panels/Rubrics/index.tsx` — the leaderboard rendering branch in `RubricReportCard`.
- **Modify** `packages/console/src/shell/theme.css` — minimal leaderboard row/table styles (reuse `.hyg-verdict.is-*` + existing tokens).
- **Create** `src/gem/__tests__/contextHygieneRubric.test.ts` — rubric + per-session-verdict tests (in CI).
- **Create** `packages/console/src/panels/Rubrics/__tests__/HygieneLeaderboard.test.tsx` — leaderboard render test (local).

## Constraints

- ESM `.js` import specifiers; 3-line copyright header on new files.
- Reuse `hygieneScore` / `assessesHygiene` / the scan / the detectors verbatim — no re-implemented scoring or threshold logic.
- The `context-hygiene` rubric id is distinct from the existing `"hygiene"` rubric.
- Privacy: `perSession` already carries `sessionId` + `transcript` (a basename) + `DetectorSummary` counts/advice — the added `hygiene` is a verdict/score. No `arg`/path introduced.
- Additive: the `hygiene?` per-session field is optional; non-hygiene rubrics and their existing rendering are unaffected.
- Server tests in `src/gem/__tests__/` (CI); console tests local-only.
- Commit identity Raymond Feng <raymond@ninemind.ai> with the `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>` trailer.

## Out of scope (later follow-ups)

- Ranking all scanned sessions including bounded ones (payload-size work; the header count suffices for v1).
- Tier-2 LLM boundary-judge; ambient warm-daemon nudging; the interactive EMBER widget.
- A dedicated leaderboard route/page separate from the Rubrics panel.
- Org-level / cross-user hygiene aggregation.
