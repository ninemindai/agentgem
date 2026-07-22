# Studio MCP Connector UX — Design

**Date:** 2026-07-21
**Status:** Approved (design), pre-implementation
**Scope:** Gaps 2 + 1 of the MCP-connector Studio UX review. Gaps 3 (connection-status
chip) and 4 (OAuth) are explicitly deferred — see "Deferred".

## Problem

Miniapp MCP connectors shipped as `mcpNeeds` (declared-authoritative connector manifest
→ digest-pinned consent → host-brokered `window.agentgemApp.mcp.*` calls). The runtime
(consent card in `Runner.tsx`, broker in `mcpUiHost.ts`, pool in `mcpConnectors.ts`) is
solid, but the **authoring and disclosure** surfaces in Studio never caught up:

1. **Connectors are invisible after save.** `Studio.tsx:657` renders
   `<CapabilityStrip needs={meta?.needs} pruned={pruned} />` — it passes `needs` (built-in
   host caps) but **not** `mcpNeeds`. The one surface meant to show "what this miniapp
   reaches" omits connectors entirely.
2. **No candidate discovery in authoring.** The Composer has intent-only capability
   *checkboxes* for built-in caps (`Composer.tsx:155`, steering the agent's first build
   prompt via `capPreamble`), but **nothing** for MCP connectors. An author must already
   know a server name and trust the agent to write `agentgemApp.mcp.callTool("github", …)`
   by hand. `introspectConfig().mcpServers` already enumerates installed servers from the
   user's local agent config (`.claude/settings.json`, `.mcp.json`, Codex TOML) — those
   candidates are simply never surfaced.

## Goals

- After save, the CapabilityStrip discloses each declared connector, its tools, and its
  install/reachability state (including the portability warning when a declared connector
  is not installed on this machine).
- In the Composer, the author can browse installed MCP servers as candidates, expand one
  to see its tools, and check it to **steer** the build prompt — without the picker ever
  becoming an authority over `mcpNeeds`.

## Non-goals / invariants preserved

- **Single authority (no toggle).** The code is the sole authority over `mcpNeeds`,
  reconciled at save (`deriveMcpNeeds`/`mergeMcpNeeds`, declared-authoritative per D10).
  The picker is **intent** (appends to the build prompt, exactly like `capPreamble`); it
  never writes `meta.json`. The strip is **disclosure**; it has no toggle. Adding either
  would reintroduce the second authority the reconciliation exists to remove
  (`CapabilityStrip.tsx:2-5`).
- **No new consent path.** Runtime consent (digest-pinned `mcp-consent`, the Runner card,
  the `mcp:<server>` gate) is untouched.
- **Secrets never reach the browser.** The candidate route returns redacted artifacts only
  (name + transport + secret *names*), never raw config — mirroring existing
  `introspectConfig({redact:true})` / `McpServerArtifactSchema` redaction.

## Design

### Gap 2 — CapabilityStrip renders `mcpNeeds` (disclosure)

Reuses the **existing** `/api/play/mcp/servers?name=<miniapp>` route unchanged
(`play.controller.ts:250-268`, console client `playMcpServersRoute` at `routes.ts:1151`).
That route already returns, per *declared* connector, `{ server, tools[], configDigest? }`,
and its shape distinguishes three states for free:

| Response shape | Meaning | Strip rendering |
| --- | --- | --- |
| `configDigest` present, `tools` non-empty | installed & reachable | `server → tool, tool, …` |
| `configDigest` present, `tools` empty | installed but unreachable | "couldn't connect to `server`" |
| `configDigest` absent | not installed on this machine | `⚠ connector not installed here` (portability) |

- `Studio.tsx` fetches `playMcpServersRoute` after load and after each save (SWR-style; a
  connector-less miniapp — `mcpNeeds` empty/absent — skips the fetch), and passes the
  result to `CapabilityStrip`.
- `CapabilityStrip` gains a `connectors?: ConnectorRow[]` prop (`ConnectorRow = { server,
  tools: string[], state: "ready" | "unreachable" | "missing" }`) rendered beneath the
  existing `needs` rows. Existing `needs`/`pruned` behavior is unchanged.
- New CSS rules for the connector rows (`play-caps__mcp`, `play-caps__mcp-tools`,
  `play-caps__mcp--missing`) added in the same change as the classNames.

### Gap 1 — Composer connector picker (intent)

Two new server routes (both GET, both console-facing via new `defineRoute` clients):

- **`GET /api/play/mcp/candidates`** → `{ servers: { server, transport, needsSecret }[] }`.
  Body = `introspectConfig({ redact: true }).mcpServers` mapped to name + transport +
  `needsSecret` (`(secretRefs?.length ?? 0) > 0`). **Cheap: no MCP connect, no tool
  listing, redacted.** New `PlayMcpCandidatesResponseSchema` in `app/src/schemas.ts`.
- **`GET /api/play/mcp/candidate-tools?server=X`** → `{ tools: { name, description? }[] }`.
  Body = `listConnectorTools(X)` — **one live connect, only invoked on expand**; a connect
  failure or unknown server degrades to `{ tools: [] }` (never throws the route). Its
  `tools` array reuses the exact per-tool object shape already defined inside
  `PlayMcpServersResponseSchema` (`{ name, description?, annotations? }`), factored into a
  shared `McpToolSchema` so the two response schemas cannot drift.

Composer UI:

- A new `<fieldset className="play-connectors-pick">` beside the existing capability
  checkboxes (`Composer.tsx:155`). On mount for agent-build tabs, fetch `/candidates`
  (mirrors the existing `useEffect` fetch pattern at `Composer.tsx:91-95`).
