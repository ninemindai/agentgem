# Miniapps: app spec

Normative specification of the AgentGem **miniapp** (mini-game) feature, written
for spec-driven development: each requirement is stated so an implementation — or
an agent implementing against it — can be checked. The words **MUST**, **MUST
NOT**, **SHOULD**, and **MAY** are used in the RFC-2119 sense.

Companions: [`evolution.md`](evolution.md) records why these rules exist;
[`../play.md`](../play.md) is the user-facing tour;
[`../../skills/agentgem-miniapp/SKILL.md`](../../skills/agentgem-miniapp/SKILL.md)
is the authoring contract injected into the Studio agent — where this spec and
the skill describe the same rule, the skill's wording is the one the agent sees,
and the two MUST NOT drift. The skill body is itself a byte-for-byte view of
`MINIAPP_BUILDER_BRIEF` (`packages/play/src/builderBrief.ts`): contract changes
are made to the constant, never to the markdown, and
`src/play/__tests__/builderBrief.test.ts` guards the mirror.

## 1. Overview

A miniapp is a **single, self-contained HTML file** built by chatting with a
coding agent, run in a **sealed iframe**, and treated as a first-class **`game`
Gem** (versionable, shareable, publishable). The design trades all network access
away in exchange for being safe to run anywhere, and compensates with a
**host-brokered capability protocol** (MCP Apps `ui/*`) for live data.

Three invariants anchor everything below:

- **I1 — Sealed runtime.** A miniapp has no network and no origin. Everything it
  needs is baked in or brokered by a trusted host over `postMessage`.
- **I2 — Declarations cannot lie.** Every capability a miniapp uses is declared
  in `meta.json`, and Save derives the truth from the source and reconciles it.
- **I3 — Nothing ships without opt-in.** Building is local. Publishing, pushing,
  and team sharing are each a separate explicit act with a user-chosen scope.

## 2. Definitions

| term | meaning |
| --- | --- |
| **registry** | `~/.agentgem/miniapps/` (or `$AGENTGEM_HOME/miniapps`) — a git repository, one directory per miniapp |
| **bundle** | the miniapp's single HTML file, stored as `index.html` |
| **seal** | the save-time admission gate (self-containment + smoke-load) |
| **host** | the trusted embedder (console Runner, marketplace, or an external MCP Apps host) |
| **shim** | the injected client (`window.agentgemApp`) that speaks the wire protocol |
| **need** | a capability declared in `meta.json` `needs` |
| **mcpNeed** | a declared MCP-connector requirement in `meta.json` `mcpNeeds` |

## 3. The artifact

- **A1.** A miniapp MUST be one self-contained HTML document. Authoring MUST NOT
  add a second executable file.
- **A2.** On disk, a miniapp is a registry directory holding `index.html` and
  `meta.json`; seeded uploads MAY add `uploads/` (shipped) and `ref/`
  (gitignored, agent-readable reference material only).
- **A3.** The registry is a git repository and **versioning is git**: every save,
  seed, import, and checkpoint MUST be a commit. There is no user-facing version
  number; `meta.engineVersion` tracks the scaffold engine, not the user's edits.
  Registry commits MUST be serialized (per-repo mutex) so concurrent saves
  cannot corrupt the repo.
- **A4.** Save MUST dual-write: the registry files *and* the one-artifact `game`
  Gem (`GameArtifact` in the gem artifact union). Re-saving upserts the gem.
- **A5.** `meta.json` carries at least: `name`, `genre` (single-sourced enum,
  drift-guarded), `needs`, `mcpNeeds`, `engineVersion`, and server-owned fields
  (`uploads`) that Save MUST preserve and MUST keep out of the published gem.
  Share state lives in a `share.json` sidecar, durable across restarts.
- **A6.** Creating a miniapp MUST mint a new identity; "new" never overwrites an
  existing one (directory claims are atomic, with collision suffixing). Delete is
  git-recoverable, and MUST remove the paired gem only when it was created from
  Play (`createdFrom: "play"`). Built-in miniapps (id prefix `__`) MUST NOT be
  deletable.
