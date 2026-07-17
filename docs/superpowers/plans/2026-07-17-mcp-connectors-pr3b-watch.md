# MCP Connectors PR-3b: watchTool + Watch Registry Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Add `window.agentgemApp.mcp.watchTool` + `invalidate` — a host-side poll registry that keeps a sealed miniapp's connector data live, mirroring `window.claude.mcp.watchTool`. Fold in the PR-3a follow-up manager fix.

**Architecture:** The registry lives IN the `mcpUiHost` router as state (keyed by a canonical `server+tool+input` identity), so the router keeps single-ownership of per-frame lifecycle + `bumpGeneration` teardown. The router stays DOM-free: the Runner INJECTS the timing (`schedule`/`clearSchedule`) and a visibility signal, exactly as it injects `openExternal`/`copyText`. Polls reuse the registration-time consent grant non-interactively; error semantics mirror the claude contract (keep-last-good on transient, retract-and-stop on authz/digest-change). D11: watch registration rejects a tool whose `readOnlyHint` is wire-explicitly `false`.

**Tech Stack:** TypeScript ESM; vitest + jsdom (console) and root dist (play/model). No new deps.

**Spec/decisions:** parent spec §4; PR-3a decisions doc (D1–D8); this plan's Decisions & Concurrency Contract below (D1–D2 + the codex outside-voice hardening, all folded).

## Global Constraints

- Node >= 24; pnpm. Root suite `pnpm test`. Console tests NOT in root CI — run `pnpm --filter @agentgem/console test` separately. Fresh worktree: `pnpm install && pnpm build` once first.
- New source files start with the two-line copyright header. ESM `.js` suffixes. Console `packages/console/src` may only `import type` from `@agentgem/model`.
- **The mcpUiHost router MUST stay DOM-free** — no `document`/`window` reference in it. Timing + visibility are injected deps. This is the property that keeps it jsdom-unit-testable.
- Comments explain *why*/constraints, dense house style.

## Decisions & Concurrency Contract (the crux — every task must honor these)

