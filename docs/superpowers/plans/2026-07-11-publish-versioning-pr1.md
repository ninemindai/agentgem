# Publish confirmation + versioning (PR 1) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** When publishing a miniapp from Studio, detect an app the user already owns and let them choose *overwrite the current version* vs. *publish as an auto-bumped new version* — instead of today's silent overwrite of a hardcoded `"0.1.0"`.

**Architecture:** A new **signed** pre-flight endpoint `POST /api/aggregator/gem-status` reports `{ exists, ownedByMe, latestVersion }`. It is signed with the console's ed25519 producer key exactly like the existing `/api/aggregator/catalog` publish — the console authenticates by signature, not a session cookie, and the signing happens server-to-server in the console's local server (`src/gem.controller.ts`). No session/CORS/originGuard changes. Studio calls a thin local proxy route `GET /api/publish-status`, runs a pure decision function over the result, and drives a confirm banner. Real versioning already works at the DB layer (`catalog_gems` PK is `(gem_key, version)`); the only blocker was the hardcoded version string.

> **Design note (refines the spec):** the spec's PR 1 sketched a *session-gated GET* `gem-status`. During planning we confirmed the console has no session cookie for the aggregator — it authenticates by ed25519 signature. So this plan uses a **signed POST** mirroring `/api/aggregator/catalog`. Same information, correct auth, less machinery.

**Tech Stack:** TypeScript (ESM, `.js` import specifiers), Drizzle + PGlite (aggregator tests), zod + @agentback (controllers/routes), React (console), vitest.

## Global Constraints

- **Node ≥ 24, ESM.** All local imports use the `.js` extension in the specifier (e.g. `import { bumpPatch } from "./bumpPatch.js"`).
- **New-file header** (first two lines of every new source/test file):
  ```
  // Copyright (c) 2026 NineMind, Inc.
  // SPDX-License-Identifier: MIT
  ```
- **Ownership is the `accounts.id` uuid**, never the `published_by` login string.
- **Signed requests**: ed25519, canonical-JSON payload, 5-minute freshness — reuse `resolveSignedAccount` (server) and `Identity.sign` (client). Never invent a new signing scheme.
- **Version strings are plain `"major.minor.patch"`** — there is no `semver` dependency and none is to be added.
- **Test homes / commands:**
  - Aggregator: `src/aggregator/__tests__/*.test.ts`; run `npx vitest run <file>` from repo root. Test db via `makeTestDb()` (PGlite in-memory).
  - Root `src/gem/*`: co-located `*.test.ts`; run `npx vitest run <file>`.
  - Console: co-located `*.test.ts(x)`; run `cd packages/console && npx vitest run <file>`.
  - Full gate before PR: `npm test` (root: `tsc -b && vitest run`) **and** `cd packages/console && npx vitest run`.
- **Commit trailer** (every commit):
  ```
  Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
  ```
- Work happens in the worktree `/Users/rfeng/Projects/ninemind/agentgem-worktrees/publish-scope-versioning` on branch `feat/publish-scope-versioning`.

---

### Task 1: `bumpPatch` version util (console)

**Files:**
- Create: `packages/console/src/util/bumpPatch.ts`
- Test: `packages/console/src/util/bumpPatch.test.ts`

**Interfaces:**
- Produces: `bumpPatch(version: string): string` — increments the patch component of a plain `"M.m.p"` string.

- [ ] **Step 1: Write the failing test**

`packages/console/src/util/bumpPatch.test.ts`:
```ts
// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
import { describe, it, expect } from "vitest";
import { bumpPatch } from "./bumpPatch.js";

describe("bumpPatch", () => {
  it("increments the patch component", () => {
    expect(bumpPatch("0.1.0")).toBe("0.1.1");
    expect(bumpPatch("1.2.3")).toBe("1.2.4");
  });
  it("carries multi-digit patches", () => {
    expect(bumpPatch("0.1.9")).toBe("0.1.10");
    expect(bumpPatch("2.0.99")).toBe("2.0.100");
  });
  it("pads short versions before bumping", () => {
    expect(bumpPatch("1")).toBe("1.0.1");
    expect(bumpPatch("1.2")).toBe("1.2.1");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/console && npx vitest run src/util/bumpPatch.test.ts`
Expected: FAIL — cannot resolve `./bumpPatch.js`.

- [ ] **Step 3: Write minimal implementation**

