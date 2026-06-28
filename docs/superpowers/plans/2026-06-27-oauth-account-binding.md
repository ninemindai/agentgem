# OAuth account-binding Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Bind producer ed25519 keys to GitHub accounts via OAuth device flow, and expose a `verifiedProducers` overlay (distinct bound accounts) alongside the raw distinct-pubkey count on every public aggregate.

**Architecture:** A new `account_bindings` table (keyed by pubkey) records server-verified key↔account links. `agentgem bind` runs GitHub's device flow locally, obtains an access token, signs a bind request with the local ed25519 key, and POSTs `{pubkey, token, signedAt, signature}` to the aggregator. The server verifies the signature (key possession) + the token via an `AccountVerifier` seam (account possession), then upserts the binding. Aggregates LEFT JOIN the binding table and add a `verifiedProducers` count — non-breaking; the raw count and k-anon gate are unchanged.

**Tech Stack:** TypeScript (ESM, Node ≥22), drizzle-orm + `@agentback/drizzle` (pglite in tests / node-postgres in prod), `@agentback/openapi` decorators, zod 4, vitest (runs compiled `dist/`), node:crypto ed25519.

## Global Constraints

- Node ≥22, `"type": "module"`: all relative imports end in `.js` (e.g. `import { x } from "./schema.js"`).
- Tests run from **compiled** `dist/`: `vitest.config.ts` includes `dist/**/__tests__/**/*.test.js`. The `npm test` script is `tsc -b && vitest run`, so it builds first. Run a single test file with `npm test -- dist/<path>.test.js`.
- zod 4: use `.loose()` not `.passthrough()`.
- Identity public-key token format is `ed25519:<spki-der-base64>` (`src/gem/identity.ts`). Sign/verify via that module's `verify(pubkey, data, sigB64)` and `Identity.sign(data)`.
- Canonical signing payloads use `canonicalJSON` from `src/gem/attestation.ts` (sorted keys) so client and server hash identically.
- The k-anon gate stays exactly `having count(distinct a.producer_pubkey) >= ${k}` (keyed on the RAW pubkey count). `verifiedProducers` is purely additive and never gates suppression.
- `POST /api/aggregator/bind` is a WRITE: it must NOT be added to `originGuard`'s `PUBLIC_READ_PATHS`. It stays default-guarded (cross-site blocked, non-browser CLI allowed).
- camelCase result fields from raw SQL require a quoted alias: `... as "verifiedProducers"`.
- Commits: author `Raymond Feng <raymond@ninemind.ai>`; message body ends with a line `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`. Use `git -c user.name=... -c user.email=...`.
- Branch is `feat/oauth-account-binding` (already created off `origin/main`). Do not create a new branch.

---

### Task 1: `account_bindings` schema + DDL

**Files:**
- Modify: `src/aggregator/schema.ts`
- Test: `src/aggregator/__tests__/bindings.schema.test.ts` (create)

**Interfaces:**
- Produces: `accountBindings` pgTable (columns `pubkey` PK → `producers.pubkey`, `provider`, `accountId`/`account_id`, `accountLogin`/`account_login`, `boundAt`/`bound_at`); added to the `schema` export and to `ensureSchema`.

- [ ] **Step 1: Write the failing test**

Create `src/aggregator/__tests__/bindings.schema.test.ts`:

```ts
// src/aggregator/__tests__/bindings.schema.test.ts
import { describe, it, expect } from "vitest";
import { makeTestDb } from "../testDb.js";
import { producers, accountBindings } from "../schema.js";

describe("account_bindings schema", () => {
  it("stores a binding and reads it back", async () => {
    const db = await makeTestDb();
    await db.insert(producers).values({ pubkey: "ed25519:p1" });
    await db.insert(accountBindings).values({ pubkey: "ed25519:p1", provider: "github", accountId: "42", accountLogin: "octocat" });
    const rows = await db.select().from(accountBindings);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ pubkey: "ed25519:p1", provider: "github", accountId: "42", accountLogin: "octocat" });
  });
  it("rejects a binding for a non-existent producer (FK)", async () => {
    const db = await makeTestDb();
    await expect(
      db.insert(accountBindings).values({ pubkey: "ed25519:ghost", provider: "github", accountId: "1", accountLogin: "x" }),
    ).rejects.toThrow();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- dist/aggregator/__tests__/bindings.schema.test.js`
Expected: FAIL — `accountBindings` is not exported from `../schema.js` (build or import error).

- [ ] **Step 3: Implement the schema**

In `src/aggregator/schema.ts`, add the table after `usageEdges` (before the `schema` export):

```ts
export const accountBindings = pgTable("account_bindings", {
  pubkey: text("pubkey").primaryKey().references(() => producers.pubkey),
  provider: text("provider").notNull(),
  accountId: text("account_id").notNull(),
  accountLogin: text("account_login").notNull(),
  boundAt: timestamp("bound_at", { withTimezone: true }).notNull().defaultNow(),
});
```

