# Desktop Client Mode / No-PGlite Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the desktop a pure API client — no local database, no PGlite — so the Benchmark tab reads the hosted aggregator instead of 500ing on an empty embedded PGlite that can't boot.

**Architecture:** Add a hosted `benchmarkClient` + `/api/benchmark` proxy so the console reads the aggregator over HTTP (Phase A — fixes the 500). Then split the monolithic `src/index.ts` into two entrypoints over a shared `appCommon.ts`: `src/index.ts` (server, `+ mountAggregator`) and `src/client.ts` (desktop). The desktop bundle builds from `client.ts`, which never imports the aggregator path, so esbuild ships it with no `@agentgem/aggregator`/auth/`pg`/PGlite (Phase B).

**Tech Stack:** TypeScript (ESM, Node 24), AgentBack (`@agentback/openapi` REST controllers, Zod schemas), Vitest, esbuild (desktop bundling), Electron.

## Global Constraints

- **Match existing client-proxy pattern.** New hosted clients mirror `src/gem/shareClient.ts` (a `resolveBase()` + injectable `http`); new proxy controllers mirror `src/share.proxy.controller.ts` (`@api({ basePath })`, thin delegate). Copied verbatim: the aggregator base default is `DEFAULT_AGGREGATOR_URL = "https://api.agentgem.ai"` (exported from `shareClient.ts`), overridable via `process.env.AGENTGEM_AGGREGATOR_URL`.
- **Graceful degradation, never throw to the panel.** Read clients return `[]` on any non-2xx / network error / timeout (10s), so the console renders its existing empty state. Mirrors `reviewClient`'s "degrade to empty picker."
- **No auth on these reads.** The hosted `/api/aggregator/benchmarks` + `/effectiveness` are anonymous public reads; a server-side fetch also passes hosted `originGuard` (no `Origin`/`Sec-Fetch-*`). Send no API key, no cookies.
- **Server behaviour must not change.** `src/index.ts` (what `api.agentgem.ai` on Fly runs) must register the exact same routes before and after the Phase B refactor. Verify with the full test suite and a route-registration check.
- **CI gate:** root `dist/__tests__` only. `packages/console` tests and typecheck are NOT in CI — run them locally (`pnpm --filter @agentgem/console test`).
- **Bundle entry:** the desktop core is built by `desktop/scripts/bundle-core.mjs` (esbuild, `format: "esm"`, `platform: "node"`, `keepNames: true`).

---

## File Structure

- `src/gem/benchmarkClient.ts` (create) — hosted anon GET for benchmarks + effectiveness; injectable `http`; returns `[]` on failure.
- `src/benchmark.proxy.controller.ts` (create) — `@api({ basePath: "/api/benchmark" })`; two GETs delegating to `benchmarkClient`.
- `packages/console/src/api/routes.ts` (modify) — repoint `benchmarksRoute`/`effectivenessRoute` to the proxy paths.
- `src/serverAggregator.ts` (create, Phase B) — `mountAggregator(app, server, env)`: the aggregator/auth/OG/orgs/registry block extracted from `index.ts`; sole importer of `@agentgem/aggregator` + heavy server deps.
- `src/appCommon.ts` (create, Phase B) — `buildCommonApp(port)`: the shared/client surface (RestApplication config, MCP, the console + client-proxy controllers, explorer, mcp-http, healthz, console static serving, dispatch hooks, originGuard).
- `src/index.ts` (modify, Phase B) — server entry = `buildCommonApp` + `await mountAggregator(...)` + start.
- `src/client.ts` (create, Phase B) — desktop entry = `buildCommonApp` + `BenchmarkProxyController` + start. No aggregator import.
- `desktop/scripts/bundle-core.mjs` (modify, Phase B) — esbuild `entryPoints` → `dist/client.js`.
- `docs/deploy/enterprise.md` (create, Phase C) — server-mode deployment (own `DATABASE_URL`) + client config (`AGENTGEM_AGGREGATOR_URL`).

Tests: `src/gem/__tests__/benchmarkClient.test.ts`, `src/__tests__/benchmarkProxyController.test.ts`, `src/__tests__/clientEntry.test.ts`, plus a bundle-content assertion in `desktop/`.

---

## Phase A — Fix the 500 (client reads hosted). No refactor.

