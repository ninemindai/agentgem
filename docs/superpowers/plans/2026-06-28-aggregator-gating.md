# Aggregator Gating Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Gate the aggregator reads with admin-issued API keys and a two-tier rate limit (anonymous per-IP, keyed per-key), runnable locally on embedded pglite.

**Architecture:** A new `api_keys` table + `apiKeys.ts` module (hash-stored keys); an async `apiKeyIdentity` express middleware resolves `x-api-key` → `req.gemTier`/`req.gemKeyId` once (bridging the async DB lookup to the synchronous limiter path); two `@agentback/extension-rate-limit` mounts gated by `skip` give the tiers; `index.ts` always registers the aggregator, backed by Postgres when `DATABASE_URL` is set and by `@electric-sql/pglite` otherwise.

**Tech Stack:** TypeScript (ESM, `.js` import specifiers), `@agentback/rest` + `@agentback/openapi` decorator controllers, drizzle-orm (pg-core; pglite + node-postgres adapters), `@agentback/extension-rate-limit`, vitest (runs against compiled `dist/` for the server package), `node:crypto`.

## Global Constraints

- The worktree starts with **no `node_modules`** — run `pnpm install` once before Task 1 (the controller/session does this at execution start).
- Import specifiers use the `.js` extension even for `.ts` sources (ESM/NodeNext). Match the existing files.
- **Server-package tests run against compiled `dist/`** — `pnpm test` is `tsc -b && vitest run`. Aggregator unit tests use `makeTestDb()` (`src/aggregator/testDb.ts`): `drizzle(new PGlite(), { schema })` + `ensureSchema`.
- Randomness/ids from `node:crypto` (`randomBytes`, `randomUUID`) — never `Math.random`.
- API key plaintext format: `"ag_" + base64url(32 random bytes)`. Store only `sha256hex(plaintext)`; return plaintext exactly once.
- Admin endpoints reuse the existing pattern: gate on `process.env.AGGREGATOR_ADMIN_TOKEN` with the controller's constant-time `tokenEq`; **never log the request body**.
- Default limits: anonymous **60 req / 60s** per IP; keyed **600 req / 60s** per key. Bad key → **401** (no anonymous fallback). Limits read from env (`AGG_ANON_POINTS` / `AGG_KEYED_POINTS`) with those defaults — a minimal seam for test tuning + ops.
- Rate limit scopes the whole `/api/aggregator` path (reads + writes). Store failures **fail open** (extension default).
- `AppDb = PgDatabase<any, typeof schema>` from `src/aggregator/schema.ts`. Controllers receive it via constructor (`new AggregatorController(db)` in tests).

---

### Task 1: `api_keys` schema + key module

**Files:**
- Modify: `src/aggregator/schema.ts`
- Create: `src/aggregator/apiKeys.ts`
- Test: `src/aggregator/__tests__/apiKeys.test.ts`

**Interfaces:**
- Produces:
  - `apiKeys` drizzle table (added to the exported `schema` object) and its DDL in `ensureSchema`.
  - `generateKey(): { plaintext: string; hash: string }`
  - `issueKey(db: AppDb, label: string): Promise<{ id: string; plaintext: string; label: string }>`
  - `verifyKey(db: AppDb, plaintext: string): Promise<{ id: string; label: string } | null>` (null when missing OR revoked)
  - `revokeKey(db: AppDb, id: string): Promise<boolean>` (false if already revoked / not found)
  - `listKeys(db: AppDb): Promise<{ id: string; label: string; createdAt: Date; revokedAt: Date | null }[]>` (newest first; never returns hashes)

- [ ] **Step 1: Write the failing test**

