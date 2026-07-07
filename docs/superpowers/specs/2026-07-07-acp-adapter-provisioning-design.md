# ACP Adapter Provisioning — Design

**Date:** 2026-07-07
**Status:** Approved (brainstorm) — ready for implementation plan
**Approach:** B — managed-dir resolver seam, npm-on-demand for CLI, bundle-in-app for desktop

## Problem

The Chat tab lets a user converse through a coding agent (Claude Code, Codex) over
ACP. Availability of each agent is decided by probing PATH for a bare adapter binary:

- `packages/base/src/agents.ts:10` — `AGENTS = [{id:"claude-code", command:["claude-agent-acp"]}, {id:"codex", command:["codex-acp"]}]`
- `availableAgents()` runs `which <bin>` per agent; the Chat picker greys out any that miss.
- `connectAcpAdapter` (`packages/base/src/acpSession.ts:68`) spawns `descriptor.command` **by bare name**, relying on PATH resolution.

These adapter binaries are **not** bundled: neither `@agentclientprotocol/claude-agent-acp`
nor `@agentclientprotocol/codex-acp` appears in any `package.json` or `node_modules/.bin`.
A fresh downloader must `npm i -g` them by hand, know they differ from the plain `codex`
CLI, and land them on the exact PATH the server process inherits. This fails silently in
two common cases:

1. **nvm/PATH drift** — a global install under a different Node than the server sees.
2. **Desktop (Electron)** — the app runs the core **in-process** (`desktop/src/server.ts`
   `import()`s the core into the Electron process; there is no child Node and no `npm`),
   and a GUI launch has a minimal PATH that won't see globally-installed adapters.

Goal: a downloader can use Chat with either agent without manual PATH/npm fiddling, on
**both** distribution channels (CLI `npm i -g @ninemind/agentgem` and the desktop app).

## Scope

- **In scope:** ensure the adapter binary is present and resolvable; consent-gated
  install; surface an "installed · needs login" state.
- **Out of scope (deliberate):** driving the agent's own login (OpenAI/Claude). The
  adapter prompts on first use, as today. We only *surface* a best-effort needs-login
  hint. Full login orchestration is a possible later project.

## Key constraints discovered

- **Desktop has no `npm`** and a minimal GUI PATH; the core runs inside the Electron
  process. On-demand `npm` is a non-starter there.
- **Desktop can still execute a Node adapter** by spawning `process.execPath` (Electron's
  own binary) with `ELECTRON_RUN_AS_NODE=1` pointed at the adapter's entry `.js`. No
  system `node`/`npm` needed. So the desktop problem is purely *getting the files on disk*.
- Each adapter is ~250 MB on disk because it bundles its whole agent CLI
  (`codex-acp` 261 MB incl. `@openai/codex`; `claude-agent-acp` 249 MB incl.
  `claude-agent-sdk`). Bundling both into every install is ~510 MB — rejected as a
  universal default; acceptable for the desktop DMG as a conscious call (see Decisions).
- An **executable-consent gate already exists**: `install-hosted` returns
  `409 consent_required` and the console gates on it (`src/gem.controller.ts:594`,
  `src/gem/hostedInstall.ts`). Reuse this UX verbatim.
- **Tests inject all agent/network deps** (no real `claude-agent-acp`, no real npm);
  vitest runs from `dist/`. The design must keep npm behind an injected seam.

## Architecture: the resolver seam

One new provisioning layer in `@agentgem/base`, co-located with `agents.ts`/`acpSession.ts`.

### Registry gains provenance

`AgentDescriptor` extends from `{id, name, command}` to also carry `{package, version}`
with a **pinned** version (vetted, reproducible — not floating `latest`):

```
{ id:"claude-code", name:"Claude Code", command:["claude-agent-acp"],
  package:"@agentclientprotocol/claude-agent-acp", version:"0.51.0" }
{ id:"codex",       name:"Codex",       command:["codex-acp"],
  package:"@agentclientprotocol/codex-acp",       version:"1.1.0" }
```

### resolveAdapter(id, runtime) → launch plan

Tries sources in order and returns an absolute, runnable plan (or "missing"):

1. **On PATH** (`which <bin>`) — back-compat for users who already `npm i -g`'d it.
2. **App-managed dir** — `~/.agentgem/adapters/<id>/` (an isolated npm prefix). Resolve
   the absolute entry from its `node_modules/<package>` `bin`.
3. **Bundled in app** (desktop only) — `process.resourcesPath/adapters/<id>`, shipped via
   electron-builder `extraResources`.
4. **Missing** → `{available:false, installable:true}`.

### Launch is unified and absolute

`connectAcpAdapter` stops spawning `descriptor.command` by bare name and consumes the plan:

- **CLI runtime:** spawn the resolved bin/entry (absolute path).
- **Desktop runtime:** spawn `process.execPath` with `ELECTRON_RUN_AS_NODE=1` + the entry
  `.js`, running the adapter on Electron's own Node.

Security invariants unchanged: `localAgentEnv()` sanitization and the server-derived cwd
(`acpSession.ts` note at lines 30–35) still apply; request input never reaches the spawn.

### Runtime is injected, not sniffed

The CLI entry (`src/index.ts`) injects `runtime:"cli"`; desktop (`desktop/src/server.ts`)
injects `runtime:"desktop"` + `resourcesPath`. No `process.versions.electron` sniffing in
`base` — matches the codebase's dependency-injection style.

## Components