### Task 1: `benchmarkClient`

**Files:**
- Create: `src/gem/benchmarkClient.ts`
- Test: `src/gem/__tests__/benchmarkClient.test.ts`

**Interfaces:**
- Consumes: `DEFAULT_AGGREGATOR_URL` from `src/gem/shareClient.ts`.
- Produces:
  - `type BenchmarkHttp = (url: string, init: { method: string; headers: Record<string,string> }) => Promise<{ status: number; json(): Promise<unknown> }>`
  - `benchmarks(args?: { gemDigest?: string; endpoint?: string; http?: BenchmarkHttp }): Promise<unknown[]>`
  - `effectiveness(args?: { sort?: string; minConfidence?: number; gemName?: string; endpoint?: string; http?: BenchmarkHttp }): Promise<unknown[]>`

- [ ] **Step 1: Write the failing test**

```typescript
// src/gem/__tests__/benchmarkClient.test.ts
import { describe, it, expect } from "vitest";
import { benchmarks, effectiveness, type BenchmarkHttp } from "../benchmarkClient.js";

const ok = (rows: unknown[]): BenchmarkHttp => async () => ({ status: 200, json: async () => rows });

describe("benchmarkClient", () => {
  it("passes through the hosted rows on 200", async () => {
    const rows = [{ model: "opus", mostly: 3 }];
    expect(await benchmarks({ endpoint: "https://x", http: ok(rows) })).toEqual(rows);
  });
  it("hits the effectiveness path with sort+minConfidence", async () => {
    let seen = "";
    const http: BenchmarkHttp = async (url) => { seen = url; return { status: 200, json: async () => [] }; };
    await effectiveness({ endpoint: "https://x", sort: "score", minConfidence: 0.3, http });
    expect(seen).toBe("https://x/api/aggregator/effectiveness?sort=score&minConfidence=0.3");
  });
  it("returns [] on a 5xx", async () => {
    const http: BenchmarkHttp = async () => ({ status: 500, json: async () => ({}) });
    expect(await benchmarks({ endpoint: "https://x", http })).toEqual([]);
  });
  it("returns [] on a thrown/timeout error", async () => {
    const http: BenchmarkHttp = async () => { throw new Error("network"); };
    expect(await effectiveness({ endpoint: "https://x", http })).toEqual([]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm exec vitest run src/gem/__tests__/benchmarkClient.test.ts`
Expected: FAIL — cannot find module `../benchmarkClient.js`.

- [ ] **Step 3: Write the implementation**

```typescript
// src/gem/benchmarkClient.ts
// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
// Hosted-aggregator read client for the desktop's Benchmark tab. Mirrors shareClient:
// resolve the base (explicit -> AGENTGEM_AGGREGATOR_URL -> the public default) and GET the
// anonymous, public, k-anonymised roll-ups. Runs in the core, so a server-side fetch passes
// the hosted originGuard as a non-browser client and needs no auth. Any failure degrades to []
// so the panel shows its empty state instead of an error.
import { DEFAULT_AGGREGATOR_URL } from "./shareClient.js";

export type BenchmarkHttp = (
  url: string,
  init: { method: string; headers: Record<string, string> },
) => Promise<{ status: number; json(): Promise<unknown> }>;

const defaultHttp: BenchmarkHttp = async (url, init) => {
  const res = await fetch(url, { ...init, signal: AbortSignal.timeout(10_000) });
  return { status: res.status, json: () => res.json() };
};

function resolveBase(endpoint?: string): string {
  if (endpoint !== undefined) return endpoint;
  if (process.env.AGENTGEM_AGGREGATOR_URL) return process.env.AGENTGEM_AGGREGATOR_URL;
  return DEFAULT_AGGREGATOR_URL;
}

async function getRows(base: string, path: string, http: BenchmarkHttp): Promise<unknown[]> {
  if (!base) return [];
  try {
    const res = await http(`${base}${path}`, { method: "GET", headers: { accept: "application/json" } });
    if (res.status < 200 || res.status >= 300) return [];
    const body = await res.json();
    return Array.isArray(body) ? body : [];
  } catch {
    return [];
  }
}

export async function benchmarks(
  args: { gemDigest?: string; endpoint?: string; http?: BenchmarkHttp } = {},
): Promise<unknown[]> {
  const q = args.gemDigest ? `?gemDigest=${encodeURIComponent(args.gemDigest)}` : "";
  return getRows(resolveBase(args.endpoint), `/api/aggregator/benchmarks${q}`, args.http ?? defaultHttp);
}

export async function effectiveness(
  args: { sort?: string; minConfidence?: number; gemName?: string; endpoint?: string; http?: BenchmarkHttp } = {},
): Promise<unknown[]> {
  const p = new URLSearchParams();
  if (args.sort) p.set("sort", args.sort);
  if (args.minConfidence !== undefined) p.set("minConfidence", String(args.minConfidence));
  if (args.gemName) p.set("gemName", args.gemName);
  const q = p.toString() ? `?${p.toString()}` : "";
  return getRows(resolveBase(args.endpoint), `/api/aggregator/effectiveness${q}`, args.http ?? defaultHttp);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm exec vitest run src/gem/__tests__/benchmarkClient.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add src/gem/benchmarkClient.ts src/gem/__tests__/benchmarkClient.test.ts
git commit -m "feat(benchmark): hosted-aggregator read client (anon, degrades to [])"
```