`packages/console/src/util/bumpPatch.ts`:
```ts
// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
// Bump the patch component of a plain "major.minor.patch" version. Versions are opaque plain
// strings here (no semver dependency); this is the only place a next version is computed.
export function bumpPatch(version: string): string {
  const parts = version.split(".");
  while (parts.length < 3) parts.push("0");
  const patch = Number.parseInt(parts[2], 10);
  parts[2] = String((Number.isFinite(patch) ? patch : 0) + 1);
  return parts.slice(0, 3).join(".");
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd packages/console && npx vitest run src/util/bumpPatch.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/console/src/util/bumpPatch.ts packages/console/src/util/bumpPatch.test.ts
git commit -m "feat(console): bumpPatch version util

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: `gemStatusFor` + `gemStatusSigningPayload` (aggregator core)

**Files:**
- Modify: `packages/aggregator/src/catalog.ts` (add exports; `eq`, `desc` are already imported at line 5; `canonicalJSON` at line 9; `catalogGems` at line 6)
- Modify: `packages/aggregator/src/index.ts` (the package barrel — the file that re-exports from `./catalog.js`; add the three new names next to the existing `latestGemVersion` export)
- Test: `src/aggregator/__tests__/gemStatus.test.ts`

**Interfaces:**
- Consumes: `catalogGems`, `latestGemVersion` (existing), `canonicalJSON` (existing import), `resolveSignedAccount` (existing).
- Produces:
  - `interface GemStatus { exists: boolean; ownedByMe: boolean; latestVersion: string | null }`
  - `gemStatusSigningPayload(gemKey: string, pubkey: string, signedAt: number): string`
  - `gemStatusFor(db: AppDb, gemKey: string, accountId: string | null): Promise<GemStatus>`

- [ ] **Step 1: Write the failing test**

`src/aggregator/__tests__/gemStatus.test.ts`:
```ts
// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
import { describe, it, expect } from "vitest";
import { generateKeyPairSync, sign as edSign } from "node:crypto";
import { makeTestDb, catalogGems, gemStatusFor, gemStatusSigningPayload, resolveSignedAccount, producers, accountBindings, accounts } from "@agentgem/aggregator";

function signer() {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const pubkey = "ed25519:" + publicKey.export({ format: "der", type: "spki" }).toString("base64");
  return { pubkey, sign: (d: string) => edSign(null, Buffer.from(d, "utf8"), privateKey).toString("base64") };
}

describe("gemStatusFor", () => {
  it("reports not-exists for an unknown key", async () => {
    const db = await makeTestDb();
    expect(await gemStatusFor(db, "@me/none", "acct-1")).toEqual({ exists: false, ownedByMe: false, latestVersion: null });
  });

  it("reports the latest-published version and ownership for the owner", async () => {
    const db = await makeTestDb();
    await db.insert(catalogGems).values({ gemKey: "@me/game", version: "0.1.0", publishedBy: "me", createdAtMs: 1000, ownerAccountId: "acct-1" });
    await db.insert(catalogGems).values({ gemKey: "@me/game", version: "0.1.1", publishedBy: "me", createdAtMs: 2000, ownerAccountId: "acct-1" });
    expect(await gemStatusFor(db, "@me/game", "acct-1")).toEqual({ exists: true, ownedByMe: true, latestVersion: "0.1.1" });
  });

  it("latest is by publish time; a different account does not own it", async () => {
    const db = await makeTestDb();
    await db.insert(catalogGems).values({ gemKey: "@me/game", version: "9.9.9", publishedBy: "me", createdAtMs: 1000, ownerAccountId: "acct-1" });
    await db.insert(catalogGems).values({ gemKey: "@me/game", version: "0.1.0", publishedBy: "me", createdAtMs: 2000, ownerAccountId: "acct-1" });
    expect(await gemStatusFor(db, "@me/game", "acct-2")).toEqual({ exists: true, ownedByMe: false, latestVersion: "0.1.0" });
  });

  it("null accountId is never the owner", async () => {
    const db = await makeTestDb();
    await db.insert(catalogGems).values({ gemKey: "@me/game", version: "0.1.0", publishedBy: "me", createdAtMs: 1000, ownerAccountId: "acct-1" });
    expect(await gemStatusFor(db, "@me/game", null)).toEqual({ exists: true, ownedByMe: false, latestVersion: "0.1.0" });
  });

  it("gemStatusSigningPayload verifies through resolveSignedAccount", async () => {
    const db = await makeTestDb();
    const s = signer();
    const accountId = crypto.randomUUID();
    await db.insert(producers).values({ pubkey: s.pubkey });
    await db.insert(accounts).values({ id: accountId, provider: "github", providerAccountId: "42", login: "octocat" });
    await db.insert(accountBindings).values({ pubkey: s.pubkey, provider: "github", accountId: "42", accountLogin: "octocat" });
    const now = 1_000_000;
    const payload = gemStatusSigningPayload("@octocat/game", s.pubkey, now);
    const who = await resolveSignedAccount(db, { pubkey: s.pubkey, payload, signedAt: now, signature: s.sign(payload) }, now);
    expect(who).toEqual({ ok: true, accountId, login: "octocat" });
  });
});
```

> If `catalogGems` is not already exported from the barrel, add it there (it is a core table; `producers`/`accountBindings`/`accounts` are already exported — see `src/aggregator/__tests__/catalogShare.test.ts`).

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/aggregator/__tests__/gemStatus.test.ts`
Expected: FAIL — `gemStatusFor` / `gemStatusSigningPayload` not exported.

