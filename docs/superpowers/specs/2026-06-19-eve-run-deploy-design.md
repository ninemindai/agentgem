# Eve run/deploy from the UI (Phase 3)

**Date:** 2026-06-19
**Status:** Approved (design)

## Goal

Let an operator **run the rendered eve project locally or deploy it to Vercel
from the agentgem UI**. This is Phase 3 of the eve-deploy effort; Phases 1–2
(`docs/superpowers/specs/2026-06-19-eve-deploy-design.md`) already make the
`eve` target emit a runnable project. This spec adds the orchestration + UI to
actually run/deploy it.

## Decisions (from brainstorming)

- **Run dir:** a stable `~/.agentgem/workspaces/<name>/.run/eve/` (NOT
  `.targets/eve`, which `renderTarget` wipes on every render — `workspaces.ts:106`).
  `node_modules` persists there across renders.
- **Logs/status:** UI **polls** `GET /api/run-status`, which returns state + a
  log tail (in-memory ring buffer). No SSE.
- **Vercel CLI:** add `vercel` as an agentgem **dependency** (pinned); invoke
  the pinned binary. (Heavy dep, chosen over `npx`.)
- **Scope:** both local run and Vercel deploy, in two implementation phases
  (3a local, 3b Vercel) plus UI (3c).

## v1 boundaries (approved)

- **Deployed-runtime secrets are the operator's job.** `vercel deploy` ships the
  build; the deployed agent's `ANTHROPIC_API_KEY` (+ any MCP secrets) must be set
  on the **Vercel project**. agentgem does not push provider secrets in v1.
- **One local run at a time** (single `eve start` port). In-memory run registry;
  a server restart resets status to `idle` and does not auto-reap a lingering
  child (surfaced as a caveat).
- **Local server only.** Run endpoints spawn processes and install deps — they
  are for the operator's own machine, never an untrusted caller.

## Architecture

A new side-effecting module `src/gem/run.ts` (peer of `workspaces.ts`), wired
through controller endpoints and a "Run" section in `src/public/index.html`.

### Testability — injected `ProcessRunner`

Mirroring `publish.ts`'s injected `PublishClient`, `run.ts` depends on a
`ProcessRunner` interface so the pure logic is unit-testable without spawning:

```ts
export interface ProcHandle {
  pid: number;
  onLine(cb: (line: string, stream: "out" | "err") => void): void;
  onExit(cb: (code: number | null) => void): void;
  kill(): void;
}
export interface ProcessRunner {
  spawn(cmd: string, args: string[], opts: { cwd: string; env: NodeJS.ProcessEnv }): ProcHandle;
}
```

The real runner wraps `node:child_process.spawn` (line-buffered). Tests inject a
fake that emits scripted lines/exit codes.

### State machine (per workspace, in-memory)

```
idle → installing → building → running → idle        (local; running until stop)
idle → installing → building → deploying → idle       (vercel; returns URL)
(any) → failed                                         (non-zero exit)
```

A `RunState` record per workspace: `{ mode: "local" | "vercel"; state: "idle" |
"installing" | "building" | "running" | "deploying" | "failed"; url?: string;
logTail: string[] }`. `logTail` is a ring buffer (cap 200 lines).

### Components (`src/gem/run.ts`)

- `runReadiness(): { local: boolean; vercel: boolean }` —
  `local = major(process.version) >= 24`; `vercel = !!process.env.VERCEL_TOKEN`.
- `ensureRunProject(name): string` — re-`materialize(gem, "eve")`; refresh
  `.run/eve` by `rmSync(.run/eve/agent)` + rewriting `agent/` and the scaffold
  files (`writeArchiveDir`), preserving `node_modules`/`.output`/`.eve`; then run
  `npm install` if `node_modules` is absent **or** the written `package.json`
  differs from the last-installed copy (compare bytes against a stored
  `.run/eve/.installed-package.json`). Returns the run-dir path. Uses the
  injected runner for `npm install`.
