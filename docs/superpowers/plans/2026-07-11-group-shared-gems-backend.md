# Group-shared gems — Backend Implementation Plan (Plan 1 of 2)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give native groups a payload — an owner can share a private gem with a group, and members gain access — by adding a `gem_group_shares` ACL, a single `accountCanAccessGem` gate, owner-gated share-management endpoints, and a member-gated discovery endpoint.

**Architecture:** Additive ACL. A gem stays `visibility='private'`; a new `gem_group_shares(gem_key, group_id)` table widens access. One helper `accountCanAccessGem(db, gemKey, version, accountId)` = `public/unlisted` OR owner OR member-of-a-shared-group. The existing owner-gated resolve endpoints are generalized to route through it. Sharing is per `gem_key` (all versions inherit).

**Tech Stack:** TypeScript (ESM, `.js` import specifiers), Drizzle ORM over Postgres (PGlite in tests), raw Express handlers, Vitest. Spec: `docs/superpowers/specs/2026-07-11-group-shared-gems-design.md`.

## Global Constraints

- ESM only: every relative import ends in `.js` (e.g. `import { x } from "./catalog.js"`), even for `.ts` sources.
- Store code lives in `packages/aggregator/src/*.ts` and MUST be re-exported from `packages/aggregator/src/index.ts` (the `@agentgem/aggregator` barrel) — tests import only from `@agentgem/aggregator`.
- Tests are authored in `src/**/__tests__/*.test.ts` (repo ROOT `src`, not the package). Vitest runs the COMPILED output: `vitest include = dist/**/__tests__/**/*.test.js`. The `pnpm test` script is `tsc -b && vitest run`, so it compiles first. Run a single file with its **dist** path: `pnpm test dist/<area>/__tests__/<name>.test.js`.
- Ownership is ALWAYS the `accounts.id` uuid, never the `published_by` login string.
- No-leak rule: a caller without access gets the SAME `404` as a missing gem — never a `403` that confirms existence (except the documented group-role `403`, which only fires for a caller who is already a member).
- License header on every new source file:
  ```
  // Copyright (c) 2026 NineMind, Inc.
  // SPDX-License-Identifier: MIT
  ```
- `Date.now()` is the timestamp source in app code (pass an overridable `now` param, mirroring `recordCatalogShare`).
- Commit message trailer on every commit: `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`

---

## Task 0: Worktree bootstrap (once)

**Files:** none (environment only).

- [ ] **Step 1: Install and build the worktree**

This is a fresh worktree; sibling package `dist/` output does not exist yet, so tests cannot run until everything is built once.

Run:
```bash
cd ../agentgem-worktrees/group-shared-gems
pnpm install
pnpm build
```
Expected: `tsc -b` completes with no errors; `dist/` populated across packages and root.

- [ ] **Step 2: Baseline the test suite**

Run: `pnpm test`
Expected: the full suite PASSES (this is the pre-change baseline — if anything fails here, stop and report; it is not your change).

---

## Task 1: `gem_group_shares` schema + `accountCanAccessGem` + share store

**Files:**
- Modify: `packages/aggregator/src/schema.ts` (add table def near line 280 after `groupInvites`; add to `schema` object at line 463; add DDL inside `ensureSchema` after the `group_invites` create at ~line 680)
- Create: `packages/aggregator/src/gemShares.ts`
- Modify: `packages/aggregator/src/index.ts` (add `export * from "./gemShares.js";`)
- Test: `src/aggregator/__tests__/gemShares.test.ts`

**Interfaces:**
- Consumes: `gemAccessInfo(db, gemKey, version)` from `./catalog.js` (returns `{ visibility, ownerAccountId } | null`); `upsertAccount`, `upsertCatalogGem`, `createNativeGroup`, `grantInvite`, `makeTestDb` from `@agentgem/aggregator`.
- Produces (all exported from the barrel):
  - `shareGemWithGroup(db: AppDb, gemKey: string, groupId: string, createdBy: string, now?: number): Promise<void>` — idempotent insert.
  - `unshareGemFromGroup(db: AppDb, gemKey: string, groupId: string): Promise<boolean>` — true iff a row was removed.
  - `listGroupsForGem(db: AppDb, gemKey: string): Promise<{ groupId: string; name: string }[]>`
  - `accountCanAccessGem(db: AppDb, gemKey: string, version: string, accountId: string | null): Promise<boolean>`
  - `gemGroupShares` (Drizzle table).

- [ ] **Step 1: Add the Drizzle table + schema-object entry + DDL**

In `packages/aggregator/src/schema.ts`, add after the `groupInvites` table definition (after line ~275):

```ts
// Additive ACL: which groups a private gem (by key, all versions) is shared with. A member of any
// listed group may access the gem's private versions (see accountCanAccessGem). Group deletion
// cascades these rows; gem deletion cleans them via deleteCatalogGem.
export const gemGroupShares = pgTable("gem_group_shares", {
  gemKey: text("gem_key").notNull(),
  groupId: uuid("group_id").notNull().references(() => groups.id, { onDelete: "cascade" }),
  createdBy: uuid("created_by").notNull().references(() => accounts.id),
  createdAtMs: bigint("created_at_ms", { mode: "number" }).notNull(),
}, (t) => [primaryKey({ columns: [t.gemKey, t.groupId] })]);
```

Add `gemGroupShares` to the exported `schema` object (line 463) — append it to the list:

```ts
export const schema = { producers, /* …unchanged… */ groups, groupMembers, groupInvites, gemGroupShares, reviewRequests, reviewMessages, reviewSeen, user, session, account, verification, pendingAccountLinks, connectStates };
```

Inside `ensureSchema`, immediately after the `create table if not exists group_invites (...)` statement (~line 680), add:

```ts
  await db.execute(sql`create table if not exists gem_group_shares (
    gem_key text not null,
    group_id uuid not null references groups(id) on delete cascade,
    created_by uuid not null references accounts(id),
    created_at_ms bigint not null,
    primary key (gem_key, group_id)
  )`);
```

- [ ] **Step 2: Create the store module**

Create `packages/aggregator/src/gemShares.ts`:

```ts
// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
// gem_group_shares store: the additive ACL that gives native groups a payload. Sharing keys on
// gem_key (the app identity) — every private version of the gem inherits the share. Access is
// decided by accountCanAccessGem, the single gate every private-serving reader routes through.
import { and, eq, sql } from "drizzle-orm";
import type { AppDb } from "./schema.js";
import { gemGroupShares, groups } from "./schema.js";
import { gemAccessInfo } from "./catalog.js";

/** Share a gem (by key) with a group. Idempotent — re-sharing is a no-op. */
export async function shareGemWithGroup(
  db: AppDb, gemKey: string, groupId: string, createdBy: string, now: number = Date.now(),
): Promise<void> {
  await db.insert(gemGroupShares)
    .values({ gemKey, groupId, createdBy, createdAtMs: now })
    .onConflictDoNothing();
}

/** Remove a share. True iff a row was actually removed. */
export async function unshareGemFromGroup(db: AppDb, gemKey: string, groupId: string): Promise<boolean> {
  const removed = await db.delete(gemGroupShares)
    .where(and(eq(gemGroupShares.gemKey, gemKey), eq(gemGroupShares.groupId, groupId)))
    .returning({ groupId: gemGroupShares.groupId });
  return removed.length > 0;
}

/** Groups a gem is shared with, with names — for the owner's share panel. */
export async function listGroupsForGem(db: AppDb, gemKey: string): Promise<{ groupId: string; name: string }[]> {
  const rows = await db.select({ groupId: gemGroupShares.groupId, name: groups.name })
    .from(gemGroupShares)
    .innerJoin(groups, eq(gemGroupShares.groupId, groups.id))
    .where(eq(gemGroupShares.gemKey, gemKey));
  return rows.map((r) => ({ groupId: r.groupId, name: r.name }));
}

/** The single access gate. Public/unlisted (or no catalog row) → anyone. Private → owner, or a
 *  member of any group the gem is shared with. A null accountId (signed out) never clears private. */
export async function accountCanAccessGem(
  db: AppDb, gemKey: string, version: string, accountId: string | null,
): Promise<boolean> {
  const info = await gemAccessInfo(db, gemKey, version);
  if (!info) return true;                          // no catalog row: unlisted archive / unknown — not private
  if (info.visibility !== "private") return true;  // public + unlisted stay open
  if (!accountId) return false;
  if (info.ownerAccountId === accountId) return true;
  const shared = (await db.execute(sql`
    select 1 from gem_group_shares s
    join group_members m on m.group_id = s.group_id
    where s.gem_key = ${gemKey} and m.account_id = ${accountId}
    limit 1`)).rows;
  return shared.length > 0;
}
```

- [ ] **Step 3: Export from the barrel**

In `packages/aggregator/src/index.ts`, add after the `export * from "./groupInvites.js";` line:

```ts
export * from "./gemShares.js";
```

- [ ] **Step 4: Write the failing test**

Create `src/aggregator/__tests__/gemShares.test.ts`:

```ts
// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
import { describe, it, expect } from "vitest";
import {
  makeTestDb, upsertAccount, upsertCatalogGem, createNativeGroup, grantInvite,
  shareGemWithGroup, unshareGemFromGroup, listGroupsForGem, accountCanAccessGem,
} from "@agentgem/aggregator";

const acct = (db: any, n: string) => upsertAccount(db, { provider: "github", accountId: n, login: n });
const privateGem = (db: any, key: string, ownerId: string) =>
  upsertCatalogGem(db, { gemKey: key, version: "1.0.0", publishedBy: "owner", ownerAccountId: ownerId, createdAtMs: 1, visibility: "private" });

describe("gem shares store", () => {
  it("accountCanAccessGem: public and unlisted are open to anyone, even signed out", async () => {
    const db = await makeTestDb();
    const owner = await acct(db, "owner");
    await upsertCatalogGem(db, { gemKey: "o/pub", version: "1.0.0", publishedBy: "owner", ownerAccountId: owner.id, createdAtMs: 1, visibility: "public" });
    await upsertCatalogGem(db, { gemKey: "o/unl", version: "1.0.0", publishedBy: "owner", ownerAccountId: owner.id, createdAtMs: 1, visibility: "unlisted" });
    expect(await accountCanAccessGem(db, "o/pub", "1.0.0", null)).toBe(true);
    expect(await accountCanAccessGem(db, "o/unl", "1.0.0", null)).toBe(true);
  });

  it("accountCanAccessGem: no catalog row (unknown / unlisted-archive) is not private", async () => {
    const db = await makeTestDb();
    expect(await accountCanAccessGem(db, "ghost/x", "9.9.9", null)).toBe(true);
  });

  it("accountCanAccessGem: private is owner-only until shared", async () => {
    const db = await makeTestDb();
    const owner = await acct(db, "owner");
    const stranger = await acct(db, "stranger");
    await privateGem(db, "o/secret", owner.id);
    expect(await accountCanAccessGem(db, "o/secret", "1.0.0", owner.id)).toBe(true);
    expect(await accountCanAccessGem(db, "o/secret", "1.0.0", stranger.id)).toBe(false);
    expect(await accountCanAccessGem(db, "o/secret", "1.0.0", null)).toBe(false);
  });

  it("accountCanAccessGem: a member of a shared group gains access; a non-member does not", async () => {
    const db = await makeTestDb();
    const owner = await acct(db, "owner");
    const member = await acct(db, "member");
    const outsider = await acct(db, "outsider");
    await privateGem(db, "o/secret", owner.id);
    const g = await createNativeGroup(db, owner.id, "Team");
    await grantInvite(db, g.id, member.id, "member");
    await shareGemWithGroup(db, "o/secret", g.id, owner.id);
    expect(await accountCanAccessGem(db, "o/secret", "1.0.0", member.id)).toBe(true);
    expect(await accountCanAccessGem(db, "o/secret", "1.0.0", outsider.id)).toBe(false);
  });

  it("accountCanAccessGem: membership in an UNSHARED group grants nothing", async () => {
    const db = await makeTestDb();
    const owner = await acct(db, "owner");
    const member = await acct(db, "member");
    await privateGem(db, "o/secret", owner.id);
    const shared = await createNativeGroup(db, owner.id, "Shared");
    const other = await createNativeGroup(db, owner.id, "Other");
    await grantInvite(db, other.id, member.id, "member");   // member is in Other, not Shared
    await shareGemWithGroup(db, "o/secret", shared.id, owner.id);
    expect(await accountCanAccessGem(db, "o/secret", "1.0.0", member.id)).toBe(false);
  });

  it("shareGemWithGroup is idempotent; listGroupsForGem returns names; unshare removes", async () => {
    const db = await makeTestDb();
    const owner = await acct(db, "owner");
    await privateGem(db, "o/secret", owner.id);
    const g = await createNativeGroup(db, owner.id, "Team");
    await shareGemWithGroup(db, "o/secret", g.id, owner.id);
    await shareGemWithGroup(db, "o/secret", g.id, owner.id);   // no throw, no dup
    expect(await listGroupsForGem(db, "o/secret")).toEqual([{ groupId: g.id, name: "Team" }]);
    expect(await unshareGemFromGroup(db, "o/secret", g.id)).toBe(true);
    expect(await unshareGemFromGroup(db, "o/secret", g.id)).toBe(false);
    expect(await listGroupsForGem(db, "o/secret")).toEqual([]);
  });

  it("deleting a shared group cascades its shares away", async () => {
    const db = await makeTestDb();
    const owner = await acct(db, "owner");
    await privateGem(db, "o/secret", owner.id);
    const g = await createNativeGroup(db, owner.id, "Team");
    await shareGemWithGroup(db, "o/secret", g.id, owner.id);
    const { sql } = await import("drizzle-orm");
    await db.execute(sql`delete from groups where id = ${g.id}`);
    expect(await listGroupsForGem(db, "o/secret")).toEqual([]);
  });
});
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `pnpm test dist/aggregator/__tests__/gemShares.test.js`
Expected: `tsc -b` compiles cleanly, then all 7 tests PASS. (If `tsc -b` errors with "has no exported member", the barrel export in Step 3 or a table export in Step 1 is missing — fix and re-run.)

- [ ] **Step 6: Commit**

```bash
git add packages/aggregator/src/schema.ts packages/aggregator/src/gemShares.ts packages/aggregator/src/index.ts src/aggregator/__tests__/gemShares.test.ts
git commit -m "feat(aggregator): gem_group_shares ACL + accountCanAccessGem gate

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 2: Clean up shares when a gem is fully unpublished

**Files:**
- Modify: `packages/aggregator/src/catalog.ts` (`deleteCatalogGem`, ~line 122-134)
- Test: `src/aggregator/__tests__/gemShares.test.ts` (append one test)

**Interfaces:**
- Consumes: `gemGroupShares` table (Task 1).
- Produces: no new export; `deleteCatalogGem` now also deletes `gem_group_shares` rows for a key when its LAST version is removed.

Group deletion already cascades shares (FK). This closes the other end: a gem whose every version is unpublished should not leave dangling shares that a share panel or discovery listing would show.

- [ ] **Step 1: Write the failing test (append to the existing file)**

Append inside the `describe("gem shares store", ...)` block in `src/aggregator/__tests__/gemShares.test.ts`:

```ts
  it("unpublishing a gem's last version removes its shares", async () => {
    const db = await makeTestDb();
    const { deleteCatalogGem } = await import("@agentgem/aggregator");
    const owner = await acct(db, "owner");
    await privateGem(db, "o/secret", owner.id);
    const g = await createNativeGroup(db, owner.id, "Team");
    await shareGemWithGroup(db, "o/secret", g.id, owner.id);
    expect(await deleteCatalogGem(db, "o/secret", "1.0.0", owner.id)).toBe("deleted");
    expect(await listGroupsForGem(db, "o/secret")).toEqual([]);
  });
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm test dist/aggregator/__tests__/gemShares.test.js`
Expected: the new test FAILS — `listGroupsForGem` still returns `[{ groupId, name: "Team" }]` because the share was not cleaned up.

- [ ] **Step 3: Implement the cleanup**

In `packages/aggregator/src/catalog.ts`, add `gemGroupShares` to the schema import (line 9):

```ts
import { catalogGems, gemArchives, producers, accountBindings, gemGroupShares } from "./schema.js";
```

In `deleteCatalogGem`, inside the transaction, after the two existing `tx.delete(...)` calls and before `return "deleted";`, add:

```ts
    // If that was the key's last catalog row, drop its group shares too (a share to a gem that no
    // longer exists would otherwise linger in the owner's share panel and group discovery listings).
    const remaining = (await tx.select({ gemKey: catalogGems.gemKey }).from(catalogGems)
      .where(eq(catalogGems.gemKey, gemKey)).limit(1))[0];
    if (!remaining) await tx.delete(gemGroupShares).where(eq(gemGroupShares.gemKey, gemKey));
```

- [ ] **Step 4: Run to verify it passes**

