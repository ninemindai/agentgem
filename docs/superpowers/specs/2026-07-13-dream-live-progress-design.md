# Dreaming live progress — design

**Date:** 2026-07-13
**Status:** Approved (brainstorm), pending spec review
**Branch:** `feat/dream-live-progress`

## Problem

The Journey tab (`packages/console/src/panels/Dreaming/`) gives almost no feedback
while a background pass runs. Clicking **Dream now** flips the button to
"Dreaming…" and polls `lastPassAtMs` on a fixed 12×1.5s loop, then shows a
one-line note. Automatic passes (boot + ~10-min idle timer) surface only as a
binary `✦ warming…` pill in the shell. There is no view of *what* is running:
which phase, which project, how far along.

The backend already tracks the raw material — `getWarmStatus()` returns
`{running, last:{startedAt, finishedAt, outcomes:[{id, root, status}]}}` and is
served at `GET /api/warm/status` — but **live** per-step progress is not
published: `runWarmPass` keeps `outcomes` in a local array and only writes
`status.last` when the pass *finishes*. Mid-pass, `outcomes` still describes the
previous pass.

## Goal

Show a faithful, live step tracker in the Journey scene as any warm pass runs —
manual **or** automatic — with the three sleep phases and the current project,
and enrich the global `warming…` pill with the current phase.

Decided in brainstorming:
- **Granularity:** true live stepper (requires publishing incremental progress).
- **Structure:** 3 phases (LIGHT/DEEP/REM) + a live "now: `<project>` (i of n)" line.
- **Trigger scope:** all passes — manual (`Dream now`) and automatic (boot/idle).
- **Delivery:** poll the existing warm-status singleton. No SSE.

Non-goals: reordering warmables; per-warmable sub-progress within a step;
streaming/push transport; changing what a pass computes or enqueues.

## Background: how a pass actually runs

`runWarmPass` (`src/warm/orchestrator.ts`) iterates the registry
**warmable-outer, root-inner**, serially:

```
for w of registry:
  if w.scope === "global":  runOne(w, null)                  // once
  else:                     for root of selectedRoots: runOne(w, root)   // per top-N project
```

Registry order + phase mapping (`PHASE_OF` in `src/dream.controller.ts`):

| order | warmable  | scope     | phase |
|-------|-----------|-----------|-------|
| 1 | observe   | global    | —     |
| 2 | usage     | global    | LIGHT |
| 3 | scorecard | global    | LIGHT |
| 4 | recall    | global    | —     |
| 5 | insights  | per-root  | REM   |
| 6 | analyze   | per-root  | DEEP  |
| 7 | distill   | per-root  | —     |
| 8 | dream     | per-root  | —     |

**Execution-order wrinkle:** because `insights` (REM) precedes `analyze` (DEEP)
in the registry, phases do **not** fire in narrative LIGHT→DEEP→REM order.
We do **not** reorder warmables (that's a behavior change with possible cache
dependencies). Instead the UI renders the three phases in narrative order as a
**status panel** (each: done / running / pending) and treats the **"now" line**
as the source of truth for what is executing. A phase chip may therefore flip to
"done" slightly out of top-to-bottom order; the "now" line keeps it legible.