Create `src/aggregator/__tests__/apiKeys.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { createHash } from "node:crypto";
import { makeTestDb } from "../testDb.js";
import { generateKey, issueKey, verifyKey, revokeKey, listKeys } from "../apiKeys.js";

describe("generateKey", () => {
  it("produces an ag_-prefixed plaintext whose hash is its sha256", () => {
    const { plaintext, hash } = generateKey();
    expect(plaintext.startsWith("ag_")).toBe(true);
    expect(hash).toBe(createHash("sha256").update(plaintext).digest("hex"));
  });
  it("is distinct each call", () => {
    expect(generateKey().plaintext).not.toBe(generateKey().plaintext);
  });
});

describe("issueKey + verifyKey", () => {
  it("issues a key, stores only the hash, and verifies the plaintext", async () => {
    const db = await makeTestDb();
    const issued = await issueKey(db, "acme prod");
    expect(issued.plaintext.startsWith("ag_")).toBe(true);
    expect(issued.label).toBe("acme prod");
    const found = await verifyKey(db, issued.plaintext);
    expect(found).toEqual({ id: issued.id, label: "acme prod" });
  });
  it("rejects an unknown key", async () => {
    const db = await makeTestDb();
    expect(await verifyKey(db, "ag_nope")).toBeNull();
  });
});

describe("revokeKey", () => {
  it("revokes so verify returns null, and is idempotent", async () => {
    const db = await makeTestDb();
    const { id, plaintext } = await issueKey(db, "temp");
    expect(await revokeKey(db, id)).toBe(true);
    expect(await verifyKey(db, plaintext)).toBeNull();
    expect(await revokeKey(db, id)).toBe(false); // already revoked
  });
});

describe("listKeys", () => {
  it("lists all keys as metadata only — never the hash", async () => {
    const db = await makeTestDb();
    await issueKey(db, "first");
    await issueKey(db, "second");
    const rows = await listKeys(db);
    // Order-independent: two inserts can share a created_at millisecond, so don't assert order.
    expect(rows.map((r) => r.label).sort()).toEqual(["first", "second"]);
    expect(Object.keys(rows[0]).sort()).toEqual(["createdAt", "id", "label", "revokedAt"]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test src/aggregator/__tests__/apiKeys.test.ts`
Expected: FAIL — `../apiKeys.js` not found.

- [ ] **Step 3: Add the schema table + DDL**

In `src/aggregator/schema.ts`, add the table after `accountBindings`:

```ts
export const apiKeys = pgTable("api_keys", {
  id: uuid("id").primaryKey(),
  keyHash: text("key_hash").notNull().unique(),
  label: text("label").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  revokedAt: timestamp("revoked_at", { withTimezone: true }),
});
```

Add `apiKeys` to the exported `schema` object:

```ts
export const schema = { producers, attestations, ingredients, usageEdges, accountBindings, apiKeys };
```

Add the DDL inside `ensureSchema` (after the `account_bindings` statement):

```ts
  await db.execute(sql`create table if not exists api_keys (id uuid primary key, key_hash text not null unique, label text not null, created_at timestamptz not null default now(), revoked_at timestamptz)`);
```

- [ ] **Step 4: Write the key module**

Create `src/aggregator/apiKeys.ts`:

```ts
import { randomBytes, randomUUID, createHash } from "node:crypto";
import { eq, and, isNull, desc } from "drizzle-orm";
import { apiKeys, type AppDb } from "./schema.js";

const sha256hex = (s: string): string => createHash("sha256").update(s).digest("hex");

/** A fresh key: `ag_` + 32 random bytes (base64url), and its sha256 hash. */
export function generateKey(): { plaintext: string; hash: string } {
  const plaintext = "ag_" + randomBytes(32).toString("base64url");
  return { plaintext, hash: sha256hex(plaintext) };
}

/** Mint + persist a key (hash only). Returns the plaintext ONCE. */
export async function issueKey(db: AppDb, label: string): Promise<{ id: string; plaintext: string; label: string }> {
  const { plaintext, hash } = generateKey();
  const id = randomUUID();
  await db.insert(apiKeys).values({ id, keyHash: hash, label });
  return { id, plaintext, label };
}

/** Resolve a plaintext key to its (active) record, or null if unknown/revoked. */
export async function verifyKey(db: AppDb, plaintext: string): Promise<{ id: string; label: string } | null> {
  const rows = await db
    .select({ id: apiKeys.id, label: apiKeys.label })
    .from(apiKeys)
    .where(and(eq(apiKeys.keyHash, sha256hex(plaintext)), isNull(apiKeys.revokedAt)))
    .limit(1);
  return rows[0] ?? null;
}

/** Revoke a key by id. Returns false if it was already revoked or not found. */
export async function revokeKey(db: AppDb, id: string): Promise<boolean> {
  const res = await db
    .update(apiKeys)
    .set({ revokedAt: new Date() })
    .where(and(eq(apiKeys.id, id), isNull(apiKeys.revokedAt)))
    .returning({ id: apiKeys.id });
  return res.length > 0;
}

/** All keys, newest first — metadata only, never the hash. */
export async function listKeys(db: AppDb): Promise<{ id: string; label: string; createdAt: Date; revokedAt: Date | null }[]> {
  return db
    .select({ id: apiKeys.id, label: apiKeys.label, createdAt: apiKeys.createdAt, revokedAt: apiKeys.revokedAt })
    .from(apiKeys)
    .orderBy(desc(apiKeys.createdAt));
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `pnpm test src/aggregator/__tests__/apiKeys.test.ts`
Expected: PASS (all cases).

- [ ] **Step 6: Commit**

```bash
git add src/aggregator/schema.ts src/aggregator/apiKeys.ts src/aggregator/__tests__/apiKeys.test.ts
git commit -m "feat(aggregator): api_keys table + hashed key module (issue/verify/revoke/list)"
```

---

### Task 2: API-key identity middleware

**Files:**
- Create: `src/apiKeyIdentity.ts`
- Test: `src/__tests__/apiKeyIdentity.test.ts`

**Interfaces:**
- Consumes: `verifyKey` (Task 1), `AppDb`.
- Produces: `makeApiKeyIdentity(db: AppDb)` → an async express middleware `(req, res, next)`. Sets `req.gemTier = "anonymous"` (no key) or `"keyed"` + `req.gemKeyId` (valid key); responds **401** `{ error: "invalid api key" }` without calling `next` on a present-but-invalid key. Reads the key from the `x-api-key` header or `?apiKey` query.

- [ ] **Step 1: Write the failing test**

Create `src/__tests__/apiKeyIdentity.test.ts`:

```ts
import { describe, it, expect, vi } from "vitest";
import { makeTestDb } from "../aggregator/testDb.js";
import { issueKey } from "../aggregator/apiKeys.js";
import { makeApiKeyIdentity } from "../apiKeyIdentity.js";

