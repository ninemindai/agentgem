# MCP Connectors PR-3a — Console Consent + callTool: Eng-Review Decisions

**Date:** 2026-07-16
**Reviewed via:** `/plan-eng-review` (target: PR-3 console scope, spec §4 + D9/D11/D12)
**Parent spec:** `2026-07-16-miniapp-mcp-connectors-design.md` §4
**Status:** Decisions locked; implementation plan to follow.

PR-3 (console) was split into **PR-3a** (this doc) and **PR-3b** (watch registry).
This captures the architecture decisions that refine spec §4 for PR-3a.

## Scope split (D2)

- **PR-3a:** consent card + D9 hash-pinning, the `mcp/*` postMessage router arm,
  `window.agentgemApp.mcp.callTool` + `listTools`, console client route bindings,
  D12 listTools gating. **No `watchTool`.**
- **PR-3b:** the host-side watch registry (`watchTool`, per-`(server,tool)` keyed
  polling/replay, D11 readOnlyHint gate, hidden-tab pause). Must land before PR-4
  (the Repo Pulse demo needs `watchTool`).

Rationale: isolate the security-critical consent path (3a) from the concurrency-heavy
watch registry (3b) so each gets a focused review. `callTool`-only miniapps work after 3a.

## Verified seam facts (grounding)

- Consent today: `localStorage` key `agentgem:play:consent:${miniapp}:${cap}` = `"granted"|"denied"`;
  `AUTO_CAPS={session-data}` is the only auto-grant (`consent.ts`).
- The single consent gate: `mcpUiHost.handleCall` runs `if (!AUTO_CAPS.has(cap)) await requestConsent(cap)` then dispatches. Prior repo bug `authz-gate-fastpath-bypass` — do not add a parallel gate.
- Shim `mcpAppClient.ts` defines `window.agentgemApp` on a `sendRequest(method, params)` JSON-RPC-over-postMessage helper; streaming caps push via `ui/notifications/tool-result`.
- **The console browser bundle cannot value-import `@agentgem/model`** — its barrel pulls `node:fs/os/path` (verified: `resolveDir`/`atomicWrite`/`binPath`). Only `import type` works. This is why `consent.ts` hand-copies `CAP_TOOL` with a drift test.
- The merged `GET /api/play/mcp/servers` response is `{servers:[{server, tools:[{name,description,annotations}]}]}` — **no digest, no config**. The console never sees a connector's raw config (redacted inventory + tools-only response).
- **No per-mcp_server content hash exists today** (`McpServerArtifact` = `{type,name,transport,config,source?,secretRefs?}`); `canonicalMcpServer` is salted, for ingredient identity, not consent pinning.
- Client route bindings for `/play/mcp/call` and `/play/mcp/servers` **do not exist** in `packages/console/src/api/routes.ts` — PR-3a adds them (mirror `playSaveRoute`).

## Decisions

### D3 — Connector identity digest is server-provided, over the REDACTED config

The console cannot compute a connector-identity hash (it never sees raw config). So the
**server** adds a per-server `configDigest` to the `/play/mcp/servers` response:
`configDigest = sha256(canonical({ transport, config: redactMcpConfig(config).config }))`,
**unsalted**, over the REDACTED config (command / args / url / env-var *names*, no secret
values). Stable across secret rotation; changes on an implementation swap — exactly the D9
shadowing threat.

- Canonicalization MUST be deterministic: sorted object keys, normalized URL, stable arg
  order — else consent churns randomly.
- **Honest naming:** this is *config* pinning, not binary-identity pinning. A same-config
  swap of the underlying binary (symlink / docker tag repoint) is NOT detected. Accepted
  residual: that requires local filesystem/registry write access, which is already full
  compromise of the trusted local surface.
- The unsalted digest stays on the **console↔server** channel; it is **never returned to
  the sealed frame** via `listTools` (avoids handing miniapps a stable fingerprint).

### D4 — Browser-safe `MCP_ERROR_CODES` mirror + drift test

The console cannot value-import `MCP_ERROR_CODES` from `@agentgem/model`. Mirror it in a
browser-safe console module, pinned to the canonical enum by a drift test (the
`capTool.drift.test.ts` precedent). The client route schema and the shim's error branching
both use the mirror. The shim preserves the structured `{code, message, data}` error shape
across postMessage (not just the code string) so clients branch on `code`, not text.

### D5 — Single shared consent gate; D12 gating in the console `mcp/list` handler

- `mcp/call` routes through the **existing** `requestConsent` keyed `mcp:<server>` (no
  parallel consent path). `AUTO_CAPS` can never hold an `mcp:` key.
- **D12:** `mcp/list` uses a **non-prompting** `getConsent` check (listing must never pop a
  prompt) and returns `{server, tools:[]}` until consent is granted, full (declared) tools
  after.
- A drift/guard test asserts every `mcp/*` path hits the gate and `AUTO_CAPS` excludes
  `mcp:` keys.
- **postMessage `source` validation:** the `mcp/*` router arm MUST validate `event.source`
  is the sealed frame's `contentWindow` (so no other window can trigger MCP prompts/calls
  through the trusted host). Explicitly tested.

### D6 — Full jsdom suite in 3a; real-browser E2E rides to PR-4

3a pins every jsdom-testable behavior: consent Allow/Deny, hash-mismatch re-prompt, D12
empty-tools, gate-bypass drift, reload persistence, error branching, postMessage source
validation, fail-closed legacy-key migration. The real-browser consent→data E2E rides to
PR-4 (needs a real connector; PR-4's Repo Pulse demo + verify-skill walk covers the Allow
path end-to-end). No throwaway fake-connector browser harness in 3a.