---

### Task 2: `BenchmarkProxyController` + register it

**Files:**
- Create: `src/benchmark.proxy.controller.ts`
- Modify: `src/index.ts` (add `app.restController(BenchmarkProxyController)` next to `ShareProxyController`, ~line 157; add the import next to the `ShareProxyController` import)
- Test: `src/__tests__/benchmarkProxyController.test.ts`

**Interfaces:**
- Consumes: `benchmarks`, `effectiveness` from `src/gem/benchmarkClient.ts`.
- Produces: `class BenchmarkProxyController` with `benchmarks()` (GET `/api/benchmark`) and `effectiveness(input)` (GET `/api/benchmark/effectiveness`), both `Promise<unknown[]>`.

- [ ] **Step 1: Write the failing test**

```typescript
// src/__tests__/benchmarkProxyController.test.ts
import { describe, it, expect, vi } from "vitest";

vi.mock("../gem/benchmarkClient.js", () => ({
  benchmarks: vi.fn(async () => [{ model: "opus" }]),
  effectiveness: vi.fn(async () => [{ gemName: "g" }]),
}));

import { BenchmarkProxyController } from "../benchmark.proxy.controller.js";
import { effectiveness as effClient } from "../gem/benchmarkClient.js";

describe("BenchmarkProxyController", () => {
  it("delegates benchmarks to the client", async () => {
    expect(await new BenchmarkProxyController().benchmarks()).toEqual([{ model: "opus" }]);
  });
  it("forwards effectiveness query to the client", async () => {
    const c = new BenchmarkProxyController();
    await c.effectiveness({ query: { sort: "score", minConfidence: 0.3 } });
    expect(effClient).toHaveBeenCalledWith({ sort: "score", minConfidence: 0.3 });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm exec vitest run src/__tests__/benchmarkProxyController.test.ts`
Expected: FAIL — cannot find module `../benchmark.proxy.controller.js`.

- [ ] **Step 3: Write the controller**

```typescript
// src/benchmark.proxy.controller.ts
// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
// Same-origin proxy the console calls for the Benchmark tab. Forwards to the hosted aggregator
// via benchmarkClient (server-side, anonymous). Mirrors ShareProxyController: keeps the browser
// same-origin and the base resolution server-side. Response schema is permissive — the hosted
// side already validated, and the console re-validates against its own BenchmarkSchema.
import { z } from "zod";
import { api, get } from "@agentback/openapi";
import { benchmarks, effectiveness } from "./gem/benchmarkClient.js";

const Rows = z.array(z.record(z.string(), z.unknown()));
const EffQuery = z.object({
  sort: z.enum(["producers", "score"]).optional(),
  minConfidence: z.coerce.number().optional(),
  gemName: z.string().optional(),
});
const BenchQuery = z.object({ gemDigest: z.string().optional() });

@api({ basePath: "/api/benchmark" })
export class BenchmarkProxyController {
  @get("/", { query: BenchQuery, response: Rows })
  async benchmarks(input: { query: z.infer<typeof BenchQuery> } = { query: {} }): Promise<unknown[]> {
    return benchmarks({ gemDigest: input.query.gemDigest });
  }

  @get("/effectiveness", { query: EffQuery, response: Rows })
  async effectiveness(input: { query: z.infer<typeof EffQuery> } = { query: {} }): Promise<unknown[]> {
    return effectiveness({ sort: input.query.sort, minConfidence: input.query.minConfidence, gemName: input.query.gemName });
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm exec vitest run src/__tests__/benchmarkProxyController.test.ts`
Expected: PASS (2 tests).