- [ ] **Step 3: Write minimal implementation**

Append to `packages/aggregator/src/catalog.ts` (near `latestGemVersion`, ~line 82):
```ts
export interface GemStatus { exists: boolean; ownedByMe: boolean; latestVersion: string | null }

// Signed payload for a gem-status pre-flight query. Mirrors catalogSigningPayload but commits to
// the queried key (not a full manifest), so resolveSignedAccount can attribute the request.
export function gemStatusSigningPayload(gemKey: string, pubkey: string, signedAt: number): string {
  return canonicalJSON({ pubkey, signedAt, gemKey });
}

// Pre-flight for the publish dialog: does this key exist, is it owned by `accountId` (the resolved
// signer; null = unresolved/anonymous), and what is the latest-published version?
export async function gemStatusFor(db: AppDb, gemKey: string, accountId: string | null): Promise<GemStatus> {
  const rows = await db.select({ version: catalogGems.version, ownerAccountId: catalogGems.ownerAccountId, createdAtMs: catalogGems.createdAtMs })
    .from(catalogGems)
    .where(eq(catalogGems.gemKey, gemKey))
    .orderBy(desc(catalogGems.createdAtMs));
  if (rows.length === 0) return { exists: false, ownedByMe: false, latestVersion: null };
  const latest = rows[0];
  return { exists: true, ownedByMe: accountId != null && latest.ownerAccountId === accountId, latestVersion: latest.version };
}
```

In `packages/aggregator/src/index.ts`, add `gemStatusFor`, `gemStatusSigningPayload`, and `type GemStatus` to the existing re-export from `"./catalog.js"` (the same statement that already exports `latestGemVersion`).

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/aggregator/__tests__/gemStatus.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/aggregator/src/catalog.ts packages/aggregator/src/index.ts src/aggregator/__tests__/gemStatus.test.ts
git commit -m "feat(aggregator): gemStatusFor + gemStatusSigningPayload

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 3: signed `POST /api/aggregator/gem-status` controller

**Files:**
- Modify: `src/aggregator.controller.ts` (add schemas near line 142; add `gemStatusFor, gemStatusSigningPayload` to the existing `import { ... } from "@agentgem/aggregator"` at line 17–18; add the handler method)
- Test: `src/aggregator/__tests__/gemStatus.controller.test.ts`

**Interfaces:**
- Consumes: `resolveSignedAccount`, `gemStatusFor`, `gemStatusSigningPayload` (Task 2 barrel exports).
- Produces: `POST /api/aggregator/gem-status`, body `{ key, pubkey, signedAt, signature }` → `{ exists, ownedByMe, latestVersion }`. Auth failure ⇒ public info with `ownedByMe:false` (existence + latest are public; only ownership needs a valid signer).

- [ ] **Step 1: Write the failing test**