Run: `pnpm test dist/aggregator/__tests__/gemShares.test.js`
Expected: all 8 tests PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/aggregator/src/catalog.ts src/aggregator/__tests__/gemShares.test.ts
git commit -m "feat(aggregator): drop gem shares when a gem's last version is unpublished

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 3: Generalize the owner resolve endpoints to `accountCanAccessGem`

**Files:**
- Modify: `packages/aggregator/src/catalog.ts` (add `catalogGemForViewer`, mirroring `catalogGemForOwner` at ~line 316)
- Modify: `src/catalog/install.ts` (import + 4 handlers: `ownerGameMetaHandler`, `ownerGameHtmlHandler`, `ownerGemArchiveHandler`, `ownerGemHandler`)
- Test: `src/catalog/__tests__/sharedResolve.test.ts`

**Interfaces:**
- Consumes: `accountCanAccessGem` (Task 1), `gemAccessInfo`, `latestGemVersion`, `getGemArchive`.
- Produces: `catalogGemForViewer(db: AppDb, gemKey: string, accountId: string): Promise<CatalogRow | null>` — the latest row for a key IF `accountCanAccessGem` passes for `accountId`, else null.

These endpoints are currently owner-only (`info.ownerAccountId !== accountId → 404`). Generalizing the check to `accountCanAccessGem` lets a shared-group member resolve/install a private gem while preserving the no-leak `404` for everyone else. Owner remains a subset, so existing owner behavior is unchanged.

- [ ] **Step 1: Write the failing test**

