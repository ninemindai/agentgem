# Miniapp MCP Connectors — Design

**Date:** 2026-07-16
**Status:** Approved (brainstorm 2026-07-15 → eng review 2026-07-16, 11 findings + 5 cross-model tensions, all resolved)
**Diagram:** `2026-07-15-miniapp-mcp-connectors-architecture.html` (same directory)

## Problem

claude.ai artifacts can now call the viewer's MCP connectors: build a dashboard once, every
viewer's copy pulls live data through their own credentials after a consent prompt. AgentGem
miniapps have the skeleton of this (sealed iframe, capability `needs`, host-brokered tools,
per-gem consent) but can only reach the five built-in host tools — never the viewer's own
MCP servers. This design gives miniapps the same declare → consent → live-data experience,
with `mcp_server` gems as the connector registry.

## Settled decisions

| # | Decision |
|---|----------|
| 1 | Platform capability + demo miniapp (not a UX mock) |
| 2 | Connectors = installed `mcp_server` gems (`McpServerArtifact`) |
| 3 | Any miniapp may declare (marketplace-installed included); viewer consents per server — the claude.ai trust model, not the `invoke-agent` local-only model |
| 4 | Author API mirrors `window.claude.mcp` (`callTool`/`watchTool`/`listTools`/`invalidate`, `result.payload`, coded errors) |
| 5 | Full scope, phased PRs (complexity gate D2: watchTool is the DX being mimicked) |

## Architecture

Runtime call path (①–⑥ in the diagram):

```
sealed iframe                console (trusted host)          core server (localhost)         local processes
┌───────────────────┐  ①    ┌──────────────┐   ③ REST   ┌──────────────────────┐  ⑤   ┌──────────────┐  ⑥
│ window.agentgemApp│──────▶│ mcp/* router │───────────▶│ PlayController        │─────▶│ mcp_server   │────▶ upstream APIs
│   .mcp.{callTool, │ post  │  ② consent   │ /api/play/ │  ④ manifest check     │ SDK  │ gems (stdio/ │ env
│    watchTool,...} │ msg   │  gate        │ mcp/call   │  (server,tool)∈saved  │      │ http/sse)    │ creds
└───────────────────┘  ◀────│ watch        │            │  mcpNeeds             │      └──────────────┘
      ▲ data/error events   │ registry     │            │  mcpConnectors.ts     │
                            └──────────────┘            └──────────────────────┘
```

