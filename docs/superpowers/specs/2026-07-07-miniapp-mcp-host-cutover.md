# Miniapp MCP-Apps Host Runtime + Cutover — Design Spec

**Status:** design, reviewed (opus design-review incorporated — see "Review fixes" markers).
**Depends on:** Phase 1 producer adapter (PR #204, `packages/play/src/mcpApp.ts`).
**Supersedes at cutover:** the private `agentgem:request` / `agentgem:feed` postMessage bridge.

## Goal & constraints (from Raymond, 2026-07-07)

Make the AgentGem console a **compliant MCP Apps host**: a running miniapp talks to the host over the standard **JSON-RPC `ui/*` + `tools/call`** protocol instead of the private `agentgem:request/feed` messages. Constraints:

1. **Functional parity — no functional loss.** Every behavior the current `Runner.tsx` runtime provides must still work after cutover (Parity Checklist below is the review gate).
2. **No backward compatibility.** Hard cutover — the runtime speaks ONLY the standard protocol afterward. No dual-protocol support.
3. **Migrate the stored/shared miniapps.** Stored miniapps (`~/.agentgem/miniapps/`, their dual-written game gems, and published archives) embed the old private bridge; they must be rewritten to the new client shim so they keep working after cutover.
4. **A few PRs, reviewed as a whole before cutover.** Build the pieces as stacked PRs; hold the parity-critical cutover PR until the whole set is reviewed.

## Current runtime contract (what parity must preserve)

Source of truth: `packages/console/src/panels/Play/Runner.tsx`, `consent.ts`, `../Watch/sandboxDoc.ts`, and the embedded bridge in `packages/play/src/scaffolds.ts`.

**Sandbox** (`sandboxDoc.ts`): single `<iframe sandbox="allow-scripts">` (null origin, no `allow-same-origin`), CSP `default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; img-src data:; font-src data:; media-src data:;`, plus an in-memory `localStorage`/`sessionStorage` shim injected first in `<head>` (null-origin frames throw on storage; storage is therefore ephemeral — games must not rely on persistence, and don't today).

**Private wire protocol** (today):
- iframe → host: `postMessage({ type:"agentgem:request", want:<cap>, message?:<prompt> })`
- host → iframe: `postMessage({ type:"agentgem:feed", channel:<cap>, data:<payload> }, "*")`
- Host honors a request only when `e.source === iframe.contentWindow` (browser-set, unforgeable) AND `want ∈ gem.needs` — **re-checked on every message** (Runner.tsx:111–114).

**Capabilities** (`Runner.serve()`), each preserved:
| cap | consent | host action | delivery |
|---|---|---|---|
| `session-data` | AUTO (own source session) | `playSessionDataRoute.call({query:{name}})` | one feed |
| `local-project-access` | gated | `inventoryRoute.call()` | one feed |
| `live-session-events` | gated | `fetchSessions()` → `openWatchStream(file)` (most-recent="live"); `{type:"idle"}` **and reset `liveOpen`** if none (allows later retry); one stream/game | stream of feeds |
| `invoke-agent` | gated | open neutral chat — `POST /api/chat` **WITHOUT the `miniapp` field** → `permission:"deny"` read-only (Runner.tsx:67–68; `chatSession.ts:38`), serialized via `chatPromise` → `openStudioStream(chatId,message)` | feeds `{kind:delta/tool/done/failed}`; one turn/game (`invoking`) |

**Consent** (`consent.ts`): `AUTO_CAPS={session-data}`; others need remembered per-gem consent (`localStorage["agentgem:play:consent:<name>:<cap>"]` = granted|denied), prompted on first ask via the `pending` modal. **Thumbnails (`interactive=false`) still serve AUTO caps** (session-data) — the AUTO branch runs BEFORE the `!interactive` gate (Runner.tsx:116–117; Arcade thumbs rely on this) — but never prompt/feed GATED caps. `decide()` re-validates `cap ∈ needs`. `CAP_LABEL` copy per cap.

**Other host behaviors** preserved: staleness pinning (`gameGen`); stream teardown on unmount/game-change; single-flight guards `liveOpen` / `invoking` / `chatPromise` **and `feedingRef`** (one Replay-yours feed at a time, Runner.tsx:35,88); the **"Replay yours" picker** (`canRebind` when `needs` includes `session-data` + interactive) → `feedSession(sessionId,agent)` → session-data feed; scale-to-fit; fullscreen button; thumbnail click-through. **`apiBase == null` means "no host" (skip brokering); `apiBase === ""` is a VALID same-origin base** (Runner.tsx:41,109) — the new host wiring must not collapse `""` into "no host" (no `if (!apiBase)`; use `== null`).

**Embedded client bridge** (`scaffolds.ts` replayScaffold — the migration surface, straddling TWO regions OUTSIDE the `AGENTGEM:GAME-LOGIC` markers): the top `message` listener + `requestData()` (lines 92–102) and the bottom 5×/800ms retry loop (167–176). Critically, `boot()` runs unconditionally on **baked** `DATA` first (line 166); it requests fresh data only if the bundle is un-baked (169).

**Offline / published render (parity-critical, corrected from first draft):** `assertPortable` (`portability.ts:15–30`) FORCES any `session-data` miniapp to bake a non-empty `<script id="game-data">` timeline, enforced in `saveMiniapp` (`miniapps.ts:41–42`). So **every published/stored replay renders from baked data with NO host** (the waiting state is only the never-published bare scaffold). The marketplace `GamePlayer` is broker-less and relies on exactly this baked render.

## Target architecture

Keep the **single null-origin sealed iframe** (unchanged `sandboxDoc` CSP + storage shim). Replace ONLY the message vocabulary with JSON-RPC 2.0 `ui/*` over `postMessage`. Rationale: the null-origin iframe + CSP is the trusted security boundary; `postMessage` JSON-RPC works fine null-origin; the spec's double-iframe sandbox-proxy is an isolation upgrade (cross-origin + `allow-same-origin`, which would also swap the ephemeral storage shim for real origin storage) that is orthogonal to parity and to emitting portable resources — deferred (Decision D1).

Three new units:

1. **Host tools** (`mcpHostTools.ts`, console): the capability→tool executors, each a thin wrapper over an existing route/stream, independently testable. Tool names: `agentgem_get_session_data({sessionId?,agent?})`, `agentgem_get_inventory()`, `agentgem_subscribe_sessions()`, `agentgem_invoke_agent({message})`. All `visibility:["app"]`. `agentgem_invoke_agent` keeps the neutral no-`miniapp` `POST /api/chat` contract (permission:deny).

2. **`ui/*` host router** (`mcpUiHost.ts`, console): owns the postMessage JSON-RPC endpoint for one iframe. Handles `ui/initialize`, routes `tools/call` through the consent gate to the host tools, and pushes host→UI `ui/notifications/tool-result` for streaming tools. **Security (per-call, not advertisement):** on EVERY inbound message it validates `e.source === iframe.contentWindow` AND that the called tool is in the `needs`-derived allowlist — rejecting undeclared tools even though `ui/initialize` also advertises the set (advertisement is discovery only). Reuses `gameGen` staleness + teardown + all single-flight guards + consent semantics verbatim.

3. **Client shim** (`mcpAppClient`, a JS string constant in `packages/play`): embedded in scaffolds and injected by migration. Behavior, parity-preserving:
   - **Renders baked data first:** calls the app's render (`boot()`) on any baked `DATA` at startup, independent of the host (reproduces scaffolds.ts:166). The host is a REFRESH, never a prerequisite.
   - **Bounded `ui/initialize` retry:** posts `ui/initialize` and RETRIES (bounded, ~5×/800ms) until a reply or timeout — this defeats the host-listener attach race (Runner adds its listener in a post-mount effect), exactly as the old `requestData()` loop did. A single-shot post would regress.
   - Exposes `callTool(name,args)` → Promise (resolves on the JSON-RPC result) and `onNotification(method, cb)` (for streaming tool results). With no host reply after the bounded retries, it simply stops — the baked render stands (offline/marketplace parity).

### Protocol mapping (old → standard)

| Today (private) | Standard |
|---|---|
| iframe ready | bounded-retry `ui/initialize` → host `McpUiInitializeResult` (advertised tools + hostContext) → `ui/notifications/initialized` |
| `request {want:"session-data"}` | `tools/call {name:"agentgem_get_session_data"}` → result |
| `request {want:"local-project-access"}` | `tools/call {name:"agentgem_get_inventory"}` → result |
| `request {want:"live-session-events"}` | `tools/call {name:"agentgem_subscribe_sessions"}` → result may be `{status:"idle"}` (no session; guard reset so a later call re-subscribes) or `{status:"subscribed"}`; each event → `ui/notifications/tool-result` |
| `request {want:"invoke-agent", message}` | `tools/call {name:"agentgem_invoke_agent", arguments:{message}}` → each delta/tool/done/failed → `ui/notifications/tool-result` |
| `feed {channel,data}` one-shot | the `tools/call` JSON-RPC response |
| `feed {channel,data}` stream | `ui/notifications/tool-result` `{ toolName, chunk }` |
| host "Replay yours" re-feed | host calls `agentgem_get_session_data({sessionId,agent})` and pushes result via `ui/notifications/tool-result` on the session-data tool |
| fullscreen button (host chrome) | KEEP host button (parity); optionally also honor `ui/request-display-mode` (additive, may cut) |

**Resolved ambiguity:** streaming uses `ui/notifications/tool-result` carrying `{ toolName, chunk }` (spec-standard method), NOT a private `agentgem/*` method — shim, host, and tests all key on this.

Consent is unchanged and rides `tools/call`: a gated tool prompts (remembered per gem) before the router executes it; AUTO (`session-data`) executes immediately; thumbnails serve AUTO but never execute gated tools.

## Parity Checklist (review gate — each must be demonstrably preserved)

1. Sealed null-origin iframe + identical CSP + storage shim (ephemeral storage semantics unchanged).
2. All four capabilities produce the same host data/streams as today, incl. the exact `agentgem_invoke_agent` neutral `permission:deny` contract (no `miniapp` field).
3. session-data AUTO; the other three consent-gated + remembered per gem; identical `CAP_LABEL` copy; first-ask modal.
4. Thumbnails (`interactive=false`) **still serve AUTO (session-data)** but never prompt/feed GATED caps.
5. Per-call security: `e.source === iframe` AND tool ∈ `needs`-allowlist enforced on EVERY inbound message (advertisement ≠ boundary).
6. Staleness pinning (`gameGen`): async results after a game change no-op; streams close.
7. Stream teardown on unmount/game-change; single-flight guards `liveOpen` / `invoking` / `chatPromise` / **`feedingRef`**.
8. "Replay yours" picker rebinds session-data with the viewer-picked session (one feed in-flight via `feedingRef`).
9. live-session-events idle-when-no-session with guard reset for later retry; most-recent session = "live".
10. invoke-agent serialized chat-open, one turn at a time, streams delta/tool/done/failed.
11. Scale-to-fit + fullscreen + thumbnail click-through UX unchanged.
12. **Offline/published: the shim `boot()`s on baked `DATA` at startup so published/stored replays render with NO host** (assertPortable guarantees baked data); the host feed only refreshes; the waiting state is only the un-baked bare scaffold. Marketplace GamePlayer stays broker-less and renders baked data — no regression.
13. `apiBase == null` ⇒ no host (skip); `apiBase === ""` ⇒ valid same-origin (broker) — never collapse `""` into "no host".

## Migration design

Only miniapps embedding the private bridge need migration — in practice replay-genre bundles (`needs:["session-data"]`); `project-fun`/imported self-contained bundles have no bridge and are untouched.

- **`migrateMiniappHtml(html): { html, outcome }`** (`packages/play`) where `outcome ∈ {"migrated","already","unrecognized"}` — a **3-state** result (NOT a boolean): detects the old bridge (the `agentgem:feed`/`agentgem:request`/`requestData` boilerplate in the two regions), rewrites it to the `mcpAppClient` shim + a `callTool("agentgem_get_session_data")` + an `onNotification` handler that re-renders (`boot()`), leaving the `AGENTGEM:GAME-LOGIC` block and the baked `<script id="game-data">` untouched. Idempotent (`already` if the shim is present). Returns `unrecognized` (loud, not silent) when the boilerplate was edited beyond recognition, so migration reports it rather than leaving a file silently on the old protocol.
- **`engineVersion` bump lives in the migrate ROUTE, not the HTML codemod** (the codemod has no access to `meta.json`): the route reads `meta`, bumps `engineVersion`, and calls `saveMiniapp` with the migrated html + bumped meta so the dual-written game gem re-syncs and the html re-passes `gameGate`+`assertPortable` (hard gate — migrated html must still validate).
- **Entry point:** `agentgem play migrate` / `POST /api/play/migrate` walks `listMiniapps()`, migrates each in place (git-commit "migrate to MCP Apps client"), and reports per-app outcome (incl. any `unrecognized`).
- **Zero-silent-break backstop:** `readMiniapp`/`playMiniappRoute` applies `migrateMiniappHtml` idempotently on read, so any old-bridge HTML that reached the console by a path the walk missed is migrated at play time (the stored-file migration is then an optimization). Baked data means an un-migrated copy is at worst *degraded* (no live refresh), never blank; the marketplace copy renders fine (broker-less + baked).

## PR decomposition (stacked on #204; cutover held for whole-review)

- **PR #204 — Phase 1 (done):** producer `ui://` resource + tool.
- **PR B — host tools:** `mcpHostTools.ts` (the four `agentgem_*` executors over existing routes/streams + descriptors); unit-tested. No Runner wiring.
- **PR C — protocol layer:** `mcpUiHost.ts` (JSON-RPC `ui/*` router: initialize, per-call-guarded tools/call dispatch through a consent hook, `ui/notifications/tool-result` push, staleness/teardown) + the `mcpAppClient` shim string + shim/router unit tests over a simulated postMessage pair. Not yet wired into Runner. **`scaffolds.ts` NOT touched here.**
- **PR D — migration codemod (inert):** `migrateMiniappHtml` (3-state) + `POST /api/play/migrate` route + on-read backstop; tests incl. old-bridge→migrated round-trip that still passes `gameGate`/`assertPortable`. **Does NOT change `scaffolds.ts`** (see ordering hazard) — purely additive/inert until invoked at cutover.
- **PR E — cutover (held):** rewire `Runner.tsx` to drive `mcpUiHost` + `mcpHostTools`, drop the private `serve`/`agentgem:request` listener; **update `scaffolds.ts` to emit the shim HERE** so the new-shim seed lands atomically with the Runner that understands it; keep consent + picker + scale/fullscreen; run the migration; e2e parity verification against the checklist. Marketplace GamePlayer stays broker-less.

**Ordering hazard (fixed):** the `scaffolds.ts` shim-emit MUST land with the Runner cutover (PR E), NOT in D — otherwise, merged bottom-up, D on `main` would seed new-shim miniapps that the still-old Runner can't answer (stuck `ui/initialize`) while the new shim ignores the old `agentgem:feed`. Keeping scaffold-emit in E closes the window; D stays independently landable and inert.

Git: sequential stacked branches (B off #204 head, C off B, D off C, E off D). Review B–E as a whole; merge bottom-up once approved.

## Decisions

- **D1 — Keep single null-origin iframe; defer the double-iframe sandbox proxy.** The portable contract is the JSON-RPC `ui/*` wire, independent of iframe topology (the producer already emits `ui://` resources with CSP metadata), so deferring blocks nothing. Storage stays the ephemeral shim; the future proxy would swap to real origin storage — harmless while games can't rely on persistence (they can't). *Alt:* build the proxy now — rejected (scope/parity risk).
- **D2 — Streaming over `ui/notifications/tool-result`, not polling.** *Alt:* poll — rejected (loses liveness).
- **D3 — Migration rewrites the bridge in place (codemod), 3-state + on-read backstop**, never re-seed (would clobber authored game-logic). Robustness comes from the 3-state `unrecognized` report + the on-read backstop.
- **D4 — Fullscreen stays a host-chrome button** (parity); additive `ui/request-display-mode` optional.

## Test strategy

- PR B: each `agentgem_*` executor unit-tested against fake routes/streams (data shape, single-flight guards, idle+guard-reset, the no-`miniapp` neutral-chat contract).
- PR C: shim↔router handshake incl. bounded-retry attach-race recovery; tools/call; `ui/notifications/tool-result`; the consent-gate hook fires for gated tools; per-call `e.source`+allowlist rejection; staleness/teardown — over a simulated `postMessage` pair (jsdom).
- PR D: `migrateMiniappHtml` idempotence + `unrecognized` path; a real stored replay bundle migrates, still passes `gameGate`/`assertPortable`, and boots on baked data; on-read backstop.
- PR E: Runner integration test (jsdom) exercising the full 13-item checklist per capability; the existing Play suite stays green; manual live smoke (real session-data feed, real consent prompt, real invoke-agent stream).