**Event-loop constraint:** per-root warmables run synchronous scans that block
the event loop, so `/api/warm/status` cannot respond *during* a warmable —
progress updates land at warmable **boundaries**, not continuously. A long step
can make the "now" line sit still briefly. This is acceptable and noted in the UI
copy expectations (it's a step tracker, not a smooth bar).

## Architecture & data flow

```
runWarmPass loop ──updates──▶ module `status.progress`  (in-process singleton)
                                     │
        GET /api/warm/status ────────┤ (returns whole status; progress rides along)
        GET /api/dream/status ───────┘ (adds a compact `progress` block)
                                     │
                     poll (adaptive) ▼
      Dreaming panel  ─ DreamProgress (phase panel + "now" line)
      shell           ─ WarmingPill  (appends current phase)
```

No push channel. Both consumers poll — fast while a pass runs, slow when idle.

## The progress shape

Add to the orchestrator (`src/warm/orchestrator.ts`):

```ts
export interface WarmProgress {
  startedAt: number;
  phase: "LIGHT" | "DEEP" | "REM" | null;   // phase of the currently-running warmable
  phasesLit: Array<"LIGHT" | "DEEP" | "REM">; // phases with ≥1 warmed/hit so far
  currentRoot: string | null;                 // display basename of the project (null for global steps)
  rootIndex: number;                          // 1-based index within the current per-root warmable (0 for global)
  rootCount: number;                          // number of selected projects
  done: number;                               // steps completed
  total: number;                              // total steps this pass
}

export interface WarmStatus {
  running: boolean;
  last: WarmPassResult | null;
  progress: WarmProgress | null;              // non-null only while running
}
```

Update rules inside `runWarmPass`:
- Before the loop: compute `total` (globals count once + per-root warmables ×
  `selectedRoots.length`) and `rootCount = selectedRoots.length`; set
  `status.progress = {startedAt, phase:null, phasesLit:[], currentRoot:null,
  rootIndex:0, rootCount, done:0, total}`.
- After each `runOne` (or a skip): increment `done`; set `phase = PHASE_OF[w.id]
  ?? null` (unphased warmables — observe/recall/distill/dream — report `phase:
  null`, so the panel shows no phase "running" during those steps while the "now"
  line still shows the project activity); set `currentRoot` to the root's
  basename (or null for global); set `rootIndex` (1-based) for per-root steps
  (0 for global); if the outcome is `warmed`/`hit` and the warmable is phased,
  add its phase to `phasesLit` (deduped).
- On completion: keep the terminal `status` write, but set `progress = null`
  (idle). The re-entrancy guard's early return leaves `progress` untouched.

`PHASE_OF` currently lives in `dream.controller.ts`. Move it (or a copy) to the
orchestrator/registry so both the loop and the controller share one mapping —
single source of truth. (Small, in-scope: the controller keeps importing it.)

## Components / changes

1. **`src/warm/orchestrator.ts`** — the `WarmProgress` type, `status.progress`
   field, up-front `total`/`rootCount`, and the per-step update. No control-flow
   change; ~15–20 lines. Own the phase mapping here.

2. **`src/dream.controller.ts`** — extend `StatusSchema` with an optional compact
   `progress` object (`{phase, phasesLit, currentRoot, rootIndex, rootCount,
   done, total}`); the `status()` handler passes through `getWarmStatus().progress`.
   Keep the existing `phasesLit` (last-pass) field for backward compat; the live
   panel prefers `progress.phasesLit` when a pass is running.

3. **`packages/console/src/panels/Dreaming/api.ts`** — add `progress` to the
   `DreamStatus` type.

4. **`packages/console/src/panels/Dreaming/` — new `DreamProgress` subcomponent** —
   renders the 3-phase status panel (done/running/pending from `progress`) and
   the "now: `<currentRoot>` (`rootIndex` of `rootCount`)" line; hidden when no
   pass is running. `index.tsx`:
   - Replace the brittle 12×1.5s `lastPassAtMs`-diff loop: `runDream` fires the
     POST, then relies on the shared adaptive poll to reflect `running` →
     progress → done.
   - Adaptive poll: ~1.2s while `status.running`, ~6s when idle.
   - Auto-refresh the timeline when `lastPassAtMs` advances (a pass finished) and
     periodically while running so new drafts appear.

5. **`packages/console/src/components/WarmingPill.tsx`** — read `progress.phase`
   from `/api/warm/status` and append it (`✦ warming… DEEP`); falls back to plain
   `warming…` when phase is null.

6. **`styles.css` (marketplace/console)** — hand-authored rules for any new
   `ex-*`/`dream-*` classes (this console has no CSS framework; every class needs
   a matching rule — mirror existing `.dream-*` tokens).

## Error handling / edge cases

- Best-effort: a failed status poll leaves the last snapshot; never throws to the
  user.
- `progress` is `null` when idle → panel renders nothing.
- A warmable `error`/`skipped` still advances `done` (shown in the count; not a
  hard failure).
- Re-entrancy: a second `runWarmPass` while one is running returns early and does
  not touch `progress`.
- Multi-process: `status`/`progress` is a per-process singleton. The console
  talks to the same server process that runs the schedule, so this is consistent;
  a pass running in another process (cross-process warm lock) simply won't show
  progress here — acceptable, best-effort.
- Unmount safety: keep the existing `aliveRef` guard so polls don't set state on
  an unmounted panel.

## Testing

- **Orchestrator unit** (`src/warm/__tests__/`) — inject a fake registry + roots +
  `now`; assert `getWarmStatus().progress` advances (`phase`, `rootIndex`,
  `done`/`total`, `phasesLit`) across the pass and is `null` after completion; and
  that the re-entrancy early-return leaves progress untouched.
- **Controller** (`src/__tests__/`) — `/api/dream/status` includes the compact
  `progress` when a pass is mid-flight (drive via a stubbed `getWarmStatus`), and
  omits/nulls it when idle.
- **Console component** (not in CI — run locally) — `DreamProgress` renders phase
  states + "now" line from a fixture; `WarmingPill` appends the phase.
- **Manual/browser** — drive `Dream now` and observe the live panel; confirm an
  auto pass (short idle interval via `AGENTGEM_WARM_INTERVAL_MS`) also lights the
  panel with no click.

## Rollout

Single PR (backend + frontend together; the frontend degrades gracefully if
`progress` is absent, but they ship as one coherent change). No migration, no new
dependency, no config. CI gates on `test (24)` (root `dist/__tests__`); console
tests run locally.