- Each candidate is a collapsed row: `server` + transport badge (+ `needs secret` hint).
  Expanding a row fetches `/candidate-tools?server` **once** (cached in local state) and
  displays the tool names **read-only** — no per-tool checkboxes (selection is
  server-level; tool checkboxes would drift toward control).
- Checking a server adds it to a `connectors: string[]` state set (parallel to the existing
  `caps` state).

### Prompt wiring (intent, not authority)

A `connectorPreamble(servers: string[]): string` mirrors `capPreamble` (`Composer.tsx:34`)
and rides the **same `onCreated(name, preamble)` seam** — no new plumbing. Emitted text:

```
This miniapp should use these MCP connectors — for each, call its tools via
`window.agentgemApp.mcp.callTool(server, tool)` and add the server to `"mcpNeeds"` in
meta.json:
- github
- linear
```

Applied on exactly the tabs where `capPreamble` is applied today
(`Composer.tsx:105,131,142`), combined with `capPreamble`/upload preambles — one rule, not
two. The save-time scan + declared-authoritative reconciliation remains the only authority
over `mcpNeeds`; an unchecked-but-used server is auto-declared by the scan, a
checked-but-unused one is simply never written.

### Data flow

- **Picker:** Composer → `/candidates` (cheap list) → expand → `/candidate-tools` (lazy,
  one connect) → check → `connectorPreamble` folded into the build prompt.
- **Strip:** Studio → `/play/mcp/servers?name` (existing) → `CapabilityStrip` renders
  declared connectors + tools + install/reachability state.
- The two paths **share no state** — authoring intent and post-save disclosure stay
  decoupled, which is what keeps "intent vs. authority" clean.

## Files changed

**Server (`packages/app`)**
- `src/schemas.ts` — `PlayMcpCandidatesResponseSchema`, `PlayMcpCandidateToolsQuerySchema`,
  `PlayMcpCandidateToolsResponseSchema`.
- `src/play.controller.ts` — `@get("/play/mcp/candidates")`, `@get("/play/mcp/candidate-tools")`.

**Console (`packages/console`)**
- `src/api/routes.ts` — `playMcpCandidatesRoute`, `playMcpCandidateToolsRoute` clients.
- `src/panels/Play/Composer.tsx` — connectors fieldset, `connectors` state, lazy tool
  fetch/expand, `connectorPreamble`, folded into the three `onCreated` call sites.
- `src/panels/Play/CapabilityStrip.tsx` — `connectors` prop + connector rows.
- `src/panels/Play/Studio.tsx` — fetch `playMcpServersRoute` post-load/post-save, derive
  `ConnectorRow[]`, pass to `CapabilityStrip`.
- `src/shell/theme.css` (the single console stylesheet — existing `.play-caps` rules at
  ~L622, `.play-caps-pick` at ~L2486) — add `.play-connectors-pick*` and `.play-caps__mcp*`
  rules adjacent to their siblings.

## Testing

- **CapabilityStrip** (vitest): renders all three connector states (ready / unreachable /
  missing); existing `needs`/`pruned` rows unaffected; renders nothing when no connectors.
- **Composer** (vitest): `/candidates` populates rows; expand triggers exactly one
  `/candidate-tools` fetch and caches it; checking a server yields the correct
  `connectorPreamble`; unchecked → no preamble; preamble composes with `capPreamble`.
- **Routes** (app vitest): `/candidates` output is redacted (no `config`/secret values,
  `needsSecret` reflects `secretRefs`); `/candidate-tools` degrades to `{ tools: [] }` on a
  connect failure / unknown server rather than throwing.
- **CSS enforcement:** grep each new `play-*` className resolves to a rule (per the repo's
  "every className CSS-enforced" rule).
- **Invariant re-checks:** picker writes no `meta.json` (assert `saveMiniapp` untouched by
  the picker path); strip has no toggle; Runner consent path unchanged.

## Deferred

- **Gap 3 — connection-status chip in the picker.** The picker deliberately shows only
  `needsSecret` (cheap). A live `✓ connected / ⚠ needs secret / ✗ unreachable` chip would
  require connecting to every candidate on open (a process per server) or a new status
  endpoint. Out of scope; the strip already surfaces reachability post-save.
- **Gap 4 — OAuth for HTTP/SSE connectors.** `connectTransport` currently creates
  `StreamableHTTPClientTransport`/`SSEClientTransport` with no `authProvider`; auth today is
  static-secret only. OAuth is a three-tier follow-on, not one build:
  1. **Delegate (free, today):** a self-hosted OAuth-handling MCP gateway (e.g.
     Apache-2.0 **OpenConnector**, run locally, credentials behind its own boundary) already
     presents as a standard MCP server — it appears as a candidate in this picker with **zero
     new AgentGem code**; it owns OAuth, AgentGem brokers tool calls as usual.
  2. **Native (OSS):** MCP `authProvider` (OAuth 2.1 + PKCE + dynamic client registration)
     for connecting *directly* to a remote OAuth-protected MCP server with no gateway; token
     stored locally. This is the only tier that needs real AgentGem code + a redirect surface
     + local token storage — and it collides with "config redacted, secrets server-side," so
     it needs its own design pass.
  3. **Hosted (Enterprise):** a managed broker — **Vercel Connect** (requires a Vercel
     runtime + `VERCEL_OIDC_TOKEN`, billed per token request) or **Composio** — layered onto
     the cloud edition, where tokens living off-machine is acceptable. Poor fit for the OSS
     local-first default; clean fit for the hosted edition.