Two independent security checks by design: the **consent gate** (console, "did the viewer
agree?") and **manifest enforcement** (server, "did the author declare this?") read
different stored facts. A compromised console UI cannot widen a miniapp's reach.

**Trust boundary statement (explicit, per review D13):** consent is a **UX-layer control
in the trusted console, not an API security boundary**. The localhost API trusts local
callers — the house model shared by every play route. Manifest enforcement is the
server-side control. The consent card grants **tool-level** access; inputs to an allowed
tool are not policy-checked (matches the mirrored contract).

## 1. Model (`@agentgem/model`)

- `GameArtifact.mcpNeeds?: { server: string; tools: string[] }[]` beside `needs`.
  `server` = installed `mcp_server` gem name.
- **Envelope canonical home (4A):** `MCP_ERROR_CODES` union (full claude-contract set:
  `server_not_connected`, `server_unavailable`, `not_in_manifest`, `tool_error`,
  `bad_request`, `not_granted`, `capability_disabled`, …) + `derivePayload()`
  (`structuredContent` ?? first text block parsed as JSON ?? verbatim text) exported once.
  Server derives payload; console/shim mirrors are drift-test-pinned (the `consent.ts` ↔
  `CAP_TOOL` pattern).
- One exported Zod schema backs every wire echo of `mcpNeeds` (save, publish, catalog) —
  the #446 lesson, pinned by the capTool drift test.

## 2. Save-time derivation (`packages/play`) — declared-authoritative (D10)

Declared `mcpNeeds` are **authoritative and never pruned**. The `capabilityScan` MCP pass
is assistive only:

- Auto-fills manifest entries from literal `agentgemApp.mcp.callTool("srv", "tool", …)` /
  `watchTool(…)` it can resolve.
- **Warns** (never errors) on `mcp.*` usage it cannot resolve (wrappers, constants,
  dynamic selection) — such calls work at runtime if declared; the server manifest check
  is the real boundary.
- Rationale: derivation-as-gate breaks wrapper-structured apps and the ported-artifact DX;
  pruning what a regex cannot see causes runtime `not_in_manifest`.
- **CRITICAL regression pin:** existing 4-cap `deriveNeeds` behavior unchanged.

## 3. Server (`src/`)

**`src/play/mcpConnectors.ts`** — MCP SDK client manager keyed by gem name:

- **Lifecycle (1A):** per-gem single-flight connect chain (concurrent first calls → one
  spawn); in-flight call counter gates the idle reaper (~5 min); per-call timeout (~30 s).
  stdio spawns use the #424 resolved-PATH helper (Electron bare-PATH trap).
- **Spawn env (2A):** `{ PATH, HOME }` + **only** the gem's `secretRefs`-declared names
  resolved from the local environment. Never `process.env` passthrough (the
  `stdioProxyRunner` precedent does this deliberately-differently). Negative test: an
  undeclared var never reaches the child.
- **Missing secret (D14):** connect fails fast; `server_not_connected` detail names the
  missing variable ("GITHUB_TOKEN not set").
- Transports: stdio (spawn), http, sse — per the gem's `McpServerArtifact.transport`.

**Routes (`PlayController`):**

- `POST /api/play/mcp/call {name, server, tool, input}` — loads the **saved** miniapp,
  rejects `(server, tool)` ∉ `mcpNeeds` (`not_in_manifest`); returns the envelope with
  server-derived `payload`. Error mapping: gem missing → `server_not_connected`;
  connect/timeout → `server_unavailable` (retryable); tool-reported failure →
  `tool_error` (+result).
- `GET /api/play/mcp/servers?name=` — manifest ∩ installed gems, with tools +
  annotations, for `listTools()`.

## 4. Console host (`packages/console` Play)

- **Consent (3A + D9):** per-`(miniapp gem × mcp:<server>)` keys, never auto-granted
  (`AUTO_CAPS` can never contain mcp needs — drift-pinned). The grant records the
  **mcp_server gem's content hash**; on mismatch (gem updated/replaced/shadowed) consent
  clears and the card re-prompts with a "connector changed" note. Card copy names the
  server, its declared tools, and that access is tool-level ("tools, not specific
  queries").
- **Router:** brokers `mcp/*` postMessage; no dispatch path may bypass the consent gate
  (drift test: uncosented call → prompt, never a brokered call).
- **listTools gating (D12):** pre-consent, a declared server lists with `authStatus` and
  an **empty `tools` array** (the contract's pending shape); full inventory after Allow.
- **Watch registry (6A + D11):** ≥30 s poll floor; replay with `cache.storedAt`;
  **per-identity coalescing** (canonical sorted-key input hash — N registrations, one
  flight); pauses when the tab is hidden, catch-up refetch on return; per-frame cap 16;
  teardown on unmount; **rejects tools with wire-explicit `readOnlyHint: false`**
  (contract-fidelity gate against timed side effects). Eager connect fires on consent
  Allow so the cold spawn overlaps UI settling.
- **Shim:** `window.agentgemApp.mcp.{callTool, watchTool, listTools, invalidate}` with the
  claude envelope; embedded error strings drift-pinned to `MCP_ERROR_CODES`.

## 5. Marketplace (`packages/marketplace`)

Display-only: "Uses connectors: <servers>" chip from `mcpNeeds` on cards + player page.
The hosted sealed `GamePlayer` never installs `agentgemApp.mcp` — member absent, miniapps
render their no-connector state (public-artifact parity). Every new `ex-*` class ships
with its `styles.css` rule.

## 6. Demo — Repo Pulse

GitHub dashboard miniapp (open PRs / recently merged / commits via `list_pull_requests`,
`search_pull_requests`, `list_commits`), feature-detecting `agentgemApp.mcp`. Ported from
the claude.ai artifact of the same design — the port itself is the DX acceptance test.

## 7. Testing (5A — 100% traced-path coverage)

- **Root (dist, CI-gated):** connection manager vs fake **slow** stdio server
  (single-flight, in-flight vs reaper); env allowlist negative; **http-transport fixture**
  (in-process SDK server); manifest enforcement; error mapping + payload derivation;
  scan auto-fill/warn behavior; **CRITICAL** deriveNeeds regression pin.
- **Console (jsdom, local):** consent drift test (no fast-path, AUTO_CAPS exclusion,
  empty-tools pre-consent); hash-mismatch re-prompt; **reload persistence**; registry
  replay/floor/teardown/**cap/hidden-pause**/coalescing; **error-event → section
  fallback**; readOnlyHint watch rejection; shim envelope conformance + drift pins.
- **Marketplace:** chip render; degraded player.
- **E2E (verify skill, real browser):** save → Runner → consent Allow → live data in
  sealed iframe — against the **fake connector first** (D14); the GitHub demo is
  acceptance polish, not the platform's first proof.

## Delivery

PR-1 model+schemas → PR-2 server → PR-3 console → PR-4b demo (sequential lane);
PR-4a marketplace chip parallelizable after PR-1 (separate worktree, no shared modules).

## NOT in scope

- **Multi-instance connectors** (two GitHub accounts) → TODOS.md; evolution = additive
  binding hint, claude-contract-compatible. v1 `server_not_connected` copy hints the
  install/rename workaround.
- **Install-time read/action badges** on marketplace cards → TODOS.md (advisory-framing
  caveat).
- **Server-side consent store / per-input tool policy / PR resequencing** — rejected
  (D13): forks the house trust model; the reference contract is also tool-grained.
- **OAuth / `needs_reauth` flows** — env-credential model in v1.

## What already exists (reused)

`consent.ts` grants (extended) · `Runner.serve()`/`mcpHostTools.ts` brokering ·
`capabilityScan.ts` (demoted to assistive) · sealed-frame shim transport (#279/#283) ·
`@modelcontextprotocol/sdk` ^1.29 (no new deps) · #424 resolved-PATH helper ·
`PLAY_CAPS` drift-test pattern (#446).

## Known residual risks (accepted, documented)

- Consented read tool + consent-gated `open-link` = exfiltration path (viewer sees both
  prompts).
- Unannotated write tools remain watchable (same residual as the mirrored contract).
- Localhost API callable by any local process (house model; consent is UX-layer — see
  trust boundary statement).

## Review trail

Eng review 2026-07-16 (`/plan-eng-review`): findings 1A/2A/3A/4A/5A/6A; codex outside
voice (15 findings) → accepted D9 hash-pinned consent, D10 declared-authoritative
manifests, D11 readOnlyHint gate, D12 listTools gating, D14 additive notes; held D13
trust model. Implementation tasks:
`~/.gstack/projects/agentgem/tasks-eng-review-20260716-111510.jsonl` (10 tasks).
