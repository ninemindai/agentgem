# Groups & Membership (Plan 1 of 2) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a provider-neutral group model — federated groups mirrored from GitHub orgs and native groups created inside AgentGem — with membership, admin-minted invite links, and a reconciler that can never evict an invited guest.

**Architecture:** Three new Postgres tables (`groups`, `group_members`, `group_invites`) in `packages/aggregator`. Federated groups are auto-created per GitHub App installation; their `source='sync'` member rows are materialized at sign-in (an org roster holds bare GitHub logins, most of which have no `accounts` row, so they cannot be mirrored directly). Every delete path the GitHub App owns is narrowed to `WHERE source = 'sync'`, so invited guests survive offboarding. Routes hang off the existing `/api/catalog/*` prefix, which already has credentialed CORS and session resolution.

**Tech Stack:** TypeScript (ESM, `.js` import specifiers), Drizzle ORM over Postgres, PGlite for tests, vitest, raw Express route modules.

**Spec:** `docs/superpowers/specs/2026-07-08-groups-and-private-gems-design.md`

## Global Constraints

- **Node `>= 24`.** No new runtime dependencies — everything needed is already present (`drizzle-orm`, `node:crypto`).
- **ESM with explicit `.js` specifiers** in imports, even from `.ts` sources (`import { x } from "./groups.js"`).
- **Tests run against compiled `dist/`, not `src/`.** `pnpm test` is `tsc -b && vitest run`, and `vitest.config.ts` includes only `dist/**/__tests__/**/*.test.js`. Pointing vitest at a `src/**/*.test.ts` path matches nothing. After any file rename, run `pnpm clean` first or stale `dist/` output will run instead.
- **There are no drizzle-kit migrations.** `ensureSchema` in `packages/aggregator/src/schema.ts` is the DDL source of truth. A new table needs four edits: (1) the `pgTable` object, (2) an entry in the `schema` const at `schema.ts:269`, (3) `create table if not exists` in `ensureSchema`, (4) an alphabetized entry in `src/aggregator/__tests__/schema.test.ts`. Omitting (4) fails a test that looks unrelated to your change.
- **`CREATE TABLE IF NOT EXISTS` does not back-fill columns on an existing table.** Any column added to a pre-existing table needs a paired `alter table ... add column if not exists`. This plan adds no columns to existing tables, so the trap does not bite here — but Plan 2 adds `catalog_gems.visibility` and must.
- **Aggregator store code lives in `packages/aggregator/src/`; its tests live at repo-root `src/aggregator/__tests__/`** and import through the package name `@agentgem/aggregator`.
- **The aggregator barrel is `export * from "./<module>.js"`** with no named list (`packages/aggregator/src/index.ts`). A new module needs one new `export *` line.
- **`packages/console` tests and typecheck are NOT in CI.** This plan does not touch console. If you do, run them locally.
- **Lowercasing convention:** `org_scope` and `gh_login` are lowercased at write time so gates are case-insensitive without `lower()` on reads. Group `scope` follows the same rule. Account login lookups use `lower(accounts.login)` because `accounts.login` preserves GitHub's casing.

## File Structure

**Create:**
- `packages/aggregator/src/groups.ts` — group + membership store. One responsibility: rows in `groups` and `group_members`.
- `packages/aggregator/src/groupInvites.ts` — invite mint/redeem/revoke. Separate because its lifecycle (multi-use, expiry, revocation, sha256-only) is unrelated to membership queries.
- `src/aggregator/__tests__/groups.test.ts`
- `src/aggregator/__tests__/groupInvites.test.ts`
- `src/aggregator/__tests__/groupFederation.test.ts` — the sync/guest invariant.
- `src/groups/install.ts` — raw Express routes.
- `src/groups/__tests__/install.test.ts`

**Modify:**
- `packages/aggregator/src/schema.ts` — three tables, `schema` const, `ensureSchema` DDL.
- `packages/aggregator/src/index.ts` — two `export *` lines.
- `packages/aggregator/src/githubApp.ts` — `upsertInstallation` also ensures a federated group; `deleteInstallation` narrows to `source='sync'`.
- `packages/aggregator/src/webAuth.ts` — add `captureOrgMemberships` seam.
- `packages/aggregator/src/binding.ts:70` — call the seam instead of `setAccountScopes`.
- `src/auth/install.ts:88` — call the seam instead of `setAccountScopes`.
- `src/githubApp/sync.ts` — mirror `replaceOrgMembers` / `upsertOrgMember` / `deleteOrgMember` into `group_members`.
- `src/aggregator/__tests__/schema.test.ts` — three table names.
- `src/index.ts:195-200` — mount `installGroups`.

---

### Task 1: Schema — three tables

**Files:**
- Modify: `packages/aggregator/src/schema.ts`
- Modify: `src/aggregator/__tests__/schema.test.ts:12-13`

**Interfaces:**
- Consumes: nothing.
- Produces: drizzle tables `groups`, `groupMembers`, `groupInvites`, exported from `@agentgem/aggregator` (via the existing `export * from "./schema.js"`).

- [ ] **Step 1: Write the failing test**

In `src/aggregator/__tests__/schema.test.ts`, add the three names to the sorted array. Postgres `order by 1` places them between `gem_archives` and `handoff_codes`, in this order: `group_invites`, `group_members`, `groups`.

```ts
expect((t.rows as { table_name: string }[]).map((x) => x.table_name)).toEqual(["account_bindings", "account_scopes", "accounts", "api_keys", "app_installations", "attestations", "catalog_gems", "curated_skills", "gem_adoptions", "gem_archives", "group_invites", "group_members", "groups", "handoff_codes", "ingredients", "model_outcomes", "org_members", "org_settings", "producers", "reviews", "share_cards", "stars", "usage_day_models", "usage_days", "usage_edges", "web_sessions"]);
```

- [ ] **Step 2: Run test to verify it fails**

```bash
tsc -b && pnpm exec vitest run dist/aggregator/__tests__/schema.test.js
```
Expected: FAIL — actual array lacks `group_invites`, `group_members`, `groups`.

- [ ] **Step 3: Add the tables**

In `packages/aggregator/src/schema.ts`, after the `orgMembers` definition (currently ending line 214):

```ts
// A group is a set of accounts that can be granted access together.
//   kind 'federated' — mirrors an external network; `scope` is a name proven by that authority
//                      (today: a GitHub App installation on that org). Unique, because it was earned.
//   kind 'native'    — created inside AgentGem; no scope, uuid-addressed, invite-only.
// The check constraint IS the definition: a scope exists iff an external authority verified it.
export const groups = pgTable("groups", {
  id: uuid("id").primaryKey(),
  kind: text("kind").notNull(),
  scope: text("scope").unique(),
  name: text("name").notNull(),
  createdBy: uuid("created_by").references(() => accounts.id),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

// `source` is load-bearing. The GitHub App reconciler deletes ONLY source='sync' rows, so an
// invited guest survives org offboarding while a departed org member is evicted within seconds.
// Sync rows are materialized at sign-in (org rosters hold bare logins with no accounts row).
export const groupMembers = pgTable("group_members", {
  groupId: uuid("group_id").notNull().references(() => groups.id, { onDelete: "cascade" }),
  accountId: uuid("account_id").notNull().references(() => accounts.id),
  role: text("role").notNull().default("member"),
  source: text("source").notNull().default("invite"),
  addedAt: timestamp("added_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [primaryKey({ columns: [t.groupId, t.accountId] })]);

// Multi-use until expiry or revocation — a link pasted into a chat, not a one-shot machine code.
// Only sha256(token) is stored, so a DB leak cannot join a group. (Contrast handoff_codes, which
// is delete-on-read; the storage discipline is shared, the lifecycle is not.)
export const groupInvites = pgTable("group_invites", {
  tokenHash: text("token_hash").primaryKey(),
  groupId: uuid("group_id").notNull().references(() => groups.id, { onDelete: "cascade" }),
  role: text("role").notNull().default("member"),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  createdBy: uuid("created_by").notNull().references(() => accounts.id),
  revokedAt: timestamp("revoked_at", { withTimezone: true }),
});
```

- [ ] **Step 4: Register them in the `schema` const**

Replace `schema.ts:269`:

```ts
export const schema = { producers, attestations, ingredients, usageEdges, modelOutcomes, accountBindings, shareCards, apiKeys, accounts, webSessions, handoffCodes, stars, reviews, gemAdoptions, accountScopes, usageDays, usageDayModels, orgSettings, catalogGems, gemArchives, curatedSkills, appInstallations, orgMembers, groups, groupMembers, groupInvites };
```

- [ ] **Step 5: Add the DDL**

In `ensureSchema`, immediately after the `org_members` create (currently `schema.ts:327`):