Create `src/catalog/__tests__/sharedResolve.test.ts`. It drives the handlers with a fake `req`/`res` (matching the repo's handler test style) and a real PGlite db + a real session cookie.

First inspect an existing route test for the exact session-cookie helper used with these handlers:

Run: `grep -rn "resolveSession\|sessionCookie\|makeAuth\|authedReq\|cookie" src/catalog/__tests__ src/groups/__tests__ | head`

Use whatever helper those tests use to mint an authenticated request for a given account (commonly a `makeAuth(db)` plus a signed session cookie helper from `packages/aggregator/src/auth/testCookie.ts`). Then:

```ts
// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
import { describe, it, expect } from "vitest";
import { makeTestDb, upsertAccount, upsertCatalogGem, upsertGemArchive, createNativeGroup, grantInvite, shareGemWithGroup, makeAuth } from "@agentgem/aggregator";
import { ownerGemArchiveHandler } from "../install.js";
// import the SAME authed-request helper the neighbouring tests use (found via the grep above)

// A minimal fake Res that records status + json body.
function fakeRes() {
  const out: { code: number; body: any } = { code: 200, body: undefined };
  const res: any = {
    status(c: number) { out.code = c; return res; },
    set() { return res; },
    json(b: unknown) { out.body = b; return res; },
    send(b: unknown) { out.body = b; return res; },
  };
  return { res, out };
}

describe("shared-gem resolve (access-gated, no-leak 404)", () => {
  it("a shared-group member can download a private gem; a stranger gets 404", async () => {
    const db = await makeTestDb();
    const auth = makeAuth(db);
    const owner = await upsertAccount(db, { provider: "github", accountId: "owner", login: "owner" });
    const member = await upsertAccount(db, { provider: "github", accountId: "member", login: "member" });
    const stranger = await upsertAccount(db, { provider: "github", accountId: "stranger", login: "stranger" });
    await upsertCatalogGem(db, { gemKey: "o/secret", version: "1.0.0", publishedBy: "owner", ownerAccountId: owner.id, createdAtMs: 1, visibility: "private" });
    await upsertGemArchive(db, { gemKey: "o/secret", version: "1.0.0", bytes: new Uint8Array([1, 2, 3]), digest: "d", createdAtMs: 1, ownerAccountId: owner.id });
    const g = await createNativeGroup(db, owner.id, "Team");
    await grantInvite(db, g.id, member.id, "member");
    await shareGemWithGroup(db, "o/secret", g.id, owner.id);

    const deps = { db, auth, webOrigins: ["https://app.agentgem.ai"] };
    const handler = ownerGemArchiveHandler(deps);

    // member: 200 with bytes  (replace authedReq(...) with the real helper)
    const m = fakeRes();
    await handler(authedReq(member.id, { key: "o/secret", version: "1.0.0" }) as any, m.res);
    expect(m.out.code).toBe(200);
    expect(m.out.body.archiveBase64).toBe(Buffer.from([1, 2, 3]).toString("base64"));

    // stranger: 404, no leak
    const s = fakeRes();
    await handler(authedReq(stranger.id, { key: "o/secret", version: "1.0.0" }) as any, s.res);
    expect(s.out.code).toBe(404);
  });
});
```

> Note for the implementer: if `makeAuth` + a cookie helper is awkward to drive here, follow EXACTLY the harness the existing `src/catalog/__tests__` or `src/groups/__tests__/install.test.ts` uses to build an authenticated `req` — do not invent a new one. The assertions (member→200, stranger→404) stay the same.

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm test dist/catalog/__tests__/sharedResolve.test.js`
Expected: FAIL — the member currently gets `404` because the handler still checks `info.ownerAccountId !== accountId`.

- [ ] **Step 3: Add `catalogGemForViewer` to `catalog.ts`**

In `packages/aggregator/src/catalog.ts`, add the `gemShares` gate import at the top is NOT needed (avoid a cycle: `gemShares.ts` imports `catalog.ts`). Instead inline the same query. Add this function right after `catalogGemForOwner` (~line 337):

```ts
// Latest version of a gem visible to `accountId` under the access rules (owner OR shared-group
// member OR non-private). Returns null when the account has no access — the caller 404s with no leak.
export async function catalogGemForViewer(db: AppDb, gemKey: string, accountId: string): Promise<CatalogRow | null> {
  const version = await latestGemVersion(db, gemKey);
  if (!version) return null;
  const info = await gemAccessInfo(db, gemKey, version);
  if (!info) return null;
  const allowed = info.visibility !== "private"
    || info.ownerAccountId === accountId
    || ((await db.execute(sql`
        select 1 from gem_group_shares s join group_members m on m.group_id = s.group_id
        where s.gem_key = ${gemKey} and m.account_id = ${accountId} limit 1`)).rows.length > 0);
  if (!allowed) return null;
  return catalogGemForOwnerless(db, gemKey, version);
}

// The row for (gemKey, version) with no owner filter (the viewer path has already authorized access).
async function catalogGemForOwnerless(db: AppDb, gemKey: string, version: string): Promise<CatalogRow | null> {
  const rows = await db.select({
    gemKey: catalogGems.gemKey, version: catalogGems.version, publishedBy: catalogGems.publishedBy,
    author: catalogGems.author, description: catalogGems.description, tags: catalogGems.tags,
    artifactKinds: catalogGems.artifactKinds, type: catalogGems.type, grade: catalogGems.grade,
    artifacts: catalogGems.artifacts, createdAtMs: catalogGems.createdAtMs,
    ownerAccountId: catalogGems.ownerAccountId, visibility: catalogGems.visibility, archiveKey: gemArchives.gemKey,
  }).from(catalogGems)
    .leftJoin(gemArchives, and(eq(catalogGems.gemKey, gemArchives.gemKey), eq(catalogGems.version, gemArchives.version)))
    .where(and(eq(catalogGems.gemKey, gemKey), eq(catalogGems.version, version))).limit(1);
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

`sql` is already imported in `catalog.ts` (line 5).

- [ ] **Step 4: Rewire the four handlers in `src/catalog/install.ts`**

Update the import on line 10 to add `accountCanAccessGem` and `catalogGemForViewer`:

```ts
import { resolveSession, deleteCatalogGem, listCatalogGemsForOwner, gemAccessInfo, latestGemVersion, getGemArchive, catalogGemForOwner, catalogGemForViewer, accountCanAccessGem } from "@agentgem/aggregator";
```

In `ownerGameMetaHandler`, `ownerGameHtmlHandler`, and `ownerGemArchiveHandler`, replace the line:

```ts
    const info = await gemAccessInfo(deps.db, key, version);
    if (!info || info.ownerAccountId !== accountId) { res.status(404).json({ error: "gem not found" }); return; }
```

with:

```ts
    if (!(await accountCanAccessGem(deps.db, key, version, accountId))) { res.status(404).json({ error: "gem not found" }); return; }
```

(`gemAccessInfo` may become unused in this file — if so, remove it from the import to keep the lint clean. `latestGemVersion`/`getGemArchive` stay.)

In `ownerGemHandler`, replace:

```ts
    const g = await catalogGemForOwner(deps.db, key, accountId);
```

with:

```ts
    const g = await catalogGemForViewer(deps.db, key, accountId);
```

(`catalogGemForOwner` may now be unused here — remove from the import if so.)

- [ ] **Step 5: Run to verify it passes**

Run: `pnpm test dist/catalog/__tests__/sharedResolve.test.js`
Expected: PASS (member→200, stranger→404).

- [ ] **Step 6: Run the catalog regression tests (owner path unchanged)**

Run: `pnpm test dist/aggregator/__tests__/catalog.test.js dist/aggregator/__tests__/refusePrivate.controller.test.js dist/aggregator/__tests__/gameResolveStillWorks.test.js`
Expected: PASS — owner-only and anonymous-private behaviors are unchanged.

- [ ] **Step 7: Commit**

```bash
git add packages/aggregator/src/catalog.ts src/catalog/install.ts src/catalog/__tests__/sharedResolve.test.ts
git commit -m "feat(catalog): access-gate resolve endpoints via accountCanAccessGem (owner + shared members)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 4: `gem-shares` endpoints (owner-gated share management)

**Files:**
- Create: `src/catalog/shares.ts`
- Modify: `src/index.ts` (call `installGemShares(app, deps)` where `installCatalog` is wired)
- Test: `src/catalog/__tests__/shares.route.test.ts`

**Interfaces:**
- Consumes: `resolveSession`, `catalogGemForOwner`, `groupMemberRole`, `shareGemWithGroup`, `unshareGemFromGroup`, `listGroupsForGem` (all from `@agentgem/aggregator`).
- Produces: `installGemShares(app, deps: { db, auth, webOrigins })` registering GET/POST/DELETE/OPTIONS on `/api/catalog/gem-shares`.

Semantics:
- `GET ?key=` → `{ shares: [{ groupId, name }] }`. Owner-only (caller must own `key`, else no-leak `404`).
- `POST {key, groupId}` → share. Owner-only AND caller must be a member of `groupId` (else `403 "join the group first"`). `{ shared: true }`.
- `DELETE ?key=&groupId=` → `{ removed: boolean }`. Owner-only.

- [ ] **Step 1: Write the failing test**

Create `src/catalog/__tests__/shares.route.test.ts`. Reuse the same fake-`res` + authed-`req` helpers as Task 3 (copy the `fakeRes` helper; use the same real authed-request helper).

```ts
// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
import { describe, it, expect } from "vitest";
import { makeTestDb, upsertAccount, upsertCatalogGem, createNativeGroup, grantInvite, makeAuth, listGroupsForGem } from "@agentgem/aggregator";
import { shareGemHandler } from "../shares.js";
// fakeRes + authedReq: same helpers as sharedResolve.test.ts

describe("gem-shares route (owner-gated)", () => {
  it("owner who is a group member can POST a share; non-owner 404; non-member owner 403", async () => {
    const db = await makeTestDb();
    const auth = makeAuth(db);
    const owner = await upsertAccount(db, { provider: "github", accountId: "owner", login: "owner" });
    const other = await upsertAccount(db, { provider: "github", accountId: "other", login: "other" });
    await upsertCatalogGem(db, { gemKey: "o/secret", version: "1.0.0", publishedBy: "owner", ownerAccountId: owner.id, createdAtMs: 1, visibility: "private" });
    const g = await createNativeGroup(db, owner.id, "Team");   // owner is admin/member
    const foreign = await createNativeGroup(db, other.id, "Foreign");   // owner is NOT a member
    const deps = { db, auth, webOrigins: ["https://app.agentgem.ai"] };
    const handler = shareGemHandler(deps);

    // owner shares with own group -> 200
    const ok = fakeRes();
    await handler(authedReq(owner.id, {}, { key: "o/secret", groupId: g.id }, "POST") as any, ok.res);
    expect(ok.out.code).toBe(200);
    expect(await listGroupsForGem(db, "o/secret")).toEqual([{ groupId: g.id, name: "Team" }]);

    // non-owner tries to share owner's gem -> 404 (no leak)
    const nf = fakeRes();
    await handler(authedReq(other.id, {}, { key: "o/secret", groupId: foreign.id }, "POST") as any, nf.res);
    expect(nf.out.code).toBe(404);

    // owner shares with a group they don't belong to -> 403
    const forbidden = fakeRes();
    await handler(authedReq(owner.id, {}, { key: "o/secret", groupId: foreign.id }, "POST") as any, forbidden.res);
    expect(forbidden.out.code).toBe(403);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm test dist/catalog/__tests__/shares.route.test.js`
Expected: FAIL to compile — `../shares.js` / `shareGemHandler` does not exist yet.

- [ ] **Step 3: Implement `src/catalog/shares.ts`**

```ts
// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
// Owner-gated gem-share management (raw express, sibling of catalog/install.ts): reachable
// cross-site, own credentialed CORS, originGuard-exempt via the /api/catalog/ prefix. All routes
// authed (session → 401). Owner-gate is no-leak: a caller who does not own `key` gets 404, never a
// 403 that would confirm the gem exists. The only 403 is "you own the gem but are not in that group".
import type { AppDb, makeAuth } from "@agentgem/aggregator";
import { resolveSession, catalogGemForOwner, groupMemberRole, shareGemWithGroup, unshareGemFromGroup, listGroupsForGem } from "@agentgem/aggregator";

export interface SharesDeps { db: AppDb; auth: ReturnType<typeof makeAuth>; webOrigins: string[] }

interface Req { method: string; query: Record<string, unknown>; body: Record<string, unknown>; headers: Record<string, string | undefined> }
interface Res { status(c: number): Res; set(k: string, v: string): Res; json(b: unknown): Res; send(b: unknown): Res }
type ExpressApp = {
  get(p: string, h: (req: Req, res: Res) => unknown): unknown;
  post(p: string, h: (req: Req, res: Res) => unknown): unknown;
  delete(p: string, h: (req: Req, res: Res) => unknown): unknown;
  options(p: string, h: (req: Req, res: Res) => unknown): unknown;
};

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function cors(req: Req, res: Res, origins: string[]): void {
  const origin = req.headers["origin"];
  if (origin && origins.includes(origin)) {
    res.set("Access-Control-Allow-Origin", origin);
    res.set("Access-Control-Allow-Credentials", "true");
    res.set("Vary", "Origin");
  }
}
function preflight(res: Res): void {
  res.set("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS").set("Access-Control-Allow-Headers", "content-type").status(204).send("");
}

// Resolve the session and confirm the caller owns `key`. Returns the accountId, or null after
// having already sent the correct no-leak response (401 signed out, 400 bad key, 404 not owner).
async function requireGemOwner(deps: SharesDeps, req: Req, res: Res, key: string): Promise<string | null> {
  const who = await resolveSession(deps.auth, req.headers);
  if (!who) { res.status(401).json({ error: "sign in required" }); return null; }
  if (!key) { res.status(400).json({ error: "key required" }); return null; }
  const owned = await catalogGemForOwner(deps.db, key, who.accountId);
  if (!owned) { res.status(404).json({ error: "gem not found" }); return null; }
  return who.accountId;
}

export function shareGemHandler(deps: SharesDeps) {
  return async (req: Req, res: Res): Promise<void> => {
    cors(req, res, deps.webOrigins);
    if (req.method === "OPTIONS") { preflight(res); return; }

    if (req.method === "GET") {
      const key = String((req.query.key as string | undefined) ?? "");
      const accountId = await requireGemOwner(deps, req, res, key);
      if (!accountId) return;
      res.json({ shares: await listGroupsForGem(deps.db, key) });
      return;
    }

    if (req.method === "POST") {
      const key = String((req.body.key as string | undefined) ?? "");
      const groupId = String((req.body.groupId as string | undefined) ?? "");
      const accountId = await requireGemOwner(deps, req, res, key);
      if (!accountId) return;
      if (!UUID_RE.test(groupId)) { res.status(400).json({ error: "groupId must be a UUID" }); return; }
      // You can only share INTO a group you belong to.
      if (!(await groupMemberRole(deps.db, groupId, accountId))) { res.status(403).json({ error: "join the group first" }); return; }
      await shareGemWithGroup(deps.db, key, groupId, accountId);
      res.json({ shared: true });
      return;
    }

    if (req.method === "DELETE") {
      const key = String((req.query.key as string | undefined) ?? "");
      const groupId = String((req.query.groupId as string | undefined) ?? "");
      const accountId = await requireGemOwner(deps, req, res, key);
      if (!accountId) return;
      if (!UUID_RE.test(groupId)) { res.status(400).json({ error: "groupId must be a UUID" }); return; }
      res.json({ removed: await unshareGemFromGroup(deps.db, key, groupId) });
      return;
    }

    res.status(405).json({ error: "method not allowed" });
  };
}

export function installGemShares(app: ExpressApp, deps: SharesDeps): void {
  const h = shareGemHandler(deps);
  app.get("/api/catalog/gem-shares", h);
  app.post("/api/catalog/gem-shares", h);
  app.delete("/api/catalog/gem-shares", h);
  app.options("/api/catalog/gem-shares", h);
}
```

- [ ] **Step 4: Wire it into the server**

In `src/index.ts`, find where `installCatalog(...)` is called and add immediately after it:

```ts
installGemShares(app, { db, auth, webOrigins });
```

Add the import alongside the existing `installCatalog` import (match the existing import style in that file — likely `import { installGemShares } from "./catalog/shares.js";`). Use the SAME `app`, `db`, `auth`, and `webOrigins` bindings the neighbouring `installCatalog`/`installGroups` calls use.

- [ ] **Step 5: Run to verify it passes**

Run: `pnpm test dist/catalog/__tests__/shares.route.test.js`
Expected: PASS (owner→200, non-owner→404, non-member-owner→403).

- [ ] **Step 6: Commit**

```bash
git add src/catalog/shares.ts src/index.ts src/catalog/__tests__/shares.route.test.ts
git commit -m "feat(catalog): owner-gated /api/catalog/gem-shares (share/unshare/list)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 5: `group-gems` discovery endpoint (member-gated)

**Files:**
- Create: `packages/aggregator/src/gemShares.ts` gets one new function `listGemsSharedWithGroup` (extend Task 1's module)
- Modify: `src/groups/install.ts` (add `groupGemsHandler` + register `/api/catalog/group-gems`)
- Test: `src/aggregator/__tests__/gemShares.test.ts` (store) + `src/groups/__tests__/install.test.ts` (route, append)

**Interfaces:**
- Consumes: `requireGroupRole(deps, req, res, needAdmin=false)` (existing in `src/groups/install.ts`); `gemGroupShares`, `catalogGems`, `gemArchives`.
- Produces: `listGemsSharedWithGroup(db: AppDb, groupId: string): Promise<{ gemKey: string; version: string; description: string; artifactKinds: string[]; installable: boolean }[]>`.

- [ ] **Step 1: Write the failing store test (append to `gemShares.test.ts`)**

```ts
  it("listGemsSharedWithGroup returns the latest version + metadata of each shared gem", async () => {
    const db = await makeTestDb();
    const { listGemsSharedWithGroup, upsertGemArchive } = await import("@agentgem/aggregator");
    const owner = await acct(db, "owner");
    await upsertCatalogGem(db, { gemKey: "o/secret", version: "1.0.0", publishedBy: "owner", ownerAccountId: owner.id, createdAtMs: 1, visibility: "private", description: "hi", artifactKinds: ["game"] });
    await upsertGemArchive(db, { gemKey: "o/secret", version: "1.0.0", bytes: new Uint8Array([1]), digest: "d", createdAtMs: 1, ownerAccountId: owner.id });
    const g = await createNativeGroup(db, owner.id, "Team");
    await shareGemWithGroup(db, "o/secret", g.id, owner.id);
    expect(await listGemsSharedWithGroup(db, g.id)).toEqual([
      { gemKey: "o/secret", version: "1.0.0", description: "hi", artifactKinds: ["game"], installable: true },
    ]);
    const empty = await createNativeGroup(db, owner.id, "Empty");
    expect(await listGemsSharedWithGroup(db, empty.id)).toEqual([]);
  });
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm test dist/aggregator/__tests__/gemShares.test.js`
Expected: FAIL to compile — `listGemsSharedWithGroup` is not exported yet.

- [ ] **Step 3: Implement the store function**

Append to `packages/aggregator/src/gemShares.ts`. Add `catalogGems, gemArchives` to the schema import and `desc` to the drizzle import:

```ts
import { and, desc, eq, sql } from "drizzle-orm";
import { gemGroupShares, groups, catalogGems, gemArchives } from "./schema.js";
```

```ts
/** Gems shared with a group, each at its latest published version, with the metadata the
 *  marketplace's discovery listing needs. Newest-shared first. */
export async function listGemsSharedWithGroup(
  db: AppDb, groupId: string,
): Promise<{ gemKey: string; version: string; description: string; artifactKinds: string[]; installable: boolean }[]> {
  const shares = await db.select({ gemKey: gemGroupShares.gemKey })
    .from(gemGroupShares).where(eq(gemGroupShares.groupId, groupId));
  const out: { gemKey: string; version: string; description: string; artifactKinds: string[]; installable: boolean }[] = [];
  for (const s of shares) {
    const row = (await db.select({
      version: catalogGems.version, description: catalogGems.description,
      artifactKinds: catalogGems.artifactKinds, archiveKey: gemArchives.gemKey,
    }).from(catalogGems)
      .leftJoin(gemArchives, and(eq(catalogGems.gemKey, gemArchives.gemKey), eq(catalogGems.version, gemArchives.version)))
      .where(eq(catalogGems.gemKey, s.gemKey))
      .orderBy(desc(catalogGems.createdAtMs)).limit(1))[0];
    if (!row) continue;   // share to a gem with no catalog row (fully unpublished) — skip
    out.push({
      gemKey: s.gemKey, version: row.version, description: row.description ?? "",
      artifactKinds: row.artifactKinds ?? [], installable: row.archiveKey != null,
    });
  }
  return out;
}
```

- [ ] **Step 4: Run the store test to verify it passes**

Run: `pnpm test dist/aggregator/__tests__/gemShares.test.js`
Expected: all gem-shares store tests PASS.

- [ ] **Step 5: Write the failing route test (append to `src/groups/__tests__/install.test.ts`)**

Match the existing harness in that file (it already builds authed requests + a fake res for the group handlers). Add:

```ts
  it("group-gems: a member sees the gems shared with the group; a non-member gets 404", async () => {
    // set up: owner creates group + private gem + shares it; member joins; stranger does not.
    // Drive groupGemsHandler(deps) with req.query.id = group.id for member (expect 200 + gems[0])
    // and for a stranger (expect 404). Reuse this file's existing authed-req + fakeRes helpers.
  });
```

> Implementer: fill this in using the SAME fixtures/helpers already present in `install.test.ts` (it tests `groupsHandler`, `groupMembersHandler`, etc.). Assert member→`{ gems: [{ gemKey: "o/secret", ... }] }` at code 200, stranger→404.

- [ ] **Step 6: Run to verify it fails**

Run: `pnpm test dist/groups/__tests__/install.test.js`
Expected: FAIL — `groupGemsHandler` not exported yet.

- [ ] **Step 7: Add the handler + registration in `src/groups/install.ts`**

Add `listGemsSharedWithGroup` to the `@agentgem/aggregator` import block (lines 20-25). Add this handler after `groupInviteRedeemHandler`:

```ts
/** GET → gems shared with this group (any member). Member-gated via requireGroupRole. */
export function groupGemsHandler(deps: GroupsDeps) {
  return async (req: Req, res: Res): Promise<void> => {
    cors(req, res, deps.webOrigins);
    if (req.method === "OPTIONS") { preflight(res); return; }
    const ok = await requireGroupRole(deps, req, res, false);
    if (!ok) return;
    res.json({ gems: await listGemsSharedWithGroup(deps.db, ok.groupId) });
  };
}
```

In `installGroups`, after the existing `for` loop, register the new route (GET + OPTIONS only):

```ts
  const groupGems = groupGemsHandler(deps);
  expressApp.get("/api/catalog/group-gems", groupGems);
  expressApp.options("/api/catalog/group-gems", groupGems);
```

- [ ] **Step 8: Run both test files to verify they pass**

Run: `pnpm test dist/groups/__tests__/install.test.js dist/aggregator/__tests__/gemShares.test.js`
Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git add packages/aggregator/src/gemShares.ts src/groups/install.ts src/aggregator/__tests__/gemShares.test.ts src/groups/__tests__/install.test.ts
git commit -m "feat(groups): member-gated /api/catalog/group-gems discovery listing

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 6: Full-suite green + PR

**Files:** none (verification).

- [ ] **Step 1: Run the entire suite**

Run: `pnpm test`
Expected: `tsc -b` clean, ALL tests PASS (baseline count from Task 0 + the new files).

- [ ] **Step 2: Push and open the PR**

```bash
git push -u origin group-shared-gems
gh pr create --title "feat: group-shared gems (backend — ACL, enforcement, share + discovery endpoints)" \
  --body "$(cat <<'EOF'
Backend for group-shared gems (Plan 1 of 2). Native groups get a payload:
an owner shares a private gem with a group; members gain access.

- `gem_group_shares` ACL table + `accountCanAccessGem` single gate
- resolve endpoints generalized owner → owner|shared-member (no-leak 404 preserved)
- owner-gated `/api/catalog/gem-shares` (share/unshare/list)
- member-gated `/api/catalog/group-gems` discovery listing
- shares cascade on group delete (FK) and clear when a gem's last version is unpublished

Spec: docs/superpowers/specs/2026-07-11-group-shared-gems-design.md
Frontend is Plan 2 (separate PR).

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

- [ ] **Step 3: Watch CI and merge when green**

```bash
gh run watch "$(gh run list --branch group-shared-gems --limit 1 --json databaseId --jq '.[0].databaseId')" --exit-status
gh pr merge --rebase --delete-branch
```
Expected: `test (24)` passes, PR merges. (The local branch-delete may error because `main` is checked out elsewhere — the remote merge still succeeds; verify with `git fetch && git log origin/main --oneline -1`.)

---

## Self-Review

**Spec coverage:**
- Data model `gem_group_shares` → Task 1. ✓
- `accountCanAccessGem` single gate → Task 1. ✓
- Generalize owner resolve endpoints → Task 3. ✓
- Owner-gated shares management endpoints → Task 4. ✓
- Member-gated discovery (`group-gems`) → Task 5. ✓
- Cascade on group delete (FK DDL) → Task 1; cleanup on gem delete → Task 2. ✓
- Security invariants (401/no-leak-404/share-only-to-own-group) → Tasks 3, 4, 5 tests. ✓
- Groups management endpoints already exist → no task (correct). ✓
- Frontend (client, pages, routing, Gem share control, nav) → **deferred to Plan 2** (separate doc), per the spec's rollout. ✓

**Placeholder scan:** Task 3 Step 1 and Task 5 Step 5 intentionally defer the authed-request harness to "the same helper the neighbouring tests use" rather than inventing one — the assertions are concrete; only the fixture plumbing is delegated to match repo convention. All other steps contain complete code.

**Type consistency:** `accountCanAccessGem(db, gemKey, version, accountId)`, `shareGemWithGroup(db, gemKey, groupId, createdBy, now?)`, `unshareGemFromGroup(db, gemKey, groupId)`, `listGroupsForGem(db, gemKey) → {groupId,name}[]`, `listGemsSharedWithGroup(db, groupId)`, `catalogGemForViewer(db, gemKey, accountId)` — names/signatures match across every task that references them.

## Follow-up: Plan 2 (frontend)

After this plan merges, a second plan doc (`2026-07-11-group-shared-gems-frontend.md`) covers the `@agentgem/marketplace` work: `groups.ts` client + share methods, `Groups.tsx` / `GroupDetail.tsx` / join landing pages, `Gem.tsx` share control, routing + conformance, and the signed-in "Groups" nav entry. It depends only on the endpoints this plan ships.