- **A7.** A stored miniapp is also mintable as an **MCP Apps resource**
  (`ui://agentgem/<name>`, mime `text/html;profile=mcp-app`) with a
  `play_<name>` launcher tool, carrying its game metadata (genre, needs,
  `offline` flag) in `_meta["ai.agentgem/game"]` — this is what lets external
  MCP Apps hosts render a miniapp unchanged.

## 4. Admission: what Save enforces

Save runs the gates below in order; any failure aborts the save with an
actionable message (surfaced in Studio with a "Fix with agent" handoff).

### 4.1 The seal

- **S1.** The bundle MUST NOT contain, in executable code: an external `src=` or
  `href=` (anything other than `data:` or `#`); a bare module import; or the
  tokens `fetch`, `XMLHttpRequest`, `WebSocket`, `EventSource`, `importScripts`,
  `navigator.sendBeacon`.
- **S2.** The scan is textual and deliberately blunt: it matches inside comments
  and string literals. Content inside `<script type="application/json">` blocks
  is exempt — which is what makes baked data safe to include.
- **S3.** The bundle MUST be ≤ 1.5 MB and MUST NOT throw during a headless
  (jsdom) smoke-load. Canvas contexts are stubbed for the smoke.
- **S4.** The seal is an **admission heuristic, not a security boundary**. The
  security boundary is the runtime (§5). Implementations MUST NOT weaken the
  runtime on the grounds that the seal already checked something.

### 4.2 Needs reconciliation

- **S5.** Save MUST derive the capabilities the bundle actually uses — host tool
  calls, `agentgemApp.` action-method calls, and `agentgemApp.mcp.*` connector
  calls — and reconcile against `meta.json`:
  - a **used but undeclared** capability fails the save, naming the capability;
  - a **declared but unused** capability is pruned, and the user is told.

  The two manifests are deliberately asymmetric: `needs` is
  **derived-authoritative** (undeclared use throws, unused declarations prune),
  while `mcpNeeds` is **declared-authoritative** (the result is declared ∪
  derived; derivation only auto-fills and warns, never prunes or blocks —
  because the manifest is a security allowlist enforced server-side at call
  time, see P8).
- **S6.** Tool and method names MUST be written as **literal strings** at the
  call site. Save MUST reject a non-literal name: the reconciler reads source,
  and a name it cannot see is a capability it would wrongly prune.
- **S7.** A bundle that uses the host bridge MUST carry the injected shim; Save
  splices it if absent (without nesting a document) and adopts needs added since
  the last save.

### 4.3 Portability

- **S8.** A miniapp declaring `session-data` MUST bake a non-empty `timeline`
  into `<script id="game-data" type="application/json">`. Rationale: the
  marketplace plays games with **no host at all**; without baked data the
  published game is empty forever.
- **S9.** A miniapp MUST boot from its baked data first and re-render if fresher
  host data arrives. It MUST NOT block first paint on a host.

### 4.4 Checkpoints

- **S10.** `checkpoint` (auto-run at agent turn-end) commits work-in-progress to
  the registry **without** the gates, and upserts the gem opportunistically.
  Checkpoints exist so unfinished work survives; only Save admits a bundle.

## 5. Runtime environment

- **R1.** A miniapp runs in an iframe with `sandbox="allow-scripts"` and **no
  `allow-same-origin`** (null origin), under this CSP:
  `default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline';
  img-src data:; font-src data:; media-src data:`.
- **R2.** The host MUST install an in-memory `localStorage`/`sessionStorage`
  shim (a null-origin document throws on the real thing). State does not survive
  reload, and miniapps MUST NOT promise otherwise.
- **R3.** Theming: the host MAY supply the CSS variables
  `--color-background-primary`, `--color-background-secondary`,
  `--color-text-primary`, `--color-border-primary`, and sets
  `<html data-theme>` to `light`/`dark`. Miniapps MUST read variables with
  fallbacks, because most hosts send none.
- **R4.** Sizing: miniapps MUST lay out full-window and re-measure on `resize`.
  Hosts MAY scale-to-fit previews; the frame can be born small; display-mode
  changes push fresh `containerDimensions` (§6.4).
