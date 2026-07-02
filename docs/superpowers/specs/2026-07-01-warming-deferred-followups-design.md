# Warming Deferred Follow-ups — Distill Caching · Cross-Process Lock · OS-Service Install

**Date:** 2026-07-01
**Status:** Design approved, ready for implementation plan
**Branch:** `feat/warm-deferred` (off `origin/main`, which has the warming engine + Trigger A/C)

## Problem

Three deferred follow-ups from the warming work (PRs #55, #59), each independent:

1. **Distill caching** — the per-project playbook distillation (`/playbook/prepare`: `distillWorkflow` + `distillSessionLessons` over all of a project's transcripts) is LLM-backed but **recomputes on every call**. It's the last expensive per-project compute not in the warm system.
2. **Cross-process lock** — a daemon (Trigger C) and a running console (Trigger A) can both fire a warm pass and burn LLM tokens on the same work. Atomic writes already make this *safe*; the lock avoids the *waste*.
3. **OS-service auto-install** — the Trigger C daemon must be started by hand. A one-command install writes an OS unit so it auto-starts at login.

## What already exists (reuse)

- The warm engine `runWarmPass` (`src/warm/orchestrator.ts`) + warmable registry (`src/warm/registry.ts`) with the `(root, token)` cache pattern; `writeJsonAtomic` (`@agentgem/model`); `readInsightsCacheEntry`-style caches.
- Headless-core pattern: `computeWorkflowAnalysis` (`src/warm/../workflowCore.ts`) — cache-aware, injectable LLM deps, `updatedAt`, don't-cache-degraded.
- `acquirePidfile`/`releasePidfile` + `isAlive` (`src/warm/pidfile.ts`) — the exact stale-tolerant liveness lock primitive the cross-process lock needs.
- The daemon (`src/warm/daemon.ts`), schedule (`src/warm/schedule.ts`), watcher (`src/warm/watch.ts` — `warmRootsIndividually`), and the `agentgem warm` CLI branch (`src/cli.ts` → `runWarmCommand`).
- Distill fns (`@agentgem/insight`): `distillWorkflow(signal, scanInv): Promise<{ distilled: DistilledSkill[]; degraded: boolean }>`, `distillSessionLessons(signal, scanInv): Promise<{ lessons: DistilledLesson[]; degraded: boolean }>`. `transcriptToken(paths)`.
- `preparePlaybook(deps)` (`src/gem/playbookPrepareCore.ts`) whose `deps.distill: () => Promise<{ skills: DistilledSkill[]; lessons: DistilledLesson[]; degraded: boolean }>`.

## Decisions (locked)

| Item | Decision |
|---|---|
| Distill cache target | The per-project `/playbook/prepare` distill step (skills+lessons). `distillWorkflow` alone stays cached inside `analyze`; single-session `/inspect/distill` stays uncached. |
| Distill cache shape | New `distill-cache.json` `(root, token)` cache mirroring the others (atomic writes, entry ts, don't-cache-degraded). |
| Lock placement | **At the driver entry points (schedule tick, daemon initial pass, watcher batch) — NOT inside `runWarmPass`.** Same cross-process effect, zero change to the tested engine core, and keeps the orchestrator's injected tests filesystem-free. Refinement of the approved "gate runWarmPass". |
| Lock opt-out | `AGENTGEM_WARM_LOCK === "false"` disables it (runs fn without locking). Best-effort. |
| Service platforms | macOS launchd (`~/Library/LaunchAgents/`) + Linux systemd-user (`~/.config/systemd/user/`). Other → clear message. |

## A. Distill caching

- **`packages/insight/src/distillCache.ts`** (new) — `readDistillCache(root, token)`, `readDistillCacheEntry(root, token): { result, ts } | null`, `writeDistillCache(root, token, result, nowMs)`. Byte-for-byte the `insightsCache.ts` shape (MAX_ENTRIES cap, `writeJsonAtomic`, `TOKEN_VERSION = "d1"`, `distill-cache.json`). Exported via the insight barrel.
- **`src/distillCore.ts`** (new) — `computeDistill(root, opts?): Promise<{ payload: DistillPayload; cached: boolean; updatedAt: number | null }>` mirroring `computeWorkflowAnalysis`: derive `scanInv` (introspectProject + introspectConfig), `paths = claudeTranscriptsForCwd`, `token = transcriptToken(paths)`; cache-hit early return via `readDistillCacheEntry`; else run `distillWorkflow` + `distillSessionLessons` concurrently → `payload = { skills, lessons, degraded }` (`skills = distill.distilled`); cache only when `!degraded`; `updatedAt`. Injectable `distillWorkflow?`/`distillSessionLessons?`/`now?`. `DistillPayload = { skills: DistilledSkill[]; lessons: DistilledLesson[]; degraded: boolean }`.
- **`/playbook/prepare` (gem.controller.ts)** — replace the inline `distill` closure with delegation: `distill: async () => (await computeDistill(root)).payload`. Keep the existing `introspectAll`+find existence check (throws `InvalidInputError`). Existing playbook-prepare tests are the behavior guardrail — must stay green.
- **`distill` warmable (registry.ts)** — add `"distill"` to the `Warmable` id union; new entry `{ id:"distill", cost:"llm", scope:"per-root", warm: (root,{dir,force}) => computeDistill(root,{dir,force}).then(r => r.cached ? "hit" : "warmed") }`. It joins insights+analyze in the top-N LLM tier automatically.

## B. Cross-process warm lock

- **`src/warm/lock.ts`** (new) — `withWarmLock<T>(home: string, fn: () => Promise<T>, onSkip: () => T, deps?: { acquire?; release?; enabled? }): Promise<T>`. Lockfile `${home}/.agentgem/warm-pass.lock`. Default `acquire = acquirePidfile`, `release = releasePidfile` (reused from pidfile.ts — stale-tolerant liveness). `enabled` default `process.env.AGENTGEM_WARM_LOCK !== "false"`. Logic: if `!enabled` → `return fn()`; else `if (!acquire(lockPath)) return onSkip(); try { return await fn(); } finally { release(lockPath); }`. Never throws beyond fn.
- **Gate the drivers:**
  - `schedule.ts`: default `run` becomes `() => withWarmLock(home, () => runWarmPass(), () => undefined)` (schedule gains a `home` default `agentgemHome()`).
  - `daemon.ts`: wrap `initialPass` and the watcher runner in `withWarmLock(home, …, () => undefined)` so the daemon's own passes also respect the lock.
- `runWarmPass` is unchanged (its in-process re-entrancy guard stays). The lock is purely a driver-level, cross-process complement.

## C. OS-service auto-install

- **`src/warm/service.ts`** (new):
  - `launchdPlist(execArgs: string[], label = "ai.ninemind.agentgem.warm"): string` — a `<plist>` running `execArgs` with `RunAtLoad` + `KeepAlive`.
  - `systemdUnit(execArgs: string[]): string` — a `[Unit]/[Service]/[Install]` user unit running `execArgs`, `WantedBy=default.target`.
  - `installService(deps?): { path: string; loadCmd: string }` and `uninstallService(deps?): { path: string; removed: boolean }` — deps `{ platform?=process.platform, home?=homedir(), exec?=default cmd, writeFile?, unlink?, mkdir? }`. macOS → LaunchAgents plist; Linux → systemd user unit; else throw `UnsupportedPlatformError`.
  - `runServiceCommand(argv, deps?): void` — testable CLI entry: `--install-service` → install + log path & load command; `--uninstall-service` → uninstall + log; unsupported platform → errorLog + exit(1). Injected `install`/`uninstall`/`log`/`errorLog`/`exit`.
  - Default `exec` = `[process.execPath, <resolved dist/cli.js>, "warm", "--watch"]`.
- **`src/cli.ts`** — in the `warm` branch: if argv contains `--install-service` or `--uninstall-service` → `runServiceCommand(argv.slice(1))`; else `runWarmCommand(argv.slice(1))`. Add HELP lines.

## Error handling

Best-effort throughout (matches the warming ethos). The lock never wedges: a crashed holder's stale pid is overwritten (pidfile liveness). Service install failures surface as a clear message + non-zero exit; unsupported platform is explicit. Distill caching preserves don't-cache-degraded and never throws from the cache layer.

## Testing

- **Distill cache:** entry round-trip (hit + miss + ts) in `src/__tests__/distillCache.test.ts` (temp `AGENTGEM_HOME`).
- **computeDistill:** cache-hit path (pre-seed cache, no agent); fresh non-degraded writes + second call hits with same `updatedAt`; degraded → not cached, `updatedAt` null (injected distill fakes). Temp home + cleanup.
- **distill warmable:** warm→hit→force-warm (injected fakes or pre-seeded cache) in `registry.test.ts`.
- **withWarmLock:** runs fn + releases when free; a live holder → `onSkip` (fn not called); `enabled=false` → runs fn without touching the lockfile; release happens even if fn throws. Injected acquire/release.
- **service:** `launchdPlist`/`systemdUnit` contain the exec args + platform-correct structure; `installService` writes to the right path per injected platform and returns the load command; unsupported platform throws; `runServiceCommand` branches (install/uninstall/unsupported→exit(1)) with injected deps.
- Guardrail: existing `playbookPrepareCore`/playbook-prepare tests stay green after the delegate.
- All tests inject I/O + use temp `AGENTGEM_HOME`; backend tests run against compiled `dist/` (`pnpm -w build` first).

## Scope boundaries (YAGNI)

- **In:** distill cache + core + prepare-delegate + warmable; `withWarmLock` + driver gating; service generators + install/uninstall + CLI.
- **Deferred:** caching single-session `/inspect/distill`; Windows service integration; a lock that also coordinates with foreground SSE computes (the foreground gate already handles in-process; cross-process SSE coordination is out).

## Rationale notes

- Distill caching reuses the exact `computeWorkflowAnalysis`/`insightsCache` patterns — homogeneous, low-risk, and it makes the "playbooks into gems" path (the original vision) warm like everything else.
- Gating the lock at drivers (not the engine) is strictly safer: the engine's core + its tests are untouched, and cross-process contention only actually happens between the two long-running drivers anyway.
- The lock reuses `acquirePidfile`/`releasePidfile` verbatim — a lockfile *is* a pidfile with a different name — so there's no new liveness code.