`src/aggregator/__tests__/gemStatus.controller.test.ts`:
```ts
// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
import { describe, it, expect } from "vitest";
import { generateKeyPairSync, sign as edSign } from "node:crypto";
import { makeTestDb, catalogGems, gemStatusSigningPayload, producers, accountBindings, accounts } from "@agentgem/aggregator";
import { AggregatorController } from "../../aggregator.controller.js";

function signer() {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const pubkey = "ed25519:" + publicKey.export({ format: "der", type: "spki" }).toString("base64");
  return { pubkey, sign: (d: string) => edSign(null, Buffer.from(d, "utf8"), privateKey).toString("base64") };
}

describe("AggregatorController.gemStatus", () => {
  it("returns ownedByMe:true for the signing owner", async () => {
    const db = await makeTestDb();
    const s = signer();
    const accountId = crypto.randomUUID();
    await db.insert(producers).values({ pubkey: s.pubkey });
    await db.insert(accounts).values({ id: accountId, provider: "github", providerAccountId: "42", login: "octocat" });
    await db.insert(accountBindings).values({ pubkey: s.pubkey, provider: "github", accountId: "42", accountLogin: "octocat" });
    await db.insert(catalogGems).values({ gemKey: "@octocat/game", version: "0.1.0", publishedBy: "octocat", createdAtMs: 1000, ownerAccountId: accountId });
    const now = Date.now(); // must be within the 5-min freshness window (controller uses Date.now())
    const payload = gemStatusSigningPayload("@octocat/game", s.pubkey, now);
    const ctrl = new AggregatorController(db);
    const res = await ctrl.gemStatus({ body: { key: "@octocat/game", pubkey: s.pubkey, signedAt: now, signature: s.sign(payload) } });
    expect(res).toEqual({ exists: true, ownedByMe: true, latestVersion: "0.1.0" });
  });

  it("returns ownedByMe:false on a bad signature but still reports existence", async () => {
    const db = await makeTestDb();
    await db.insert(catalogGems).values({ gemKey: "@octocat/game", version: "0.1.0", publishedBy: "octocat", createdAtMs: 1000, ownerAccountId: crypto.randomUUID() });
    const s = signer();
    const ctrl = new AggregatorController(db);
    const res = await ctrl.gemStatus({ body: { key: "@octocat/game", pubkey: s.pubkey, signedAt: Date.now(), signature: "bogus" } });
    expect(res).toEqual({ exists: true, ownedByMe: false, latestVersion: "0.1.0" });
  });
});
```

> `new AggregatorController(db)` instantiates the plain class directly (the `auth` constructor param is optional). If the sibling `src/aggregator/__tests__/publishGem.controller.test.ts` uses a different construction/harness, match it.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/aggregator/__tests__/gemStatus.controller.test.ts`
Expected: FAIL — `ctrl.gemStatus` is not a function.

- [ ] **Step 3: Write minimal implementation**

In `src/aggregator.controller.ts`, add to the `@agentgem/aggregator` import (line 17–18): `gemStatusFor`, `gemStatusSigningPayload`.

Add schemas near the other consts (~line 142–144):
```ts
const GemStatusBody = z.object({ key: z.string(), pubkey: z.string(), signedAt: z.number(), signature: z.string() });
const GemStatusResult = z.object({ exists: z.boolean(), ownedByMe: z.boolean(), latestVersion: z.string().nullable() });
```

Add the handler method inside the class (next to `catalog`, ~line 282):
```ts
  // Pre-flight for the publish dialog. Signed like /catalog — the console has no session cookie; it
  // authenticates with its ed25519 producer key. Existence + latest are public; ownedByMe is true
  // only for the verified owner. Auth failure ⇒ public info with ownedByMe:false.
  @post("/gem-status", { body: GemStatusBody, response: GemStatusResult })
  async gemStatus(input: { body: z.infer<typeof GemStatusBody> }): Promise<z.infer<typeof GemStatusResult>> {
    const b = input.body;
    const who = await resolveSignedAccount(this.db, {
      pubkey: b.pubkey, payload: gemStatusSigningPayload(b.key, b.pubkey, b.signedAt), signedAt: b.signedAt, signature: b.signature,
    });
    return gemStatusFor(this.db, b.key, who.ok ? who.accountId : null);
  }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/aggregator/__tests__/gemStatus.controller.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add src/aggregator.controller.ts src/aggregator/__tests__/gemStatus.controller.test.ts
git commit -m "feat(aggregator): signed POST /api/aggregator/gem-status

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 4: `postGemStatus` client (console local server → aggregator)

**Files:**
- Create: `src/gem/gemStatusClient.ts`
- Test: `src/gem/gemStatusClient.test.ts`

**Interfaces:**
- Consumes: `gemStatusSigningPayload` + `type GemStatus` (Task 2), `Identity` (`@agentgem/model`), `ShareHttp` (`./catalogShareClient.js`).
- Produces: `postGemStatus(args: { gemKey: string; identity: Identity; endpoint?: string; http?: ShareHttp; now?: () => number }): Promise<GemStatus>`

- [ ] **Step 1: Write the failing test**