- **R5.** Plain-HTML escapes are in scope: `#` anchor navigation MUST NOT escape
  the `srcdoc` frame.

## 6. Host protocol

### 6.1 Wire

- **P1.** The wire is **MCP Apps `ui/*` JSON-RPC over `postMessage`** (protocol
  revision `2026-01-26`): `ui/initialize` → host reply carrying granted tools in
  `_meta["ai.agentgem/host"]` plus `hostContext` → `ui/notifications/initialized`
  → queued-call flush; calls go over `tools/call`; teardown is a
  `ui/resource-teardown` request/reply; stream and watch identity ride `_meta`.
  The injected shim exposes all of this as `window.agentgemApp`; miniapps MUST
  use the shim, not hand-rolled messaging. A built-in **Protocol Inspector**
  miniapp serves as the living conformance harness.
- **P2.** The host attaches only when `needs` is non-empty, and answers
  `ui/initialize` advertising **exactly the declared capabilities** — the bundle
  carries the transport (shim), `meta.json` carries the grant; neither alone
  makes the app work.
- **P3.** Handshake: the shim retries ~5 times over ~4 seconds and queues early
  `callTool`s. With no host, every call rejects with `"no host"`. Error
  semantics miniapps MUST handle: `-32601` undeclared capability, `-32001`
  consent refused, `"no host"` absent host.
- **P4.** Tool results stream as spec-shaped `CallToolResult` frames;
  `ui/initialize` results are spec-shaped. Conformance is locked by an
  end-to-end wire test proving shim and host agree on `_meta` shapes.
- **P5.** Notification dispatch is by **JSON-RPC method** (e.g.
  `ui/notifications/tool-result`), with `toolName` read from params for
  filtering. Dispatching on `params.toolName` as the subscription key silently
  drops host pushes and is a known shipped bug — MUST NOT be reintroduced.
- **P6.** Handlers MUST be registered before first render; the host may push
  immediately after the handshake.

### 6.2 Data capabilities (`needs`)

| capability | host tool | provides | consent |
| --- | --- | --- | --- |
| `session-data` | `agentgem_get_session_data` | the source session `{ meta, timeline }` | auto-approved |
| `local-project-access` | `agentgem_get_inventory` | viewer's skills/servers/projects (metadata, not artifact bodies) | prompt |
| `live-session-events` | `agentgem_subscribe_sessions` | live coding-session events, streamed | prompt |
| `invoke-agent` | `agentgem_invoke_agent` | one agent turn, transcript streamed | prompt |
| `context-hygiene` | (brokered stream) | live hygiene signals for a user-bound session | prompt |

### 6.3 Action capabilities (derived from `agentgemApp.` method calls)

- `openLink(url)` — host asks the user **every time**, showing the URL.
- `sendMessage` / `updateModelContext` — external chat hosts only; in the
  console and marketplace they reject with "unsupported by this host", and
  miniapps MUST degrade gracefully. Local-only: MUST NOT ship in a published
  miniapp.
- `requestDisplayMode("fullscreen" | "inline")` — the host MAY refuse; its reply
  names the mode actually applied and it pushes fresh `containerDimensions` via
  `ui/notifications/host-context-changed`. Miniapps MUST re-read layout from
  those dimensions.
- `copy-command` (clipboard write) — the first egress capability: consent-gated
  and **never remembered**; every copy re-prompts.

### 6.4 MCP connectors (`mcpNeeds`)

- **P7.** `agentgemApp.mcp.{callTool, listTools}` lets a miniapp use the
  viewer's MCP servers through the host — still with zero network of its own.
- **P8.** Consent is **digest-pinned and fail-closed**: approval is stored as
  `{decision, digest}` over the exact server/tool surface; if the surface
  changes, consent is void and calls fail with `server_config_changed`. An
  unreachable server replies `server_unavailable` rather than hanging. The
  **security boundary is server-side**: the `/api/play/mcp/call` route rejects
  any tool not in the declared `mcpNeeds` manifest (`not_in_manifest`) and
  re-checks the expected config digest — the shim and host router are
  convenience layers, not the gate.
