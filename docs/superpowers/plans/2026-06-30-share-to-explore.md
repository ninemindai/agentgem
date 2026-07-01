# Share to Explore Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a browse-only "Share to Explore" verb that writes a gem's manifest metadata into the hosted aggregator DB (attributed via the producer-key binding), so it appears on `app.agentgem.ai` without a per-user GitHub registry.

**Architecture:** The local console signs a manifest payload with its ed25519 producer key and forwards it to the hosted aggregator, which verifies the signature, resolves the signer's GitHub login from `account_bindings`, and upserts a `catalog_gems` row. A new console "Connect GitHub" device-flow control establishes that binding. `GET /api/registry/gems` merges DB rows with the existing GitHub registry index. Registry publish is untouched.

**Tech Stack:** TypeScript (ESM, Node ≥22), AgentBack (`@agentback/openapi` decorators), Drizzle (Postgres/pglite), Zod, ed25519 (`@agentgem/model`), Vitest, React (`packages/console`, `packages/marketplace`).

## Global Constraints

- Node ≥22, ESM only; all local imports end in `.js`.
- Vitest runs **compiled** tests from `dist/`. After renames/moves run `pnpm clean` before `pnpm test`. Run `pnpm test` (root) — it runs `tsc -b && vitest run`.
- Grade is clamped to `1..3` (mirror `RegistryGemSchema`: `z.number().int().min(1).max(3)`).
- Attribution is **server-derived**: `published_by` comes only from the `account_bindings` lookup; any client-supplied author string is metadata, never ownership.
- Signing payloads use `canonicalJSON` (from `@agentgem/insight`) with a freshness window (mirror `recordBinding`'s `FRESHNESS_MS = 300_000`).
- Commit author is `Raymond Feng <raymond@ninemind.ai>`. End commit messages with the Co-Authored-By trailer.
- The hosted aggregator base is `AGENTGEM_AGGREGATOR_URL` (default `https://api.agentgem.ai`), the same resolution `shareClient.ts` uses.
- Producer key: `loadOrCreateIdentity()` from `@agentgem/model` → `{ publicKey, sign(data) }`; verify with `verify(publicKey, data, sigB64)`.

---

## File Structure

**Phase 1 — Connect GitHub (device flow):**
- Create `src/explore/bindingFile.ts` — read/write `~/.agentgem/binding.json`.
- Create `src/explore/connectCore.ts` — device-flow → sign → forward-to-hosted-bind (pure, injected deps).
- Create `src/explore.controller.ts` — same-origin console endpoints: `/api/explore/connect/start`, `/api/explore/connect/finish`, `/api/explore/identity`.
- Modify `src/index.ts` — mount `ExploreController`.

**Phase 2 — DB catalog:**
- Modify `packages/aggregator/src/schema.ts` — `catalog_gems` table + `ensureSchema` DDL + register in `schema`.
- Create `packages/aggregator/src/catalog.ts` — `catalogSigningPayload`, `recordCatalogShare`, `listCatalogGems`, types.
- Modify `packages/aggregator/src/index.ts` — export `./catalog.js`.
- Modify `src/aggregator.controller.ts` — `POST /api/aggregator/catalog`.
- Modify `src/gem/publicCatalog.ts` — `installable` on `RegistryGem`; `mapDbToGems`; merge helper.
- Modify `src/schemas.ts` — `installable` on `RegistryGemSchema`.
- Modify `src/gem.controller.ts` — `registryGems` merges DB + index; `playbookPublish` signs + forwards to hosted catalog.
- Create `src/gem/catalogShareClient.ts` — signs manifest, POSTs to hosted `/api/aggregator/catalog`.
- Modify `packages/console/src/panels/Curate/PublishToExplore.tsx` — connect gate + rename.
- Modify `packages/marketplace/src/types.ts` + `src/api.ts` — `installable` flag.

---

## Phase 1 — Connect GitHub (device flow)

### Task 1: Binding file read/write

**Files:**
- Create: `src/explore/bindingFile.ts`
- Test: `src/explore/__tests__/bindingFile.test.ts`

**Interfaces:**
- Produces: `interface Binding { provider: string; login: string; accountId: string; boundAt: string }`; `readBinding(dir?: string): Binding | null`; `writeBinding(b: Binding, dir?: string): void`. Default `dir` = `join(homedir(), ".agentgem")`.

- [ ] **Step 1: Write the failing test**

```ts
// src/explore/__tests__/bindingFile.test.ts
import { describe, it, expect } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readBinding, writeBinding } from "../bindingFile.js";

describe("bindingFile", () => {
  it("returns null when no binding file exists", () => {
    const dir = mkdtempSync(join(tmpdir(), "agbind-"));
    expect(readBinding(dir)).toBeNull();
  });

  it("round-trips a written binding", () => {
    const dir = mkdtempSync(join(tmpdir(), "agbind-"));
    const b = { provider: "github", login: "octocat", accountId: "42", boundAt: "2026-06-30T00:00:00.000Z" };
    writeBinding(b, dir);
    expect(readBinding(dir)).toEqual(b);
  });

  it("returns null on malformed json", () => {
    const dir = mkdtempSync(join(tmpdir(), "agbind-"));
    writeBinding({ provider: "github", login: "x", accountId: "1", boundAt: "t" }, dir);
    // corrupt it
    const { writeFileSync } = require("node:fs");
    writeFileSync(join(dir, "binding.json"), "{not json");
    expect(readBinding(dir)).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm clean && pnpm test -- bindingFile`
Expected: FAIL — cannot find module `../bindingFile.js`.

- [ ] **Step 3: Write minimal implementation**

```ts
// src/explore/bindingFile.ts
// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
// Local record of "this machine's producer key is bound to GitHub @login" — mirrors what
// `agentgem bind` writes, so the console and CLI share one source of truth.
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export interface Binding { provider: string; login: string; accountId: string; boundAt: string }

const defaultDir = (): string => join(homedir(), ".agentgem");

export function readBinding(dir: string = defaultDir()): Binding | null {
  try {
    const raw = readFileSync(join(dir, "binding.json"), "utf8");
    const b = JSON.parse(raw) as Partial<Binding>;
    if (typeof b.login === "string" && typeof b.provider === "string" && typeof b.accountId === "string") {
      return { provider: b.provider, login: b.login, accountId: b.accountId, boundAt: String(b.boundAt ?? "") };
    }
    return null;
  } catch {
    return null; // absent or malformed → not connected
  }
}

export function writeBinding(b: Binding, dir: string = defaultDir()): void {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  writeFileSync(join(dir, "binding.json"), JSON.stringify(b), { mode: 0o600 });
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test -- bindingFile`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add src/explore/bindingFile.ts src/explore/__tests__/bindingFile.test.ts
git commit -m "feat(explore): binding.json read/write helper

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 2: Connect core (device-flow → sign → hosted bind)

**Files:**
- Create: `src/explore/connectCore.ts`
- Test: `src/explore/__tests__/connectCore.test.ts`

**Interfaces:**
- Consumes: `bindSigningPayload` (`@agentgem/aggregator`), `Identity` (`@agentgem/model`), `writeBinding`/`Binding` (Task 1).
- Produces:
  - `startConnect(deps: { clientId: string; requestDeviceCode: (id: string) => Promise<DeviceCode> }): Promise<DeviceCode>` where `DeviceCode = { deviceCode: string; userCode: string; verificationUri: string; interval: number }`.
  - `finishConnect(deps: FinishDeps): Promise<{ connected: true; login: string } | { connected: false; rejected: string }>`.
  - `type FinishDeps = { clientId: string; deviceCode: string; interval: number; base: string; identity: Identity; pollForToken: (id: string, code: string, o: { intervalSec: number }) => Promise<string>; http: (url: string, init: { method: string; headers: Record<string,string>; body: string }) => Promise<{ status: number; json(): Promise<unknown> }>; now: () => number; write: (b: Binding) => void }`.

`finishConnect` polls for the token, signs `bindSigningPayload(pubkey, token, signedAt)`, POSTs `{ pubkey, token, signedAt, signature }` to `${base}/api/aggregator/bind`, and on `{bound:true}` calls `write(...)` and returns the login.

- [ ] **Step 1: Write the failing test**

```ts
// src/explore/__tests__/connectCore.test.ts
import { describe, it, expect, vi } from "vitest";
import { finishConnect } from "../connectCore.js";
import type { Identity } from "@agentgem/model";

const identity: Identity = { publicKey: "ed25519:PUB", sign: (d) => "sig(" + d.length + ")" };

function httpReturning(status: number, body: unknown) {
  return vi.fn(async () => ({ status, json: async () => body }));
}

describe("finishConnect", () => {
  it("binds and writes on a successful hosted bind", async () => {
    const write = vi.fn();
    const http = httpReturning(200, { bound: true, provider: "github", login: "octocat", accountId: "42" });
    const res = await finishConnect({
      clientId: "cid", deviceCode: "dc", interval: 5, base: "https://api.agentgem.ai",
      identity, pollForToken: async () => "gh-token", http, now: () => 1_000_000, write,
    });
    expect(res).toEqual({ connected: true, login: "octocat" });
    expect(write).toHaveBeenCalledWith(expect.objectContaining({ provider: "github", login: "octocat", accountId: "42" }));
    // forwarded to the hosted bind endpoint with the signed payload
    const [url, init] = http.mock.calls[0];
    expect(url).toBe("https://api.agentgem.ai/api/aggregator/bind");
    expect(JSON.parse(init.body)).toMatchObject({ pubkey: "ed25519:PUB", token: "gh-token", signedAt: 1_000_000 });
  });

  it("returns rejected without writing when the hosted side refuses", async () => {
    const write = vi.fn();
    const http = httpReturning(200, { bound: false, rejected: "unknown-producer" });
    const res = await finishConnect({
      clientId: "cid", deviceCode: "dc", interval: 5, base: "https://api.agentgem.ai",
      identity, pollForToken: async () => "gh-token", http, now: () => 1, write,
    });
    expect(res).toEqual({ connected: false, rejected: "unknown-producer" });
    expect(write).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test -- connectCore`
Expected: FAIL — cannot find module `../connectCore.js`.

- [ ] **Step 3: Write minimal implementation**

```ts
// src/explore/connectCore.ts
// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
// Console-driven GitHub device flow that binds the local producer key to a verified GitHub
// account on the HOSTED aggregator. Same trust construction as `agentgem bind`, but injectable.
import { bindSigningPayload } from "@agentgem/aggregator";
import type { Identity } from "@agentgem/model";
import type { Binding } from "./bindingFile.js";

export interface DeviceCode { deviceCode: string; userCode: string; verificationUri: string; interval: number }
type Http = (url: string, init: { method: string; headers: Record<string, string>; body: string }) => Promise<{ status: number; json(): Promise<unknown> }>;

export async function startConnect(deps: { clientId: string; requestDeviceCode: (id: string) => Promise<DeviceCode> }): Promise<DeviceCode> {
  return deps.requestDeviceCode(deps.clientId);
}

export interface FinishDeps {
  clientId: string; deviceCode: string; interval: number; base: string;
  identity: Identity;
  pollForToken: (id: string, code: string, o: { intervalSec: number }) => Promise<string>;
  http: Http; now: () => number; write: (b: Binding) => void;
}

export async function finishConnect(deps: FinishDeps): Promise<{ connected: true; login: string } | { connected: false; rejected: string }> {
  const token = await deps.pollForToken(deps.clientId, deps.deviceCode, { intervalSec: deps.interval });
  const signedAt = deps.now();
  const signature = deps.identity.sign(bindSigningPayload(deps.identity.publicKey, token, signedAt));
  const res = await deps.http(`${deps.base}/api/aggregator/bind`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ pubkey: deps.identity.publicKey, token, signedAt, signature }),
  });
  const b = (await res.json()) as { bound?: boolean; provider?: string; login?: string; accountId?: string; rejected?: string };
  if (!b.bound || !b.login || !b.provider || !b.accountId) return { connected: false, rejected: b.rejected ?? "unknown" };
  deps.write({ provider: b.provider, login: b.login, accountId: b.accountId, boundAt: new Date(signedAt).toISOString() });
  return { connected: true, login: b.login };
}
```

> Note: `new Date(signedAt)` uses a numeric arg, which is allowed (only `Date.now()`/argless `new Date()` are restricted, and only inside Workflow scripts — this is app code).

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test -- connectCore`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add src/explore/connectCore.ts src/explore/__tests__/connectCore.test.ts
git commit -m "feat(explore): device-flow connect core (sign + hosted bind)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 3: Console-facing `ExploreController` + mount

**Files:**
- Create: `src/explore.controller.ts`
- Modify: `src/index.ts` (import + `.controller(ExploreController)` registration, near the other controllers)
- Test: `src/explore/__tests__/exploreController.test.ts`

**Interfaces:**
- Consumes: `startConnect`/`finishConnect` (Task 2), `readBinding` (Task 1), `requestDeviceCode`/`pollForToken` (`./bind/deviceFlow.js`), `loadOrCreateIdentity` (`@agentgem/model`), `DEFAULT_AGGREGATOR_URL` resolution (inline, mirroring `shareClient.ts`).
- Produces REST (same-origin, local): `POST /api/explore/connect/start` → `DeviceCode`; `POST /api/explore/connect/finish` body `{ deviceCode, interval }` → `{ connected, login? , rejected? }`; `GET /api/explore/identity` → `{ connected: boolean, login?: string }`.

The controller reads `AGENTGEM_GITHUB_CLIENT_ID`; if unset, `start` throws a typed `Error("set AGENTGEM_GITHUB_CLIENT_ID to connect GitHub")` → surfaced as a clear message (not a silent 500). `finish` resolves the base via `process.env.AGENTGEM_AGGREGATOR_URL ?? "https://api.agentgem.ai"`.

- [ ] **Step 1: Write the failing test** (unit-test the handler methods directly — no HTTP server needed)

```ts
// src/explore/__tests__/exploreController.test.ts
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ExploreController } from "../../explore.controller.js";
import { writeBinding } from "../bindingFile.js";

