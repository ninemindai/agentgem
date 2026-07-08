# PR B — MCP Apps Host Runtime Library (inert) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Build the standards-compliant host-side runtime for miniapps — the four capability tools, the JSON-RPC `ui/*` router, and the embedded client shim — as new, fully-tested, **inert** modules (NOT yet wired into `Runner.tsx`; the cutover is PR D).

**Architecture:** Three units. `mcpHostTools.ts` (console) = stateless executors over the existing routes/streams + the `visibility:["app"]` tool descriptors. `mcpUiHost.ts` (console) = a framework-agnostic controller that owns ONE iframe's `postMessage` JSON-RPC endpoint (handshake, per-call-guarded `tools/call` dispatch through a consent hook, `ui/notifications/tool-result` push, `gameGen` staleness + teardown + single-flight guards). `mcpAppClient` (a JS string in `@agentgem/play`) = the shim miniapps embed (boot-on-baked-data, bounded-retry `ui/initialize`, `callTool`, `onNotification`). Faithful extraction of `Runner.serve()` + the message handler onto the standard wire — behavior identical, vocabulary standard.

**Tech Stack:** TypeScript ESM; React only as the eventual host (not in this PR); Vitest + jsdom + @testing-library; `@agentback/client` typed routes.

## Global Constraints

- **Node floor >=24.**
- **Console tests run from SOURCE** (`packages/console` vitest: `environment: jsdom`, `include: src/**/*.test.{ts,tsx}`), via `pnpm --filter @agentgem/console test` — **NOT** compiled dist, **NOT** in root CI. Typecheck separately with `pnpm --filter @agentgem/console exec tsc -b` (or root `pnpm exec tsc -b`).
- **`@agentgem/play` tests run from COMPILED dist** at repo root (`pnpm exec tsc -b && pnpm exec vitest run dist/play/__tests__/<x>.test.js`).
- **Route mocking pattern (console):** `vi.spyOn(playSessionDataRoute, "call").mockResolvedValue(...)` — `@agentback/client` bypasses global fetch, so stub the route's `.call`, not `fetch`. Raw `fetch` calls (`/api/agents`, `/api/chat`) are stubbed with `vi.stubGlobal("fetch", ...)`. See `packages/console/src/panels/Play/__tests__/Runner.test.tsx` for the exact idioms (`fromIframe` helper, etc.).
- **Reuse Phase-1 types:** import `McpUiTool` from `@agentgem/play` (do NOT redefine).
- **Tool names (exact):** `agentgem_get_session_data`, `agentgem_get_inventory`, `agentgem_subscribe_sessions`, `agentgem_invoke_agent`. All `visibility:["app"]`.
- **Streaming notification method (exact):** host→UI `ui/notifications/tool-result` with params `{ toolName: string, chunk: unknown }`.
- **invoke-agent neutral-chat contract (exact, security-critical):** open the chat via `POST /api/chat` with **NO `miniapp` field** (yields `permission:"deny"` read-only). Never send `miniapp`.
- **Transitional duplication is intended:** these modules re-express logic that still lives inline in `Runner.tsx` until the PR D cutover removes the inline copies. Reviewers: do NOT flag duplication-with-Runner as a defect in this PR — it is the stacked-cutover design (spec `docs/superpowers/specs/2026-07-07-miniapp-mcp-host-cutover.md`).
- **Parity source of truth:** `Runner.tsx` behaviors enumerated in the spec's 13-item Parity Checklist. Every executor/guard must match.

---

### Task 1: `mcpHostTools.ts` — capability executors + descriptors

Stateless functions that produce the same host data/streams as `Runner.serve()`, plus the tool descriptors and the capability↔tool-name maps. No per-iframe state here (the router owns guards).

**Files:**
- Create: `packages/console/src/panels/Play/mcpHostTools.ts`
- Test: `packages/console/src/panels/Play/__tests__/mcpHostTools.test.ts`

**Interfaces (Produces):**
```ts
import type { McpUiTool } from "@agentgem/play";
export const CAP_TOOL: Record<string,string>;   // GameCapability → tool name (4 entries)
export const TOOL_CAP: Record<string,string>;    // inverse
export const HOST_TOOLS: McpUiTool[];            // 4 descriptors, visibility:["app"], resourceUri "" (host tools, not a ui resource)
export interface StreamHandle { close(): void }
export async function getSessionData(apiBase: string, name: string, args?: { sessionId?: string; agent?: string }): Promise<{ meta: Record<string,unknown>; timeline: unknown[] }>;
export async function getInventory(apiBase: string): Promise<unknown>;
export async function subscribeSessions(apiBase: string, onEvent: (e: unknown) => void): Promise<{ status: "subscribed"; handle: StreamHandle } | { status: "idle" }>;
export async function openNeutralChat(apiBase: string): Promise<string>;   // agents→/api/chat (no miniapp) → chatId
export function invokeAgent(apiBase: string, chatId: string, message: string, h: { onDelta:(t:string)=>void; onTool:(t:unknown)=>void; onDone:()=>void; onFailed:(e:string)=>void }): StreamHandle;
```

