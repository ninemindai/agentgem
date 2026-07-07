# Live Context-Hygiene Nudge (Watch) — design

**Date:** 2026-07-06
**Status:** Draft for review
**Depends on:** PR #161 (merged) — `buildHygieneReport` / `sessionHygieneCore.ts`. This branch (`feat/watch-hygiene-nudge`) is a standalone follow-up off `origin/main`.
**Visual lineage:** `mockups/context-bloat-report.html` (curve), `mockups/ember-session-game.html` (the anti-doomscroll framing this makes real, in quiet form).

## Problem

PR #153/#161 made context hygiene **retrospective** — you open a finished session and see how healthy its context was. But the highest-value moment is *while a session is running*: a long session drifts past the point where it should have been cut, and nothing tells you. We want a **live, prospective nudge** — watch an active session and, the moment its context hygiene escalates past a threshold, surface a quiet "consider a clean break" banner. The intent (from the original exploration) is anti-doomscroll: make *stopping clean* the rewarded move, without nagging someone who keeps their sessions bounded.

## Goal

In the console **Watch** tab, while a user is viewing a live Claude session's Feed, show a dismissible nudge banner (with a live bloat-curve sparkline) when that session's hygiene **escalates** to `mixed` or `bloated`. Fires once per escalation; re-arms if the session clears and re-bloats; silent while healthy.

**Non-goals:** ambient/background nudging when the console isn't open on the session (no daemon, no OS notification — v1 is only-while-watching); the gamified EMBER widget; Codex support (the bloat curve needs per-turn `usage`); any change to the watched session itself (the nudge is advisory — the console cannot clear an external agent's context).

## Architecture

Three units. The scan and curve are reused verbatim from #161; the only new logic is a pure nudge-trigger function and a file-tailing SSE endpoint (a clone of the existing `watchEvents.ts`).

### 1. Reuse helper — `hygieneReportForFile(path)`