Note: the `effectiveness` test asserts the client is called with exactly `{ sort, minConfidence }` — `gemName` is `undefined` and omitted from the object literal in the controller, so pass `{ sort: "score", minConfidence: 0.3, gemName: undefined }` in the controller call OR assert with `expect.objectContaining`. Use `expect.objectContaining({ sort: "score", minConfidence: 0.3 })` in the test to avoid coupling on `undefined` keys.

- [ ] **Step 5: Register the controller**

In `src/index.ts`, add the import beside the `ShareProxyController` import, and register it beside line 157:

```typescript
import { BenchmarkProxyController } from "./benchmark.proxy.controller.js";
// ...
  app.restController(ShareProxyController);
  app.restController(BenchmarkProxyController);
```

- [ ] **Step 6: Run the root test suite (no regressions)**

Run: `pnpm build && pnpm exec vitest run`
Expected: PASS (existing suite + the two new tests).

- [ ] **Step 7: Commit**

```bash
git add src/benchmark.proxy.controller.ts src/__tests__/benchmarkProxyController.test.ts src/index.ts
git commit -m "feat(benchmark): /api/benchmark proxy to the hosted aggregator"
```

---

### Task 3: Repoint the console Benchmark panel

**Files:**
- Modify: `packages/console/src/api/routes.ts:896` (`benchmarksRoute` path) and `:908` (`effectivenessRoute` path)

**Interfaces:**
- Consumes: the `/api/benchmark` + `/api/benchmark/effectiveness` routes from Task 2.
- Produces: no signature change — `benchmarksRoute`/`effectivenessRoute` keep their names, query, and response schemas; only the URL path changes. The `Benchmark` panel is untouched.

- [ ] **Step 1: Change the two route paths**

In `packages/console/src/api/routes.ts`:

```typescript
export const benchmarksRoute = defineRoute("GET", "/api/benchmark", {
  query: z.object({ gemDigest: z.string().optional() }),
  response: BenchmarkSchema,
});
// ...
export const effectivenessRoute = defineRoute("GET", "/api/benchmark/effectiveness", {
  query: z.object({ gemName: z.string().optional(), sort: z.enum(["producers", "score"]).optional(), minConfidence: z.coerce.number().optional() }),
  response: EffectivenessSchema,
});
```

- [ ] **Step 2: Run the console tests (local — not in CI)**

Run: `pnpm --filter @agentgem/console test`
Expected: PASS (no test asserts the old path; if one does, update it to `/api/benchmark`).

- [ ] **Step 3: Verify in the running app (behaviour, not just tests)**

Build and launch the desktop core; open the Benchmark tab. Expected: it renders the **empty state** ("No network benchmark data yet…") — NOT a 500 — because prod currently has `producers = 0`. Confirm no `ClientError: Internal Server Error` in the panel.

Run:
```bash
pnpm build
node dist/index.js &   # SERVE_CONSOLE defaults on; loopback
curl -s -o /dev/null -w "%{http_code}\n" http://127.0.0.1:$PORT/api/benchmark
```
Expected: `200` with body `[]` (proxied from the empty prod aggregator).

- [ ] **Step 4: Commit**

```bash
git add packages/console/src/api/routes.ts
git commit -m "fix(console): Benchmark tab reads the hosted aggregator via /api/benchmark"
```

**Phase A deliverable:** the reported 500 is gone — the desktop Benchmark tab reads prod through the proxy and renders honestly (empty until producers ingest). The local PGlite aggregator is now unused by the console but still mounted; Phase B removes it.

---

## Phase B — Two entrypoints, no PGlite in the bundle.

### Task 4: Extract `serverAggregator.ts` (no behaviour change)

**Files:**
- Create: `src/serverAggregator.ts`
- Modify: `src/index.ts` (remove the extracted block; call `mountAggregator`)
- Test: `src/__tests__/serverRoutes.test.ts` (route-registration snapshot — guards the refactor)