Update the `schema` export to include it:

```ts
export const schema = { producers, attestations, ingredients, usageEdges, accountBindings };
```

Add the DDL as the last statement in `ensureSchema`:

```ts
  await db.execute(sql`create table if not exists account_bindings (pubkey text primary key references producers(pubkey), provider text not null, account_id text not null, account_login text not null, bound_at timestamptz not null default now())`);
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- dist/aggregator/__tests__/bindings.schema.test.js`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add src/aggregator/schema.ts src/aggregator/__tests__/bindings.schema.test.ts
git -c user.name="Raymond Feng" -c user.email="raymond@ninemind.ai" commit -m "feat(aggregator): account_bindings table (pubkey -> github account)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 2: `AccountVerifier` seam + `GitHubVerifier`

**Files:**
- Create: `src/aggregator/accountVerifier.ts`
- Test: `src/aggregator/__tests__/accountVerifier.test.ts` (create)

**Interfaces:**
- Produces:
  - `interface VerifiedAccount { provider: string; accountId: string; login: string }`
  - `interface AccountVerifier { verify(token: string): Promise<VerifiedAccount> }` — throws on an invalid/expired token or provider error.
  - `class GitHubVerifier implements AccountVerifier` — constructor `(fetchImpl: typeof fetch = fetch)`.

- [ ] **Step 1: Write the failing test**

Create `src/aggregator/__tests__/accountVerifier.test.ts`:

```ts
// src/aggregator/__tests__/accountVerifier.test.ts
import { describe, it, expect } from "vitest";
import { GitHubVerifier } from "../accountVerifier.js";

function fakeFetch(status: number, body: unknown): typeof fetch {
  return (async () => ({ ok: status >= 200 && status < 300, status, json: async () => body })) as unknown as typeof fetch;
}

describe("GitHubVerifier", () => {
  it("maps GitHub /user to a VerifiedAccount", async () => {
    const v = new GitHubVerifier(fakeFetch(200, { id: 42, login: "octocat" }));
    expect(await v.verify("tok")).toEqual({ provider: "github", accountId: "42", login: "octocat" });
  });
  it("throws on a non-2xx response", async () => {
    const v = new GitHubVerifier(fakeFetch(401, { message: "Bad credentials" }));
    await expect(v.verify("tok")).rejects.toThrow();
  });
  it("throws on an unexpected body shape", async () => {
    const v = new GitHubVerifier(fakeFetch(200, { login: "octocat" })); // no id
    await expect(v.verify("tok")).rejects.toThrow();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- dist/aggregator/__tests__/accountVerifier.test.js`
Expected: FAIL — cannot find module `../accountVerifier.js`.

- [ ] **Step 3: Implement the verifier**

Create `src/aggregator/accountVerifier.ts`:

```ts
// src/aggregator/accountVerifier.ts
// The provider seam: the only network dependency in the binding path. Tests inject a fake.
export interface VerifiedAccount { provider: string; accountId: string; login: string; }
export interface AccountVerifier { verify(token: string): Promise<VerifiedAccount>; }

export class GitHubVerifier implements AccountVerifier {
  constructor(private fetchImpl: typeof fetch = fetch) {}
  async verify(token: string): Promise<VerifiedAccount> {
    const res = await this.fetchImpl("https://api.github.com/user", {
      headers: { Authorization: `Bearer ${token}`, "User-Agent": "agentgem", Accept: "application/vnd.github+json" },
    });
    if (!res.ok) throw new Error(`github /user: ${res.status}`);
    const u = (await res.json()) as { id?: unknown; login?: unknown };
    if (typeof u.id !== "number" || typeof u.login !== "string") throw new Error("github /user: unexpected shape");
    // accountId is the numeric id as text (stable across login renames); login is for display only.
    return { provider: "github", accountId: String(u.id), login: u.login };
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- dist/aggregator/__tests__/accountVerifier.test.js`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add src/aggregator/accountVerifier.ts src/aggregator/__tests__/accountVerifier.test.ts
git -c user.name="Raymond Feng" -c user.email="raymond@ninemind.ai" commit -m "feat(aggregator): AccountVerifier seam + GitHubVerifier

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 3: `recordBinding` — signature + freshness + upsert

**Files:**
- Create: `src/aggregator/binding.ts`
- Test: `src/aggregator/__tests__/binding.test.ts` (create)

**Interfaces:**
- Consumes: `verify` from `../gem/identity.js`; `canonicalJSON` from `../gem/attestation.js`; `accountBindings`, `producers` from `./schema.js`; `AccountVerifier`/`VerifiedAccount` from `./accountVerifier.js`.
- Produces:
  - `interface BindRequest { pubkey: string; token: string; signedAt: number; signature: string }`
  - `type BindResult = { bound: true; provider: string; login: string; accountId: string } | { bound: false; rejected: "bad-signature" | "stale" | "unknown-producer" | "provider-error" }`
  - `bindSigningPayload(pubkey: string, token: string, signedAt: number): string` — the exact string both client and server sign.
  - `recordBinding(db, req: BindRequest, verifier: AccountVerifier, now?: number): Promise<BindResult>`