describe("ExploreController.identity", () => {
  const prev = process.env.AGENTGEM_HOME;
  afterEach(() => { process.env.AGENTGEM_HOME = prev; });

  it("reports connected when a binding file is present", () => {
    const dir = mkdtempSync(join(tmpdir(), "aghome-"));
    process.env.AGENTGEM_HOME = dir;
    writeBinding({ provider: "github", login: "octocat", accountId: "42", boundAt: "t" }, dir);
    const c = new ExploreController();
    expect(c.identity()).toEqual({ connected: true, login: "octocat" });
  });

  it("reports not connected when absent", () => {
    const dir = mkdtempSync(join(tmpdir(), "aghome-"));
    process.env.AGENTGEM_HOME = dir;
    const c = new ExploreController();
    expect(c.identity()).toEqual({ connected: false });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test -- exploreController`
Expected: FAIL — cannot find module `../../explore.controller.js`.

- [ ] **Step 3: Write minimal implementation**

```ts
// src/explore.controller.ts
// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
// Same-origin endpoints the LOCAL console calls to connect GitHub (device flow) and read identity.
// The browser stays same-origin; this controller forwards to the hosted aggregator's /bind.
import { z } from "zod";
import { api, get, post } from "@agentback/openapi";
import { homedir } from "node:os";
import { join } from "node:path";
import { loadOrCreateIdentity } from "@agentgem/model";
import { requestDeviceCode, pollForToken } from "./bind/deviceFlow.js";
import { startConnect, finishConnect } from "./explore/connectCore.js";
import { readBinding } from "./explore/bindingFile.js";

const DeviceCodeSchema = z.object({ deviceCode: z.string(), userCode: z.string(), verificationUri: z.string(), interval: z.number() });
const FinishBody = z.object({ deviceCode: z.string(), interval: z.number() });
const FinishResult = z.object({ connected: z.boolean(), login: z.string().optional(), rejected: z.string().optional() });
const IdentityResult = z.object({ connected: z.boolean(), login: z.string().optional() });

// Test seam: override the ~/.agentgem dir. Mirrors loadOrCreateIdentity's default.
const agentgemDir = (): string => process.env.AGENTGEM_HOME ?? join(homedir(), ".agentgem");
const aggregatorBase = (): string => process.env.AGENTGEM_AGGREGATOR_URL ?? "https://api.agentgem.ai";
function clientId(): string {
  const id = process.env.AGENTGEM_GITHUB_CLIENT_ID;
  if (!id) throw new Error("set AGENTGEM_GITHUB_CLIENT_ID to connect GitHub");
  return id;
}

@api({ basePath: "/api/explore" })
export class ExploreController {
  @post("/connect/start", { response: DeviceCodeSchema })
  async connectStart(): Promise<z.infer<typeof DeviceCodeSchema>> {
    return startConnect({ clientId: clientId(), requestDeviceCode });
  }

  @post("/connect/finish", { body: FinishBody, response: FinishResult })
  async connectFinish(input: { body: z.infer<typeof FinishBody> }): Promise<z.infer<typeof FinishResult>> {
    const dir = agentgemDir();
    const r = await finishConnect({
      clientId: clientId(), deviceCode: input.body.deviceCode, interval: input.body.interval,
      base: aggregatorBase(), identity: loadOrCreateIdentity(dir),
      pollForToken, http: async (url, i) => { const res = await fetch(url, i); return { status: res.status, json: () => res.json() }; },
      now: () => Date.now(), write: (b) => { const { writeBinding } = require("./explore/bindingFile.js"); writeBinding(b, dir); },
    });
    return r.connected ? { connected: true, login: r.login } : { connected: false, rejected: r.rejected };
  }

  @get("/identity", { response: IdentityResult })
  identity(): z.infer<typeof IdentityResult> {
    const b = readBinding(agentgemDir());
    return b ? { connected: true, login: b.login } : { connected: false };
  }
}
```

> Replace the inline `require(...)` for `writeBinding` with a top-level `import { writeBinding } from "./explore/bindingFile.js";` — shown inline only to keep the diff local; prefer the top-level import.

Then wire it in `src/index.ts` alongside the other `.controller(...)` calls (search for `GemController` registration and add next to it):

```ts
import { ExploreController } from "./explore.controller.js";
// ... where controllers are registered:
app.controller(ExploreController);
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test -- exploreController`
Expected: PASS (2 tests).

- [ ] **Step 5: Verify the app boots with the new controller**

Run: `pnpm build && node dist/index.js` (Ctrl-C after the listening line)
Expected: `agentgem listening at http://127.0.0.1:4317` with no controller-registration error. Then in another shell: `curl -s http://127.0.0.1:4317/api/explore/identity` → `{"connected":false}` (on a machine with no binding).

- [ ] **Step 6: Commit**

```bash
git add src/explore.controller.ts src/explore/__tests__/exploreController.test.ts src/index.ts
git commit -m "feat(explore): console connect/start, connect/finish, identity endpoints

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 4: Console "Connect GitHub" control + Share gate

**Files:**
- Create: `packages/console/src/api/exploreRoutes.ts` — `connectStartRoute`, `connectFinishRoute`, `identityRoute` (defineRoute, mirroring `routes.ts`).
- Modify: `packages/console/src/panels/Curate/PublishToExplore.tsx` — rename heading to "Share to Explore", add the connect control + gate.
- Test: `packages/console/src/panels/Curate/PublishToExplore.test.tsx` — add connect-gate cases.

**Interfaces:**
- Consumes: `makeClient` (`../../api/routes.js`), the three explore routes.
- Produces: UI only. The Share submit button is disabled until `identityRoute` reports `connected`.

> **Note on CI:** `packages/console` tests are NOT in root CI (see the ci-skips-console-tests memory). Run them locally: `pnpm --filter @agentgem/console test`.

- [ ] **Step 1: Write the failing test** (add to the existing describe block)

```tsx
// append inside packages/console/src/panels/Curate/PublishToExplore.test.tsx
it("disables Share until GitHub is connected", async () => {
  // identity route returns not-connected
  vi.stubGlobal("fetch", vi.fn(async (url: string) => {
    if (String(url).includes("/api/explore/identity")) return { ok: true, text: async () => JSON.stringify({ connected: false }) } as Response;
    return { ok: true, text: async () => "{}" } as Response;
  }));
  render(<PublishToExplore apiBase="" selected={{}} skillCount={1} lessonCount={0} />);
  const btn = await screen.findByRole("button", { name: /share to explore/i }) as HTMLButtonElement;
  expect(btn.disabled).toBe(true);
  expect(screen.getByText(/connect github/i)).toBeTruthy();
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @agentgem/console test -- PublishToExplore`
Expected: FAIL — button not found / not disabled (current UI has no gate, and the button reads "Publish to explore").

- [ ] **Step 3: Add the routes**

```ts
// packages/console/src/api/exploreRoutes.ts
import { z } from "zod";
import { defineRoute } from "@agentback/client";

export const connectStartRoute = defineRoute("POST", "/api/explore/connect/start", {
  response: z.object({ deviceCode: z.string(), userCode: z.string(), verificationUri: z.string(), interval: z.number() }),
});
export const connectFinishRoute = defineRoute("POST", "/api/explore/connect/finish", {
  body: z.object({ deviceCode: z.string(), interval: z.number() }),
  response: z.object({ connected: z.boolean(), login: z.string().optional(), rejected: z.string().optional() }),
});
export const identityRoute = defineRoute("GET", "/api/explore/identity", {
  response: z.object({ connected: z.boolean(), login: z.string().optional() }),
});
```

- [ ] **Step 4: Implement the gate + connect control in `PublishToExplore.tsx`**

Add near the top of the component body (after existing `useState`s):

```tsx
import { connectStartRoute, connectFinishRoute, identityRoute } from "../../api/exploreRoutes.js";
// ...
const [identity, setIdentity] = useState<{ connected: boolean; login?: string } | null>(null);
const [connecting, setConnecting] = useState<{ userCode: string; verificationUri: string } | null>(null);

useEffect(() => {
  const client = makeClient(apiBase);
  identityRoute.call(client, {}).then(setIdentity).catch(() => setIdentity({ connected: false }));
}, [apiBase]);

const connectGitHub = async () => {
  const client = makeClient(apiBase);
  const dc = await connectStartRoute.call(client, {});
  setConnecting({ userCode: dc.userCode, verificationUri: dc.verificationUri });
  const res = await connectFinishRoute.call(client, { body: { deviceCode: dc.deviceCode, interval: dc.interval } });
  setConnecting(null);
  if (res.connected) setIdentity({ connected: true, login: res.login });
  else setError(res.rejected === "unknown-producer" ? "Share telemetry once first, then connect." : `Connect failed: ${res.rejected}`);
};
```

Render, above the form's submit button:

```tsx
{identity && !identity.connected && (
  <div className="explore-connect">
    <button type="button" onClick={connectGitHub}>Connect GitHub</button>
    {connecting && <p>Open <a href={connecting.verificationUri} target="_blank" rel="noreferrer">{connecting.verificationUri}</a> and enter <code>{connecting.userCode}</code></p>}
  </div>
)}
```

Change the submit button text and disabled condition:

```tsx
<button type="submit" disabled={busy || !identity?.connected}>
  {busy ? "Sharing…" : "Share to explore"}
</button>
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `pnpm --filter @agentgem/console test -- PublishToExplore`
Expected: PASS (existing cases + the new gate case). Update any existing case that asserted the old "Publish to explore" label to "Share to explore".

- [ ] **Step 6: Commit**

```bash
git add packages/console/src/api/exploreRoutes.ts packages/console/src/panels/Curate/PublishToExplore.tsx packages/console/src/panels/Curate/PublishToExplore.test.tsx
git commit -m "feat(console): Connect GitHub control + Share-to-Explore gate

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Phase 2 — DB catalog

### Task 5: `catalog_gems` schema + store helpers

**Files:**
- Modify: `packages/aggregator/src/schema.ts` (add table, register in `schema`, add DDL in `ensureSchema`)
- Create: `packages/aggregator/src/catalog.ts`
- Modify: `packages/aggregator/src/index.ts` (add `export * from "./catalog.js";`)
- Test: `packages/aggregator/src/__tests__/catalog.test.ts`

**Interfaces:**
- Produces:
  - Table `catalogGems` with columns per spec.
  - `interface CatalogRow { gemKey: string; version: string; publishedBy: string; author?: string; description?: string; tags?: string[]; artifactKinds?: string[]; type?: string; grade?: number; createdAtMs: number }`.
  - `upsertCatalogGem(db: AppDb, row: CatalogRow): Promise<void>` — upsert on `(gemKey, version)`.
  - `listCatalogGems(db: AppDb): Promise<CatalogRow[]>` — newest first.

- [ ] **Step 1: Write the failing test**

```ts
// packages/aggregator/src/__tests__/catalog.test.ts
import { describe, it, expect } from "vitest";
import { makeTestDb } from "../testDb.js";
import { upsertCatalogGem, listCatalogGems } from "../catalog.js";

describe("catalog store", () => {
  it("inserts and lists a catalog gem", async () => {
    const db = await makeTestDb();
    await upsertCatalogGem(db, { gemKey: "@octocat/kit", version: "1.0.0", publishedBy: "octocat", description: "d", tags: ["x"], artifactKinds: ["skill"], grade: 2, createdAtMs: 1000 });
    const rows = await listCatalogGems(db);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ gemKey: "@octocat/kit", version: "1.0.0", publishedBy: "octocat", grade: 2, tags: ["x"] });
  });

  it("upserts on (gemKey, version) — no duplicate rows", async () => {
    const db = await makeTestDb();
    await upsertCatalogGem(db, { gemKey: "@o/k", version: "1.0.0", publishedBy: "o", description: "first", createdAtMs: 1 });
    await upsertCatalogGem(db, { gemKey: "@o/k", version: "1.0.0", publishedBy: "o", description: "second", createdAtMs: 2 });
    const rows = await listCatalogGems(db);
    expect(rows).toHaveLength(1);
    expect(rows[0].description).toBe("second");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm clean && pnpm test -- catalog`
Expected: FAIL — cannot find module `../catalog.js`.

- [ ] **Step 3: Add the table + DDL in `schema.ts`**

After the `gemAdoptions` table:

```ts
export const catalogGems = pgTable("catalog_gems", {
  gemKey: text("gem_key").notNull(),
  version: text("version").notNull(),
  publishedBy: text("published_by").notNull(),
  author: text("author"),
  description: text("description"),
  tags: jsonb("tags").$type<string[]>(),
  artifactKinds: jsonb("artifact_kinds").$type<string[]>(),
  type: text("type"),
  grade: integer("grade"),
  createdAtMs: bigint("created_at_ms", { mode: "number" }).notNull(),
}, (t) => [primaryKey({ columns: [t.gemKey, t.version] })]);
```

Add `catalogGems` to the `schema` object literal. In `ensureSchema`, add:

```ts
await db.execute(sql`create table if not exists catalog_gems (gem_key text not null, version text not null, published_by text not null, author text, description text, tags jsonb, artifact_kinds jsonb, type text, grade integer, created_at_ms bigint not null, primary key (gem_key, version))`);
```

- [ ] **Step 4: Write `catalog.ts`**

```ts
// packages/aggregator/src/catalog.ts
// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
// Browse-only "shared" gem catalog. Manifest metadata only (no archive bytes).
import { sql } from "drizzle-orm";
import type { AppDb } from "./schema.js";
import { catalogGems } from "./schema.js";

export interface CatalogRow {
  gemKey: string; version: string; publishedBy: string;
  author?: string; description?: string; tags?: string[]; artifactKinds?: string[];
  type?: string; grade?: number; createdAtMs: number;
}

export async function upsertCatalogGem(db: AppDb, row: CatalogRow): Promise<void> {
  await db.insert(catalogGems).values({
    gemKey: row.gemKey, version: row.version, publishedBy: row.publishedBy,
    author: row.author ?? null, description: row.description ?? null,
    tags: row.tags ?? null, artifactKinds: row.artifactKinds ?? null,
    type: row.type ?? null, grade: row.grade ?? null, createdAtMs: row.createdAtMs,
  }).onConflictDoUpdate({
    target: [catalogGems.gemKey, catalogGems.version],
    set: {
      publishedBy: row.publishedBy, author: row.author ?? null, description: row.description ?? null,
      tags: row.tags ?? null, artifactKinds: row.artifactKinds ?? null, type: row.type ?? null,
      grade: row.grade ?? null, createdAtMs: row.createdAtMs,
    },
  });
}

export async function listCatalogGems(db: AppDb): Promise<CatalogRow[]> {
  const rows = await db.select().from(catalogGems).orderBy(sql`created_at_ms desc`);
  return rows.map((r) => ({
    gemKey: r.gemKey, version: r.version, publishedBy: r.publishedBy,
    author: r.author ?? undefined, description: r.description ?? undefined,
    tags: r.tags ?? undefined, artifactKinds: r.artifactKinds ?? undefined,
    type: r.type ?? undefined, grade: r.grade ?? undefined, createdAtMs: r.createdAtMs,
  }));
}
```

Add to `packages/aggregator/src/index.ts`:

```ts
export * from "./catalog.js";
```

- [ ] **Step 5: Run test to verify it passes**

Run: `pnpm clean && pnpm test -- catalog`
Expected: PASS (2 tests).

- [ ] **Step 6: Commit**

```bash
git add packages/aggregator/src/schema.ts packages/aggregator/src/catalog.ts packages/aggregator/src/index.ts packages/aggregator/src/__tests__/catalog.test.ts
git commit -m "feat(aggregator): catalog_gems table + upsert/list store

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 6: `catalogSigningPayload` + `recordCatalogShare` (verify → bind lookup → upsert)

**Files:**
- Modify: `packages/aggregator/src/catalog.ts` (add signing payload + record fn)
- Test: `packages/aggregator/src/__tests__/catalogShare.test.ts`

**Interfaces:**
- Consumes: `verify` (`@agentgem/model`), `canonicalJSON` (`@agentgem/insight`), `producers`/`accountBindings` tables, `upsertCatalogGem` (Task 5).
- Produces:
  - `interface CatalogManifest { gemKey: string; version: string; author?: string; description?: string; tags?: string[]; artifactKinds?: string[]; type?: string; grade?: number }`.
  - `catalogSigningPayload(m: CatalogManifest, pubkey: string, signedAt: number): string`.
  - `interface ShareRequest { manifest: CatalogManifest; pubkey: string; signedAt: number; signature: string }`.
  - `type ShareResult = { shared: true; publishedBy: string; gemKey: string; version: string } | { shared: false; rejected: "bad-signature" | "stale" | "not-connected" }`.
  - `recordCatalogShare(db: AppDb, req: ShareRequest, now?: number): Promise<ShareResult>` — verifies signature, freshness (`FRESHNESS_MS = 300_000`), upserts the `producers` row for `pubkey` (bootstrap), looks up `account_bindings`; missing → `not-connected`; else `upsertCatalogGem` with `publishedBy = binding.account_login`, `grade` clamped to `1..3`.

- [ ] **Step 1: Write the failing test**

```ts
// packages/aggregator/src/__tests__/catalogShare.test.ts
import { describe, it, expect } from "vitest";
import { generateKeyPairSync, sign as edSign } from "node:crypto";
import { makeTestDb } from "../testDb.js";
import { producers, accountBindings } from "../schema.js";
import { catalogSigningPayload, recordCatalogShare, listCatalogGems, type CatalogManifest } from "../catalog.js";

function signer() {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const pubkey = "ed25519:" + publicKey.export({ format: "der", type: "spki" }).toString("base64");
  return { pubkey, sign: (d: string) => edSign(null, Buffer.from(d, "utf8"), privateKey).toString("base64") };
}
const M: CatalogManifest = { gemKey: "@octocat/kit", version: "1.0.0", description: "d", grade: 5 };

describe("recordCatalogShare", () => {
  it("rejects not-connected when no binding exists", async () => {
    const db = await makeTestDb();
    const s = signer();
    const now = 1_000_000;
    const sig = s.sign(catalogSigningPayload(M, s.pubkey, now));
    const res = await recordCatalogShare(db, { manifest: M, pubkey: s.pubkey, signedAt: now, signature: sig }, now);
    expect(res).toEqual({ shared: false, rejected: "not-connected" });
  });

  it("shares with server-derived publishedBy + clamped grade when bound", async () => {
    const db = await makeTestDb();
    const s = signer();
    await db.insert(producers).values({ pubkey: s.pubkey });
    await db.insert(accountBindings).values({ pubkey: s.pubkey, provider: "github", accountId: "42", accountLogin: "octocat" });
    const now = 1_000_000;
    const sig = s.sign(catalogSigningPayload(M, s.pubkey, now));
    const res = await recordCatalogShare(db, { manifest: M, pubkey: s.pubkey, signedAt: now, signature: sig }, now);
    expect(res).toEqual({ shared: true, publishedBy: "octocat", gemKey: "@octocat/kit", version: "1.0.0" });
    const rows = await listCatalogGems(db);
    expect(rows[0]).toMatchObject({ publishedBy: "octocat", grade: 3 }); // 5 clamped to 3
  });

  it("rejects a bad signature", async () => {
    const db = await makeTestDb();
    const s = signer();
    const now = 1_000_000;
    const res = await recordCatalogShare(db, { manifest: M, pubkey: s.pubkey, signedAt: now, signature: "AA==" }, now);
    expect(res).toEqual({ shared: false, rejected: "bad-signature" });
  });

  it("rejects a stale signedAt", async () => {
    const db = await makeTestDb();
    const s = signer();
    const signedAt = 1_000_000;
    const sig = s.sign(catalogSigningPayload(M, s.pubkey, signedAt));
    const res = await recordCatalogShare(db, { manifest: M, pubkey: s.pubkey, signedAt, signature: sig }, signedAt + 400_000);
    expect(res).toEqual({ shared: false, rejected: "stale" });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm clean && pnpm test -- catalogShare`
Expected: FAIL — `catalogSigningPayload`/`recordCatalogShare` not exported.

- [ ] **Step 3: Add to `catalog.ts`**

```ts
import { createHash } from "node:crypto";
import { verify } from "@agentgem/model";
import { canonicalJSON } from "@agentgem/insight";
import { producers, accountBindings } from "./schema.js";

export interface CatalogManifest {
  gemKey: string; version: string; author?: string; description?: string;
  tags?: string[]; artifactKinds?: string[]; type?: string; grade?: number;
}
export interface ShareRequest { manifest: CatalogManifest; pubkey: string; signedAt: number; signature: string }
export type ShareResult =
  | { shared: true; publishedBy: string; gemKey: string; version: string }
  | { shared: false; rejected: "bad-signature" | "stale" | "not-connected" };

const FRESHNESS_MS = 300_000;
const clampGrade = (g?: number): number | undefined => (g === undefined ? undefined : Math.max(1, Math.min(3, Math.trunc(g))));

// Sign over a hash of the manifest so the canonical (loggable) payload stays compact and stable.
export function catalogSigningPayload(m: CatalogManifest, pubkey: string, signedAt: number): string {
  const manifestHash = createHash("sha256").update(canonicalJSON(m)).digest("hex");
  return canonicalJSON({ pubkey, signedAt, manifestHash });
}

export async function recordCatalogShare(db: AppDb, req: ShareRequest, now: number = Date.now()): Promise<ShareResult> {
  if (!verify(req.pubkey, catalogSigningPayload(req.manifest, req.pubkey, req.signedAt), req.signature)) {
    return { shared: false, rejected: "bad-signature" };
  }
  if (!Number.isFinite(req.signedAt) || Math.abs(now - req.signedAt) > FRESHNESS_MS) {
    return { shared: false, rejected: "stale" };
  }
  // Bootstrap: register the producer so a first-time desktop can share (mirrors ingest's implicit
  // producer creation). No-op if it already exists.
  await db.insert(producers).values({ pubkey: req.pubkey }).onConflictDoNothing();
  const bind = await db.select().from(accountBindings).where(sql`pubkey = ${req.pubkey}`);
  const login = bind[0]?.accountLogin;
  if (!login) return { shared: false, rejected: "not-connected" };
  const m = req.manifest;
  await upsertCatalogGem(db, {
    gemKey: m.gemKey, version: m.version, publishedBy: login,
    author: m.author, description: m.description, tags: m.tags, artifactKinds: m.artifactKinds,
    type: m.type, grade: clampGrade(m.grade), createdAtMs: now,
  });
  return { shared: true, publishedBy: login, gemKey: m.gemKey, version: m.version };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm clean && pnpm test -- catalogShare`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/aggregator/src/catalog.ts packages/aggregator/src/__tests__/catalogShare.test.ts
git commit -m "feat(aggregator): recordCatalogShare — verify sig, bind lookup, server-derived publishedBy

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 7: Hosted `POST /api/aggregator/catalog` endpoint

**Files:**
- Modify: `src/aggregator.controller.ts` (import + schemas + method)
- Test: `src/aggregator/__tests__/catalogController.test.ts`

**Interfaces:**
- Consumes: `recordCatalogShare` (Task 6), `AppDb`.
- Produces REST: `POST /api/aggregator/catalog` body `{ manifest, pubkey, signedAt, signature }` → `{ shared: boolean, publishedBy?, rejected? }`. On `not-connected` the HTTP layer stays 200 with `{shared:false,rejected:"not-connected"}` (the console maps it to a "connect first" message — same shape as `/bind`).

- [ ] **Step 1: Write the failing test** (construct the controller with a test db, call the method)

```ts
// src/aggregator/__tests__/catalogController.test.ts
import { describe, it, expect } from "vitest";
import { generateKeyPairSync, sign as edSign } from "node:crypto";
import { makeTestDb, producers, accountBindings, catalogSigningPayload } from "@agentgem/aggregator";
import { AggregatorController } from "../../aggregator.controller.js";

function signer() {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const pubkey = "ed25519:" + publicKey.export({ format: "der", type: "spki" }).toString("base64");
  return { pubkey, sign: (d: string) => edSign(null, Buffer.from(d, "utf8"), privateKey).toString("base64") };
}

describe("AggregatorController.catalog", () => {
  it("shares a bound producer's manifest", async () => {
    const db = await makeTestDb();
    const s = signer();
    await db.insert(producers).values({ pubkey: s.pubkey });
    await db.insert(accountBindings).values({ pubkey: s.pubkey, provider: "github", accountId: "1", accountLogin: "octocat" });
    const c = new AggregatorController(db);
    const manifest = { gemKey: "@octocat/kit", version: "1.0.0", description: "d" };
    const signedAt = Date.now();
    const signature = s.sign(catalogSigningPayload(manifest, s.pubkey, signedAt));
    const res = await c.catalog({ body: { manifest, pubkey: s.pubkey, signedAt, signature } });
    expect(res).toMatchObject({ shared: true, publishedBy: "octocat" });
  });

  it("returns not-connected for an unbound producer", async () => {
    const db = await makeTestDb();
    const s = signer();
    const c = new AggregatorController(db);
    const manifest = { gemKey: "@x/y", version: "1.0.0" };
    const signedAt = Date.now();
    const signature = s.sign(catalogSigningPayload(manifest, s.pubkey, signedAt));
    const res = await c.catalog({ body: { manifest, pubkey: s.pubkey, signedAt, signature } });
    expect(res).toMatchObject({ shared: false, rejected: "not-connected" });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm clean && pnpm test -- catalogController`
Expected: FAIL — `c.catalog` is not a function.

- [ ] **Step 3: Add the endpoint to `aggregator.controller.ts`**

Add the import (with the other `@agentgem/aggregator` imports):

```ts
import { recordCatalogShare } from "@agentgem/aggregator";
```

Add the schemas (near the top, with the other `const ...Body`/`...Result` schemas):

```ts
const CatalogManifestSchema = z.object({
  gemKey: z.string(), version: z.string(), author: z.string().optional(), description: z.string().optional(),
  tags: z.array(z.string()).optional(), artifactKinds: z.array(z.string()).optional(),
  type: z.string().optional(), grade: z.number().optional(),
});
const CatalogBody = z.object({ manifest: CatalogManifestSchema, pubkey: z.string(), signedAt: z.number(), signature: z.string() });
const CatalogResult = z.object({ shared: z.boolean(), publishedBy: z.string().optional(), gemKey: z.string().optional(), version: z.string().optional(), rejected: z.string().optional() });
```

Add the method (inside the class, near `bind`):

```ts
@post("/catalog", { body: CatalogBody, response: CatalogResult })
async catalog(input: { body: z.infer<typeof CatalogBody> }): Promise<z.infer<typeof CatalogResult>> {
  const r = await recordCatalogShare(this.db, input.body);
  return r.shared
    ? { shared: true, publishedBy: r.publishedBy, gemKey: r.gemKey, version: r.version }
    : { shared: false, rejected: r.rejected };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm clean && pnpm test -- catalogController`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add src/aggregator.controller.ts src/aggregator/__tests__/catalogController.test.ts
git commit -m "feat(aggregator): POST /api/aggregator/catalog endpoint

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 8: Read merge — `installable` flag + DB rows in `/api/registry/gems`

**Files:**
- Modify: `src/gem/publicCatalog.ts` (`installable` on `RegistryGem`, `mapIndexToGems` sets `installable:true`, add `mapDbToGems`, add `mergeGems`)
- Modify: `src/schemas.ts` (`installable` on `RegistryGemSchema`)
- Modify: `src/gem.controller.ts` (`registryGems` merges DB + index)
- Modify: `packages/marketplace/src/types.ts` (`installable?: boolean`)
- Test: `src/__tests__/publicCatalogMerge.test.ts`

**Interfaces:**
- Consumes: `listCatalogGems`/`CatalogRow` (Task 5), existing `RegistryIndex`.
- Produces: `RegistryGem` gains `installable: boolean`; `mapDbToGems(rows: CatalogRow[]): RegistryGem[]`; `mergeGems(dbGems: RegistryGem[], indexGems: RegistryGem[]): RegistryGem[]` (DB wins on `key` collision).

- [ ] **Step 1: Write the failing test**

```ts
// src/__tests__/publicCatalogMerge.test.ts
import { describe, it, expect } from "vitest";
import { mapDbToGems, mergeGems, mapIndexToGems } from "../gem/publicCatalog.js";
import type { RegistryIndex } from "@agentgem/distribute";

describe("publicCatalog merge", () => {
  it("maps DB rows as non-installable", () => {
    const gems = mapDbToGems([{ gemKey: "@o/k", version: "1.0.0", publishedBy: "o", description: "d", createdAtMs: 1 }]);
    expect(gems[0]).toMatchObject({ key: "@o/k", version: "1.0.0", installable: false, publishedBy: "o" });
  });

  it("marks registry index gems installable", () => {
    const index = { items: { "@o/k": { latest: "2.0.0", discovery: { description: "r" } } } } as unknown as RegistryIndex;
    expect(mapIndexToGems(index)[0]).toMatchObject({ key: "@o/k", installable: true });
  });

  it("DB wins on key collision", () => {
    const db = mapDbToGems([{ gemKey: "@o/k", version: "1.0.0", publishedBy: "o", createdAtMs: 1 }]);
    const idx = mapIndexToGems({ items: { "@o/k": { latest: "9.9.9" } } } as unknown as RegistryIndex);
    const merged = mergeGems(db, idx);
    expect(merged).toHaveLength(1);
    expect(merged[0]).toMatchObject({ key: "@o/k", version: "1.0.0", installable: false });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm clean && pnpm test -- publicCatalogMerge`
Expected: FAIL — `mapDbToGems`/`mergeGems` not exported; `installable` missing.

- [ ] **Step 3: Update `publicCatalog.ts`**

Add `installable: boolean;` to the `RegistryGem` interface. In `mapIndexToGems`, add `installable: true` to each mapped object. Then add:

```ts
import type { CatalogRow } from "@agentgem/aggregator";

/** DB-shared gems are browse-only teasers, never installable. */
export function mapDbToGems(rows: CatalogRow[]): RegistryGem[] {
  return rows.map((r) => ({
    key: r.gemKey, version: r.version, author: r.author, description: r.description,
    tags: r.tags, artifactKinds: r.artifactKinds, type: r.type, publishedBy: r.publishedBy,
    grade: r.grade, installable: false,
  }));
}

/** Union both sources; DB (freshly shared) wins on key collision. */
export function mergeGems(dbGems: RegistryGem[], indexGems: RegistryGem[]): RegistryGem[] {
  const byKey = new Map<string, RegistryGem>();
  for (const g of indexGems) byKey.set(g.key, g);
  for (const g of dbGems) byKey.set(g.key, g); // DB overwrites
  return [...byKey.values()];
}
```

Add `installable: z.boolean()` to `RegistryGemSchema` in `src/schemas.ts` (and `publishedBy: z.string().optional()`, `type: z.string().optional()` if not present — check first; the response mapper must satisfy the schema).

- [ ] **Step 4: Wire the merge into `registryGems` (`src/gem.controller.ts`)**

```ts
@get("/registry/gems", { query: PickQuerySchema, response: RegistryGemsResponseSchema })
async registryGems(_input: { query: z.infer<typeof PickQuerySchema> }): Promise<z.infer<typeof RegistryGemsResponseSchema>> {
  const cfg = registryConfigFromEnv();
  const getIndex = cfg ? () => githubRegistrySource(cfg).getIndex() : null;
  const indexGems = await publicGemCache.get(getIndex, Date.now());
  const dbGems = this.db ? mapDbToGems(await listCatalogGems(this.db)) : [];
  return { gems: mergeGems(dbGems, indexGems) };
}
```

Add imports at the top of `gem.controller.ts`: `mapDbToGems, mergeGems` from `./gem/publicCatalog.js` (extend the existing `createGemCache` import line) and `listCatalogGems` from `@agentgem/aggregator`.

Add `installable?: boolean;` to `packages/marketplace/src/types.ts` `RegistryGem`.

- [ ] **Step 5: Run tests to verify they pass**

Run: `pnpm clean && pnpm test -- publicCatalogMerge publicCatalog`
Expected: PASS. Also run `pnpm test` fully once to catch any `RegistryGemSchema` consumers that now need `installable` (the mappers set it, so the response validates).

- [ ] **Step 6: Commit**

```bash
git add src/gem/publicCatalog.ts src/schemas.ts src/gem.controller.ts packages/marketplace/src/types.ts src/__tests__/publicCatalogMerge.test.ts
git commit -m "feat(catalog): merge DB-shared gems into /api/registry/gems with installable flag

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 9: Wire `playbookPublish` to sign + forward to the hosted catalog

**Files:**
- Create: `src/gem/catalogShareClient.ts`
- Modify: `src/gem.controller.ts` (`playbookPublish` uses the client instead of `registryPublish`)
- Test: `src/gem/__tests__/catalogShareClient.test.ts`

**Interfaces:**
- Consumes: `Identity` (`@agentgem/model`), `catalogSigningPayload`/`CatalogManifest` (`@agentgem/aggregator`), the hosted base resolution (mirror `shareClient.ts`).
- Produces: `postCatalogShare(args: { manifest: CatalogManifest; identity: Identity; endpoint?: string; http?: ShareHttp; now?: () => number }): Promise<{ shared: true; publishedBy: string } | { shared: false; rejected: string }>`.

- [ ] **Step 1: Write the failing test**

```ts
// src/gem/__tests__/catalogShareClient.test.ts
import { describe, it, expect, vi } from "vitest";
import { postCatalogShare } from "../catalogShareClient.js";
import type { Identity } from "@agentgem/model";

const identity: Identity = { publicKey: "ed25519:PUB", sign: (d) => "sig" + d.length };

describe("postCatalogShare", () => {
  it("signs the manifest and posts to the hosted catalog endpoint", async () => {
    const http = vi.fn(async () => ({ status: 200, json: async () => ({ shared: true, publishedBy: "octocat" }) }));
    const res = await postCatalogShare({
      manifest: { gemKey: "@o/k", version: "1.0.0", description: "d" },
      identity, endpoint: "https://api.agentgem.ai", http, now: () => 1_000_000,
    });
    expect(res).toEqual({ shared: true, publishedBy: "octocat" });
    const [url, init] = http.mock.calls[0];
    expect(url).toBe("https://api.agentgem.ai/api/aggregator/catalog");
    const body = JSON.parse(init.body);
    expect(body).toMatchObject({ pubkey: "ed25519:PUB", signedAt: 1_000_000, manifest: { gemKey: "@o/k" } });
    expect(typeof body.signature).toBe("string");
  });

  it("surfaces a rejected result", async () => {
    const http = vi.fn(async () => ({ status: 200, json: async () => ({ shared: false, rejected: "not-connected" }) }));
    const res = await postCatalogShare({ manifest: { gemKey: "@o/k", version: "1.0.0" }, identity, endpoint: "https://api.agentgem.ai", http });
    expect(res).toEqual({ shared: false, rejected: "not-connected" });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm clean && pnpm test -- catalogShareClient`
Expected: FAIL — cannot find module `../catalogShareClient.js`.

- [ ] **Step 3: Write `catalogShareClient.ts`**

```ts
// src/gem/catalogShareClient.ts
// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
// Signs a gem manifest with the local producer key and forwards it to the hosted aggregator's
// catalog endpoint. Mirrors shareClient.ts (same base resolution, same http seam).
import type { Identity } from "@agentgem/model";
import { catalogSigningPayload, type CatalogManifest } from "@agentgem/aggregator";

export type ShareHttp = (url: string, init: { method: string; headers: Record<string, string>; body: string }) => Promise<{ status: number; json(): Promise<unknown> }>;
const defaultHttp: ShareHttp = async (url, init) => { const res = await fetch(url, { ...init, signal: AbortSignal.timeout(10_000) }); return { status: res.status, json: () => res.json() }; };

const DEFAULT_AGGREGATOR_URL = "https://api.agentgem.ai";
function resolveBase(endpoint: string | undefined): string {
  if (endpoint !== undefined) return endpoint;
  if (process.env.AGENTGEM_AGGREGATOR_URL) return process.env.AGENTGEM_AGGREGATOR_URL;
  return DEFAULT_AGGREGATOR_URL;
}

export async function postCatalogShare(args: {
  manifest: CatalogManifest; identity: Identity; endpoint?: string; http?: ShareHttp; now?: () => number;
}): Promise<{ shared: true; publishedBy: string } | { shared: false; rejected: string }> {
  const base = resolveBase(args.endpoint);
  const http = args.http ?? defaultHttp;
  const now = (args.now ?? (() => Date.now()))();
  const signature = args.identity.sign(catalogSigningPayload(args.manifest, args.identity.publicKey, now));
  const res = await http(`${base}/api/aggregator/catalog`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ manifest: args.manifest, pubkey: args.identity.publicKey, signedAt: now, signature }),
  });
  if (res.status < 200 || res.status >= 300) throw new Error(`catalog share ${res.status}`);
  const b = (await res.json()) as { shared?: boolean; publishedBy?: string; rejected?: string };
  return b.shared && b.publishedBy ? { shared: true, publishedBy: b.publishedBy } : { shared: false, rejected: b.rejected ?? "unknown" };
}
```

- [ ] **Step 4: Rewire `playbookPublish` in `src/gem.controller.ts`**

Replace the `publish` closure so it reads the workspace manifest, loads the identity, and shares to the DB (instead of `registryPublish`). Keep the `share()` card mint as-is.

```ts
@post("/playbook/publish", { body: PlaybookPublishBodySchema, response: PlaybookPublishResponseSchema })
async playbookPublish(input: { body: z.infer<typeof PlaybookPublishBodySchema> }): Promise<z.infer<typeof PlaybookPublishResponseSchema>> {
  const b = input.body;
  return publishPlaybookCore({
    publish: async () => {
      const gem = readGemArchive(readWorkspace(b.workspace).files);
      const manifest = {
        gemKey: `${b.scope}/${b.name ?? b.workspace}`, version: b.version,
        description: b.description, tags: b.tags, grade: gem.grade,
        artifactKinds: gem.artifacts?.map((a) => a.kind),
      };
      const identity = loadOrCreateIdentity();
      const r = await postCatalogShare({ manifest, identity });
      if (!r.shared) throw new Error(r.rejected === "not-connected" ? "connect your GitHub account first" : `share rejected: ${r.rejected}`);
      return { ref: manifest.gemKey, version: b.version };
    },
    share: async () => createShareCard(this.db!, { kind: "gem", name: b.name ?? b.workspace, provenance: b.provenance, generatedAtMs: Date.now() }),
  });
}
```

Add imports to `gem.controller.ts`: `loadOrCreateIdentity` from `@agentgem/model` (check if already imported), `postCatalogShare` from `./gem/catalogShareClient.js`. Verify `gem.artifacts` shape via `readGemArchive`'s return type; if the field differs, map the correct artifact-kind accessor (grep `readGemArchive` return type in `@agentgem/base`). If artifacts aren't readily available, omit `artifactKinds` (optional).

- [ ] **Step 5: Run tests to verify they pass**

Run: `pnpm clean && pnpm test -- catalogShareClient`
Expected: PASS (2 tests). Then run the full suite: `pnpm test` — expect green (or pre-existing real-FS scan flakes noted in the realfs-scan-tests-flake memory; verify those in isolation, don't attribute to this change).

- [ ] **Step 6: Manual smoke (optional but recommended)**

With `AGENTGEM_GITHUB_CLIENT_ID` set and after connecting once against a local aggregator (`AGENTGEM_AGGREGATOR_URL=http://127.0.0.1:PORT`), click **Share to Explore**. Expected: no 500; either success (`exploreRef` shown) or a clear "connect your GitHub account first".

- [ ] **Step 7: Commit**

```bash
git add src/gem/catalogShareClient.ts src/gem.controller.ts src/gem/__tests__/catalogShareClient.test.ts
git commit -m "feat(share): playbookPublish signs + forwards manifest to the hosted catalog

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Self-Review

**Spec coverage:**
- Connect GitHub device flow → Tasks 1–4. ✅
- `catalog_gems` table → Task 5. ✅
- Hosted `/api/aggregator/catalog` (verify sig, binding lookup, producer upsert, publishedBy) → Tasks 6–7. ✅
- Console share proxy (sign + forward + share card) → Task 9 (via `playbookPublish` + `catalogShareClient`). ✅
- Read merge + `installable` → Task 8. ✅
- Error handling (typed 403/not-connected instead of 500) → Tasks 6, 7, 9 (`not-connected` surfaced as a clear message). ✅
- Bundled share-card → Task 9 (`share()` retained). ✅
- Producer-registration bootstrap for fresh desktops → Task 6 (`producers` upsert). ✅

**Placeholder scan:** none — every code step is concrete. Two flagged verifications (the `require`→`import` swap in Task 3, and the `gem.artifacts` shape in Task 9) are explicit instructions, not placeholders.

**Type consistency:** `RegistryGem.installable: boolean` set by both `mapIndexToGems` (true) and `mapDbToGems` (false); `CatalogRow` produced by Task 5 and consumed by Tasks 6/8; `CatalogManifest` produced by Task 6 and consumed by Tasks 7/9; `catalogSigningPayload` shared by Tasks 6 (verify) and 9 (sign) — identical import. Consistent.

## Notes carried from spec
- Registry publish path stays intact; this only repoints the **playbook** publish (the "Share to Explore" button) at the DB. If a separate installable registry-publish entry point is desired later, it can call `registryPublish` directly.
- `packages/console` tests aren't in root CI — run `pnpm --filter @agentgem/console test` locally for Task 4.