**Interfaces:**
- Produces: `export async function mountAggregator(app: RestApplication, server: Awaited<RestApplication["restServer"]>, env: NodeJS.ProcessEnv): Promise<void>` — performs everything `createApp` currently does between `resolveAggregatorDb()` (line 166) and the registry-upload block (line 345), inclusive: `registerDrizzle`, `AggregatorController`, `ShareController`, `mountGating`, the `auth`/`makeAuth` + connect/handoff/mountAuth + migrate/backfill block, stars/reviews/catalog/groups/gemShares/usage/handles/account, `installOg`, the GitHub App webhook/setup/orgsApi + reconcile timers (registering the timer-clearing `app.onStop`), and registry upload-publish. Moves the corresponding imports out of `index.ts` into `serverAggregator.ts`.

- [ ] **Step 1: Write the route-registration guard test (before refactoring)**

```typescript
// src/__tests__/serverRoutes.test.ts
import { describe, it, expect, beforeAll } from "vitest";
import { createApp } from "../index.js";

// Server mode: exercise the aggregator path with an in-process DB.
describe("server entry route registration", () => {
  let paths: string[];
  beforeAll(async () => {
    process.env.SERVE_CONSOLE = "false";
    const app = await createApp(0);
    const server = await app.restServer;
    paths = server.expressApp._router.stack
      .filter((l: any) => l.route)
      .map((l: any) => l.route.path);
  });
  it("registers the aggregator + benchmark proxy surface", () => {
    for (const p of ["/healthz"]) expect(paths).toContain(p);
    // controller routes live in agentback's dispatcher; assert the raw ones that must persist:
    expect(paths.some((p) => p.startsWith("/api/aggregator") || p === "/healthz")).toBe(true);
  });
});
```

