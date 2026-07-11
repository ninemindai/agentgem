# Publish visibility — Public/Unlisted (PR 2a) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give every published gem a `visibility` scope, expose **Public / Unlisted** in the Studio publish flow (Public = listed in Explore, Unlisted = hidden from Explore but reachable by its `/games/@scope/name` link), and retire the legacy archive-only "Copy share link" quick-share now that an unlisted publish replaces it.

**Architecture:** Add a `visibility text NOT NULL DEFAULT 'public'` column to `catalog_gems`, thread it through the signed publish manifest into the row, and filter the anonymous Explore list (`listCatalogGems`) to `visibility='public'`. Unlisted gems simply don't appear in Explore but resolve normally by key (the `/games/:key` route already handles scoped keys). **Private is explicitly out of scope here** — it needs owner-only server-enforcement (resolve gate + `my-gems` + originGuard) and ships in PR 2b; to avoid shipping a fake "private," this PR's publish schema accepts only `public`|`unlisted`.

**Tech Stack:** TypeScript (ESM, `.js` specifiers), Drizzle + PGlite (aggregator tests), zod + @agentback (controllers/routes), React (console), vitest.

## Global Constraints

- **Node ≥ 24, ESM.** Local imports use the `.js` extension in the specifier.
- **New-file header** (first two lines of every new source/test file):
  ```
  // Copyright (c) 2026 NineMind, Inc.
  // SPDX-License-Identifier: MIT
  ```
- **`visibility` values:** the DB column is free-text `'public' | 'unlisted' | 'private'` (forward-compatible with PR 2b). **This PR's publish-body zod enum accepts only `["public","unlisted"]`** — do not add `'private'` to any user-facing schema or UI here.
- **Default is `'public'`** everywhere (column default, manifest default, schema `.optional()` → treated as public). Public = today's exact behavior; this PR must not change what a public publish does.
- **Signing:** `visibility` rides inside the signed `CatalogManifest` (the signature hashes `canonicalJSON(manifest)`); client and server both include it, so no signing-scheme change — never invent one.
- **Ownership** is the `accounts.id` uuid, never `published_by`.
- **DDL is hand-written idempotent SQL in `ensureSchema`** (not drizzle-kit): every schema change adds BOTH the `pgTable` column AND an `alter table ... add column if not exists` line.
- **Test homes / commands:**
  - Aggregator: `src/aggregator/__tests__/*.test.ts`; run `npx tsc -b && npx vitest run dist/aggregator/__tests__/<name>.test.js` (root vitest globs compiled `dist/**`, NOT `src/`).
  - Console: co-located `*.test.ts(x)`; run `cd packages/console && npx vitest run <path>` (console vitest runs `src` directly).
  - Full gate before PR: `npm test` (root `tsc -b && vitest run`) **and** `cd packages/console && npx vitest run`.
- **Commit trailer** (every commit): `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`
- Work in the worktree `/Users/rfeng/Projects/ninemind/agentgem-worktrees/publish-visibility` on branch `feat/publish-visibility`.

---

### Task 1: `visibility` column on `catalog_gems`

**Files:**
- Modify: `packages/aggregator/src/schema.ts` (pgTable `catalogGems` ~line 276-291; `ensureSchema` catalog_gems DDL ~line 567-569)
- Test: `src/aggregator/__tests__/visibilityColumn.test.ts`

**Interfaces:**
- Produces: a `visibility` column, NOT NULL default `'public'`, on `catalog_gems`.

- [ ] **Step 1: Write the failing test**