`src/gem/gemStatusClient.test.ts`:
```ts
// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
import { describe, it, expect } from "vitest";
import type { ShareHttp } from "./catalogShareClient.js";
import { postGemStatus } from "./gemStatusClient.js";

const fakeIdentity = { publicKey: "ed25519:AAAA", sign: (_d: string) => "sig" };

describe("postGemStatus", () => {
  it("signs the key and posts to /api/aggregator/gem-status, returning the status", async () => {
    let seen: { url: string; body: unknown } | null = null;
    const http: ShareHttp = async (url, init) => {
      seen = { url, body: JSON.parse(String(init?.body ?? "{}")) };
      return { status: 200, json: async () => ({ exists: true, ownedByMe: true, latestVersion: "0.1.2" }) };
    };
    const res = await postGemStatus({ gemKey: "@me/game", identity: fakeIdentity, endpoint: "https://agg.test", http, now: () => 5 });
    expect(res).toEqual({ exists: true, ownedByMe: true, latestVersion: "0.1.2" });
    expect(seen!.url).toBe("https://agg.test/api/aggregator/gem-status");
    expect(seen!.body).toEqual({ key: "@me/game", pubkey: "ed25519:AAAA", signedAt: 5, signature: "sig" });
  });

  it("throws when the service returns a non-2xx", async () => {
    const http: ShareHttp = async () => ({ status: 503, json: async () => ({}) });
    await expect(postGemStatus({ gemKey: "@me/game", identity: fakeIdentity, endpoint: "https://agg.test", http })).rejects.toThrow();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/gem/gemStatusClient.test.ts`
Expected: FAIL — cannot resolve `./gemStatusClient.js`.

- [ ] **Step 3: Write minimal implementation**

`src/gem/gemStatusClient.ts`:
```ts
// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
// Signs a gem-status pre-flight with the local producer key and asks the hosted aggregator whether
// a key already exists, whether we own it, and its latest version. Mirrors gemPublishClient.ts.
import type { Identity } from "@agentgem/model";
import { InvalidInputError } from "@agentgem/model";
import { createLogger } from "@agentgem/base";
import { gemStatusSigningPayload, type GemStatus } from "@agentgem/aggregator";
import type { ShareHttp } from "./catalogShareClient.js";

const log = createLogger("share");

const defaultHttp: ShareHttp = async (url, init) => {
  const res = await fetch(url, { ...init, signal: AbortSignal.timeout(30_000) });
  return { status: res.status, json: () => res.json() };
};

const DEFAULT_AGGREGATOR_URL = "https://api.agentgem.ai";
function resolveBase(endpoint: string | undefined): string {
  if (endpoint !== undefined) return endpoint;
  if (process.env.AGENTGEM_AGGREGATOR_URL) return process.env.AGENTGEM_AGGREGATOR_URL;
  return DEFAULT_AGGREGATOR_URL;
}

export async function postGemStatus(args: {
  gemKey: string; identity: Identity; endpoint?: string; http?: ShareHttp; now?: () => number;
}): Promise<GemStatus> {
  const base = resolveBase(args.endpoint);
  const http = args.http ?? defaultHttp;
  const now = (args.now ?? (() => Date.now()))();
  const signature = args.identity.sign(gemStatusSigningPayload(args.gemKey, args.identity.publicKey, now));
  const res = await http(`${base}/api/aggregator/gem-status`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ key: args.gemKey, pubkey: args.identity.publicKey, signedAt: now, signature }),
  });
  if (res.status < 200 || res.status >= 300) {
    log.warn("gem-status POST to %s failed: HTTP %d", base, res.status);
    throw new InvalidInputError(`could not reach the publish service (HTTP ${res.status}); try again in a moment`);
  }
  return (await res.json()) as GemStatus;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/gem/gemStatusClient.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add src/gem/gemStatusClient.ts src/gem/gemStatusClient.test.ts
git commit -m "feat(console): postGemStatus signed pre-flight client

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 5: local `GET /api/publish-status` route + handler

Thin glue over Task 4 — no new logic, so it is verified by typecheck + build (the publish flow itself is exercised end-to-end in Task 7's verification). This mirrors `publishSetup`, which is likewise unit-test-free glue over `postGemPublish` + `loadOrCreateIdentity`.

**Files:**
- Modify: `packages/console/src/api/routes.ts` (add `publishStatusRoute`)
- Modify: `src/gem.controller.ts` (add the `@get("/publish-status")` handler; `get`, `z`, `loadOrCreateIdentity` are already imported; add `postGemStatus`)

**Interfaces:**
- Consumes: `postGemStatus` (Task 4), `loadOrCreateIdentity` (existing, `src/gem.controller.ts:220`).
- Produces: `publishStatusRoute = GET /api/publish-status`, query `{ workspace, scope, name? }` → `{ exists, ownedByMe, latestVersion }`. gemKey derived as `` `${scope}/${name ?? workspace}` `` — identical to `publishSetup` (`src/gem.controller.ts:624`).

- [ ] **Step 1: Add the client route**

In `packages/console/src/api/routes.ts`, near `publishSetupRoute` (~line 797):
```ts
export const publishStatusRoute = defineRoute("GET", "/api/publish-status", {
  query: z.object({ workspace: z.string(), scope: z.string(), name: z.string().optional() }),
  response: z.object({ exists: z.boolean(), ownedByMe: z.boolean(), latestVersion: z.string().nullable() }),
});
```

- [ ] **Step 2: Add the local handler**

In `src/gem.controller.ts`, add to the import from `./gem/gemPublishClient.js` neighborhood (~line 289):
```ts
import { postGemStatus } from "./gem/gemStatusClient.js";
```
Add schemas near the publish schemas:
```ts
const PublishStatusQuerySchema = z.object({ workspace: z.string(), scope: z.string(), name: z.string().optional() });
const PublishStatusResponseSchema = z.object({ exists: z.boolean(), ownedByMe: z.boolean(), latestVersion: z.string().nullable() });
```
Add the handler method (next to `publishSetup`, ~line 615):
```ts
  // Pre-flight for the publish dialog: is this workspace's gem already published, do we own it, and
  // what's the latest version? Signs with the local producer key (like publishSetup). Same gemKey
  // derivation as publishSetup so the check matches what publish will write.
  @get("/publish-status", { query: PublishStatusQuerySchema, response: PublishStatusResponseSchema })
  async publishStatus(input: { query: z.infer<typeof PublishStatusQuerySchema> }): Promise<z.infer<typeof PublishStatusResponseSchema>> {
    const q = input.query;
    const gemKey = `${q.scope}/${q.name ?? q.workspace}`;
    return postGemStatus({ gemKey, identity: loadOrCreateIdentity() });
  }
