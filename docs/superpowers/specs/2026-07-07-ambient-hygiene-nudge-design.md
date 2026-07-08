# Ambient Context-Hygiene Nudge (warm daemon) — design

**Date:** 2026-07-07
**Status:** Draft for review
**Depends on:** the warm daemon (`src/warm/*`, all merged) and #176's pure logic — `buildTickEvents` + `nudgeTransition` (`src/watchHygieneNudge.ts`) and `hygieneReportForFile` (`src/sessionHygieneCore.ts`), all on `origin/main`. Standalone branch `feat/hygiene-ambient-nudge` off `origin/main`.

## Problem

The hygiene nudge (#176) only fires while you're actively viewing a session in the console's Watch tab. The highest-leverage case is the opposite: a session you're *not* looking at drifts into bloat while you're doing something else. We want an **ambient** nudge — an OS notification that fires even with no app open — when any active session's context escalates. The always-on host already exists (the warm daemon), so this is a small hook, not new infrastructure.

## Goal

Opt-in via `agentgem warm --watch --nudge`: the warm daemon, which already watches every `~/.claude/projects` transcript, additionally runs a hygiene check on each changed session and fires a **native OS notification** ("context is heavy — a clean break keeps it sharp") when a session escalates to `mixed`/`bloated`. Once per climb per session; re-arms after a clear. Off by default.

**Non-goals:** any UI (it's an OS notification, not a panel); per-session/project selection (watches all sessions the daemon already sees — see Scope); a desktop-app-only path (the daemon is the headless host); Windows notifications (macOS/Linux only, matching the daemon's `--install-service` support); changing the deterministic hygiene engine.

## Scope: all active sessions, gated by escalation

The daemon already watches all of `~/.claude/projects`, so ambient nudging is zero-extra-config: any session that appends is checked. Noise is bounded by `buildTickEvents`' escalation logic — a nudge fires only when a session's verdict *climbs* to a heavier level, once per climb, re-arming after it drops to `bounded`. A healthy (`bounded`) session never notifies.

## Architecture

Three small units; `hygieneReportForFile`, `buildTickEvents`, `nudgeTransition`, the watch loop, the daemon, and the service install are all reused untouched.

### 1. `nodeNotify.ts` (`src/warm/nodeNotify.ts`) — the one new I/O

A node-side OS notification (the browser `osNotify` in `packages/console` is unreachable from the daemon's plain-node process).

```ts
export type NotifyExec = (cmd: string, args: string[]) => void;   // execFile-shaped; default spawns detached
export function nodeNotify(title: string, body: string, exec?: NotifyExec): void;
```

- `process.platform === "darwin"` → `exec("osascript", ["-e", `display notification ${q(body)} with title ${q(title)}`])` where `q` is AppleScript string-quoting (wrap in double quotes, backslash-escape `"` and `\`).
- `"linux"` → `exec("notify-send", [title, body])` (argv array — no shell, so no injection).
- else → no-op (Windows / headless CI silently skip).
- **Sanitize** `title`/`body`: strip control chars/newlines and cap length (~200) before use — the strings are agent-authored advice + a scrubbed transcript basename, but defense-in-depth.
- **Never throws:** a missing binary / spawn error is caught and logged (`createLogger("warm")`), matching the daemon's other best-effort paths. `exec` is injectable so tests never spawn.

### 2. `hygieneNudger.ts` (`src/warm/hygieneNudger.ts`) — the escalation glue

Pure of real I/O when its two deps are injected; reuses #176's `buildTickEvents` for the entire fire-on-escalation + advice logic.

```ts
import { buildTickEvents, type Verdict } from "../watchHygieneNudge.js";
import type { HygieneReport } from "../sessionHygieneCore.js";

export function createHygieneNudger(deps: {
  notify: (title: string, body: string) => void;      // nodeNotify in prod
  reportForFile: (path: string) => HygieneReport;     // hygieneReportForFile in prod
}): { nudge(files: string[]): void };
```

- Holds `const last = new Map<string, Verdict>()` keyed by `report.meta.sessionId`.
- `nudge(files)`: for each `file`, in a `try/catch` (a half-written transcript must not kill the daemon or skip the rest):
  - `const report = deps.reportForFile(file);`
  - `const id = report.meta.sessionId || file;`
  - `const t = buildTickEvents(last.get(id) ?? null, report);`
  - if `t.nudge`, `deps.notify("AgentGem — context is heavy", \`${basename(file)}: ${t.nudge.advice}\`)`.
  - `last.set(id, t.nextVerdict);`
- The notification body carries the transcript **basename** + agent-authored advice only — never a path (privacy, mirroring the report's contract).

### 3. Wiring — `startWarmWatch` hook + `--nudge` flag

- **`src/warm/watch.ts`** — `startWarmWatch(opts)` gains `nudge?: (files: string[]) => void`. In `flush()`, after the existing `const roots = toRoots(...); if (roots.length) void run(roots);`, add `opts.nudge?.(files)` (the debounced changed transcript paths). Default absent → byte-identical existing behavior.
- **`src/warm/daemon.ts`** — `startWarmDaemon(opts)` gains `nudge?: boolean`. When true: `const nudger = createHygieneNudger({ notify: nodeNotify, reportForFile: hygieneReportForFile });` and pass `nudge: (files) => nudger.nudge(files)` into the `startWatch({ ... })` call. Off → no nudger built, no notifications.
- **`runWarmCommand(argv, ...)`** — parse `--nudge` from argv (a boolean, like `--watch`) and thread it into `startWarmDaemon({ nudge: argv.includes("--nudge") })`.
- **`src/cli.ts`** — add a help line: `agentgem warm --watch --nudge   Also send an OS notification when a session's context gets heavy`.

## Data flow

```
agentgem warm --watch --nudge  (headless daemon / installed service)
   │  fs.watch(~/.claude/projects) → debounce 2500ms → flush(changed files)
   ▼
run(roots)  [existing warm pass]     +     nudge(files)  [new]
                                             │  per file: hygieneReportForFile(file)
                                             │  buildTickEvents(last[sessionId], report)  ← #176 escalation+advice
                                             │  t.nudge ?  nodeNotify(title, basename: advice)
                                             ▼  last[sessionId] = t.nextVerdict
                                    OS notification (osascript / notify-send)
```

## Testing

- **`nodeNotify` (CI, `src/warm/__tests__/nodeNotify.test.ts`):** injected fake `exec` + overridable platform — darwin → correct `osascript` argv (title/body AppleScript-quoted); linux → `notify-send` argv; unknown platform → no-op (exec never called); a `"`/newline/control char in title/body is sanitized (no injection into the argv); a throwing `exec` is swallowed (no throw).
- **`createHygieneNudger` (CI):** injected `notify` (records) + `reportForFile` (canned reports) — `bounded→mixed` fires exactly one notify carrying the fired-factor advice; staying `mixed` is silent; `bloated→bounded→bloated` re-fires (re-arm); a `reportForFile` that throws on one file skips it and still processes the rest; the body contains the basename, never a path.
- **Wiring (CI):** `startWarmWatch`'s existing tests pass with `nudge` absent; a new test asserts `flush()` calls the injected `nudge` with the debounced changed files. `runWarmCommand` builds the nudger only when `--nudge` is present (assert not otherwise).

## Files

- **Create** `src/warm/nodeNotify.ts` — the OS-notification helper.
- **Create** `src/warm/hygieneNudger.ts` — the escalation glue.
- **Modify** `src/warm/watch.ts` — optional `nudge` param, called in `flush()`.
- **Modify** `src/warm/daemon.ts` — `nudge?` opt; wire the nudger when set; parse `--nudge` in `runWarmCommand`.
- **Modify** `src/cli.ts` — the `--nudge` help line.
- **Create** `src/warm/__tests__/nodeNotify.test.ts`, `src/warm/__tests__/hygieneNudger.test.ts` — CI.
- **Modify** the existing `startWarmWatch` test file (find it) — add the `flush`-calls-`nudge` case + the `--nudge` parse case.

## Constraints

- ESM `.js` import specifiers; 3-line copyright header on new files.
- **Opt-in, off by default** — no `--nudge` ⇒ no nudger, no notifications, existing daemon behavior byte-identical.
- Reuse `hygieneReportForFile`, `buildTickEvents`, `nudgeTransition` verbatim — no re-implemented hygiene/escalation logic. The ONLY new logic is `nodeNotify` + the thin nudger loop + the wiring.
- **Never throw / never die:** a bad transcript, a missing notify binary, or a spawn failure degrades to a logged warning; the daemon keeps running.
- Privacy: the notification body is a scrubbed transcript basename + agent-authored advice — never a path/arg.
- macOS + Linux only (matches the daemon's `--install-service` platforms); other platforms no-op.
- Injectable `exec` + platform so all `nodeNotify` branches run on one CI host without firing a real notification.
- Server/daemon tests in `src/**/__tests__/` (CI); commit identity Raymond Feng <raymond@ninemind.ai> with the `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>` trailer.

## Out of scope (later)

- A desktop-app native path (dedupe with the daemon) / a console toggle for `--nudge`.
- Per-session/project selection + persistence.
- Windows notifications; notification actions (click-to-open the session).
- The interactive EMBER widget (the last shelf item).