- [ ] **Step 1: Write the failing test**

Create `src/aggregator/__tests__/binding.test.ts`:

```ts
// src/aggregator/__tests__/binding.test.ts
import { describe, it, expect } from "vitest";
import { generateKeyPairSync, sign as edSign } from "node:crypto";
import { makeTestDb } from "../testDb.js";
import { producers, accountBindings } from "../schema.js";
import { recordBinding, bindSigningPayload, type BindRequest } from "../binding.js";
import type { AccountVerifier, VerifiedAccount } from "../accountVerifier.js";

function makeSigner() {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const pubkey = "ed25519:" + publicKey.export({ format: "der", type: "spki" }).toString("base64");
  return { pubkey, sign: (d: string) => edSign(null, Buffer.from(d, "utf8"), privateKey).toString("base64") };
}
const fakeVerifier = (acct: VerifiedAccount): AccountVerifier => ({ verify: async () => acct });
const throwingVerifier: AccountVerifier = { verify: async () => { throw new Error("bad token"); } };
const OCTOCAT: VerifiedAccount = { provider: "github", accountId: "42", login: "octocat" };

async function req(signer: ReturnType<typeof makeSigner>, token: string, signedAt: number): Promise<BindRequest> {
  return { pubkey: signer.pubkey, token, signedAt, signature: signer.sign(bindSigningPayload(signer.pubkey, token, signedAt)) };
}

describe("recordBinding", () => {
  it("records a binding for a valid signature + verified token + existing producer", async () => {
    const db = await makeTestDb();
    const s = makeSigner();
    await db.insert(producers).values({ pubkey: s.pubkey });
    const now = 1_000_000;
    const res = await recordBinding(db, await req(s, "tok", now), fakeVerifier(OCTOCAT), now);
    expect(res).toEqual({ bound: true, provider: "github", login: "octocat", accountId: "42" });
    const rows = await db.select().from(accountBindings);
    expect(rows).toHaveLength(1);
    expect(rows[0].accountId).toBe("42");
  });
  it("rejects a bad signature", async () => {
    const db = await makeTestDb();
    const s = makeSigner();
    await db.insert(producers).values({ pubkey: s.pubkey });
    const now = 1_000_000;
    const bad = { ...(await req(s, "tok", now)), signature: "AAAA" };
    expect(await recordBinding(db, bad, fakeVerifier(OCTOCAT), now)).toEqual({ bound: false, rejected: "bad-signature" });
  });
  it("rejects a stale signedAt (> 300s skew)", async () => {
    const db = await makeTestDb();
    const s = makeSigner();
    await db.insert(producers).values({ pubkey: s.pubkey });
    const signedAt = 1_000_000;
    const res = await recordBinding(db, await req(s, "tok", signedAt), fakeVerifier(OCTOCAT), signedAt + 300_001);
    expect(res).toEqual({ bound: false, rejected: "stale" });
  });
  it("rejects an unknown producer (no producer row)", async () => {
    const db = await makeTestDb();
    const s = makeSigner();
    const now = 1_000_000;
    expect(await recordBinding(db, await req(s, "tok", now), fakeVerifier(OCTOCAT), now)).toEqual({ bound: false, rejected: "unknown-producer" });
  });
  it("maps a provider error", async () => {
    const db = await makeTestDb();
    const s = makeSigner();
    await db.insert(producers).values({ pubkey: s.pubkey });
    const now = 1_000_000;
    expect(await recordBinding(db, await req(s, "tok", now), throwingVerifier, now)).toEqual({ bound: false, rejected: "provider-error" });
  });
  it("is idempotent and updates in place on rebind to a different account", async () => {
    const db = await makeTestDb();
    const s = makeSigner();
    await db.insert(producers).values({ pubkey: s.pubkey });
    const now = 1_000_000;
    await recordBinding(db, await req(s, "tok", now), fakeVerifier(OCTOCAT), now);
    await recordBinding(db, await req(s, "tok2", now), fakeVerifier({ provider: "github", accountId: "99", login: "hubot" }), now);
    const rows = await db.select().from(accountBindings);
    expect(rows).toHaveLength(1);              // still one row for this pubkey
    expect(rows[0].accountId).toBe("99");      // updated in place
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- dist/aggregator/__tests__/binding.test.js`
Expected: FAIL — cannot find module `../binding.js`.

- [ ] **Step 3: Implement `recordBinding`**

Create `src/aggregator/binding.ts`:

```ts
// src/aggregator/binding.ts
// Records a server-verified pubkey -> account binding. Two proofs combine: the ed25519
// signature proves key possession; the token (verified live by AccountVerifier) proves
// account possession. Replays are idempotent; a signedAt freshness window blocks stale tokens.
import { createHash } from "node:crypto";
import { sql } from "drizzle-orm";
import { verify } from "../gem/identity.js";
import { canonicalJSON } from "../gem/attestation.js";
import type { AppDb } from "./schema.js";
import { accountBindings } from "./schema.js";
import type { AccountVerifier } from "./accountVerifier.js";

export interface BindRequest { pubkey: string; token: string; signedAt: number; signature: string; }
export type BindResult =
  | { bound: true; provider: string; login: string; accountId: string }
  | { bound: false; rejected: "bad-signature" | "stale" | "unknown-producer" | "provider-error" };

const FRESHNESS_MS = 300_000;

/** The exact string the client signs and the server verifies. Signs over sha256(token) — never the
 *  raw token — so the secret stays out of the canonical (loggable) payload. */
export function bindSigningPayload(pubkey: string, token: string, signedAt: number): string {
  const tokenHash = createHash("sha256").update(token).digest("hex");
  return canonicalJSON({ pubkey, signedAt, tokenHash });
}

export async function recordBinding(
  db: AppDb, req: BindRequest, verifier: AccountVerifier, now: number = Date.now(),
): Promise<BindResult> {
  // 1. key possession (cheap, no DB, no leak)
  if (!verify(req.pubkey, bindSigningPayload(req.pubkey, req.token, req.signedAt), req.signature)) {
    return { bound: false, rejected: "bad-signature" };
  }
  // 2. freshness
  if (!Number.isFinite(req.signedAt) || Math.abs(now - req.signedAt) > FRESHNESS_MS) {
    return { bound: false, rejected: "stale" };
  }
  // 3. producer must exist (FK + a clear "share before binding" signal)
  const prod = await db.execute<{ pubkey: string }>(sql`select pubkey from producers where pubkey = ${req.pubkey}`);
  if (prod.rows.length === 0) return { bound: false, rejected: "unknown-producer" };
  // 4. account possession (live)
  let acct;
  try { acct = await verifier.verify(req.token); }
  catch { return { bound: false, rejected: "provider-error" }; }
  // 5. upsert (pubkey PK -> one account per key; rebind updates in place)
  await db.insert(accountBindings)
    .values({ pubkey: req.pubkey, provider: acct.provider, accountId: acct.accountId, accountLogin: acct.login })
    .onConflictDoUpdate({
      target: accountBindings.pubkey,
      set: { provider: acct.provider, accountId: acct.accountId, accountLogin: acct.login, boundAt: sql`now()` },
    });
  return { bound: true, provider: acct.provider, login: acct.login, accountId: acct.accountId };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- dist/aggregator/__tests__/binding.test.js`
Expected: PASS (6 tests).

- [ ] **Step 5: Commit**

```bash
git add src/aggregator/binding.ts src/aggregator/__tests__/binding.test.ts
git -c user.name="Raymond Feng" -c user.email="raymond@ninemind.ai" commit -m "feat(aggregator): recordBinding (sig + freshness + upsert)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 4: `verifiedProducers` overlay on aggregates

**Files:**
- Modify: `src/aggregator/aggregates.ts`
- Test: `src/aggregator/__tests__/verifiedProducers.test.ts` (create)

**Interfaces:**
- Consumes: `accountBindings`, `producers` from `./schema.js` (in the test).
- Produces (changed return types — later tasks/UI rely on these field names):
  - `popularity(...)` rows gain `verifiedProducers: number`.
  - `coOccurrence(...)` rows gain `verifiedProducers: number`.
  - `adoption(...)` rows gain `verifiedProducers: number`.

- [ ] **Step 1: Write the failing test**

Create `src/aggregator/__tests__/verifiedProducers.test.ts`:

```ts
// src/aggregator/__tests__/verifiedProducers.test.ts
import { describe, it, expect } from "vitest";
import { sql } from "drizzle-orm";
import { makeTestDb } from "../testDb.js";
import { projectAttestation } from "../project.js";
import { accountBindings } from "../schema.js";
import { popularity, coOccurrence, adoption } from "../aggregates.js";
import type { AppDb } from "../schema.js";

function att(pubkey: string, digest: string, skills: string[]) {
  return { formatVersion: 1, canonicalizerVersion: 3, gem: { name: "g", digest },
    producer: { publicKey: pubkey, account: null },
    source: { harness: { id: "claude-code" }, models: [], scan: { sessions: 2, spanDays: 1, firstMs: 0, lastMs: 0 } },
    ingredients: { skills: skills.map((id) => ({ id, idKind: "plugin", public: true, invocations: 2, sessions: 1 })), mcps: [] },
    evidence: { signalDigest: "d" }, signedAt: 1, signature: "x" } as never;
}
async function bind(db: AppDb, pubkey: string, accountId: string) {
  await db.insert(accountBindings).values({ pubkey, provider: "github", accountId, accountLogin: "u" + accountId });
}