Add to `src/sessionHygieneCore.ts`, beside `sessionHygiene`. `sessionHygiene(id, agent)` resolves a session by id and needs the project inventory; the Watch endpoint instead has a **file path already resolved to a watch root**, and the hygiene detectors need only `contextSeries` + the scrubbed step spine — **not** resolved artifacts. So this helper scans the one file with a minimal empty inventory (the same shape the #161 tests use) and returns the report:

```ts
const MINIMAL_INV = { project: { root: "", skills: [], mcpServers: [], hooks: [], instructions: [] }, global: { skills: [], mcpServers: [], hooks: [] } };

export function hygieneReportForFile(path: string): HygieneReport {
  return buildHygieneReport(scanWorkflow([path], MINIMAL_INV as ScanInventory, { retainSequences: true }));
}
```

No new detector logic; `buildHygieneReport` is imported/reused as-is.

### 2. Nudge trigger — `nudgeTransition(prev, next)` (pure, the only new logic)

`src/watchHygieneNudge.ts` (small, pure, no I/O):

```ts
export type Verdict = "bounded" | "mixed" | "bloated";
const RANK: Record<Verdict, number> = { bounded: 0, mixed: 1, bloated: 2 };

// Fire ONLY on escalation to a heavier verdict (bounded→mixed/bloated, mixed→bloated).
// Same-or-lower (staying heavy, or dropping toward bounded after a /clear) is silent —
// one nudge per climb, natural re-arm after a drop. `prev === null` on first snapshot:
// fire only if the session opens already past bounded.
export function nudgeTransition(prev: Verdict | null, next: Verdict): "fire" | "silent" {
  if (next === "bounded") return "silent";
  if (prev === null) return "fire";              // opened already heavy
  return RANK[next] > RANK[prev] ? "fire" : "silent";
}
```

This is the anti-doomscroll core: it structurally cannot nag a session that stays bounded, and rewards the drop (re-arm, no penalty).

### 3. SSE endpoint — `GET /api/watch/hygiene?file=`

`src/watchHygiene.ts`, a sibling of `watchEvents.ts` (same tail-on-mtime scaffold: `resolveTranscriptFile`, `sourceForFile`, `POLL_MS=1000`, `HEARTBEAT_MS=15000`, SSE `send(event, data)`). Per connection it holds `lastVerdict: Verdict | null`.

- On connect: `send("phase", { phase: "watching" })`. If the file's source is not Claude, `send("phase", { phase: "unsupported" })` and stream nothing further (heartbeat only) — the curve needs `usage`.
- On each mtime change: `const rep = hygieneReportForFile(resolved)`.
  - Always `send("hygiene", { verdict, score, curveTail, factors })` — `curveTail` = the last N (≈120) `TurnUsage` points + `cap`, so the client sparkline stays current. `factors` = the fired hygiene `DetectorSummary` rows only (privacy: counts/advice, never an arg).
  - If `nudgeTransition(lastVerdict, rep.hygiene.verdict) === "fire"`, also `send("nudge", { verdict, advice })` where `advice` is the highest-severity fired factor's `advice` (fallback to a generic "context is heavy — a clean break keeps it sharp").
  - Set `lastVerdict = rep.hygiene.verdict`.
- Errors/`scanWorkflow` returning no session degrade to a quiet snapshot (empty curve), never crash the stream (matches `watchEvents` robustness).

Wire it in `src/index.ts` beside the other `watch*` stream routes.

## UI

- **`packages/console/src/panels/Watch/hygieneStream.ts`** — a mirror of `eventStream.ts`: `openHygieneStream(apiBase, file, onEvent)` subscribing via `EventSource` to `/api/watch/hygiene?file=`, dispatching typed `hygiene` / `nudge` / `phase` / `failed` events, returning an unsubscribe.
- **`packages/console/src/panels/Watch/HygieneNudge.tsx`** — rendered at the top of `SessionFeed` (which already owns the per-`file` subscription lifecycle), keyed on `file`.
  - `bounded` (or no data): renders nothing.
  - Live `hygiene` snapshots update an internal state (verdict, score, curveTail) but do NOT force the banner open.
  - On a `nudge` event: show a dismissible banner — verdict chip + the `advice` line + a small live bloat-curve sparkline (reuse the #161 `BloatCurve` canvas, heat-toned, reading real `--accent`/`--muted` tokens). Dismiss records the dismissed verdict; a later `nudge` at a **higher** verdict re-shows (dismiss a `mixed`, still get pinged on `bloated`).
  - `phase: "unsupported"` (Codex): render nothing.

## Data flow

```
Watch tab → SessionFeed({file})  ── mounts ──►  HygieneNudge({apiBase, file})
                                                     │ openHygieneStream(/api/watch/hygiene?file=)
   server: tail file on mtime ──► hygieneReportForFile ──► buildHygieneReport (#161 core)
                                                     │
        every tick:  send("hygiene", {verdict, score, curveTail, factors})
        on escalation: send("nudge", {verdict, advice})   ← nudgeTransition(lastVerdict, verdict)
                                                     ▼
   sparkline + score stay live (silent);  banner slides in only on a nudge; dismiss re-arms on escalation
```

## Testing

- **Server (in CI, `src/gem/__tests__/`):**
  - `nudgeTransition` — a full table: every `(prev ∈ {null,bounded,mixed,bloated}) × (next)` pair → expected `fire`/`silent`, explicitly covering re-arm (`bloated→bounded→mixed` fires twice) and no-renag (`mixed→mixed→bloated` fires only on the `bloated`).
  - `hygieneReportForFile` — on a fixture Claude transcript written to a temp dir (reuse #161's fixture writer): curve populated, verdict present, no throw; a tool-free/short file yields an empty curve without error.
- **Client (local, not in root CI):** `HygieneNudge.test.tsx` — renders nothing on a `bounded` snapshot; shows the banner + advice on a `nudge` event; dismiss hides it; a subsequent higher-verdict `nudge` re-shows. Sparkline smoke-tested ("renders without throwing"), consistent with #161.

## Files

- **Modify** `src/sessionHygieneCore.ts` — add `hygieneReportForFile(path)` + `MINIMAL_INV`.
- **Create** `src/watchHygieneNudge.ts` — `Verdict` type + pure `nudgeTransition`.
- **Create** `src/watchHygiene.ts` — the SSE tail endpoint.
- **Modify** `src/index.ts` — register the `/api/watch/hygiene` route beside sibling `watch*` streams.
- **Create** `packages/console/src/panels/Watch/hygieneStream.ts` — client SSE subscriber.
- **Create** `packages/console/src/panels/Watch/HygieneNudge.tsx` — the banner + sparkline.
- **Modify** `packages/console/src/panels/Watch/SessionFeed.tsx` — render `<HygieneNudge>` at the top.
- **Create** `src/gem/__tests__/watchHygieneNudge.test.ts` — `nudgeTransition` table + `hygieneReportForFile` fixture (in CI).
- **Create** `packages/console/src/panels/Watch/__tests__/HygieneNudge.test.tsx` — component test (local).

## Constraints

- ESM `.js` import specifiers; 3-line copyright header on new files.
- Reuse `buildHygieneReport` and the `BloatCurve` canvas verbatim — no re-implemented detector/threshold/curve logic.
- Privacy: streamed events carry verdict/score + integer curve points + `DetectorSummary` counts/advice only — never an `arg`/path. `curveTail` is `TurnUsage` integers.
- The SSE endpoint follows `watchEvents.ts` exactly for tailing, heartbeat, scope-resolution, and robustness (never crash the stream on a bad tick).
- Claude-only; Codex files get a `phase: "unsupported"` and no banner.
- Server tests in `src/gem/__tests__/` (CI); console tests local-only.
- Commit identity Raymond Feng <raymond@ninemind.ai> with the `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>` trailer.

## Out of scope (later follow-ups)

- Ambient nudging when not watching (warm-daemon watcher + OS/desktop notification + a which-sessions selection).
- The full interactive EMBER game widget.
- Tier-2 LLM boundary-judge on the live stream ("cut at turn N").
- A user-configurable threshold (ship the `mixed`/`bloated` defaults; make them tunable only if asked).
