# Miniapp builder skill — the authoring contract the Studio agent actually reads

_Base: `origin/main` @ bf9f5d1c (worktree `agentgem-miniapp-skill`, branch `feat/miniapp-builder-skill`)._

## Goal

Give the **Play Studio agent** a complete authoring contract for sealed miniapps /
mini-games: the rules, the host capability protocol, the security model, the
source data it is handed, the privacy boundary, and the traps that have already
cost us debugging time.

Today that contract is `studioInstructions()` — four sentences in
`packages/play/src/studio.ts:52`:

> edit only `<name>.html`; keep it self-contained and SEALED; inline JS/CSS; `data:`
> URIs only; no network calls; replace the `AGENTGEM:GAME-LOGIC` block; read
> `<script id="game-data">`; must not throw on load.

That covers the seal and nothing else. It never mentions `window.agentgemApp`,
how to declare `needs` in `meta.json`, the consent gate, that baked `game-data`
is redacted **and then published**, that storage is an ephemeral in-memory shim
under the null origin, or the one-shot-viewport sizing bug. The agent that writes
every miniapp is the one reader who never sees any of it.

## Audience (decided)

The **Studio agent** — the ACP session opened by `POST /api/chat {miniapp}`,
cwd-jailed by `studioCwd()` to `~/.agentgem/miniapps/<name>/`.

Two consequences follow directly, and they determine the whole design:

1. **The agent cannot read this repo.** `studioCwd()` resolve-normalizes and
   rejects any path outside the miniapps registry. A skill file that merely sits
   in `skills/` is unreachable — the contract must be *pushed* into the brief.
2. **The adapter may not have a skill loader.** The studio runs `claude-agent-acp`
   *or* `codex-acp`. Only a plain brief string is guaranteed to arrive.

`packages/run/src/chatSession.ts:122` injects the brief on the **first turn only**,
then nulls it. Brief length is therefore a one-time cost, not a per-turn tax, so a
full-length contract can be inlined.

## Architecture: one string, two consumers

Canonical text is a TypeScript string constant. The markdown file is a
generated-and-asserted **view** of it, not a second source.

```
packages/play/src/builderBrief.ts        MINIAPP_BUILDER_BRIEF  ← canonical
        │
        ├── studio.ts studioInstructions(name)   → the Studio agent's first-turn brief
        └── skills/agentgem-miniapp/SKILL.md     → humans + `npx skills add ninemindai/agentgem`
                     ▲
                     └── src/play/__tests__/builderBrief.test.ts asserts SKILL.md ends with the const
```

This was chosen over three alternatives:

- **SKILL.md canonical, read at runtime.** Requires adding `skills/` to
  package.json `files` (today: `dist` only) and resolving via `import.meta.url`.
  Buys nothing and adds a packaging failure mode on a path the studio depends on.
- **Build-time text embed.** Correct, but adds a build step to `packages/play`
  for one string.
- **Standalone skill, brief points at it.** The cwd jail makes it a silent no-op.
- **Seed a copy into each miniapp dir.** Gets git-committed into the registry,
  travels toward publish, and only Claude-family adapters read it.

`skills/` is already the location skills.sh scans (see
`docs/superpowers/specs/2026-07-05-insights-skills-design.md`), so the human-facing
artifact is free.

## Skill content

Eight sections, each anchored to code rather than invented. Source of every claim
is named so a future editor can re-verify it.

### 1. What you're building

One sealed `<name>.html`. Edit only between the `AGENTGEM:GAME-LOGIC` markers.
`meta.json` is where `needs` is declared. The file runs in a null-origin iframe —
`sandbox="allow-scripts"` with **no** `allow-same-origin` — under

```
default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline';
img-src data:; font-src data:; media-src data:;
```

_(`packages/console/src/panels/Watch/sandboxDoc.ts`; `Play/Runner.tsx`.)_

### 2. The rules Save enforces

Two gates, both run by `saveMiniapp()`:

- **Seal** (`packages/play/src/gameGate.ts`). No external `src`/`href`, no bare
  `import … from`, and none of
  `fetch | XMLHttpRequest | WebSocket | EventSource | importScripts | navigator.sendBeacon`
  anywhere in **executable** code — including comments and string literals, a known
  false positive worth naming rather than hiding. ≤ 1.5 MB. Must not throw on load
  (jsdom smoke). Inert `<script type="application/json">` content is excluded from
  the scan by `scannableCode()`.
- **Portability** (`packages/play/src/portability.ts`). If `meta.json` `needs`
  contains `session-data`, the file **must** bake a non-empty `timeline` into
  `<script id="game-data">`. app.agentgem.ai plays games with **no capability
  broker**; without a fallback the published game sits empty.

### 3. Project / session / skill as context

The source is injected as an inert `<script id="game-data" type="application/json">`
in `<head>`, so it parses **before** the body script runs (`studio.ts` `seedHtml()`).

| `GameSource.kind` | genre | shape of `game-data` |
|---|---|---|
| `session` | `replay` | `{ meta, timeline: {role,tsMs,text}[] }` — ≤ 500 turns, `text` sliced to 200 chars (`sourceContext.compactTurns`) |
| `skill` | `skill-run` | `extractSource` skill context |
| `project` | `project-fun` | `extractSource` project context |
| `html`, `blank` | `project-fun` | none |

The standing rule: **boot from baked data first, re-render when fresh data arrives,
never assume a host exists.** A miniapp must be watchable on app.agentgem.ai.

### 4. Backend access — the host capability protocol

The miniapp never touches the network. The host brokers, over `postMessage` —
which CSP does not govern. That is *why* "sealed" and "interactive" coexist, and
it is the single most non-obvious fact in the system.

The wire is MCP Apps `ui/*` JSON-RPC 2.0 (`modelcontextprotocol/ext-apps`, MVP
`2026-01-26`). The shim `window.agentgemApp` is injected by
`packages/play/src/mcpAppClient.ts`; the router is
`packages/console/src/panels/Play/mcpUiHost.ts`.

```js
await window.agentgemApp.callTool(name, args)            // one-shot, returns a Promise
window.agentgemApp.onNotification("ui/notifications/tool-result",
                                  ({ toolName, chunk }) => …)   // streamed
window.agentgemApp.ready        // boolean
window.agentgemApp.hostTools    // tools the host advertised, filtered to your `needs`
```

Subscribe **by method** (`"ui/notifications/tool-result"`), not by `toolName`.
Dispatching on `d.params.toolName` silently drops every host-pushed refresh; this
exact bug shipped once and was caught only by whole-stack review (fixed `dbae1127`).

| capability (`meta.json` `needs`) | tool | you get | consent |
|---|---|---|---|
| `session-data` | `agentgem_get_session_data` | your own source session `{meta,timeline}` | **auto** (`AUTO_CAPS`) |
| `local-project-access` | `agentgem_get_inventory` | the viewer's skills / MCP servers / projects | prompt |
| `live-session-events` | `agentgem_subscribe_sessions` | streamed live session events | prompt |
| `invoke-agent` | `agentgem_invoke_agent({message})` | a streamed agent transcript | prompt |

Failure modes to handle: undeclared capability → JSON-RPC `-32601`
`"capability not permitted"`; denied consent → `-32001` `"consent denied"`; no host
at all (marketplace) → the handshake exhausts after ~5 × 800 ms and every pending
`callTool` rejects with `"no host"`.

### 5. Security model — what a miniapp may not assume

- **The gate is an admission heuristic. The CSP + null origin is the boundary.**
  `gameGate.ts` says so in its own header. Don't try to defeat either.