describe("verifiedProducers overlay", () => {
  it("popularity: two keys on one account collapse to 1 verified; unbound counts raw-only", async () => {
    const db = await makeTestDb();
    await projectAttestation(db, att("ed25519:p1", "d1", ["skill:a"]));
    await projectAttestation(db, att("ed25519:p2", "d2", ["skill:a"]));
    await projectAttestation(db, att("ed25519:p3", "d3", ["skill:a"])); // unbound
    await bind(db, "ed25519:p1", "100");
    await bind(db, "ed25519:p2", "100"); // same account as p1
    const [row] = await popularity(db, { kind: "skill", k: 1 });
    expect(row.producers).toBe(3);           // raw distinct keys
    expect(row.verifiedProducers).toBe(1);   // p1+p2 -> one account; p3 unbound -> not counted
  });
  it("coOccurrence and adoption expose verifiedProducers", async () => {
    const db = await makeTestDb();
    await projectAttestation(db, att("ed25519:p1", "d1", ["skill:a", "skill:x"]));
    await projectAttestation(db, att("ed25519:p2", "d2", ["skill:a", "skill:x"]));
    await bind(db, "ed25519:p1", "100");
    await bind(db, "ed25519:p2", "100");
    const co = await coOccurrence(db, { id: "skill:a", k: 1 });
    const x = co.find((r) => r.id === "skill:x")!;
    expect(x.producers).toBe(2);
    expect(x.verifiedProducers).toBe(1);
    const ad = await adoption(db, { id: "skill:a", k: 1 });
    expect(ad[0].producers).toBe(2);
    expect(ad[0].verifiedProducers).toBe(1);
  });
  it("excludes quarantined attestations from both counts", async () => {
    const db = await makeTestDb();
    await projectAttestation(db, att("ed25519:p1", "d1", ["skill:a"]));
    await bind(db, "ed25519:p1", "100");
    // quarantine the only attestation -> skill:a disappears from aggregates entirely
    await db.execute(sql`update attestations set quarantined = true`);
    expect(await popularity(db, { kind: "skill", k: 1 })).toEqual([]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- dist/aggregator/__tests__/verifiedProducers.test.js`
Expected: FAIL — `row.verifiedProducers` is `undefined` (property does not exist yet).

- [ ] **Step 3: Add the overlay to all three aggregates**

In `src/aggregator/aggregates.ts`, replace each function's body. `popularity`:

```ts
export async function popularity(
  db: AppDb, opts: { kind?: string; limit?: number; k?: number } = {},
): Promise<{ id: string; kind: string; producers: number; verifiedProducers: number; invocations: number; sessions: number }[]> {
  const k = opts.k ?? DEFAULT_K, limit = opts.limit ?? 100;
  const r = await db.execute<{ id: string; kind: string; producers: number; verifiedProducers: number; invocations: number; sessions: number }>(sql`
    select e.ingredient_id as id, i.kind,
           count(distinct a.producer_pubkey)::int as producers,
           count(distinct b.provider || ':' || b.account_id)::int as "verifiedProducers",
           sum(e.invocations)::int as invocations, sum(e.sessions)::int as sessions
    from usage_edges e
    join attestations a on a.id = e.attestation_id and not a.quarantined
    join ingredients  i on i.id = e.ingredient_id
    left join account_bindings b on b.pubkey = a.producer_pubkey
    where (${opts.kind ?? null}::text is null or i.kind = ${opts.kind ?? null})
    group by e.ingredient_id, i.kind
    having count(distinct a.producer_pubkey) >= ${k}
    order by producers desc, invocations desc
    limit ${limit}
  `);
  return r.rows as { id: string; kind: string; producers: number; verifiedProducers: number; invocations: number; sessions: number }[];
}
```

`coOccurrence`:

```ts
export async function coOccurrence(
  db: AppDb, opts: { id: string; limit?: number; k?: number },
): Promise<{ id: string; producers: number; verifiedProducers: number }[]> {
  const k = opts.k ?? DEFAULT_K, limit = opts.limit ?? 50;
  const r = await db.execute<{ id: string; producers: number; verifiedProducers: number }>(sql`
    select e2.ingredient_id as id,
           count(distinct a.producer_pubkey)::int as producers,
           count(distinct b.provider || ':' || b.account_id)::int as "verifiedProducers"
    from usage_edges e1
    join usage_edges e2 on e2.attestation_id = e1.attestation_id and e2.ingredient_id <> e1.ingredient_id
    join attestations a on a.id = e1.attestation_id and not a.quarantined
    left join account_bindings b on b.pubkey = a.producer_pubkey
    where e1.ingredient_id = ${opts.id}
    group by e2.ingredient_id
    having count(distinct a.producer_pubkey) >= ${k}
    order by producers desc
    limit ${limit}
  `);
  return r.rows as { id: string; producers: number; verifiedProducers: number }[];
}
```

`adoption`:

```ts
export async function adoption(
  db: AppDb, opts: { id: string; bucket?: "week" | "month"; k?: number },
): Promise<{ bucket: string; producers: number; verifiedProducers: number; invocations: number }[]> {
  const k = opts.k ?? DEFAULT_K;
  const bucket = opts.bucket === "month" ? "month" : "week"; // whitelist; never a raw caller value
  const r = await db.execute<{ bucket: string; producers: number; verifiedProducers: number; invocations: number }>(sql`
    select to_char(date_trunc(${bucket}, a.ingested_at), 'YYYY-MM-DD') as bucket,
           count(distinct a.producer_pubkey)::int as producers,
           count(distinct b.provider || ':' || b.account_id)::int as "verifiedProducers",
           sum(e.invocations)::int as invocations
    from usage_edges e
    join attestations a on a.id = e.attestation_id and not a.quarantined
    left join account_bindings b on b.pubkey = a.producer_pubkey
    where e.ingredient_id = ${opts.id}
    group by 1
    having count(distinct a.producer_pubkey) >= ${k}
    order by 1
  `);
  return r.rows as { bucket: string; producers: number; verifiedProducers: number; invocations: number }[];
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -- dist/aggregator/__tests__/verifiedProducers.test.js dist/aggregator/__tests__/aggregates.test.js`
Expected: PASS — the new file (3 tests) AND the existing `aggregates.test.js` still green (the added column does not break existing assertions).

- [ ] **Step 5: Commit**

```bash
git add src/aggregator/aggregates.ts src/aggregator/__tests__/verifiedProducers.test.ts
git -c user.name="Raymond Feng" -c user.email="raymond@ninemind.ai" commit -m "feat(aggregator): verifiedProducers overlay on popularity/co-occurrence/adoption

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 5: `POST /bind` route + `verifiedProducers` in response schemas + guard test

**Files:**
- Modify: `src/aggregator.controller.ts`
- Modify: `src/__tests__/originGuard.test.ts`

**Interfaces:**
- Consumes: `recordBinding`, `BindRequest` from `./aggregator/binding.js`; `GitHubVerifier` from `./aggregator/accountVerifier.js`.
- Produces: `POST /api/aggregator/bind`; `verifiedProducers: z.number()` added to `PopResult`, `CoResult`, `AdoptResult`.

- [ ] **Step 1: Write the failing test (guard)**

In `src/__tests__/originGuard.test.ts`, add inside the `describe("originGuard — public aggregator reads ...")` block (next to the existing `/ingest` write-guard test):

```ts
  it("does NOT exempt the bind write — cross-site POST to /api/aggregator/bind stays guarded", () => {
    const r = run({ "sec-fetch-site": "cross-site" }, "agg.example", "POST", "/api/aggregator/bind");
    expect(r.blocked).toBe(true);
    expect(r.status).toBe(403);
  });
```

- [ ] **Step 2: Run test to verify current state**

Run: `npm test -- dist/__tests__/originGuard.test.js`
Expected: PASS already — `/api/aggregator/bind` is not in `PUBLIC_READ_PATHS`, so it is blocked by default. (This test pins that invariant so a future edit can't silently exempt the write.) If it FAILS, the route was wrongly added to `PUBLIC_READ_PATHS` — do not do that.

- [ ] **Step 3: Add the route and the schema field**

In `src/aggregator.controller.ts`, add imports near the top:

```ts
import { recordBinding } from "./aggregator/binding.js";
import { GitHubVerifier } from "./aggregator/accountVerifier.js";
```

Add bind schemas next to the other schema consts:

```ts
const BindBody = z.object({ pubkey: z.string(), token: z.string(), signedAt: z.number(), signature: z.string() });
const BindResultSchema = z.union([
  z.object({ bound: z.literal(true), provider: z.string(), login: z.string(), accountId: z.string() }),
  z.object({ bound: z.literal(false), rejected: z.string() }),
]);
```

Add `verifiedProducers: z.number()` to the three result schemas:

```ts
const PopResult = z.array(z.object({ id: z.string(), kind: z.string(), producers: z.number(), verifiedProducers: z.number(), invocations: z.number(), sessions: z.number() }));
const CoResult = z.array(z.object({ id: z.string(), producers: z.number(), verifiedProducers: z.number() }));
const AdoptResult = z.array(z.object({ bucket: z.string(), producers: z.number(), verifiedProducers: z.number(), invocations: z.number() }));
```

Add the route method to the `AggregatorController` class (after `adoption`):

```ts
  @post("/bind", { body: BindBody, response: BindResultSchema })
  async bind(input: { body: z.infer<typeof BindBody> }): Promise<z.infer<typeof BindResultSchema>> {
    // GitHubVerifier is the live provider; recordBinding does signature + freshness + producer checks.
    return recordBinding(this.db, input.body as z.infer<typeof BindBody>, new GitHubVerifier());
  }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -- dist/__tests__/originGuard.test.js`
Expected: PASS (including the new guard assertion). The build (`tsc -b`) must also succeed — confirming the result-schema types line up with the aggregate return types from Task 4.

- [ ] **Step 5: Commit**

```bash
git add src/aggregator.controller.ts src/__tests__/originGuard.test.ts
git -c user.name="Raymond Feng" -c user.email="raymond@ninemind.ai" commit -m "feat(aggregator): POST /bind route + verifiedProducers in response schemas

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 6: `agentgem bind` CLI + GitHub device-flow client

**Files:**
- Create: `src/bind/deviceFlow.ts`
- Create: `src/bind/cli.ts`
- Modify: `src/cli.ts`
- Test: `src/bind/__tests__/deviceFlow.test.ts` (create)

**Interfaces:**
- Consumes: `loadOrCreateIdentity` from `../gem/identity.js`; `bindSigningPayload` from `../aggregator/binding.js`.
- Produces:
  - `requestDeviceCode(clientId: string, fetchImpl?: typeof fetch): Promise<DeviceCode>` where `DeviceCode = { deviceCode, userCode, verificationUri, interval }`.
  - `pollForToken(clientId: string, deviceCode: string, opts?: { fetchImpl?; sleep?; intervalSec?; maxAttempts? }): Promise<string>`.
  - `main(argv: string[])` in `src/bind/cli.ts`.

- [ ] **Step 1: Write the failing test**

Create `src/bind/__tests__/deviceFlow.test.ts`:

```ts
// src/bind/__tests__/deviceFlow.test.ts
import { describe, it, expect } from "vitest";
import { requestDeviceCode, pollForToken } from "../deviceFlow.js";

function jsonFetch(...responses: unknown[]): typeof fetch {
  let i = 0;
  return (async () => { const body = responses[Math.min(i++, responses.length - 1)]; return { ok: true, status: 200, json: async () => body }; }) as unknown as typeof fetch;
}
const noSleep = async () => {};

describe("device flow", () => {
  it("requestDeviceCode maps the GitHub response", async () => {
    const f = jsonFetch({ device_code: "DC", user_code: "WXYZ-1234", verification_uri: "https://github.com/login/device", interval: 5 });
    expect(await requestDeviceCode("cid", f)).toEqual({ deviceCode: "DC", userCode: "WXYZ-1234", verificationUri: "https://github.com/login/device", interval: 5 });
  });
  it("pollForToken returns the token after authorization_pending", async () => {
    const f = jsonFetch({ error: "authorization_pending" }, { access_token: "gho_abc" });
    expect(await pollForToken("cid", "DC", { fetchImpl: f, sleep: noSleep })).toBe("gho_abc");
  });
  it("pollForToken throws on access_denied", async () => {
    const f = jsonFetch({ error: "access_denied" });
    await expect(pollForToken("cid", "DC", { fetchImpl: f, sleep: noSleep })).rejects.toThrow(/access_denied/);
  });
  it("pollForToken throws on expired_token", async () => {
    const f = jsonFetch({ error: "expired_token" });
    await expect(pollForToken("cid", "DC", { fetchImpl: f, sleep: noSleep })).rejects.toThrow(/expired_token/);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- dist/bind/__tests__/deviceFlow.test.js`
Expected: FAIL — cannot find module `../deviceFlow.js`.

- [ ] **Step 3: Implement the device-flow client**

Create `src/bind/deviceFlow.ts`:

```ts
// src/bind/deviceFlow.ts
// GitHub OAuth device flow (https://docs.github.com/apps/oauth-device-flow). No callback URL,
// no client secret — the CLI requests a code, the user approves in a browser, the CLI polls.
export interface DeviceCode { deviceCode: string; userCode: string; verificationUri: string; interval: number; }

export async function requestDeviceCode(clientId: string, fetchImpl: typeof fetch = fetch): Promise<DeviceCode> {
  const res = await fetchImpl("https://github.com/login/device/code", {
    method: "POST", headers: { Accept: "application/json", "Content-Type": "application/json" },
    body: JSON.stringify({ client_id: clientId, scope: "read:user" }),
  });
  if (!res.ok) throw new Error(`device/code: ${res.status}`);
  const j = (await res.json()) as { device_code: string; user_code: string; verification_uri: string; interval?: number };
  return { deviceCode: j.device_code, userCode: j.user_code, verificationUri: j.verification_uri, interval: j.interval ?? 5 };
}

export async function pollForToken(
  clientId: string, deviceCode: string,
  opts: { fetchImpl?: typeof fetch; sleep?: (ms: number) => Promise<void>; intervalSec?: number; maxAttempts?: number } = {},
): Promise<string> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  let intervalSec = opts.intervalSec ?? 5;
  const maxAttempts = opts.maxAttempts ?? 60;
  for (let i = 0; i < maxAttempts; i++) {
    const res = await fetchImpl("https://github.com/login/oauth/access_token", {
      method: "POST", headers: { Accept: "application/json", "Content-Type": "application/json" },
      body: JSON.stringify({ client_id: clientId, device_code: deviceCode, grant_type: "urn:ietf:params:oauth:grant-type:device_code" }),
    });
    const j = (await res.json()) as { access_token?: string; error?: string };
    if (j.access_token) return j.access_token;
    if (j.error === "authorization_pending") { await sleep(intervalSec * 1000); continue; }
    if (j.error === "slow_down") { intervalSec += 5; await sleep(intervalSec * 1000); continue; }
    throw new Error(`device flow: ${j.error ?? "unknown error"}`); // access_denied, expired_token, …
  }
  throw new Error("device flow: timed out waiting for authorization");
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- dist/bind/__tests__/deviceFlow.test.js`
Expected: PASS (4 tests).

- [ ] **Step 5: Implement the CLI command (thin wrapper, manually verified)**

Create `src/bind/cli.ts`:

```ts
// src/bind/cli.ts — `agentgem bind`: device-flow auth, then bind the local key to a GitHub account.
import { writeFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { loadOrCreateIdentity } from "../gem/identity.js";
import { bindSigningPayload } from "../aggregator/binding.js";
import { requestDeviceCode, pollForToken } from "./deviceFlow.js";

export async function main(_argv: string[]): Promise<void> {
  const clientId = process.env.AGENTGEM_GITHUB_CLIENT_ID;
  const base = process.env.AGENTGEM_AGGREGATOR_URL;
  if (!clientId) { console.error("agentgem bind: set AGENTGEM_GITHUB_CLIENT_ID (GitHub OAuth app client id)"); process.exitCode = 1; return; }
  if (!base) { console.error("agentgem bind: set AGENTGEM_AGGREGATOR_URL (hosted aggregator base URL)"); process.exitCode = 1; return; }

  const id = loadOrCreateIdentity();
  const dc = await requestDeviceCode(clientId);
  console.log(`\nTo bind this machine's key to your GitHub account:\n  1. open ${dc.verificationUri}\n  2. enter code: ${dc.userCode}\n`);
  const token = await pollForToken(clientId, dc.deviceCode, { intervalSec: dc.interval });

  const signedAt = Date.now();
  const signature = id.sign(bindSigningPayload(id.publicKey, token, signedAt));
  // CLI client: Node fetch sends no Origin/Sec-Fetch-Site, so originGuard treats it as a non-browser caller.
  const res = await fetch(new URL("/api/aggregator/bind", base), {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ pubkey: id.publicKey, token, signedAt, signature }),
  });
  const out = (await res.json()) as { bound: boolean; provider?: string; login?: string; accountId?: string; rejected?: string };
  if (!out.bound) { console.error(`agentgem bind: rejected (${out.rejected ?? "unknown"})`); process.exitCode = 1; return; }

  const dir = join(homedir(), ".agentgem");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  writeFileSync(join(dir, "binding.json"), JSON.stringify({ provider: out.provider, login: out.login, accountId: out.accountId, boundAt: new Date().toISOString() }), { mode: 0o600 });
  console.log(`✓ bound to ${out.provider}:@${out.login}`);
}
```

In `src/cli.ts`, add the dispatch branch immediately after the `send|receive` block (before the port parsing):

```ts
  // `agentgem bind` — bind this machine's signing key to a GitHub account (anti-sybil identity).
  if (argv[0] === "bind") {
    const { main: bindMain } = await import("./bind/cli.js");
    return bindMain(argv);
  }
```

Add a `bind` entry to the `HELP` string (append after the `receive` line):

```
  agentgem bind                         Bind this machine's key to your GitHub account
```

- [ ] **Step 6: Verify build + full suite + manual smoke**

Run: `npm test`
Expected: PASS — the whole suite (all aggregator + bind + originGuard tests) green, and `tsc -b` clean.

Manual smoke (no live GitHub app needed — confirms the env-guard path):
Run: `node dist/cli.js bind`
Expected: prints `agentgem bind: set AGENTGEM_GITHUB_CLIENT_ID …` and exits non-zero (because the env var is unset). Confirms dispatch + help wiring without needing a registered OAuth app.

- [ ] **Step 7: Commit**

```bash
git add src/bind/deviceFlow.ts src/bind/cli.ts src/cli.ts src/bind/__tests__/deviceFlow.test.ts
git -c user.name="Raymond Feng" -c user.email="raymond@ninemind.ai" commit -m "feat(cli): agentgem bind — GitHub device-flow account binding

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Deferred (NOT in this plan)

- Registering the real GitHub OAuth app (`client_id`) + prod env wiring + a true end-to-end against live GitHub and a reachable aggregator — rides with the deploy (#38).
- Surfacing the verified badge / `verifiedProducers` in the Insights UI — #42.
- Account-age / allowlist / review-state gating — #45.
- Provisioning a bare `producers` row at bind time (bind-before-share) — nicety; `recordBinding` returns `unknown-producer` until then.