```

- [ ] **Step 3: Typecheck + build**

Run: `npx tsc -b`
Expected: clean (no errors). This compiles the root `src/` and referenced packages, proving the route/handler types line up.

- [ ] **Step 4: Commit**

```bash
git add packages/console/src/api/routes.ts src/gem.controller.ts
git commit -m "feat(console): GET /api/publish-status local pre-flight route

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 6: `resolvePublishAction` decision function (console)

Extract the dialog's decision as a pure, fully-tested function so the JSX wiring in Task 7 stays thin.

**Files:**
- Create: `packages/console/src/panels/Play/publishAction.ts`
- Test: `packages/console/src/panels/Play/publishAction.test.ts`

**Interfaces:**
- Consumes: `bumpPatch` (Task 1).
- Produces:
  - `interface GemStatus { exists: boolean; ownedByMe: boolean; latestVersion: string | null }` (local wire DTO — a 3-field duplicate is fine; do not import the server package into browser code)
  - `type PublishAction = { kind: "publish"; version: string } | { kind: "confirm"; latestVersion: string; nextVersion: string } | { kind: "taken" }`
  - `resolvePublishAction(status: GemStatus): PublishAction`

- [ ] **Step 1: Write the failing test**

`packages/console/src/panels/Play/publishAction.test.ts`:
```ts
// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
import { describe, it, expect } from "vitest";
import { resolvePublishAction } from "./publishAction.js";

describe("resolvePublishAction", () => {
  it("publishes 0.1.0 for a brand-new app", () => {
    expect(resolvePublishAction({ exists: false, ownedByMe: false, latestVersion: null })).toEqual({ kind: "publish", version: "0.1.0" });
  });
  it("asks to confirm overwrite vs next version when the app is mine", () => {
    expect(resolvePublishAction({ exists: true, ownedByMe: true, latestVersion: "0.1.4" }))
      .toEqual({ kind: "confirm", latestVersion: "0.1.4", nextVersion: "0.1.5" });
  });
  it("reports 'taken' when the app exists under another account", () => {
    expect(resolvePublishAction({ exists: true, ownedByMe: false, latestVersion: "2.0.0" })).toEqual({ kind: "taken" });
  });
  it("falls back to 0.1.0 as the latest when mine but version is missing", () => {
    expect(resolvePublishAction({ exists: true, ownedByMe: true, latestVersion: null }))
      .toEqual({ kind: "confirm", latestVersion: "0.1.0", nextVersion: "0.1.1" });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/console && npx vitest run src/panels/Play/publishAction.test.ts`
Expected: FAIL — cannot resolve `./publishAction.js`.

- [ ] **Step 3: Write minimal implementation**

