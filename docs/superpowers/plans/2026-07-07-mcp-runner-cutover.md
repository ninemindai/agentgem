# PR D — Runner Cutover to MCP Apps Protocol Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development. Checkbox (`- [ ]`) steps.

**Goal:** Cut the miniapp runtime over to the standard `ui/*` protocol: `Runner.tsx` becomes a thin React shell over `createUiHost` (dropping the private `agentgem:request/feed` serve/listener/refs — the transitional duplication PR B introduced is REMOVED here), `scaffolds.ts` emits the new shim so newly-seeded miniapps are born on the new wire (landing atomically with the Runner), and `Runner.test.tsx` is rewritten to the new wire as the **parity gate** — the SAME 13 behaviors, standard vocabulary. **This PR is held for whole-review before merge.**

**Architecture:** `createUiHost` (PR B) owns the protocol + guards + streaming; `Runner` owns only the React UI (iframe/scale/fullscreen/thumbnail, the consent modal, the "Replay yours" picker) and supplies `requestConsent` (remembered consent + thumbnail suppression) and calls `uiHost.feedSessionData` for the host-initiated rebind. Stored miniapps arrive migrated via PR C's on-read backstop; newly-seeded ones use the new scaffold — so no dual protocol exists at runtime.

**Tech Stack:** React + Vitest/jsdom/@testing-library (console, from source); `@agentgem/play` (dist).

## Global Constraints

- **Node >=24.**
- **Console tests from SOURCE:** `pnpm --filter @agentgem/console test -- Runner` (and full `pnpm --filter @agentgem/console test`). **Authoritative typecheck: `pnpm --filter @agentgem/console exec tsc -b --force`** and `pnpm exec tsc -b --force` (root).
- **`@agentgem/play` tests from dist:** `pnpm exec tsc -b && pnpm exec vitest run dist/play/__tests__/<x>.test.js`.
- **Parity is the gate.** Every behavior in `packages/console/src/panels/Play/__tests__/Runner.test.tsx` today must still hold after the rewrite — only the WIRE assertions change (from `agentgem:request`/`agentgem:feed` postMessages to `ui/initialize`/`tools/call`/`ui/notifications/tool-result`). Do NOT drop a behavior.
- Reuse: `createUiHost`/`UiHost`/`UiHostDeps` from `./mcpUiHost.js`; `mcpAppClient`/`MCP_CLIENT_MARKER` from `@agentgem/play`; `getConsent`/`setConsent`/`AUTO_CAPS`/`CAP_LABEL` from `./consent.js`.
- After this PR, `Runner.tsx` no longer references `playSessionDataRoute`/`inventoryRoute`/`fetchSessions`/`openWatchStream`/`openStudioStream` directly for brokering (those live in `mcpHostTools` via the router) — EXCEPT `fetchSessions` for the "Replay yours" picker list (host UI concern) which stays.

---

### Task 1: `scaffolds.ts` — replay scaffold emits the new shim bridge