- **P9.** Watches (`mcp/watch`/`mcp/unwatch`) are host-scheduled with coalesced
  polls, epoch/single-flight semantics, and visibility gating; `mcp/invalidate`
  re-polls live watches and never resurrects stopped ones.

### 6.5 Trust model (host-side requirements)

The host MUST NOT trust the frame:

- **T1.** Verify each message came from the current miniapp's frame.
- **T2.** Re-check every call against the declared `needs` at call time.
- **T3.** Ignore any miniapp-supplied `sessionId` for `session-data`; only the
  user rebinds the session (host-initiated feed).
- **T4.** Invalidate the host generation on game switch: replies destined for a
  swapped-out game are dropped.
- **T5.** Permit one live stream and one agent turn at a time.
- **T6.** `invoke-agent` opens a neutral agent turn with edit permission denied
  — it MUST NOT be able to change files or run commands.

## 7. Lifecycle

### 7.1 Compose (seed)

Composer creates a miniapp from one of: **Project**, **Session** (genre
`replay`), **Skill** (`skill-run`), **HTML** import, or **Blank** — optionally
with uploaded files, each marked **Ship** (baked into the bundle, inside the
size cap) or **Reference** (written to gitignored `ref/` for the agent to read,
never shipped). Seed data is baked as the inert `game-data` JSON block,
scrubbed on the way in (§8). Session timelines are capped (≤ 500 turns, text
truncated) to protect the size budget.

### 7.2 Build (Studio)

A coding agent edits the bundle inside
`// ==== AGENTGEM:GAME-LOGIC START/END ====` markers, with the authoring skill
injected into its first turn. The agent is **cwd-jailed**: only a working
directory under the miniapps registry root is honored, so a Studio session
cannot be pointed at arbitrary paths. The live preview renegotiates its host on every
save, so `meta.json` edits take effect at the next Save with no separate reload.
Studio sessions are durable: chat history survives reload and a live agent turn
resumes with progress. Failed gates hand the error back to the agent
("Fix with agent").

### 7.3 Ship (each step explicit, opt-in — invariant I3)

| action | scope | what happens |
| --- | --- | --- |
| **Save** | local | gates → write registry + `meta.json` → git commit → upsert gem |
| **Push to git** | your remote | pushes the whole registry for backup/portability |
| **Share** | chosen visibility | screenshot capture (real running game, for OG card) → publish to the marketplace as Public / Unlisted / Private; existing key confirms overwrite vs new version; signed-out users connect inline and the publish resumes |
| **Request review** | chosen group | stages the game to a team you pick; reviewers play the staged copy in a sealed modal; only an explicit approval publishes |

Published games are addressable at `/games/:key`, searchable by genre/tag, and
play-counted by a public click beacon — the count fires on the click, not the
GET, and the beacon is deliberately the **single** origin-guard-exempt public
write (an inflatable engagement count, never presented as unique people). A
sealed miniapp is intrinsically offline-capable — there is no network to lose —
and advertises that via the `offline` flag in its MCP Apps metadata.

## 8. Privacy

- **V1.** Whatever is baked in the file ships with it. Authoring MUST NOT write
  absolute home paths, usernames, hostnames, or key-shaped strings.
- **V2.** Seed data passes through `redactForBake` (home directory → `~`; known
  token shapes → `‹redacted›`). This is best-effort hygiene; the opt-in shipping
  gates (§7.3) are the actual control.
- **V3.** A gated capability reads the **viewer's** machine, not the author's;
  consent prompts are deliberately blunt. A capability SHOULD be declared only
  when the miniapp is pointless without it.

## 9. Implementation map

The engine is `packages/play` (`@agentgem/play`); the server routes live in
`packages/app` (`@agentgem/app`); the console owns the surfaces. (CI-gated tests
still live in the root `src/__tests__/` and `src/play/__tests__/` trees.)