**Implementation contract (match `Runner.serve()` exactly):**
- `getSessionData`: `playSessionDataRoute.call(makeClient(apiBase), { query: { name, ...(args?.sessionId?{sessionId:args.sessionId,agent:args.agent}:{}) } })`. (When `args` present, pass sessionId+agent — the "Replay yours" rebind path.)
- `getInventory`: `inventoryRoute.call(makeClient(apiBase))`.
- `subscribeSessions`: `fetchSessions(apiBase)`; if none → `{status:"idle"}`; else `openWatchStream(apiBase, sessions[0].file, onEvent)` → `{status:"subscribed", handle:{close}}`.
- `openNeutralChat`: `fetch(apiBase+"/api/agents")` → pick `available` else first → `fetch(apiBase+"/api/chat",{POST, body:{agentId}})` (NO miniapp) → `chatId`.
- `invokeAgent`: `openStudioStream(apiBase, chatId, message, {onDelta,onTool: t=>h.onTool(t), onDone: ()=>h.onDone(), onFailed})` → returns the close handle.
- `HOST_TOOLS`: one `McpUiTool` per cap: `{ name: CAP_TOOL[cap], description, inputSchema:{type:"object",properties: <session-data/invoke-agent take optional args, others {}>}, _meta:{ui:{resourceUri:"",visibility:["app"]}} }`.

- [ ] **Step 1: Write the test suite (the behavioral gate)**

Create `packages/console/src/panels/Play/__tests__/mcpHostTools.test.ts` covering:
- `getSessionData("", "g1")` calls `playSessionDataRoute.call` with `{query:{name:"g1"}}` and returns its result; with `args` passes `sessionId`+`agent`.
- `getInventory("")` calls `inventoryRoute.call` and returns its result.
- `subscribeSessions` with a session → `{status:"subscribed"}` and `openWatchStream` called with `sessions[0].file`; forwards events via `onEvent`. With no sessions → `{status:"idle"}` and `openWatchStream` NOT called.
- `openNeutralChat` posts to `/api/chat` with a body that has **no `miniapp` key** (assert `JSON.parse(body).miniapp === undefined`) and returns the chatId; picks the `available` agent.
- `invokeAgent` calls `openStudioStream` with `(apiBase, chatId, message, handlers)` and wires delta/done/failed through.
- `CAP_TOOL`/`TOOL_CAP` are inverse; `HOST_TOOLS` has 4 entries all `visibility:["app"]` with the exact names.

Use the `Runner.test.tsx` mocking idioms (`vi.spyOn(route,"call")`, `vi.spyOn(watchStream,...)`, `vi.spyOn(studioStream,"openStudioStream")`, `vi.stubGlobal("fetch",...)`).

- [ ] **Step 2: Run the tests — RED**
Run: `pnpm --filter @agentgem/console test -- mcpHostTools` → FAIL (module missing).

- [ ] **Step 3: Implement `mcpHostTools.ts` to the contract above.**

- [ ] **Step 4: Run the tests — GREEN**
Run: `pnpm --filter @agentgem/console test -- mcpHostTools` → PASS. Then typecheck: `pnpm --filter @agentgem/console exec tsc -b` → exit 0.

- [ ] **Step 5: Commit**
```bash
git add packages/console/src/panels/Play/mcpHostTools.ts packages/console/src/panels/Play/__tests__/mcpHostTools.test.ts
git commit -m "feat(play): MCP Apps host tools (session-data/inventory/subscribe/invoke)"
```

---

### Task 2: `mcpAppClient` shim + `mcpUiHost` router

The client shim miniapps embed, and the host controller that answers it. Built together because their tests are the two ends of one `postMessage` conversation.

**Files:**
- Create: `packages/play/src/mcpAppClient.ts` (the shim as a JS string constant + a `MCP_CLIENT_VERSION` marker)
- Modify: `packages/play/src/index.ts` (export `mcpAppClient`, `MCP_CLIENT_MARKER`)
- Create: `packages/console/src/panels/Play/mcpUiHost.ts`
- Test: `src/play/__tests__/mcpAppClient.test.ts` (repo-root, dist) and `packages/console/src/panels/Play/__tests__/mcpUiHost.test.ts` (console, jsdom)

**Interfaces (Produces):**
```ts
// packages/play/src/mcpAppClient.ts
export const MCP_CLIENT_MARKER = "agentgem:mcp-app-client";   // detectable substring for migration idempotence
export function mcpAppClient(): string;   // a <script> string: window.agentgemApp = { callTool, onNotification, ready }

// packages/console/src/panels/Play/mcpUiHost.ts
export interface UiHostDeps {                // injected so the router is testable without React
  apiBase: string; name: string; needs: string[]; interactive: boolean;
  target: Window;                            // the iframe.contentWindow to post to / match e.source against
  requestConsent: (cap: string) => Promise<boolean>;   // Runner supplies the modal; AUTO caps bypass (handled in router)
}
export interface UiHost { handleMessage(e: MessageEvent): void; dispose(): void; bumpGeneration(): void; }
export function createUiHost(deps: UiHostDeps): UiHost;
```