`src/aggregator/__tests__/visibilityColumn.test.ts`:
```ts
// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
import { describe, it, expect } from "vitest";
import { sql } from "drizzle-orm";
import { makeTestDb } from "@agentgem/aggregator";

describe("catalog_gems.visibility column", () => {
  it("exists and defaults to 'public' for a row inserted without it", async () => {
    const db = await makeTestDb();
    await db.execute(sql`insert into catalog_gems (gem_key, version, published_by, created_at_ms) values ('@me/g', '0.1.0', 'me', 1000)`);
    const rows = await db.execute(sql`select visibility from catalog_gems where gem_key = '@me/g'`);
    // pglite returns { rows: [...] }
    const r = (rows as unknown as { rows: { visibility: string }[] }).rows[0];
    expect(r.visibility).toBe("public");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx tsc -b && npx vitest run dist/aggregator/__tests__/visibilityColumn.test.js`
Expected: FAIL — column `visibility` does not exist.

- [ ] **Step 3: Add the column (pgTable + DDL)**

In `packages/aggregator/src/schema.ts`, add to the `catalogGems` pgTable, right after the `ownerAccountId` line:
```ts
  // Sharing scope. 'public' = listed in Explore; 'unlisted' = hidden from Explore but reachable by
  // its /games/<key> link; 'private' = owner-only (enforcement lands in PR 2b). Default public.
  visibility: text("visibility").notNull().default("public"),
```
In `ensureSchema`, right after the `alter table catalog_gems add column if not exists artifacts jsonb` line:
```ts
  await db.execute(sql`alter table catalog_gems add column if not exists visibility text not null default 'public'`);
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx tsc -b && npx vitest run dist/aggregator/__tests__/visibilityColumn.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/aggregator/src/schema.ts src/aggregator/__tests__/visibilityColumn.test.ts
git commit -m "feat(aggregator): add catalog_gems.visibility column (default public)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: thread `visibility` through the aggregator core + filter Explore

**Files:**
- Modify: `packages/aggregator/src/catalog.ts` — `CatalogRow` (~12-20), `upsertCatalogGem` (~22-38), `CatalogManifest` (~164-170), `recordCatalogShare` (~222-248), `listCatalogGems` (~40-57)
- Test: `src/aggregator/__tests__/visibility.test.ts`

**Interfaces:**
- Consumes: `catalogGems`, `eq`, `desc`, `and` (already imported).
- Produces:
  - `type Visibility = "public" | "unlisted" | "private"` (export from catalog.ts)
  - `CatalogRow.visibility?: Visibility`; `CatalogManifest.visibility?: Visibility`
  - `upsertCatalogGem` writes `visibility` (default `'public'`)
  - `recordCatalogShare` threads `manifest.visibility` into the row
  - `listCatalogGems` returns only `visibility='public'` rows

- [ ] **Step 1: Write the failing test**

`src/aggregator/__tests__/visibility.test.ts`:
```ts
// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
import { describe, it, expect } from "vitest";
import { generateKeyPairSync, sign as edSign } from "node:crypto";
import { makeTestDb, upsertCatalogGem, listCatalogGems, catalogSigningPayload, recordCatalogShare, producers, accountBindings, accounts, catalogGems, type CatalogManifest } from "@agentgem/aggregator";
import { sql } from "drizzle-orm";

function signer() {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const pubkey = "ed25519:" + publicKey.export({ format: "der", type: "spki" }).toString("base64");
  return { pubkey, sign: (d: string) => edSign(null, Buffer.from(d, "utf8"), privateKey).toString("base64") };
}
async function bind(db: Awaited<ReturnType<typeof makeTestDb>>, pubkey: string) {
  const accountId = crypto.randomUUID();
  await db.insert(producers).values({ pubkey });
  await db.insert(accounts).values({ id: accountId, provider: "github", providerAccountId: "42", login: "octocat" });
  await db.insert(accountBindings).values({ pubkey, provider: "github", accountId: "42", accountLogin: "octocat" });
  return accountId;
}