### D7 — Enforce the digest at `/call` (close the TOCTOU) [cross-model]

Console-side pinning alone is a UX signal with a time-of-check/time-of-use hole: the viewer
consents to digest A, then the gem's config changes (or the pooled connection is stale)
before a call. So:

- `POST /api/play/mcp/call` gains an optional `expectedConfigDigest`. The server computes
  the live connector's current digest and **rejects before executing** if they differ
  (coded error — reuse `needs_reauth`, or add a dedicated `server_config_changed`).
- A connector config change **invalidates the pooled connection** so a stale client can't
  answer with old config. (Small additive touch to PR-2's merged `/call` + connection
  manager, riding in PR-3a.)
- This makes D9 server-enforced, consistent with "manifest is the boundary, consent is UX."

### D8 — Consent read model [cross-model]

- `mcp/list` uses non-prompting `getConsent`; `mcp/call` prompts via `requestConsent`.
- Consent value becomes `{decision, digest}` (not a bare string). A digest mismatch means
  "no decision for this digest" → re-prompt **regardless** of a prior `granted`/`denied` (a
  swapped implementation deserves a fresh yes/no).
- `listTools` returns the miniapp's **declared** tools (`mcpNeeds` ∩ connector tools), not
  every connector tool — the app never sees tools the server would reject.
- Each `/servers` server entry carries an explicit `status`:
  `"needsConsent" | "granted" | "denied" | "unavailable"`, so an empty tool list is never
  ambiguous.
- **Fail-closed migration:** a legacy bare-string consent key (or any malformed value)
  never counts as a digest-pinned grant — the reader treats it as "no decision." Tested.

## NOT in scope (PR-3a)

- **`watchTool` + the watch registry + D11 readOnlyHint gate** → PR-3b.
- **Real-browser E2E** → PR-4 (D6).
- **`invalidate`** as a shim method → PR-3b (belongs with the watch/cache machinery). 3a
  does **not** cache `listTools`; each call re-checks, so there is nothing to invalidate yet.
- **Multi-instance connectors, install-time read/action badges** → TODOS.md (deferred earlier).
- **Marketplace chip + Repo Pulse demo** → PR-4.

## What already exists (reused, not rebuilt)

- `consent.ts` `getConsent`/`setConsent` + the `key(name,cap)` scheme (extended to carry the digest).
- `mcpUiHost.handleCall` consent gate + `requestConsent` callback (the one enforcement point).
- `mcpAppClient.ts` `sendRequest` plumbing (the `mcp/*` methods ride it — new JSON-RPC methods, handshake-gated queue inherited).
- The `ui/notifications/tool-result` postMessage channel (relevant to 3b, not 3a).
- `playSaveRoute`/`playSessionDataRoute` client-binding pattern (`api/routes.ts`).
- `capTool.drift.test.ts` (the drift-pin pattern for the error-code mirror).
- Server: PR-2's `/play/mcp/call` manifest enforcement + connection manager (extended by D7).

## Failure modes (new codepaths)

| Codepath | Realistic failure | Test? | Error handling | Visible? |
|----------|-------------------|-------|----------------|----------|
| `mcp/call` consent | miniapp calls before consent | yes (Allow/Deny) | prompt, then granted/denied | prompt shown |
| digest mismatch mid-session | gem config swapped after consent | yes (D7 + hash-mismatch) | `/call` rejects, console re-prompts | re-prompt / coded error |
| stale pooled connection | pool built from old config | yes (D7 pool-invalidation) | pool invalidated, reconnect | transparent |
| `mcp/list` pre-consent | app enumerates tools | yes (D12 empty-tools) | empty tools + `needsConsent` status | app renders no-connector state |
| legacy consent key | old bare-string value read | yes (fail-closed migration) | treated as no-decision | re-prompt |
| foreign postMessage | another window posts `mcp/*` | yes (source validation) | ignored (source != frame) | silent (correct) |
| unknown error code | server emits a newer code | drift test guards enum | generic branch on unmapped code | generic message |

No failure mode is both untested AND silent AND unhandled → no critical gap.

## Parallelization

Sequential within 3a (all touch the console Play module + the one consent store); the small
D7 server touch (`/call` digest + pool invalidation) is a separable lane that can land first
or alongside. **Lane A:** D7 server digest + `/servers` `configDigest` + pool invalidation.
**Lane B:** console (consent scheme, `mcp/*` router, shim, client bindings, D12) — depends on
Lane A's `configDigest` field + the `/call` param. Do A, then B. PR-3b is a later lane
entirely.

## GSTACK REVIEW REPORT

| Review | Trigger | Why | Runs | Status | Findings |
|--------|---------|-----|------|--------|----------|
| Eng Review | `/plan-eng-review` | Architecture & tests (required) | 1 | clean | 3 arch + 1 test issues resolved; 2 cross-model tensions adopted; 7 hardening items folded |
| Outside Voice | codex (high) | Independent 2nd opinion | 1 | issues_found → all triaged | 16 raised; 2 adopted as tensions (D7/D8), 7 folded as plan requirements, rest already covered |

- **CODEX:** surfaced the D3/D5 digest-TOCTOU (→ D7 server-enforced digest) and the four-part consent read model (→ D8); both adopted. Folded hardening: postMessage source validation, fail-closed legacy-key migration, deterministic canonical JSON, digest-not-exposed-to-frame, no listTools cache in 3a, structured error shape across postMessage.
- **CROSS-MODEL:** the section review and codex agree the consent path is the crux; codex tightened it from console-UX pinning to a server-enforced digest gate. No disagreement stands unresolved.
- **VERDICT:** ENG CLEARED — ready to write the PR-3a implementation plan.

NO UNRESOLVED DECISIONS