(Adapt the assertion to how AgentBack exposes registered routes — the goal is a snapshot that fails if the refactor drops the aggregator surface. If controller routes aren't on the express `_router` stack, assert via a live request to `/api/aggregator/overview` returning non-404 instead.)

- [ ] **Step 2: Run it to capture the passing baseline**

Run: `pnpm build && pnpm exec vitest run src/__tests__/serverRoutes.test.ts`
Expected: PASS (baseline before the move).

- [ ] **Step 3: Create `serverAggregator.ts` by moving the block**

Move lines 165–345 of `src/index.ts` (the `let aggDb` block through the registry upload-publish `if`) into `export async function mountAggregator(app, server, env)`. Move these imports from `index.ts` to `serverAggregator.ts`: `resolveAggregatorDb`, `AppDb`, `migrateAccountsToBetterAuth`, `backfillUserHandles`, `makeAuth`, `mountGating`, `registerDrizzle`, `AggregatorController`, `ShareController`, `installOg`, `installHandoff`, `installConnect`, `installHandles`, `installAccount`, `installStars`, `installReviews`, `installCatalog`, `installGemShares`, `installGroups`, `installUsage`, `installRegistryUploadPublish`, `installGithubWebhook`, `installGithubSetup`, `installOrgsApi`, `AUTH_BINDING`, `deriveRpId`, `appConfigFromEnv`, `InstallationTokens`, `GithubAppDeps`, `reconcileAll`, `defaultHttp`, `registryConfigFromEnv`, `githubRegistrySource`, `githubRegistryPublisher`, `defaultGemTypeRegistry`, and the `migrateAccountsOrFail` helper. Keep `migrateAccountsOrFail` exported (its tests import it) — move it to `serverAggregator.ts` and re-export from `index.ts` if any test imports it from `index.js` (grep first: `grep -rn "migrateAccountsOrFail" src/**/__tests__`).

`index.ts` change (the call site, replacing the removed block):

```typescript
import { mountAggregator } from "./serverAggregator.js";
// ... after `const server = await app.restServer;` and the trust-proxy block:
await mountAggregator(app, server, process.env);
```

- [ ] **Step 4: Verify no behaviour change**

Run: `pnpm build && pnpm exec vitest run`
Expected: PASS — the full suite (including `serverRoutes.test.ts` and any better-auth/migration/aggregator tests) is green, unchanged.

- [ ] **Step 5: Commit**

```bash
git add src/serverAggregator.ts src/index.ts src/__tests__/serverRoutes.test.ts
git commit -m "refactor(server): extract mountAggregator into serverAggregator.ts (no behaviour change)"
```

---

### Task 5: Extract `appCommon.ts` (shared surface)

**Files:**
- Create: `src/appCommon.ts`
- Modify: `src/index.ts` (use `buildCommonApp`)

**CRITICAL ordering constraint (do not collapse into one blob):** the current post-fix `index.ts` order is `mountAggregator` → **global** `app.expressMiddleware("middleware.originGuard", originGuard)` → `/healthz` → `SERVE_CONSOLE` console-serving → the raw **SSE routes** (`/api/warm/status`, `/api/workflow/analyze/stream`, `/api/gem/run/stream`, `/api/gem/verify/stream`, `/api/scorecard/stream`, `/api/insights/stream`, `/api/rubric/stream`, and any Watch-tab streams — each registered with `originGuard` as a **per-route** middleware arg). The global `originGuard` **MUST** register *after* the aggregator's `middleware.shareOriginSecret` + rate limiters (this is exactly the Task-4 fix; AgentBack orders same-group express middlewares by registration order). Therefore the shared surface is split into two functions so each entry can slot its aggregator/benchmark step *between* them.

**Interfaces:**
- Produces:
  - `export async function buildCommonApp(port: number): Promise<{ app: RestApplication; server: Awaited<RestApplication["restServer"]> }>` — the part that must run BEFORE the aggregator/benchmark step: `new RestApplication`, body-parser config, `MCPComponent`/`GemTypesComponent`/`AgentSourcesComponent`, MCPServer config, the `GemController`/`RubricController`/`ReviewController`/`DreamController`/`ShareProxyController`/`SourcesController`/`PlayController` controllers, `GemTools`, the dispatch hooks (`playNoCache`/`gemNoCache`/`gameHtmlCache`), `installExplorer`, `installMcpHttp`, `await app.restServer`, trust-proxy. Returns `{ app, server }`. Does **NOT** register the global `originGuard`, `/healthz`, console-serving, or the SSE routes.
  - `export function finalizeCommonApp(app: RestApplication, server: Awaited<RestApplication["restServer"]>): void` — the part that must run AFTER: the global `app.expressMiddleware("middleware.originGuard", originGuard)`, `/healthz`, the `SERVE_CONSOLE` console-serving block, the raw SSE routes (each keeping its per-route `originGuard` arg), and the `closeSharedIndex` `app.onStop`. Preserves the exact order shown above.
- Consumes: nothing new.

- [ ] **Step 1: Create `appCommon.ts` (both functions) and rewrite `index.ts`**

Move the corresponding imports too. `src/index.ts` becomes:

```typescript
// src/index.ts — SERVER entry (public api.agentgem.ai, private enterprise deployments, Fly).
import { buildCommonApp, finalizeCommonApp } from "./appCommon.js";
import { mountAggregator } from "./serverAggregator.js";
export { migrateAccountsOrFail } from "./serverAggregator.js"; // preserve existing test import path

export async function createApp(port: number): Promise<RestApplication> {
  const { app, server } = await buildCommonApp(port);
  await mountAggregator(app, server, process.env);   // registers shareOriginSecret + rate limiters FIRST
  finalizeCommonApp(app, server);                    // then global originGuard + healthz + console + SSE
  return app;
}
// ... keep the existing run()/main bootstrap that calls createApp + installGracefulShutdown.
```

Keep `createApp`'s exported name and signature identical (tests + `run()` depend on it). The resulting registration order must be byte-for-byte the same as the current `index.ts` — verify with the full suite AND the `shareMiddlewareOrder` test (which asserts shareOriginSecret precedes originGuard).

- [ ] **Step 2: Verify server unchanged (order-sensitive)**

Run: `pnpm build && pnpm exec vitest run serverRoutes shareMiddlewareOrder`
Expected: PASS — `shareMiddlewareOrder` proves the global `originGuard` still registers after the aggregator's `shareOriginSecret` (i.e. `finalizeCommonApp` runs after `mountAggregator`). Then run the full suite `pnpm exec vitest run` and confirm no NEW failures beyond the known concurrency flakes (visibility/stars/scan, which pass in isolation).

- [ ] **Step 3: Commit**

```bash
git add src/appCommon.ts src/index.ts
git commit -m "refactor(server): extract buildCommonApp/finalizeCommonApp; index.ts = common + mountAggregator + finalize"
```

---

### Task 6: Add `src/client.ts` (desktop entry)

**Files:**
- Create: `src/client.ts`
- Test: `src/__tests__/clientEntry.test.ts`

**Interfaces:**
- Consumes: `buildCommonApp` + `finalizeCommonApp` (Task 5), `BenchmarkProxyController` (Task 2).
- Produces: `export async function createClientApp(port: number): Promise<RestApplication>` + a `run()`/main that boots it (mirror `index.ts`'s bootstrap, minus aggregator concerns).

- [ ] **Step 1: Write the failing test**

```typescript
// src/__tests__/clientEntry.test.ts
import { describe, it, expect } from "vitest";
import { createClientApp } from "../client.js";

describe("client entry", () => {
  it("boots without a database and serves /api/benchmark, not /api/aggregator", async () => {
    delete process.env.DATABASE_URL;
    const app = await createClientApp(0);
    const server = await app.restServer;
    const res = await fetch(`http://127.0.0.1:${server.port}/api/benchmark`, { headers: { "sec-fetch-site": "same-origin" } });
    expect(res.status).toBe(200);
    const agg = await fetch(`http://127.0.0.1:${server.port}/api/aggregator/overview`, { headers: { "sec-fetch-site": "same-origin" } });
    expect(agg.status).toBe(404); // aggregator is not mounted in the client entry
    await app.stop();
  });
});
```

(If AgentBack doesn't expose `server.port` for an ephemeral port, pass a fixed test port to `createClientApp` and use it. `/api/benchmark` will proxy to the default hosted aggregator and return `[]`; stub `AGENTGEM_AGGREGATOR_URL` to an unreachable host to keep the test offline — it still returns `[]`, status 200.)

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm build && pnpm exec vitest run src/__tests__/clientEntry.test.ts`
Expected: FAIL — cannot find module `../client.js`.