function mockReqRes(headers: Record<string, string> = {}, query: Record<string, unknown> = {}) {
  const req: any = { method: "GET", path: "/api/aggregator/popularity", query, get: (n: string) => headers[n.toLowerCase()] };
  const res: any = { code: 0, body: "", status(c: number) { this.code = c; return this; }, type() { return this; }, send(b: string) { this.body = b; return this; } };
  return { req, res };
}

describe("apiKeyIdentity", () => {
  it("marks requests with no key as anonymous and calls next", async () => {
    const db = await makeTestDb();
    const next = vi.fn();
    const { req, res } = mockReqRes();
    await makeApiKeyIdentity(db)(req, res, next);
    expect(req.gemTier).toBe("anonymous");
    expect(next).toHaveBeenCalledOnce();
  });

  it("marks a valid x-api-key as keyed with its id and calls next", async () => {
    const db = await makeTestDb();
    const { id, plaintext } = await issueKey(db, "t");
    const next = vi.fn();
    const { req, res } = mockReqRes({ "x-api-key": plaintext });
    await makeApiKeyIdentity(db)(req, res, next);
    expect(req.gemTier).toBe("keyed");
    expect(req.gemKeyId).toBe(id);
    expect(next).toHaveBeenCalledOnce();
  });

  it("401s a present-but-invalid key without calling next", async () => {
    const db = await makeTestDb();
    const next = vi.fn();
    const { req, res } = mockReqRes({ "x-api-key": "ag_bogus" });
    await makeApiKeyIdentity(db)(req, res, next);
    expect(res.code).toBe(401);
    expect(JSON.parse(res.body)).toEqual({ error: "invalid api key" });
    expect(next).not.toHaveBeenCalled();
  });

  it("also accepts the apiKey query parameter", async () => {
    const db = await makeTestDb();
    const { plaintext } = await issueKey(db, "t");
    const next = vi.fn();
    const { req, res } = mockReqRes({}, { apiKey: plaintext });
    await makeApiKeyIdentity(db)(req, res, next);
    expect(req.gemTier).toBe("keyed");
    expect(next).toHaveBeenCalledOnce();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test src/__tests__/apiKeyIdentity.test.ts`
Expected: FAIL — `../apiKeyIdentity.js` not found.

- [ ] **Step 3: Write the middleware**

Create `src/apiKeyIdentity.ts`:

```ts
// Resolves the caller's tier from an API key BEFORE the rate limiters run, so the
// limiters' synchronous keyGenerator/skip can read req.gemTier/req.gemKeyId without an
// async DB hit. Mounted (scoped to /api/aggregator) ahead of the extension-rate-limit mounts.
import type { AppDb } from "./aggregator/schema.js";
import { verifyKey } from "./aggregator/apiKeys.js";

interface IdReq {
  query?: Record<string, unknown>;
  get(name: string): string | undefined;
  gemTier?: "anonymous" | "keyed";
  gemKeyId?: string;
}
interface IdRes { status(code: number): IdRes; type(t: string): IdRes; send(body: string): unknown }
type IdNext = () => void;

export function makeApiKeyIdentity(db: AppDb) {
  return async function apiKeyIdentity(req: IdReq, res: IdRes, next: IdNext): Promise<void> {
    const header = req.get("x-api-key");
    const queried = typeof req.query?.apiKey === "string" ? (req.query.apiKey as string) : undefined;
    const key = header ?? queried;
    if (!key) { req.gemTier = "anonymous"; next(); return; }
    const found = await verifyKey(db, key);
    if (!found) { res.status(401).type("application/json").send(JSON.stringify({ error: "invalid api key" })); return; }
    req.gemTier = "keyed";
    req.gemKeyId = found.id;
    next();
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test src/__tests__/apiKeyIdentity.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/apiKeyIdentity.ts src/__tests__/apiKeyIdentity.test.ts
git commit -m "feat(gating): async api-key identity middleware (tier + 401 on bad key)"
```

---

### Task 3: Admin key-issuance endpoints

**Files:**
- Modify: `src/aggregator.controller.ts`
- Test: `src/aggregator/__tests__/keysController.test.ts`

**Interfaces:**
- Consumes: `issueKey`, `revokeKey`, `listKeys` (Task 1); the controller's existing `tokenEq` + `this.db`.
- Produces three controller methods, all admin-gated by `AGGREGATOR_ADMIN_TOKEN`:
  - `POST /api/aggregator/keys` body `{ token, label }` → `{ ok: true, id, key, label } | { ok: false, rejected }`
  - `POST /api/aggregator/keys/revoke` body `{ token, id }` → `{ ok: true, revoked } | { ok: false, rejected }`
  - `POST /api/aggregator/keys/list` body `{ token }` → `{ ok: true, keys: {id,label,createdAt,revokedAt}[] } | { ok: false, rejected }` (dates ISO strings, `revokedAt` nullable)

- [ ] **Step 1: Write the failing test**

Create `src/aggregator/__tests__/keysController.test.ts`:

```ts
import { describe, it, expect, afterEach } from "vitest";
import { makeTestDb } from "../testDb.js";
import { AggregatorController } from "../../aggregator.controller.js";

const orig = { ...process.env };
afterEach(() => { process.env = { ...orig }; });

describe("POST /api/aggregator/keys (issue)", () => {
  it("refuses when AGGREGATOR_ADMIN_TOKEN is unset", async () => {
    delete process.env.AGGREGATOR_ADMIN_TOKEN;
    const db = await makeTestDb();
    expect(await new AggregatorController(db).issueKey({ body: { token: "x", label: "l" } }))
      .toEqual({ ok: false, rejected: "keys-disabled" });
  });
  it("rejects a wrong token", async () => {
    process.env.AGGREGATOR_ADMIN_TOKEN = "s3cret";
    const db = await makeTestDb();
    expect(await new AggregatorController(db).issueKey({ body: { token: "nope", label: "l" } }))
      .toEqual({ ok: false, rejected: "unauthorized" });
  });
  it("issues a key with the right token", async () => {
    process.env.AGGREGATOR_ADMIN_TOKEN = "s3cret";
    const db = await makeTestDb();
    const res = await new AggregatorController(db).issueKey({ body: { token: "s3cret", label: "acme" } });
    expect(res.ok).toBe(true);
    if (res.ok) { expect(res.key.startsWith("ag_")).toBe(true); expect(res.label).toBe("acme"); }
  });
});

describe("revoke + list", () => {
  it("revokes an issued key and lists metadata (no hash)", async () => {
    process.env.AGGREGATOR_ADMIN_TOKEN = "s3cret";
    const db = await makeTestDb();
    const ctl = new AggregatorController(db);
    const issued = await ctl.issueKey({ body: { token: "s3cret", label: "acme" } });
    if (!issued.ok) throw new Error("issue failed");
    const rev = await ctl.revokeKey({ body: { token: "s3cret", id: issued.id } });
    expect(rev).toEqual({ ok: true, revoked: true });
    const list = await ctl.listKeys({ body: { token: "s3cret" } });
    expect(list.ok).toBe(true);
    if (list.ok) {
      expect(list.keys).toHaveLength(1);
      expect(list.keys[0]).toMatchObject({ id: issued.id, label: "acme" });
      expect(typeof list.keys[0].createdAt).toBe("string");
      expect(list.keys[0].revokedAt).not.toBeNull();
      expect("keyHash" in list.keys[0]).toBe(false);
    }
  });
  it("rejects list with a wrong token", async () => {
    process.env.AGGREGATOR_ADMIN_TOKEN = "s3cret";
    const db = await makeTestDb();
    expect(await new AggregatorController(db).listKeys({ body: { token: "nope" } }))
      .toEqual({ ok: false, rejected: "unauthorized" });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test src/aggregator/__tests__/keysController.test.ts`
Expected: FAIL — `issueKey`/`revokeKey`/`listKeys` not methods on the controller.

- [ ] **Step 3: Add the schemas + import**

In `src/aggregator.controller.ts`, add to the imports near the top:

```ts
import { issueKey, revokeKey, listKeys } from "./aggregator/apiKeys.js";
```

Add these schema consts alongside the others (after the `SweepResult` block):

```ts
const KeyIssueBody = z.object({ token: z.string(), label: z.string().min(1).max(120) });
const KeyIssueResult = z.union([
  z.object({ ok: z.literal(true), id: z.string(), key: z.string(), label: z.string() }),
  z.object({ ok: z.literal(false), rejected: z.string() }),
]);
const KeyRevokeBody = z.object({ token: z.string(), id: z.string() });
const KeyRevokeResult = z.union([
  z.object({ ok: z.literal(true), revoked: z.boolean() }),
  z.object({ ok: z.literal(false), rejected: z.string() }),
]);
const KeyListBody = z.object({ token: z.string() });
const KeyListResult = z.union([
  z.object({ ok: z.literal(true), keys: z.array(z.object({ id: z.string(), label: z.string(), createdAt: z.string(), revokedAt: z.string().nullable() })) }),
  z.object({ ok: z.literal(false), rejected: z.string() }),
]);
```

- [ ] **Step 4: Add the controller methods**

Inside the `AggregatorController` class (after the `sweep` method), add:

```ts
  // Admin-only: mint an API key. Gated by AGGREGATOR_ADMIN_TOKEN (like /sweep). The plaintext
  // is returned ONCE; only its hash is stored. Do NOT log input.body (it has the token).
  @post("/keys", { body: KeyIssueBody, response: KeyIssueResult })
  async issueKey(input: { body: z.infer<typeof KeyIssueBody> }): Promise<z.infer<typeof KeyIssueResult>> {
    const expected = process.env.AGGREGATOR_ADMIN_TOKEN;
    if (!expected) return { ok: false, rejected: "keys-disabled" };
    if (!tokenEq(input.body.token, expected)) return { ok: false, rejected: "unauthorized" };
    const { id, plaintext, label } = await issueKey(this.db, input.body.label);
    return { ok: true, id, key: plaintext, label };
  }

  @post("/keys/revoke", { body: KeyRevokeBody, response: KeyRevokeResult })
  async revokeKey(input: { body: z.infer<typeof KeyRevokeBody> }): Promise<z.infer<typeof KeyRevokeResult>> {
    const expected = process.env.AGGREGATOR_ADMIN_TOKEN;
    if (!expected) return { ok: false, rejected: "keys-disabled" };
    if (!tokenEq(input.body.token, expected)) return { ok: false, rejected: "unauthorized" };
    return { ok: true, revoked: await revokeKey(this.db, input.body.id) };
  }

  // POST (not GET) so the admin token travels in the body, never a URL/query that lands in logs.
  @post("/keys/list", { body: KeyListBody, response: KeyListResult })
  async listKeys(input: { body: z.infer<typeof KeyListBody> }): Promise<z.infer<typeof KeyListResult>> {
    const expected = process.env.AGGREGATOR_ADMIN_TOKEN;
    if (!expected) return { ok: false, rejected: "keys-disabled" };
    if (!tokenEq(input.body.token, expected)) return { ok: false, rejected: "unauthorized" };
    const keys = (await listKeys(this.db)).map((k) => ({
      id: k.id, label: k.label, createdAt: k.createdAt.toISOString(), revokedAt: k.revokedAt ? k.revokedAt.toISOString() : null,
    }));
    return { ok: true, keys };
  }
```

- [ ] **Step 5: Run test to verify it passes**

Run: `pnpm test src/aggregator/__tests__/keysController.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/aggregator.controller.ts src/aggregator/__tests__/keysController.test.ts
git commit -m "feat(aggregator): admin key issue/revoke/list endpoints"
```

---

### Task 4: Rate-limit tier options + mountGating

**Files:**
- Modify: `package.json`
- Create: `src/gating.ts`
- Test: `src/__tests__/gating.test.ts`

**Interfaces:**
- Consumes: `makeApiKeyIdentity` (Task 2); `@agentback/extension-rate-limit`'s `installRateLimit`.
- Produces:
  - `ANON_POINTS`, `KEYED_POINTS`, `WINDOW_SECS` (numbers; points read from env with defaults 60 / 600).
  - `anonRateLimitOptions(points?: number)` and `keyedRateLimitOptions(points?: number)` — each returns the extension's options object with `path: "/api/aggregator"`, `durationSecs: WINDOW_SECS`, a `keyGenerator`, and a `skip`. Anonymous: keyGen = `req.ip`, skip when `req.gemTier === "keyed"`. Keyed: keyGen = `req.gemKeyId`, skip when `req.gemTier !== "keyed"`.
  - `mountGating(app, db): Promise<void>` — mounts `apiKeyIdentity` (scoped to `/api/aggregator`) then the two `installRateLimit` mounts, in that order.

- [ ] **Step 1: Add the dependency**

Add to `package.json` `dependencies` (keep alphabetical with the other `@agentback/*` entries):

```json
"@agentback/extension-rate-limit": "^0.6.0",
```

Run: `pnpm install`
Expected: resolves and installs `@agentback/extension-rate-limit` + `rate-limiter-flexible`.

- [ ] **Step 2: Write the failing test**

Create `src/__tests__/gating.test.ts` (tests OUR tiering logic — the option builders' `skip`/`keyGenerator`; the extension's 429 behavior is the framework's and is validated by the live local run):

```ts
import { describe, it, expect } from "vitest";
import { ANON_POINTS, KEYED_POINTS, anonRateLimitOptions, keyedRateLimitOptions } from "../gating.js";

const keyed = { ip: "1.2.3.4", gemTier: "keyed", gemKeyId: "key-1" } as any;
const anon = { ip: "1.2.3.4", gemTier: "anonymous" } as any;

describe("anonRateLimitOptions", () => {
  it("limits anonymous callers by IP and skips keyed ones", () => {
    const o = anonRateLimitOptions();
    expect(o.points).toBe(ANON_POINTS);
    expect(o.path).toBe("/api/aggregator");
    expect(o.skip(keyed)).toBe(true);   // keyed callers use the other bucket
    expect(o.skip(anon)).toBe(false);
    expect(o.keyGenerator(anon)).toBe("1.2.3.4");
  });
});

describe("keyedRateLimitOptions", () => {
  it("limits keyed callers by key id and skips anonymous ones", () => {
    const o = keyedRateLimitOptions();
    expect(o.points).toBe(KEYED_POINTS);
    expect(o.skip(anon)).toBe(true);
    expect(o.skip(keyed)).toBe(false);
    expect(o.keyGenerator(keyed)).toBe("key-1");
  });
  it("honors an explicit points override (for tuning)", () => {
    expect(keyedRateLimitOptions(5).points).toBe(5);
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `pnpm test src/__tests__/gating.test.ts`
Expected: FAIL — `../gating.js` not found.

- [ ] **Step 4: Write `gating.ts`**

Create `src/gating.ts`:

```ts
// Two-tier rate limiting for the aggregator: anonymous callers are limited per-IP at a low
// ceiling; callers presenting a valid API key are limited per-key at a high ceiling. The
// extension can't vary `points` per request, so each tier is a separate mount, routed by `skip`.
import { installRateLimit } from "@agentback/extension-rate-limit";
import { makeApiKeyIdentity } from "./apiKeyIdentity.js";
import type { AppDb } from "./aggregator/schema.js";

const AGG_PATH = "/api/aggregator";
export const WINDOW_SECS = 60;
export const ANON_POINTS = Number(process.env.AGG_ANON_POINTS ?? 60);
export const KEYED_POINTS = Number(process.env.AGG_KEYED_POINTS ?? 600);

type GReq = { ip?: string; gemTier?: string; gemKeyId?: string };

export function anonRateLimitOptions(points: number = ANON_POINTS) {
  return {
    path: AGG_PATH,
    points,
    durationSecs: WINDOW_SECS,
    keyGenerator: (req: GReq) => req.ip ?? "anon",
    skip: (req: GReq) => req.gemTier === "keyed",
  };
}

export function keyedRateLimitOptions(points: number = KEYED_POINTS) {
  return {
    path: AGG_PATH,
    points,
    durationSecs: WINDOW_SECS,
    keyGenerator: (req: GReq) => req.gemKeyId ?? "anon",
    skip: (req: GReq) => req.gemTier !== "keyed",
  };
}

// Mounts identity (scoped to /api/aggregator) ahead of the two limiter mounts. Call in
// createApp after the aggregator db is registered and before app.start().
export async function mountGating(app: import("@agentback/rest").RestApplication, db: AppDb): Promise<void> {
  const server = await app.restServer;
  server.expressApp.use(AGG_PATH, makeApiKeyIdentity(db));
  await installRateLimit(app, anonRateLimitOptions());
  await installRateLimit(app, keyedRateLimitOptions());
}
```

> If `installRateLimit`'s options type rejects the extra `keyGenerator`/`skip` arg shapes, cast the option object `as never` at the call site only after confirming the field names against the installed `@agentback/extension-rate-limit` `dist/index.d.ts` (`RateLimitOptions`). Do not change the documented field names.

- [ ] **Step 5: Run test to verify it passes**

Run: `pnpm test src/__tests__/gating.test.ts && pnpm exec tsc -b`
Expected: PASS, and `tsc` clean (confirms `mountGating` + the extension import type-check).

- [ ] **Step 6: Commit**

```bash
git add package.json pnpm-lock.yaml src/gating.ts src/__tests__/gating.test.ts
git commit -m "feat(gating): two-tier rate-limit options + mountGating (extension-rate-limit)"
```

---

### Task 5: Local pglite mode + wire gating into the server

**Files:**
- Create: `src/aggregator/localDb.ts`
- Test: `src/aggregator/__tests__/localDb.test.ts`
- Modify: `src/index.ts`

**Interfaces:**
- Consumes: `schema`, `ensureSchema`, `AppDb` (Task 1); `mountGating` (Task 4).
- Produces: `resolveAggregatorDb(): Promise<{ db: AppDb; onStop: () => Promise<void>; mode: "postgres" | "pglite" }>` — Postgres when `DATABASE_URL` is set, else embedded pglite. Either way `ensureSchema` is applied.

- [ ] **Step 1: Write the failing test**

Create `src/aggregator/__tests__/localDb.test.ts`:

```ts
import { describe, it, expect, afterEach } from "vitest";
import { resolveAggregatorDb } from "../localDb.js";
import { issueKey, verifyKey } from "../apiKeys.js";

const orig = { ...process.env };
afterEach(() => { process.env = { ...orig }; });

describe("resolveAggregatorDb", () => {
  it("falls back to embedded pglite when DATABASE_URL is unset, with a usable schema", async () => {
    delete process.env.DATABASE_URL;
    const { db, onStop, mode } = await resolveAggregatorDb();
    expect(mode).toBe("pglite");
    const { plaintext } = await issueKey(db, "local"); // schema exists + writable
    expect(await verifyKey(db, plaintext)).not.toBeNull();
    await onStop();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test src/aggregator/__tests__/localDb.test.ts`
Expected: FAIL — `../localDb.js` not found.

- [ ] **Step 3: Write `localDb.ts`**

Create `src/aggregator/localDb.ts`:

```ts
// Chooses the aggregator's database: hosted Postgres when DATABASE_URL is set, otherwise an
// embedded pglite instance so the full gated aggregator runs locally with no external Postgres.
// pglite data is in-memory/ephemeral — for dev + validation, not production.
import { schema, ensureSchema, type AppDb } from "./schema.js";

export async function resolveAggregatorDb(): Promise<{ db: AppDb; onStop: () => Promise<void>; mode: "postgres" | "pglite" }> {
  const url = process.env.DATABASE_URL;
  if (url) {
    const { Pool } = await import("pg");
    const { drizzle } = await import("drizzle-orm/node-postgres");
    const pool = new Pool({ connectionString: url });
    const db = drizzle(pool, { schema }) as unknown as AppDb;
    await ensureSchema(db);
    return { db, onStop: () => pool.end(), mode: "postgres" };
  }
  const { PGlite } = await import("@electric-sql/pglite");
  const { drizzle } = await import("drizzle-orm/pglite");
  const pg = new PGlite();
  const db = drizzle(pg, { schema }) as unknown as AppDb;
  await ensureSchema(db);
  return { db, onStop: () => pg.close(), mode: "pglite" };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test src/aggregator/__tests__/localDb.test.ts`
Expected: PASS (`mode === "pglite"`, key round-trips).

- [ ] **Step 5: Wire `index.ts`**

In `src/index.ts`, replace the existing aggregator block:

```ts
  if (process.env.DATABASE_URL) {
    const pool = new Pool({ connectionString: process.env.DATABASE_URL });
    const db = drizzle(pool, { schema });
    await ensureSchema(db as never);
    registerDrizzle(app, db, { onStop: () => pool.end() });
    app.restController(AggregatorController);
  }
```

with:

```ts
  // Aggregator (B1) + gating: always registered now — Postgres when DATABASE_URL is set, else
  // embedded pglite for local runs (ephemeral). mountGating adds the api-key identity middleware
  // + the two-tier rate limiters over /api/aggregator.
  {
    const { db, onStop, mode } = await resolveAggregatorDb();
    registerDrizzle(app, db as never, { onStop });
    app.restController(AggregatorController);
    await mountGating(app, db);
    console.log(`aggregator: ${mode}${mode === "pglite" ? " (set DATABASE_URL for Postgres)" : ""}`);
  }
```

Update the imports at the top of `src/index.ts`: remove the now-unused `Pool` (from `"pg"`) and `drizzle` (from `"drizzle-orm/node-postgres"`) imports **only if** nothing else in the file uses them (they moved into `localDb.ts`); keep `registerDrizzle`, `ensureSchema`, `schema`, `AggregatorController`. Add:

```ts
import { resolveAggregatorDb } from "./aggregator/localDb.js";
import { mountGating } from "./gating.js";
```

> `ensureSchema`/`schema` may become unused in `index.ts` after this move — remove an import only when `tsc` reports it unused, and only the ones your change orphaned.

- [ ] **Step 6: Typecheck + full suite**

Run: `pnpm exec tsc -b && pnpm test`
Expected: tsc clean; the full server suite passes (the pre-existing `dist`-dependent failures, if any, are unrelated — note them but don't fix here).

- [ ] **Step 7: Commit**

```bash
git add src/aggregator/localDb.ts src/aggregator/__tests__/localDb.test.ts src/index.ts
git commit -m "feat(gating): embedded pglite local mode + mount gating in the server"
```

---

## Final verification (live local run — the spec's acceptance check)

- [ ] Build + start the server with no `DATABASE_URL` and a known admin token:

```bash
AGGREGATOR_ADMIN_TOKEN=devtoken AGG_ANON_POINTS=3 pnpm build && \
AGGREGATOR_ADMIN_TOKEN=devtoken AGG_ANON_POINTS=3 node dist/index.js &
```

- [ ] Mint a key:

```bash
curl -s -XPOST localhost:4317/api/aggregator/keys -H 'content-type: application/json' \
  -d '{"token":"devtoken","label":"smoke"}'   # → {"ok":true,"id":...,"key":"ag_...","label":"smoke"}
```

- [ ] Exceed the anonymous limit (4th request within the window → 429, with `RateLimit-*` headers):

```bash
for i in 1 2 3 4; do curl -s -o /dev/null -w "%{http_code}\n" localhost:4317/api/aggregator/overview; done
# expect 200 200 200 429
```

- [ ] Repeat with the key — stays 200 past the anon ceiling:

```bash
for i in 1 2 3 4 5; do curl -s -o /dev/null -w "%{http_code}\n" \
  -H "x-api-key: ag_..." localhost:4317/api/aggregator/overview; done
# expect all 200
```

- [ ] Bad key → 401:

```bash
curl -s -o /dev/null -w "%{http_code}\n" -H 'x-api-key: ag_bogus' localhost:4317/api/aggregator/overview  # 401
```

- [ ] Stop the server (`kill %1`).