Make newly-seeded replays speak the new wire (identical to `migrateMiniappHtml`'s output shape), so a fresh seed and the cut-over Runner agree. `sealedTemplate` (project-fun/skill-run) has no bridge — unchanged.

**Files:**
- Modify: `packages/play/src/scaffolds.ts` (`replayScaffold()` — replace the old `agentgem:request/feed` bridge with the `mcpAppClient()`-based bridge: shim in `<head>`, `onNotification` + `callTool("agentgem_get_session_data")` glue, keeping `DATA`/`boot()`/the RPG-duel GAME-LOGIC block + the baked-data-first boot).
- Modify: `packages/play/src/__tests__`? (play tests are at repo root) → Test: `src/play/__tests__/scaffolds.test.ts` (extend existing).

- [ ] **Step 1:** Extend `src/play/__tests__/scaffolds.test.ts`: `scaffoldFor("replay")` now contains `MCP_CLIENT_MARKER`, does NOT contain `"agentgem:request"`, STILL contains `AGENTGEM:GAME-LOGIC` + the duel logic + boots on baked data (the bottom `boot()` remains), and (with a baked timeline injected) passes `gameGate`+`assertPortable(["session-data"])`. Keep the existing scaffold assertions that still hold.
- [ ] **Step 2:** RED — `pnpm exec tsc -b && pnpm exec vitest run dist/play/__tests__/scaffolds.test.js`.
- [ ] **Step 3:** Update `replayScaffold()` to emit the new bridge (mirror `migrate.ts`'s target output). `sealedTemplate` untouched.
- [ ] **Step 4:** GREEN + `pnpm exec tsc -b --force`. Also run `dist/play/__tests__/migrate.test.js` (migrating the NEW scaffold → `"already"`, since it now carries the marker) and fix that migrate test's expectation if it fed the bare scaffold expecting `"migrated"`.
- [ ] **Step 5:** Commit `feat(play): replay scaffold emits the MCP Apps client bridge`.

---

### Task 2: `mcpUiHost.feedSessionData` — host-initiated rebind

The "Replay yours" picker feeds a viewer-picked session. Per PR B's security fix, the miniapp can't choose a session; the HOST calls this with explicit args.

**Files:**
- Modify: `packages/console/src/panels/Play/mcpUiHost.ts` (add `feedSessionData` to `UiHost` + impl)
- Test: `packages/console/src/panels/Play/__tests__/mcpUiHost.test.ts` (append)

- [ ] **Step 1:** Add to the `UiHost` interface: `feedSessionData(sessionId: string, agent: string): void`. Impl: guarded by the existing `feedingRef` single-flight + `gameGen` staleness; calls `getSessionData(deps.apiBase, deps.name, {sessionId, agent})` and pushes `ui/notifications/tool-result` `{toolName:"agentgem_get_session_data", chunk: data}` to `deps.target` (same envelope the shim's `onNotification` consumes → the game re-boots on the picked session).
- [ ] **Step 2:** Test (append to mcpUiHost.test.ts): `feedSessionData("s1","codex")` → `playSessionDataRoute.call` invoked with `{query:{name, sessionId:"s1", agent:"codex"}}` and a `ui/notifications/tool-result` posted to target; a second concurrent call is suppressed by `feedingRef`; a call after `bumpGeneration` no-ops.
- [ ] **Step 3:** RED → implement → GREEN (`pnpm --filter @agentgem/console test -- mcpUiHost`) + `tsc -b --force`.
- [ ] **Step 4:** Commit `feat(play): mcpUiHost.feedSessionData for the host-initiated replay rebind`.

---

### Task 3: `Runner.tsx` cutover + `Runner.test.tsx` parity rewrite

Runner delegates all protocol/brokering to `createUiHost`; keeps only UI + `requestConsent` + picker. Rewrite the test suite to the new wire — the parity gate. **Most delicate task; preserve every behavior.**

**Files:**
- Modify: `packages/console/src/panels/Play/Runner.tsx` (thin shell)
- Modify: `packages/console/src/panels/Play/__tests__/Runner.test.tsx` (rewrite wire assertions; keep behavioral coverage)

**New Runner shape (contract):**
- Refs/state kept: `boxRef`, `iframeRef`, `scale`, `fs`, `pending` (consent modal cap), `pendingResolve` (the Promise resolver for `requestConsent`), `pickerOpen`, `sessions`, `hostRef: useRef<UiHost|null>`.
- `requestConsent(cap): Promise<boolean>` (a stable `useCallback`): if `!interactive` → `false` (thumbnail suppression); else `getConsent(name,cap)`: `"granted"`→`true`, `"denied"`→`false`, `null`→ set `pending=cap`, close picker, return a Promise whose resolver is stored; the modal's Allow/Deny calls `decide(true/false)` which `setConsent(name,cap,...)` + resolves. (AUTO `session-data` never reaches `requestConsent` — the router serves it directly.)
- Effect (deps `[name, apiBase, needs, interactive, requestConsent]`): when `name!=null && apiBase!=null && needs?.length` and `iframeRef.current?.contentWindow` exists → `createUiHost({apiBase, name, needs, interactive, target, requestConsent})`, store in `hostRef`, add a `window` `message` listener delegating to `host.handleMessage`, cleanup removes the listener + `host.dispose()`.
- Game-change (`[name]` effect): `hostRef.current?.bumpGeneration()` (or recreate host); reset `pending`.
- Picker `feedSession(sessionId, agent)`: `hostRef.current?.feedSessionData(sessionId, agent)`; keep `fetchSessions` for the list + `feedingRef` is now inside the host (the picker just calls it). `canRebind`/`openPicker`/picker modal unchanged.
- Scale/fullscreen/thumbnail/`sandboxDoc` iframe: UNCHANGED.
- REMOVE: the old `serve()`, the `agentgem:request` message handler, and refs now owned by the router (`liveOpen`/`invoking`/`chatId`/`chatPromise`/`gameGen`/`feedingRef`, and the direct route imports used only by `serve`).

**Parity mapping — rewrite each existing test to the new wire (keep the behavior):**
| Existing behavior (Runner.test.tsx) | New-wire assertion |
|---|---|
| sealed iframe + scaled viewport | unchanged (DOM assertions) |
| session-data: request → fetch → feed | iframe posts `ui/initialize` then `tools/call {name:"agentgem_get_session_data"}`; assert `playSessionDataRoute.call` with `{query:{name}}` and a `ui/notifications/tool-result`/result posted back |
| ignores undeclared cap | `tools/call` for a tool whose cap ∉ needs → no route call |
| gated cap prompts + Allow feeds + remembers | `tools/call` for `agentgem_get_inventory` → modal shown, `inventoryRoute` not called until Allow; Allow → called + `getConsent` granted |
| Deny records + never feeds | as today, new wire |
| live-session-events streams + idle-retry | `tools/call {agentgem_subscribe_sessions}` → `openWatchStream`; idle path re-subscribes |
| invoke-agent streams transcript | `tools/call {agentgem_invoke_agent,{message}}` → `openStudioStream` → `ui/notifications/tool-result` deltas |
| thumbnail never prompts gated | unchanged intent (interactive=false) |
| Replay-yours picker feeds chosen session | picker click → `feedSessionData` → `playSessionDataRoute.call` with `{name,sessionId,agent}` |
| picker-vs-consent modal precedence | unchanged intent |

(The iframe→host `ui/initialize`/`tools/call` messages are simulated via the `fromIframe` helper, same as today's `agentgem:request`.)

- [ ] **Step 1:** Rewrite `Runner.test.tsx` to the new wire per the mapping (every row preserved). RED against the current (old-wire) Runner.
- [ ] **Step 2:** RED — `pnpm --filter @agentgem/console test -- Runner`.
- [ ] **Step 3:** Rewrite `Runner.tsx` to the thin-shell contract; remove the old serve/listener/refs/imports.
- [ ] **Step 4:** GREEN — `pnpm --filter @agentgem/console test -- Runner`; then full `pnpm --filter @agentgem/console test` + `pnpm --filter @agentgem/console exec tsc -b --force` + `pnpm exec tsc -b --force`.
- [ ] **Step 5:** Commit `feat(play): cut Runner over to the MCP Apps ui/* protocol (drop private bridge)`.

## Whole-review checklist (controller, before the stack merges)
- All 13 parity-checklist behaviors demonstrably preserved (new-wire Runner tests + host tests).
- No `agentgem:request`/`agentgem:feed` string remains in runtime code or scaffolds (`grep`).
- Migration: playing a pre-cutover stored replay yields migrated html (backstop) and works; a freshly-seeded replay uses the new scaffold.
- Full root suite + full console suite green; `tsc -b --force` (root + console) clean.
- Manual live smoke: seed a replay, play it, session-data renders; a gated cap prompts; invoke-agent streams.