`packages/console/src/panels/Play/publishAction.ts`:
```ts
// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
import { bumpPatch } from "../../util/bumpPatch.js";

export interface GemStatus { exists: boolean; ownedByMe: boolean; latestVersion: string | null }
export type PublishAction =
  | { kind: "publish"; version: string }
  | { kind: "confirm"; latestVersion: string; nextVersion: string }
  | { kind: "taken" };

// Decide what the publish dialog does given the pre-flight status.
export function resolvePublishAction(status: GemStatus): PublishAction {
  if (!status.exists) return { kind: "publish", version: "0.1.0" };
  if (!status.ownedByMe) return { kind: "taken" };
  const latest = status.latestVersion ?? "0.1.0";
  return { kind: "confirm", latestVersion: latest, nextVersion: bumpPatch(latest) };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd packages/console && npx vitest run src/panels/Play/publishAction.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/console/src/panels/Play/publishAction.ts packages/console/src/panels/Play/publishAction.test.ts
git commit -m "feat(console): resolvePublishAction decision for the publish dialog

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 7: wire the confirm dialog into Studio

**Files:**
- Modify: `packages/console/src/panels/Play/Studio.tsx`

**Interfaces:**
- Consumes: `publishStatusRoute` (Task 5), `resolvePublishAction` + `PublishAction` (Task 6).
- Produces: the publish flow now runs the pre-flight and, for an app the user owns, shows a `play-banner` with **Publish v{next}** and **Overwrite v{latest}** buttons; a brand-new app publishes `0.1.0` directly; a name owned by someone else surfaces a message.

- [ ] **Step 1: Add imports**

In `packages/console/src/panels/Play/Studio.tsx`, extend the routes import (line 3) with `publishStatusRoute`, and add:
```ts
import { resolvePublishAction, type PublishAction } from "./publishAction.js";
```

- [ ] **Step 2: Add dialog state**

Next to the other `useState` flags (~line 48–54):
```tsx
  const [pendingVersion, setPendingVersion] = useState<{ latestVersion: string; nextVersion: string; login: string } | null>(null);
```

- [ ] **Step 3: Give `publishWorkspace` a version parameter**

Replace the `publishWorkspace` signature and the hardcoded `version: "0.1.0"` (Studio.tsx:274, :279):
```tsx
  async function publishWorkspace(login: string, version: string) {
    setStatus("publishing to app.agentgem.ai…");
    try {
      const g = genreOf(meta?.genre ?? "project-fun");
      const pub = await publishSetupRoute.call(makeClient(apiBase), { body: {
        workspace: name, scope: login, name, version, provenance: "play",
        description: `${g.label} mini-game`, tags: ["game", meta?.genre ?? "project-fun"],
      } });
      setShare({ gemUrl: `https://app.agentgem.ai/gems/${encodeURIComponent(pub.exploreRef)}`, cardUrl: pub.shareUrl }); setStatus("");
    } catch (e) {
      const body = (e as Record<string, unknown>).body;
      setStatus(`share failed: ${typeof body === "string" ? body : (e as Error).message}`);
    }
  }
```

- [ ] **Step 4: Run the pre-flight in `shareToExplore`**

Replace `shareToExplore` (Studio.tsx:292–298):
```tsx
  async function shareToExplore() {
    setStatus("preparing…"); setShare(null); setPendingVersion(null);
    if (!(await save())) return;
    if (!(identity?.bound && identity.login)) { setStatus(""); setPendingPublish(true); return; }
    const login = identity.login;
    setStatus("checking app.agentgem.ai…");
    let action: PublishAction;
    try {
      const st = await publishStatusRoute.call(makeClient(apiBase), { query: { workspace: name, scope: login, name } });
      action = resolvePublishAction(st);
    } catch (e) {
      setStatus(`could not check for an existing app: ${(e as Error).message}`); return;
    }
    if (action.kind === "publish") { await publishWorkspace(login, action.version); return; }
    if (action.kind === "taken") { setStatus(`“${name}” is already published by another account — choose a different name.`); return; }
    setStatus(""); setPendingVersion({ latestVersion: action.latestVersion, nextVersion: action.nextVersion, login });
  }