**Shim contract (`mcpAppClient()` returns a `<script>` that):**
- installs `window.agentgemApp = { callTool(name,args)→Promise, onNotification(method,cb), ready:boolean }`.
- posts `{ jsonrpc:"2.0", method:"ui/initialize", id }` to `window.parent`, **retrying bounded ~5×/800ms** until it receives the initialize result (defeats the host attach race), then posts `ui/notifications/initialized`.
- `callTool` sends `{jsonrpc:"2.0", id, method:"tools/call", params:{name, arguments:args}}`; resolves on the matching-`id` result.
- listens for `ui/notifications/tool-result` and dispatches `{toolName,chunk}` to `onNotification` subscribers.
- validates inbound `e.source === window.parent`.
- carries the `MCP_CLIENT_MARKER` string (for migration idempotence detection).

**Router contract (`createUiHost` — faithful to `Runner.serve()` + the message handler):**
- `handleMessage`: ignore unless `e.source === deps.target`. Parse JSON-RPC. On `ui/initialize` → reply `{result:{ protocolVersion, tools: HOST_TOOLS.filter(t ∈ needs), hostContext:{} }}`. On `tools/call` → resolve tool→cap; **reject if cap ∉ needs** (per-call guard, mirrors `needs.includes`); AUTO (`session-data`) executes immediately; gated caps → `deps.requestConsent(cap)` (Runner owns remembered-consent + thumbnail suppression via that callback) → if granted execute.
- Execution routes to `mcpHostTools`: one-shot tools reply with the JSON-RPC result; `subscribe`/`invoke` reply with an ack result and push each event via `ui/notifications/tool-result`. Preserve the guards: `liveOpen` (one live stream), `invoking` + `chatId`/`chatPromise` serialization (one invoke turn, one chat-open), `feedingRef` (one session-data rebind feed) — all as router-instance refs.
- `bumpGeneration()` pins a generation; async continuations after a bump no-op and streams close. `dispose()` closes all registered stream handles.

- [ ] **Step 1: Write `mcpAppClient` tests (repo-root dist)** — a jsdom-simulated parent that: responds to `ui/initialize` after a 1-tick delay and asserts the shim RETRIED (attach-race), then `callTool` round-trips a result, and an emitted `ui/notifications/tool-result` reaches an `onNotification` subscriber. Assert `mcpAppClient()` contains `MCP_CLIENT_MARKER`.

- [ ] **Step 2: RED** — `pnpm exec tsc -b && pnpm exec vitest run dist/play/__tests__/mcpAppClient.test.js` → FAIL.

- [ ] **Step 3: Implement `mcpAppClient.ts` + export.**

- [ ] **Step 4: GREEN** (repeat the run) → PASS.

- [ ] **Step 5: Write `mcpUiHost` tests (console, jsdom)** — using two `postMessage`-wired windows (or spies): `ui/initialize` returns only the tools in `needs`; a `tools/call` for a cap ∉ needs is rejected (no executor call); an AUTO `session-data` call executes without `requestConsent`; a gated call calls `requestConsent` and only executes on `true`; a streaming tool pushes `ui/notifications/tool-result`; `bumpGeneration` then a late executor result does NOT post; `dispose` closes stream handles. Reuse the `mcpHostTools` route-spies from Task 1.

- [ ] **Step 6: RED** — `pnpm --filter @agentgem/console test -- mcpUiHost` → FAIL.

- [ ] **Step 7: Implement `mcpUiHost.ts` to the contract.**

- [ ] **Step 8: GREEN + typecheck** — `pnpm --filter @agentgem/console test -- mcpUiHost` → PASS; `pnpm --filter @agentgem/console exec tsc -b` → 0; `pnpm exec tsc -b && pnpm exec vitest run dist/play` → play suite green.

- [ ] **Step 9: Commit**
```bash
git add packages/play/src/mcpAppClient.ts packages/play/src/index.ts src/play/__tests__/mcpAppClient.test.ts packages/console/src/panels/Play/mcpUiHost.ts packages/console/src/panels/Play/__tests__/mcpUiHost.test.ts
git commit -m "feat(play): ui/* JSON-RPC host router + embedded client shim"
```

## Self-review checklist (controller, before PR)
- All 4 executors match `Runner.serve()` data/stream shapes and guards.
- Per-call `cap ∈ needs` + `e.source` enforced in the router (not advertisement-only).
- invoke-agent chat-open sends NO `miniapp` field.
- Shim retries `ui/initialize` (attach-race) and carries `MCP_CLIENT_MARKER`.
- Nothing wired into `Runner.tsx` yet (inert); scaffolds untouched.
