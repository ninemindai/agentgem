# MCP Connectors PR-3a: Console Consent + callTool Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give sealed miniapps `window.agentgemApp.mcp.callTool` + `listTools`, gated by a per-connector consent card that is pinned to the connector's server-provided config digest and enforced server-side at call time. No `watchTool` (PR-3b).

**Architecture:** The console browser bundle can't value-import `@agentgem/model` (node-tainted barrel), so the MCP error-code set is mirrored + drift-pinned. The connector-identity digest is computed server-side over the *redacted* config, returned on `/play/mcp/servers`, and re-checked at `/play/mcp/call` (closing the console-only-pinning TOCTOU). The console `mcpUiHost` router grows `mcp/call` + `mcp/list` branches that route through the existing single consent gate (keyed `mcp:<server>`, decision stored as `{decision, digest}`), do the D12 empty-tools gating, and call two new typed client routes. The shim's `mcp` arm rides the existing `sendRequest` plumbing and mirrors `window.claude.mcp` (resolve on ok, throw-with-`code` on error).

**Tech Stack:** TypeScript ESM (`.js` suffixes). Server: AgentBack `@post`/`@get`, `@agentgem/base` `redactMcpConfig`, node `crypto`. Console: React + the `@agentback/client` typed routes, vitest + jsdom.

**Spec/decisions:** `docs/superpowers/specs/2026-07-16-mcp-connectors-pr3a-console-decisions.md` (D2–D8). Parent: `2026-07-16-miniapp-mcp-connectors-design.md` §4.

## Global Constraints

- Node >= 24; pnpm. Root suite: `pnpm test` (= `tsc -b && vitest run`). Console tests are NOT in root CI (`ci-skips-console-tests`) — run them locally: `pnpm --filter @agentgem/console test` (vitest+jsdom). A single root test: `tsc -b && pnpm exec vitest run dist/<path>.test.js`.
- Fresh worktree: `pnpm install && pnpm build` once before the first `pnpm test`.
- New source files start with `// Copyright (c) 2026 NineMind, Inc.` + `// SPDX-License-Identifier: MIT`.
- ESM `.js` import suffixes. The console browser bundle may only `import type` from `@agentgem/model` (its barrel pulls `node:fs/os/path`); never value-import it in `packages/console/src`.
- **Security invariants (must hold, tested):**
  - The consent gate is single-path: every `mcp/*` call routes through the same `requestConsent`/`getConsent` used by host tools. `AUTO_CAPS` may never contain an `mcp:` key. (`authz-gate-fastpath-bypass` lesson.)
  - The unsalted `configDigest` is a console↔server value; it is NEVER returned to the sealed frame (no digest in what `listTools`/`mcp.listTools` hands the miniapp).
  - `/play/mcp/call` re-checks the digest server-side and rejects a mismatch BEFORE executing; a config change invalidates the pooled connection.
  - Legacy bare-string consent values fail closed: never counted as a digest-pinned grant.
  - The router's `handleMessage` already validates `e.source === deps.target` (mcpUiHost.ts:212) — the `mcp/*` branches inherit it; a test confirms a foreign-source `mcp/call` is ignored.
- Comments explain *why*/constraints, matching the dense house style.

## Lanes

- **Lane A (Tasks 1–2, model + server):** the error code + digest. Must land first — Lane B consumes the `configDigest` field and the `expectedConfigDigest` param.
- **Lane B (Tasks 3–6, console):** consent store, client bindings, router arm, shim + Runner.
- **Task 7:** sweep + PR.

---

### Task 1: `server_config_changed` code + browser-safe console error mirror

**Files:**
- Modify: `packages/model/src/mcpEnvelope.ts` (add the code to `MCP_ERROR_CODES`)
- Create: `packages/console/src/panels/Play/mcpErrors.ts` (browser-safe mirror)
- Test: `src/__tests__/mcpEnvelope.test.ts` (extend), `packages/console/src/panels/Play/__tests__/mcpErrors.drift.test.ts` (new)

**Interfaces:**
- Produces: `"server_config_changed"` in `MCP_ERROR_CODES` (`@agentgem/model`); `MCP_ERROR_CODES` (a `readonly string[]`) + `type McpErrorCode` from `packages/console/src/panels/Play/mcpErrors.ts` — the console router/shim/client bindings use the mirror.

- [ ] **Step 1: Extend the model test (RED)**

In `src/__tests__/mcpEnvelope.test.ts`, add to the `MCP_ERROR_CODES` membership test's list: `"server_config_changed"`. Run `tsc -b && pnpm exec vitest run dist/__tests__/mcpEnvelope.test.js` → FAIL (code missing).

- [ ] **Step 2: Add the code**

