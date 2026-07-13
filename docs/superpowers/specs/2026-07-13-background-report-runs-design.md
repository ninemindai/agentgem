# Background report runs

**Date:** 2026-07-13
**Status:** SUPERSEDED IN PART by the eng review (2026-07-13).

> **Read this first.** The engineering review (`/plan-eng-review`) pivoted the
> implementation away from the `ReportRunManager` + serial queue + new SSE-view
> design described below to a **lightweight registry over the existing routes**.
> Reasons: the serial queue was a concurrency *regression* (today the three report
> kinds run concurrently) with a wedge-blocks-everything risk and no cancel, and the
> new SSE-view route added nothing over polling on the status-only reattach path.
> The existing SSE routes already continue-and-cache after disconnect, so goals 2
> (notify) and 3 (visibility) need only a small in-flight registry the routes update.
> **The authoritative build is `../plans/2026-07-13-background-report-runs.md`.**
> The problem statement, goals, non-goals, and the concurrency/persistence/activity/
> reattach *decisions* below still hold; the *mechanism* (manager/queue/SSE-view) does
> not. Kept below for the reasoning trail.

## Problem

In the local console app, actions that drive a coding agent (via ACP) to generate
a report — Insights, Rubric evaluation, Mine scorecard, Curate analyze, gem-run —
run *inside the HTTP request that streams them*. The panel opens an `EventSource`,
folds `phase`/`delta`/`done` events into component `useState`, and tears the stream
down on unmount. Navigating away therefore:

- closes the stream and **discards all in-progress UI state** (phase, deltas, the
  eventual report),
- gives **no signal when the work finishes**, and
- leaves the user no way to **see what's running or come back to a finished run**.