```ts
await db.execute(sql`create table if not exists groups (id uuid primary key, kind text not null, scope text unique, name text not null, created_by uuid references accounts(id), created_at timestamptz not null default now(), constraint groups_kind_scope check ((kind = 'federated') = (scope is not null)))`);
await db.execute(sql`create table if not exists group_members (group_id uuid not null references groups(id) on delete cascade, account_id uuid not null references accounts(id), role text not null default 'member', source text not null default 'invite', added_at timestamptz not null default now(), primary key (group_id, account_id))`);
await db.execute(sql`create index if not exists group_members_account_idx on group_members (account_id)`);
await db.execute(sql`create table if not exists group_invites (token_hash text primary key, group_id uuid not null references groups(id) on delete cascade, role text not null default 'member', expires_at timestamptz not null, created_by uuid not null references accounts(id), revoked_at timestamptz)`);
await db.execute(sql`create index if not exists group_invites_group_idx on group_invites (group_id)`);
// Login → account lookup for the federated member sync. accounts.login preserves GitHub's casing.
await db.execute(sql`create index if not exists accounts_login_lower_idx on accounts (lower(login))`);
```

- [ ] **Step 6: Run test to verify it passes**

```bash
tsc -b && pnpm exec vitest run dist/aggregator/__tests__/schema.test.js
```
Expected: PASS.

- [ ] **Step 7: Verify the check constraint actually rejects bad rows**

Add to `src/aggregator/__tests__/schema.test.ts`:

```ts
it("groups: kind='federated' iff scope is not null", async () => {
  const db = await makeTestDb();
  await expect(db.execute(sql`insert into groups (id, kind, scope, name) values (gen_random_uuid(), 'native', 'acme', 'bad')`)).rejects.toThrow();
  await expect(db.execute(sql`insert into groups (id, kind, scope, name) values (gen_random_uuid(), 'federated', null, 'bad')`)).rejects.toThrow();
});
```

```bash
tsc -b && pnpm exec vitest run dist/aggregator/__tests__/schema.test.js
```
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add packages/aggregator/src/schema.ts src/aggregator/__tests__/schema.test.ts
git commit -m "feat(aggregator): groups, group_members, group_invites tables"
```

---

### Task 2: Group + membership store

**Files:**
- Create: `packages/aggregator/src/groups.ts`
- Create: `src/aggregator/__tests__/groups.test.ts`
- Modify: `packages/aggregator/src/index.ts`

**Interfaces:**
- Consumes: `groups`, `groupMembers`, `accounts` tables (Task 1); `AppDb` from `./schema.js`.
- Produces:
  ```ts
  type GroupKind = "federated" | "native";
  type GroupRole = "admin" | "member";
  type MemberSource = "sync" | "invite";
  interface Group { id: string; kind: GroupKind; scope: string | null; name: string }

  ensureFederatedGroup(db: AppDb, scope: string): Promise<Group>
  createNativeGroup(db: AppDb, createdBy: string, name: string): Promise<Group>
  getGroup(db: AppDb, groupId: string): Promise<Group | null>
  groupByScope(db: AppDb, scope: string): Promise<Group | null>
  listGroupsForAccount(db: AppDb, accountId: string): Promise<(Group & { role: GroupRole; source: MemberSource })[]>
  listGroupMembers(db: AppDb, groupId: string): Promise<{ accountId: string; login: string; avatarUrl: string | null; role: GroupRole; source: MemberSource }[]>
  upsertGroupMember(db: AppDb, groupId: string, accountId: string, role: GroupRole, source: MemberSource): Promise<void>
  removeGroupMember(db: AppDb, groupId: string, accountId: string): Promise<void>
  groupMemberRole(db: AppDb, groupId: string, accountId: string): Promise<GroupRole | null>
  deleteSyncedMembers(db: AppDb, groupId: string): Promise<void>
  replaceSyncedMembers(db: AppDb, groupId: string, logins: { login: string; role: GroupRole }[]): Promise<void>
  accountIdForLogin(db: AppDb, login: string): Promise<string | null>
  ```

- [ ] **Step 1: Write the failing test**

Create `src/aggregator/__tests__/groups.test.ts`:

```ts
// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
import { describe, it, expect } from "vitest";
import {
  makeTestDb, upsertAccount,
  ensureFederatedGroup, createNativeGroup, getGroup, groupByScope,
  listGroupsForAccount, listGroupMembers, upsertGroupMember, removeGroupMember,
  groupMemberRole, deleteSyncedMembers, replaceSyncedMembers, accountIdForLogin,
} from "@agentgem/aggregator";