In `packages/model/src/mcpEnvelope.ts`, add `"server_config_changed",` to the `MCP_ERROR_CODES` array (near `needs_reauth`/`selection_required` — it's a re-consent-needed signal). Update the doc comment block to describe it: "the connector's config changed since the caller's consented digest; re-prompt and retry." Re-run → PASS.

- [ ] **Step 3: Write the console mirror + drift test (RED)**

Create `packages/console/src/panels/Play/__tests__/mcpErrors.drift.test.ts` (mirror `capTool.drift.test.ts`):

```typescript
// packages/console/src/panels/Play/__tests__/mcpErrors.drift.test.ts
import { describe, it, expect } from "vitest";
import { MCP_ERROR_CODES as MIRROR } from "../mcpErrors.js";
import { MCP_ERROR_CODES as CANON } from "@agentgem/model";

describe("console MCP_ERROR_CODES mirrors @agentgem/model", () => {
  it("is identical to the canonical union (order included)", () => {
    expect([...MIRROR]).toEqual([...CANON]);
  });
});
```

(The test file CAN value-import `@agentgem/model` — tests run under Node, not the browser bundle. Only `packages/console/src` runtime modules are bundle-constrained.)

Run `pnpm --filter @agentgem/console test -- mcpErrors.drift` → FAIL (module missing).

- [ ] **Step 4: Write the mirror**

Create `packages/console/src/panels/Play/mcpErrors.ts`:

```typescript
// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
// Browser-safe mirror of @agentgem/model's MCP_ERROR_CODES. The console is bundled for the browser
// (scripts/build-console.mjs) and @agentgem/model's barrel pulls node:fs/os/path, so it cannot be
// value-imported here — same reason consent.ts hand-copies CAP_TOOL. Pinned to the canonical union by
// mcpErrors.drift.test.ts. Adding a code upstream (e.g. server_config_changed) fails that test until
// mirrored here.
export const MCP_ERROR_CODES = [
  "needs_reauth", "server_not_connected", "selection_required", "server_not_found",
  "server_unavailable", "not_in_manifest", "blocked_by_policy", "approval_required",
  "tool_error", "bad_request", "cancelled", "rate_limited", "upstream_error",
  "not_granted", "capability_disabled", "capability_removed", "transform_error",
  "server_config_changed",
] as const;
export type McpErrorCode = (typeof MCP_ERROR_CODES)[number];
```

(Copy the EXACT order the model file uses after Step 2 — the drift test compares order. If the model appends `server_config_changed` at the end, match that; if it inserts near `needs_reauth`, match that instead.)

Run both tests → PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/model/src/mcpEnvelope.ts src/__tests__/mcpEnvelope.test.ts packages/console/src/panels/Play/mcpErrors.ts packages/console/src/panels/Play/__tests__/mcpErrors.drift.test.ts
git commit -m "feat(model+console): server_config_changed code + browser-safe MCP_ERROR_CODES mirror (D4)"
```

---

### Task 2: Server — connector config digest on `/servers`, enforced at `/call`

**Files:**
- Create: `packages/play/src/mcpDigest.ts` (the digest helper)
- Modify: `packages/play/src/mcpConnectors.ts` (expose the digest; invalidate pool on config change)
- Modify: `src/schemas.ts` (`configDigest` on servers response; `expectedConfigDigest` on call request)
- Modify: `src/play.controller.ts` (`mcpServers` returns digests; `mcpCall` re-checks the digest)
- Test: `src/play/__tests__/mcpDigest.test.ts` (new), extend `src/__tests__/playMcpCall.test.ts`

**Interfaces:**
- Consumes: `redactMcpConfig` (`@agentgem/base`), `McpServerArtifact`, Task-1 code.
- Produces: `mcpServerConfigDigest(gem: McpServerArtifact): string` from `@agentgem/play`; `configDigest?: string` per server on `PlayMcpServersResponseSchema`; `expectedConfigDigest?: string` on `PlayMcpCallRequestSchema`; `resolveConnectorDigest(server): string | undefined` on the manager (current live digest); pool invalidation when the digest changes. Lane B (Tasks 5) reads `configDigest` and sends `expectedConfigDigest`.

- [ ] **Step 1: Write the digest helper test (RED)**

Create `src/play/__tests__/mcpDigest.test.ts`:

```typescript
// src/play/__tests__/mcpDigest.test.ts
import { describe, it, expect } from "vitest";
import { mcpServerConfigDigest } from "@agentgem/play";

const gem = (config: Record<string, unknown>) => ({ type: "mcp_server" as const, name: "github", transport: "stdio" as const, config, source: "user" });

describe("mcpServerConfigDigest", () => {
  it("is stable across key order (deterministic canonicalization)", () => {
    const a = mcpServerConfigDigest(gem({ command: "gh-mcp", args: ["--x"], env: { A: "1", B: "2" } }));
    const b = mcpServerConfigDigest(gem({ env: { B: "2", A: "1" }, args: ["--x"], command: "gh-mcp" }));
    expect(a).toBe(b);
    expect(a).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it("is STABLE across a secret VALUE change (redacted config)", () => {
    // redactMcpConfig blanks high-entropy values; a rotated token must not change the digest.
    const a = mcpServerConfigDigest(gem({ command: "gh-mcp", env: { GITHUB_TOKEN: "ghp_oldtokenoldtokenoldtoken00" } }));
    const b = mcpServerConfigDigest(gem({ command: "gh-mcp", env: { GITHUB_TOKEN: "ghp_newtokennewtokennewtoken99" } }));
    expect(a).toBe(b);
  });

  it("CHANGES when the implementation (command/args/url) changes", () => {
    const a = mcpServerConfigDigest(gem({ command: "gh-mcp" }));
    const b = mcpServerConfigDigest(gem({ command: "evil-mcp" }));
    expect(a).not.toBe(b);
  });

  it("CHANGES when a declared env var NAME changes (a different secret surface)", () => {
    const a = mcpServerConfigDigest(gem({ command: "x", env: { GITHUB_TOKEN: "aaaaaaaaaaaaaaaaaaaaaaaa" } }));
    const b = mcpServerConfigDigest(gem({ command: "x", env: { OTHER_TOKEN: "aaaaaaaaaaaaaaaaaaaaaaaa" } }));
    expect(a).not.toBe(b);
  });
});
```

Run `tsc -b && pnpm exec vitest run dist/play/__tests__/mcpDigest.test.js` → FAIL (missing export).

- [ ] **Step 2: Write the digest helper**

Create `packages/play/src/mcpDigest.ts`:

```typescript
// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
// Connector-identity digest for consent pinning (spec D3/D7). Over the REDACTED config, so it is:
//   • STABLE across a secret rotation (redactMcpConfig blanks the value; the env var NAME survives) —
//     a new GITHUB_TOKEN must not silently wipe the viewer's consent.
//   • CHANGED when the implementation swaps (command/args/url) or the declared secret surface changes —
//     the D9 shadowing threat: install a different gem under the same name and the digest moves.
// It is config pinning, NOT binary-identity pinning: a same-config repoint of the underlying binary
// (symlink / docker tag) is not detected — that needs local write access, which is already full
// compromise of the trusted local surface. Deterministic canonical JSON (sorted keys) or consent churns.
import { createHash } from "node:crypto";
import { redactMcpConfig } from "@agentgem/base";
import type { McpServerArtifact } from "@agentgem/model";

function canonical(v: unknown): string {
  if (v === null || typeof v !== "object") return JSON.stringify(v ?? null);
  if (Array.isArray(v)) return `[${v.map(canonical).join(",")}]`;
  const keys = Object.keys(v as Record<string, unknown>).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonical((v as Record<string, unknown>)[k])}`).join(",")}}`;
}

export function mcpServerConfigDigest(gem: McpServerArtifact): string {
  const { config } = redactMcpConfig(gem.config);
  const payload = canonical({ transport: gem.transport, config });
  return `sha256:${createHash("sha256").update(payload).digest("hex")}`;
}
```

Export through `@agentgem/play` (`packages/play/src/index.ts`, beside `mcpEnv`/`mcpConnectors`). Run → PASS.

- [ ] **Step 3: Manager — expose current digest + invalidate pool on config change**

In `packages/play/src/mcpConnectors.ts`:
- Add `export function resolveConnectorDigest(server: string): string | undefined { const g = resolveConnectorGem(server); return g ? mcpServerConfigDigest(g) : undefined; }` (import `mcpServerConfigDigest` from `./mcpDigest.js`).
- In `ensureClient(server)`, after resolving the gem and BEFORE returning a pooled client: compute `mcpServerConfigDigest(gem)`; store it on the pool `Entry` (`entry.digest`). If an existing pooled entry's `digest` differs from the freshly-resolved gem's digest, `await closeEntry(server)` first and reconnect — a config change must not answer from a stale client. Add `digest?: string` to the `Entry` interface.
- Export nothing else new; the route reads `resolveConnectorDigest`.

Add a manager test to `src/play/__tests__/mcpConnectors.test.ts`: with the injected reader returning gem-A then gem-B (different command) for the same name, assert the second call reconnects (a fresh spawn) rather than reusing A's client. (Reuse the fake fixture; flip the reader between calls.)

- [ ] **Step 4: Schemas (RED via the route test)**

In `src/schemas.ts`:
- `PlayMcpCallRequestSchema`: add `expectedConfigDigest: z.string().optional(),`.
- `PlayMcpServersResponseSchema` server entry: add `configDigest: z.string().optional(),` (present iff the gem is installed).

- [ ] **Step 5: Extend the route test (RED)**

In `src/__tests__/playMcpCall.test.ts` add:

```typescript
it("returns a configDigest for an installed server", async () => {
  const ctrl = new PlayController();
  await ctrl.save({ body: { name: "pulse", html: mcpHtml(`window.agentgemApp.mcp.callTool("fake","read_thing")`), meta: { ...meta, mcpNeeds: [{ server: "fake", tools: ["read_thing"] }] } } });
  __setConnectorReaderForTest(() => stdioGem("fake"));
  const res = await ctrl.mcpServers({ query: { name: "pulse" } });
  expect(res.servers[0].configDigest).toMatch(/^sha256:/);
});

it("rejects a call whose expectedConfigDigest no longer matches the live connector", async () => {
  const ctrl = new PlayController();
  await ctrl.save({ body: { name: "pulse", html: mcpHtml(`window.agentgemApp.mcp.callTool("fake","read_thing")`), meta: { ...meta, mcpNeeds: [{ server: "fake", tools: ["read_thing"] }] } } });
  __setConnectorReaderForTest(() => stdioGem("fake"));
  const res = await ctrl.mcpCall({ body: { name: "pulse", server: "fake", tool: "read_thing", input: {}, expectedConfigDigest: "sha256:deadbeef" } });
  expect(res.ok).toBe(false);
  expect(res.error?.code).toBe("server_config_changed");
});

it("allows a call whose expectedConfigDigest matches (or is omitted)", async () => {
  const ctrl = new PlayController();
  await ctrl.save({ body: { name: "pulse", html: mcpHtml(`window.agentgemApp.mcp.callTool("fake","read_thing")`), meta: { ...meta, mcpNeeds: [{ server: "fake", tools: ["read_thing"] }] } } });
  __setConnectorReaderForTest(() => stdioGem("fake"));
  const digest = (await ctrl.mcpServers({ query: { name: "pulse" } })).servers[0].configDigest!;
  const res = await ctrl.mcpCall({ body: { name: "pulse", server: "fake", tool: "read_thing", input: { q: 1 }, expectedConfigDigest: digest } });
  expect(res.ok).toBe(true);
  expect(res.payload).toEqual({ echo: { q: 1 } });
});
```

Run `tsc -b && pnpm exec vitest run dist/__tests__/playMcpCall.test.js` → FAIL.

- [ ] **Step 6: Controller — return digests, enforce at call**

In `src/play.controller.ts`:
- `mcpServers`: for each installed server, add `configDigest: resolveConnectorDigest(need.server)` to the returned entry (import `resolveConnectorDigest`). Not-installed servers keep `{server, tools: []}` (no digest).
- `mcpCall`: after the manifest check and BEFORE `callConnectorTool`, if `input.body.expectedConfigDigest` is present, compare it to `resolveConnectorDigest(server)`; on mismatch return `{ ok: false, error: { code: "server_config_changed", message: "connector config changed since consent — re-approve" } }`. (An omitted `expectedConfigDigest` is allowed for non-console callers — the console always sends it.)

Run → PASS. Then the full server-side group: `pnpm exec vitest run dist/play/__tests__/ dist/__tests__/playMcpCall.test.js`.

- [ ] **Step 7: Commit**

```bash
git add packages/play/src/mcpDigest.ts packages/play/src/mcpConnectors.ts packages/play/src/index.ts src/schemas.ts src/play.controller.ts src/play/__tests__/mcpDigest.test.ts src/play/__tests__/mcpConnectors.test.ts src/__tests__/playMcpCall.test.ts
git commit -m "feat(play): connector config digest — on /servers, enforced at /call, pool-invalidating (D3/D7)"
```

---

### Task 3: Console consent store — `{decision, digest}` for `mcp:<server>`, fail-closed legacy

**Files:**
- Modify: `packages/console/src/panels/Play/consent.ts`
- Test: `packages/console/src/panels/Play/__tests__/consent.test.ts` (new)

**Interfaces:**
- Produces: `getMcpConsent(name, server): { decision: "granted" | "denied"; digest: string } | null`, `setMcpConsent(name, server, decision, digest): void`, and `clearMcpConsent(name, server): void` from `consent.ts`. The existing `getConsent`/`setConsent` (bare-string caps) are UNCHANGED. Task 5's router uses all three (`clearMcpConsent` on a `server_config_changed` rejection).

- [ ] **Step 1: Write the test (RED)**

Create `packages/console/src/panels/Play/__tests__/consent.test.ts`:

```typescript
// packages/console/src/panels/Play/__tests__/consent.test.ts
import { describe, it, expect, beforeEach } from "vitest";
import { getMcpConsent, setMcpConsent, getConsent, setConsent } from "../consent.js";

beforeEach(() => localStorage.clear());

describe("mcp consent (digest-pinned)", () => {
  it("stores and reads a {decision, digest} record", () => {
    setMcpConsent("app1", "github", "granted", "sha256:aaa");
    expect(getMcpConsent("app1", "github")).toEqual({ decision: "granted", digest: "sha256:aaa" });
  });

  it("is scoped per (miniapp, server)", () => {
    setMcpConsent("app1", "github", "granted", "sha256:aaa");
    expect(getMcpConsent("app2", "github")).toBeNull();
    expect(getMcpConsent("app1", "slack")).toBeNull();
  });

  it("stores a denial with its digest", () => {
    setMcpConsent("app1", "github", "denied", "sha256:bbb");
    expect(getMcpConsent("app1", "github")).toEqual({ decision: "denied", digest: "sha256:bbb" });
  });

  it("FAILS CLOSED on a legacy bare-string value (never a digest-pinned grant)", () => {
    // Simulate an old-scheme grant written under a colliding key.
    localStorage.setItem("agentgem:play:mcp-consent:app1:github", "granted");
    expect(getMcpConsent("app1", "github")).toBeNull();
  });

  it("FAILS CLOSED on malformed JSON / missing fields", () => {
    localStorage.setItem("agentgem:play:mcp-consent:app1:github", "{not json");
    expect(getMcpConsent("app1", "github")).toBeNull();
    localStorage.setItem("agentgem:play:mcp-consent:app1:slack", JSON.stringify({ decision: "granted" }));
    expect(getMcpConsent("app1", "slack")).toBeNull(); // no digest → not a valid pin
  });

  it("does not collide with the legacy per-cap getConsent scheme", () => {
    setConsent("app1", "local-project-access", "granted");
    expect(getMcpConsent("app1", "local-project-access")).toBeNull();
    expect(getConsent("app1", "local-project-access")).toBe("granted");
  });
});
```

Run `pnpm --filter @agentgem/console test -- consent` → FAIL.

- [ ] **Step 2: Implement**

In `packages/console/src/panels/Play/consent.ts`, add (leave `getConsent`/`setConsent` untouched):

```typescript
// MCP connector consent (spec D8). Distinct key namespace + a {decision, digest} VALUE, not the bare
// "granted"/"denied" string the per-cap scheme uses — the digest pins consent to the connector's
// server-provided config identity so a swapped/shadowed gem (D9) forces a fresh decision. Reads FAIL
// CLOSED: a bare string, malformed JSON, or a missing digest is treated as "no decision", never as a
// grant — a legacy or tampered value can never silently authorize a connector.
type McpDecision = "granted" | "denied";
export interface McpConsent { decision: McpDecision; digest: string }
const mcpKey = (name: string, server: string) => `agentgem:play:mcp-consent:${name}:${server}`;

export function getMcpConsent(name: string, server: string): McpConsent | null {
  try {
    const raw = localStorage.getItem(mcpKey(name, server));
    if (!raw) return null;
    const v = JSON.parse(raw) as unknown;
    if (typeof v !== "object" || v === null) return null;
    const d = (v as { decision?: unknown }).decision;
    const h = (v as { digest?: unknown }).digest;
    if ((d !== "granted" && d !== "denied") || typeof h !== "string" || h.length === 0) return null;
    return { decision: d, digest: h };
  } catch { return null; }
}

export function setMcpConsent(name: string, server: string, decision: McpDecision, digest: string): void {
  try { localStorage.setItem(mcpKey(name, server), JSON.stringify({ decision, digest })); } catch { /* disabled storage */ }
}

// Drop a connector's remembered decision so the next call re-prompts. Called when the server reports
// the connector's config changed out from under a grant (server_config_changed).
export function clearMcpConsent(name: string, server: string): void {
  try { localStorage.removeItem(mcpKey(name, server)); } catch { /* disabled storage */ }
}
```

Add a matching test to `consent.test.ts`:

```typescript
it("clearMcpConsent removes the record so the next read is null", () => {
  setMcpConsent("app1", "github", "granted", "sha256:aaa");
  clearMcpConsent("app1", "github");
  expect(getMcpConsent("app1", "github")).toBeNull();
});
```

(add `clearMcpConsent` to the test's import). Run → PASS.

- [ ] **Step 3: Commit**

```bash
git add packages/console/src/panels/Play/consent.ts packages/console/src/panels/Play/__tests__/consent.test.ts
git commit -m "feat(console): digest-pinned mcp consent store — {decision, digest}, fail-closed (D8)"
```

---

### Task 4: Console client bindings for `/play/mcp/call` + `/play/mcp/servers`

**Files:**
- Modify: `packages/console/src/api/routes.ts`
- Test: covered by Task 5's router test (a binding with no consumer isn't independently meaningful); add a shape assertion here only if the file has a pattern of per-route tests (it does not).

**Interfaces:**
- Consumes: the `McpErrorCode` mirror (Task 1) for the response `error.code`.
- Produces: `playMcpCallRoute`, `playMcpServersRoute` (defineRoute) — Task 5's router calls them via `makeClient(apiBase)`.

- [ ] **Step 1: Add the bindings**

In `packages/console/src/api/routes.ts` (mirror `playSaveRoute`, and the server schemas at `src/schemas.ts`). Import the mirror: `import { MCP_ERROR_CODES } from "../panels/Play/mcpErrors.js";` then:

```typescript
const McpErrorCodeEnum = z.enum(MCP_ERROR_CODES);
export const playMcpCallRoute = defineRoute("POST", "/api/play/mcp/call", {
  body: z.object({ name: z.string(), server: z.string(), tool: z.string(), input: z.unknown().optional(), expectedConfigDigest: z.string().optional() }),
  response: z.object({
    ok: z.boolean(),
    payload: z.unknown().optional(),
    content: z.array(z.unknown()).optional(),
    error: z.object({ code: McpErrorCodeEnum, message: z.string() }).optional(),
  }),
});
export const playMcpServersRoute = defineRoute("GET", "/api/play/mcp/servers", {
  query: z.object({ name: z.string() }),
  response: z.object({
    servers: z.array(z.object({
      server: z.string(),
      configDigest: z.string().optional(),
      tools: z.array(z.object({
        name: z.string(),
        description: z.string().optional(),
        annotations: z.object({ readOnlyHint: z.boolean().optional(), destructiveHint: z.boolean().optional() }).optional(),
      })),
    })),
  }),
});
```

(The console route schema is an independent hand-written mirror of the server schema — the repo's established pattern; the `McpErrorCodeEnum` uses the drift-pinned mirror so it can't diverge from the model silently.)

- [ ] **Step 2: Typecheck + commit**

Run `pnpm --filter @agentgem/console exec tsc --noEmit` (clean). Commit:

```bash
git add packages/console/src/api/routes.ts
git commit -m "feat(console): typed client bindings for /play/mcp/call + /servers"
```

---

### Task 5: Console router — `mcp/call` + `mcp/list` branches in `mcpUiHost.ts`

**Files:**
- Modify: `packages/console/src/panels/Play/mcpUiHost.ts`
- Test: `packages/console/src/panels/Play/__tests__/mcpUiHost.mcp.test.ts` (new)

**Interfaces:**
- Consumes: Task 3 (`getMcpConsent`/`setMcpConsent`), Task 4 (`playMcpCallRoute`/`playMcpServersRoute`), `makeClient`. `deps` gains `mcpNeeds: { server: string; tools: string[] }[]` (Runner supplies it, Task 6).
- Produces: `mcp/call` + `mcp/list` handling; the frame receives the envelope as the JSON-RPC result (Task 6's shim converts to resolve/throw). The router owns the digest-consent DECISION (it has the digest); `requestConsent` stays a dumb modal.

- [ ] **Step 1: Write the router test (RED)**

Create `packages/console/src/panels/Play/__tests__/mcpUiHost.mcp.test.ts`. Mirror `mcpUiHost.test.ts` (a `target = { postMessage: vi.fn() }` fake, `msg(source, data)` helper, `requestConsent = vi.fn(async () => true)`). Mock the two client routes (the file mocks `../../api/routes.js` — check `mcpUiHost.test.ts` for how it stubs network; if it hits a fake fetch, mirror that; simplest is `vi.mock("../mcpHostTools.js")`-style — instead here `vi.mock("../../api/routes.js", ...)` to make `playMcpCallRoute.call`/`playMcpServersRoute.call` return canned envelopes). Tests to cover:

```
- mcp/list before consent → each declared server returns { server, tools: [], status: "needsConsent" }
- mcp/list after a granted+matching-digest consent → returns declared∩connector tools, status "granted"
- mcp/list for a declared server with no installed gem → { server, tools: [], status: "unavailable" }
- mcp/call, no prior consent, requestConsent→true → sets {granted, digest}, calls playMcpCallRoute with expectedConfigDigest=digest, replies the ok envelope
- mcp/call, requestConsent→false → sets {denied, digest}, replies { ok:false, error:{ code:"not_granted" } }, never calls the route
- mcp/call, prior granted + SAME digest → no prompt (requestConsent not called), calls the route
- mcp/call, prior granted but digest CHANGED (servers now reports a new configDigest) → re-prompts
- mcp/call, prior denied + same digest → replies not_granted WITHOUT re-prompting
- mcp/call for a (server,tool) NOT in mcpNeeds → { ok:false, error:{ code:"not_in_manifest" } }, no route call, no prompt
- mcp/call where the route returns server_config_changed → clears cached digest + mcp consent for that server, replies the error
- AUTO_CAPS never contains an mcp: key (guard assertion)
- a foreign-source message (e.source !== target) with method mcp/call is ignored (inherits handleMessage:212)
- the digest is NEVER present in any mcp/list reply payload sent to the frame
```

Run `pnpm --filter @agentgem/console test -- mcpUiHost.mcp` → FAIL.

- [ ] **Step 2: Implement the branches**

In `packages/console/src/panels/Play/mcpUiHost.ts`:
- Import: `getMcpConsent, setMcpConsent` from `./consent.js`; `playMcpCallRoute, playMcpServersRoute` from `../../api/routes.js`; `makeClient` (same source Task-1 host tools use).
- `UiHostDeps` gains `mcpNeeds: { server: string; tools: string[] }[]`.
- Router state: `const mcpDigests = new Map<string, string | undefined>();` (server → last-seen configDigest; `undefined` = not installed). A helper `async function loadServers(): Promise<Map<string, {tools, configDigest}>>` that calls `playMcpServersRoute.call(makeClient(deps.apiBase), { query: { name: deps.name } })`, refreshes `mcpDigests`, returns a map.
- `handleMessage`: add `if (d.method === "mcp/call") { void handleMcpCall(d); return; }` and `if (d.method === "mcp/list") { void handleMcpList(d); return; }` (after the existing `tools/call` branch, before/after the ui/* ones — order doesn't matter, they're exclusive).
- `handleMcpList(d)`: `const gen = generation;` load servers; for each `need` in `deps.mcpNeeds`, compute `status` from the (server) install state + `getMcpConsent(deps.name, need.server)` vs the current `configDigest`:
  - not installed (`configDigest` undefined) → `{ server, tools: [], status: "unavailable" }`
  - installed, no matching-digest grant → `{ server, tools: [], status: consent?.decision === "denied" && consent.digest === digest ? "denied" : "needsConsent" }`
  - installed + granted + matching digest → `{ server, tools: <serverTools ∩ need.tools>, status: "granted" }`
  Reply `{ servers: [...] }`. NEVER include `configDigest` in the reply. `if (stale(gen)) return;` before replying.
- `handleMcpCall(d)`: `const { server, tool, input } = d.params; const gen = generation;`
  1. Manifest fast-reject: if `server`/`tool` not in `deps.mcpNeeds` → `reply(d.id, { ok: false, error: { code: "not_in_manifest", message: ... } })`; return. (Server also enforces; this avoids a round-trip + spurious prompt.)
  2. `await loadServers()`; `const digest = mcpDigests.get(server);` if `digest == null` → `reply(d.id, { ok:false, error:{ code:"server_not_connected", message:... } })`; return.
  3. Consent decision (router owns it — it has the digest): `const c = getMcpConsent(deps.name, server);`
     - if `c?.decision === "granted" && c.digest === digest` → proceed.
     - else if `c?.decision === "denied" && c.digest === digest` → `reply(d.id, { ok:false, error:{ code:"not_granted", message:"consent denied" } })`; return.
     - else → `const ok = await deps.requestConsent("mcp:" + server, mcpDetail(server));` `if (stale(gen)) return;` `setMcpConsent(deps.name, server, ok ? "granted" : "denied", digest);` `if (!ok) { reply(d.id, { ok:false, error:{ code:"not_granted", message:"consent denied" } }); return; }`
  4. `const res = await playMcpCallRoute.call(makeClient(deps.apiBase), { body: { name: deps.name, server, tool, input, expectedConfigDigest: digest } });`
  5. if `!res.ok && res.error?.code === "server_config_changed"` → `mcpDigests.delete(server); clearMcpConsent(deps.name, server);` (Task 3) so the next call re-prompts against the new digest; reply the error envelope (don't auto-loop).
  6. else `reply(d.id, res);` (`if (stale(gen)) return;` before replying).
- `mcpDetail(server)`: build the consent-card detail string from `deps.mcpNeeds` — e.g. `"github (tools: list_pull_requests, list_commits)"`. The Runner's modal renders it (Task 6).
- `bumpGeneration`: clear `mcpDigests`.
- Import `clearMcpConsent` (Task 3) alongside `getMcpConsent`/`setMcpConsent`.

- [ ] **Step 3: Green + commit**

Run `pnpm --filter @agentgem/console test -- mcpUiHost` → PASS (new + existing router tests). Commit:

```bash
git add packages/console/src/panels/Play/mcpUiHost.ts packages/console/src/panels/Play/consent.ts packages/console/src/panels/Play/__tests__/
git commit -m "feat(console): mcp/call + mcp/list router — single-gate digest consent, D12 empty-tools, manifest fast-reject (D5/D7/D8)"
```

---

### Task 6: Shim `mcp` arm + Runner wiring + consent-card copy

**Files:**
- Modify: `packages/play/src/mcpAppClient.ts` (the `mcp` arm)
- Modify: `packages/console/src/panels/Play/Runner.tsx` (pass `mcpNeeds`; `requestConsent` mcp branch; modal copy)
- Test: extend `packages/play` shim tests (find where `mcpAppClient` output is asserted) + `Runner.test.tsx`

**Interfaces:**
- Consumes: Task 5's router; the Runner reads the miniapp's `mcpNeeds` from meta (already fetched for `needs`).
- Produces: `window.agentgemApp.mcp.{ callTool, listTools }` in the sealed frame, mirroring `window.claude.mcp` (resolve on ok, throw an `McpError`-shaped `{code, message}` on failure).

- [ ] **Step 1: Shim arm (RED via a shim-output test)**

Find the existing test asserting `mcpAppClient()` output (grep `mcpAppClient` under `src/play/__tests__` / `packages/play`). Add assertions that the emitted script defines `agentgemApp.mcp.callTool` and `agentgemApp.mcp.listTools`. Then in `mcpAppClient.ts`, inside the `api` object, add:

```javascript
    // MCP connectors (spec §4). Mirrors window.claude.mcp: callTool RESOLVES with {payload, content}
    // on success and THROWS an McpError-shaped {code, message} on failure, so a claude.ai artifact ports
    // nearly verbatim. The host router (mcpUiHost) replies with the server ENVELOPE as the JSON-RPC
    // result (never a JSON-RPC error), so the structured code survives the generic resolve path above;
    // this wrapper converts {ok:false, error} into the throw. listTools returns the host's
    // consent-gated {servers:[{server, tools, status}]} verbatim (no digest is ever sent here).
    mcp: {
      callTool: function (server, tool, input) {
        return sendRequest("mcp/call", { server: server, tool: tool, input: input }).then(function (r) {
          if (r && r.ok) return { payload: r.payload, content: r.content };
          var msg = (r && r.error && r.error.message) || "connector call failed";
          var err = new Error(msg);
          err.code = (r && r.error && r.error.code) || "upstream_error";
          throw err;
        });
      },
      listTools: function () { return sendRequest("mcp/list", {}); }
    },
```

Run the shim test → PASS.

- [ ] **Step 2: Runner wiring (RED via Runner.test.tsx)**

In `Runner.test.tsx`, add a test pair mirroring the `live-session-events` consent block (lines ~156–217): a miniapp declaring `mcpNeeds:[{server:"github",tools:["list_pull_requests"]}]` calls `agentgemApp.mcp.callTool("github","list_pull_requests")`; assert the consent modal renders `“{name}” wants to use the github connector` (copy per below) with Allow/Deny, and that Allow leads to the brokered call. (Stub the API client routes as the router test does.)

In `Runner.tsx`:
- Read `mcpNeeds` from the loaded miniapp meta and pass it into `createUiHost({ ..., mcpNeeds })` (alongside `needs`).
- `requestConsent`: add `mcp:` to the "always prompt when asked, never consult the per-cap cache" set (the router already decided a prompt is needed and owns the digest cache): `if (cap !== "open-link" && cap !== "copy-command" && !cap.startsWith("mcp:")) { /* consult getConsent cache */ }`. For an `mcp:` cap, fall through to the modal.
- The consent modal copy: when `pending` starts with `mcp:`, render `“{name}” wants to use the {server} connector` and, from `pendingDetail`, the tool list line (e.g. "Tools: list_pull_requests, list_commits") and a "tool-level access — not specific queries" note (spec D13 copy). `CAP_LABEL` has no mcp entry; branch on the `mcp:` prefix in the render.

- [ ] **Step 3: Green + commit**

Run `pnpm --filter @agentgem/console test -- Runner` and the shim test → PASS. Commit:

```bash
git add packages/play/src/mcpAppClient.ts packages/console/src/panels/Play/Runner.tsx <shim test> packages/console/src/panels/Play/__tests__/Runner.test.tsx
git commit -m "feat(play+console): agentgemApp.mcp.{callTool,listTools} shim arm + connector consent card (D4/D13)"
```

---

### Task 7: Full-suite regression + push + PR

- [ ] **Step 1: Root suite** — `pnpm install && pnpm build` (if not done), then `pnpm test`. Green (flake caveat: real-FS scan tests under concurrency — verify in isolation before judging red). This covers the model + server + play changes.
- [ ] **Step 2: Console suite** — `pnpm --filter @agentgem/console test` (NOT in root CI per `ci-skips-console-tests`; run locally). All green, including the new consent/router/Runner/drift tests and the untouched `capTool.drift`/`mcpUiHost`/`Runner` suites (regression).
- [ ] **Step 3: Typecheck** — `pnpm --filter @agentgem/console exec tsc --noEmit` clean.
- [ ] **Step 4: Push + PR** — `git push -u origin HEAD`; `gh pr create --title "feat: MCP connector console — consent + callTool (PR-3a of 4)" --body ...`. Body: what landed (digest-pinned consent, mcp/* router, shim arm, client bindings, D12), spec §4 + D3-D8 refs, the note that the small server digest change (Lane A) rides in this PR, suite counts, and end with `🤖 Generated with [Claude Code](https://claude.com/claude-code)`. Then `gh run watch <id> --exit-status` before merge.

---

## Out of scope for PR-3a (later)

- **`watchTool` + the watch registry + D11 readOnlyHint gate + `invalidate`** → PR-3b. (3a does not cache `listTools`; each `mcp/list` re-checks — nothing to invalidate yet.)
- **Real-browser E2E** → PR-4 (D6).
- **Marketplace chip + Repo Pulse demo** → PR-4. **Multi-instance connectors, install-time badges, http/sse transport test** → TODOS.md.

## What already exists (reused)

`consent.ts` store + `mcpUiHost` router + its `e.source === target` boundary (mcpUiHost.ts:212) + the single `requestConsent` gate; `mcpAppClient.sendRequest` handshake-gated plumbing; the `ui/notifications` channel; `playSaveRoute` client-binding pattern; `capTool.drift.test.ts` pattern; `mcpUiHost.test.ts`/`Runner.test.tsx` harnesses; PR-2's `/play/mcp/*` routes + connection manager + `redactMcpConfig`.

## Failure modes

See the decisions doc's Failure Modes table — no new codepath is both untested AND silent AND unhandled (each row has a test + a coded error + a visible state). Critical to preserve: the digest re-check (Task 2 step 6) must run BEFORE `callConnectorTool`; the consent decision (Task 5 step 2) must be the router's, keyed on the CURRENT digest.
