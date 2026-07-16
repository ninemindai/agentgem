# MCP Connectors PR-2: Server Spine Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stand up the server side of miniapp MCP connectors — a live in-process MCP client manager that connects to the viewer's installed `mcp_server` gems, plus the `POST /api/play/mcp/call` and `GET /api/play/mcp/servers` routes with server-side manifest enforcement and the canonical error envelope.

**Architecture:** A new `src/play/mcpConnectors.ts` connection manager keyed by gem name owns pooled MCP SDK `Client` connections (single-flight connect, in-flight-gated idle reaper, per-call timeout, minimal spawn env). Two `PlayController` routes sit in front of it: `call` loads the SAVED miniapp and rejects any `(server, tool)` outside its `mcpNeeds` (the security boundary — PR-1's save-time scan is only assistive), then returns the PR-1 `derivePayload` envelope; `servers` returns the manifest ∩ installed gems for `listTools()`. All errors map onto PR-1's `MCP_ERROR_CODES`.

**Tech Stack:** TypeScript ESM (`.js` suffixes), `@modelcontextprotocol/sdk` ^1.29 client (`Client` + `StdioClientTransport` / `StreamableHTTPClientTransport` / `SSEClientTransport`), `@agentgem/capture` `introspectConfig` for the gem registry, AgentBack `@api`/`@post`/`@get` routes, vitest over compiled `dist/`.

**Spec:** `docs/superpowers/specs/2026-07-16-miniapp-mcp-connectors-design.md` §3, resolutions 1A/2A/D13/D14. PR-1 (merged) provides `McpNeed`, `mcpNeeds` on the saved artifact, `MCP_ERROR_CODES`, `derivePayload`.

## Global Constraints

- Node >= 24; pnpm. Root test command `pnpm test` (= `tsc -b && vitest run`). A single test runs as `tsc -b && pnpm exec vitest run dist/<path>.test.js` — a `src/*.ts` path silently matches nothing.
- Fresh worktree: run `pnpm install` then `pnpm build` (root, produces the console bundle) once before the first `pnpm test`, or unrelated console tests fail on a missing `dist/console` bundle.
- Every new source file starts with `// Copyright (c) 2026 NineMind, Inc.` + `// SPDX-License-Identifier: MIT`.
- ESM imports use explicit `.js` suffixes. The MCP SDK client entry points are `@modelcontextprotocol/sdk/client/index.js` (`Client`), `.../client/stdio.js` (`StdioClientTransport`), `.../client/streamableHttp.js` (`StreamableHTTPClientTransport`), `.../client/sse.js` (`SSEClientTransport`) — the same package `mcpProxy.ts` already imports from. If a transport entry path differs in the installed version, confirm the real path under `node_modules/.../@modelcontextprotocol/sdk` before guessing.
- **Manifest enforcement is the security boundary (spec §3, D13):** `POST /play/mcp/call` MUST reject any `(server, tool)` not present in the SAVED miniapp's `mcpNeeds` with `not_in_manifest`, reading the saved `meta.json` via the registry — never trusting a client-supplied manifest. This is enforced server-side even though consent (PR-3) is console-side; PR-2's route is the boundary.
- **Spawn env allowlist (2A):** a spawned stdio gem's child env is `{ PATH, HOME } ∪ (the gem's own raw config.env) ∪ { each secretRefs-declared name that is set in process.env }`. NEVER spread `process.env`. This is why the manager reads the gem UNREDACTED (`introspectConfig({ redact: false })`): redaction replaces `config.env` values with `<redacted>`, so the raw read is the only source of the gem's real env.
- **Error codes come from PR-1's `MCP_ERROR_CODES`** (`@agentgem/model`) — no new code list. `derivePayload` (also `@agentgem/model`) computes the response payload once, server-side.
- Comments explain *why* and constraints, matching the dense house style.
- `AgentError` from `@agentback/openapi` carries HTTP status; the MCP envelope's coded errors ride the JSON body (a resolved 200 with an `{ error: { code, message } }` shape — see Task 3), NOT an HTTP error, so the sealed frame's shim can branch on `code`. Transport/HTTP failures (route not found, body invalid) stay `AgentError`.

---

### Task 1: Spawn env assembly (pure, testable in isolation)

**Files:**
- Create: `src/play/mcpEnv.ts`
- Test: `src/play/__tests__/mcpEnv.test.ts` (new)

**Interfaces:**
- Consumes: `McpServerArtifact` (`config`, `secretRefs`) from `@agentgem/model`.
- Produces: `buildSpawnEnv(gem: { config: Record<string, unknown>; secretRefs?: { name: string }[] }, processEnv: NodeJS.ProcessEnv): { env: Record<string, string>; missingSecrets: string[] }` — Task 2's connection manager calls this to assemble a child env and to fast-fail (D14) when a declared secret is absent everywhere.

- [ ] **Step 1: Write the failing test**

Create `src/play/__tests__/mcpEnv.test.ts`:

```typescript
// src/play/__tests__/mcpEnv.test.ts
import { describe, it, expect } from "vitest";
import { buildSpawnEnv } from "@agentgem/play";

const PROC = { PATH: "/usr/bin:/bin", HOME: "/home/u", OPENAI_API_KEY: "sk-live", UNRELATED: "leak-me" } as NodeJS.ProcessEnv;