```

- [ ] **Step 5: Route the post-bind resume through the pre-flight**

Search Studio.tsx for the resume-after-connect path that consumes `pendingPublish` and calls `publishWorkspace(` (the `onBound`/resume handler). Change that resume to re-enter the pre-flight instead of publishing directly: clear `pendingPublish` and call `void shareToExplore()` (now that identity is bound, `shareToExplore` runs the check and either publishes `0.1.0` or shows the confirm banner). Do not call `publishWorkspace` with a hardcoded version from the resume path.

- [ ] **Step 6: Add the confirm banner**

In the return JSX, alongside the other `play-banner` blocks (after the `share` banner, ~Studio.tsx:371):
```tsx
      {pendingVersion && (
        <div className="play-banner">
          <span className="play-banner__ico">📦</span>
          <div className="play-banner__body">
            <div className="play-banner__title">“{name}” is already published (v{pendingVersion.latestVersion})</div>
            <div className="play-banner__detail">Publish a new version, or overwrite the current one.</div>
          </div>
          <button className="play-btn play-btn--primary" onClick={() => { const p = pendingVersion; setPendingVersion(null); void publishWorkspace(p.login, p.nextVersion); }}>Publish v{pendingVersion.nextVersion}</button>
          <button className="play-btn play-btn--ghost" onClick={() => { const p = pendingVersion; setPendingVersion(null); void publishWorkspace(p.login, p.latestVersion); }}>Overwrite v{pendingVersion.latestVersion}</button>
        </div>
      )}
```

- [ ] **Step 7: Typecheck + console tests**

Run: `npx tsc -b && cd packages/console && npx vitest run`
Expected: clean typecheck; existing Studio tests (`src/panels/Play/__tests__/StudioShare.test.tsx`) still pass. If `StudioShare.test.tsx` asserted the old hardcoded `"0.1.0"` publish call shape, update that assertion to the new pre-flight-then-publish flow (mock `publishStatusRoute` to return `{ exists: false, ownedByMe: false, latestVersion: null }` so it publishes `0.1.0`).

- [ ] **Step 8: Commit**

```bash
git add packages/console/src/panels/Play/Studio.tsx packages/console/src/panels/Play/__tests__/StudioShare.test.tsx
git commit -m "feat(console): confirm overwrite vs new version on publish

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 8: end-to-end verification + PR

**Files:** none (verification + integration).

- [ ] **Step 1: Full test gate**

Run: `npm test` (root: `tsc -b && vitest run`)
Then: `cd packages/console && npx vitest run`
Expected: all green. (CI only gates the root `dist/__tests__` suite; console tests are local-only, so they MUST be run here.)

- [ ] **Step 2: Drive the flow (use the `verify` skill / `run` skill)**

Exercise the real publish path against a local aggregator (or a disposable scope): publish a miniapp once (expect `0.1.0`), then publish the same app again and confirm the banner offers **Publish v0.1.1** / **Overwrite v0.1.0**; take each branch and confirm the resulting `catalog_gems` rows (`0.1.1` new row vs. `0.1.0` overwritten). Attempt a name owned by a different account and confirm the "already published by another account" message.

- [ ] **Step 3: Push and open the PR**

```bash
git push -u origin feat/publish-scope-versioning
gh pr create --title "Publish confirmation + versioning (PR 1)" --body "$(cat <<'EOF'
Detect an already-published app the user owns and let them choose overwrite vs. a new auto-bumped version, replacing today's silent overwrite of a hardcoded 0.1.0.

- Signed POST /api/aggregator/gem-status pre-flight (ed25519, like /catalog)
- bumpPatch util; real (gem_key, version) versioning (DB already supported it)
- Studio confirm banner: Publish v{next} / Overwrite v{latest}

Spec: docs/superpowers/specs/2026-07-11-publish-scope-versioning-design.md

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

- [ ] **Step 4: Watch CI and merge**

Run: `gh run watch <run-id> --exit-status` then `gh pr merge --rebase --delete-branch`.
The required check is `test (24)`. After merge, verify each commit's content landed on `origin/main` (`git fetch` then grep `origin/main:<file>` for a marker from every commit — the multi-commit dropped-commit trap).

---

## Self-Review

- **Spec coverage (PR 1 scope):** pre-flight existence check → Tasks 2–5; overwrite-vs-new-version dialog → Tasks 6–7; auto-bump patch, no editing → Task 1 + Task 6 (`nextVersion`); "exists, not mine" surfaced → Task 6 (`taken`) + Task 7; real versioning (stop hardcoding `0.1.0`) → Task 7 Step 3. Visibility/scope is explicitly **PR 2**, not covered here.
- **Auth correction vs spec:** spec said session-gated GET; plan uses signed POST (documented in Architecture) — the console has no aggregator session cookie. Same data, correct mechanism.
- **Type consistency:** `GemStatus { exists, ownedByMe, latestVersion }` is the single shape across Tasks 2 (server), 4 (client, imported), 6 (browser DTO). `gemStatusSigningPayload(gemKey, pubkey, signedAt)` signature identical in Tasks 2/3/4. `publishWorkspace(login, version)` two-arg form used consistently in Task 7. `resolvePublishAction` `PublishAction` kinds (`publish`/`confirm`/`taken`) consumed exactly in Task 7.
- **Placeholder scan:** every code step has complete code; the two glue steps without a unit test (Task 5, Task 7 JSX) are gated by `tsc -b` + the Task 8 drive, and say so.
- **Known edge (documented, out of scope):** orphaned NULL-owner rows still reject re-publish as `"conflict"` upstream; unchanged here.