describe("visibility threading + Explore filter", () => {
  it("upsertCatalogGem defaults visibility to public and round-trips a value", async () => {
    const db = await makeTestDb();
    await upsertCatalogGem(db, { gemKey: "@me/a", version: "0.1.0", publishedBy: "me", createdAtMs: 1 });
    await upsertCatalogGem(db, { gemKey: "@me/b", version: "0.1.0", publishedBy: "me", createdAtMs: 2, visibility: "unlisted" });
    const rows = (await db.execute(sql`select gem_key, visibility from catalog_gems order by gem_key`)) as unknown as { rows: { gem_key: string; visibility: string }[] };
    expect(rows.rows).toEqual([{ gem_key: "@me/a", visibility: "public" }, { gem_key: "@me/b", visibility: "unlisted" }]);
  });

  it("listCatalogGems returns only public rows", async () => {
    const db = await makeTestDb();
    await upsertCatalogGem(db, { gemKey: "@me/pub", version: "0.1.0", publishedBy: "me", createdAtMs: 1, visibility: "public" });
    await upsertCatalogGem(db, { gemKey: "@me/unl", version: "0.1.0", publishedBy: "me", createdAtMs: 2, visibility: "unlisted" });
    await upsertCatalogGem(db, { gemKey: "@me/prv", version: "0.1.0", publishedBy: "me", createdAtMs: 3, visibility: "private" });
    const listed = (await listCatalogGems(db)).map((g) => g.gemKey);
    expect(listed).toEqual(["@me/pub"]);
  });

  it("recordCatalogShare stores the manifest visibility", async () => {
    const db = await makeTestDb();
    const s = signer();
    await bind(db, s.pubkey);
    const m: CatalogManifest = { gemKey: "@octocat/g", version: "1.0.0", visibility: "unlisted" };
    const now = 1_000_000;
    const sig = s.sign(catalogSigningPayload(m, s.pubkey, now));
    const res = await recordCatalogShare(db, { manifest: m, pubkey: s.pubkey, signedAt: now, signature: sig }, now);
    expect(res).toMatchObject({ shared: true });
    const row = (await db.select({ v: catalogGems.visibility }).from(catalogGems))[0];
    expect(row.v).toBe("unlisted");
    // unlisted is excluded from Explore
    expect(await listCatalogGems(db)).toEqual([]);
  });

  it("recordCatalogShare defaults missing visibility to public (listed)", async () => {
    const db = await makeTestDb();
    const s = signer();
    await bind(db, s.pubkey);
    const m: CatalogManifest = { gemKey: "@octocat/g", version: "1.0.0" };
    const now = 1_000_000;
    const sig = s.sign(catalogSigningPayload(m, s.pubkey, now));
    await recordCatalogShare(db, { manifest: m, pubkey: s.pubkey, signedAt: now, signature: sig }, now);
    expect((await listCatalogGems(db)).map((g) => g.gemKey)).toEqual(["@octocat/g"]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx tsc -b && npx vitest run dist/aggregator/__tests__/visibility.test.js`
Expected: FAIL — `Visibility` not exported / `visibility` not persisted / `listCatalogGems` returns all rows.

- [ ] **Step 3: Implement**

In `packages/aggregator/src/catalog.ts`:

Add the type near the top (after the imports):
```ts
export type Visibility = "public" | "unlisted" | "private";
```

Add to `CatalogRow` (after `ownerAccountId`):
```ts
  visibility?: Visibility;
```

Add to `CatalogManifest` (after `gemDigest`):
```ts
  visibility?: Visibility;
```

In `upsertCatalogGem`, add `visibility` to BOTH the `.values({...})` and the `.onConflictDoUpdate({ set: {...} })` objects:
```ts
    // in .values({...}):
    visibility: row.visibility ?? "public",
```
```ts
    // in set: {...}:
      visibility: row.visibility ?? "public",
```

In `recordCatalogShare`, add `visibility` to the `upsertCatalogGem({...})` call:
```ts
    visibility: m.visibility ?? "public",
```

In `listCatalogGems`, add a `.where(...)` before `.orderBy(...)`:
```ts
    .where(eq(catalogGems.visibility, "public"))
```
(so the query reads `...leftJoin(...).where(eq(catalogGems.visibility, "public")).orderBy(desc(catalogGems.createdAtMs))`.)

- [ ] **Step 4: Run test to verify it passes**

Run: `npx tsc -b && npx vitest run dist/aggregator/__tests__/visibility.test.js`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/aggregator/src/catalog.ts src/aggregator/__tests__/visibility.test.ts
git commit -m "feat(aggregator): thread visibility into the row; filter Explore to public

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 3: accept `visibility` on the publish edge (server schema + publish body)

**Files:**
- Modify: the `CatalogManifestSchema` zod definition (locate with `grep -rn "CatalogManifestSchema" packages/ src/` — it's the schema `recordCatalogShare`'s callers validate against; likely in `src/aggregator.controller.ts` or a shared schema module)
- Modify: `src/schemas.ts` — `PlaybookPublishBodySchema` (~559-562)
- Modify: `packages/console/src/api/routes.ts` — `publishSetupRoute` body (~795-800) and `playbookPublishRoute` body (~791-794)
- Modify: `src/gem.controller.ts` — the `manifest = {...}` object in `publishSetup` (~625-632) and in `playbookPublish` (~590-614)
- Verify: `npx tsc -b`

**Interfaces:**
- Consumes: `Visibility` (Task 2).
- Produces: the publish request carries `visibility?: "public" | "unlisted"` end-to-end into the manifest that `postGemPublish`/`postCatalogShare` sign and send. (Those clients already serialize the whole `manifest` object, so adding the field to the manifest literal is sufficient — do not change the client files.)

- [ ] **Step 1: Widen the server manifest schema**

Locate `CatalogManifestSchema` (grep). Add to its `z.object({...})`:
```ts
  visibility: z.enum(["public", "unlisted", "private"]).optional(),
```
(The server accepts all three for forward-compat with PR 2b; the console never sends `private` in this PR.)

- [ ] **Step 2: Add `visibility` to the publish body schema**

In `src/schemas.ts`, `PlaybookPublishBodySchema`, add (note: only `public`/`unlisted` at the edge):
```ts
  visibility: z.enum(["public", "unlisted"]).optional(),
```

- [ ] **Step 3: Add `visibility` to the console routes**

In `packages/console/src/api/routes.ts`, add `visibility: z.enum(["public", "unlisted"]).optional(),` to the `body: z.object({...})` of BOTH `publishSetupRoute` and `playbookPublishRoute`.

- [ ] **Step 4: Thread it into the manifest objects**

In `src/gem.controller.ts`, add `visibility: b.visibility,` to the `const manifest = {...}` literal in BOTH `publishSetup` and `playbookPublish` (right after `gemKey`/`version`).

- [ ] **Step 5: Typecheck**

Run: `npx tsc -b`
Expected: clean. (Threading is transparent to the signed clients, which serialize the whole manifest; storage + filtering are already covered by Task 2's tests, so no new unit test here — this step is schema/type wiring gated by tsc.)

- [ ] **Step 6: Commit**

```bash
git add src/aggregator.controller.ts src/schemas.ts packages/console/src/api/routes.ts src/gem.controller.ts
git commit -m "feat(publish): accept visibility on the publish edge and thread into the manifest

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```
> If `CatalogManifestSchema` lives in a file other than `aggregator.controller.ts`, adjust the `git add` path accordingly.

---

### Task 4: Studio scope selector (Public / Unlisted)

**Files:**
- Modify: `packages/console/src/panels/Play/Studio.tsx`
- Modify (if StudioShare asserts the publish body): `packages/console/src/panels/Play/__tests__/StudioShare.test.tsx`
- Modify: `packages/console/src/shell/theme.css` (only if a new class is needed; prefer existing `play-*` classes)

**Interfaces:**
- Consumes: `publishSetupRoute` (now accepts `visibility`).
- Produces: a `scope` selector (default `"public"`) whose value is sent as `visibility` on publish; an unlisted publish surfaces the playable `/games/<key>` link.

- [ ] **Step 1: Add scope state**

Next to the other publish `useState`s (~line 49-56):
```tsx
  const [scope, setScope] = useState<"public" | "unlisted">("public");
```

- [ ] **Step 2: Thread visibility through `publishWorkspace`**

Change the signature to `publishWorkspace(login: string, version: string, visibility: "public" | "unlisted")` and:
- add `visibility,` to the `publishSetupRoute.call(...)` body object;
- on success, branch the share link by visibility:
```tsx
      const gemUrl = visibility === "unlisted"
        ? `https://app.agentgem.ai/games/${pub.exploreRef}`   // playable link; not listed in Explore
        : `https://app.agentgem.ai/gems/${encodeURIComponent(pub.exploreRef)}`;
      setShare({ gemUrl, cardUrl: pub.shareUrl }); setStatus("");
```

- [ ] **Step 3: Pass `scope` at every publish call site**

- In `checkAndPublish`, the `action.kind === "publish"` branch: `await publishWorkspace(login, action.version, scope);`
- In the `pendingVersion` confirm-banner buttons (both "Publish v{next}" and "Overwrite v{latest}"): pass `scope` as the third arg to `publishWorkspace(p.login, p.nextVersion, scope)` / `(p.login, p.latestVersion, scope)`.

- [ ] **Step 4: Render the selector**

Add, adjacent to the "Share to Explore" control (match the existing control styling; a minimal segmented control using existing `play-btn`/`play-btn--primary` is fine):
```tsx
      <div className="play-scope" role="radiogroup" aria-label="Sharing scope">
        <button type="button" className={`play-btn ${scope === "public" ? "play-btn--primary" : "play-btn--ghost"}`} aria-pressed={scope === "public"} onClick={() => setScope("public")}>Public</button>
        <button type="button" className={`play-btn ${scope === "unlisted" ? "play-btn--primary" : "play-btn--ghost"}`} aria-pressed={scope === "unlisted"} onClick={() => setScope("unlisted")}>Unlisted</button>
      </div>
```
If `.play-scope` needs layout, add to `theme.css` next to the other `play-*` rules:
```css
.play-scope { display: inline-flex; gap: 6px; }
```

- [ ] **Step 5: Update/extend the Studio test**

Read `StudioShare.test.tsx`. If it asserts the `publishSetupRoute` call body, add `visibility: "public"` to the expected body (default). Add one test: set scope to Unlisted, publish, and assert the call body carries `visibility: "unlisted"` and the surfaced link is the `/games/` form. Mock `publishStatusRoute` to return `{ exists: false, ownedByMe: false, latestVersion: null }` so publish proceeds.

- [ ] **Step 6: Verify**

Run: `npx tsc -b && cd packages/console && npx vitest run src/panels/Play/__tests__/StudioShare.test.tsx`
Expected: clean typecheck; StudioShare green.

- [ ] **Step 7: Commit**

```bash
git add packages/console/src/panels/Play/Studio.tsx packages/console/src/panels/Play/__tests__/StudioShare.test.tsx packages/console/src/shell/theme.css
git commit -m "feat(console): Public/Unlisted scope selector in the publish flow

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 5: retire the quick-share — console side

**Files:**
- Modify: `packages/console/src/panels/Play/Studio.tsx`
- Modify: `packages/console/src/api/routes.ts`
- Modify: `packages/console/src/panels/Play/__tests__/StudioShare.test.tsx` (remove quick-share assertions)

**Interfaces:**
- Produces: no more "Copy share link" UI or `/api/play/share` client route; unlisted publish is the only share path. Existing `/games/<id>` links keep resolving (server resolve untouched here).

- [ ] **Step 1: Remove the console quick-share surface**

In `Studio.tsx`, delete: `copyShareLink`, `mintShare`, `revokeShareLink`, `dismissShareConnect`; the `shareLink`, `pendingShare`, `sharing` state declarations; the "Copy share link" button (`Studio.tsx:384`); the `shareLink` banner and the `pendingShare` connect banner; the `onBound` resume branch that calls `mintShare` (line ~73); and the `refresh()` line that reads `r.share?.url` into `setShareLink`. Remove `shareMiniappRoute, revokeMiniappRoute` from the routes import (line 3). Leave the **publish** flow (`shareToExplore`/`checkAndPublish`/`publishWorkspace`/`pendingVersion`/`pendingPublish`) intact.

- [ ] **Step 2: Remove the client routes**

In `packages/console/src/api/routes.ts`, delete `shareMiniappRoute` and `revokeMiniappRoute` (~968-974).

- [ ] **Step 3: Update the Studio test**

In `StudioShare.test.tsx`, remove any test that exercises `copyShareLink`/`mintShare`/`revokeShareLink`/the share-link banner. Keep the publish/confirm/scope tests.

- [ ] **Step 4: Verify**

Run: `npx tsc -b && cd packages/console && npx vitest run`
Expected: clean typecheck (no dangling references to the removed symbols); console suite green.

- [ ] **Step 5: Commit**

```bash
git add packages/console/src/panels/Play/Studio.tsx packages/console/src/api/routes.ts packages/console/src/panels/Play/__tests__/StudioShare.test.tsx
git commit -m "refactor(console): retire the legacy Copy-share-link quick-share

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 6: retire the quick-share — server side (keep resolve)

**Files:**
- Modify: `src/play.controller.ts` (remove `share`, `revoke` handlers + their schemas/imports)
- Modify: `src/aggregator.controller.ts` (remove `share-archive` POST mint + `share-archive/revoke` + their schemas)
- Delete: `src/gem/shareArchiveClient.ts` (its only callers were the removed play handlers) — confirm no other importers first
- Test: `src/aggregator/__tests__/gameResolveStillWorks.test.ts` (prove old archive-only `/games/<id>` links still resolve after the mint routes are gone)

**Interfaces:**
- Keep intact (the resolve path): `getGemArchive`, `archiveOnlyVersion`, `latestGemVersion`, `deleteGemArchiveOwned`, `upsertGemArchive`, and the `game-meta`/`game-html`/`gem-archive` GET handlers. Only the POST **mint** side is removed.

- [ ] **Step 1: Write the resolve-still-works test (guards the deletion)**

`src/aggregator/__tests__/gameResolveStillWorks.test.ts`:
```ts
// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
import { describe, it, expect } from "vitest";
import { makeTestDb, upsertGemArchive, archiveOnlyVersion, getGemArchive } from "@agentgem/aggregator";

describe("archive-only /games/<id> resolve survives the quick-share retirement", () => {
  it("resolves an existing archive-only row by its slash-less share id", async () => {
    const db = await makeTestDb();
    const bytes = new Uint8Array([1, 2, 3]);
    await upsertGemArchive(db, { gemKey: "abc123", version: "1", bytes, digest: "d", createdAtMs: 1, ownerAccountId: null });
    // no catalog_gems row => archive-only => resolvable by share id
    expect(await archiveOnlyVersion(db, "abc123")).toBe("1");
    const a = await getGemArchive(db, "abc123", "1");
    expect(a?.digest).toBe("d");
  });
});
```
Run: `npx tsc -b && npx vitest run dist/aggregator/__tests__/gameResolveStillWorks.test.js`
Expected: PASS immediately (resolve path is unchanged) — this is a regression guard, not TDD-red. (If `upsertGemArchive`'s signature differs, adjust to match its actual params — it is the function `shareArchive` used.)

- [ ] **Step 2: Remove the server mint handlers**

In `src/aggregator.controller.ts`, delete the `@post("/share-archive")` `shareArchive` handler and the `@post("/share-archive/revoke")` `revokeShareArchive` handler, plus their now-unused schema consts (`ShareArchiveManifest`, `ShareArchiveBody`, `ShareArchiveResult`, `RevokeShareBody`, `RevokeShareResult`) and any imports (`genShareId`, `staticGate`) that become unused. Leave `getGemArchive`/`upsertGemArchive`/`deleteGemArchiveOwned` and the resolve GETs untouched.

In `src/play.controller.ts`, delete the `@post("/play/share")` `share` and `@post("/play/revoke")` `revoke` handlers, their schemas (`PlayShareRequestSchema` etc.), and imports that become unused (`postShareArchive`, `postShareArchiveRevoke`, `writeMiniappShare`, `readMiniappShare`, `clearMiniappShare`). Leave the rest of the play controller intact.

- [ ] **Step 3: Delete the now-orphaned client**

Confirm `src/gem/shareArchiveClient.ts` has no remaining importers: `grep -rn "shareArchiveClient" src/ packages/`. If clean, delete the file. If something else imports it, leave it and note in the report.

- [ ] **Step 4: Verify**

Run: `npm test` (root `tsc -b && vitest run`)
Expected: clean typecheck (no dangling imports of the removed symbols); full root suite green, including the new resolve-still-works test. Watch for any test that exercised the removed `share-archive`/`play/share` endpoints — delete those tests as part of this task (they test retired behavior).

- [ ] **Step 5: Commit**

```bash
git add -A src/play.controller.ts src/aggregator.controller.ts src/aggregator/__tests__/gameResolveStillWorks.test.ts
git commit -m "refactor: retire quick-share mint (server); keep /games resolve

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 7: end-to-end verification + PR

- [ ] **Step 1: Full gate** — `npm test`, then `cd packages/console && npx vitest run`. Both green.
- [ ] **Step 2: Drive** (verify/run skill): publish a miniapp as **Public** → appears in the Explore list (`GET /api/registry/gems`); publish/one as **Unlisted** → absent from that list but its `/games/<scoped-key>` link resolves (`game-meta`). Confirm the old "Copy share link" button is gone and a previously-minted `/games/<id>` link still resolves.
- [ ] **Step 3: Push + PR** off `origin/main`; title "Publish visibility — Public/Unlisted (PR 2a)". Body: summarize the column, the Explore filter, the scope selector, the quick-share retirement, and note **Private ships in PR 2b**. Reference the spec.
- [ ] **Step 4: Watch CI** (`gh run watch <id> --exit-status`) → `gh pr merge --rebase --delete-branch`. After merge, `git fetch` and grep `origin/main:<file>` for a marker from EVERY commit (the dropped-commit check).

---

## Self-Review

- **Spec coverage (PR 2a slice):** `visibility` column → Task 1; publish threading → Tasks 2-4; Explore filter → Task 2; Public/Unlisted selector → Task 4; retire quick-share (keep resolve) → Tasks 5-6. Private is deliberately deferred to PR 2b (Global Constraints + Architecture say so; the edge enum blocks a fake-private).
- **Type consistency:** `Visibility = "public"|"unlisted"|"private"` defined once (Task 2), used in `CatalogRow`/`CatalogManifest`; publish-edge zod enum is the narrower `["public","unlisted"]` (Tasks 3-4); `publishWorkspace(login, version, visibility)` three-arg form used at all call sites (Task 4).
- **Placeholder scan:** Tasks 3 and 4-Step-4 are schema/UI wiring gated by `tsc -b` + Task 2's storage/filter tests + the StudioShare test; Task 1/2/6 carry real DB tests. The one lookup left to the implementer (`CatalogManifestSchema`'s file) is a bounded grep, not a placeholder.
- **Signing:** visibility rides in the signed manifest; client sends what it signed, server hashes the received manifest — no scheme change. Verified against `catalogSigningPayload`.
- **Deletion safety (Tasks 5-6):** the resolve path is explicitly preserved and guarded by Task 6 Step 1's regression test; only the mint side is removed, so existing `/games/<id>` links keep working.