- **D1 — registry home:** registry is router state (a `Map<identity, WatchEntry>`), torn down by the existing `bumpGeneration`. Timing/visibility injected by the Runner (`UiHostDeps.schedule(fn, ms) → cancel`, `deps.isHidden()`/a visibility event). Poll floor ≥30s (clamp).
- **D2 — mid-stream semantics (mirror `window.claude.mcp`):** a poll reuses the registration-time grant **non-interactively** (never re-prompts). On `server_config_changed` (digest swap) OR an authz denial (`needs_reauth`/`not_granted`/`server_not_connected`): **STOP** the watch, emit an `{type:"error"}` event that RETRACTS, and clear that server's stored consent so the next interactive call re-prompts. On a transient error (`server_unavailable`/`tool_error`/`upstream_error`): emit an `{type:"error"}` event but KEEP last-good (don't stop).
- **[codex] Deferred-close reconnect (folds the PR-3a follow-up):** the manager's digest-invalidation reconnect must NOT close the old transport while `inFlight > 0`. Connect the replacement, route new calls to it, and close the old transport only when its own `inFlight` drains to 0.
- **[codex] D11 needs annotations:** `loadServers` currently drops tool annotations (`{name}[]`). Widen it to carry `annotations`. Watch registration **fails closed**: allow a watch only when the tool's `readOnlyHint === true` (a wire-explicit `false`, or absent/unknown, is rejected `bad_request` for watch — a write or unknown-safety tool must not be polled). (callTool is unaffected — the server manifest check governs it.)
- **[codex] Entry epochs + insert-before-await:** create the `WatchEntry` synchronously and store it in the Map BEFORE any `await`. Stamp it with an `epoch` token. Every async continuation (poll result, reschedule, notify, cache write) re-reads `registry.get(identity)` and checks `entry.epoch === capturedEpoch && !stale(gen)` before acting — a late poll for a torn-down/re-registered identity is dropped. (The `new-index-must-join-single-flight` lesson, applied to the registry.)
- **[codex] Per-entry single-flight:** each entry carries `inFlight: boolean`, `dirty: boolean`, `nextAllowedAt: number`. The three triggers (interval tick, visibility catch-up, `invalidate`) never run concurrent `/call`s for one identity: if triggered while `inFlight`, set `dirty` and run exactly ONE follow-up after the current poll completes AND `now >= nextAllowedAt` (the ≥30s floor). A poll slower than the interval cannot overlap itself.
- **[codex] Idempotent synchronous unsubscribe:** `unsubscribe()` removes its watcher from the entry immediately and is idempotent. When an entry's watcher count hits 0, cancel its timer and mark it cancelled; a poll already in flight, when it resolves, drops (no notify, no reschedule) because the entry is gone/cancelled.
- **[codex] Cached-result classes:** store `lastGood` (a successful result) SEPARATELY from `lastTransientError` and `stoppedReason`. Replay-on-register delivers only `lastGood` (never a stale transient error); a new registration on a `stopped` identity requires fresh interactive consent (it isn't silently coalesced into a dead entry).
- **[codex] invalidate doesn't resurrect:** `invalidate(server?, tool?, input?)` drops `lastGood` for matching entries and triggers a re-poll of matching **non-stopped** entries only; it re-checks the stop conditions (consent+digest) before executing and never revives a stopped/revoked entry.
- **[codex] Canonical identity:** `mcpIdentity(server, tool, input)` normalizes `input` to JSON-compatible values, REJECTS unsupported (`BigInt`/`Date`/`function`/`NaN`/`Infinity`/symbol) with `bad_request`, sorts object keys recursively, and keys off the exact normalized body that will be sent to `/call` (so two logically-identical inputs coalesce and the key matches the wire body).
- **Per-frame watch cap 16:** a 17th distinct-identity registration rejects `bad_request`; unsubscribing frees a slot (accounted on the Map size, not a monotonic counter).

## Lanes

- **Lane A (Task 1):** manager deferred-close reconnect — independent, lands first or parallel.
- **Lane B (Tasks 2–7):** the console watch registry + shim + Runner.

---

### Task 1: Manager deferred-close reconnect (fold PR-3a follow-up)

**Files:** Modify `packages/play/src/mcpConnectors.ts`; extend `src/play/__tests__/mcpConnectors.test.ts`.

**Interfaces:** no public API change — internal: the digest-invalidation reconnect no longer closes a transport with `inFlight > 0`.

- [ ] **Step 1 (RED):** Add a test: caller X does a slow `callConnectorTool` (fixture `FAKE_DELAY_MS` high) so `inFlight===1`; while it's in flight, caller Y triggers `ensureClient` with a changed digest (reader returns a new command). Assert X's call still RESOLVES successfully (its transport was not closed under it), and the old transport is closed only after X completes. Run → FAIL (current code closes oldTransport immediately).

- [ ] **Step 2:** In `ensureClient`'s digest-mismatch branch (`mcpConnectors.ts` ~line 119), replace the unconditional `await oldTransport.close()` with: connect the replacement first (`connectTransport`), swap the entry's `client`/`transport`/`digest` to the new one, then close the OLD transport only when the old entry's `inFlight === 0` — if `inFlight > 0`, register a deferred close that fires when the call-completion path (`finally { entry.inFlight-- }`) drops it to 0. Keep the single-flight `connecting` discipline from PR-3a (no `await` before the entry's `connecting` is stored; epoch/identity check on completion). Preserve `__resetConnectorsForTest` (it must close both current and any deferred-old transports).

- [ ] **Step 3 (GREEN):** the new test + the full play group `pnpm exec vitest run dist/play/__tests__/` green, no leaked child process (`ps` check).

- [ ] **Step 4: Commit** `fix(play): reconnect defers old-transport close until inFlight drains (no mid-call transport yank)`

---

### Task 2: `loadServers` keeps annotations + `mcpIdentity` canonical helper

