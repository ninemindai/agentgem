# Share-Archive Server (PR 2a) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A locally-authored miniapp can be uploaded to the aggregator **unlisted** and served at a copyable `app.agentgem.ai/games/<shareId>` URL, owned by the uploader's account so only they can revoke it.

**Architecture:** A signed `POST /api/aggregator/share-archive` verifies the uploader's ed25519 key → resolves it to an `accounts.id` UUID → re-gates the game HTML through `staticGate` → stores the archive under a scope-less `genShareId()` key with `owner_account_id` set, but **no `catalog_gems` row** (so it never lists). A signed `DELETE` revokes it, copying `deleteCatalogGem`'s fail-closed UUID ownership check. `game-meta`'s version resolution falls back to `gem_archives` so the scope-less URL resolves.

**Tech Stack:** TypeScript, AgentBack + Zod controllers, Drizzle/Postgres (PGlite in tests), Vitest. Ed25519 via `@agentgem/model`. Gem archive via `@agentgem/distribute`. Static gate via `@agentgem/play`.

## Global Constraints

- **Spec:** `docs/superpowers/specs/2026-07-09-entity-address-scheme-design.md` — read the *Minting a public address*, *The version-resolution fallback*, and *Revocation* sections.
- **Worktree:** `../agentgem-share-archive`, branch `feat/miniapp-share-archive`, branched off `origin/main`. Do not commit to `main`.
- **Build on `origin/main`.** The identity re-key (PR #285) is already merged there: `accounts.id` (== `"user".id`) is the authorizing UUID; `catalog_gems.owner_account_id` + `deleteCatalogGem`'s check are the pattern to copy. Do NOT branch from `feat/identity-rekey` — it is a stale snapshot 47 commits behind.
- **Ownership = `accounts.id` UUID.** Never a login string, never the device pubkey. Compare UUID `===`; **a NULL owner is owned by nobody, fail closed** — never a string-compare fallback.
- **This is server + tests ONLY.** No console UI, no marketplace changes. Those are PR 2b.
- **Server tests run compiled `dist/`.** `vitest.config.ts` includes `dist/**/__tests__/**/*.test.js`. Always `pnpm build` before running a server test, and focused paths name the **`dist/` `.js`** file. After any cross-lineage rebase, `rm -rf dist packages/*/dist *.tsbuildinfo` before rebuild — `tsc -b` leaves stale orphans that vitest runs as phantom failures.
- **`AgentError` exposes `.statusCode`, NOT `.status`** — assert `toMatchObject({ statusCode: 404 })`.
- **The mint/revoke routes are console-originated** (origin-less Node fetch), so they pass `originGuard`'s fall-through unchanged — **no `PUBLIC_READ_PATHS`/`PUBLIC_WRITE_PATHS` entry**. Do NOT add one; a public-write entry would let any web page mint shares.

---

### Task 1: `resolveSignedAccount` — reusable pubkey → accounts.id resolver

Extract the verify + freshness + binding→account chain that lives inline in `recordCatalogShare`, so mint and revoke both reuse it with different signed payloads. Refactor `recordCatalogShare` to call it (DRY, and its tests cover the refactor).

**Files:**
- Modify: `packages/aggregator/src/catalog.ts` (add helper ~after line 117; refactor `recordCatalogShare` at 134-161)
- Test: `packages/aggregator/src/__tests__/resolveSignedAccount.test.ts` (create — note the aggregator package's tests live under `packages/aggregator/src/__tests__/`, compiled to `packages/aggregator/dist/__tests__/`)

**Interfaces:**
- Consumes: `verify` (`@agentgem/model`), `canonicalJSON` (`@agentgem/insight`), `producers`, `accountBindings`, `accounts` (already imported in catalog.ts).
- Produces:
  - `type SignedAccount = { ok: true; accountId: string; login: string } | { ok: false; rejected: "bad-signature" | "stale" | "not-connected" }`
  - `resolveSignedAccount(db: AppDb, args: { pubkey: string; payload: string; signedAt: number; signature: string }, now?: number): Promise<SignedAccount>`

- [ ] **Step 1: Write the failing test**

Create `packages/aggregator/src/__tests__/resolveSignedAccount.test.ts`:

```ts
// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
import { describe, it, expect } from "vitest";
import { generateKeyPairSync, sign as edSign, randomUUID } from "node:crypto";
import { makeTestDb, producers, accountBindings, accounts, resolveSignedAccount } from "@agentgem/aggregator";

function signer() {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const pubkey = "ed25519:" + publicKey.export({ format: "der", type: "spki" }).toString("base64");
  return { pubkey, sign: (d: string) => edSign(null, Buffer.from(d, "utf8"), privateKey).toString("base64") };
}

async function boundDb() {
  const db = await makeTestDb();
  const s = signer();
  await db.insert(producers).values({ pubkey: s.pubkey });
  await db.insert(accounts).values({ id: randomUUID(), provider: "github", providerAccountId: "1", login: "octocat" });
  await db.insert(accountBindings).values({ pubkey: s.pubkey, provider: "github", accountId: "1", accountLogin: "octocat" });
  return { db, s };
}

describe("resolveSignedAccount", () => {
  it("resolves a bound key over an arbitrary payload to its accounts.id + login", async () => {
    const { db, s } = await boundDb();
    const signedAt = Date.now();
    const payload = "revoke:xK3f9a2Bq1";
    const r = await resolveSignedAccount(db, { pubkey: s.pubkey, payload, signedAt, signature: s.sign(payload) });
    expect(r.ok).toBe(true);
    if (r.ok) { expect(r.login).toBe("octocat"); expect(r.accountId).toMatch(/[0-9a-f-]{36}/); }
  });

  it("rejects a bad signature", async () => {
    const { db, s } = await boundDb();
    const r = await resolveSignedAccount(db, { pubkey: s.pubkey, payload: "p", signedAt: Date.now(), signature: s.sign("other") });
    expect(r).toEqual({ ok: false, rejected: "bad-signature" });
  });

  it("rejects a stale signedAt (> 300s skew)", async () => {
    const { db, s } = await boundDb();
    const signedAt = Date.now() - 400_000;
    const r = await resolveSignedAccount(db, { pubkey: s.pubkey, payload: "p", signedAt, signature: s.sign("p") });
    expect(r).toEqual({ ok: false, rejected: "stale" });
  });

  it("rejects an unbound key as not-connected", async () => {
    const db = await makeTestDb();
    const s = signer();
    const r = await resolveSignedAccount(db, { pubkey: s.pubkey, payload: "p", signedAt: Date.now(), signature: s.sign("p") });
    expect(r).toEqual({ ok: false, rejected: "not-connected" });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
pnpm build && pnpm exec vitest run packages/aggregator/dist/__tests__/resolveSignedAccount.test.js
```

Expected: FAIL at build — `resolveSignedAccount is not exported`.

- [ ] **Step 3: Add the helper and refactor `recordCatalogShare`**

In `packages/aggregator/src/catalog.ts`, add after the `FRESHNESS_MS` constant (~line 117):

```ts
export type SignedAccount =
  | { ok: true; accountId: string; login: string }
  | { ok: false; rejected: "bad-signature" | "stale" | "not-connected" };

// The account-resolution chain shared by every signed WRITE: prove key possession over `payload`,
// check freshness, then resolve the producer key to its authorizing accounts.id (== "user".id) via
// the binding. Callers pass whatever canonical payload their route signs (a manifest hash for
// publish/mint, the shareId for revoke). Fail-closed: an unbound or unresolvable key owns nothing.
export async function resolveSignedAccount(
  db: AppDb,
  args: { pubkey: string; payload: string; signedAt: number; signature: string },
  now: number = Date.now(),
): Promise<SignedAccount> {
  if (!verify(args.pubkey, args.payload, args.signature)) return { ok: false, rejected: "bad-signature" };
  if (!Number.isFinite(args.signedAt) || Math.abs(now - args.signedAt) > FRESHNESS_MS) return { ok: false, rejected: "stale" };
  await db.insert(producers).values({ pubkey: args.pubkey }).onConflictDoNothing();
  const bind = (await db.select().from(accountBindings).where(sql`pubkey = ${args.pubkey}`))[0];
  if (!bind) return { ok: false, rejected: "not-connected" };
  const acct = (await db.select({ id: accounts.id }).from(accounts)
    .where(and(eq(accounts.provider, bind.provider), eq(accounts.providerAccountId, bind.accountId))).limit(1))[0];
  if (!acct) return { ok: false, rejected: "not-connected" };
  return { ok: true, accountId: acct.id, login: bind.accountLogin };
}
```

Then refactor `recordCatalogShare` (lines 134-161) to call it — replacing the inline verify/freshness/binding/account block with:

```ts
export async function recordCatalogShare(db: AppDb, req: ShareRequest, now: number = Date.now()): Promise<ShareResult> {
  const who = await resolveSignedAccount(db, {
    pubkey: req.pubkey, payload: catalogSigningPayload(req.manifest, req.pubkey, req.signedAt),
    signedAt: req.signedAt, signature: req.signature,
  }, now);
  if (!who.ok) return { shared: false, rejected: who.rejected };
  const m = req.manifest;
  await upsertCatalogGem(db, {
    gemKey: m.gemKey, version: m.version, publishedBy: who.login, ownerAccountId: who.accountId,
    author: m.author, description: m.description, tags: m.tags, artifactKinds: m.artifactKinds,
    type: m.type, grade: clampGrade(m.grade), artifacts: m.artifacts, createdAtMs: now,
  });
  return { shared: true, publishedBy: who.login, gemKey: m.gemKey, version: m.version };
}
```

Note: `catalogSigningPayload` is defined below `recordCatalogShare` in the file; it's a `function` declaration (hoisted), so the call is fine. Leave `catalogSigningPayload`, `verify`, `FRESHNESS_MS`, and all imports as they are.

- [ ] **Step 4: Verify both the new test and the existing publish tests pass**

```bash
pnpm build && pnpm exec vitest run packages/aggregator/dist/__tests__/resolveSignedAccount.test.js dist/aggregator/__tests__/publishGem.controller.test.js dist/aggregator/__tests__/catalogShare.test.js
```

Expected: all PASS. The refactor must not change `recordCatalogShare`'s behavior — the publish tests are the regression guard.

- [ ] **Step 5: Commit**

```bash
git add packages/aggregator/src/catalog.ts packages/aggregator/src/__tests__/resolveSignedAccount.test.ts
git commit -m "feat(aggregator): resolveSignedAccount — shared pubkey->accounts.id resolver"
```

---

### Task 2: `gem_archives.owner_account_id` column + owner-aware archive helpers

Add the owner column and the two helpers mint/revoke need: writing an archive with an owner, and a fail-closed delete.

**Files:**
- Modify: `packages/aggregator/src/schema.ts` (drizzle def ~line 286; ensureSchema DDL ~after line 632)
- Modify: `packages/aggregator/src/catalog.ts` (`upsertGemArchive` at 58; add `deleteGemArchiveOwned` + `archiveOnlyVersion`)
- Test: `packages/aggregator/src/__tests__/gemArchiveOwner.test.ts` (create)

**Interfaces:**
- Consumes: `gemArchives`, `AppDb`, `and`, `eq` (imported in catalog.ts).
- Produces:
  - `upsertGemArchive(db, a: { gemKey; version; bytes; digest; createdAtMs; ownerAccountId?: string })` — new optional field.
  - `deleteGemArchiveOwned(db: AppDb, gemKey: string, ownerAccountId: string): Promise<"deleted" | "not-found" | "forbidden">`
  - `archiveOnlyVersion(db: AppDb, gemKey: string): Promise<string | null>` — the version of a gem_archives row that has NO catalog row (an unlisted share); null otherwise.

- [ ] **Step 1: Write the failing test**

Create `packages/aggregator/src/__tests__/gemArchiveOwner.test.ts`:

```ts
// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
import { describe, it, expect } from "vitest";
import { randomUUID } from "node:crypto";
import { makeTestDb, accounts, upsertGemArchive, getGemArchive, deleteGemArchiveOwned, archiveOnlyVersion } from "@agentgem/aggregator";

async function acct(db: Awaited<ReturnType<typeof makeTestDb>>): Promise<string> {
  const id = randomUUID();
  await db.insert(accounts).values({ id, provider: "github", providerAccountId: id, login: "u" });
  return id;
}

describe("gem_archives ownership", () => {
  it("stores an owner and lets that owner delete it", async () => {
    const db = await makeTestDb();
    const owner = await acct(db);
    await upsertGemArchive(db, { gemKey: "xK3f9a2Bq1", version: "1", bytes: new Uint8Array([1, 2, 3]), digest: "d", createdAtMs: 1, ownerAccountId: owner });
    expect(await getGemArchive(db, "xK3f9a2Bq1", "1")).not.toBeNull();
    expect(await deleteGemArchiveOwned(db, "xK3f9a2Bq1", owner)).toBe("deleted");
    expect(await getGemArchive(db, "xK3f9a2Bq1", "1")).toBeNull();
  });

  it("forbids a different account from deleting (fail-closed on wrong owner)", async () => {
    const db = await makeTestDb();
    const owner = await acct(db), other = await acct(db);
    await upsertGemArchive(db, { gemKey: "xK3f9a2Bq1", version: "1", bytes: new Uint8Array([1]), digest: "d", createdAtMs: 1, ownerAccountId: owner });
    expect(await deleteGemArchiveOwned(db, "xK3f9a2Bq1", other)).toBe("forbidden");
    expect(await getGemArchive(db, "xK3f9a2Bq1", "1")).not.toBeNull();
  });

  it("forbids deleting a NULL-owner archive — owned by nobody", async () => {
    const db = await makeTestDb();
    const someone = await acct(db);
    await upsertGemArchive(db, { gemKey: "@octocat/tetris", version: "1.0.0", bytes: new Uint8Array([1]), digest: "d", createdAtMs: 1 }); // no owner
    expect(await deleteGemArchiveOwned(db, "@octocat/tetris", someone)).toBe("forbidden");
  });

  it("returns not-found for an absent key", async () => {
    const db = await makeTestDb();
    expect(await deleteGemArchiveOwned(db, "nope", await acct(db))).toBe("not-found");
  });

  it("archiveOnlyVersion returns the version of an unlisted (catalog-less) archive", async () => {
    const db = await makeTestDb();
    await upsertGemArchive(db, { gemKey: "xK3f9a2Bq1", version: "1", bytes: new Uint8Array([1]), digest: "d", createdAtMs: 1, ownerAccountId: await acct(db) });
    expect(await archiveOnlyVersion(db, "xK3f9a2Bq1")).toBe("1");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
pnpm build && pnpm exec vitest run packages/aggregator/dist/__tests__/gemArchiveOwner.test.js
```

Expected: FAIL at build — `deleteGemArchiveOwned`/`archiveOnlyVersion` not exported.

- [ ] **Step 3a: Add the column (drizzle def + ensureSchema DDL)**

In `packages/aggregator/src/schema.ts`, add to the `gemArchives` pgTable def (the block starting `export const gemArchives = pgTable("gem_archives", {`, ~line 286), after the `createdAtMs` column:

```ts
  ownerAccountId: uuid("owner_account_id").references(() => accounts.id),
```

Then in `ensureSchema`, next to the existing `catalog_gems` owner block (lines 631-632), add:

```ts
  // Owner of an UNLISTED share archive (no catalog_gems row). NULL = owned by nobody (published
  // gems, whose ownership lives on catalog_gems). Same fail-closed rule as catalog_gems.
  await db.execute(sql`alter table gem_archives add column if not exists owner_account_id uuid references accounts(id)`);
  await db.execute(sql`create index if not exists gem_archives_owner_idx on gem_archives (owner_account_id)`);
```

- [ ] **Step 3b: Extend `upsertGemArchive` and add the two helpers**

In `packages/aggregator/src/catalog.ts`, replace `upsertGemArchive` (lines 58-61) with:

```ts
export async function upsertGemArchive(db: AppDb, a: { gemKey: string; version: string; bytes: Uint8Array; digest: string; createdAtMs: number; ownerAccountId?: string }): Promise<void> {
  await db.insert(gemArchives).values({ gemKey: a.gemKey, version: a.version, bytes: a.bytes, size: a.bytes.length, digest: a.digest, createdAtMs: a.createdAtMs, ownerAccountId: a.ownerAccountId ?? null })
    .onConflictDoUpdate({ target: [gemArchives.gemKey, gemArchives.version], set: { bytes: a.bytes, size: a.bytes.length, digest: a.digest, createdAtMs: a.createdAtMs, ownerAccountId: a.ownerAccountId ?? null } });
}
```

Add after `deleteCatalogGem` (~line 103):

```ts
// Owner-only revoke of an UNLISTED share archive (no catalog_gems row exists for it). Mirrors
// deleteCatalogGem's rule exactly: NULL owner is owned by nobody; compare the accounts.id uuid,
// never a string. Deletes only the gem_archives row.
export async function deleteGemArchiveOwned(db: AppDb, gemKey: string, ownerAccountId: string): Promise<DeleteGemResult> {
  const row = (await db.select({ ownerAccountId: gemArchives.ownerAccountId }).from(gemArchives)
    .where(eq(gemArchives.gemKey, gemKey)).limit(1))[0];
  if (!row) return "not-found";
  if (row.ownerAccountId === null || row.ownerAccountId !== ownerAccountId) return "forbidden";
  await db.delete(gemArchives).where(eq(gemArchives.gemKey, gemKey));
  return "deleted";
}

// The version of a gem_archives row that has NO catalog_gems row — i.e. an unlisted share. Used by
// game-meta to resolve /games/<shareId> (a scope-less key has no catalog "latest"). Returns null
// for a published gem (its version comes from latestGemVersion) or an absent key.
export async function archiveOnlyVersion(db: AppDb, gemKey: string): Promise<string | null> {
  const listed = await catalogGemExists2(db, gemKey);
  if (listed) return null;
  const row = (await db.select({ version: gemArchives.version }).from(gemArchives)
    .where(eq(gemArchives.gemKey, gemKey)).orderBy(desc(gemArchives.createdAtMs)).limit(1))[0];
  return row?.version ?? null;
}

// True if ANY catalog_gems row exists for this key (any version). Distinct from catalogGemExists,
// which needs a specific version.
async function catalogGemExists2(db: AppDb, gemKey: string): Promise<boolean> {
  const r = (await db.select({ gemKey: catalogGems.gemKey }).from(catalogGems).where(eq(catalogGems.gemKey, gemKey)).limit(1))[0];
  return r != null;
}
```

(`uuid` is already imported in schema.ts; `desc`, `and`, `eq`, `catalogGems`, `gemArchives` are already imported in catalog.ts.)

- [ ] **Step 4: Verify**

```bash
pnpm build && pnpm exec vitest run packages/aggregator/dist/__tests__/gemArchiveOwner.test.js
```

Expected: PASS, 5 tests.

- [ ] **Step 5: Commit**

```bash
git add packages/aggregator/src/schema.ts packages/aggregator/src/catalog.ts packages/aggregator/src/__tests__/gemArchiveOwner.test.ts
git commit -m "feat(aggregator): owner_account_id on gem_archives + owned-delete + archiveOnlyVersion"
```

---

### Task 3: `POST /api/aggregator/share-archive` — the signed mint

**Files:**
- Modify: `src/aggregator.controller.ts` (schemas ~line 144; route after `publishGem` ~line 300; imports at top)
- Test: `src/aggregator/__tests__/shareArchive.controller.test.ts` (create)
- Test helper: `src/aggregator/__tests__/helpers/publishFixtures.ts` (extend with a game-gem fixture)

**Interfaces:**
- Consumes: `resolveSignedAccount`, `upsertGemArchive`, `genShareId` (from `../share/shareStore.js`), `staticGate` (from `@agentgem/play`), `importGem` (`@agentgem/distribute`), `catalogSigningPayload` (`@agentgem/aggregator`), `isPublishedKey`... — see below on the invariant.
- Produces: `AggregatorController.shareArchive(input: { body }): Promise<{ key: string; url: string }>`; `POST /api/aggregator/share-archive`.

- [ ] **Step 1: Add a game-gem fixture**

Append to `src/aggregator/__tests__/helpers/publishFixtures.ts`:

```ts
// A one-artifact game gem, for the share-archive (miniapp) path.
export function gameGem(): import("@agentgem/model").Gem {
  return {
    name: "tetris", createdFrom: "/tmp/.claude", checks: [], requiredSecrets: [],
    artifacts: [{
      type: "game", name: "tetris", title: "Tetris", genre: "project-fun",
      html: "<!doctype html><title>t</title><canvas></canvas>", createdFrom: { kind: "blank", title: "Tetris" }, engineVersion: "1",
    }],
  } as import("@agentgem/model").Gem;
}
```

- [ ] **Step 2: Write the failing test**

Create `src/aggregator/__tests__/shareArchive.controller.test.ts`:

```ts
// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
import { describe, it, expect } from "vitest";
import { randomUUID } from "node:crypto";
import { makeTestDb, producers, accountBindings, accounts, getGemArchive, listCatalogGems } from "@agentgem/aggregator";
import { exportGem, importGem } from "@agentgem/distribute";
import { catalogSigningPayload } from "@agentgem/aggregator";
import { AggregatorController } from "../../aggregator.controller.js";
import { signer, gameGem } from "./helpers/publishFixtures.js";

async function boundDb() {
  const db = await makeTestDb();
  const s = signer();
  await db.insert(producers).values({ pubkey: s.pubkey });
  await db.insert(accounts).values({ id: randomUUID(), provider: "github", providerAccountId: "1", login: "octocat" });
  await db.insert(accountBindings).values({ pubkey: s.pubkey, provider: "github", accountId: "1", accountLogin: "octocat" });
  return { db, s };
}

function signedArchiveBody(gem: ReturnType<typeof gameGem>, s: ReturnType<typeof signer>, signedAt = Date.now()) {
  const { bytes } = exportGem(gem, { version: "1" });
  const { meta } = importGem(bytes);
  const manifest = { gemKey: "_", version: "1", gemDigest: meta.gemDigest };
  const signature = s.sign(catalogSigningPayload(manifest, s.pubkey, signedAt));
  return { manifest, archiveBase64: bytes.toString("base64"), pubkey: s.pubkey, signedAt, signature };
}

describe("AggregatorController.shareArchive", () => {
  it("mints an unlisted, owned share and serves it by its scope-less key", async () => {
    const { db, s } = await boundDb();
    const res = await new AggregatorController(db).shareArchive({ body: signedArchiveBody(gameGem(), s) });

    expect(res.key).not.toContain("/");                         // scope-less => unlistable
    expect(res.url).toBe(`https://app.agentgem.ai/games/${res.key}`);
    expect(await getGemArchive(db, res.key, "1")).not.toBeNull();
    expect(await listCatalogGems(db)).toHaveLength(0);          // THE unlisted invariant
  });

  it("rejects HTML that fails the server-side static gate", async () => {
    const { db, s } = await boundDb();
    const evil = gameGem();
    (evil.artifacts[0] as { html: string }).html = "<!doctype html><script>fetch('http://evil')</script>";
    await expect(new AggregatorController(db).shareArchive({ body: signedArchiveBody(evil, s) }))
      .rejects.toMatchObject({ statusCode: 400 });
  });

  it("rejects an unbound producer (not-connected) and stores nothing", async () => {
    const db = await makeTestDb();
    const s = signer();
    await expect(new AggregatorController(db).shareArchive({ body: signedArchiveBody(gameGem(), s) }))
      .rejects.toMatchObject({ statusCode: 401 });
  });

  it("rejects a non-game archive", async () => {
    const { db, s } = await boundDb();
    const notGame = { name: "x", createdFrom: "/tmp/.claude", checks: [], requiredSecrets: [],
      artifacts: [{ type: "skill", name: "s", source: "standalone", content: "# s\n" }] } as ReturnType<typeof gameGem>;
    await expect(new AggregatorController(db).shareArchive({ body: signedArchiveBody(notGame, s) }))
      .rejects.toMatchObject({ statusCode: 400, code: "not_a_game" });
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

```bash
pnpm build && pnpm exec vitest run dist/aggregator/__tests__/shareArchive.controller.test.js
```

Expected: FAIL at build — `shareArchive` not a method.

- [ ] **Step 4: Implement the route**

In `src/aggregator.controller.ts`, add imports (extend the existing `@agentgem/aggregator` and add the others):

```ts
import { resolveSignedAccount, catalogSigningPayload } from "@agentgem/aggregator";
import { staticGate } from "@agentgem/play";
import { genShareId } from "./share/shareStore.js";
```

(Check the existing import lines first — `upsertGemArchive`, `getGemArchive`, `importGem` are already imported; add only what's missing. `catalogSigningPayload` may already be imported.)

Add the schemas near the others (~line 144):

```ts
const ShareArchiveBody = z.object({ manifest: CatalogManifestSchema, archiveBase64: z.string(), pubkey: z.string(), signedAt: z.number(), signature: z.string() });
const ShareArchiveResult = z.object({ key: z.string(), url: z.string() });
```

Add the route after `publishGem` (~line 300):

```ts
  // Unlisted share: upload a miniapp's archive and get a copyable /games/<shareId> URL, owned by the
  // uploader's accounts.id so only they can revoke it. Distinct from publish-gem: no catalog_gems row
  // (never lists), a scope-less genShareId key, and the game HTML is re-gated server-side because we
  // serve it from our own origin. The sealed null-origin iframe is the real boundary; this gate is
  // defense-in-depth. Console-originated (origin-less), so originGuard's fall-through allows it.
  @post("/share-archive", { body: ShareArchiveBody, response: ShareArchiveResult })
  async shareArchive(input: { body: z.infer<typeof ShareArchiveBody> }): Promise<z.infer<typeof ShareArchiveResult>> {
    const b = input.body;
    const who = await resolveSignedAccount(this.db, {
      pubkey: b.pubkey, payload: catalogSigningPayload(b.manifest, b.pubkey, b.signedAt), signedAt: b.signedAt, signature: b.signature,
    });
    if (!who.ok) throw new AgentError("not connected", { status: who.rejected === "not-connected" ? 401 : 400, code: who.rejected, retryable: false });

    const bytes = Buffer.from(b.archiveBase64, "base64");
    let digest: string, gem;
    try { const imp = importGem(bytes); digest = imp.meta.gemDigest; gem = imp.gem; }
    catch { throw new AgentError("invalid gem archive", { status: 400, code: "invalid_archive", retryable: false }); }
    if (b.manifest.gemDigest && b.manifest.gemDigest !== digest) throw new AgentError("digest mismatch", { status: 400, code: "digest_mismatch", retryable: false });

    const game = gem.artifacts.find((x) => x.type === "game") as { html?: unknown } | undefined;
    if (!game || typeof game.html !== "string") throw new AgentError("this gem has no game to share", { status: 400, code: "not_a_game", retryable: false });
    const gate = staticGate(game.html);
    if (!gate.ok) throw new AgentError(`static gate: ${gate.failures.join("; ")}`, { status: 400, code: "gate_failed", retryable: false });

    const key = genShareId();                                  // slash-less => can never be a published key
    await upsertGemArchive(this.db, { gemKey: key, version: "1", bytes: new Uint8Array(bytes), digest, createdAtMs: Date.now(), ownerAccountId: who.accountId });
    return { key, url: `https://app.agentgem.ai/games/${key}` };
  }
```

- [ ] **Step 5: Verify**

```bash
pnpm build && pnpm exec vitest run dist/aggregator/__tests__/shareArchive.controller.test.js
```

Expected: PASS, 4 tests.

- [ ] **Step 6: Commit**

```bash
git add src/aggregator.controller.ts src/aggregator/__tests__/shareArchive.controller.test.ts src/aggregator/__tests__/helpers/publishFixtures.ts
git commit -m "feat(aggregator): POST /share-archive — signed unlisted mint, server-gated, owned"
```

---

### Task 4: `POST /api/aggregator/share-archive/revoke` — the signed revoke

**Framework note:** AgentBack controllers expose only `@get`/`@post` (the aggregator controller imports `api, get, post, AgentError` — there is no `@del`). The existing unpublish DELETE is a raw express handler in `src/catalog/install.ts` authenticated by a **session cookie** — the wrong auth for our console-signature caller. So revoke is a **`@post`** beside the mint: same signature auth, same controller test harness, no express detour. The spec names it `DELETE /api/aggregator/share-archive`; this is the same operation as a POST-with-body under the framework's constraint.

**Files:**
- Modify: `src/aggregator.controller.ts` (schema; `@post` route after `shareArchive`)
- Test: `src/aggregator/__tests__/shareArchive.controller.test.ts` (extend)

**Interfaces:**
- Consumes: `resolveSignedAccount`, `deleteGemArchiveOwned` (`@agentgem/aggregator`, Task 2). The revoke payload is a plain string over the shareId — `revoke:<key>:<signedAt>` — unambiguous, no new dependency.
- Produces: `AggregatorController.revokeShareArchive(input: { body }): Promise<{ revoked: boolean }>`; `POST /api/aggregator/share-archive/revoke`.

- [ ] **Step 1: Write the failing test** (append to `shareArchive.controller.test.ts`)

```ts
describe("AggregatorController.revokeShareArchive", () => {
  function revokeBody(key: string, s: ReturnType<typeof signer>, signedAt = Date.now()) {
    const payload = `revoke:${key}:${signedAt}`;
    return { key, pubkey: s.pubkey, signedAt, signature: s.sign(payload) };
  }

  it("lets the minting account revoke its own share", async () => {
    const { db, s } = await boundDb();
    const c = new AggregatorController(db);
    const { key } = await c.shareArchive({ body: signedArchiveBody(gameGem(), s) });
    const res = await c.revokeShareArchive({ body: revokeBody(key, s) });
    expect(res).toEqual({ revoked: true });
    expect(await getGemArchive(db, key, "1")).toBeNull();
  });

  it("forbids a different account from revoking (fail-closed)", async () => {
    const { db, s } = await boundDb();
    const c = new AggregatorController(db);
    const { key } = await c.shareArchive({ body: signedArchiveBody(gameGem(), s) });
    // a second bound producer on a DIFFERENT account
    const s2 = signer();
    await db.insert(producers).values({ pubkey: s2.pubkey });
    await db.insert(accounts).values({ id: randomUUID(), provider: "github", providerAccountId: "2", login: "mallory" });
    await db.insert(accountBindings).values({ pubkey: s2.pubkey, provider: "github", accountId: "2", accountLogin: "mallory" });
    await expect(c.revokeShareArchive({ body: revokeBody(key, s2) })).rejects.toMatchObject({ statusCode: 403 });
    expect(await getGemArchive(db, key, "1")).not.toBeNull();
  });

  it("404s an unknown key", async () => {
    const { db, s } = await boundDb();
    await expect(new AggregatorController(db).revokeShareArchive({ body: revokeBody("nope", s) })).rejects.toMatchObject({ statusCode: 404 });
  });
});
```

(`producers` and `randomUUID` are already imported at the top of this file from Task 3.)

- [ ] **Step 2: Run to verify it fails**

```bash
pnpm build && pnpm exec vitest run dist/aggregator/__tests__/shareArchive.controller.test.js
```

Expected: FAIL at build — `revokeShareArchive` not a method.

- [ ] **Step 3: Implement** (schema + `@post` route in `src/aggregator.controller.ts`, after `shareArchive`)

```ts
const RevokeShareBody = z.object({ key: z.string(), pubkey: z.string(), signedAt: z.number(), signature: z.string() });
const RevokeShareResult = z.object({ revoked: z.boolean() });
```

```ts
  // Owner-only revoke of an unlisted share (POST, not DELETE — AgentBack controllers have no @del;
  // see the framework note). The signature is over `revoke:<key>:<signedAt>`, proving the caller
  // holds a device key bound to the OWNING account — any of the owner's devices works, since
  // ownership is the accounts.id, not the key. Fail-closed: wrong/NULL owner -> 403.
  @post("/share-archive/revoke", { body: RevokeShareBody, response: RevokeShareResult })
  async revokeShareArchive(input: { body: z.infer<typeof RevokeShareBody> }): Promise<z.infer<typeof RevokeShareResult>> {
    const b = input.body;
    const who = await resolveSignedAccount(this.db, {
      pubkey: b.pubkey, payload: `revoke:${b.key}:${b.signedAt}`, signedAt: b.signedAt, signature: b.signature,
    });
    if (!who.ok) throw new AgentError("not connected", { status: who.rejected === "not-connected" ? 401 : 400, code: who.rejected, retryable: false });
    const r = await deleteGemArchiveOwned(this.db, b.key, who.accountId);
    if (r === "not-found") throw new AgentError("share not found", { status: 404, code: "share_not_found", retryable: false });
    if (r === "forbidden") throw new AgentError("not the owner", { status: 403, code: "forbidden", retryable: false });
    return { revoked: true };
  }
```

Add `deleteGemArchiveOwned` to the `@agentgem/aggregator` import. `@post` and `AgentError` are already imported.

- [ ] **Step 4: Verify**

```bash
pnpm build && pnpm exec vitest run dist/aggregator/__tests__/shareArchive.controller.test.js
```

Expected: PASS, all 7 tests in the file.

- [ ] **Step 5: Commit**

```bash
git add src/aggregator.controller.ts src/aggregator/__tests__/shareArchive.controller.test.ts
git commit -m "feat(aggregator): POST /share-archive/revoke — owner-only fail-closed revoke"
```

---

### Task 5: `game-meta` resolves a scope-less share key's version

Without this, `/games/<shareId>` 404s: `latestGemVersion` reads `catalog_gems`, which an unlisted share has no row in.

**Files:**
- Modify: `src/aggregator.controller.ts` (`gameMeta` at line 328-338; add the fallback + import `archiveOnlyVersion`)
- Test: `src/aggregator/__tests__/gameMeta.controller.test.ts` (extend — the file exists from PR 1)

**Interfaces:**
- Consumes: `archiveOnlyVersion` (`@agentgem/aggregator`, Task 2).

- [ ] **Step 1: Write the failing test** (append to the existing `gameMeta.controller.test.ts`)

```ts
it("resolves an unlisted share key (no catalog row) via its archive", async () => {
  const db = await makeTestDb();
  // Seed an archive with NO catalog row, exactly as share-archive does. Reuse the gameGem fixture shape.
  const { exportGem } = await import("@agentgem/distribute");
  const { upsertGemArchive } = await import("@agentgem/aggregator");
  const gem = { name: "t", createdFrom: "/tmp/.claude", checks: [], requiredSecrets: [],
    artifacts: [{ type: "game", name: "t", title: "Unlisted Game", genre: "project-fun",
      html: "<!doctype html><title>t</title><canvas></canvas>", createdFrom: { kind: "blank", title: "t" }, engineVersion: "1" }] };
  const { bytes } = exportGem(gem as never, { version: "1" });
  await upsertGemArchive(db, { gemKey: "xK3f9a2Bq1", version: "1", bytes: new Uint8Array(bytes), digest: "d", createdAtMs: 1 });

  const res = await new AggregatorController(db).gameMeta({ query: { key: "xK3f9a2Bq1" } });
  expect(res).toEqual({ title: "Unlisted Game", genre: "project-fun", version: "1" });
});
```

- [ ] **Step 2: Run to verify it fails**

```bash
pnpm build && pnpm exec vitest run dist/aggregator/__tests__/gameMeta.controller.test.js
```

Expected: FAIL — resolves to `null` version → 404 `gem_archive_not_found`.

- [ ] **Step 3: Implement the fallback**

In `src/aggregator.controller.ts` `gameMeta`, change the version-resolution line (330):

```ts
    const version = input.query.version ?? (await latestGemVersion(this.db, key)) ?? (await archiveOnlyVersion(this.db, key));
```

Add `archiveOnlyVersion` to the `@agentgem/aggregator` import.

- [ ] **Step 4: Verify** (the whole game-meta file, to confirm no regression of the published-key path)

```bash
pnpm build && pnpm exec vitest run dist/aggregator/__tests__/gameMeta.controller.test.js
```

Expected: PASS, all tests (the PR 1 published-key cases + the new unlisted case).

- [ ] **Step 5: Commit**

```bash
git add src/aggregator.controller.ts src/aggregator/__tests__/gameMeta.controller.test.js
git commit -m "feat(aggregator): game-meta resolves a scope-less share key's version from gem_archives"
```

Note the `git add` path is the **source** `.ts`, not `dist` — write `src/aggregator/__tests__/gameMeta.controller.test.ts`.

---

### Task 6: Verify end-to-end, then open the PR

- [ ] **Step 1: Full server suite**

```bash
pnpm test
```

Expected: PASS. If `orgCatalog`/`observeScan`/`scorecard` time out, re-run them in isolation — known concurrency flakes, unrelated.

- [ ] **Step 2: The unlisted invariant, one more way**

Confirm no share-archive key can ever collide with a published key. `genShareId()` is base62 (no slash); `isPublishedKey` (marketplace) is `key.includes("/")`. Add this assertion to `shareArchive.controller.test.ts` if not already covered by the "does not contain /" check — it is; no new code needed. Just confirm the check reads `expect(res.key).not.toContain("/")`.

- [ ] **Step 3: Confirm branch is ahead of origin/main only**

```bash
git fetch origin && git rev-list --left-right --count origin/main...HEAD
```

Expected: `0	<n>`.

- [ ] **Step 4: Push and open the PR**

```bash
git push -u origin feat/miniapp-share-archive
gh pr create --title "feat: share-archive server — unlisted, owned miniapp links (PR 2a)" --body "$(cat <<'EOF'
Server leg of PR 2 from `docs/superpowers/specs/2026-07-09-entity-address-scheme-design.md`.

A locally-authored miniapp can be uploaded UNLISTED and served at a copyable
`app.agentgem.ai/games/<shareId>` URL, owned by the uploader's account.

- `resolveSignedAccount` — the pubkey→accounts.id chain extracted from `recordCatalogShare` (which now reuses it)
- `gem_archives.owner_account_id` column + `deleteGemArchiveOwned` (fail-closed UUID ownership, copies `deleteCatalogGem`)
- `POST /api/aggregator/share-archive` — signed mint, no catalog row (unlisted), server-side `staticGate`, owner = `accounts.id`
- `DELETE /api/aggregator/share-archive` — signed revoke, works from any of the owner's devices, fail-closed for everyone else
- `game-meta` falls back to `gem_archives` so a scope-less `/games/<shareId>` resolves

Conforms to the merged identity re-key (PR #285): ownership is the `accounts.id` UUID, NULL owner = nobody, never a string compare.

**Console UI (Copy/Revoke buttons, connect prompt) is PR 2b.**

## Test plan
- New: resolveSignedAccount, gem_archives ownership, share-archive mint + revoke, game-meta unlisted fallback
- Regression: `recordCatalogShare` refactor guarded by the existing publishGem/catalogShare tests
- Full server suite green

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

- [ ] **Step 5: Watch CI, merge, verify every commit landed**

```bash
gh run watch <run-id> --exit-status
gh pr merge --rebase --delete-branch
```

`--delete-branch` errors on the local delete (`main` checked out elsewhere) but the remote merge still lands — verify via `gh pr view <n> --json state` (want `MERGED`), then grep `origin/main` for a marker from EACH commit (not just the first):

```bash
git fetch origin
git show origin/main:packages/aggregator/src/catalog.ts | grep -c "resolveSignedAccount"
git show origin/main:packages/aggregator/src/schema.ts | grep -c "gem_archives_owner_idx"
git show origin/main:src/aggregator.controller.ts | grep -c "share-archive"
```

Every one must hit. If commits dropped, `git rebase origin/main` (merged auto-skip) → fresh branch → new PR.
