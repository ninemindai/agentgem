# Private gem install/download + detail page (PR 2c) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a private gem's owner **download/install** it and view its **detail page** through the marketplace — the two items deferred from PR 2b. A private gem is still owner-only and server-enforced; this adds owner-gated endpoints + a dedicated `/my-apps/<key>` detail view.

**Architecture:** Two new session-gated endpoints under `/api/catalog/` (mirroring PR 2b's `ownerGame*Handler`): `gem-archive` (owner-only archive bytes → download/import) and `gem` (owner-only single-gem metadata → detail page). A new `catalogGemForOwner` aggregator helper. A dedicated marketplace `MyAppDetail` page at `/my-apps/<key>` (owner-only) with the visibility badge, description/contents, **Download .gem** (owner-gated), Play for games (reusing PR 2b's `getOwnerGame*`), and Unpublish. The public `Gem.tsx` (`/gems/:key`) stays public-only and untouched; My apps links every gem (all visibilities) to the new owner detail.

**Tech Stack:** TypeScript (ESM, `.js` specifiers), Drizzle + PGlite, raw-express (session endpoints), better-auth, React + Vite (marketplace), vitest.

## Global Constraints

- **Node ≥ 24, ESM.** Local imports use the `.js` extension in the specifier.
- **New-file header** (aggregator/`src` files, NOT marketplace): `// Copyright (c) 2026 NineMind, Inc.` then `// SPDX-License-Identifier: MIT`. **`packages/marketplace/src` has NO SPDX headers by local convention** — do NOT add them to new marketplace files.
- **Ownership is the `accounts.id` uuid**, resolved server-side via `resolveSession`; the client never sends an account id (`me.id` is display-only).
- **No existence leak**: a non-owner (or anonymous) request to an owner endpoint returns **404** (same body as unknown), never 403.
- **Private gems are NOT CLI-installable** (the `npx agentgem get` path resolves through the public, private-refusing `/api/aggregator/gem-archive`). The detail page's install affordance for a private gem is **Download .gem + import in the desktop app** — do NOT show the `npx get` command for private.
- **Public/Unlisted detail** stays on the existing public `/gems/:key` page (unchanged). Only the owner detail (`/my-apps/<key>`) is new.
- **Test homes / commands:**
  - Aggregator data-layer: `src/aggregator/__tests__/*.test.ts`; session endpoints: `src/__tests__/*.test.ts`; run `npx tsc -b && npx vitest run dist/<path>.test.js`.
  - Marketplace: `packages/marketplace/src/**/*.test.tsx`; run `cd packages/marketplace && npx vitest run <path>`. CI runs marketplace tests.
  - Full gate: `pnpm build && pnpm test` (root — build before tests) AND `cd packages/marketplace && npx vitest run`.
- **Commit trailer** (every commit): `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`
- Work in the worktree `/Users/rfeng/Projects/ninemind/agentgem-worktrees/publish-private-install` on branch `feat/publish-private-install`.

---

### Task 1: `catalogGemForOwner` helper

**Files:**
- Modify: `packages/aggregator/src/catalog.ts`
- Test: `src/aggregator/__tests__/catalogGemForOwner.test.ts`

**Interfaces:**
- Produces: `catalogGemForOwner(db: AppDb, gemKey: string, accountId: string): Promise<CatalogRow | null>` — the latest version of `gemKey` owned by `accountId` (all visibilities), or `null` if the account doesn't own that key. Mirrors `listCatalogGemsForOwner`'s select shape.

- [ ] **Step 1: Write the failing test**

