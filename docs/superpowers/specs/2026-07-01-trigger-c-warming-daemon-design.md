# Trigger C — Standalone Warming Daemon

**Date:** 2026-07-01
**Status:** Design approved, ready for implementation plan
**Branch:** `feat/trigger-c-daemon` (off `origin/main`, which includes the merged warming engine from PR #55)

## Problem

The background-warming engine (`runWarmPass`) shipped with **Trigger A**: a schedule that warms the precompute caches on console boot and on a 10-minute idle loop, *while the console is running*. The engine was built trigger-agnostic on purpose. Trigger C is the deferred second driver: **keep the caches warm even when the console app is closed**, and react to a finished session within seconds rather than waiting for the next idle tick.

## What already exists (do not rebuild)

- `runWarmPass(opts)` — the trigger-agnostic engine (`src/warm/orchestrator.ts`): global warmables (usage, scorecard) run once; LLM warmables (insights, analyze) run for the top-N recent projects; serial; foreground gate; re-entrancy guard; best-effort. Accepts `{ roots, topN, force, ... }`.
- `startWarmSchedule` (`src/warm/schedule.ts`) — Trigger A (boot + idle), console-gated.
- The three `(root, token)` caches under `~/.agentgem/` and the `AGENTGEM_WARM_TOPN` / `AGENTGEM_WARM_INTERVAL_MS` env knobs.
- The `agentgem` CLI (`src/cli.ts`) — a thin subcommand dispatcher (`send`/`receive`/`bind` → else `run()`).
- Transcript→cwd parsing already exists (the `cwd` field read by `observeScan` / `bucketTranscriptsByCwd`).

Trigger C adds **no warming logic** — it is a *driver*: watch the filesystem → debounce → call `runWarmPass` targeted at the changed project.

## Decisions (locked)

| Fork | Decision |
|---|---|
| Process model | **Standalone CLI daemon** — `agentgem warm --watch`, a foreground long-lived process the user owns (terminal/tmux/their own launchd). |
| Watch mechanism | Native `fs.watch` on `~/.claude/projects`, recursive, debounced ~2.5s. No `chokidar` dependency. |
| Change → pass granularity | **Targeted** — map changed transcript → project root, dedupe a burst, then `runWarmPass({ roots:[root], topN:1 })` per changed root. One `runWarmPass()` on startup to warm current state. |
| Coexistence with a running console | **Atomic cache writes** (temp file + `rename()`) so two processes never corrupt a cache file; last-writer-wins. Also hardens the caches for Trigger A. |
| Singleton | Pidfile `~/.agentgem/warm.pid`; a second daemon with a live pid warns and exits (stale pid tolerated). |

## Architecture

```
fs.watch(~/.claude/projects, { recursive: true })
   → debounce(~2500ms, coalesce a session's rapid appends)
   → map changed *.jsonl paths → project roots (via existing cwd parse) → dedupe
   → for each root: runWarmPass({ roots:[root], topN:1 })
```

`agentgem warm --watch` is a thin CLI entry that: writes/acquires the pidfile, runs one initial `runWarmPass()`, starts the watcher, and blocks until a signal. The watcher owns the fs subscription, the debounce timer, and the path→root mapping; it calls an injectable runner (default `runWarmPass`).

## Components & interfaces

### `src/warm/watch.ts` (new)
```ts
export interface WarmWatch { stop(): void }
export function startWarmWatch(opts?: {
  claudeDir?: string;                                   // default: resolveDirs().claudeDir
  debounceMs?: number;                                  // default 2500
  watch?: (dir: string, cb: (evt: string, file: string | null) => void) => { close(): void }; // default fs.watch wrapper (recursive)
  setTimer?: (fn: () => void, ms: number) => unknown;   // default setTimeout
  clearTimer?: (h: unknown) => void;                    // default clearTimeout
  run?: (roots: string[]) => Promise<unknown>;          // default: roots => runWarmPass({ roots, topN: 1 })
  now?: () => number;                                   // for tests
}): WarmWatch
```
- Buffers changed file paths; on debounce fire, maps each to its project root, dedupes, and calls `run(roots)` once for the batch.
- **Path→root mapping** reuses the existing transcript→cwd parse (the same field `bucketTranscriptsByCwd`/`observeScan` read). A file whose cwd can't be resolved is skipped (best-effort).
- `stop()` closes the fs subscription and clears any pending timer.
- Everything external (watch, timers, runner) is injectable so tests use zero real I/O.

### `src/warm/daemon.ts` (new)
```ts
export interface WarmDaemon { stop(): Promise<void> }
export function startWarmDaemon(opts?: {
  home?: string;                    // default agentgemHome()
  onLog?: (msg: string) => void;    // default console.log
  watch?: typeof startWarmWatch;    // injectable for tests
  initialPass?: () => Promise<unknown>; // default () => runWarmPass()
}): WarmDaemon | null                // null if another live daemon holds the pidfile
```
- Acquires the pidfile (`~/.agentgem/warm.pid`); if a live pid is present, logs a warning and returns `null` (caller exits).
- Runs the initial pass (fire-and-forget), starts the watcher, returns a handle.
- `stop()` stops the watcher and removes the pidfile.

### `src/warm/pidfile.ts` (new, tiny)
```ts
export function acquirePidfile(path: string): boolean   // true if acquired; false if a live pid already holds it
export function releasePidfile(path: string): void
```
- Liveness check via `process.kill(pid, 0)` (throws ⇒ stale ⇒ overwrite). Best-effort, never throws out.

### `src/cli.ts` (modify)
Add a `warm` subcommand: `agentgem warm --watch [--debounce <ms>]`. Parses flags, calls `startWarmDaemon()`, wires `SIGINT`/`SIGTERM` → `stop()` → exit, and prints a one-line "watching …" banner. Update the CLI `HELP` text.

### Atomic cache writes (modify — `@agentgem/insight`, `@agentgem/capture`)
Harden the three existing writers (`writeInsightsCache`, `writeAnalysisCache`, `writeGlobalUsageCache`) to write a temp file in the same directory then `renameSync` over the target (atomic on one filesystem). A shared helper `writeJsonAtomic(path, data)` keeps it DRY. Preserves the best-effort/never-throw contract.

## Data flow

startup → `acquirePidfile` (exit if a live daemon exists) → `runWarmPass()` (warm current state) → `fs.watch` loop → on a debounced batch → dedupe affected roots → `runWarmPass({ roots:[root], topN:1 })` each. Unchanged tokens short-circuit inside the warmables, so redundant events cost ~nothing.

## Error handling & lifecycle

- Foreground process. `SIGINT`/`SIGTERM` → stop watcher, release pidfile, exit 0.
- `fs.watch` errors are logged; the watcher stays alive and re-subscribes on directory-rename events.
- Every warm and every path parse is best-effort — a malformed transcript or a failed pass logs and the loop continues. The daemon never crashes on bad input.
- Atomic writes guarantee a reader (console or daemon) never sees a half-written cache file.

## Testing

- **`watch.ts`** (injected `watch` + fake timer + fake `run`):
  - a burst of change events within the debounce window coalesces into **one** `run` call;
  - changed file paths map to the correct project roots and are deduped;
  - a path whose cwd can't be resolved is skipped, not fatal;
  - `stop()` closes the subscription and clears a pending timer (no `run` after stop).
- **`pidfile.ts`**: acquire on a free path succeeds; a second acquire with a live pid fails; a stale pid (dead process) is overwritten; release removes the file.
- **`daemon.ts`** (injected watch + initialPass + a temp `home`): returns `null` when a live pidfile exists; otherwise runs the initial pass once and returns a handle whose `stop()` releases the pidfile.
- **Atomic writes**: interleaved writes from two callers always leave a valid, fully-parseable JSON file (never a truncated blob); a normal write still round-trips.
- **CLI**: `agentgem warm --watch` dispatches to `startWarmDaemon` (parse + wire; injectable so no real process spawn).

Tests inject all I/O and use a temp `AGENTGEM_HOME`; none touch the real `~/.claude`.

## Scope boundaries (YAGNI)

- **In v1:** the watch daemon (`watch.ts` + `daemon.ts` + `pidfile.ts`), the `agentgem warm --watch` CLI, targeted per-root warm, one startup pass, and atomic cache writes.
- **Deferred:**
  - **OS-service auto-install** — a `agentgem warm --install-service` that writes a launchd/systemd unit invoking this daemon. Thin follow-up; per-OS unit templates + uninstall are their own surface.
  - **Cross-process lock / role-exclusion** — atomic writes make concurrent warmers merely *wasteful*, not unsafe. Add a lock only if redundant warming is ever observed to matter.
  - **Windows-specific path handling** — `fs.watch` recursive + the projects-dir layout are validated on macOS/Linux first.

## Rationale notes

- The engine is trigger-agnostic by construction (Task 5), so Trigger C is purely a driver — no cache/compute code, which keeps the blast radius small.
- Atomic writes are the minimal correctness primitive for multi-process coexistence and are a general hardening (Trigger A benefits too), so they belong in the cache layer, not the daemon.
- Targeted warming (`roots:[changed]`, `topN:1`) is what makes a watcher worthwhile over the idle timer: insights for the project you just finished are fresh within seconds, at one project's cost.