**Files:** Modify `packages/console/src/panels/Play/mcpUiHost.ts` (widen `loadServers`); modify `packages/console/src/api/routes.ts` if the client `/servers` response schema drops annotations (verify — PR-3a's binding kept them, but the router's local narrowing at `loadServers` is what drops them); create `packages/console/src/panels/Play/mcpIdentity.ts`; test `packages/console/src/panels/Play/__tests__/mcpIdentity.test.ts`.

**Interfaces:** Produces `mcpIdentity(server, tool, input): { key: string; body: unknown }` — the canonical registry key + the normalized body to send to `/call` — throwing a tagged error on unsupported input; and `loadServers` now returns per-tool `{ name; annotations?: { readOnlyHint?; destructiveHint? } }`.

- [ ] **Step 1 (RED):** `mcpIdentity.test.ts`:

```typescript
// packages/console/src/panels/Play/__tests__/mcpIdentity.test.ts
import { describe, it, expect } from "vitest";
import { mcpIdentity, McpIdentityError } from "../mcpIdentity.js";

describe("mcpIdentity", () => {
  it("coalesces key-order-different but logically-identical inputs", () => {
    expect(mcpIdentity("gh", "list", { a: 1, b: 2 }).key).toBe(mcpIdentity("gh", "list", { b: 2, a: 1 }).key);
  });
  it("normalizes nested objects recursively (sorted keys), and body is the normalized value", () => {
    const r = mcpIdentity("gh", "list", { z: { y: 1, x: 2 }, a: [3, { d: 4, c: 5 }] });
    expect(r.key).toContain('"a":[3,{"c":5,"d":4}]');       // arrays keep order; object keys sorted
    // body is the normalized value the poll will send to /call — its serialization is stable/sorted
    expect(JSON.stringify(r.body)).toBe('{"a":[3,{"c":5,"d":4}],"z":{"x":2,"y":1}}');
  });
  it("distinguishes different servers/tools/inputs", () => {
    expect(mcpIdentity("gh", "list", {}).key).not.toBe(mcpIdentity("gh", "get", {}).key);
    expect(mcpIdentity("gh", "list", {}).key).not.toBe(mcpIdentity("sl", "list", {}).key);
    expect(mcpIdentity("gh", "list", { a: 1 }).key).not.toBe(mcpIdentity("gh", "list", { a: 2 }).key);
  });
  it("treats undefined/absent input as the same empty call", () => {
    expect(mcpIdentity("gh", "list").key).toBe(mcpIdentity("gh", "list", undefined).key);
  });
  it("REJECTS unsupported values with McpIdentityError", () => {
    for (const bad of [{ d: new Date() }, { n: NaN }, { i: Infinity }, { f: () => 1 }, { b: 10n }] as unknown[]) {
      expect(() => mcpIdentity("gh", "list", bad)).toThrow(McpIdentityError);
    }
  });
});
```

Run `pnpm --filter @agentgem/console test -- mcpIdentity` → FAIL.

- [ ] **Step 2:** Create `mcpIdentity.ts`: a recursive normalizer that accepts only JSON scalars (`string`/`finite number`/`boolean`/`null`), arrays, and plain objects; throws `McpIdentityError` on anything else (`Date`/`function`/`BigInt`/`NaN`/`Infinity`/`symbol`/`undefined`-as-a-value inside an object is dropped like JSON does — but a top-level `undefined` input is the empty call `{}`); sorts object keys; returns `{ body: <normalized>, key: "server:"+server+"|tool:"+tool+"|input:"+JSON.stringify(normalized) }`. The `body` is what Task 4's poll sends to `/call` so the wire body equals what was keyed.

- [ ] **Step 3:** Widen `loadServers` (`mcpUiHost.ts` ~line 221) so its Map value's `tools` is `{ name: string; annotations?: { readOnlyHint?: boolean; destructiveHint?: boolean } }[]` (carry `s.tools` through with annotations intact — don't re-narrow to `{name}`). Confirm the client `/servers` response schema (`api/routes.ts`) already includes `annotations` (PR-3a Task 4 added it) — if not, add it. Existing `handleMcpList`/`handleMcpCall` are unaffected (they read `.name`).