- `startLocal(name, runner): RunState` — `ensureRunProject`, then spawn
  `eve build` (`node_modules/.bin/eve build`) → on success spawn `eve start`;
  parse the listening URL from stdout (`parseEveUrl`); store the child + state in
  the registry. Rejects if a local run is already active for any workspace.
- `stopLocal(name): { stopped: boolean }` — kill the child, set `idle`.
- `deployVercel(name, runner): RunState` — `ensureRunProject`, spawn `eve build`
  with `env.VERCEL = "1"`, then the pinned `vercel deploy --prebuilt --yes
  --token=<VERCEL_TOKEN>` (cwd = run dir); parse the deployment URL
  (`parseVercelUrl`). Throws if `VERCEL_TOKEN` is unset.
- `getRunStatus(name): RunState | { state: "idle" }` — read the registry.
- Pure helpers (unit-tested): `parseEveUrl(lines)`, `parseVercelUrl(lines)`,
  `pushLog(buf, line)` (ring buffer), `nodeMajor(version)`.

### Controller endpoints (`src/gem.controller.ts`) + schemas (`src/schemas.ts`)

| Method | Path | Body/Query | Response |
|---|---|---|---|
| GET | `/api/run-ready` | `?name&target=eve` | `{ local: boolean, vercel: boolean }` |
| POST | `/api/run` | `{ name, target: "eve", mode: "local"\|"vercel" }` | `{ mode, state, url? }` |
| GET | `/api/run-status` | `?name&target=eve` | `{ mode, state, url?, logTail: string[] }` |
| POST | `/api/run/stop` | `{ name, target: "eve" }` | `{ stopped: boolean }` |

`/api/run` with `mode:"vercel"` and no `VERCEL_TOKEN` returns 400. The
`VERCEL_TOKEN` is read server-side and never returned.

### UI (`src/public/index.html`)

A "Run" section on the eve target/workspace view:
- "Run locally" and "Deploy to Vercel" buttons, each disabled when its
  `run-ready` flag is false (with a hint, e.g. "set VERCEL_TOKEN").
- A state badge (`idle`/`installing`/`building`/`running`/`deploying`/`failed`).
- The `url` rendered as a clickable link once present.
- A polled log tail (`GET /api/run-status` every ~1.5s while state is active).
- A "Stop" button shown while `state === "running"`.

## Error handling

- Non-zero exit from `npm install` / `eve build` / `eve start` / `vercel deploy`
  → `state: "failed"`, the captured `logTail` retained for display.
- `mode:"vercel"` without `VERCEL_TOKEN` → 400 `invalid_request`.
- Concurrent local run requested while one is active → 409-style error
  (`{ error: "a local run is already active" }`).
- Server restart → registry empty → status `idle`; a previously spawned child may
  still hold the port (documented; operator kills it).

## Testing

- **Unit (vitest):** `parseEveUrl`/`parseVercelUrl` against sample stdout;
  `pushLog` ring-buffer cap; `nodeMajor`/`runReadiness` (stub `process.version` /
  `VERCEL_TOKEN`); command + env construction for `startLocal`/`deployVercel`
  via the injected fake `ProcessRunner` (assert exact argv/cwd/env, the
  build→start / build→deploy sequencing, and `failed` on a non-zero exit);
  `ensureRunProject` install-skip logic via a fake fs/runner.
- **Manual/e2e:** against the `gem` workspace on this machine — `POST /api/run`
  local → `running` + URL reachable; `POST /api/run/stop`; with `VERCEL_TOKEN`
  set, `mode:"vercel"` → deployment URL. (Not in vitest — needs real eve + npm.)

## Out of scope (future)

- Pushing provider/MCP secrets to the Vercel project (operator configures them).
- Multiple concurrent local runs / port allocation.
- Persisting run state across server restarts; auto-reaping orphaned children.
- Run/deploy for non-eve targets (this is eve-specific; generalize later).