| File | Change |
|---|---|
| `packages/base/src/adapters.ts` *(new)* | `resolveAdapter`, `ensureAdapter`, `adapterStatus`, launch-plan builder. Pure logic over injected `probe`/`fs`/`installer`/`spawn`. |
| `packages/base/src/agents.ts` | Registry gains `package`+`version`; `availableAgents()` delegates to `resolveAdapter`; returns `{id, name, available, installable, source: path\|managed\|bundled, needsLogin?}`. |
| `packages/base/src/acpSession.ts` | `connectAcpAdapter` consumes the launch plan (absolute entry + optional `ELECTRON_RUN_AS_NODE`) instead of bare spawn. |
| `src/goldmine/chatRoutes.ts` | New `POST /api/agents/:id/install` (consent-gated); `GET /api/agents` returns richer status. |
| `src/index.ts` | Injects `runtime:"cli"` + managed-dir installer into chat deps. |
| `desktop/electron-builder.yml` + `desktop/src/server.ts` | `extraResources` bundles both adapters; injects `runtime:"desktop"` + `resourcesPath`. |
| `packages/console` Chat picker | Renders `installable` agents with an Install affordance → consent modal → `POST install` → refetch `/api/agents`. Surfaces "installed · needs login". |

## Acquire / install flow

Acquire runs **only** for source #2 (CLI managed dir):

```
npm install <package>@<version> --prefix <tmp>   # isolated per-adapter prefix
# on success: atomic rename <tmp> → ~/.agentgem/adapters/<id>
```

- **Temp prefix → atomic rename**: a half-finished install never resolves as "present."
- **Per-id install lock**: concurrent installs of the same adapter await one run.
- **Desktop never acquires**: if a bundled adapter is somehow absent, report
  "reinstall the app" — never shell out to npm.

### Data flow (inline install, CLI)

```
Chat loads → GET /api/agents → [{id:"codex", available:false, installable:true}]
User picks Codex → console consent modal:
   "Install Codex adapter — downloads @agentclientprotocol/codex-acp
    (~260 MB, pinned v1.1.0) and runs it locally.  [Cancel] [Install]"
→ POST /api/agents/codex/install {consent:true}
→ ensureAdapter: npm --prefix (tmp → atomic rename) → re-resolve
→ 200 {available:true, needsLogin:true}
→ console refetches /api/agents; Codex now selectable (badge: "needs login")
Select Codex → connectAcpAdapter(resolveAdapter) → absolute launch → ACP session
```

Without `consent:true`, `POST install` returns `409 consent_required`, reusing the
`install-hosted` gate.

## Error handling

| Situation | Behavior |
|---|---|
| No consent on install | `409 consent_required` (reuses `install-hosted` gate) |
| `npm` absent (CLI, rare) | Clear error ("npm not found — install `<pkg>@<ver>` manually") with the exact command |
| npm nonzero exit / network fail | Fail with **stderr tail**; temp dir discarded (atomic rename never fired); console offers Retry |
| Concurrent install of same id | Per-id lock; second caller awaits the first's result |
| Partial/corrupt install | Temp-prefix + atomic rename ⇒ broken install never resolves as `available` |
| Desktop bundle missing | "Reinstall the app" — never attempts npm on desktop |
| Installed but not logged in | `needsLogin:true` (best-effort probe of `~/.codex`/`~/.claude`); Chat still lets you select it; adapter prompts on first use |

Guiding rule: **a failed install leaves zero trace that could later read as success** —
the atomic-rename boundary enforces it.

## Testing

Follows the repo convention (inject all agent/network deps; no real npm/adapters in CI;
vitest runs from `dist/`).

- **`adapters.ts` unit** — `resolveAdapter` source-ordering (path → managed → bundled →
  missing) with injected probes; launch-plan builder asserts CLI vs desktop shape
  (desktop ⇒ `process.execPath` + `ELECTRON_RUN_AS_NODE=1`); `ensureAdapter` drives an
  **injected fake installer**, asserts temp→atomic-rename and the per-id lock.
- **`agents.ts` unit** — status mapping (`available`/`installable`/`source`/`needsLogin`).
- **Route unit** — `POST install` returns 409 without consent, 200 with (fake installer);
  `GET /api/agents` shape.
- **Desktop unit** — `resourcesPath` resolution + node-launch plan (no real Electron).
- **Opt-in smoke (not CI)** — a real `npm i` of one adapter into a temp prefix + resolve,
  mirroring `scripts/smoke/chat-e2e.mjs`. Manual, gated.

The **injected-installer seam** keeps this CI-safe: `ensureAdapter` never calls `npm`
directly — it calls an injected `install(pkg, dir)`; CI passes a fixture-maker,
production passes the real npm-spawn.

## Decisions & tradeoffs

- **Approach B over A/C.** C (`optionalDependencies`) forces ~510 MB on every install,
  both channels — rejected. A (fully on-demand, incl. desktop binary download we host)
  requires standing up build+host+version-tracking infra for adapter bundles — deferred
  until desktop installer size is an actual complaint. B unifies the hard part (the
  resolver/spawn seam) and uses the simplest delivery each channel already supports.
- **Desktop bundles both adapters (~510 MB DMG).** Conscious call for full parity /
  offline day-one on desktop. Trimming to a default-plus-on-demand model is the natural
  A-style follow-up if DMG size becomes a problem.
- **Pinned adapter versions.** Vetted + reproducible; bumped deliberately, not floating.
- **Auth is out of scope.** Availability-only keeps this shippable; needs-login is a
  best-effort hint, not a blocker.

## Follow-ups (not in this spec)

- A-style **on-demand desktop binary download** to trim the DMG (host prebuilt adapter
  bundles; download the one agent the user picks).
- **Login orchestration** (device-flow / hand-off) so users go zero-to-chatting in-app.
- A **management surface** (Adapters/Configuration panel) for status/removal, if inline
  install proves insufficient.