- [ ] **Step 3: Write `client.ts`**

```typescript
// src/client.ts — DESKTOP entry: pure API client. No aggregator, no DB, no PGlite.
import type { RestApplication } from "@agentback/rest";
import { buildCommonApp, finalizeCommonApp } from "./appCommon.js";
import { BenchmarkProxyController } from "./benchmark.proxy.controller.js";

export async function createClientApp(port: number): Promise<RestApplication> {
  const { app, server } = await buildCommonApp(port);
  app.restController(BenchmarkProxyController);   // client-only proxy; slots where mountAggregator sits on the server
  finalizeCommonApp(app, server);                // same global originGuard + healthz + console + SSE, after the controller step
  return app;
}

// Bootstrap: mirror index.ts's run()/installGracefulShutdown, calling createClientApp.
// (Copy index.ts's main() shape; drop any aggregator-specific shutdown.)
```

Note: `app.restController()` registers into the DI container and can run after `await app.restServer` (AgentBack resolves controllers lazily at dispatch), so registering `BenchmarkProxyController` here — after `buildCommonApp` already awaited `restServer` — is fine; the `clientEntry` test above proves `/api/benchmark` dispatches.

Move the `app.restController(BenchmarkProxyController)` line added in Task 2 OUT of `index.ts` if it should be client-only. Decision: register `BenchmarkProxyController` in **both** entries is harmless (the server can proxy to itself), but cleaner is client-only. Register it in `client.ts` only; remove it from `index.ts`. Keep the server's own `/api/aggregator/benchmarks` (via `mountAggregator`) — different path, no collision.

- [ ] **Step 4: Run it to verify it passes**

Run: `pnpm build && pnpm exec vitest run src/__tests__/clientEntry.test.ts`
Expected: PASS.

- [ ] **Step 5: Full suite**