- [ ] **Step 4 (GREEN):** `mcpIdentity` test + the existing `mcpUiHost.mcp` suite (regression — loadServers widening must not break Task 5's tests) green.

- [ ] **Step 5: Commit** `feat(console): mcpIdentity canonical watch key + loadServers keeps tool annotations (D11 prep)`

---

### Task 3: The watch registry + `mcp/watch`/`mcp/unwatch` router branches

**Files:** Modify `packages/console/src/panels/Play/mcpUiHost.ts`; test `packages/console/src/panels/Play/__tests__/mcpUiHost.watch.test.ts`.

**Interfaces:** Consumes Task 2 (`mcpIdentity`, annotated `loadServers`), the existing consent helpers, `playMcpCallRoute`. `UiHostDeps` gains `schedule?: (fn: () => void, ms: number) => () => void` (returns a cancel fn) and `isHidden?: () => boolean` (Runner injects; absent → no polling, replay-only, so the router stays testable without them). Produces `mcp/watch` (register) + `mcp/unwatch` router branches and the poll loop.

The `WatchEntry` shape (router-internal):
```
interface WatchEntry {
  identity: string; epoch: number;         // epoch bumps on teardown/re-register; async work checks it
  server: string; tool: string; body: unknown;
  watchers: Map<number, true>;             // watchId -> present; count 0 => cancel
  lastGood?: { payload: unknown; content: unknown[]; storedAt: number };
  stoppedReason?: string;                  // set on authz/digest stop; a new register can't join a stopped entry
  inFlight: boolean; dirty: boolean; nextAllowedAt: number;
  cancelTimer?: () => void;
}
```

- [ ] **Step 1 (RED):** `mcpUiHost.watch.test.ts` — mirror `mcpUiHost.mcp.test.ts`'s harness (fake `target`, mocked `../../api/routes.js`, `requestConsent`), plus a fake injected `schedule` (a manual clock: capture the `(fn, ms)` and let the test fire it) and `isHidden`. Cover:
  - register (`mcp/watch`) a read tool (annotations `readOnlyHint:true`), consent granted → replies an ack with a `watchId`; the first poll runs `/call` and notifies a `{type:"data"}` event to the frame carrying that `watchId`.
  - **D11:** register a tool with `readOnlyHint:false` → `bad_request`, no poll, no consent prompt. Register a tool with ABSENT annotations → also `bad_request` (fail closed).
  - **coalescing:** two `mcp/watch` for the SAME identity → one poll flight; both watchers get the data event; the reader/`/call` mock is invoked once per tick, not twice.
  - **replay:** a second watcher registering after a poll landed immediately gets the cached `lastGood` (not a fresh `/call`).
  - **replay never delivers a transient error:** after a transient-error poll, a new watcher gets no stale error (only lastGood if any).
  - **single-flight vs overlapping triggers:** fire the interval tick while a poll is in flight → only ONE follow-up `/call` after it completes + floor; a visibility catch-up + an interval tick landing together coalesce to one.
  - **≥30s floor:** the injected `schedule` is called with ms >= 30000; a manual invalidate before the floor still respects `nextAllowedAt`.
  - **hidden pause:** `isHidden()` true → no poll scheduled; on becoming visible (test flips it + fires the visibility hook) → a catch-up poll runs.
  - **D2 stop-and-retract:** a poll returning `server_config_changed` → the watch STOPS, emits `{type:"error"}`, clears that server's mcp consent (`getMcpConsent` now null); an authz denial (`not_granted`) → same stop+retract.
  - **D2 keep-last-good:** a poll returning `server_unavailable`/`tool_error` → emits `{type:"error"}` but the entry stays alive and lastGood is unchanged (a subsequent good poll delivers data again).
  - **idempotent unsubscribe:** `mcp/unwatch` a watchId → removed; unwatching again is a no-op; when the last watcher leaves, the timer is cancelled (assert the injected cancel fn was called) and a poll already in flight, on resolve, does NOT notify.
  - **cap 16:** a 17th distinct-identity register → `bad_request`; unsubscribing one then registering a new identity succeeds.
  - **epoch drop:** register, let a poll start, `bumpGeneration()` mid-poll → on poll resolve, no notify (stale gen); the entry map is cleared.
  - **teardown:** `bumpGeneration` cancels every timer and clears the registry (assert all injected cancel fns fired).
  - **security guards:** a foreign-source `mcp/watch` is ignored (inherits `handleMessage` `e.source===target`); the poll reuses the grant (never calls `requestConsent` after the first register).

Run `pnpm --filter @agentgem/console test -- mcpUiHost.watch` → FAIL (branches missing).

- [ ] **Step 2:** Implement in `mcpUiHost.ts`:
  - `const watches = new Map<string, WatchEntry>();` in the router closure; `let watchIdSeq = 1;`
  - `handleWatch(d)`: parse `{server, tool, input}`; `mcpIdentity(...)` (catch `McpIdentityError` → `bad_request`); manifest fast-reject (server,tool)∉mcpNeeds → reply `bad_request`/`not_in_manifest`; `await loadServers()` (guard rejection like handleMcpCall) → find the tool's `annotations.readOnlyHint`; if `!== true` → `bad_request` (D11 fail-closed); digest = mcpDigests.get(server); undefined → `server_not_connected`. Consent: reuse the router's digest-consent decision (granted+match → proceed; else prompt via `requestConsent("mcp:"+server, mcpDetail(server))` + setMcpConsent). If consent denied → reply error, no watch. Then: if an entry for this identity exists AND is not `stopped` → add a new `watchId` to it, reply the ack `{watchId}`, and if `lastGood` exists deliver a replay data event (microtask, not sync). Else create a fresh `WatchEntry` synchronously (BEFORE any await for the poll), store it, `epoch = ++entryEpochSeq`, add the watchId, reply the ack, and kick the first poll via the single-flight `runPoll(entry)`.
  - `runPoll(entry)`: if `entry.inFlight` → `entry.dirty = true; return`. Set `inFlight=true`; capture `epoch = entry.epoch, gen = generation`. Consent re-check (non-interactive `getMcpConsent`): if not granted+match → stop-and-retract (see below). Call `playMcpCallRoute.call(..., { name, server, tool, input: entry.body, expectedConfigDigest: mcpDigests.get(server) })`. On resolve: if `watches.get(identity)?.epoch !== epoch || stale(gen)` → drop. If `res.ok` → set `lastGood`, clear `lastTransientError`, notify all watchers `{type:"data"}`. Else branch on `res.error.code`: authz/`server_config_changed` → `stopWatch(entry, code)`; transient → notify `{type:"error"}` keep-last-good. Finally: `inFlight=false`; if `dirty` and not stopped → clear `dirty`, schedule an immediate follow-up (respecting `nextAllowedAt`); else schedule the next interval tick (≥30s) via `deps.schedule` unless `deps.isHidden?.()` (then arm the visibility catch-up).
  - `stopWatch(entry, reason)`: set `stoppedReason`; on `server_config_changed`/authz → `clearMcpConsent(name, server)` + `mcpDigests.delete(server)`; cancel timer; notify all watchers `{type:"error", stop:true}` (retract); keep the entry (so late polls drop) but its watchers can unsubscribe.
  - `handleUnwatch(d)`: remove the `watchId` from its entry; if watchers empty → cancel timer, delete the entry (bump nothing — a re-register makes a fresh entry). Idempotent.
  - notify for watches: extend the `notify` shape with a `watchId` in `_meta` so the shim routes to the right handler (a new `_meta["ai.agentgem/watch"] = { watchId, type: "data"|"error" }`), distinct from the existing stream `_meta["ai.agentgem/stream"]`.
  - `bumpGeneration`: for every entry, cancel its timer and (defensively) delete; `watches.clear()`. Also bump `generation` as today so in-flight polls drop.
  - `handleMessage`: add `if (d.method === "mcp/watch") { void handleWatch(d); return; }` and `mcp/unwatch`.
  - Cap: in `handleWatch`, before creating a NEW identity, if `watches.size >= 16` and the identity isn't already present → `bad_request`.

- [ ] **Step 3 (GREEN):** the watch suite green + the existing `mcpUiHost.mcp`/`mcpUiHost` suites green (regression). Typecheck clean.

- [ ] **Step 4: Commit** `feat(console): watch registry — coalesced polls, D11 gate, epoch/single-flight, D2 error semantics (mcp/watch+unwatch)`

---

### Task 4: `mcp/invalidate` router branch

**Files:** Modify `mcpUiHost.ts`; test in `mcpUiHost.watch.test.ts`.

- [ ] **Step 1 (RED):** tests: `mcp/invalidate` with no args drops `lastGood` for all non-stopped entries and triggers exactly one re-poll each (respecting single-flight + floor); `(server)` / `(server,tool)` / `(server,tool,input)` narrow the match (input via `mcpIdentity`); a STOPPED entry is NOT re-executed by invalidate (no resurrection); invalidate re-checks consent/digest before executing (a revoked-consent entry stops rather than refetching).

- [ ] **Step 2:** `handleInvalidate(d)`: compute the match set from `{server?, tool?, input?}` (input → `mcpIdentity` key suffix match); for each matching NON-stopped entry: clear `lastGood`, then `runPoll(entry)` (which itself re-checks consent/digest and single-flights). Reply an ack. Add the `mcp/invalidate` branch to `handleMessage`.

- [ ] **Step 3 (GREEN) + Commit** `feat(console): mcp/invalidate — re-poll matching live watches, never resurrect stopped ones`

---

### Task 5: Shim `mcp.watchTool` + `mcp.invalidate` arm

**Files:** Modify `packages/play/src/mcpAppClient.ts`; extend the shim test.

**Interfaces:** `window.agentgemApp.mcp.watchTool(server, tool, input, handler, opts?)` returns a SYNCHRONOUS `unsubscribe()`; `handler` receives `{type:"data", result}` / `{type:"error", error}` events; `mcp.invalidate(server?, tool?, input?)` returns a promise.

- [ ] **Step 1 (RED):** extend the shim-output test: assert the emitted script defines `agentgemApp.mcp.watchTool` + `agentgemApp.mcp.invalidate`, and (if the harness executes the script) that watchTool registers via `mcp/watch`, routes `_meta["ai.agentgem/watch"]` notifications to the right handler by `watchId`, delivers `{type:"data"}`/`{type:"error"}`, and returns a sync function whose call posts `mcp/unwatch` and stops further handler calls.

- [ ] **Step 2:** In `mcpAppClient.ts`'s `api.mcp`, add (ES5-ish, matching the file):
  - `watchTool(server, tool, input, handler, opts)`: allocate a client-side `watchId` synchronously; send `mcp/watch` (via `sendRequest` — the host ack carries the host's watchId; map client↔host id, or have the host echo the client-suggested id — simplest: the host assigns and returns it in the ack, and the shim keys its handler table on the host id once the ack resolves; buffer any event arriving before the ack under the identity, or have the host NOT emit before the ack resolves). Register `handler` in a `watchSubs` table keyed by host watchId. Return a synchronous `unsubscribe` that marks the local sub dead immediately (so no further handler calls) and fires `mcp/unwatch` (best-effort). Route incoming `ui/notifications/tool-result` whose `_meta["ai.agentgem/watch"]` matches to the handler as `{type, result|error}`.
  - `invalidate(server, tool, input)`: `sendRequest("mcp/invalidate", {server, tool, input})`.
  - IMPORTANT the synchronous-unsubscribe contract: the returned function must exist and neutralize the handler SYNCHRONOUSLY even if the `mcp/watch` ack hasn't resolved yet (buffer the unsubscribe: if called pre-ack, mark it so the ack handler immediately unwatches and never registers the handler).

- [ ] **Step 3 (GREEN) + Commit** `feat(play): agentgemApp.mcp.watchTool + invalidate shim arm (sync unsubscribe, data/error events)`

---

### Task 6: Runner injects `schedule`/visibility + connector-watch wiring

**Files:** Modify `packages/console/src/panels/Play/Runner.tsx`; extend `Runner.test.tsx`.

- [ ] **Step 1 (RED):** a Runner test: a miniapp that `watchTool`s a read connector renders, consents, and receives a data event after the injected clock advances; when the Runner unmounts, the injected timers are cancelled (no post-unmount poll). Mock the routes; drive a fake clock.

- [ ] **Step 2:** In `Runner.tsx`: pass `schedule` (a `setTimeout`-based `(fn, ms) => () => clearTimeout(t)`, tracked so unmount clears all) and `isHidden: () => document.visibilityState === "hidden"` into `createUiHost`, plus wire a `visibilitychange` listener that, on becoming visible, calls a host method to run catch-up polls (add `runVisibilityCatchup()` to the `UiHost` interface, or have the router register the visibility interest via a callback the Runner drives). Ensure `bumpGeneration`/unmount cancels the visibility listener and all timers.

- [ ] **Step 3 (GREEN) + Commit** `feat(console): Runner injects watch scheduler + visibility signal into the host router`

---

### Task 7: Full-suite sweep + push + PR

- [ ] **Step 1:** `pnpm install && pnpm build`; `pnpm test` (root) green (flake-isolation caveat; `ps` shows no stray fake-server). `pnpm --filter @agentgem/console test` green (all new watch/identity tests + regression). `pnpm --filter @agentgem/console exec tsc --noEmit` clean.
- [ ] **Step 2:** `git status --short` clean; `git push -u origin HEAD`.
- [ ] **Step 3:** `gh pr create --title "feat: MCP connector watch registry — watchTool + invalidate (PR-3b of 4)" --body ...`. Body: what landed (host-side coalesced poll registry, D11 read-only gate, D2 keep-last-good/retract semantics, epoch+single-flight concurrency discipline, deferred-close reconnect fix, the shim watchTool/invalidate arm, injected scheduler/visibility), the codex outside-voice hardening it folds, spec refs, suite counts, note PR-4 = marketplace chip + Repo Pulse demo + real-browser E2E, end with `🤖 Generated with [Claude Code](https://claude.com/claude-code)`. `gh run watch <id> --exit-status` before merge.

---

## Out of scope (PR-4)

Marketplace "uses connectors" chip; Repo Pulse demo; real-browser E2E; the deferred http/sse transport test (TODOS). Multi-instance connectors + install-time badges remain TODOs.

## What already exists (reused)

The `mcpUiHost` router + its `generation`/`stale`/`bumpGeneration` lifecycle + the `e.source===target` boundary; the `notify`/`ui/notifications/tool-result` channel (extended with a watch `_meta` tag); `getMcpConsent`/`clearMcpConsent` + the digest-consent decision from PR-3a; `playMcpCallRoute`; the shim `sendRequest` + `onNotification` dispatch; PR-2's connection manager (extended by Task 1); `mcpUiHost.mcp.test.ts`/`Runner.test.tsx` harnesses.

## Failure modes (new codepaths)

| Codepath | Failure | Test | Handling | Visible |
|---|---|---|---|---|
| poll while `inFlight` | overlapping /call | yes (single-flight) | dirty+one-follow-up | transparent |
| poll after unsubscribe | notify a dead handler | yes (idempotent unwatch) | epoch/watcher-count drop | none (correct) |
| digest swap mid-watch | stale connector feeds | yes (D2 stop) | stop+retract+clear consent | error event |
| consent revoked mid-watch | unauthorized data | yes (poll re-check) | stop+retract | error event |
| transient poll error | dashboard wiped | yes (keep-last-good) | error event, keep lastGood | error event, data stays |
| reconnect during in-flight call | transport yank | yes (Task 1) | deferred close | transparent |
| 17th watch | unbounded polls | yes (cap 16) | bad_request | error to app |
| unsupported input | key/throw mismatch | yes (mcpIdentity) | bad_request | error to app |
| bumpGeneration mid-poll | leaked timer / late notify | yes (teardown+epoch) | cancel+drop | none |

No new codepath is untested + silent + unhandled.