| area | where |
| --- | --- |
| registry, `saveMiniapp`/`checkpointMiniapp`, gem dual-write, `MiniappMeta` | `packages/play/src/miniapps.ts`, `git.ts` |
| seal gate (`staticGate`/`gameGate`) + jsdom smoke-load | `packages/play/src/gameGate.ts` |
| needs derivation/reconciliation, literal-name check, mcpNeeds merge | `packages/play/src/capabilityScan.ts` |
| portability gate (`assertPortable`) | `packages/play/src/portability.ts` |
| MCP Apps resource/tool minting (`ui://agentgem/<name>`) | `packages/play/src/mcpApp.ts` |
| injected client shim (`window.agentgemApp`) | `packages/play/src/mcpAppClient.ts` |
| MCP connector broker (pooled SDK clients) + config digest | `packages/play/src/mcpConnectors.ts`, `mcpDigest.ts` |
| Studio create seams, cwd jail, seed baking | `packages/play/src/studio.ts`, `sourceContext.ts`, `redact.ts`, `scaffolds.ts` |
| uploads (Ship → `uploads/`, Reference → `ref/`) | `packages/play/src/uploads.ts` |
| share sidecar · genres enum · brief · migration | `packages/play/src/miniappShare.ts`, `genres.ts`, `builderBrief.ts`, `migrate.ts` |
| built-ins: Ember · Protocol Inspector · Repo Pulse | `packages/play/src/ember.ts`, `inspector.ts`, `repoPulse.ts` |
| `GameArtifact`, `McpNeed`, capability unions | `packages/model/src/types.ts` |
| capability ↔ tool/method bijection, `AUTO_CAPS` | `packages/model/src/capabilities.ts` |
| REST routes (`/api/play/*`) + wire schemas | `packages/app/src/play.controller.ts`, `packages/app/src/schemas.ts` |
| play-beacon origin-guard exemption | `packages/app/src/originGuard.ts` |
| trusted host router (dispatch, consent, streams, watches) | `packages/console/src/panels/Play/mcpUiHost.ts` |
| host tool executors | `packages/console/src/panels/Play/mcpHostTools.ts` |
| sealed-iframe player + consent modal + capture | `packages/console/src/panels/Play/Runner.tsx` |
| sealed-doc wrapper (CSP-first, storage/anchor/capture shims) | `packages/console/src/panels/Watch/sandboxDoc.ts` |
| Studio / Arcade / publish flow | `packages/console/src/panels/Play/Studio.tsx`, `Arcade.tsx`, `publishAction.ts` |
| authoring contract (agent-facing) | `skills/agentgem-miniapp/SKILL.md` |

Design history: dated specs and plans under `docs/superpowers/specs/` and
`docs/superpowers/plans/` (see [`evolution.md`](evolution.md) for the map).

## 10. Conformance checklist

For verifying an implementation change (or reviewing a PR) against this spec:

- [ ] Bundle admitted by Save passes S1–S9 (seal, reconciliation, portability).
- [ ] A save with an undeclared tool call fails naming the capability; an unused
      declaration is pruned with notice (S5).
- [ ] Non-literal tool/method names are rejected at Save (S6).
- [ ] The runtime frame is null-origin `allow-scripts` with the §5 CSP (R1).
- [ ] `ui/initialize` advertises exactly the declared needs (P2); undeclared →
      `-32601`, refused consent → `-32001`, no host → `"no host"` (P3).
- [ ] Notifications dispatch by method, not `toolName` (P5).
- [ ] Host enforces T1–T6 (frame check, per-call re-check, user-only rebind,
      generation drop, concurrency caps, read-only invoke-agent).
- [ ] MCP connector consent is digest-pinned and fail-closed (P8).
- [ ] Clipboard egress re-prompts every time (§6.3).
- [ ] No artifact leaves the machine without an explicit user act with a chosen
      scope (I3, §7.3).
- [ ] Any contract change is made in `MINIAPP_BUILDER_BRIEF`
      (`packages/play/src/builderBrief.ts`) and mirrored into
      `skills/agentgem-miniapp/SKILL.md` (drift-guarded).
- [ ] New capability widenings ship with a matching save-time or consent-time
      tightening (see [`evolution.md`](evolution.md), D10).