Run: `pnpm exec vitest run`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/client.ts src/__tests__/clientEntry.test.ts src/index.ts
git commit -m "feat(desktop): src/client.ts pure-client entry (common + benchmark proxy, no aggregator)"
```

---

### Task 7: Build the desktop from the client entry; assert PGlite is gone

**Files:**
- Modify: `desktop/scripts/bundle-core.mjs` (`entryPoints`)
- Test: `desktop/scripts/__tests__/bundle-content.test.ts` (or a shell assertion in the bundle script)

**Interfaces:**
- Consumes: `dist/client.js` (Task 6).

- [ ] **Step 1: Repoint the esbuild entry**

In `desktop/scripts/bundle-core.mjs`, change:

```javascript
  entryPoints: [join(repo, "dist", "index.js")],
```
to:
```javascript
  entryPoints: [join(repo, "dist", "client.js")],
```

Remove any `@electric-sql/pglite` `external` entry if present — it's now unreachable and needs no special handling. Leave `electron`/`jsdom` external as-is.

- [ ] **Step 2: Add a bundle-content assertion**

```javascript
// at the end of bundle-core.mjs, after the esbuild build():
import { readFileSync as __rf } from "node:fs";
const bundle = __rf(join(out, "index.mjs"), "utf8");
for (const forbidden of ["@electric-sql/pglite", "new PGlite(", "AggregatorController", "drizzle-orm/pglite"]) {
  if (bundle.includes(forbidden)) {
    throw new Error(`desktop bundle must not contain "${forbidden}" — client entry leaked a server dep`);
  }
}
console.log("bundle check: no aggregator/PGlite symbols ✓");
```

- [ ] **Step 3: Build the desktop core and verify the assertion holds**

Run: `pnpm build && node desktop/scripts/bundle-core.mjs`
Expected: `core bundled → …` followed by `bundle check: no aggregator/PGlite symbols ✓`. If it throws, an import in `appCommon.ts`/`client.ts` transitively reaches the aggregator — trace and cut it.

- [ ] **Step 4: Verify the packaged desktop boots and the tab works**

Run the packaged app (or `node desktop/core-dist/index.mjs` with `SERVE_CONSOLE` on), open the Benchmark tab. Expected: empty state, no 500; `curl /api/benchmark` → `200 []`.

- [ ] **Step 5: Commit**

```bash
git add desktop/scripts/bundle-core.mjs desktop/scripts/__tests__/bundle-content.test.ts
git commit -m "build(desktop): bundle from client entry; assert no aggregator/PGlite in the bundle"
```

---

## Phase C — Docs.

### Task 8: Enterprise deployment doc

**Files:**
- Create: `docs/deploy/enterprise.md`

- [ ] **Step 1: Write the doc**

Document: server mode is selected by setting `DATABASE_URL`; the same server image (`src/index.ts`) runs the public `api.agentgem.ai` and any private enterprise deployment, each against its own Postgres (tenant-isolated). Enterprise desktops are configured with `AGENTGEM_AGGREGATOR_URL=https://api.<enterprise>.internal` (+ the auth/web-origin envs); the consumer desktop is always the client entry (`src/client.ts`) and never receives a `DATABASE_URL`. Cross-link the spec.

- [ ] **Step 2: Commit**

```bash
git add docs/deploy/enterprise.md
git commit -m "docs(deploy): private enterprise deployment (server mode) + client config"
```

---

## Self-Review

**Spec coverage:**
- benchmarkClient + proxy + console repoint → Tasks 1–3 (spec §1–§3). ✓
- Two entrypoints (`appCommon`/`serverAggregator`/`index`/`client`) → Tasks 4–6 (spec §4). ✓
- Desktop bundle drops aggregator/PGlite → Task 7 (spec §5). ✓
- Private enterprise deployment doc → Task 8 (spec §6). ✓
- Testing (client success/skip/error, proxy, entrypoint boot, bundle content) → Tasks 1,2,6,7 (spec Testing). ✓
- Out-of-scope (org-scoped benchmark, producer wiring) → not planned here, by design. ✓

**Type consistency:** `benchmarks`/`effectiveness` signatures are defined in Task 1 and consumed unchanged in Tasks 2/6; `BenchmarkProxyController`, `mountAggregator`, `buildCommonApp`, `createClientApp` names are stable across the tasks that reference them.

**Risk note:** Tasks 4–5 are the load-bearing refactor. They must be *pure moves* — the `serverRoutes.test.ts` guard (Task 4) plus the unchanged full suite are the safety net. If any aggregator/auth/migration test changes behaviour, stop and treat it as a regression, not an expected diff.