- **The host trusts nothing the miniapp sends.** It pins `e.source` (browser-set,
  unforgeable), enforces `cap ∈ needs` on every call rather than only at
  advertisement, **ignores a miniapp-supplied `sessionId`** for `session-data`
  (rebinding to another session is host-initiated only, via the Runner's picker),
  single-flights live streams and invoke turns, and drops in-flight replies from a
  superseded game via a generation pin.
- **`invoke-agent` is a neutral, read-only agent turn** — opened with no `miniapp`,
  so `permission: "deny"`. It cannot edit files or run commands. Don't tell the
  user it can.
- **`localStorage` / `sessionStorage` are an in-memory shim** installed by
  `sandboxDoc.ts` only because a null-origin document throws `SecurityError` on
  native access. State is ephemeral and dies on reload. Don't promise persistence.

### 6. Privacy

- **Anything baked into the HTML ships.** Save dual-writes a one-artifact `game`
  gem (`writeGameGem`); "Share to app.agentgem.ai" makes it public.
- **Seed data was already scrubbed** by `redactForBake()` — home dir → `~`, and
  OpenAI / GitHub / AWS / Slack / JWT token shapes → `‹redacted›`. It is
  explicitly best-effort, **not a guarantee**. Never write absolute home paths,
  usernames, hostnames, or key-shaped strings back into the file.
- **Gated capabilities read the *viewer's* data, not the author's.** Each costs
  the viewer a blunt consent prompt — "run a local AI agent on your machine" — so
  declare a capability only when the game is useless without it.

### 7. Traps

Each of these has already cost debugging time (see the `play-mini-games` history):

- Full-window layout: `html,body{height:100%;overflow:hidden}`,
  `#stage{position:fixed;inset:0}`.
- **Never measure the viewport once.** Listen to `resize`. A one-shot measurement
  at parse time is the #1 sizing bug: the frame can be born small, and fullscreen
  changes the real viewport.
- Don't hand-roll a readiness poll. The shim already retries the handshake ~5 ×
  800 ms and queues `callTool`s issued before `ready`.
- Canvas games take 3–5 s to first paint. A blank frame right after mount is
  usually slow paint, not a bug.
- Stay under 1.5 MB. Inline `data:` assets sparingly.

### 8. Finishing

Save runs both gates; Push to git commits the registry; Share to app.agentgem.ai
publishes the gem. On a gate failure the console surfaces the message — fix it in
the file. (The console additionally offers "Fix with agent", which injects the
failure back into the studio chat.)

## Files

| File | Change |
|---|---|
| `packages/play/src/builderBrief.ts` | **new** — `export const MINIAPP_BUILDER_BRIEF: string` |
| `packages/play/src/studio.ts` | `studioInstructions(name)` → `` `You are building the miniapp in ${name}.html.\n\n${MINIAPP_BUILDER_BRIEF}` `` |
| `packages/play/src/index.ts` | export the const |
| `skills/agentgem-miniapp/SKILL.md` | **new** — frontmatter + `# agentgem-miniapp` + the identical body |
| `src/play/__tests__/builderBrief.test.ts` | **new** — drift guard + content guards |

`studioInstructions` is shared by `seedStudio`, `importStudio`, `blankStudio`, and
`studioBrief`, so all four entry points pick the contract up with no further change.

## Testing

Play tests live in root `src/play/__tests__` and run against `dist` — follow that;
do **not** add a package-local vitest config.

`src/play/__tests__/builderBrief.test.ts`:

- `SKILL.md` parses as frontmatter with `name: agentgem-miniapp` and a
  non-empty `description`;
- `SKILL.md.endsWith(MINIAPP_BUILDER_BRIEF)` — the drift guard that makes the
  markdown a view rather than a fork;
- content guards — the brief mentions each of `agentgem_get_session_data`,
  `agentgem_get_inventory`, `agentgem_subscribe_sessions`, `agentgem_invoke_agent`,
  the literal `ui/notifications/tool-result`, `needs`, `default-src 'none'`,
  `redactForBake`, and `read-only`.

Existing tests that must stay green without modification:
`src/__tests__/chatStudio.test.ts:29` asserts the brief *contains* `<name>.html`
(preserved by the composed first line), and `src/__tests__/playRoutes.test.ts:54`
asserts the seeded HTML contains `AGENTGEM:GAME-LOGIC` (untouched).

## Non-goals

- No runtime change: `mcpUiHost.ts`, `mcpHostTools.ts`, `Runner.tsx` untouched.
- No new capability, and no change to either gate.
- Not an external-host authoring guide — running miniapps in Claude/ChatGPT is
  `mcpApp.ts`'s producer surface and a separate concern.
- No `.claude/skills/` directory; `skills/` stays the home for first-party skills.