`src/aggregator/__tests__/catalogGemForOwner.test.ts`:
```ts
// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
import { describe, it, expect } from "vitest";
import { makeTestDb, upsertCatalogGem, catalogGemForOwner } from "@agentgem/aggregator";

describe("catalogGemForOwner", () => {
  it("returns the owner's private gem (latest version), with visibility populated", async () => {
    const db = await makeTestDb();
    await upsertCatalogGem(db, { gemKey: "@me/g", version: "0.1.0", publishedBy: "me", createdAtMs: 1, ownerAccountId: "acct-1", visibility: "private" });
    await upsertCatalogGem(db, { gemKey: "@me/g", version: "0.2.0", publishedBy: "me", createdAtMs: 2, ownerAccountId: "acct-1", visibility: "private" });
    const g = await catalogGemForOwner(db, "@me/g", "acct-1");
    expect(g).toMatchObject({ gemKey: "@me/g", version: "0.2.0", visibility: "private", ownerAccountId: "acct-1" });
  });
  it("returns null when the account does not own the key", async () => {
    const db = await makeTestDb();
    await upsertCatalogGem(db, { gemKey: "@me/g", version: "0.1.0", publishedBy: "me", createdAtMs: 1, ownerAccountId: "acct-1", visibility: "private" });
    expect(await catalogGemForOwner(db, "@me/g", "acct-2")).toBeNull();
    expect(await catalogGemForOwner(db, "@me/none", "acct-1")).toBeNull();
  });
});
```
> If `owner_account_id` needs real UUIDs for the FK, seed a real `accounts` row (mirror the sibling tests' `mkAccount` helper) and use its uuid.

- [ ] **Step 2: Run to verify it fails**

Run: `npx tsc -b && npx vitest run dist/aggregator/__tests__/catalogGemForOwner.test.js`
Expected: FAIL — `catalogGemForOwner` not exported.

- [ ] **Step 3: Implement (append to `packages/aggregator/src/catalog.ts`)**

```ts
// Single gem (latest version) owned by accountId, across all visibilities — for the owner's detail page.
// null when the account doesn't own that key.
export async function catalogGemForOwner(db: AppDb, gemKey: string, accountId: string): Promise<CatalogRow | null> {
  const rows = await db.select({
    gemKey: catalogGems.gemKey, version: catalogGems.version, publishedBy: catalogGems.publishedBy,
    author: catalogGems.author, description: catalogGems.description, tags: catalogGems.tags,
    artifactKinds: catalogGems.artifactKinds, type: catalogGems.type, grade: catalogGems.grade,
    artifacts: catalogGems.artifacts, createdAtMs: catalogGems.createdAtMs,
    ownerAccountId: catalogGems.ownerAccountId, visibility: catalogGems.visibility, archiveKey: gemArchives.gemKey,
  }).from(catalogGems)
    .leftJoin(gemArchives, and(eq(catalogGems.gemKey, gemArchives.gemKey), eq(catalogGems.version, gemArchives.version)))
    .where(and(eq(catalogGems.gemKey, gemKey), eq(catalogGems.ownerAccountId, accountId)))
    .orderBy(desc(catalogGems.createdAtMs)).limit(1);
  const r = rows[0];
  if (!r) return null;
  return {
    gemKey: r.gemKey, version: r.version, publishedBy: r.publishedBy,
    author: r.author ?? undefined, description: r.description ?? undefined,
    tags: r.tags ?? undefined, artifactKinds: r.artifactKinds ?? undefined,
    type: r.type ?? undefined, grade: r.grade ?? undefined, artifacts: r.artifacts ?? undefined,
    createdAtMs: r.createdAtMs, ownerAccountId: r.ownerAccountId ?? null,
    visibility: (r.visibility as Visibility) ?? "public", installable: r.archiveKey != null,
  };
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx tsc -b && npx vitest run dist/aggregator/__tests__/catalogGemForOwner.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/aggregator/src/catalog.ts src/aggregator/__tests__/catalogGemForOwner.test.ts
git commit -m "feat(aggregator): catalogGemForOwner single-gem owner reader

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: owner-gated `gem-archive` + `gem` endpoints

**Files:**
- Modify: `src/catalog/install.ts` (add `ownerGemArchiveHandler`, `ownerGemHandler` + register)
- Test: `src/__tests__/catalogOwnerInstall.test.ts`

**Interfaces:**
- Consumes: `getGemArchive`, `gemAccessInfo`, `catalogGemForOwner` (Task 1) from `@agentgem/aggregator`.
- Produces (session-gated, under `/api/catalog/`, 401 if no session, 404 if not owner — no leak):
  - `GET /api/catalog/gem-archive?key&version` → `{ archiveBase64 }` for the owner.
  - `GET /api/catalog/gem?key` → the owner's gem metadata: `{ key, version, publishedBy, description, tags, artifactKinds, artifacts, grade, visibility, installable }`.

- [ ] **Step 1: Write the failing test**

`src/__tests__/catalogOwnerInstall.test.ts` — mirror `src/__tests__/catalogOwnerEndpoints.test.ts` (the PR 2b file) for the `withSession`/`mockRes`/`req`/`deps` scaffolding (read it first, copy verbatim). Cover:
```
// gem-archive: 401 no session; 404 for a session that isn't the owner; 200 { archiveBase64 } for the owner.
// gem: 401 no session; 404 for non-owner; 200 with the metadata shape for the owner (assert visibility + installable).
```
Seed a private gem + its `gem_archives` bytes owned by the session's `user.id` (via `mintSession`/`withSession` + `upsertCatalogGem`/`upsertGemArchive`).

- [ ] **Step 2: Run to verify it fails**

Run: `npx tsc -b && npx vitest run dist/__tests__/catalogOwnerInstall.test.js`
Expected: FAIL — handlers not exported / routes not registered.

- [ ] **Step 3: Implement in `src/catalog/install.ts`**

Add `catalogGemForOwner` to the `@agentgem/aggregator` import. Add two handlers mirroring `ownerGameHtmlHandler`'s shape (cors → OPTIONS-preflight → 401 → owner check → serve):
```ts
export function ownerGemArchiveHandler(deps: CatalogDeps) {
  return async (req: Req, res: Res): Promise<void> => {
    cors(req, res, deps.webOrigins);
    if (req.method === "OPTIONS") { preflight(res); return; }
    const accountId = await sessionAccountId(deps, req);
    if (!accountId) { res.status(401).json({ error: "sign in required" }); return; }
    const key = String((req.query.key as string | undefined) ?? "");
    const version = String((req.query.version as string | undefined) ?? "");
    if (!key || !version) { res.status(404).json({ error: "gem not found" }); return; }
    const info = await gemAccessInfo(deps.db, key, version);
    if (!info || info.ownerAccountId !== accountId) { res.status(404).json({ error: "gem not found" }); return; }
    const a = await getGemArchive(deps.db, key, version);
    if (!a) { res.status(404).json({ error: "gem not found" }); return; }
    res.json({ archiveBase64: Buffer.from(a.bytes).toString("base64") });
  };
}
export function ownerGemHandler(deps: CatalogDeps) {
  return async (req: Req, res: Res): Promise<void> => {
    cors(req, res, deps.webOrigins);
    if (req.method === "OPTIONS") { preflight(res); return; }
    const accountId = await sessionAccountId(deps, req);
    if (!accountId) { res.status(401).json({ error: "sign in required" }); return; }
    const key = String((req.query.key as string | undefined) ?? "");
    if (!key) { res.status(404).json({ error: "gem not found" }); return; }
    const g = await catalogGemForOwner(deps.db, key, accountId);
    if (!g) { res.status(404).json({ error: "gem not found" }); return; }
    res.json({
      key: g.gemKey, version: g.version, publishedBy: g.publishedBy, description: g.description ?? "",
      tags: g.tags ?? [], artifactKinds: g.artifactKinds ?? [], artifacts: g.artifacts ?? [],
      grade: g.grade ?? null, visibility: g.visibility ?? "public", installable: g.installable ?? false,
    });
  };
}
```
Register in `installCatalog`:
```ts
  for (const p of ["/api/catalog/gem-archive"]) { expressApp.get(p, ownerGemArchiveHandler(deps)); expressApp.options(p, ownerGemArchiveHandler(deps)); }
  for (const p of ["/api/catalog/gem-detail"]) { expressApp.get(p, ownerGemHandler(deps)); expressApp.options(p, ownerGemHandler(deps)); }
```
> **Path note:** use `/api/catalog/gem-detail` for the metadata endpoint — NOT `/api/catalog/gem`, which already exists as the DELETE unpublish route. A GET on the same path would be a separate method, but a distinct path is clearer and avoids handler confusion. `Buffer` is already used in this file (via the game handlers), so it's imported/available.

- [ ] **Step 4: Run to verify it passes**

Run: `npx tsc -b && npx vitest run dist/__tests__/catalogOwnerInstall.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/catalog/install.ts src/__tests__/catalogOwnerInstall.test.ts
git commit -m "feat: owner-gated gem-archive + gem-detail endpoints (private install)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 3: marketplace api methods

**Files:**
- Modify: `packages/marketplace/src/api.ts`
- Test: extend an existing api test if present, else covered via Task 4's page tests.

**Interfaces:**
- Produces (credentialed, `credentials: "include"`, mirroring `getMyGems`/`getOwnerGameMeta`):
  - `getMyGem(key: string): Promise<MyGemDetail>` → GET `/api/catalog/gem-detail?key=`.
  - `getOwnerGemArchive(key: string, version: string): Promise<string>` → GET `/api/catalog/gem-archive?key&version`, returns the base64 string.
  - A `MyGemDetail` type `{ key, version, publishedBy, description, tags, artifactKinds, artifacts, grade, visibility, installable }`.

- [ ] **Step 1: Add the methods**

Mirror the existing `getOwnerGameMeta` / `getMyGems` (they use `getCred<T>` with `credentials:"include"`). Add:
```ts
    getMyGem: (key: string) => getCred<MyGemDetail>(base, "/api/catalog/gem-detail", { key }),
    getOwnerGemArchive: (key: string, version: string) =>
      getCred<{ archiveBase64: string }>(base, "/api/catalog/gem-archive", { key, version }).then((r) => r.archiveBase64),
```
Add the `MyGemDetail` type near `MyGem`. (`getCred` and `MyGem` already exist from PR 2b.)

- [ ] **Step 2: Typecheck**

Run: `cd packages/marketplace && npx tsc -b` (or the marketplace's typecheck script) — clean. Behavior is exercised by Task 4's page tests.

- [ ] **Step 3: Commit**

```bash
git add packages/marketplace/src/api.ts
git commit -m "feat(marketplace): getMyGem + getOwnerGemArchive api methods

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 4: `MyAppDetail` page + route + My apps links

**Files:**
- Create: `packages/marketplace/src/pages/MyAppDetail.tsx`
- Modify: `packages/marketplace/src/Router.tsx` (add `/my-apps/<key>` route)
- Modify: `packages/marketplace/src/pages/MyApps.tsx` (Details link for ALL visibilities → the owner detail)
- Test: `packages/marketplace/src/pages/MyAppDetail.test.tsx`; update `Router.conformance.test.tsx` if needed.

**Interfaces:**
- Consumes: `getMyGem`, `getOwnerGemArchive` (Task 3), `getOwnerGameMeta`/`getOwnerGameHtml` (PR 2b), `unpublishGem` (existing), `GamePlayer`, `GemContents` (read how `Gem.tsx` uses them).

- [ ] **Step 1: Build `MyAppDetail`**

`MyAppDetail.tsx` (read `MyApps.tsx` + `Gem.tsx` first and mirror their idioms). Props `{ api, me, keyName }`. Behavior:
- Gate on `!me` → sign-in prompt (mirror MyApps).
- Fetch `api.getMyGem(keyName)`; loading / not-found / error states. (404 → "not found or not yours".)
- Render: title (`keyName`), a **visibility badge** (Public/Unlisted/Private, reuse MyApps' badge classes), description, `<GemContents artifacts={gem.artifacts ?? []} />`.
- **Download .gem** button → `getOwnerGemArchive(gem.key, gem.version)` → base64 → Blob → download (copy the `downloadGem` blob logic from `Gem.tsx:70-84`). Show the "import it in AgentGem → Get Gems → Import a .gem file" hint. Do NOT show the `npx get` command (private isn't CLI-installable).
- **Play** (if `artifactKinds` includes `"game"`): resolve via `getOwnerGameMeta`/`getOwnerGameHtml` (the PR 2b owner path, same as MyApps `playPrivate`) → `<GamePlayer html interactive />`.
- **Unpublish**: `api.unpublishGem(gem.key, gem.version)` (copy the confirm + error handling from `Gem.tsx:92-103`), navigate to `/my-apps` on success.

- [ ] **Step 2: Route + My apps links**

In `Router.tsx`, add a route matching `/my-apps/<key>` (greedy splat like the games/gems detail routes) rendering `<MyAppDetail api={c.api} me={c.me} keyName={decodeURIComponent(m[1])} />`. Keep the existing `/my-apps` panel route; order the detail route so `/my-apps/<key>` matches before/independently of `/my-apps`. Ensure `Router.conformance.test.tsx` still passes (it enumerates routes generically; add the new id to any required list if the test needs it).

In `MyApps.tsx`, change the per-gem "Details" link so it renders for **all** visibilities and points at the owner detail: `<a href={"/my-apps/" + encodeURIComponent(g.key)}>Details</a>` (replacing the `g.visibility === "public"` → `/gems/` link). Public/unlisted gems can still keep their `/gems/` or `/games/` links too if desired, but Details now goes to the owner detail for every gem.

- [ ] **Step 3: Tests**

`MyAppDetail.test.tsx`: mock `api.getMyGem` → a private gem; assert badge + description + Download button render; mock `getOwnerGemArchive` and assert clicking Download calls it; assert sign-in prompt when `me` null; assert not-found state when `getMyGem` rejects. Update `MyApps.test.tsx` if it asserted the old `/gems/` Details link. Update `Router.conformance.test.tsx` if required.

- [ ] **Step 4: Verify**

Run: `cd packages/marketplace && npx vitest run` (whole marketplace suite green incl. conformance) AND `npx tsc -b` (root).

- [ ] **Step 5: Commit**

```bash
git add packages/marketplace/src/pages/MyAppDetail.tsx packages/marketplace/src/Router.tsx packages/marketplace/src/pages/MyApps.tsx packages/marketplace/src/pages/MyAppDetail.test.tsx packages/marketplace/src/pages/MyApps.test.tsx packages/marketplace/src/Router.conformance.test.tsx
git commit -m "feat(marketplace): private gem detail page (download, play, unpublish)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 5: end-to-end verification + PR

- [ ] **Step 1: Full gate** — `pnpm build` then `pnpm test` (root); `cd packages/marketplace && npx vitest run`. All green.
- [ ] **Step 2: Drive** (verify/run skill): publish a private miniapp; in My apps, open its **Details** (`/my-apps/<key>`); confirm the visibility badge, that **Download .gem** works (owner-gated), that a private **game plays**, and Unpublish works. Confirm a non-owner session and anonymous both get 404 from `/api/catalog/gem-archive` and `/api/catalog/gem-detail` (the public `/gems/:key` page still can't see private).
- [ ] **Step 3: Push + PR** off `origin/main`; title "Private gem install/download + detail page (PR 2c)". Body: owner-gated gem-archive + gem-detail endpoints, `/my-apps/<key>` detail page (download/play/unpublish), private isn't CLI-installable (download+import).
- [ ] **Step 4: Watch CI** (`gh run watch <id> --exit-status`; confirm the check shows `pass`, rerun the flaky `coldBuildWorker` timing test if it trips) → `gh pr merge --rebase --delete-branch`. After merge, `git fetch` + grep `origin/main:<file>` for a marker from EVERY commit.

---

## Self-Review

- **Coverage:** deferred item "owner install/download of private" → Tasks 2 (gem-archive endpoint) + 4 (Download .gem); "private detail page" → Tasks 1+2 (gem-detail endpoint + helper) + 4 (MyAppDetail). api glue → Task 3.
- **No-leak preserved:** both new owner endpoints 404 non-owner (same body); the public `/gems/:key` and `/api/aggregator/gem-archive` stay private-refusing (untouched).
- **Type consistency:** `catalogGemForOwner` returns `CatalogRow | null` (Task 1) consumed by `ownerGemHandler` (Task 2); `MyGemDetail` shape matches the `gem-detail` endpoint's JSON (Tasks 2/3); `getOwnerGemArchive` returns the base64 string (Tasks 3/4).
- **Convention:** marketplace files get NO SPDX header (per-package convention, confirmed in PR 2b); aggregator/`src` files do.
- **Path collision avoided:** metadata endpoint is `/api/catalog/gem-detail`, distinct from the existing `/api/catalog/gem` DELETE.
- **Scope discipline:** the public `Gem.tsx` is untouched — private-owner concerns live entirely in the new `MyAppDetail`, mirroring how PR 2b kept private-play in My apps.
