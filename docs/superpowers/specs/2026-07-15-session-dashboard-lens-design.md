# Session Dashboard lens — design

**Date:** 2026-07-15
**Status:** implemented (follow-on to the session-blast-radius lenses, PR #433)

## What

The Watch panel's agent-generated HTML dashboard, moved to where it's most useful for
review: a **▤ Dashboard** lens in History → Session's structure toggle
(◆ Map | ◎ Blast | ∿ Context | ▤ Dashboard | ≣ Transcript). For a completed session it is
generated once on first open and **cached by (sessionId, transcript mtime)**, so
reopening is instant; a Regenerate button forces a fresh pass.

## How

- **Generator reused, not duplicated:** `renderDashboard` (packages/insight/dashboardRender.ts)
  gains two optional fields — `final: true` switches the prompt framing from "LIVE
  dashboard of a running session" to "FINAL dashboard of a COMPLETED session", and
  `onDelta` streams progress chunks (same wiring as `reportRender`). The live Watch
  path is untouched (both fields default off).
- **Input bounding** (`src/sessionDashboardCore.ts`): the live path feeds the agent
  ≤~40-event bursts; a whole historical transcript can be thousands of events with long
  text. `capDashboardEvents` clips each span's free text to 400 chars and keeps the
  session's head (20) + tail (120) with a visible `[… N events omitted …]` marker.
- **Transport:** `GET /api/inspect/session/dashboard` — a `streamOf:` SSE route on
  `gem.controller.ts` mirroring the rubric-report pattern exactly (`pump`,
  `beginForeground`/`endForeground`, events `start | delta | done | failed`,
  `fresh=true` skips the cache). Only tagged `DashboardInputError` messages are echoed;
  unexpected faults emit a generic message (no path leakage).
- **Cache:** `packages/insight/src/dashboardCache.ts`, the `analysisCache` shape with
  `root → sessionId` and token `dv1:<transcript mtimeMs>` (version-bumped when the
  dashboard contract changes). `~/.agentgem/session-dashboard-cache.json`, 50 entries,
  one per session, best-effort.
- **Client:** `panels/Observe/dashboardStream.ts` (typed `route.stream()` mirror, same
  as `rubricStream.ts`) + `SessionDashboard.tsx` — progress note while generating, then
  ONE sealed iframe (`sandbox="allow-scripts"`, `sandboxDoc` CSP — reused from
  panels/Watch). No SSE double-buffer: this is one-shot, not a live feed.
- Claude-only, matching the Blast/Context lenses; the tab hides for codex.

## Not done (deliberately)

- Removing the Watch Dashboard tab — live sessions still want the evolving dashboard;
  this lens covers the historical side. (Remove later if Watch usage says otherwise.)
- Codex support (needs a codex session resolver by id; the extractor `codexSessionEvents`
  already exists when that lands).
