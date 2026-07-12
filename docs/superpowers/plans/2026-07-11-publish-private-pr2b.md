# Publish visibility — Private, owner-only (PR 2b) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make **Private** a real, owner-only scope. A private gem is absent from Explore (PR 2a already does this) AND the anonymous resolve endpoints refuse it (no non-owner can play/install/download it, no existence leak); the owner accesses their private gems through the **marketplace web** — a "My apps" view (session-gated `my-gems`) and owner-gated play.

**Architecture:** Two new aggregator query helpers (`gemAccessInfo`, `listCatalogGemsForOwner`). The three anonymous resolve handlers (`game-meta`/`game-html`/`gem-archive`) gain an explicit "refuse private → 404" check. New session-gated owner endpoints under `/api/catalog/` (mirroring `src/catalog/install.ts`): `my-gems` (list the owner's gems incl. private) and owner-gated `game-meta`/`game-html` (play a private gem). Console widens the publish edge to accept `private` and adds the Private selector option. The marketplace gets a `My apps` page that lists the owner's gems and plays private games via the owner endpoints. Ownership is always re-checked server-side by `accounts.id` uuid via `resolveSession`.

**Tech Stack:** TypeScript (ESM, `.js` specifiers), Drizzle + PGlite (aggregator/data tests), zod + @agentback (controllers), raw-express (session endpoints), better-auth (`resolveSession`/`mintSession`), React + Vite (marketplace), vitest.

## Global Constraints

- **Node ≥ 24, ESM.** Local imports use the `.js` extension in the specifier.
- **New-file header** (first two lines of every new source/test file):
  ```
  // Copyright (c) 2026 NineMind, Inc.
  // SPDX-License-Identifier: MIT
  ```
- **Ownership is the `accounts.id` uuid**, resolved server-side via `resolveSession` → `{ accountId }`, compared to `catalog_gems.owner_account_id`. **Never trust a client-sent account id.**
- **Private must not leak existence**: a non-owner (or anonymous) request for a private gem returns **404 not-found**, the same error shape as a truly missing gem — not 403.
- **Archive-only unlisted shares have no `catalog_gems` row** (`gemAccessInfo` returns `null`); they are NOT private and must keep resolving (old `/games/<id>` links).
- **Public/Unlisted behavior is unchanged.** Only `private` is newly gated.
- Publish-edge enum widens from `["public","unlisted"]` to `["public","unlisted","private"]` in this PR (PR 2a restricted it deliberately; now enforcement exists).
- **Session-gated endpoints** live under `/api/catalog/` (already originGuard-exempt) and set their own credentialed CORS via `webOrigins` — copy `src/catalog/install.ts` exactly; do NOT add them to `PUBLIC_READ_PATHS`.
- **Test homes / commands:**
  - Aggregator data-layer + controller tests: `src/aggregator/__tests__/*.test.ts`, session-endpoint tests: `src/__tests__/*.test.ts`; run `npx tsc -b && npx vitest run dist/<path>.test.js` (root vitest globs compiled `dist/**`).
  - Marketplace: `packages/marketplace/src/**/*.test.tsx`; run `cd packages/marketplace && npx vitest run <path>`. **CI runs marketplace tests.**
  - Console: `cd packages/console && npx vitest run <path>` (runs `src` directly).
  - Full gate: `pnpm build && pnpm test` (root — the build must precede tests; `consoleMount` needs the built console) AND `cd packages/marketplace && npx vitest run` AND `cd packages/console && npx vitest run`.
  - **Trap:** deleting a `.ts` test source leaves a stale compiled `dist/**` test that keeps running; a fresh worktree needs `pnpm build` before sibling-dist-dependent tests pass.
- **Commit trailer** (every commit): `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`
- Work in the worktree `/Users/rfeng/Projects/ninemind/agentgem-worktrees/publish-private` on branch `feat/publish-private`.

## Out of scope (follow-up)

Owner install/download of a private gem (owner-gated `gem-archive`) and a full private **Gem-detail** page (needs a single-gem owner fetch). PR 2b delivers: publish private, see it in My apps, and **play** it. Note these deferrals in the PR body.

---

### Task 1: aggregator helpers — `gemAccessInfo` + `listCatalogGemsForOwner`

**Files:**
- Modify: `packages/aggregator/src/catalog.ts`
- Test: `src/aggregator/__tests__/privateAccess.test.ts`

**Interfaces:**
- Consumes: `catalogGems`, `eq`, `desc`, `and`, `Visibility` (all present).
- Produces:
  - `gemAccessInfo(db: AppDb, gemKey: string, version: string): Promise<{ visibility: Visibility; ownerAccountId: string | null } | null>` — the catalog row's visibility + owner for a specific `(key, version)`, or `null` if no catalog row exists (archive-only / unknown).
  - `listCatalogGemsForOwner(db: AppDb, accountId: string): Promise<CatalogRow[]>` — every gem owned by `accountId` (all visibilities), newest first, with `visibility` and `ownerAccountId` populated on each row.

- [ ] **Step 1: Write the failing test**

`src/aggregator/__tests__/privateAccess.test.ts`:
```ts
// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
import { describe, it, expect } from "vitest";
import { makeTestDb, upsertCatalogGem, gemAccessInfo, listCatalogGemsForOwner } from "@agentgem/aggregator";

describe("gemAccessInfo", () => {
  it("returns visibility + owner for a known (key, version)", async () => {
    const db = await makeTestDb();
    await upsertCatalogGem(db, { gemKey: "@me/g", version: "0.1.0", publishedBy: "me", createdAtMs: 1, ownerAccountId: "acct-1", visibility: "private" });
    expect(await gemAccessInfo(db, "@me/g", "0.1.0")).toEqual({ visibility: "private", ownerAccountId: "acct-1" });
  });
  it("returns null when no catalog row exists (archive-only / unknown)", async () => {
    const db = await makeTestDb();
    expect(await gemAccessInfo(db, "sharedid", "1")).toBeNull();
  });
});

describe("listCatalogGemsForOwner", () => {
  it("returns all of the owner's gems (every visibility), newest first, excludes others", async () => {
    const db = await makeTestDb();
    await upsertCatalogGem(db, { gemKey: "@me/pub", version: "0.1.0", publishedBy: "me", createdAtMs: 1, ownerAccountId: "acct-1", visibility: "public" });
    await upsertCatalogGem(db, { gemKey: "@me/prv", version: "0.1.0", publishedBy: "me", createdAtMs: 3, ownerAccountId: "acct-1", visibility: "private" });
    await upsertCatalogGem(db, { gemKey: "@you/x", version: "0.1.0", publishedBy: "you", createdAtMs: 2, ownerAccountId: "acct-2", visibility: "public" });
    const mine = await listCatalogGemsForOwner(db, "acct-1");
    expect(mine.map((g) => [g.gemKey, g.visibility])).toEqual([["@me/prv", "private"], ["@me/pub", "public"]]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx tsc -b && npx vitest run dist/aggregator/__tests__/privateAccess.test.js`
Expected: FAIL — `gemAccessInfo` / `listCatalogGemsForOwner` not exported.

- [ ] **Step 3: Implement (append to `packages/aggregator/src/catalog.ts`)**

```ts
// Visibility + owner for one (key, version). null = no catalog row (archive-only unlisted share or
// unknown) — such a resolve is NOT private and must keep working.
export async function gemAccessInfo(db: AppDb, gemKey: string, version: string): Promise<{ visibility: Visibility; ownerAccountId: string | null } | null> {
  const r = (await db.select({ visibility: catalogGems.visibility, ownerAccountId: catalogGems.ownerAccountId })
    .from(catalogGems).where(and(eq(catalogGems.gemKey, gemKey), eq(catalogGems.version, version))).limit(1))[0];
  return r ? { visibility: r.visibility as Visibility, ownerAccountId: r.ownerAccountId ?? null } : null;
}

// Every gem owned by accountId, across all visibilities (the owner's own "My apps" view). Newest first.
export async function listCatalogGemsForOwner(db: AppDb, accountId: string): Promise<CatalogRow[]> {
  const rows = await db.select({
    gemKey: catalogGems.gemKey, version: catalogGems.version, publishedBy: catalogGems.publishedBy,
    author: catalogGems.author, description: catalogGems.description, tags: catalogGems.tags,
    artifactKinds: catalogGems.artifactKinds, type: catalogGems.type, grade: catalogGems.grade,
    artifacts: catalogGems.artifacts, createdAtMs: catalogGems.createdAtMs,
    ownerAccountId: catalogGems.ownerAccountId, visibility: catalogGems.visibility, archiveKey: gemArchives.gemKey,
  }).from(catalogGems)
    .leftJoin(gemArchives, and(eq(catalogGems.gemKey, gemArchives.gemKey), eq(catalogGems.version, gemArchives.version)))
    .where(eq(catalogGems.ownerAccountId, accountId))
    .orderBy(desc(catalogGems.createdAtMs));
  return rows.map((r) => ({
    gemKey: r.gemKey, version: r.version, publishedBy: r.publishedBy,
    author: r.author ?? undefined, description: r.description ?? undefined,
    tags: r.tags ?? undefined, artifactKinds: r.artifactKinds ?? undefined,
    type: r.type ?? undefined, grade: r.grade ?? undefined, artifacts: r.artifacts ?? undefined,
    createdAtMs: r.createdAtMs, ownerAccountId: r.ownerAccountId ?? null,
    visibility: (r.visibility as Visibility) ?? "public", installable: r.archiveKey != null,
  }));
}
```
(The barrel `export * from "./catalog.js"` re-exports both automatically.)

- [ ] **Step 4: Run test to verify it passes**

Run: `npx tsc -b && npx vitest run dist/aggregator/__tests__/privateAccess.test.js`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/aggregator/src/catalog.ts src/aggregator/__tests__/privateAccess.test.ts
git commit -m "feat(aggregator): gemAccessInfo + listCatalogGemsForOwner helpers

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: preserve visibility on republish (PR 2a carryover)

Fixes the logged landmine: a republish that omits `visibility` currently resets the row to `public` — a privacy downgrade once `private` exists.

**Files:**
- Modify: `packages/aggregator/src/catalog.ts` (`recordCatalogShare`)
- Test: `src/aggregator/__tests__/visibilityPreserve.test.ts`

**Interfaces:**
- Changes `recordCatalogShare` so that when `manifest.visibility` is `undefined`, the existing row's visibility is preserved (new rows still default to `public`).

- [ ] **Step 1: Write the failing test**

`src/aggregator/__tests__/visibilityPreserve.test.ts`:
```ts
// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
import { describe, it, expect } from "vitest";
import { generateKeyPairSync, sign as edSign } from "node:crypto";
import { makeTestDb, catalogSigningPayload, recordCatalogShare, gemAccessInfo, producers, accountBindings, accounts, type CatalogManifest } from "@agentgem/aggregator";

function signer() {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const pubkey = "ed25519:" + publicKey.export({ format: "der", type: "spki" }).toString("base64");
  return { pubkey, sign: (d: string) => edSign(null, Buffer.from(d, "utf8"), privateKey).toString("base64") };
}
async function share(db: Awaited<ReturnType<typeof makeTestDb>>, s: ReturnType<typeof signer>, m: CatalogManifest, now: number) {
  return recordCatalogShare(db, { manifest: m, pubkey: s.pubkey, signedAt: now, signature: s.sign(catalogSigningPayload(m, s.pubkey, now)) }, now);
}

describe("recordCatalogShare preserves visibility on republish-without-visibility", () => {
  it("a republish that omits visibility keeps the prior private scope", async () => {
    const db = await makeTestDb();
    const s = signer();
    const accountId = crypto.randomUUID();
    await db.insert(producers).values({ pubkey: s.pubkey });
    await db.insert(accounts).values({ id: accountId, provider: "github", providerAccountId: "42", login: "octocat" });
    await db.insert(accountBindings).values({ pubkey: s.pubkey, provider: "github", accountId: "42", accountLogin: "octocat" });
    await share(db, s, { gemKey: "@octocat/g", version: "1.0.0", visibility: "private" }, 1_000_000);
    // republish same key/version, no visibility field
    await share(db, s, { gemKey: "@octocat/g", version: "1.0.0" }, 1_000_100);
    expect((await gemAccessInfo(db, "@octocat/g", "1.0.0"))?.visibility).toBe("private");
  });
  it("a brand-new gem with no visibility still defaults to public", async () => {
    const db = await makeTestDb();
    const s = signer();
    const accountId = crypto.randomUUID();
    await db.insert(producers).values({ pubkey: s.pubkey });
    await db.insert(accounts).values({ id: accountId, provider: "github", providerAccountId: "42", login: "octocat" });
    await db.insert(accountBindings).values({ pubkey: s.pubkey, provider: "github", accountId: "42", accountLogin: "octocat" });
    await share(db, s, { gemKey: "@octocat/new", version: "1.0.0" }, 1_000_000);
    expect((await gemAccessInfo(db, "@octocat/new", "1.0.0"))?.visibility).toBe("public");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx tsc -b && npx vitest run dist/aggregator/__tests__/visibilityPreserve.test.js`
Expected: FAIL — the first test sees `public` (republish reset it).

- [ ] **Step 3: Implement**

In `recordCatalogShare` (`packages/aggregator/src/catalog.ts`), the ownership-guard block already fetches the existing row. Extend that select to also read `visibility`, and pass a preserved value to `upsertCatalogGem`:
```ts
  const existing = (await db.select({ ownerAccountId: catalogGems.ownerAccountId, visibility: catalogGems.visibility }).from(catalogGems)
    .where(and(eq(catalogGems.gemKey, m.gemKey), eq(catalogGems.version, m.version))).limit(1))[0];
  if (existing && existing.ownerAccountId !== who.accountId) return { shared: false, rejected: "conflict" };
```
Then in the `upsertCatalogGem({...})` call, change the visibility line to preserve the existing scope when the manifest omits it:
```ts
    visibility: m.visibility ?? (existing?.visibility as Visibility | undefined) ?? "public",
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx tsc -b && npx vitest run dist/aggregator/__tests__/visibilityPreserve.test.js`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/aggregator/src/catalog.ts src/aggregator/__tests__/visibilityPreserve.test.ts
git commit -m "fix(aggregator): preserve visibility on republish that omits it

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 3: anonymous resolve endpoints refuse private

**Files:**
- Modify: `src/aggregator.controller.ts` (`gemArchive`, `gameHtml`, `gameMeta`)
- Test: `src/aggregator/__tests__/refusePrivate.controller.test.ts`

**Interfaces:**
- Consumes: `gemAccessInfo` (Task 1) — add to the `@agentgem/aggregator` import.
- Produces: each of the three handlers, after resolving `(key, version)`, returns **404 not-found** if `gemAccessInfo(...).visibility === "private"`. Public/unlisted and archive-only (`null`) are unaffected.

- [ ] **Step 1: Write the failing test**

`src/aggregator/__tests__/refusePrivate.controller.test.ts`:
```ts
// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
import { describe, it, expect } from "vitest";
import { makeTestDb, upsertCatalogGem, upsertGemArchive } from "@agentgem/aggregator";
import { AggregatorController } from "../../aggregator.controller.js";
import { exportGem } from "@agentgem/archive"; // if a game-gem builder is needed; else construct bytes via a fixture

// Minimal: a private catalog row + its archive; assert the public GETs 404.
describe("anonymous resolve refuses private", () => {
  async function seedPrivateGame(db: Awaited<ReturnType<typeof makeTestDb>>) {
    // Build a game-gem archive whose only artifact is a game (title/html), then store it + a private catalog row.
    // Reuse the archive-building helper the share/publish tests use; if unavailable, store raw bytes and assert on gem-archive only.
    // (Implementer: mirror how gameMeta.controller.test.ts / gemArchive.controller.test.ts build their fixtures.)
  }
  it("gem-archive 404s a private key", async () => {
    const db = await makeTestDb();
    await upsertGemArchive(db, { gemKey: "@me/g", version: "1", bytes: new Uint8Array([1]), digest: "d", createdAtMs: 1, ownerAccountId: "acct-1" });
    await upsertCatalogGem(db, { gemKey: "@me/g", version: "1", publishedBy: "me", createdAtMs: 1, ownerAccountId: "acct-1", visibility: "private" });
    const ctrl = new AggregatorController(db);
    await expect(ctrl.gemArchive({ query: { key: "@me/g", version: "1" } })).rejects.toMatchObject({ status: 404 });
  });
  it("gem-archive still serves a public key", async () => {
    const db = await makeTestDb();
    await upsertGemArchive(db, { gemKey: "@me/pub", version: "1", bytes: new Uint8Array([1, 2]), digest: "d", createdAtMs: 1, ownerAccountId: "acct-1" });
    await upsertCatalogGem(db, { gemKey: "@me/pub", version: "1", publishedBy: "me", createdAtMs: 1, ownerAccountId: "acct-1", visibility: "public" });
    const ctrl = new AggregatorController(db);
    const res = await ctrl.gemArchive({ query: { key: "@me/pub", version: "1" } });
    expect(typeof res.archiveBase64).toBe("string");
  });
  it("gem-archive still serves an archive-only key with no catalog row (unlisted share)", async () => {
    const db = await makeTestDb();
    await upsertGemArchive(db, { gemKey: "shareid", version: "1", bytes: new Uint8Array([9]), digest: "d", createdAtMs: 1, ownerAccountId: "acct-1" });
    const ctrl = new AggregatorController(db);
    const res = await ctrl.gemArchive({ query: { key: "shareid", version: "1" } });
    expect(typeof res.archiveBase64).toBe("string");
  });
});
```
> The `gem-archive` handler doesn't parse the archive, so raw bytes suffice for its tests. For `game-html`/`game-meta` (which `importGem` + require a game artifact), build the fixture the same way the sibling `gameMeta.controller.test.ts` / `gemArchive.controller.test.ts` do — read those first and mirror. Add analogous private-404 + public-served cases for `gameMeta` and `gameHtml`.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx tsc -b && npx vitest run dist/aggregator/__tests__/refusePrivate.controller.test.js`
Expected: FAIL — private key is served (no 404 yet).

- [ ] **Step 3: Implement**

In `src/aggregator.controller.ts`, add `gemAccessInfo` to the `@agentgem/aggregator` import. In each handler, after `(key, version)` is known and before returning the payload, add:
```ts
    if ((await gemAccessInfo(this.db, key, version))?.visibility === "private")
      throw new AgentError("gem archive not found", { status: 404, code: "gem_archive_not_found", retryable: false });
```
- `gemArchive`: `key`/`version` are `input.query.key`/`input.query.version`; insert the check after the `getGemArchive` null-check (or before — both fine; use `input.query.key, input.query.version`).
- `gameHtml`: same, using `input.query.key, input.query.version`.
- `gameMeta`: insert AFTER `version` is resolved (`const version = ... latestGemVersion ... archiveOnlyVersion`) and the `if (!version) 404`, using `key, version`. (Archive-only shares resolve via `archiveOnlyVersion` and have no catalog row → `gemAccessInfo` null → served.)

- [ ] **Step 4: Run test to verify it passes**

Run: `npx tsc -b && npx vitest run dist/aggregator/__tests__/refusePrivate.controller.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/aggregator.controller.ts src/aggregator/__tests__/refusePrivate.controller.test.ts
git commit -m "feat(aggregator): anonymous resolve endpoints 404 private gems

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 4: session-gated owner endpoints (`my-gems` + owner play)

**Files:**
- Modify: `src/catalog/install.ts` (add `myGemsHandler`, `ownerGameMetaHandler`, `ownerGameHtmlHandler` + register GET routes; extend the `ExpressApp` type with `get`)
- Modify: `src/index.ts` (no change if added inside `installCatalog`; it's already wired)
- Test: `src/__tests__/catalogOwnerEndpoints.test.ts`

**Interfaces:**
- Consumes: `resolveSession`, `listCatalogGemsForOwner`, `gemAccessInfo`, `latestGemVersion`, `getGemArchive` (from `@agentgem/aggregator`), `importGem` (from `@agentgem/archive`).
- Produces (all under `/api/catalog/`, session-gated, 401 if no session):
  - `GET /api/catalog/my-gems` → `{ gems: Array<{ key, version, description, artifactKinds, visibility, installable }> }` for the caller's owned gems.
  - `GET /api/catalog/game-meta?key` → owner-only `{ title, genre, version }` (403 if the resolved row isn't owned by the caller; 404 if unknown/not-a-game).
  - `GET /api/catalog/game-html?key&version` → owner-only `{ html }` (403 if not owner; 404 if unknown/not-a-game).

- [ ] **Step 1: Write the failing test**

`src/__tests__/catalogOwnerEndpoints.test.ts` — mirror `src/__tests__/starsInstall.test.ts` for the `withSession`/`mockRes`/`req`/`deps` scaffolding (read it first and copy those helpers verbatim). Cover:
```ts
// my-gems: 401 without session; with session returns only the caller's gems (incl. private).
// game-meta/game-html: 401 without session; 403 when the gem is owned by a different account;
// 200 with the game payload when the caller owns it (build a game-gem archive fixture like the
// aggregator game tests, store it + a private catalog row owned by the session's user.id).
```
Seed ownership so `owner_account_id === user.id` (the session's account). Use `mintSession`/`makeAuth` from `@agentgem/aggregator` exactly as `starsInstall.test.ts` does. Assert `_status` and `_body`.

- [ ] **Step 2: Run to verify it fails**

Run: `npx tsc -b && npx vitest run dist/__tests__/catalogOwnerEndpoints.test.js`
Expected: FAIL — handlers not exported / routes not registered.

- [ ] **Step 3: Implement in `src/catalog/install.ts`**

Extend the `ExpressApp` type to include `get(p, h)`. Add the three handlers following the exact `cors`/`preflight`/`sessionAccountId`/401 shape already in the file. Sketch (fill in with the file's existing helpers):
```ts
export function myGemsHandler(deps: CatalogDeps) {
  return async (req: Req, res: Res): Promise<void> => {
    cors(req, res, deps.webOrigins);
    if (req.method === "OPTIONS") { preflight(res); return; }
    const accountId = await sessionAccountId(deps, req);
    if (!accountId) { res.status(401).json({ error: "sign in required" }); return; }
    const rows = await listCatalogGemsForOwner(deps.db, accountId);
    res.json({ gems: rows.map((g) => ({ key: g.gemKey, version: g.version, description: g.description ?? "", artifactKinds: g.artifactKinds ?? [], visibility: g.visibility ?? "public", installable: g.installable ?? false })) });
  };
}
// ownerGameMetaHandler / ownerGameHtmlHandler: resolveSession → 401; resolve version (latestGemVersion for meta,
// query.version for html); const info = await gemAccessInfo(deps.db, key, version); if (!info || info.ownerAccountId !== accountId) 404;
// then getGemArchive + importGem + pull the game artifact (title/genre or html), 404 if not-a-game. Mirror the
// aggregator controller's gameMeta/gameHtml body for the extraction.
```
Register in `installCatalog`:
```ts
  for (const p of ["/api/catalog/my-gems"]) { expressApp.get(p, myGemsHandler(deps)); expressApp.options(p, myGemsHandler(deps)); }
  for (const p of ["/api/catalog/game-meta"]) { expressApp.get(p, ownerGameMetaHandler(deps)); expressApp.options(p, ownerGameMetaHandler(deps)); }
  for (const p of ["/api/catalog/game-html"]) { expressApp.get(p, ownerGameHtmlHandler(deps)); expressApp.options(p, ownerGameHtmlHandler(deps)); }
```
Update `preflight` to allow `GET` (currently `"DELETE, OPTIONS"`) — use `"GET, DELETE, OPTIONS"`.

> Note: 404 (not 403) when `info.ownerAccountId !== accountId` on the owner resolve keeps parity with the anonymous refusal (no existence leak). Use 403 only for `my-gems`? No — `my-gems` needs no per-gem check. For the owner-resolve endpoints, a non-owner authenticated caller gets 404 (same as unknown), consistent with the no-leak rule.

- [ ] **Step 4: Run to verify it passes**

Run: `npx tsc -b && npx vitest run dist/__tests__/catalogOwnerEndpoints.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/catalog/install.ts src/__tests__/catalogOwnerEndpoints.test.ts
git commit -m "feat: session-gated owner endpoints (my-gems + owner play)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 5: console — Private publish option

**Files:**
- Modify: `src/schemas.ts` (`PlaybookPublishBodySchema` visibility enum)
- Modify: the `CatalogManifestSchema` visibility enum (already accepts all three — verify; no change if so)
- Modify: `packages/console/src/api/routes.ts` (`publishSetupRoute`, `playbookPublishRoute` visibility enums)
- Modify: `packages/console/src/panels/Play/Studio.tsx` (scope state type + a Private selector button)
- Modify: `packages/console/src/panels/Play/__tests__/StudioShare.test.tsx`

**Interfaces:**
- Widen the publish-edge visibility enum from `["public","unlisted"]` to `["public","unlisted","private"]` and add a **Private** option to the Studio scope selector.

- [ ] **Step 1: Widen the edge enums**

In `src/schemas.ts` `PlaybookPublishBodySchema`, and in both `publishSetupRoute` and `playbookPublishRoute` bodies (`packages/console/src/api/routes.ts`), change `z.enum(["public","unlisted"])` → `z.enum(["public","unlisted","private"])`. (`CatalogManifestSchema` already accepts all three from PR 2a — confirm with `grep`.)

- [ ] **Step 2: Add the Private selector option (TDD via StudioShare)**

In `Studio.tsx`, change `scope` state type to `"public" | "unlisted" | "private"` and add a third selector button (mirror the existing Public/Unlisted buttons):
```tsx
        <button type="button" className={`play-btn ${scope === "private" ? "play-btn--primary" : "play-btn--ghost"}`} aria-pressed={scope === "private"} onClick={() => setScope("private")}>Private</button>
```
In `StudioShare.test.tsx`, add a test: select Private, publish, assert the `publishSetupRoute` body carries `visibility: "private"`.

- [ ] **Step 3: Verify**

Run: `npx tsc -b && cd packages/console && npx vitest run src/panels/Play/__tests__/StudioShare.test.tsx`
Expected: clean; StudioShare green (existing + new private test).

- [ ] **Step 4: Commit**

```bash
git add src/schemas.ts packages/console/src/api/routes.ts packages/console/src/panels/Play/Studio.tsx packages/console/src/panels/Play/__tests__/StudioShare.test.tsx
git commit -m "feat(console): Private option in the publish scope selector

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 6: marketplace — "My apps" + owner play of private

**Files:**
- Modify: `packages/marketplace/src/api.ts` (add `getMyGems`, `getOwnerGameMeta`, `getOwnerGameHtml`)
- Create: `packages/marketplace/src/pages/MyApps.tsx`
- Modify: `packages/marketplace/src/Router.tsx` (add `my-apps` panel route + `PANELS`)
- Modify: `packages/marketplace/src/App.tsx` (nav link, `{me && ...}`)
- Test: `packages/marketplace/src/pages/MyApps.test.tsx`; update `packages/marketplace/src/Router.conformance.test.tsx` if it enumerates panels/routes.

**Interfaces:**
- Consumes the Task 4 endpoints. Read `api.ts` (the `getAccountProviders` credentialed template), `Router.tsx` (panel-route shape), `App.tsx` (nav), `pages/Account.tsx` or `Publish.tsx` (a `me`-gated panel page for structure), and `GamePlayer` (used by `Play.tsx`) before writing.

- [ ] **Step 1: Add api methods (credentialed, mirror `getAccountProviders`)**

```ts
    getMyGems: async (): Promise<{ gems: MyGem[] }> => {
      const res = await fetch(base + "/api/catalog/my-gems", { credentials: "include" });
      if (!res.ok) throw new Error(`/api/catalog/my-gems -> ${res.status}`);
      return JSON.parse(await res.text()) as { gems: MyGem[] };
    },
    getOwnerGameMeta: (key: string) =>
      getCred<GameMeta>(base, "/api/catalog/game-meta", { key }),
    getOwnerGameHtml: (key: string, version: string) =>
      getCred<{ html: string }>(base, "/api/catalog/game-html", { key, version }).then((r) => r.html),
```
Add a small credentialed `getCred<T>` helper (like `get<T>` but with `{ credentials: "include" }`), and a `MyGem` type `{ key: string; version: string; description: string; artifactKinds: string[]; visibility: "public"|"unlisted"|"private"; installable: boolean }`.

- [ ] **Step 2: Build the `MyApps` page**

`MyApps.tsx` (structure mirrors `Account.tsx`/`Publish.tsx` — gate on `!me` → sign-in prompt). Fetch `getMyGems()`; render a list of the owner's gems with a **visibility badge** (Public / Unlisted / Private). For game gems (artifactKinds includes `"game"`), a **Play** button that, for a private gem, resolves via `getOwnerGameMeta`/`getOwnerGameHtml` and renders `<GamePlayer html=... interactive />` (inline or in a modal); public/unlisted games can link to the normal `/games/<key>` route.

- [ ] **Step 3: Route + nav**

In `Router.tsx`, add `{ id: "my-apps", kind: "panel", match: (p) => p === "/my-apps", render: (_m, c) => <MyApps api={c.api} me={c.me} /> }` and add `"my-apps"` to `PANELS`. In `App.tsx` nav, add `{me && <a href="/my-apps" className={"ex-navlink" + (onMyApps ? " is-active" : "")}>My apps</a>}` with an `onMyApps` active-state.

- [ ] **Step 4: Tests**

`MyApps.test.tsx`: mock `api.getMyGems` to return public+unlisted+private gems; assert all render with correct badges; assert a sign-in prompt when `me` is null. If `Router.conformance.test.tsx` enumerates `PANELS`/routes, update it so `my-apps` conforms.

- [ ] **Step 5: Verify**

Run: `cd packages/marketplace && npx vitest run` (whole marketplace suite green, incl. the new + conformance tests).

- [ ] **Step 6: Commit**

```bash
git add packages/marketplace/src/api.ts packages/marketplace/src/pages/MyApps.tsx packages/marketplace/src/Router.tsx packages/marketplace/src/App.tsx packages/marketplace/src/pages/MyApps.test.tsx packages/marketplace/src/Router.conformance.test.tsx
git commit -m "feat(marketplace): My apps view + owner play of private gems

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 7: end-to-end verification + PR

- [ ] **Step 1: Full gate** — `pnpm build` then `pnpm test` (root); `cd packages/marketplace && npx vitest run`; `cd packages/console && npx vitest run`. All green. (Remember: `pnpm build` before root tests; watch for stale-`dist` artifacts of any deleted test source.)
- [ ] **Step 2: Drive** (verify/run skill): publish a miniapp as **Private**; confirm it's absent from Explore (`/api/registry/gems`) AND that anonymous `game-meta`/`gem-archive` for its key **404**; sign in on the marketplace, open **My apps**, confirm the private gem is listed with a Private badge and **plays** via the owner endpoint. Confirm a public/unlisted gem is unaffected.
- [ ] **Step 3: Push + PR** off `origin/main`; title "Publish visibility — Private, owner-only (PR 2b)". Body: enforcement (anonymous 404 for private, no leak), my-gems + owner play, Studio Private option, marketplace My apps. Note deferred: owner install/download of private + full private Gem-detail page.
- [ ] **Step 4: Watch CI** (`gh run watch <id> --exit-status`; then confirm the check actually shows `pass` — reruns for the flaky `coldBuildWorker` event-loop test if needed) → `gh pr merge --rebase --delete-branch`. After merge, `git fetch` + grep `origin/main:<file>` for a marker from EVERY commit.

---

## Self-Review

- **Spec coverage (Private slice):** Explore already excludes private (PR 2a); anonymous resolve refuses private → Task 3; owner sees/plays via marketplace → Tasks 4+6; Studio Private option → Task 5; ownership by uuid via resolveSession → Tasks 4. Carryover privacy-downgrade fix → Task 2. Deferred (owner install/download, private detail page) documented.
- **No-existence-leak invariant:** anonymous refuse = 404 (Task 3), non-owner authed resolve = 404 (Task 4) — consistent, never 403 on a private-existence check.
- **Public/Unlisted unchanged:** the private gate is an added conditional keyed on `visibility === "private"`; `gemAccessInfo` null (archive-only) is treated non-private, so old `/games/<id>` links keep resolving.
- **Type consistency:** `gemAccessInfo` shape `{ visibility, ownerAccountId }` consumed identically in Tasks 3+4; `listCatalogGemsForOwner` returns `CatalogRow[]` with `visibility` populated; the edge enum widens to all three (Task 5) with server `CatalogManifestSchema` already accepting all three.
- **Placeholder honesty:** Tasks 3, 4, 6 require reading sibling fixtures/pages (game-gem archive builder; `starsInstall.test.ts` session helpers; `Account.tsx` page structure) — each names the exact file to mirror. These are bounded "read then mirror" steps, not vague TODOs.
- **Ownership never client-trusted:** every owner endpoint resolves the session server-side; `me.id` is display-gating only on the client.