The compute *does* keep running server-side (it isn't wired to `req.on('close')`)
and populates a result cache, so a later revisit is fast — but that continuation is
accidental and invisible. We want it to be first-class: start a report, navigate
away, the work continues in the background, the user is **notified when it's done**,
and returning to the app shows the in-progress or finished run again.

## Goals

1. Any agent-backed report action can be started and left; it continues in the
   background.
2. The user is notified (in-app toast + OS notification) when a run finishes or
   fails.
3. A cross-app **activity surface** lists in-progress and recently-finished runs,
   each clickable to jump back to its report.
4. Returning to a panel whose run is still going shows its status and, on
   completion, the report.

## Non-goals (deliberately deferred — YAGNI)

- **No restart survival.** Runs live in memory + the existing result cache; a full
  app/server restart drops in-flight runs (re-running is cheap and cached).
- **No server-side token-replay buffer.** Re-attaching to a running run shows
  status + phase, then the report — not a replay of streamed narration.
- **No dedicated Activity page.** The existing notification Bell is extended
  instead.
- **No lifting of the single-agent gate** for parallel report execution.

## Decisions (settled during brainstorming)

| Decision | Choice |
|---|---|
| Scope | All agent-backed reports, via one generic layer |
| Concurrency | Sequential queue (one run at a time) |
| Persistence | Navigation + reload only (in-memory registry + result cache) |
| Activity surface | Extend the Bell into an activity dropdown |
| Re-attach fidelity | Status + spinner, then report (no token replay) |
| Start transport | `POST /api/report/run` to start; separate SSE route to *view* |
| Sequencing | Spec covers all five kinds; plan wires Insights first, then the rest |

## Approach

**Chosen: run registry + re-attachable SSE view**, generalizing the existing
`ChatManager` pattern (`packages/run/src/chatSession.ts`,
`src/goldmine/chatRoutes.ts`). The reframing: today the SSE request *is* the work;
here the SSE stream is a **live window onto a run that lives in a registry**. While
the user watches, they get live `phase`/`delta` streaming exactly as now. When they
leave, the window closes but the run keeps executing. On return, the panel
re-attaches.

Rejected alternatives:

- **Thin (notify + reuse cache, no job model).** No real queue (concurrent runs
  would contend on the agent), and the cache can't express "running," so there is
  no true in-progress visibility.
- **Persistent disk queue (generalize `dream`).** Surviving restart is exactly the
  complexity the persistence decision skips.

## Architecture

### Component map

```
Client (packages/console)                       Server (src/, packages/*)
─────────────────────────                       ─────────────────────────
Panel (Insights, Rubrics, …)
  └─ useReportRun(kind, params) ──POST /api/report/run──▶ ReportRunManager
        │                         ──GET  /api/report/run/:id/stream (view)   (src/report/runManager.ts)
        │                         ──GET  /api/report/run/:id (state)            │  sequential queue
        │                                                                       │  dedup by paramsKey
        └─ reportRunStore (localStorage pointer)                                │  background-completion
                                                                                │  beginForeground() gate
ActivityProvider (Shell) ─────────GET /api/report/runs (list, 5s poll)─────────┤
  └─ notify/dispatch → toast + osNotify (detectReportDone)                      │
  └─ NotifyBell (activity dropdown, deep-link back)              runner registry (src/report/kinds.ts)
                                                                   └─ computeInsights / computeRubric /
                                                                      computeScorecard / analyze / gemRun
```

### 1. Server — `ReportRunManager` (`src/report/runManager.ts`)

One process-wide registry, instantiated once in `src/appCommon.ts` alongside
`ChatManager`.

- **`RunRecord`**:
  ```ts
  interface RunRecord {
    id: string;                // nanoid
    kind: string;              // "insights" | "rubric" | "scorecard" | "analyze" | "gemRun"
    paramsKey: string;         // dedup key, e.g. "insights:/path/to/project"
    params: unknown;           // kind-specific, opaque to the manager
    status: "queued" | "running" | "done" | "failed";
    phase: string;             // latest phase label, for the spinner
    result?: unknown;          // report payload when done
    error?: string;            // message when failed
    startedAt: number;
    finishedAt?: number;
  }
  ```
- **Per-run event emitter** carries `phase` / `delta` / `done` / `failed` to any
  attached SSE viewer. Only the *current* phase is retained (no historical delta
  buffer).
- **Sequential queue**: exactly one run executes at a time. The worker brackets
  each run in the existing `beginForeground()/endForeground()` (from
  `src/warm/orchestrator.ts`) so the `warm` daemon yields, matching how report
  routes gate warming today.
- **Dedup / idempotent start**: `start(kind, params)` computes `paramsKey`; if a
  run with that key is `queued` or `running`, it returns that run's `id` with
  `existing: true` instead of enqueuing a duplicate.
- **Background-completion**: the run promise is owned by the manager, never by a
  request. A client disconnect cannot abort it (same guarantee as
  `chatRoutes.ts` swallowing `res.write` failures).
- **Idle eviction**: finished runs are retained for a TTL and/or a capped LRU, then
  dropped. Mirrors `ChatManager`'s idle sweep. No disk.

Public surface:
```ts
class ReportRunManager {
  start(kind: string, params: unknown): { id: string; existing: boolean };
  get(id: string): RunRecord | undefined;
  list(): RunSummary[];                                  // for the activity view
  subscribe(id: string, onEvent: (e: RunEvent) => void): () => void; // SSE view
}
```

### 2. Server — runner registry (`src/report/kinds.ts`)

`registerReportKind(kind, runner)` where a runner is a thin adapter over an
**existing compute core, unchanged**:

```ts
type ReportRunner = (
  params: unknown,
  progress: { onPhase: (p: string, extra?: object) => void; onDelta: (t: string) => void },
) => Promise<unknown>;   // resolves to the report payload

registerReportKind("insights", (p, prog) =>
  computeInsights((p as InsightsParams).root, {
    dir: (p as InsightsParams).dir,
    force: (p as InsightsParams).force,
    progress: { onPhase: prog.onPhase, onDelta: prog.onDelta },
  }).then(r => r.payload));
```

Adapters wrap `computeInsights`, `computeRubric`, `computeScorecard`, the analyze
workflow, and gem-run. The manager stays report-agnostic; adding a kind is a single
registration.

`paramsKey` derivation is per-kind (registered alongside the runner) so dedup keys
are stable and meaningful (e.g. `rubric:<rubricId>:<scope>:<root>`).

### 3. Server — routes (raw Express, wired in `src/appCommon.ts`)

All guarded by `originGuard` like the existing SSE routes.

- `POST /api/report/run` `{ kind, params }` → `{ id, existing }`. Start-or-attach.
- `GET /api/report/runs` → `RunSummary[]` (`{id, kind, paramsKey, status, phase,
  startedAt, finishedAt}`) — minimal, for the activity view.
- `GET /api/report/run/:id` → full `RunRecord` incl. `result` when `done`.
- `GET /api/report/run/:id/stream` → live SSE view. On connect: emit the run's
  current `phase`, then stream live `phase`/`delta`/`done`/`failed` via
  `manager.subscribe`. Closing the stream does **not** stop the run.

### 4. Client — `useReportRun` hook + durable pointer

- **`reportRunStore.ts`** (localStorage, modeled on `panels/Play/studioChatStore.ts`):
  pointer `agentgem:report:<paramsKey>` → `runId`. Lets a panel find its run across
  navigation and full reload. Get/set/clear, try/catch for private mode.
- **`useReportRun(kind, params)`** exposes
  `{ status, phase, deltas, report, error, start, rerun }`:
  - On mount: resolve pointer → if present, `GET /api/report/run/:id` to reconcile
    (running → attach/poll; done → load report; missing/expired → clear pointer,
    idle).
  - `start()`: `POST /api/report/run`, store the returned pointer, open the live
    SSE view. **While the user stays**, live `delta`s render (no regression from
    today).
  - **On return to a running run**: show status + phase spinner and poll
    `GET /api/report/run/:id` until `done`, then render the report. A finished run
    loads instantly from the record/cache.
  - `rerun()`: start with the cache-bypass flag (existing `?fresh` / `force`).

### 5. Client — `ActivityProvider` + Bell (extends `packages/console/src/notify/`)

- **`ActivityProvider`** mounted once in `Shell.tsx` beside `NotificationsProvider`:
  polls `GET /api/report/runs` every 5s (same cadence as the warm/dream poller),
  holds the run list in context.
- **Notify on done**: a new `detectReportDone` transition detector in
  `notify/events.ts` fires through the existing `dispatch` → toast + `osNotify` when
  a run flips to `done` or `failed`. No new notification plumbing.
- **Bell → activity dropdown**: `NotifyBell.tsx` renders running runs (with phase)
  and recent finished runs; each row deep-links back to its panel through a small
  `kind → route + query` map (e.g. `insights` → `#/insights?root=…`,
  `rubric` → `#/rubrics?rubric=…&scope=…`).

### 6. Panel adoption

Insights, Rubrics, Mine scorecard, Curate analyze, and gem-run each drop their
bespoke `generate()` + `useState` + `openXStream` wiring and call `useReportRun`.
The `report/ReportActions.tsx` export UI is unchanged (it operates on the finished
payload).

## Data flow (Insights, end to end)

1. User clicks **Insights →**. `useReportRun("insights", {root}).start()` calls
   `POST /api/report/run`.
2. Manager computes `paramsKey = "insights:<root>"`. No existing run → enqueue,
   return `{id, existing:false}`. Hook stores pointer, opens
   `GET /api/report/run/:id/stream`.
3. Worker dequeues, `beginForeground()`, runs the `insights` runner →
   `computeInsights` drives the ACP agent, emitting `phase`/`delta` through the
   run's emitter → SSE view → panel renders live.
4. **User navigates away.** SSE view closes; the run keeps executing.
   `computeInsights` finishes and caches the payload; manager marks the run `done`,
   `endForeground()`.
5. `ActivityProvider` poll sees `status: done` → `detectReportDone` → toast +
   `osNotify`; the Bell shows the finished entry.
6. **User returns to Insights.** Hook resolves the pointer → `GET :id` → `done` →
   renders the report from `result` (or the cache). Or clicks the Bell entry to
   deep-link straight back.

## Concurrency & the single agent

Report runs are serialized **among themselves** by the manager's queue and bracket
`beginForeground()` so `warm` yields. Chat is unaffected: it already spawns its
**own** ACP adapter per `chatId`, so a background report and an interactive chat do
not block each other at the OS level. We do **not** introduce a hard global agent
mutex — the existing cooperative foreground gate is sufficient.

## Error handling & edge cases

- **Failed run**: surfaced in the panel (error state) and the Bell (with message);
  `rerun()` retries with cache bypass.
- **Reload mid-run**: the localStorage pointer reconciles via `GET :id`.
- **Duplicate start / re-mount / double-click**: dedup by `paramsKey` returns the
  existing run.
- **Queue ordering**: FIFO; `queued` runs appear in the activity view with a queued
  state.
- **Expired/evicted run**: `GET :id` 404 → hook clears the stale pointer and shows
  idle (the cache may still serve a fast re-run).

## Testing

- **Manager** (`src/report/__tests__/`): queue ordering, idempotent/dedup start,
  background-completion (disconnect does not abort), TTL/LRU eviction, foreground
  bracketing.
- **Runner adapters**: each emits phase/delta and resolves to a payload.
- **Hook** (`packages/console/src/panels/.../__tests__`): start, reconcile-on-mount,
  re-attach-while-running, done-from-cache.
- **Notify**: `detectReportDone` transition (done/failed, no false positives).
- **Bell**: renders running + finished; deep-link targets resolve.

Console tests are **not** in CI (per repo convention) — run locally. Root
`src/__tests__` manager/route tests are CI-gated.

## Build sequencing

The spec covers all five report kinds. The implementation plan wires **Insights
end-to-end first** as the working proof (manager + runner registry + routes +
`useReportRun` + `ActivityProvider`/Bell + Insights panel), then fast-follows
Rubrics, scorecard, analyze, and gem-run as thin per-kind adoptions. This is
build-order, not a scope cut.

## Key files

**New:** `src/report/runManager.ts`, `src/report/kinds.ts`,
`src/report/__tests__/*`, `packages/console/src/report/reportRunStore.ts`,
`packages/console/src/report/useReportRun.ts`,
`packages/console/src/notify/ActivityProvider.tsx`.

**Modified:** `src/appCommon.ts` (instantiate manager, register routes + kinds),
`packages/console/src/notify/events.ts` (`detectReportDone`),
`packages/console/src/notify/NotifyBell.tsx` (activity dropdown + deep-link map),
`packages/console/src/shell/Shell.tsx` (mount `ActivityProvider`),
and the five report panels (`Insights`, `Rubrics`, `Mine`, `Curate`, gem-run).

**Reference implementations to lift from:** `packages/run/src/chatSession.ts`
(`ChatManager`), `src/goldmine/chatRoutes.ts` (durable SSE + background-completion),
`packages/console/src/panels/Play/{studioChatStore,studioResume,Studio}.tsx`
(client durable-session UX), `packages/console/src/notify/*` (notification stack).