describe("groups store", () => {
  it("ensureFederatedGroup is idempotent and lowercases scope", async () => {
    const db = await makeTestDb();
    const a = await ensureFederatedGroup(db, "Acme");
    const b = await ensureFederatedGroup(db, "acme");
    expect(b.id).toBe(a.id);
    expect(a.scope).toBe("acme");
    expect(a.kind).toBe("federated");
    expect((await groupByScope(db, "ACME"))?.id).toBe(a.id);
  });

  it("createNativeGroup has no scope and makes the creator an admin", async () => {
    const db = await makeTestDb();
    const me = await upsertAccount(db, { provider: "github", accountId: "1", login: "neo" });
    const g = await createNativeGroup(db, me.id, "Friends");
    expect(g.kind).toBe("native");
    expect(g.scope).toBeNull();
    expect(await groupMemberRole(db, g.id, me.id)).toBe("admin");
    expect((await getGroup(db, g.id))?.name).toBe("Friends");
  });

  it("listGroupsForAccount returns only groups the account is in, with role and source", async () => {
    const db = await makeTestDb();
    const me = await upsertAccount(db, { provider: "github", accountId: "1", login: "neo" });
    const other = await upsertAccount(db, { provider: "github", accountId: "2", login: "trin" });
    const mine = await createNativeGroup(db, me.id, "Mine");
    await createNativeGroup(db, other.id, "Theirs");
    const rows = await listGroupsForAccount(db, me.id);
    expect(rows.map((r) => r.name)).toEqual(["Mine"]);
    expect(rows[0]).toMatchObject({ id: mine.id, role: "admin", source: "invite" });
  });

  it("accountIdForLogin is case-insensitive and github-scoped", async () => {
    const db = await makeTestDb();
    const me = await upsertAccount(db, { provider: "github", accountId: "1", login: "Neo" });
    expect(await accountIdForLogin(db, "neo")).toBe(me.id);
    expect(await accountIdForLogin(db, "NEO")).toBe(me.id);
    expect(await accountIdForLogin(db, "nobody")).toBeNull();
  });

  it("replaceSyncedMembers replaces ONLY source='sync' rows, never invited guests", async () => {
    const db = await makeTestDb();
    const alice = await upsertAccount(db, { provider: "github", accountId: "1", login: "alice" });
    const bob = await upsertAccount(db, { provider: "github", accountId: "2", login: "bob" });
    const guest = await upsertAccount(db, { provider: "github", accountId: "3", login: "guest" });
    const g = await ensureFederatedGroup(db, "acme");

    await replaceSyncedMembers(db, g.id, [{ login: "alice", role: "admin" }, { login: "bob", role: "member" }]);
    await upsertGroupMember(db, g.id, guest.id, "member", "invite");
    expect((await listGroupMembers(db, g.id)).map((m) => m.login).sort()).toEqual(["alice", "bob", "guest"]);

    // Alice leaves the org; bob stays. The guest was never GitHub's to revoke.
    await replaceSyncedMembers(db, g.id, [{ login: "bob", role: "member" }]);
    const after = await listGroupMembers(db, g.id);
    expect(after.map((m) => m.login).sort()).toEqual(["bob", "guest"]);
    expect(await groupMemberRole(db, g.id, alice.id)).toBeNull();
    expect(await groupMemberRole(db, g.id, guest.id)).toBe("member");
    void bob;
  });

  it("replaceSyncedMembers skips logins with no account", async () => {
    const db = await makeTestDb();
    const g = await ensureFederatedGroup(db, "acme");
    await replaceSyncedMembers(db, g.id, [{ login: "never-signed-in", role: "member" }]);
    expect(await listGroupMembers(db, g.id)).toEqual([]);
  });

  it("deleteSyncedMembers leaves guests behind", async () => {
    const db = await makeTestDb();
    const alice = await upsertAccount(db, { provider: "github", accountId: "1", login: "alice" });
    const guest = await upsertAccount(db, { provider: "github", accountId: "3", login: "guest" });
    const g = await ensureFederatedGroup(db, "acme");
    await upsertGroupMember(db, g.id, alice.id, "member", "sync");
    await upsertGroupMember(db, g.id, guest.id, "member", "invite");
    await deleteSyncedMembers(db, g.id);
    expect((await listGroupMembers(db, g.id)).map((m) => m.login)).toEqual(["guest"]);
  });

  it("upsertGroupMember promotes role; removeGroupMember removes", async () => {
    const db = await makeTestDb();
    const me = await upsertAccount(db, { provider: "github", accountId: "1", login: "neo" });
    const g = await ensureFederatedGroup(db, "acme");
    await upsertGroupMember(db, g.id, me.id, "member", "invite");
    await upsertGroupMember(db, g.id, me.id, "admin", "invite");
    expect(await groupMemberRole(db, g.id, me.id)).toBe("admin");
    await removeGroupMember(db, g.id, me.id);
    expect(await groupMemberRole(db, g.id, me.id)).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
tsc -b && pnpm exec vitest run dist/aggregator/__tests__/groups.test.js
```
Expected: FAIL — `tsc -b` errors that `ensureFederatedGroup` etc. are not exported from `@agentgem/aggregator`.

- [ ] **Step 3: Write the store**

Create `packages/aggregator/src/groups.ts`:

```ts
// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
// Group + membership store.
//
// Two kinds of group, distinguished by whether an external authority verified the name:
//   federated — has a `scope` (a GitHub org today), proven by an App installation. Unique.
//   native    — created in AgentGem, no scope, uuid-addressed, invite-only.
//
// `group_members.source` is the load-bearing column. The GitHub App owns 'sync' rows and may
// delete only those; an invited guest ('invite') survives org offboarding. Sync rows are
// materialized at sign-in, because an org roster holds bare logins and most have no accounts row.
import { randomUUID } from "node:crypto";
import { and, eq, inArray, sql } from "drizzle-orm";
import type { AppDb } from "./schema.js";
import { accounts, groups, groupMembers } from "./schema.js";

export type GroupKind = "federated" | "native";
export type GroupRole = "admin" | "member";
export type MemberSource = "sync" | "invite";

export interface Group { id: string; kind: GroupKind; scope: string | null; name: string }

const asGroup = (r: { id: string; kind: string; scope: string | null; name: string }): Group =>
  ({ id: r.id, kind: r.kind as GroupKind, scope: r.scope, name: r.name });

const cols = { id: groups.id, kind: groups.kind, scope: groups.scope, name: groups.name };

/** The federated group for `scope`, creating it if absent. Idempotent; scope is lowercased. */
export async function ensureFederatedGroup(db: AppDb, scope: string): Promise<Group> {
  const s = scope.toLowerCase();
  const existing = await groupByScope(db, s);
  if (existing) return existing;
  const rows = await db
    .insert(groups)
    .values({ id: randomUUID(), kind: "federated", scope: s, name: s })
    .onConflictDoNothing({ target: groups.scope })
    .returning(cols);
  // A concurrent writer won the insert — re-read rather than fail.
  return rows[0] ? asGroup(rows[0]) : (await groupByScope(db, s))!;
}

/** Create a native group. The creator becomes its first admin, by invite. */
export async function createNativeGroup(db: AppDb, createdBy: string, name: string): Promise<Group> {
  const rows = await db
    .insert(groups)
    .values({ id: randomUUID(), kind: "native", scope: null, name, createdBy })
    .returning(cols);
  const g = asGroup(rows[0]);
  await upsertGroupMember(db, g.id, createdBy, "admin", "invite");
  return g;
}

export async function getGroup(db: AppDb, groupId: string): Promise<Group | null> {
  const rows = await db.select(cols).from(groups).where(eq(groups.id, groupId)).limit(1);
  return rows[0] ? asGroup(rows[0]) : null;
}

export async function groupByScope(db: AppDb, scope: string): Promise<Group | null> {
  const rows = await db.select(cols).from(groups).where(eq(groups.scope, scope.toLowerCase())).limit(1);
  return rows[0] ? asGroup(rows[0]) : null;
}

export async function listGroupsForAccount(
  db: AppDb, accountId: string,
): Promise<(Group & { role: GroupRole; source: MemberSource })[]> {
  const rows = await db
    .select({ ...cols, role: groupMembers.role, source: groupMembers.source })
    .from(groupMembers)
    .innerJoin(groups, eq(groupMembers.groupId, groups.id))
    .where(eq(groupMembers.accountId, accountId));
  return rows.map((r) => ({ ...asGroup(r), role: r.role as GroupRole, source: r.source as MemberSource }));
}

export async function listGroupMembers(
  db: AppDb, groupId: string,
): Promise<{ accountId: string; login: string; avatarUrl: string | null; role: GroupRole; source: MemberSource }[]> {
  const rows = await db
    .select({ accountId: accounts.id, login: accounts.login, avatarUrl: accounts.avatarUrl, role: groupMembers.role, source: groupMembers.source })
    .from(groupMembers)
    .innerJoin(accounts, eq(groupMembers.accountId, accounts.id))
    .where(eq(groupMembers.groupId, groupId));
  return rows.map((r) => ({ ...r, role: r.role as GroupRole, source: r.source as MemberSource }));
}

export async function upsertGroupMember(
  db: AppDb, groupId: string, accountId: string, role: GroupRole, source: MemberSource,
): Promise<void> {
  await db
    .insert(groupMembers)
    .values({ groupId, accountId, role, source })
    .onConflictDoUpdate({ target: [groupMembers.groupId, groupMembers.accountId], set: { role, source } });
}

export async function removeGroupMember(db: AppDb, groupId: string, accountId: string): Promise<void> {
  await db.delete(groupMembers).where(and(eq(groupMembers.groupId, groupId), eq(groupMembers.accountId, accountId)));
}

export async function groupMemberRole(db: AppDb, groupId: string, accountId: string): Promise<GroupRole | null> {
  const rows = await db
    .select({ role: groupMembers.role })
    .from(groupMembers)
    .where(and(eq(groupMembers.groupId, groupId), eq(groupMembers.accountId, accountId)))
    .limit(1);
  return rows[0] ? (rows[0].role as GroupRole) : null;
}

/** Drop every App-owned member row for a group. Invited guests are untouched — this predicate
 *  is the whole reason `source` exists. */
export async function deleteSyncedMembers(db: AppDb, groupId: string): Promise<void> {
  await db.delete(groupMembers).where(and(eq(groupMembers.groupId, groupId), eq(groupMembers.source, "sync")));
}

/** The account behind a GitHub login, or null. Case-insensitive; `accounts.login` keeps GitHub's casing. */
export async function accountIdForLogin(db: AppDb, login: string): Promise<string | null> {
  const rows = await db
    .select({ id: accounts.id })
    .from(accounts)
    .where(and(eq(accounts.provider, "github"), sql`lower(${accounts.login}) = ${login.toLowerCase()}`))
    .limit(1);
  return rows[0]?.id ?? null;
}

/** Replace a federated group's synced roster. Logins with no AgentGem account are skipped: they
 *  have no session and can read nothing, and their row appears the first time they sign in. */
export async function replaceSyncedMembers(
  db: AppDb, groupId: string, logins: { login: string; role: GroupRole }[],
): Promise<void> {
  await deleteSyncedMembers(db, groupId);
  if (logins.length === 0) return;
  const lowered = logins.map((l) => l.login.toLowerCase());
  const known = await db
    .select({ id: accounts.id, login: accounts.login })
    .from(accounts)
    .where(and(eq(accounts.provider, "github"), inArray(sql`lower(${accounts.login})`, lowered)));
  const roleFor = new Map(logins.map((l) => [l.login.toLowerCase(), l.role]));
  const values = known.map((a) => ({
    groupId, accountId: a.id, role: roleFor.get(a.login.toLowerCase()) ?? "member", source: "sync" as const,
  }));
  if (values.length === 0) return;
  // A guest may already hold this (group_id, account_id): an org member who was ALSO invited.
  // Sync wins on role, and the row becomes App-owned — which is correct, they are in the org.
  await db
    .insert(groupMembers)
    .values(values)
    .onConflictDoUpdate({ target: [groupMembers.groupId, groupMembers.accountId], set: { role: sql`excluded.role`, source: sql`excluded.source` } });
}
```

- [ ] **Step 4: Export from the barrel**

In `packages/aggregator/src/index.ts`, after the `export * from "./githubApp.js";` line:

```ts
export * from "./groups.js";
```

- [ ] **Step 5: Run test to verify it passes**

```bash
tsc -b && pnpm exec vitest run dist/aggregator/__tests__/groups.test.js
```
Expected: PASS, 7 tests.

- [ ] **Step 6: Commit**

```bash
git add packages/aggregator/src/groups.ts packages/aggregator/src/index.ts src/aggregator/__tests__/groups.test.ts
git commit -m "feat(aggregator): group + membership store with sync/invite sources"
```

---

### Task 3: Invite store

**Files:**
- Create: `packages/aggregator/src/groupInvites.ts`
- Create: `src/aggregator/__tests__/groupInvites.test.ts`
- Modify: `packages/aggregator/src/index.ts`

**Interfaces:**
- Consumes: `groupInvites` table (Task 1); `upsertGroupMember`, `GroupRole` (Task 2).
- Produces:
  ```ts
  type RedeemResult = "ok" | "not-found" | "gone";
  createGroupInvite(db: AppDb, opts: { groupId: string; role: GroupRole; createdBy: string; ttlMs: number }): Promise<{ token: string; expiresAt: string }>
  redeemGroupInvite(db: AppDb, token: string, accountId: string, now?: number): Promise<RedeemResult>
  revokeGroupInvite(db: AppDb, groupId: string, token: string, now?: number): Promise<boolean>
  listGroupInvites(db: AppDb, groupId: string): Promise<{ tokenHash: string; role: GroupRole; expiresAt: Date; revokedAt: Date | null }[]>
  ```

- [ ] **Step 1: Write the failing test**

Create `src/aggregator/__tests__/groupInvites.test.ts`:

```ts
// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
import { describe, it, expect } from "vitest";
import { createHash } from "node:crypto";
import { sql } from "drizzle-orm";
import {
  makeTestDb, upsertAccount, createNativeGroup, groupMemberRole,
  createGroupInvite, redeemGroupInvite, revokeGroupInvite, listGroupInvites,
} from "@agentgem/aggregator";

const seed = async () => {
  const db = await makeTestDb();
  const admin = await upsertAccount(db, { provider: "github", accountId: "1", login: "admin" });
  const g = await createNativeGroup(db, admin.id, "Friends");
  return { db, admin, g };
};

describe("group invites", () => {
  it("stores only the sha256 of the token", async () => {
    const { db, admin, g } = await seed();
    const { token } = await createGroupInvite(db, { groupId: g.id, role: "member", createdBy: admin.id, ttlMs: 60_000 });
    const rows = await db.execute(sql`select token_hash from group_invites`);
    const hashes = (rows.rows as { token_hash: string }[]).map((r) => r.token_hash);
    expect(hashes).toEqual([createHash("sha256").update(token).digest("hex")]);
    expect(hashes[0]).not.toBe(token);
  });

  it("is MULTI-use: two people redeem the same link", async () => {
    const { db, admin, g } = await seed();
    const a = await upsertAccount(db, { provider: "github", accountId: "2", login: "a" });
    const b = await upsertAccount(db, { provider: "github", accountId: "3", login: "b" });
    const { token } = await createGroupInvite(db, { groupId: g.id, role: "member", createdBy: admin.id, ttlMs: 60_000 });
    expect(await redeemGroupInvite(db, token, a.id)).toBe("ok");
    expect(await redeemGroupInvite(db, token, b.id)).toBe("ok");
    expect(await groupMemberRole(db, g.id, a.id)).toBe("member");
    expect(await groupMemberRole(db, g.id, b.id)).toBe("member");
  });

  it("redeeming inserts source='invite' with the invite's role", async () => {
    const { db, admin, g } = await seed();
    const a = await upsertAccount(db, { provider: "github", accountId: "2", login: "a" });
    const { token } = await createGroupInvite(db, { groupId: g.id, role: "admin", createdBy: admin.id, ttlMs: 60_000 });
    expect(await redeemGroupInvite(db, token, a.id)).toBe("ok");
    expect(await groupMemberRole(db, g.id, a.id)).toBe("admin");
    const rows = await db.execute(sql`select source from group_members where account_id = ${a.id}`);
    expect((rows.rows as { source: string }[])[0].source).toBe("invite");
  });

  it("expired → 'gone'", async () => {
    const { db, admin, g } = await seed();
    const a = await upsertAccount(db, { provider: "github", accountId: "2", login: "a" });
    const { token } = await createGroupInvite(db, { groupId: g.id, role: "member", createdBy: admin.id, ttlMs: 1_000 });
    expect(await redeemGroupInvite(db, token, a.id, Date.now() + 5_000)).toBe("gone");
    expect(await groupMemberRole(db, g.id, a.id)).toBeNull();
  });

  it("revoked → 'gone'", async () => {
    const { db, admin, g } = await seed();
    const a = await upsertAccount(db, { provider: "github", accountId: "2", login: "a" });
    const { token } = await createGroupInvite(db, { groupId: g.id, role: "member", createdBy: admin.id, ttlMs: 60_000 });
    expect(await revokeGroupInvite(db, g.id, token)).toBe(true);
    expect(await redeemGroupInvite(db, token, a.id)).toBe("gone");
  });

  it("unknown token → 'not-found' (no oracle difference from a wrong group)", async () => {
    const { db } = await seed();
    const a = await upsertAccount(db, { provider: "github", accountId: "2", login: "a" });
    expect(await redeemGroupInvite(db, "nope", a.id)).toBe("not-found");
  });

  it("revoking a token that belongs to a different group is refused", async () => {
    const { db, admin, g } = await seed();
    const other = await createNativeGroup(db, admin.id, "Other");
    const { token } = await createGroupInvite(db, { groupId: g.id, role: "member", createdBy: admin.id, ttlMs: 60_000 });
    expect(await revokeGroupInvite(db, other.id, token)).toBe(false);
    expect((await listGroupInvites(db, g.id))[0].revokedAt).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
tsc -b && pnpm exec vitest run dist/aggregator/__tests__/groupInvites.test.js
```
Expected: FAIL — `createGroupInvite` is not exported.

- [ ] **Step 3: Write the store**

Create `packages/aggregator/src/groupInvites.ts`:

```ts
// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
// Group invite links. Only sha256(token) is persisted, so a DB leak cannot join a group.
//
// Deliberately NOT delete-on-read like handoff_codes: a handoff code is a machine-to-machine
// one-shot, an invite is a link pasted into a chat and clicked by several people. It stays valid
// until it expires or an admin revokes it.
import { randomBytes, createHash } from "node:crypto";
import { and, eq, isNull, lt } from "drizzle-orm";
import type { AppDb } from "./schema.js";
import { groupInvites } from "./schema.js";
import { upsertGroupMember, type GroupRole } from "./groups.js";

const sha256hex = (s: string): string => createHash("sha256").update(s).digest("hex");

/** "gone" covers both expired and revoked: an admin who revokes a link and a link that timed out
 *  are the same story to the person clicking it, and the token is high-entropy so there is no
 *  enumeration oracle to protect. */
export type RedeemResult = "ok" | "not-found" | "gone";

export async function createGroupInvite(
  db: AppDb, opts: { groupId: string; role: GroupRole; createdBy: string; ttlMs: number },
): Promise<{ token: string; expiresAt: string }> {
  const token = randomBytes(24).toString("base64url");
  const expiresAt = new Date(Date.now() + opts.ttlMs);
  await db.insert(groupInvites).values({
    tokenHash: sha256hex(token), groupId: opts.groupId, role: opts.role, createdBy: opts.createdBy, expiresAt,
  });
  return { token, expiresAt: expiresAt.toISOString() };
}

/** Join the invite's group as its role, with source='invite'. Multi-use: the row survives redemption.
 *  Opportunistically sweeps invites that expired over a day ago so the table cannot grow unbounded. */
export async function redeemGroupInvite(
  db: AppDb, token: string, accountId: string, now: number = Date.now(),
): Promise<RedeemResult> {
  const rows = await db
    .select({ groupId: groupInvites.groupId, role: groupInvites.role, expiresAt: groupInvites.expiresAt, revokedAt: groupInvites.revokedAt })
    .from(groupInvites)
    .where(eq(groupInvites.tokenHash, sha256hex(token)))
    .limit(1);
  const row = rows[0];
  if (!row) return "not-found";
  if (row.revokedAt || new Date(row.expiresAt).getTime() <= now) return "gone";
  await upsertGroupMember(db, row.groupId, accountId, row.role as GroupRole, "invite");
  await db.delete(groupInvites).where(lt(groupInvites.expiresAt, new Date(now - 86_400_000)));
  return "ok";
}

/** Revoke, scoped to the group the caller administers — a token from another group is refused,
 *  so knowing a token is not enough to act on it. Returns false if nothing was revoked. */
export async function revokeGroupInvite(
  db: AppDb, groupId: string, token: string, now: number = Date.now(),
): Promise<boolean> {
  const rows = await db
    .update(groupInvites)
    .set({ revokedAt: new Date(now) })
    .where(and(eq(groupInvites.tokenHash, sha256hex(token)), eq(groupInvites.groupId, groupId), isNull(groupInvites.revokedAt)))
    .returning({ tokenHash: groupInvites.tokenHash });
  return rows.length > 0;
}

export async function listGroupInvites(
  db: AppDb, groupId: string,
): Promise<{ tokenHash: string; role: GroupRole; expiresAt: Date; revokedAt: Date | null }[]> {
  const rows = await db
    .select({ tokenHash: groupInvites.tokenHash, role: groupInvites.role, expiresAt: groupInvites.expiresAt, revokedAt: groupInvites.revokedAt })
    .from(groupInvites)
    .where(eq(groupInvites.groupId, groupId));
  return rows.map((r) => ({ ...r, role: r.role as GroupRole }));
}
```

- [ ] **Step 4: Export from the barrel**

In `packages/aggregator/src/index.ts`, after `export * from "./groups.js";`:

```ts
export * from "./groupInvites.js";
```

- [ ] **Step 5: Run test to verify it passes**

```bash
tsc -b && pnpm exec vitest run dist/aggregator/__tests__/groupInvites.test.js
```
Expected: PASS, 7 tests.

- [ ] **Step 6: Commit**

```bash
git add packages/aggregator/src/groupInvites.ts packages/aggregator/src/index.ts src/aggregator/__tests__/groupInvites.test.ts
git commit -m "feat(aggregator): multi-use group invite links, sha256-only"
```

---

### Task 4: Federated wiring — and the invariant that justifies `source`

**Files:**
- Modify: `packages/aggregator/src/githubApp.ts:18-42`
- Modify: `packages/aggregator/src/webAuth.ts` (add `captureOrgMemberships`)
- Modify: `packages/aggregator/src/binding.ts:70`
- Modify: `src/auth/install.ts:88`
- Modify: `src/githubApp/sync.ts:30-37, 95-102`
- Create: `src/aggregator/__tests__/groupFederation.test.ts`

**Interfaces:**
- Consumes: `ensureFederatedGroup`, `groupByScope`, `deleteSyncedMembers`, `replaceSyncedMembers`, `upsertGroupMember`, `removeGroupMember`, `accountIdForLogin` (Task 2); `setAccountScopes`, `ScopeGrant` (existing, `webAuth.ts:85`).
- Produces:
  ```ts
  // packages/aggregator/src/webAuth.ts
  captureOrgMemberships(db: AppDb, accountId: string, scopes: ScopeGrant[]): Promise<void>
  // packages/aggregator/src/groups.ts
  syncFederatedMemberships(db: AppDb, accountId: string, scopes: { scope: string; role: GroupRole }[]): Promise<void>
  ```

- [ ] **Step 1: Write the failing test**

Create `src/aggregator/__tests__/groupFederation.test.ts`. The third test is the one this whole column exists for.

```ts
// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
import { describe, it, expect } from "vitest";
import {
  makeTestDb, upsertAccount,
  upsertInstallation, deleteInstallation,
  groupByScope, listGroupMembers, upsertGroupMember, groupMemberRole,
  replaceSyncedMembers, captureOrgMemberships,
} from "@agentgem/aggregator";

const inst = (over = {}) => ({ installationId: 101, orgScope: "acme", repoSelection: "selected" as const, suspended: false, ...over });

describe("federated groups", () => {
  it("upsertInstallation creates the federated group for the org scope", async () => {
    const db = await makeTestDb();
    await upsertInstallation(db, inst({ orgScope: "Acme" }));
    const g = await groupByScope(db, "acme");
    expect(g).toMatchObject({ kind: "federated", scope: "acme" });
  });

  it("captureOrgMemberships materializes a sync row at sign-in", async () => {
    const db = await makeTestDb();
    await upsertInstallation(db, inst());
    const me = await upsertAccount(db, { provider: "github", accountId: "1", login: "neo" });
    await captureOrgMemberships(db, me.id, [{ scope: "neo", role: "self" }, { scope: "acme", role: "admin" }]);
    const g = (await groupByScope(db, "acme"))!;
    expect(await groupMemberRole(db, g.id, me.id)).toBe("admin");
    // "self" is the account's own login scope, not a group — it must not mint a group.
    expect(await groupByScope(db, "neo")).toBeNull();
  });

  it("INVARIANT: an invited guest survives a sync that removes every synced member", async () => {
    const db = await makeTestDb();
    await upsertInstallation(db, inst());
    const g = (await groupByScope(db, "acme"))!;
    const alice = await upsertAccount(db, { provider: "github", accountId: "1", login: "alice" });
    const guest = await upsertAccount(db, { provider: "github", accountId: "2", login: "guest" });

    await replaceSyncedMembers(db, g.id, [{ login: "alice", role: "member" }]);
    await upsertGroupMember(db, g.id, guest.id, "member", "invite");

    // Everyone leaves the GitHub org.
    await replaceSyncedMembers(db, g.id, []);

    expect(await groupMemberRole(db, g.id, alice.id)).toBeNull();
    expect(await groupMemberRole(db, g.id, guest.id)).toBe("member");
    expect((await listGroupMembers(db, g.id)).map((m) => m.login)).toEqual(["guest"]);
  });

  it("deleteInstallation drops sync rows but keeps the group and its guests", async () => {
    const db = await makeTestDb();
    await upsertInstallation(db, inst());
    const g = (await groupByScope(db, "acme"))!;
    const alice = await upsertAccount(db, { provider: "github", accountId: "1", login: "alice" });
    const guest = await upsertAccount(db, { provider: "github", accountId: "2", login: "guest" });
    await upsertGroupMember(db, g.id, alice.id, "member", "sync");
    await upsertGroupMember(db, g.id, guest.id, "member", "invite");

    await deleteInstallation(db, 101);

    expect(await groupByScope(db, "acme")).not.toBeNull();
    expect((await listGroupMembers(db, g.id)).map((m) => m.login)).toEqual(["guest"]);
  });

  it("captureOrgMemberships still writes account_scopes (it wraps, not replaces)", async () => {
    const db = await makeTestDb();
    const me = await upsertAccount(db, { provider: "github", accountId: "1", login: "neo" });
    await captureOrgMemberships(db, me.id, [{ scope: "neo", role: "self" }]);
    const { getAccountScopes } = await import("@agentgem/aggregator");
    expect((await getAccountScopes(db, me.id)).map((s) => s.scope)).toEqual(["neo"]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
tsc -b && pnpm exec vitest run dist/aggregator/__tests__/groupFederation.test.js
```
Expected: FAIL — `captureOrgMemberships` is not exported; `upsertInstallation` creates no group.

- [ ] **Step 3: Add `syncFederatedMemberships` to `groups.ts`**

Append to `packages/aggregator/src/groups.ts`:

```ts
/** Materialize this account's `source='sync'` rows from the org scopes captured at sign-in.
 *  Scopes with no federated group (the account's own login, or an org without the App) are skipped.
 *  Scopes the account no longer belongs to are dropped — sign-in is a full re-capture. */
export async function syncFederatedMemberships(
  db: AppDb, accountId: string, scopes: { scope: string; role: GroupRole }[],
): Promise<void> {
  const current = await db
    .select({ groupId: groupMembers.groupId })
    .from(groupMembers)
    .where(and(eq(groupMembers.accountId, accountId), eq(groupMembers.source, "sync")));
  const keep = new Set<string>();
  for (const s of scopes) {
    const g = await groupByScope(db, s.scope);
    if (!g) continue;
    keep.add(g.id);
    await upsertGroupMember(db, g.id, accountId, s.role, "sync");
  }
  for (const row of current) {
    if (!keep.has(row.groupId)) await removeGroupMember(db, row.groupId, accountId);
  }
}
```

- [ ] **Step 4: Add the `captureOrgMemberships` seam to `webAuth.ts`**

Append to `packages/aggregator/src/webAuth.ts`:

```ts
/** The one place sign-in turns a GitHub org list into durable state: captured scopes (the legacy
 *  gate) AND federated group membership (the new one). Both web login and device bind call this
 *  instead of setAccountScopes, so the two can never drift. A "self" grant is the account's own
 *  login, never a group. */
export async function captureOrgMemberships(db: AppDb, accountId: string, scopes: ScopeGrant[]): Promise<void> {
  await setAccountScopes(db, accountId, scopes);
  const orgs = scopes
    .map((g) => (typeof g === "string" ? { scope: g, role: "member" as const } : g))
    .filter((g) => g.role !== "self")
    .map((g) => ({ scope: g.scope, role: g.role === "admin" ? ("admin" as const) : ("member" as const) }));
  await syncFederatedMemberships(db, accountId, orgs);
}
```

Add the import at the top of `webAuth.ts`:

```ts
import { syncFederatedMemberships } from "./groups.js";
```

> **Note on module order:** `groups.ts` does not import `webAuth.ts`, so this is not a cycle. Keep it that way — if `groups.ts` ever needs a session, take the accountId as a parameter instead.

- [ ] **Step 5: Make `upsertInstallation` ensure the group, and `deleteInstallation` narrow its delete**

In `packages/aggregator/src/githubApp.ts`, add the import:

```ts
import { ensureFederatedGroup, groupByScope, deleteSyncedMembers } from "./groups.js";
```

Replace the body of `upsertInstallation` (lines 18-26) so it also mints the group:

```ts
export async function upsertInstallation(db: AppDb, inst: AppInstallation): Promise<void> {
  const orgScope = inst.orgScope.toLowerCase();
  await db.insert(appInstallations)
    .values({ installationId: inst.installationId, orgScope, repoSelection: inst.repoSelection, suspended: inst.suspended })
    .onConflictDoUpdate({
      target: appInstallations.installationId,
      set: { orgScope, repoSelection: inst.repoSelection, suspended: inst.suspended, updatedAt: sql`now()` },
    });
  // The federated group is the installation's shadow: it exists as soon as the org installs the App,
  // so a gem can be shared with it before anyone has signed in.
  await ensureFederatedGroup(db, orgScope);
}
```

Replace `deleteInstallation` (lines 33-42). Note what does **not** happen: the group row and its invited guests survive.

```ts
/** Uninstall = forget: the installation row, its synced members, and its private skill rows.
 *  The federated GROUP survives, with its invited guests and any gems shared with it — an invite
 *  was never GitHub's to revoke. Same `source='sync'` predicate as member-removal and reconcile. */
export async function deleteInstallation(db: AppDb, installationId: number): Promise<void> {
  const rows = await db.select({ orgScope: appInstallations.orgScope }).from(appInstallations)
    .where(eq(appInstallations.installationId, installationId)).limit(1);
  const orgScope = rows[0]?.orgScope;
  await db.delete(appInstallations).where(eq(appInstallations.installationId, installationId));
  if (orgScope) {
    await db.delete(orgMembers).where(eq(orgMembers.orgScope, orgScope));
    const g = await groupByScope(db, orgScope);
    if (g) await deleteSyncedMembers(db, g.id);
    await deleteOrgSkills(db, orgScope);
  }
}
```

- [ ] **Step 6: Run test to verify it passes**

```bash
tsc -b && pnpm exec vitest run dist/aggregator/__tests__/groupFederation.test.js
```
Expected: PASS, 5 tests.

- [ ] **Step 7: Point the two sign-in call sites at the seam**

In `packages/aggregator/src/binding.ts` line 70, replace `setAccountScopes(` with `captureOrgMemberships(` and fix the import on that file's import line (it currently imports `setAccountScopes` from `./webAuth.js`).

In `src/auth/install.ts` line 88, do the same: import `captureOrgMemberships` from `@agentgem/aggregator` instead of `setAccountScopes`, and call it.

- [ ] **Step 8: Mirror the webhook deltas into `group_members`**

In `src/githubApp/sync.ts`, extend the import at lines 8-12:

```ts
import {
  upsertInstallation, setInstallationSuspended, deleteInstallation, installationForScope, listInstallations,
  replaceOrgMembers, upsertOrgMember, deleteOrgMember, deleteOrgRepoSkills, pruneOrgSkills,
  groupByScope, replaceSyncedMembers, upsertGroupMember, removeGroupMember, accountIdForLogin,
  type AppDb, type AppInstallation,
} from "@agentgem/aggregator";
```

In `syncInstallation`, inside the existing `else` branch (the non-truncated path at lines 34-36), mirror the roster. Do **not** mirror when truncated — a partial replace would evict real members.

```ts
} else {
  await replaceOrgMembers(deps.db, inst.orgScope, members);
  const g = await groupByScope(deps.db, inst.orgScope);
  if (g) await replaceSyncedMembers(deps.db, g.id, members.map((m) => ({ login: m.login, role: m.role })));
}
```

In the `organization` webhook branch (lines 95-102), mirror the single-row deltas:

```ts
if (action === "member_added") {
  const role = membership?.role === "admin" ? "admin" as const : "member" as const;
  await upsertOrgMember(deps.db, org, login, role);
  const g = await groupByScope(deps.db, org);
  const accountId = g ? await accountIdForLogin(deps.db, login) : null;
  // No account yet: they have no session and can read nothing. Their row appears at first sign-in.
  if (g && accountId) await upsertGroupMember(deps.db, g.id, accountId, role, "sync");
} else if (action === "member_removed") {
  await deleteOrgMember(deps.db, org, login);
  const g = await groupByScope(deps.db, org);
  const accountId = g ? await accountIdForLogin(deps.db, login) : null;
  if (g && accountId) await removeGroupMember(deps.db, g.id, accountId);
}
return;
```

> **Known gap, accepted:** `member_removed` removes the row regardless of its `source`, so an org member who was *also* invited as a guest loses their guest status when they leave the org. `replaceSyncedMembers` (Step 3, Task 2) has the same collapse: a guest who is also an org member becomes `source='sync'`. Both follow from `(group_id, account_id)` being the primary key — one row per person per group. Making a person hold two rows would let a revoked employee keep access through a stale invite, which is worse. Note it in the code and move on.

- [ ] **Step 9: Run the full suite**

```bash
pnpm test
```
Expected: PASS. If `githubAppStore.test.js` or `webhook.test.js` now fail, they are asserting the old `deleteInstallation` behavior — read them before changing them.

- [ ] **Step 10: Commit**

```bash
git add packages/aggregator/src/groups.ts packages/aggregator/src/webAuth.ts packages/aggregator/src/githubApp.ts packages/aggregator/src/binding.ts src/auth/install.ts src/githubApp/sync.ts src/aggregator/__tests__/groupFederation.test.ts
git commit -m "feat(githubApp): mirror org membership into federated groups; guests survive sync"
```

---

### Task 5: HTTP routes

**Files:**
- Create: `src/groups/install.ts`
- Create: `src/groups/__tests__/install.test.ts`

**Interfaces:**
- Consumes: everything from Tasks 2 and 3; `resolveSession` (`webAuth.ts:44`); `SESSION_COOKIE`, `parseCookies` (`src/auth/cookie.ts`).
- Produces:
  ```ts
  interface GroupsDeps { db: AppDb; webOrigins: string[] }
  installGroups(expressApp: ExpressApp, deps: GroupsDeps): void
  ```

Routes, all under the originGuard-exempt `/api/catalog/` prefix (`src/originGuard.ts:64`), all query-param addressed to match `orgsApi.ts`:

| Method | Path | Auth | Behavior |
|---|---|---|---|
| `GET` | `/api/catalog/groups` | session | my groups, with role + source |
| `POST` | `/api/catalog/groups` | session | create a native group; creator is admin |
| `GET` | `/api/catalog/group-members?id=` | member | list members |
| `POST` | `/api/catalog/group-invites?id=` | **admin** | mint an invite; returns the raw token once |
| `DELETE` | `/api/catalog/group-invites?id=` | **admin** | revoke; token in `?token=` |
| `POST` | `/api/catalog/group-invite-redeem` | session | join; body `{ token }` |

- [ ] **Step 1: Write the failing test**

Create `src/groups/__tests__/install.test.ts`:

```ts
// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
import { describe, it, expect } from "vitest";
import { makeTestDb, upsertAccount, createSession, generateSessionToken, createNativeGroup, groupMemberRole } from "@agentgem/aggregator";
import type { AppDb } from "@agentgem/aggregator";
import { groupsHandler, groupMembersHandler, groupInvitesHandler, groupInviteRedeemHandler } from "../install.js";

const ORIGINS = ["https://app.agentgem.ai"];

function res() {
  const r: any = { code: 200, body: undefined as unknown, headers: {} as Record<string, string> };
  r.status = (c: number) => { r.code = c; return r; };
  r.set = (k: string, v: string) => { r.headers[k] = v; return r; };
  r.json = (b: unknown) => { r.body = b; return r; };
  r.send = (b: unknown) => { r.body = b; return r; };
  return r;
}
const req = (over: Record<string, unknown> = {}) =>
  ({ method: "GET", path: "/", query: {}, body: {}, headers: {}, ...over }) as any;

async function signedIn(db: AppDb, login: string) {
  const acct = await upsertAccount(db, { provider: "github", accountId: login, login });
  const { token } = generateSessionToken();
  await createSession(db, acct.id, token, 60_000);
  return { acct, headers: { authorization: `Bearer ${token}` } };
}

describe("groups routes", () => {
  it("GET /groups without a session → 401", async () => {
    const db = await makeTestDb();
    const r = res();
    await groupsHandler({ db, webOrigins: ORIGINS })(req(), r);
    expect(r.code).toBe(401);
  });

  it("POST /groups creates a native group and lists it", async () => {
    const db = await makeTestDb();
    const me = await signedIn(db, "neo");
    const deps = { db, webOrigins: ORIGINS };

    const c = res();
    await groupsHandler(deps)(req({ method: "POST", headers: me.headers, body: { name: "Friends" } }), c);
    expect(c.code).toBe(200);
    expect((c.body as any).group.name).toBe("Friends");

    const l = res();
    await groupsHandler(deps)(req({ headers: me.headers }), l);
    expect((l.body as any).groups).toHaveLength(1);
    expect((l.body as any).groups[0]).toMatchObject({ name: "Friends", role: "admin" });
  });

  it("POST /groups rejects an empty name → 400", async () => {
    const db = await makeTestDb();
    const me = await signedIn(db, "neo");
    const r = res();
    await groupsHandler({ db, webOrigins: ORIGINS })(req({ method: "POST", headers: me.headers, body: { name: "  " } }), r);
    expect(r.code).toBe(400);
  });

  it("GET /group-members from a non-member → 403", async () => {
    const db = await makeTestDb();
    const owner = await signedIn(db, "owner");
    const stranger = await signedIn(db, "stranger");
    const g = await createNativeGroup(db, owner.acct.id, "Secret");
    const r = res();
    await groupMembersHandler({ db, webOrigins: ORIGINS })(req({ headers: stranger.headers, query: { id: g.id } }), r);
    expect(r.code).toBe(403);
  });

  it("POST /group-invites from a non-admin member → 403", async () => {
    const db = await makeTestDb();
    const owner = await signedIn(db, "owner");
    const member = await signedIn(db, "member");
    const g = await createNativeGroup(db, owner.acct.id, "Club");
    const { upsertGroupMember } = await import("@agentgem/aggregator");
    await upsertGroupMember(db, g.id, member.acct.id, "member", "invite");
    const r = res();
    await groupInvitesHandler({ db, webOrigins: ORIGINS })(req({ method: "POST", headers: member.headers, query: { id: g.id }, body: {} }), r);
    expect(r.code).toBe(403);
  });

  it("admin mints an invite; another user redeems it and joins", async () => {
    const db = await makeTestDb();
    const owner = await signedIn(db, "owner");
    const joiner = await signedIn(db, "joiner");
    const g = await createNativeGroup(db, owner.acct.id, "Club");
    const deps = { db, webOrigins: ORIGINS };

    const mint = res();
    await groupInvitesHandler(deps)(req({ method: "POST", headers: owner.headers, query: { id: g.id }, body: { role: "member", ttlDays: 7 } }), mint);
    expect(mint.code).toBe(200);
    const token = (mint.body as any).token as string;
    expect(typeof token).toBe("string");

    const join = res();
    await groupInviteRedeemHandler(deps)(req({ method: "POST", headers: joiner.headers, body: { token } }), join);
    expect(join.code).toBe(200);
    expect(await groupMemberRole(db, g.id, joiner.acct.id)).toBe("member");
  });

  it("redeeming a revoked invite → 410", async () => {
    const db = await makeTestDb();
    const owner = await signedIn(db, "owner");
    const joiner = await signedIn(db, "joiner");
    const g = await createNativeGroup(db, owner.acct.id, "Club");
    const deps = { db, webOrigins: ORIGINS };

    const mint = res();
    await groupInvitesHandler(deps)(req({ method: "POST", headers: owner.headers, query: { id: g.id }, body: {} }), mint);
    const token = (mint.body as any).token as string;

    const rev = res();
    await groupInvitesHandler(deps)(req({ method: "DELETE", headers: owner.headers, query: { id: g.id, token } }), rev);
    expect(rev.code).toBe(200);

    const join = res();
    await groupInviteRedeemHandler(deps)(req({ method: "POST", headers: joiner.headers, body: { token } }), join);
    expect(join.code).toBe(410);
  });

  it("redeeming an unknown token → 404", async () => {
    const db = await makeTestDb();
    const joiner = await signedIn(db, "joiner");
    const r = res();
    await groupInviteRedeemHandler({ db, webOrigins: ORIGINS })(req({ method: "POST", headers: joiner.headers, body: { token: "bogus" } }), r);
    expect(r.code).toBe(404);
  });

  it("OPTIONS preflight is 204 and echoes an allowlisted origin", async () => {
    const db = await makeTestDb();
    const r = res();
    await groupsHandler({ db, webOrigins: ORIGINS })(req({ method: "OPTIONS", headers: { origin: "https://app.agentgem.ai" } }), r);
    expect(r.code).toBe(204);
    expect(r.headers["Access-Control-Allow-Origin"]).toBe("https://app.agentgem.ai");
    expect(r.headers["Access-Control-Allow-Credentials"]).toBe("true");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
tsc -b && pnpm exec vitest run dist/groups/__tests__/install.test.js
```
Expected: FAIL — `../install.js` does not exist.

- [ ] **Step 3: Write the routes**

Create `src/groups/install.ts`:

```ts
// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
// Group endpoints (raw express, like catalog/stars/orgsApi): reachable cross-site, own credentialed
// CORS, originGuard-exempt via the allowlisted /api/catalog/ prefix. Every route is authed (session
// cookie OR Bearer → 401). CSRF on writes is stopped by the SameSite=Lax session cookie + the 401,
// NOT by CORS.
//
// Membership is checked against group_members, never against a GitHub login — that is the point of
// the table. Invite mint/revoke are admin-gated; redeem needs only a session.
import type { AppDb } from "@agentgem/aggregator";
import {
  resolveSession, createNativeGroup, listGroupsForAccount, listGroupMembers, getGroup,
  groupMemberRole, createGroupInvite, redeemGroupInvite, revokeGroupInvite,
  type GroupRole,
} from "@agentgem/aggregator";
import { SESSION_COOKIE, parseCookies } from "../auth/cookie.js";

export interface GroupsDeps { db: AppDb; webOrigins: string[] }

interface Req { method: string; path: string; query: Record<string, unknown>; body: Record<string, unknown>; headers: Record<string, string | undefined> }
interface Res { status(c: number): Res; set(k: string, v: string): Res; json(b: unknown): Res; send(b: unknown): Res }
type ExpressApp = {
  get(p: string, h: (req: Req, res: Res) => unknown): unknown;
  post(p: string, h: (req: Req, res: Res) => unknown): unknown;
  delete(p: string, h: (req: Req, res: Res) => unknown): unknown;
  options(p: string, h: (req: Req, res: Res) => unknown): unknown;
};

const DEFAULT_INVITE_TTL_DAYS = 7;
const MAX_INVITE_TTL_DAYS = 30;

function cors(req: Req, res: Res, origins: string[]): void {
  const origin = req.headers["origin"];
  if (origin && origins.includes(origin)) {
    res.set("Access-Control-Allow-Origin", origin);
    res.set("Access-Control-Allow-Credentials", "true");
    res.set("Vary", "Origin");
  }
}
function preflight(res: Res): void {
  res.set("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS").set("Access-Control-Allow-Headers", "content-type, authorization").status(204).send("");
}

async function whoami(deps: GroupsDeps, req: Req): Promise<{ accountId: string; login: string } | null> {
  const auth = req.headers["authorization"];
  const bearer = auth && /^Bearer\s+/i.test(auth) ? auth.replace(/^Bearer\s+/i, "").trim() : "";
  const token = bearer || parseCookies(req.headers["cookie"])[SESSION_COOKIE];
  const who = token ? await resolveSession(deps.db, token) : null;
  return who ? { accountId: who.accountId, login: who.login } : null;
}

/** 401 → not signed in. Returns the caller, or null after responding. */
async function requireSession(deps: GroupsDeps, req: Req, res: Res): Promise<{ accountId: string; login: string } | null> {
  const who = await whoami(deps, req);
  if (!who) { res.status(401).json({ error: "sign in required" }); return null; }
  return who;
}

/** 401 / 404 / 403 gate for a group the caller must be in. `needAdmin` tightens it to admins.
 *  A group the caller cannot see is 404, not 403 — group ids should not be confirmable. */
async function requireGroupRole(
  deps: GroupsDeps, req: Req, res: Res, needAdmin: boolean,
): Promise<{ accountId: string; groupId: string } | null> {
  const who = await requireSession(deps, req, res);
  if (!who) return null;
  const groupId = String((req.query.id as string | undefined) ?? "");
  if (!groupId) { res.status(400).json({ error: "id required" }); return null; }
  if (!(await getGroup(deps.db, groupId))) { res.status(404).json({ error: "group not found" }); return null; }
  const role = await groupMemberRole(deps.db, groupId, who.accountId);
  if (!role) { res.status(403).json({ error: "not a member of this group" }); return null; }
  if (needAdmin && role !== "admin") { res.status(403).json({ error: "group admin required" }); return null; }
  return { accountId: who.accountId, groupId };
}

/** GET → my groups. POST {name} → create a native group (creator becomes admin). */
export function groupsHandler(deps: GroupsDeps) {
  return async (req: Req, res: Res): Promise<void> => {
    cors(req, res, deps.webOrigins);
    if (req.method === "OPTIONS") { preflight(res); return; }
    const who = await requireSession(deps, req, res);
    if (!who) return;
    if (req.method === "POST") {
      const name = String((req.body.name as string | undefined) ?? "").trim();
      if (!name || name.length > 80) { res.status(400).json({ error: "name required (1-80 chars)" }); return; }
      res.json({ group: await createNativeGroup(deps.db, who.accountId, name) });
      return;
    }
    res.json({ groups: await listGroupsForAccount(deps.db, who.accountId) });
  };
}

export function groupMembersHandler(deps: GroupsDeps) {
  return async (req: Req, res: Res): Promise<void> => {
    cors(req, res, deps.webOrigins);
    if (req.method === "OPTIONS") { preflight(res); return; }
    const ok = await requireGroupRole(deps, req, res, false);
    if (!ok) return;
    res.json({ members: await listGroupMembers(deps.db, ok.groupId) });
  };
}

/** POST → mint (admin). DELETE ?token= → revoke (admin). The raw token is returned exactly once. */
export function groupInvitesHandler(deps: GroupsDeps) {
  return async (req: Req, res: Res): Promise<void> => {
    cors(req, res, deps.webOrigins);
    if (req.method === "OPTIONS") { preflight(res); return; }
    const ok = await requireGroupRole(deps, req, res, true);
    if (!ok) return;

    if (req.method === "DELETE") {
      const token = String((req.query.token as string | undefined) ?? "");
      if (!token) { res.status(400).json({ error: "token required" }); return; }
      const revoked = await revokeGroupInvite(deps.db, ok.groupId, token);
      if (!revoked) { res.status(404).json({ error: "invite not found" }); return; }
      res.json({ revoked: true });
      return;
    }

    const role: GroupRole = req.body.role === "admin" ? "admin" : "member";
    const requested = Number(req.body.ttlDays ?? DEFAULT_INVITE_TTL_DAYS);
    const days = Number.isFinite(requested) && requested > 0 ? Math.min(requested, MAX_INVITE_TTL_DAYS) : DEFAULT_INVITE_TTL_DAYS;
    const invite = await createGroupInvite(deps.db, { groupId: ok.groupId, role, createdBy: ok.accountId, ttlMs: days * 86_400_000 });
    res.json(invite);
  };
}

/** POST {token} → join. Any signed-in user may redeem; the token is the authorization. */
export function groupInviteRedeemHandler(deps: GroupsDeps) {
  return async (req: Req, res: Res): Promise<void> => {
    cors(req, res, deps.webOrigins);
    if (req.method === "OPTIONS") { preflight(res); return; }
    const who = await requireSession(deps, req, res);
    if (!who) return;
    const token = String((req.body.token as string | undefined) ?? "");
    if (!token) { res.status(400).json({ error: "token required" }); return; }
    const result = await redeemGroupInvite(deps.db, token, who.accountId);
    if (result === "not-found") { res.status(404).json({ error: "invite not found" }); return; }
    if (result === "gone") { res.status(410).json({ error: "this invite has expired or been revoked" }); return; }
    res.json({ joined: true });
  };
}

export function installGroups(expressApp: ExpressApp, deps: GroupsDeps): void {
  expressApp.get("/api/catalog/groups", groupsHandler(deps));
  expressApp.post("/api/catalog/groups", groupsHandler(deps));
  expressApp.options("/api/catalog/groups", groupsHandler(deps));

  expressApp.get("/api/catalog/group-members", groupMembersHandler(deps));
  expressApp.options("/api/catalog/group-members", groupMembersHandler(deps));

  expressApp.post("/api/catalog/group-invites", groupInvitesHandler(deps));
  expressApp.delete("/api/catalog/group-invites", groupInvitesHandler(deps));
  expressApp.options("/api/catalog/group-invites", groupInvitesHandler(deps));

  expressApp.post("/api/catalog/group-invite-redeem", groupInviteRedeemHandler(deps));
  expressApp.options("/api/catalog/group-invite-redeem", groupInviteRedeemHandler(deps));
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
tsc -b && pnpm exec vitest run dist/groups/__tests__/install.test.js
```
Expected: PASS, 9 tests.

- [ ] **Step 5: Commit**

```bash
git add src/groups/install.ts src/groups/__tests__/install.test.ts
git commit -m "feat(groups): membership + invite routes under /api/catalog"
```

---

### Task 6: Mount and verify end-to-end

**Files:**
- Modify: `src/index.ts:65` (import), `src/index.ts:195-200` (mount)

**Interfaces:**
- Consumes: `installGroups`, `GroupsDeps` (Task 5).
- Produces: live routes.

- [ ] **Step 1: Add the import**

Next to the existing `installCatalog` import at `src/index.ts:65`:

```ts
import { installGroups } from "./groups/install.js";
```

- [ ] **Step 2: Mount inside the existing guarded block**

`src/index.ts:195-200` becomes:

```ts
// Stars + reviews + team usage need the DB + an allowlisted web origin; they don't need the GitHub OAuth secret.
if (aggDb && webOrigins.length > 0) {
  installStars(server.expressApp as never, { db: aggDb, webOrigins });
  installReviews(server.expressApp as never, { db: aggDb, webOrigins });
  installCatalog(server.expressApp as never, { db: aggDb, webOrigins });
  installGroups(server.expressApp as never, { db: aggDb, webOrigins });
  installUsage(server.expressApp as never, { db: aggDb, webOrigins });
}
```

- [ ] **Step 3: Full suite + typecheck**

```bash
pnpm clean && pnpm test
```
Expected: PASS. `pnpm test` runs `tsc -b` first, so this typechecks too. `pnpm clean` guards against stale `dist/` from the new files.

- [ ] **Step 4: Drive it for real**

Start the server with an aggregator DB and `AGENTGEM_WEB_ORIGINS` set, then:

```bash
# 401 without a session
curl -s -o /dev/null -w '%{http_code}\n' http://localhost:3000/api/catalog/groups
# → 401

# With a real Bearer token from ~/.agentgem/session.json
TOKEN=$(node -e "console.log(JSON.parse(require('fs').readFileSync(process.env.HOME + '/.agentgem/session.json','utf8')).sessionToken)")
curl -s -X POST http://localhost:3000/api/catalog/groups \
  -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d '{"name":"Friends"}'
# → {"group":{"id":"…","kind":"native","scope":null,"name":"Friends"}}

curl -s http://localhost:3000/api/catalog/groups -H "authorization: Bearer $TOKEN"
# → {"groups":[{"id":"…","name":"Friends","role":"admin","source":"invite"}]}
```

- [ ] **Step 5: Commit**

```bash
git add src/index.ts
git commit -m "feat: mount group routes"
```

---

## Self-Review

**Spec coverage.** Every Plan-1 clause maps to a task: three tables → Task 1; native groups + membership → Task 2; multi-use sha256 invites with expiry and revoke → Task 3; federated group per installation, sign-in materialization, the three narrowed delete paths → Task 4; routes on the credentialed prefix with 401/403/404/410 → Task 5; wiring → Task 6. The mandated invariant test ("an invited guest survives a sync that removes every synced member") appears twice on purpose: at the store level (Task 2, Step 1) and at the federation level (Task 4, Step 1), because they can regress independently.

**Out of scope, as agreed.** `catalog_gems.visibility`, `gem_shares`, `canReadGem`, the private read surface, and the three write-side guards are Plan 2. No task here touches `catalog_gems`, `publicGemCache`, or `PUBLIC_READ_PATHS`.

**Two accepted collapses**, both noted in code comments rather than hidden: a person holds at most one row per group, so (a) an org member who is also an invited guest becomes `source='sync'`, and (b) leaving the org removes them even though an invite existed. The alternative — two rows per person — would let a revoked employee retain access through a stale invite. Wrong trade.

**Type consistency.** `GroupRole`, `MemberSource`, `GroupKind`, and `Group` are defined once in `groups.ts` and imported everywhere. `redeemGroupInvite` returns `"ok" | "not-found" | "gone"`, and Task 5 maps exactly those three to 200/404/410.