describe("buildSpawnEnv", () => {
  it("passes PATH and HOME through, and NOTHING else from process.env by default", () => {
    const { env } = buildSpawnEnv({ config: {} }, PROC);
    expect(env.PATH).toBe("/usr/bin:/bin");
    expect(env.HOME).toBe("/home/u");
    expect(env.UNRELATED).toBeUndefined();
    expect(env.OPENAI_API_KEY).toBeUndefined();
  });

  it("carries the gem's OWN raw config.env verbatim (literal values the user configured)", () => {
    const { env } = buildSpawnEnv({ config: { env: { GITHUB_TOKEN: "ghp_literal", NODE_ENV: "production" } } }, PROC);
    expect(env.GITHUB_TOKEN).toBe("ghp_literal");
    expect(env.NODE_ENV).toBe("production");
  });

  it("resolves a declared secretRefs name from process.env when the gem config did not carry it", () => {
    const gem = { config: { command: "openai-mcp" }, secretRefs: [{ name: "OPENAI_API_KEY" }] };
    const { env, missingSecrets } = buildSpawnEnv(gem, PROC);
    expect(env.OPENAI_API_KEY).toBe("sk-live");   // pulled by NAME — it's an allowlisted secret this gem declared
    expect(missingSecrets).toEqual([]);
  });

  it("does NOT let a secretRef name pull an unrelated process.env var the gem never declared", () => {
    // UNRELATED is in process.env but not a secretRef and not in config.env → excluded.
    const { env } = buildSpawnEnv({ config: {}, secretRefs: [{ name: "OPENAI_API_KEY" }] }, PROC);
    expect(env.UNRELATED).toBeUndefined();
  });

  it("reports a declared secret that is absent from BOTH config.env and process.env (D14 fast-fail input)", () => {
    const gem = { config: { command: "gh-mcp" }, secretRefs: [{ name: "GITHUB_TOKEN" }] };
    const { env, missingSecrets } = buildSpawnEnv(gem, PROC);
    expect(env.GITHUB_TOKEN).toBeUndefined();
    expect(missingSecrets).toEqual(["GITHUB_TOKEN"]);
  });

  it("treats a config.env value of the redaction sentinel as NOT satisfying the secret", () => {
    // Defensive: if a redacted gem ever reaches here, "<redacted>" is not a real value.
    const gem = { config: { env: { GITHUB_TOKEN: "<redacted>" } }, secretRefs: [{ name: "GITHUB_TOKEN" }] };
    const { missingSecrets } = buildSpawnEnv(gem, { ...PROC, GITHUB_TOKEN: undefined });
    expect(missingSecrets).toEqual(["GITHUB_TOKEN"]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `tsc -b 2>&1 | head` — expect `buildSpawnEnv` not exported from `@agentgem/play`.

- [ ] **Step 3: Write the implementation**

Create `src/play/mcpEnv.ts`:

```typescript
// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
// Assemble the child-process environment for a spawned stdio MCP connector gem (spec 2A).
//
// The rule is an ALLOWLIST, never a process.env spread: a connector gem is third-party-installable
// code, and handing it the whole environment would leak every local credential to any gem the viewer
// runs. The child sees exactly three sources, in precedence order:
//   1. { PATH, HOME } — so the binary resolves and tools that need a home dir work.
//   2. the gem's OWN raw config.env — the literal values the user configured in .mcp.json for THIS
//      server (read unredacted; the redacted inventory replaces these with "<redacted>").
//   3. each secretRefs-declared NAME, resolved from process.env when the gem config didn't carry a
//      concrete value — covers the common pattern of relying on an ambient env var rather than
//      inlining the secret. Only names the gem itself declared as secrets are eligible; an arbitrary
//      process.env var is never pulled.
//
// `missingSecrets` lists declared secretRefs names that end up with no real value in either source —
// the D14 fast-fail signal, so a connect surfaces "GITHUB_TOKEN not set" instead of a cryptic
// upstream auth error.

const REDACTION_SENTINEL = "<redacted>";

function realString(v: unknown): string | undefined {
  return typeof v === "string" && v.length > 0 && v !== REDACTION_SENTINEL ? v : undefined;
}

export function buildSpawnEnv(
  gem: { config: Record<string, unknown>; secretRefs?: { name: string }[] },
  processEnv: NodeJS.ProcessEnv = process.env,
): { env: Record<string, string>; missingSecrets: string[] } {
  const env: Record<string, string> = {};
  if (typeof processEnv.PATH === "string") env.PATH = processEnv.PATH;
  if (typeof processEnv.HOME === "string") env.HOME = processEnv.HOME;

  const configEnv = gem.config.env;
  if (configEnv && typeof configEnv === "object" && !Array.isArray(configEnv)) {
    for (const [k, v] of Object.entries(configEnv as Record<string, unknown>)) {
      const s = realString(v);
      if (s !== undefined) env[k] = s;
    }
  }

  const missingSecrets: string[] = [];
  for (const ref of gem.secretRefs ?? []) {
    if (realString(env[ref.name]) !== undefined) continue;      // already satisfied by config.env
    const fromProc = realString(processEnv[ref.name]);
    if (fromProc !== undefined) env[ref.name] = fromProc;       // allowlisted by name, pulled from ambient env
    else missingSecrets.push(ref.name);
  }
  return { env, missingSecrets };
}
```

Export it: in `packages/play/src/index.ts` add `mcpEnv.js` to the exports (check whether the file uses `export *` per subdir or names each module — mirror the pattern already there; `src/play/` files are re-exported through `@agentgem/play`, so confirm how `mcpEnv.ts`'s siblings surface and match it).

NOTE: `src/play/mcpEnv.ts` and its test live under the repo-root `src/play/` tree that is published as `@agentgem/play` (see the PR-1 `capabilityScan` tests importing from `@agentgem/play`). Place the new file beside `capabilityScan.ts`'s compiled siblings — confirm the exact source directory by locating `capabilityScan.ts` (it is the module PR-1 edited) and putting `mcpEnv.ts` next to it; the test import path (`@agentgem/play`) is what matters.

- [ ] **Step 4: Run test to verify it passes**

Run: `tsc -b && pnpm exec vitest run dist/play/__tests__/mcpEnv.test.js` — expect 6 PASS.

- [ ] **Step 5: Commit**

```bash
git add src/play/mcpEnv.ts packages/play/src/index.ts src/play/__tests__/mcpEnv.test.ts
git commit -m "feat(play): buildSpawnEnv — allowlisted child env for connector gems (spec 2A)"
```

---

### Task 2: Connection manager (`mcpConnectors.ts`)

**Files:**
- Create: `src/play/mcpConnectors.ts`
- Test: `src/play/__tests__/mcpConnectors.test.ts` (new — uses a real in-process fake stdio MCP server fixture)
- Test fixture: `src/play/__tests__/fixtures/fakeStdioServer.mjs` (new — a tiny real MCP server over stdio)

**Interfaces:**
- Consumes: `buildSpawnEnv` (Task 1); `introspectConfig` from `@agentgem/capture`; `McpServerArtifact` from `@agentgem/model`; MCP SDK `Client` + transports.
- Produces (all async unless noted):
  - `resolveConnectorGem(server: string): McpServerArtifact | undefined` — the installed `mcp_server` gem by name (unredacted read).
  - `listConnectorTools(server: string): Promise<{ name: string; description?: string; annotations?: { readOnlyHint?: boolean; destructiveHint?: boolean } }[]>` — connect + `listTools()`; Task 3's `servers` route uses it.
  - `callConnectorTool(server: string, tool: string, input: unknown): Promise<{ content: unknown[]; structuredContent?: unknown }>` — connect + `callTool`; Task 3's `call` route uses it, then runs `derivePayload`.
  - `class ConnectorError extends Error { code: McpErrorCode }` — thrown by the two calls above; Task 3 maps `.code` onto the envelope.
  - `__resetConnectorsForTest(): void` — closes all pooled clients (test teardown; the manager is module-singleton).

- [ ] **Step 1: Write the fake stdio server fixture**

Create `src/play/__tests__/fixtures/fakeStdioServer.mjs` — a real MCP server so the manager's SDK client talks to a real peer (not a mock), per spec §7:

```javascript
// A minimal real MCP server over stdio, for connection-manager tests. Behavior is env-driven so one
// fixture covers the happy path, a slow path (single-flight timing), a tool that errors, and a
// missing-secret assertion.
//   FAKE_DELAY_MS   — delay before responding to callTool (default 0)
//   FAKE_REQUIRE_ENV — if set, the server exits non-zero at startup unless that env var is present
//                      (simulates a real server that dies without its token)
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { ListToolsRequestSchema, CallToolRequestSchema } from "@modelcontextprotocol/sdk/types.js";

const required = process.env.FAKE_REQUIRE_ENV;
if (required && !process.env[required]) {
  process.stderr.write(`fake server: missing ${required}\n`);
  process.exit(1);
}
const delay = Number(process.env.FAKE_DELAY_MS ?? 0);

const server = new Server({ name: "fake", version: "1.0.0" }, { capabilities: { tools: {} } });
server.setRequestHandler(ListToolsRequestSchema, () => ({
  tools: [
    { name: "read_thing", description: "read", annotations: { readOnlyHint: true } },
    { name: "write_thing", description: "write", annotations: { readOnlyHint: false } },
    { name: "boom", description: "always fails" },
  ],
}));
server.setRequestHandler(CallToolRequestSchema, async (req) => {
  if (delay) await new Promise((r) => setTimeout(r, delay));
  if (req.params.name === "boom") throw new Error("tool exploded");
  return { content: [{ type: "text", text: JSON.stringify({ echo: req.params.arguments ?? null }) }] };
});
await server.connect(new StdioServerTransport());
```

- [ ] **Step 2: Write the failing test**

Create `src/play/__tests__/mcpConnectors.test.ts`. The tests install a temp `AGENTGEM_HOME`/`claudeDir` with a `.mcp.json` naming the fixture as a stdio server, then drive the manager. Use `introspectConfig`'s `claudeDir` option indirection: the manager must read the gem via `introspectConfig({ redact: false })`, so the test seeds a real `~/.claude/.mcp.json`-shaped config that `introspectConfig` reads. Confirm from `introspectConfig`'s signature how to point it at a temp dir (it accepts `claudeDir`); the manager should pass through an override hook OR honor the same env the rest of the server uses. Simplest: give the manager an optional injected `introspect` reader defaulting to the real one, so the test injects a reader returning the fixture gem.

```typescript
// src/play/__tests__/mcpConnectors.test.ts
import { describe, it, expect, afterEach } from "vitest";
import { fileURLToPath } from "node:url";
import { join, dirname } from "node:path";
import { listConnectorTools, callConnectorTool, ConnectorError, __resetConnectorsForTest, __setConnectorReaderForTest } from "@agentgem/play";

const here = dirname(fileURLToPath(import.meta.url));
const FIXTURE = join(here, "fixtures", "fakeStdioServer.mjs");

// A reader that returns a stdio gem pointing at the fixture. Mirrors introspectConfig's
// McpServerArtifact shape: { type, name, transport, config, secretRefs }.
function stdioGem(name: string, extra: Record<string, unknown> = {}) {
  return { type: "mcp_server" as const, name, transport: "stdio" as const, config: { command: process.execPath, args: [FIXTURE], ...extra }, source: "user" };
}

afterEach(() => __resetConnectorsForTest());

describe("connection manager", () => {
  it("lists a gem's tools with annotations", async () => {
    __setConnectorReaderForTest((server) => (server === "fake" ? stdioGem("fake") : undefined));
    const tools = await listConnectorTools("fake");
    expect(tools.map((t) => t.name).sort()).toEqual(["boom", "read_thing", "write_thing"]);
    expect(tools.find((t) => t.name === "read_thing")?.annotations?.readOnlyHint).toBe(true);
  });

  it("calls a tool and returns the raw result content", async () => {
    __setConnectorReaderForTest((s) => stdioGem("fake"));
    const r = await callConnectorTool("fake", "read_thing", { q: 1 });
    // derivePayload runs in the ROUTE, not here — the manager returns raw content.
    const text = (r.content[0] as { text: string }).text;
    expect(JSON.parse(text)).toEqual({ echo: { q: 1 } });
  });

  it("single-flights concurrent first calls to a cold gem (one spawn, both resolve)", async () => {
    let spawns = 0;
    __setConnectorReaderForTest((s) => { spawns++; return stdioGem("fake", { env: { FAKE_DELAY_MS: "40" } }); });
    const [a, b] = await Promise.all([callConnectorTool("fake", "read_thing", {}), callConnectorTool("fake", "read_thing", {})]);
    expect(JSON.parse((a.content[0] as { text: string }).text)).toEqual({ echo: {} });
    expect(JSON.parse((b.content[0] as { text: string }).text)).toEqual({ echo: {} });
    // The reader is consulted once per connect; a single-flighted connect reads the gem once.
    expect(spawns).toBe(1);
  });

  it("maps an unknown server to a server_not_connected ConnectorError", async () => {
    __setConnectorReaderForTest(() => undefined);
    await expect(callConnectorTool("nope", "read_thing", {})).rejects.toMatchObject({ code: "server_not_connected" });
  });

  it("maps a tool-reported failure to tool_error", async () => {
    __setConnectorReaderForTest(() => stdioGem("fake"));
    await expect(callConnectorTool("fake", "boom", {})).rejects.toMatchObject({ code: "tool_error" });
  });

  it("fast-fails server_not_connected with the missing secret name when a declared secret is absent everywhere", async () => {
    __setConnectorReaderForTest(() => ({ ...stdioGem("fake"), secretRefs: [{ name: "GITHUB_TOKEN" }] }));
    // GITHUB_TOKEN is neither in config.env nor process.env → buildSpawnEnv reports it missing → manager fast-fails.
    const err = await callConnectorTool("fake", "read_thing", {}).catch((e) => e);
    expect(err).toBeInstanceOf(ConnectorError);
    expect(err.code).toBe("server_not_connected");
    expect(err.message).toContain("GITHUB_TOKEN");
  });

  it("times out a hung call as server_unavailable", async () => {
    __setConnectorReaderForTest(() => stdioGem("fake", { env: { FAKE_DELAY_MS: "5000" } }));
    await expect(callConnectorTool("fake", "read_thing", {}, { timeoutMs: 60 })).rejects.toMatchObject({ code: "server_unavailable" });
  }, 10000);

  it("does NOT poison the pool after a failed connect — a retry once the secret is set succeeds", async () => {
    let hasSecret = false;
    __setConnectorReaderForTest(() => hasSecret ? stdioGem("fake") : ({ ...stdioGem("fake"), secretRefs: [{ name: "GITHUB_TOKEN" }] }));
    await expect(callConnectorTool("fake", "read_thing", {})).rejects.toMatchObject({ code: "server_not_connected" });
    hasSecret = true;  // secret now available (gem no longer declares it missing)
    const r = await callConnectorTool("fake", "read_thing", { q: 2 });
    expect(JSON.parse((r.content[0] as { text: string }).text)).toEqual({ echo: { q: 2 } });
  });
});
```

- [ ] **Step 3: Write the implementation**

Create `src/play/mcpConnectors.ts`. Requirements the tests pin, plus the spec:

- Module-singleton pool: `Map<string, ConnEntry>` where `ConnEntry = { client: Client; transport; connecting: Promise<Client> | null; inFlight: number; lastUse: number; idleTimer }`.
- `resolveConnectorGem(server)`: default reader = `introspectConfig({ redact: false }).mcpServers.find(g => g.name === server)`; overridable via `__setConnectorReaderForTest`.
- `ensureClient(server)`: **single-flight** — if `entry.connecting` exists, await it; else create one promise, store it before the first `await`, resolve to a connected `Client`, clear `connecting`. On a stdio gem: `buildSpawnEnv(gem, process.env)`; if `missingSecrets.length`, throw `ConnectorError("… <name> not set", "server_not_connected")` BEFORE spawning (D14). Build `StdioClientTransport({ command, args, env, stderr: "pipe" })`. On http/sse: build the matching transport from `config.url`. Wrap connect failures as `server_unavailable`.
- `callConnectorTool(server, tool, input, opts?)`: `ensureClient`; `inFlight++`; `client.callTool({ name: tool, arguments: input ?? {} }, undefined, { timeout: opts?.timeoutMs ?? 30000 })` — the SDK's per-request timeout raises on hang → map to `server_unavailable`. A tool-reported failure surfaces as either a thrown SDK error OR an `isError` result depending on SDK version; treat BOTH as `tool_error` (check `result.isError === true` and rejections alike). `finally { inFlight--; touchIdle(entry) }`.
- `listConnectorTools(server)`: `ensureClient`; `client.listTools()` → map to `{ name, description, annotations }`.
- Idle reaper: `touchIdle` sets `lastUse` and arms a timer (~5 min) that closes the client ONLY if `inFlight === 0` at fire time (in-flight-gated — never close mid-call).
- `ConnectorError extends Error` with a `code: McpErrorCode` field (import the type from `@agentgem/model`).
- `__resetConnectorsForTest()`: close every transport, clear the map, clear timers.
- Unknown-gem path: `resolveConnectorGem` returns undefined → `server_not_connected`.

Reference skeleton (the implementer fills gaps against the installed SDK's exact method signatures — confirm `client.callTool`/`listTools` shapes against `node_modules`):

```typescript
// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
// Live in-process MCP client manager for miniapp connectors (spec §3, 1A/2A/D14).
//
// Distinct from mcpProxy.ts, which only RENDERS a runner script: this owns real @modelcontextprotocol
// /sdk Client connections to the viewer's installed mcp_server gems and pools them. The pool is a
// module singleton because a connector process is expensive to spawn and shared across every miniapp
// call in the session. Concurrency invariants that the race class here demands (a prior index bug in
// this repo cost real debugging — new-index-method-must-join-single-flight-chain):
//   • single-flight connect: two concurrent first calls to a cold gem spawn ONE process, not two.
//   • in-flight-gated idle close: the ~5 min reaper never closes a client with a call in flight.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { McpServerArtifact, McpErrorCode } from "@agentgem/model";
import { introspectConfig } from "@agentgem/capture";
import { buildSpawnEnv } from "./mcpEnv.js";

export class ConnectorError extends Error {
  constructor(message: string, readonly code: McpErrorCode) { super(message); this.name = "ConnectorError"; }
}

type Reader = (server: string) => McpServerArtifact | undefined;
let reader: Reader = (server) => introspectConfig({ redact: false }).mcpServers.find((g) => g.name === server);
export function __setConnectorReaderForTest(r: Reader): void { reader = r; }

export function resolveConnectorGem(server: string): McpServerArtifact | undefined { return reader(server); }

const IDLE_MS = 5 * 60_000;
const DEFAULT_TIMEOUT_MS = 30_000;

interface Entry { client: Client; transport: { close(): Promise<void> | void }; connecting: Promise<Client> | null; inFlight: number; idle?: ReturnType<typeof setTimeout>; }
const pool = new Map<string, Entry>();

async function ensureClient(server: string): Promise<Client> {
  let entry = pool.get(server);
  if (entry?.client && !entry.connecting) return entry.client;
  if (entry?.connecting) return entry.connecting;

  const gem = resolveConnectorGem(server);
  if (!gem) throw new ConnectorError(`no installed MCP server named "${server}"`, "server_not_connected");

  const connecting = (async () => {
    try {
      const client = new Client({ name: "agentgem-connector", version: "1.0.0" }, { capabilities: {} });
      let transport: Entry["transport"];
      if (gem.transport === "stdio") {
        const command = String((gem.config as { command?: unknown }).command ?? "");
        const args = Array.isArray((gem.config as { args?: unknown }).args) ? ((gem.config as { args: unknown[] }).args as string[]) : [];
        const { env, missingSecrets } = buildSpawnEnv(gem, process.env);
        if (missingSecrets.length) throw new ConnectorError(`MCP server "${server}" is missing required secret(s): ${missingSecrets.join(", ")} — set them in your environment`, "server_not_connected");
        transport = new StdioClientTransport({ command, args, env, stderr: "pipe" });
      } else {
        // http/sse: import the matching transport lazily so a stdio-only environment doesn't pay for it.
        const url = new URL(String((gem.config as { url?: unknown }).url ?? ""));
        const mod = gem.transport === "sse"
          ? await import("@modelcontextprotocol/sdk/client/sse.js")
          : await import("@modelcontextprotocol/sdk/client/streamableHttp.js");
        transport = gem.transport === "sse" ? new mod.SSEClientTransport(url) : new mod.StreamableHTTPClientTransport(url);
      }
      try { await client.connect(transport); }
      catch (e) { throw new ConnectorError(`could not connect to MCP server "${server}": ${(e as Error).message}`, "server_unavailable"); }
      const e2 = pool.get(server)!; e2.client = client; e2.transport = transport; e2.connecting = null; touchIdle(server);
      return client;
    } catch (e) {
      // A failed connect must NOT poison the pool: without this, the rejected `connecting` promise
      // stays cached and every later call re-returns the same rejection (missing-secret gems could
      // never recover after the secret is set). Drop the entry so the next call retries cleanly.
      pool.delete(server);
      throw e;
    }
  })();

  entry = { client: undefined as unknown as Client, transport: undefined as unknown as Entry["transport"], connecting, inFlight: 0 };
  pool.set(server, entry);
  return connecting;
}

function touchIdle(server: string): void {
  const e = pool.get(server); if (!e) return;
  if (e.idle) clearTimeout(e.idle);
  e.idle = setTimeout(() => { if (e.inFlight === 0) void closeEntry(server); }, IDLE_MS);
  if (typeof e.idle === "object" && "unref" in e.idle) (e.idle as { unref(): void }).unref();
}

async function closeEntry(server: string): Promise<void> {
  const e = pool.get(server); if (!e) return;
  pool.delete(server);
  if (e.idle) clearTimeout(e.idle);
  try { await e.transport?.close(); } catch { /* best-effort */ }
}

export async function listConnectorTools(server: string) {
  const client = await ensureClient(server);
  const { tools } = await client.listTools();
  return tools.map((t) => ({ name: t.name, description: t.description, annotations: t.annotations as { readOnlyHint?: boolean; destructiveHint?: boolean } | undefined }));
}

export async function callConnectorTool(server: string, tool: string, input: unknown, opts?: { timeoutMs?: number }): Promise<{ content: unknown[]; structuredContent?: unknown }> {
  const client = await ensureClient(server);
  const entry = pool.get(server)!;
  entry.inFlight++;
  try {
    const result = await client.callTool({ name: tool, arguments: (input ?? {}) as Record<string, unknown> }, undefined, { timeout: opts?.timeoutMs ?? DEFAULT_TIMEOUT_MS });
    if ((result as { isError?: boolean }).isError) throw new ConnectorError(`tool "${tool}" reported an error`, "tool_error");
    return { content: (result.content ?? []) as unknown[], structuredContent: (result as { structuredContent?: unknown }).structuredContent };
  } catch (e) {
    if (e instanceof ConnectorError) throw e;
    const msg = (e as Error).message ?? "";
    // The SDK raises a timeout error for a hung request; treat that as transient/unavailable.
    if (/timeout|timed out/i.test(msg)) throw new ConnectorError(`MCP server "${server}" timed out`, "server_unavailable");
    throw new ConnectorError(`tool "${tool}" failed: ${msg}`, "tool_error");
  } finally { entry.inFlight--; touchIdle(server); }
}

export async function __resetConnectorsForTest(): Promise<void> {
  for (const server of [...pool.keys()]) await closeEntry(server);
}
```

Export the public surface (`ConnectorError`, `listConnectorTools`, `callConnectorTool`, `resolveConnectorGem`, `__setConnectorReaderForTest`, `__resetConnectorsForTest`) through `@agentgem/play` the same way Task 1 exported `mcpEnv`.

- [ ] **Step 4: Run the tests**

Run: `tsc -b && pnpm exec vitest run dist/play/__tests__/mcpConnectors.test.js` — expect 8 PASS. If a transport import path or `callTool` option name differs in the installed SDK, fix against `node_modules` and note it in the report (do NOT guess past a compile error).

- [ ] **Step 5: Commit**

```bash
git add src/play/mcpConnectors.ts src/play/__tests__/mcpConnectors.test.ts src/play/__tests__/fixtures/fakeStdioServer.mjs packages/play/src/index.ts
git commit -m "feat(play): live MCP connection manager — single-flight connect, idle-gated pool, coded errors (1A/2A/D14)"
```

---

### Task 3: Routes — `POST /play/mcp/call` + `GET /play/mcp/servers`

**Files:**
- Modify: `src/schemas.ts` (add the request/response schemas)
- Modify: `src/play.controller.ts` (two new handlers + imports)
- Test: `src/__tests__/playMcpCall.test.ts` (new — route-level, driving the controller with the fake fixture via the injected reader)

**Interfaces:**
- Consumes: Task 2's manager; PR-1's `derivePayload` + `MCP_ERROR_CODES` (`@agentgem/model`); PR-1's saved `mcpNeeds` on the miniapp (`readMiniapp(name).meta.mcpNeeds`).
- Produces: the two routes PR-3's console shim calls. Response envelope (a resolved 200 whose body carries either a payload or a coded error — so the sealed frame branches on `code`, not HTTP status).

- [ ] **Step 1: Write the schemas**

In `src/schemas.ts`, near the other Play schemas, add:

```typescript
// ---- Play MCP connectors (PR-2) ----
export const PlayMcpCallRequestSchema = z.object({
  name: z.string(),                 // the SAVED miniapp whose mcpNeeds manifest gates this call
  server: z.string(),               // connector gem display name
  tool: z.string(),
  input: z.unknown().optional(),    // JSON args; forwarded verbatim to the tool
});
// A coded error rides the BODY (not an HTTP error) so the sealed-frame shim branches on `code`.
// `MCP_ERROR_CODES` is the canonical union (PR-1, @agentgem/model); mirror it as a wire enum here,
// drift-pinned by a test so the two never separate.
export const McpErrorCodeEnum = z.enum(MCP_ERROR_CODES);
export const PlayMcpCallResponseSchema = z.object({
  ok: z.boolean(),
  payload: z.unknown().optional(),                                   // present when ok
  content: z.array(z.unknown()).optional(),                          // raw blocks, for images/multi-block
  error: z.object({ code: McpErrorCodeEnum, message: z.string() }).optional(),  // present when !ok
});
export const PlayMcpServersQuerySchema = z.object({ name: z.string() });
export const PlayMcpServersResponseSchema = z.object({
  servers: z.array(z.object({
    server: z.string(),
    tools: z.array(z.object({
      name: z.string(),
      description: z.string().optional(),
      annotations: z.object({ readOnlyHint: z.boolean().optional(), destructiveHint: z.boolean().optional() }).optional(),
    })),
  })),
});
```

Import `MCP_ERROR_CODES` from `@agentgem/model` at the top of `src/schemas.ts` (it's already a dependency).

Add a drift-guard test in `src/__tests__/mcpEnvelope.test.ts` is out of scope; instead add a one-liner assertion to the new route test (Step 3) that `McpErrorCodeEnum.options` deep-equals `MCP_ERROR_CODES`.

- [ ] **Step 2: Write the failing route test**

Create `src/__tests__/playMcpCall.test.ts`:

```typescript
// src/__tests__/playMcpCall.test.ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { MCP_ERROR_CODES } from "@agentgem/model";
import { __setConnectorReaderForTest, __resetConnectorsForTest } from "@agentgem/play";
import { PlayController } from "../play.controller.js";
import { McpErrorCodeEnum } from "../schemas.js";

const here = dirname(fileURLToPath(import.meta.url));
const FIXTURE = join(here, "..", "play", "__tests__", "fixtures", "fakeStdioServer.mjs"); // adjust to real relative path
const stdioGem = (name: string, extra = {}) => ({ type: "mcp_server" as const, name, transport: "stdio" as const, config: { command: process.execPath, args: [FIXTURE], ...extra }, source: "user" });

let home: string;
const meta = { title: "Pulse", genre: "project-fun" as const, createdFrom: { kind: "blank" as const, title: "Pulse" }, engineVersion: "1" };
const mcpHtml = (js: string) => `<!doctype html><body><canvas></canvas><script>if(window.agentgemApp&&window.agentgemApp.mcp){${js}}</script></body>`;

beforeEach(() => { home = mkdtempSync(join(tmpdir(), "agh-")); process.env.AGENTGEM_HOME = home; });
afterEach(async () => { await __resetConnectorsForTest(); rmSync(home, { recursive: true, force: true }); delete process.env.AGENTGEM_HOME; });

describe("wire enum drift", () => {
  it("McpErrorCodeEnum equals MCP_ERROR_CODES", () => {
    expect(McpErrorCodeEnum.options).toEqual([...MCP_ERROR_CODES]);
  });
});

describe("POST /api/play/mcp/call", () => {
  it("brokers a call to a manifest-declared (server, tool) and returns derivePayload output", async () => {
    const ctrl = new PlayController();
    await ctrl.save({ body: { name: "pulse", html: mcpHtml(`window.agentgemApp.mcp.callTool("fake","read_thing")`), meta: { ...meta, mcpNeeds: [{ server: "fake", tools: ["read_thing"] }] } } });
    __setConnectorReaderForTest(() => stdioGem("fake"));
    const res = await ctrl.mcpCall({ body: { name: "pulse", server: "fake", tool: "read_thing", input: { q: 7 } } });
    expect(res.ok).toBe(true);
    expect(res.payload).toEqual({ echo: { q: 7 } });   // derivePayload parsed the text block
  });

  it("REJECTS a (server, tool) outside the saved manifest with not_in_manifest — the security boundary", async () => {
    const ctrl = new PlayController();
    await ctrl.save({ body: { name: "pulse", html: mcpHtml(`window.agentgemApp.mcp.callTool("fake","read_thing")`), meta: { ...meta, mcpNeeds: [{ server: "fake", tools: ["read_thing"] }] } } });
    __setConnectorReaderForTest(() => stdioGem("fake"));
    // write_thing is NOT declared; the route must refuse without ever calling the connector.
    const res = await ctrl.mcpCall({ body: { name: "pulse", server: "fake", tool: "write_thing", input: {} } });
    expect(res.ok).toBe(false);
    expect(res.error?.code).toBe("not_in_manifest");
  });

  it("rejects an unknown server in the manifest with not_in_manifest even if a gem exists", async () => {
    const ctrl = new PlayController();
    await ctrl.save({ body: { name: "pulse", html: mcpHtml(`window.agentgemApp.mcp.callTool("fake","read_thing")`), meta: { ...meta, mcpNeeds: [{ server: "fake", tools: ["read_thing"] }] } } });
    __setConnectorReaderForTest(() => stdioGem("other"));
    const res = await ctrl.mcpCall({ body: { name: "pulse", server: "other", tool: "read_thing", input: {} } });
    expect(res.error?.code).toBe("not_in_manifest");
  });

  it("surfaces a tool_error from the connector in the body (ok:false)", async () => {
    const ctrl = new PlayController();
    await ctrl.save({ body: { name: "pulse", html: mcpHtml(`window.agentgemApp.mcp.callTool("fake","boom")`), meta: { ...meta, mcpNeeds: [{ server: "fake", tools: ["boom"] }] } } });
    __setConnectorReaderForTest(() => stdioGem("fake"));
    const res = await ctrl.mcpCall({ body: { name: "pulse", server: "fake", tool: "boom", input: {} } });
    expect(res.ok).toBe(false);
    expect(res.error?.code).toBe("tool_error");
  });

  it("404s for an unknown miniapp name", async () => {
    const ctrl = new PlayController();
    await expect(ctrl.mcpCall({ body: { name: "ghost", server: "fake", tool: "read_thing", input: {} } })).rejects.toThrow();
  });
});

describe("GET /api/play/mcp/servers", () => {
  it("returns the manifest servers intersected with installed gems, tools populated", async () => {
    const ctrl = new PlayController();
    await ctrl.save({ body: { name: "pulse", html: mcpHtml(`window.agentgemApp.mcp.callTool("fake","read_thing")`), meta: { ...meta, mcpNeeds: [{ server: "fake", tools: ["read_thing"] }] } } });
    __setConnectorReaderForTest(() => stdioGem("fake"));
    const res = await ctrl.mcpServers({ query: { name: "pulse" } });
    expect(res.servers.map((s) => s.server)).toEqual(["fake"]);
    expect(res.servers[0].tools.find((t) => t.name === "read_thing")?.annotations?.readOnlyHint).toBe(true);
  });

  it("lists a declared server with an EMPTY tools array when no matching gem is installed", async () => {
    const ctrl = new PlayController();
    await ctrl.save({ body: { name: "pulse", html: mcpHtml(`window.agentgemApp.mcp.callTool("fake","read_thing")`), meta: { ...meta, mcpNeeds: [{ server: "fake", tools: ["read_thing"] }] } } });
    __setConnectorReaderForTest(() => undefined);  // gem not installed
    const res = await ctrl.mcpServers({ query: { name: "pulse" } });
    expect(res.servers).toEqual([{ server: "fake", tools: [] }]);
  });
});
```

NOTE: `GET /servers` returning the FULL tool inventory here is correct for PR-2 — the pre-consent empty-tools gating (D12) is a PR-3 console-broker concern, not the server route. This route returns the manifest ∩ installed gems with tools; the console decides what to expose pre-consent. Do not implement consent gating in this route.

- [ ] **Step 3: Write the handlers**

In `src/play.controller.ts`:

Imports — add to the `@agentgem/play` import: `callConnectorTool, listConnectorTools, resolveConnectorGem, ConnectorError`. Add to the `@agentgem/model` imports (or a new import): `derivePayload`. Add the four new schemas to the `./schemas.js` import.

Add the handlers (place beside the other `/play/*` routes):

```typescript
  @post("/play/mcp/call", { body: PlayMcpCallRequestSchema, response: PlayMcpCallResponseSchema })
  async mcpCall(input: { body: z.infer<typeof PlayMcpCallRequestSchema> }): Promise<z.infer<typeof PlayMcpCallResponseSchema>> {
    const { name, server, tool, input: args } = input.body;
    // 404 for an unknown miniapp (an AgentError, not an envelope error — the CALLER is malformed).
    let mcpNeeds;
    try { mcpNeeds = readMiniapp(name).meta.mcpNeeds ?? []; }
    catch (e) { throw new AgentError((e as Error).message, { status: 404 }); }
    // THE SECURITY BOUNDARY: refuse any (server, tool) the SAVED manifest does not grant, before we
    // ever touch the connector. The console consent gate (PR-3) is UX; this is enforcement.
    const declared = mcpNeeds.find((n) => n.server === server);
    if (!declared || !declared.tools.includes(tool)) {
      return { ok: false, error: { code: "not_in_manifest", message: `"${server}"/"${tool}" is not in this miniapp's declared connectors` } };
    }
    try {
      const result = await callConnectorTool(server, tool, args);
      return { ok: true, payload: derivePayload(result), content: result.content };
    } catch (e) {
      if (e instanceof ConnectorError) return { ok: false, error: { code: e.code, message: e.message } };
      return { ok: false, error: { code: "upstream_error", message: (e as Error).message } };
    }
  }

  @get("/play/mcp/servers", { query: PlayMcpServersQuerySchema, response: PlayMcpServersResponseSchema })
  async mcpServers(input: { query: z.infer<typeof PlayMcpServersQuerySchema> }): Promise<z.infer<typeof PlayMcpServersResponseSchema>> {
    let mcpNeeds;
    try { mcpNeeds = readMiniapp(input.query.name).meta.mcpNeeds ?? []; }
    catch (e) { throw new AgentError((e as Error).message, { status: 404 }); }
    const servers = [];
    for (const need of mcpNeeds) {
      // A declared server with no matching installed gem lists with EMPTY tools (the not-connected
      // shape). A failed listTools (connect error) also degrades to empty tools rather than failing
      // the whole route — one connector down must not blind the app to the others.
      if (!resolveConnectorGem(need.server)) { servers.push({ server: need.server, tools: [] }); continue; }
      try { servers.push({ server: need.server, tools: await listConnectorTools(need.server) }); }
      catch { servers.push({ server: need.server, tools: [] }); }
    }
    return { servers };
  }
```

- [ ] **Step 4: Run the tests**

Run: `tsc -b && pnpm exec vitest run dist/__tests__/playMcpCall.test.js` — expect all PASS (8). Fix the `FIXTURE` relative path in the test if the first run can't find the fixture (print `FIXTURE` and adjust).

- [ ] **Step 5: Commit**

```bash
git add src/schemas.ts src/play.controller.ts src/__tests__/playMcpCall.test.ts
git commit -m "feat(play): /play/mcp/call + /play/mcp/servers — server-side manifest enforcement + canonical envelope (spec §3)"
```

---

### Task 4: Route registration check + full-suite regression sweep + push + PR

**Files:** possibly `src/appCommon.ts` (route registration) — read it first; new `@post`/`@get` on an already-registered controller usually needs no wiring, but confirm.

- [ ] **Step 1: Confirm the routes are registered**

Check how `PlayController`'s routes reach the app (`grep -rn "PlayController" src/appCommon.ts src/*.ts`). If controllers are registered as a class (AgentBack decorator scan), the two new methods are automatically served — verify by grepping that no per-route allowlist exists. If an explicit route allowlist exists, add both paths.

- [ ] **Step 2: Full suite**

Run: `pnpm install && pnpm build` (fresh worktree, once), then `pnpm test`. Expect green. Known flake caveat: real-FS scan tests (observeScan/scorecard) can time out under full-suite concurrency — if one does, verify it in isolation before judging red. A connector test leaving a child process alive is a real bug (the `__resetConnectorsForTest` teardown must close every transport) — investigate, don't excuse.

- [ ] **Step 3: Push + PR**

```bash
git push -u origin HEAD
gh pr create --title "feat(play): MCP connector server spine — connection manager + call/servers routes (PR-2 of 4)" --body "<summary + test evidence + spec/plan links>"
```
Body: what landed (buildSpawnEnv, mcpConnectors manager, the two routes, server-side manifest enforcement), the spec §3/1A/2A/D14 references, suite counts, and end with: 🤖 Generated with [Claude Code](https://claude.com/claude-code). Then `gh run watch <id> --exit-status` before merge. Do not merge without CI green.

---

## Out of scope for PR-2 (later PRs)

- **PR-3 console:** consent card + hash-pinned grants (D9), the `mcp/*` postMessage router, the watch registry (coalescing, readOnlyHint gate D11, hidden-tab pause), listTools pre-consent empty-tools gating (D12 — the CONSOLE applies it; this route returns full tools), the `agentgemApp.mcp` shim, drift pins against `MCP_ERROR_CODES`.
- **PR-4:** marketplace chip + Repo Pulse demo + verify-skill E2E.
- **Multi-instance connectors, install-time badges:** TODOS.md.
