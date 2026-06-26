# Design: pluggable sandbox backends for Gem runs (issue #4)

- **Status:** Approved design (pre-implementation)
- **Date:** 2026-06-25
- **Issue:** #4 — "Security: sandbox agent runs so auto-allow can be safe by default"
- **Area:** Gem runner — `src/gem/acpRun.ts`, `src/gem/runGem.ts`, `src/gem/acpSession.ts`
- **Depends on:** the shipped ACP Gem runner + the gem-run security hardening (0d3a3ad)

## Problem

`defaultRunConnectFn` (`acpRun.ts`) drives a locally-installed ACP coding agent against a
materialized testbed. The agent's tool calls — including **shell** — run with the user's
full privileges; the run dir is only the agent's cwd, **not** a boundary. Blanket
auto-allow is therefore opt-in via `AGENTGEM_GEM_RUN_AUTOALLOW=1`, an interim control.

**Goal:** introduce a real isolation boundary so a Gem run can auto-approve tools safely,
and flip auto-allow to safe-by-default *only* on the isolated path.

## Approach (chosen)

A **pluggable backend registry** in front of the existing `RunConnectFn` seam, shipping
one dependency-free **OS-native reference backend** (macOS `sandbox-exec` /
Linux `bubblewrap`). agentOS (the prior spike) becomes a later plug-in to the same
registry. Selection auto-detects the best isolated backend and falls back to the
unsandboxed child-spawn with `permission: "deny"` when none is available — safe by
default on every platform.

Rejected for v1: a single hard-coded mechanism (less flexible — the user asked for a
pluggable interface); agentOS as the first backend (pre-1.0 native sidecar, hard to test
deterministically); containers (require a runtime, heavier, no in-process hosted story).

## Architecture

### `SandboxBackend` — the new abstraction

```ts
// src/gem/sandbox.ts
export interface SandboxBackend {
  id: string;                 // "macos-seatbelt" | "linux-bubblewrap" | "child-spawn"
  isolated: boolean;          // enforces a filesystem write boundary?
  available(): boolean;       // platform + required binary present
  // Produce a RunConnectFn scoped to runDir. Isolated backends bake runDir into the
  // sandbox profile and set permission:"allow"; child-spawn honors the env escape hatch.
  connectFn(runDir: string): RunConnectFn;
}

// Ordered registry; first available() isolated backend wins, else child-spawn.
export function selectRunBackend(
  runDir: string,
  env?: NodeJS.ProcessEnv,
): { backend: SandboxBackend; connectFn: RunConnectFn };
```

`RunConnectFn` (the lower-level `(descriptor, app) => { ctx, close }` seam) is unchanged.
The existing `defaultRunConnectFn` is repackaged as the `child-spawn` backend
(`isolated: false`).

### Why a command wrapper works

`connectAcpAdapter` (`acpSession.ts`) spawns `descriptor.command` verbatim
(`const [bin, ...args] = descriptor.command; spawn(bin, args, …)`). `sandbox-exec` and
`bwrap` apply to the launched process **and all descendants**, so an isolated backend is
just a descriptor whose `command` is the wrapper + the original agent argv. The agent's
shell tool-children inherit the jail with no change to the session/prompt/update plumbing.

The run dir is known before connect (`runGemWithAgent({ dir })` calls the connectFn then
`ctx.open(dir)`), so the backend factory closes over `runDir` to build the profile at
spawn time.

## The isolated backends (v1)

### macOS — `macos-seatbelt`
Wrap: `sandbox-exec -p <policy> <agent…>` (inline policy via `-p`, no temp file).
Generated SBPL policy is **write-deny**, not deny-default: allow everything, then deny
all writes, then re-allow writes only under `runDir` + temp + the std dev nodes. This
contains the blast radius (writes) while leaving reads/exec/network working — and avoids
the agentOS-spike trap where a naive `(deny default)` killed the agent's own runtime
before it could start.

```
(version 1)
(allow default)
(deny file-write*)
(allow file-write*
  (subpath "<runDir>")
  (subpath "<TMPDIR>")
  (literal "/dev/null") (literal "/dev/stdout") (literal "/dev/stderr")
  (subpath "/dev/tty") (regex #"^/dev/fd/"))
```

Network stays open (covered by `allow default`). `available()` = `process.platform ===
"darwin"` and `/usr/bin/sandbox-exec` exists.

### Linux — `linux-bubblewrap`
Wrap: `bwrap --ro-bind / / --bind <runDir> <runDir> --bind <TMPDIR> <TMPDIR> --dev /dev --proc /proc --unshare-pid -- <agent…>`.
Read-only-bind the whole FS, then writable-bind only `runDir` + temp. `available()` =
`process.platform === "linux"` and `bwrap` resolves on `PATH`.

### Scope (v1)
Contain **filesystem writes** to `runDir` (+ temp). Reads stay broad (node, npm, the agent
binary live outside `runDir`). **Network stays open** — the agent must reach the model
API; egress containment is a follow-up. Process exec is allowed (the agent spawns shells);
they inherit the same write boundary.

## Auto-allow becomes capability-gated

Replace the `AGENTGEM_GEM_RUN_AUTOALLOW` check inside `defaultRunConnectFn` with a
per-backend policy:

| Backend | `permission` default | Escape hatch |
|---|---|---|
| isolated (`macos-seatbelt` / `linux-bubblewrap`) | `allow` | — (already bounded) |
| `child-spawn` (`isolated:false`) | `deny` | `AGENTGEM_GEM_RUN_AUTOALLOW=1` → `allow` |

Result: on a Mac/Linux dev box auto-allow "just works" safely; on Windows / when no
sandbox binary is present, runs are `deny` unless the user explicitly opts in — today's
behavior, preserved as the fallback.

## Observability

`GemRunOutcome` (and the run status the SSE stream/UI read) gains:

```ts
sandbox: { backend: string; isolated: boolean };
```

so the UI can show "Sandboxed (macos-seatbelt)" vs "Unsandboxed — tools require approval",
and the regression test can assert which path executed.

## Data flow

```
runGemWithAgent({ dir, task })
  └─ selectRunBackend(dir)            → { backend, connectFn }   (auto-detect)
  └─ connectFn(CLAUDE_RUN_AGENT)      → spawns [wrapper… , claude-agent-acp]  (jailed)
  └─ ctx.open(dir) → setMode → prompt → RunResult
  └─ returns { ok, result, sandbox: { backend.id, backend.isolated } }
```

## Testing

- **Unit (`sandbox.test.ts`):** registry selection prefers an isolated backend and falls
  back to `child-spawn` when none `available()`; capability→permission mapping
  (isolated→allow, child-spawn→deny unless env=1); SBPL/bwrap argv generation for a given
  `runDir`.
- **Real-boundary test (the teeth), macOS-gated:** generate the profile for a temp
  `runDir`, then assert `sandbox-exec -f <profile> sh -c 'echo x > <outside>'` **fails**
  while a write **inside** `runDir` **succeeds**. Directly verifies the acceptance
  criterion; `it.skipIf(platform !== 'darwin' || no sandbox-exec)`.
- **Existing runner/controller tests** keep injecting a fake `RunConnectFn` and are
  unaffected; one assertion added that the outcome carries `sandbox.backend`.

## Out of scope (follow-ups)

- **agentOS backend** — plugs into this same registry (`isolated: true`); gives the
  hosted/server-side-run story. See `docs/proposals/agentos-sandboxed-execution.md`.
- **Network egress containment** — restrict the agent to the model API host only.
- **Windows isolation** — no first-class sandbox; stays on the deny fallback.

## Acceptance mapping

> a sandboxed `RunConnectFn` where shell/file tools cannot affect anything outside the run
> sandbox; auto-allow enabled by default only for that path.

- "sandboxed `RunConnectFn`" → the isolated backends' `connectFn(runDir)`.
- "cannot affect anything outside" → SBPL/bwrap write-confinement, proven by the
  real-boundary test.
- "auto-allow by default only for that path" → capability-gated permission table.
