# Groups & Membership — Plan 1a: Native Groups (of 3)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship groups, membership, and invite links for **native** groups — created inside AgentGem, invite-only, addressed by uuid — touching zero existing behavior.

**Architecture:** Three new Postgres tables in `packages/aggregator`. Membership is a lattice of two independent grants (`via_sync`, `via_invite`) rather than one `source` enum, so the GitHub App (Plan 1b) can add and remove its own grant without ever disturbing an admin's invite. Routes hang off the existing `/api/catalog/*` prefix, which already has credentialed CORS and session resolution. Plan 1a writes only `via_invite`; `via_sync` exists in the schema and stays `false`.

**Tech Stack:** TypeScript (ESM, `.js` import specifiers), Drizzle ORM over Postgres, PGlite for tests, vitest, raw Express route modules.

**Spec:** `docs/superpowers/specs/2026-07-08-groups-and-private-gems-design.md`
**Sequels:** Plan 1b (`2026-07-08-groups-plan-1b-federation.md`) — federated groups + the GitHub App reconciler. Plan 2 — gem visibility and `gem_shares`.

**Reviewed:** `/plan-eng-review` 2026-07-08. Eleven issues found and folded in; see the review report at the bottom of this file.

## Global Constraints

- **Node `>= 24`.** No new runtime dependencies — `drizzle-orm` and `node:crypto` are already present.
- **ESM with explicit `.js` specifiers** in imports, even from `.ts` sources (`import { x } from "./groups.js"`).
- **Tests run against compiled `dist/`, not `src/`.** `pnpm test` is `tsc -b && vitest run`, and `vitest.config.ts` includes only `dist/**/__tests__/**/*.test.js`. Pointing vitest at a `src/**/*.test.ts` path matches nothing. After any file rename, run `pnpm clean` first or stale `dist/` output will run instead.
- **There are no drizzle-kit migrations.** `ensureSchema` in `packages/aggregator/src/schema.ts` is the DDL source of truth. A new table needs four edits: (1) the `pgTable` object, (2) an entry in the `schema` const at `schema.ts:269`, (3) `create table if not exists` in `ensureSchema`, (4) an alphabetized entry in `src/aggregator/__tests__/schema.test.ts`. Omitting (4) fails a test that looks unrelated to your change.
- **`CREATE TABLE IF NOT EXISTS` does not back-fill columns on an existing table.** Any column added to a pre-existing table needs a paired `alter table ... add column if not exists`. This plan adds no columns to existing tables.
- **Aggregator store code lives in `packages/aggregator/src/`; its tests live at repo-root `src/aggregator/__tests__/`** and import through the package name `@agentgem/aggregator`.
- **The aggregator barrel is `export * from "./<module>.js"`** with no named list (`packages/aggregator/src/index.ts`). A new module needs one new `export *` line.
- **`packages/console` tests and typecheck are NOT in CI.** This plan does not touch console.
- **Enum columns get DB `CHECK` constraints.** TypeScript unions do not survive a raw SQL path; the database is where invariants belong.
- **Denied reads return 404, never 403** — a 403 confirms existence. 403 is reserved for a caller who has already proven they can see the resource (a member who is not an admin).

---

## The membership lattice

`source` was the wrong abstraction. A person can hold a GitHub-org grant *and* an admin's invite at the same time, and the two are owned by different authorities. Collapsing them into one column means whichever authority writes last silently destroys the other's grant — so a contractor who is invited, later hired into the org, and later still leaves the company loses the guest access an admin explicitly gave them.

Two independent bits, each owned by exactly one authority:

```
                       via_sync            via_invite
                   (GitHub App owns)     (a group admin owns)
                   ─────────────────     ────────────────────
pure org member          true                  false      ← leaves org → row deleted
invited guest            false                 true       ← leaves org → nothing happens
hired contractor         true                  true       ← leaves org → still a guest ✓
                                                          ← invite revoked → still an org member ✓
neither                  false                 false      ← forbidden by CHECK; row is deleted

effective role = max(sync_role, invite_role)   with admin > member

    reconciler (Plan 1b)   UPDATE via_sync=false, sync_role=null   WHERE group_id=?
    revoke invite          UPDATE via_invite=false, invite_role=null WHERE group_id=? AND account_id=?
    both                   DELETE WHERE NOT via_sync AND NOT via_invite   ← the row disappears
                                                                            only when nobody grants
```

Neither authority can revoke the other's grant. That is the whole design.

---

## Invite lifecycle

```
   admin POST /group-invites
            │  mints raw token (32B base64url), stores sha256 ONLY
            │  returns { id, token } — the token is shown exactly ONCE
            ▼
      ┌──────────┐   redeem (any signed-in user, MULTI-use)   ┌───────────────┐
      │  ACTIVE  │ ─────────────────────────────────────────► │ grant via_invite│
      └──────────┘                                            └───────────────┘
        │      │
        │      └── expires_at passes ──────────► GONE ── redeem → 410
        │
        └── admin DELETE /group-invites?invite=<id> ──► REVOKED ── redeem → 410
                     ▲
                     └─ revoked BY ID. The raw token is never in a URL, never in a log,
                        and cannot be recovered from the stored hash. An admin who lost
                        the link can still revoke it.

   unknown token ──► 404   (indistinguishable from a token for another group)
```

---

### Task 1: Schema — three tables

**Files:**
- Modify: `packages/aggregator/src/schema.ts`
- Modify: `src/aggregator/__tests__/schema.test.ts:12-13`

**Interfaces:**
- Consumes: nothing.
- Produces: drizzle tables `groups`, `groupMembers`, `groupInvites`, exported from `@agentgem/aggregator` via the existing `export * from "./schema.js"`.

- [ ] **Step 1: Write the failing test**

In `src/aggregator/__tests__/schema.test.ts`, add the three names to the sorted array. Postgres `order by 1` places them between `gem_archives` and `handoff_codes`, in this order: `group_invites`, `group_members`, `groups`. (Verify empirically in Step 6 — if the collation orders them differently, take the actual output, do not argue with it.)

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
//
//   kind 'federated' — mirrors an external network. Identity is `installation_id` (survives GitHub
//                      org renames); `scope` is MUTABLE display/lookup metadata, not the key.
//   kind 'native'    — created inside AgentGem. No installation, no scope, uuid-addressed.
//
// The check constraint IS the definition: a federated group is exactly one with an installation.
export const groups = pgTable("groups", {
  id: uuid("id").primaryKey(),
  kind: text("kind").notNull(),
  installationId: bigint("installation_id", { mode: "number" }).unique(),
  scope: text("scope").unique(),
  name: text("name").notNull(),
  createdBy: uuid("created_by").references(() => accounts.id),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

// Membership is a LATTICE of two independent grants, not one `source` enum.
//
//   via_sync   — owned exclusively by the GitHub App reconciler (Plan 1b)
//   via_invite — owned exclusively by a group admin
//
// Neither authority may clear the other's bit. The row exists while either bit is set, and is
// deleted when both clear. This is what lets an invited contractor who was later hired into the
// org keep their guest access after they leave the company: leaving clears via_sync, and via_invite
// still stands. A single `source` column would have destroyed that grant on the first sync.
//
// Effective role = max(sync_role, invite_role), admin > member.
export const groupMembers = pgTable("group_members", {
  groupId: uuid("group_id").notNull().references(() => groups.id, { onDelete: "cascade" }),
  accountId: uuid("account_id").notNull().references(() => accounts.id),
  viaSync: boolean("via_sync").notNull().default(false),
  viaInvite: boolean("via_invite").notNull().default(false),
  syncRole: text("sync_role"),
  inviteRole: text("invite_role"),
  addedAt: timestamp("added_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [primaryKey({ columns: [t.groupId, t.accountId] })]);

// Multi-use until expiry or revocation — a link pasted into a chat, not a one-shot machine code.
// `id` is the public handle: it is what an admin sees, and what revoke takes. Only sha256(token)
// is stored, so a DB leak cannot join a group, and revocation never needs the raw token back.
// (Contrast handoff_codes, which is delete-on-read; the storage discipline is shared, not the
// lifecycle.)
export const groupInvites = pgTable("group_invites", {
  id: uuid("id").primaryKey(),
  tokenHash: text("token_hash").notNull().unique(),
  groupId: uuid("group_id").notNull().references(() => groups.id, { onDelete: "cascade" }),
  role: text("role").notNull().default("member"),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  createdBy: uuid("created_by").notNull().references(() => accounts.id),
  revokedAt: timestamp("revoked_at", { withTimezone: true }),
});
```

Add `bigint` and `boolean` to the drizzle import at the top of `schema.ts` if not already present (they are — `appInstallations` uses both).

- [ ] **Step 4: Register them in the `schema` const**

Replace `schema.ts:269`:

```ts
export const schema = { producers, attestations, ingredients, usageEdges, modelOutcomes, accountBindings, shareCards, apiKeys, accounts, webSessions, handoffCodes, stars, reviews, gemAdoptions, accountScopes, usageDays, usageDayModels, orgSettings, catalogGems, gemArchives, curatedSkills, appInstallations, orgMembers, groups, groupMembers, groupInvites };
```

- [ ] **Step 5: Add the DDL, with every invariant expressed as a CHECK**

In `ensureSchema`, immediately after the `org_members` create (currently `schema.ts:327`):

```ts
await db.execute(sql`create table if not exists groups (
  id uuid primary key,
  kind text not null check (kind in ('federated','native')),
  installation_id bigint unique,
  scope text unique,
  name text not null,
  created_by uuid references accounts(id),
  created_at timestamptz not null default now(),
  constraint groups_kind_installation check ((kind = 'federated') = (installation_id is not null))
)`);
await db.execute(sql`create table if not exists group_members (
  group_id uuid not null references groups(id) on delete cascade,
  account_id uuid not null references accounts(id),
  via_sync boolean not null default false,
  via_invite boolean not null default false,
  sync_role text check (sync_role in ('admin','member')),
  invite_role text check (invite_role in ('admin','member')),
  added_at timestamptz not null default now(),
  primary key (group_id, account_id),
  constraint group_members_some_grant check (via_sync or via_invite),
  constraint group_members_sync_role check (via_sync = (sync_role is not null)),
  constraint group_members_invite_role check (via_invite = (invite_role is not null))
)`);
await db.execute(sql`create index if not exists group_members_account_idx on group_members (account_id)`);
await db.execute(sql`create table if not exists group_invites (
  id uuid primary key,
  token_hash text not null unique,
  group_id uuid not null references groups(id) on delete cascade,
  role text not null check (role in ('admin','member')),
  expires_at timestamptz not null,
  created_by uuid not null references accounts(id),
  revoked_at timestamptz
)`);
await db.execute(sql`create index if not exists group_invites_group_idx on group_invites (group_id)`);
// Login → account lookup for the Plan 1b federated member sync. accounts.login keeps GitHub's casing.
await db.execute(sql`create index if not exists accounts_login_lower_idx on accounts (lower(login))`);
```

- [ ] **Step 6: Run test to verify it passes, and read the real sort order**

```bash
tsc -b && pnpm exec vitest run dist/aggregator/__tests__/schema.test.js
```
Expected: PASS. If it fails only on ordering, copy the actual array from the diff — the collation, not the plan, is authoritative.

- [ ] **Step 7: Prove every constraint rejects what it claims to**

Add to `src/aggregator/__tests__/schema.test.ts`:

```ts
it("groups: kind is a closed set, and federated iff installation_id", async () => {
  const db = await makeTestDb();
  const g = sql`insert into groups (id, kind, installation_id, scope, name) values`;
  await expect(db.execute(sql`${g} (gen_random_uuid(), 'garbage', null, null, 'x')`)).rejects.toThrow();
  await expect(db.execute(sql`${g} (gen_random_uuid(), 'native', 101, null, 'x')`)).rejects.toThrow();
  await expect(db.execute(sql`${g} (gen_random_uuid(), 'federated', null, 'acme', 'x')`)).rejects.toThrow();
  await expect(db.execute(sql`${g} (gen_random_uuid(), 'native', null, null, 'ok')`)).resolves.toBeDefined();
});

it("group_members: a row with no grant cannot exist, and roles track their flags", async () => {
  const db = await makeTestDb();
  const acct = await upsertAccount(db, { provider: "github", accountId: "1", login: "neo" });
  const rows = await db.execute(sql`insert into groups (id, kind, name) values (gen_random_uuid(), 'native', 'g') returning id`);
  const gid = (rows.rows as { id: string }[])[0].id;
  const m = sql`insert into group_members (group_id, account_id, via_sync, via_invite, sync_role, invite_role) values`;
  // no grant at all
  await expect(db.execute(sql`${m} (${gid}, ${acct.id}, false, false, null, null)`)).rejects.toThrow();
  // via_invite set but no invite_role
  await expect(db.execute(sql`${m} (${gid}, ${acct.id}, false, true, null, null)`)).rejects.toThrow();
  // invite_role set but via_invite false
  await expect(db.execute(sql`${m} (${gid}, ${acct.id}, false, false, null, 'member')`)).rejects.toThrow();
  // role outside the closed set
  await expect(db.execute(sql`${m} (${gid}, ${acct.id}, false, true, null, 'owner')`)).rejects.toThrow();
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
  interface Group { id: string; kind: GroupKind; installationId: number | null; scope: string | null; name: string }
  interface GroupMember { accountId: string; login: string; avatarUrl: string | null; role: GroupRole; viaSync: boolean; viaInvite: boolean }

  RANK: Record<GroupRole, number>                       // member: 0, admin: 1
  createNativeGroup(db, createdBy, name): Promise<Group>
  getGroup(db, groupId): Promise<Group | null>
  deleteNativeGroup(db, groupId): Promise<"deleted" | "federated" | "not-found">
  listGroupsForAccount(db, accountId): Promise<(Group & { role: GroupRole })[]>
  listGroupMembers(db, groupId): Promise<GroupMember[]>
  groupMemberRole(db, groupId, accountId): Promise<GroupRole | null>
  countGroupAdmins(db, groupId): Promise<number>
  grantInvite(db, groupId, accountId, role): Promise<void>      // never lowers a role
  revokeInviteGrant(db, groupId, accountId): Promise<void>      // deletes row if no via_sync
  ```

- [ ] **Step 1: Write the failing test**

Create `src/aggregator/__tests__/groups.test.ts`:

```ts
// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
import { describe, it, expect } from "vitest";
import { sql } from "drizzle-orm";
import {
  makeTestDb, upsertAccount,
  createNativeGroup, getGroup, deleteNativeGroup, listGroupsForAccount, listGroupMembers,
  groupMemberRole, countGroupAdmins, grantInvite, revokeInviteGrant,
} from "@agentgem/aggregator";

const acct = (db: any, n: string) => upsertAccount(db, { provider: "github", accountId: n, login: n });

describe("groups store", () => {
  it("createNativeGroup: no installation, no scope, creator is admin by invite", async () => {
    const db = await makeTestDb();
    const me = await acct(db, "neo");
    const g = await createNativeGroup(db, me.id, "Friends");
    expect(g.kind).toBe("native");
    expect(g.scope).toBeNull();
    expect(g.installationId).toBeNull();
    expect(await groupMemberRole(db, g.id, me.id)).toBe("admin");
    expect((await listGroupMembers(db, g.id))[0]).toMatchObject({ login: "neo", role: "admin", viaInvite: true, viaSync: false });
    expect((await getGroup(db, g.id))?.name).toBe("Friends");
  });

  it("listGroupsForAccount returns only groups you are in", async () => {
    const db = await makeTestDb();
    const me = await acct(db, "neo");
    const other = await acct(db, "trin");
    const mine = await createNativeGroup(db, me.id, "Mine");
    await createNativeGroup(db, other.id, "Theirs");
    const rows = await listGroupsForAccount(db, me.id);
    expect(rows.map((r) => r.name)).toEqual(["Mine"]);
    expect(rows[0]).toMatchObject({ id: mine.id, role: "admin" });
  });

  it("grantInvite inserts, and PROMOTES member → admin", async () => {
    const db = await makeTestDb();
    const owner = await acct(db, "owner");
    const joiner = await acct(db, "joiner");
    const g = await createNativeGroup(db, owner.id, "G");
    await grantInvite(db, g.id, joiner.id, "member");
    expect(await groupMemberRole(db, g.id, joiner.id)).toBe("member");
    await grantInvite(db, g.id, joiner.id, "admin");
    expect(await groupMemberRole(db, g.id, joiner.id)).toBe("admin");
  });

  it("grantInvite NEVER lowers a role — an admin clicking a member link stays admin", async () => {
    const db = await makeTestDb();
    const owner = await acct(db, "owner");
    const g = await createNativeGroup(db, owner.id, "G");
    await grantInvite(db, g.id, owner.id, "member");   // owner clicks their own member-invite link
    expect(await groupMemberRole(db, g.id, owner.id)).toBe("admin");
    expect(await countGroupAdmins(db, g.id)).toBe(1);
  });

  it("revokeInviteGrant deletes the row when no sync grant remains", async () => {
    const db = await makeTestDb();
    const owner = await acct(db, "owner");
    const guest = await acct(db, "guest");
    const g = await createNativeGroup(db, owner.id, "G");
    await grantInvite(db, g.id, guest.id, "member");
    await revokeInviteGrant(db, g.id, guest.id);
    expect(await groupMemberRole(db, g.id, guest.id)).toBeNull();
    expect((await listGroupMembers(db, g.id)).map((m) => m.login)).toEqual(["owner"]);
  });

  it("revokeInviteGrant KEEPS the row when a sync grant remains", async () => {
    const db = await makeTestDb();
    const owner = await acct(db, "owner");
    const hire = await acct(db, "hire");
    const g = await createNativeGroup(db, owner.id, "G");
    await grantInvite(db, g.id, hire.id, "admin");
    // simulate Plan 1b having also granted via_sync
    await db.execute(sql`update group_members set via_sync = true, sync_role = 'member' where account_id = ${hire.id}`);
    await revokeInviteGrant(db, g.id, hire.id);
    expect(await groupMemberRole(db, g.id, hire.id)).toBe("member");   // demoted to the sync grant, not removed
    expect((await listGroupMembers(db, g.id)).find((m) => m.login === "hire")).toMatchObject({ viaSync: true, viaInvite: false });
  });

  it("effective role is the max of both grants", async () => {
    const db = await makeTestDb();
    const owner = await acct(db, "owner");
    const p = await acct(db, "p");
    const g = await createNativeGroup(db, owner.id, "G");
    await grantInvite(db, g.id, p.id, "admin");
    await db.execute(sql`update group_members set via_sync = true, sync_role = 'member' where account_id = ${p.id}`);
    expect(await groupMemberRole(db, g.id, p.id)).toBe("admin");
  });

  it("countGroupAdmins counts effective admins", async () => {
    const db = await makeTestDb();
    const owner = await acct(db, "owner");
    const m = await acct(db, "m");
    const g = await createNativeGroup(db, owner.id, "G");
    await grantInvite(db, g.id, m.id, "member");
    expect(await countGroupAdmins(db, g.id)).toBe(1);
    await grantInvite(db, g.id, m.id, "admin");
    expect(await countGroupAdmins(db, g.id)).toBe(2);
  });

  it("deleteNativeGroup cascades members and invites; refuses federated; 'not-found' otherwise", async () => {
    const db = await makeTestDb();
    const owner = await acct(db, "owner");
    const g = await createNativeGroup(db, owner.id, "G");
    await db.execute(sql`insert into groups (id, kind, installation_id, name) values (gen_random_uuid(), 'federated', 101, 'acme')`);
    const fed = (await db.execute(sql`select id from groups where kind = 'federated'`)).rows as { id: string }[];

    expect(await deleteNativeGroup(db, fed[0].id)).toBe("federated");
    expect(await deleteNativeGroup(db, "00000000-0000-0000-0000-000000000000")).toBe("not-found");
    expect(await deleteNativeGroup(db, g.id)).toBe("deleted");
    expect(await getGroup(db, g.id)).toBeNull();
    const left = await db.execute(sql`select count(*)::int as n from group_members where group_id = ${g.id}`);
    expect((left.rows as { n: number }[])[0].n).toBe(0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
tsc -b && pnpm exec vitest run dist/aggregator/__tests__/groups.test.js
```
Expected: FAIL — `tsc -b` errors that `createNativeGroup` etc. are not exported from `@agentgem/aggregator`.

- [ ] **Step 3: Write the store**

Create `packages/aggregator/src/groups.ts`:

```ts
// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
// Group + membership store.
//
// Membership is a LATTICE of two independent grants, not one `source` enum:
//
//                    via_sync            via_invite
//                (GitHub App owns)    (a group admin owns)
//   org member         true                 false      leaves org → row deleted
//   invited guest      false                true       leaves org → nothing happens
//   hired contractor   true                 true       leaves org → STILL a guest
//   nobody             false                false      forbidden by CHECK; row deleted
//
// Neither authority may clear the other's bit. That is the whole design: a single `source`
// column let whichever authority wrote last silently destroy the other's grant.
//
// This module owns via_invite. Plan 1b's groupsFederation.ts owns via_sync. Effective role is
// max(sync_role, invite_role) with admin > member.
import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import type { AppDb } from "./schema.js";
import { accounts, groups, groupMembers } from "./schema.js";

export type GroupKind = "federated" | "native";
export type GroupRole = "admin" | "member";

export const RANK: Record<GroupRole, number> = { member: 0, admin: 1 };

export interface Group { id: string; kind: GroupKind; installationId: number | null; scope: string | null; name: string }
export interface GroupMember { accountId: string; login: string; avatarUrl: string | null; role: GroupRole; viaSync: boolean; viaInvite: boolean }

const groupCols = { id: groups.id, kind: groups.kind, installationId: groups.installationId, scope: groups.scope, name: groups.name };

const asGroup = (r: { id: string; kind: string; installationId: number | null; scope: string | null; name: string }): Group =>
  ({ id: r.id, kind: r.kind as GroupKind, installationId: r.installationId, scope: r.scope, name: r.name });

/** Effective role: the stronger of the two grants. A row always has at least one (CHECK). */
export const effectiveRole = (r: { syncRole: string | null; inviteRole: string | null }): GroupRole =>
  r.syncRole === "admin" || r.inviteRole === "admin" ? "admin" : "member";

/** Create a native group. The creator becomes its first admin, by invite grant. */
export async function createNativeGroup(db: AppDb, createdBy: string, name: string): Promise<Group> {
  const rows = await db
    .insert(groups)
    .values({ id: randomUUID(), kind: "native", installationId: null, scope: null, name, createdBy })
    .returning(groupCols);
  const g = asGroup(rows[0]);
  await grantInvite(db, g.id, createdBy, "admin");
  return g;
}

export async function getGroup(db: AppDb, groupId: string): Promise<Group | null> {
  const rows = await db.select(groupCols).from(groups).where(eq(groups.id, groupId)).limit(1);
  return rows[0] ? asGroup(rows[0]) : null;
}

/** Only native groups may be deleted here. A federated group belongs to its installation, and
 *  deleteInstallation (Plan 1b) decides its fate — deleting it by hand would orphan gem_shares
 *  the moment the App reinstalls. */
export async function deleteNativeGroup(db: AppDb, groupId: string): Promise<"deleted" | "federated" | "not-found"> {
  const g = await getGroup(db, groupId);
  if (!g) return "not-found";
  if (g.kind === "federated") return "federated";
  await db.delete(groups).where(eq(groups.id, groupId));   // members + invites cascade
  return "deleted";
}

export async function listGroupsForAccount(db: AppDb, accountId: string): Promise<(Group & { role: GroupRole })[]> {
  const rows = await db
    .select({ ...groupCols, syncRole: groupMembers.syncRole, inviteRole: groupMembers.inviteRole })
    .from(groupMembers)
    .innerJoin(groups, eq(groupMembers.groupId, groups.id))
    .where(eq(groupMembers.accountId, accountId));
  return rows.map((r) => ({ ...asGroup(r), role: effectiveRole(r) }));
}

export async function listGroupMembers(db: AppDb, groupId: string): Promise<GroupMember[]> {
  const rows = await db
    .select({
      accountId: accounts.id, login: accounts.login, avatarUrl: accounts.avatarUrl,
      viaSync: groupMembers.viaSync, viaInvite: groupMembers.viaInvite,
      syncRole: groupMembers.syncRole, inviteRole: groupMembers.inviteRole,
    })
    .from(groupMembers)
    .innerJoin(accounts, eq(groupMembers.accountId, accounts.id))
    .where(eq(groupMembers.groupId, groupId));
  return rows.map((r) => ({
    accountId: r.accountId, login: r.login, avatarUrl: r.avatarUrl,
    role: effectiveRole(r), viaSync: r.viaSync, viaInvite: r.viaInvite,
  }));
}

export async function groupMemberRole(db: AppDb, groupId: string, accountId: string): Promise<GroupRole | null> {
  const rows = await db
    .select({ syncRole: groupMembers.syncRole, inviteRole: groupMembers.inviteRole })
    .from(groupMembers)
    .where(and(eq(groupMembers.groupId, groupId), eq(groupMembers.accountId, accountId)))
    .limit(1);
  return rows[0] ? effectiveRole(rows[0]) : null;
}

/** Effective admins. The last-admin guard reads this before removing or demoting anyone. */
export async function countGroupAdmins(db: AppDb, groupId: string): Promise<number> {
  const rows = await db.execute(sql`
    select count(*)::int as n from group_members
    where group_id = ${groupId} and (sync_role = 'admin' or invite_role = 'admin')`);
  return (rows.rows as { n: number }[])[0].n;
}

/** Grant (or raise) an invite membership. NEVER lowers an existing invite_role: an invite hands
 *  access out, it must not take any away. An admin who clicks their own member-invite link to
 *  check it works would otherwise demote themselves — and if they were the only admin, lock the
 *  group permanently. `greatest` is computed in SQL so a concurrent redeem cannot lose a promotion. */
export async function grantInvite(db: AppDb, groupId: string, accountId: string, role: GroupRole): Promise<void> {
  await db.execute(sql`
    insert into group_members (group_id, account_id, via_invite, invite_role)
    values (${groupId}, ${accountId}, true, ${role})
    on conflict (group_id, account_id) do update set
      via_invite = true,
      invite_role = case
        when group_members.invite_role = 'admin' then 'admin'
        else ${role}
      end`);
}

/** Clear the invite grant. The row survives iff the App still grants via_sync — revoking an invite
 *  must not evict someone who is also in the GitHub org. */
export async function revokeInviteGrant(db: AppDb, groupId: string, accountId: string): Promise<void> {
  await db
    .update(groupMembers)
    .set({ viaInvite: false, inviteRole: null })
    .where(and(eq(groupMembers.groupId, groupId), eq(groupMembers.accountId, accountId), eq(groupMembers.viaSync, true)));
  await db
    .delete(groupMembers)
    .where(and(eq(groupMembers.groupId, groupId), eq(groupMembers.accountId, accountId), eq(groupMembers.viaSync, false)));
}
```

- [ ] **Step 4: Export from the barrel**

In `packages/aggregator/src/index.ts`, after `export * from "./githubApp.js";`:

```ts
export * from "./groups.js";
```

- [ ] **Step 5: Run test to verify it passes**

```bash
tsc -b && pnpm exec vitest run dist/aggregator/__tests__/groups.test.js
```
Expected: PASS, 9 tests.

- [ ] **Step 6: Commit**

```bash
git add packages/aggregator/src/groups.ts packages/aggregator/src/index.ts src/aggregator/__tests__/groups.test.ts
git commit -m "feat(aggregator): group store with the via_sync/via_invite membership lattice"
```

---

### Task 3: Invite store

**Files:**
- Create: `packages/aggregator/src/groupInvites.ts`
- Create: `src/aggregator/__tests__/groupInvites.test.ts`
- Modify: `packages/aggregator/src/index.ts`

**Interfaces:**
- Consumes: `groupInvites` table (Task 1); `grantInvite`, `GroupRole` (Task 2).
- Produces:
  ```ts
  type RedeemResult = "ok" | "not-found" | "gone";
  interface InviteSummary { id: string; role: GroupRole; expiresAt: Date; revokedAt: Date | null }

  createGroupInvite(db, opts: { groupId; role; createdBy; ttlMs }): Promise<{ id: string; token: string; expiresAt: string }>
  redeemGroupInvite(db, token, accountId, now?): Promise<RedeemResult>
  revokeGroupInvite(db, groupId, inviteId, now?): Promise<boolean>
  listGroupInvites(db, groupId): Promise<InviteSummary[]>     // NEVER returns token_hash
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
  makeTestDb, upsertAccount, createNativeGroup, deleteNativeGroup, groupMemberRole,
  createGroupInvite, redeemGroupInvite, revokeGroupInvite, listGroupInvites,
} from "@agentgem/aggregator";

const seed = async () => {
  const db = await makeTestDb();
  const admin = await upsertAccount(db, { provider: "github", accountId: "1", login: "admin" });
  const g = await createNativeGroup(db, admin.id, "Friends");
  return { db, admin, g };
};
const acct = (db: any, n: string) => upsertAccount(db, { provider: "github", accountId: n, login: n });

describe("group invites", () => {
  it("stores only sha256(token), never the token", async () => {
    const { db, admin, g } = await seed();
    const { token, id } = await createGroupInvite(db, { groupId: g.id, role: "member", createdBy: admin.id, ttlMs: 60_000 });
    const rows = await db.execute(sql`select id, token_hash from group_invites`);
    const r = (rows.rows as { id: string; token_hash: string }[])[0];
    expect(r.token_hash).toBe(createHash("sha256").update(token).digest("hex"));
    expect(r.token_hash).not.toBe(token);
    expect(r.id).toBe(id);
  });

  it("listGroupInvites returns ids and NEVER a token_hash", async () => {
    const { db, admin, g } = await seed();
    const { id } = await createGroupInvite(db, { groupId: g.id, role: "admin", createdBy: admin.id, ttlMs: 60_000 });
    const list = await listGroupInvites(db, g.id);
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ id, role: "admin", revokedAt: null });
    expect(JSON.stringify(list)).not.toContain("token");
  });

  it("is MULTI-use: two people redeem the same link", async () => {
    const { db, admin, g } = await seed();
    const a = await acct(db, "a");
    const b = await acct(db, "b");
    const { token } = await createGroupInvite(db, { groupId: g.id, role: "member", createdBy: admin.id, ttlMs: 60_000 });
    expect(await redeemGroupInvite(db, token, a.id)).toBe("ok");
    expect(await redeemGroupInvite(db, token, b.id)).toBe("ok");
    expect(await groupMemberRole(db, g.id, a.id)).toBe("member");
    expect(await groupMemberRole(db, g.id, b.id)).toBe("member");
  });

  it("redeem grants via_invite with the invite's role", async () => {
    const { db, admin, g } = await seed();
    const a = await acct(db, "a");
    const { token } = await createGroupInvite(db, { groupId: g.id, role: "admin", createdBy: admin.id, ttlMs: 60_000 });
    expect(await redeemGroupInvite(db, token, a.id)).toBe("ok");
    expect(await groupMemberRole(db, g.id, a.id)).toBe("admin");
    const rows = await db.execute(sql`select via_invite, via_sync from group_members where account_id = ${a.id}`);
    expect((rows.rows as { via_invite: boolean; via_sync: boolean }[])[0]).toEqual({ via_invite: true, via_sync: false });
  });

  it("redeem NEVER demotes: the admin clicks their own member link", async () => {
    const { db, admin, g } = await seed();
    const { token } = await createGroupInvite(db, { groupId: g.id, role: "member", createdBy: admin.id, ttlMs: 60_000 });
    expect(await redeemGroupInvite(db, token, admin.id)).toBe("ok");
    expect(await groupMemberRole(db, g.id, admin.id)).toBe("admin");
  });

  it("expired → 'gone'", async () => {
    const { db, admin, g } = await seed();
    const a = await acct(db, "a");
    const { token } = await createGroupInvite(db, { groupId: g.id, role: "member", createdBy: admin.id, ttlMs: 1_000 });
    expect(await redeemGroupInvite(db, token, a.id, Date.now() + 5_000)).toBe("gone");
    expect(await groupMemberRole(db, g.id, a.id)).toBeNull();
  });

  it("revoke by ID — no raw token needed — then redeem → 'gone'", async () => {
    const { db, admin, g } = await seed();
    const a = await acct(db, "a");
    const { token, id } = await createGroupInvite(db, { groupId: g.id, role: "member", createdBy: admin.id, ttlMs: 60_000 });
    expect(await revokeGroupInvite(db, g.id, id)).toBe(true);
    expect(await redeemGroupInvite(db, token, a.id)).toBe("gone");
    expect((await listGroupInvites(db, g.id))[0].revokedAt).not.toBeNull();
  });

  it("revoking twice is idempotent-false; revoking another group's invite is refused", async () => {
    const { db, admin, g } = await seed();
    const other = await createNativeGroup(db, admin.id, "Other");
    const { id } = await createGroupInvite(db, { groupId: g.id, role: "member", createdBy: admin.id, ttlMs: 60_000 });
    expect(await revokeGroupInvite(db, other.id, id)).toBe(false);
    expect((await listGroupInvites(db, g.id))[0].revokedAt).toBeNull();
    expect(await revokeGroupInvite(db, g.id, id)).toBe(true);
    expect(await revokeGroupInvite(db, g.id, id)).toBe(false);
  });

  it("unknown token → 'not-found' (indistinguishable from another group's token)", async () => {
    const { db } = await seed();
    const a = await acct(db, "a");
    expect(await redeemGroupInvite(db, "nope", a.id)).toBe("not-found");
  });

  it("invite for a deleted group → 'not-found' (cascade removed it)", async () => {
    const { db, admin, g } = await seed();
    const a = await acct(db, "a");
    const { token } = await createGroupInvite(db, { groupId: g.id, role: "member", createdBy: admin.id, ttlMs: 60_000 });
    expect(await deleteNativeGroup(db, g.id)).toBe("deleted");
    expect(await redeemGroupInvite(db, token, a.id)).toBe("not-found");
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
// Group invite links.
//
//   admin mints ──► ACTIVE ──redeem (multi-use)──► via_invite grant
//                     │ │
//                     │ └── expires_at passes ───► GONE (410)
//                     └──── admin revokes BY ID ─► GONE (410)
//
// `id` is the public handle: it is what an admin sees and what revoke takes. Only sha256(token)
// is persisted, so a DB leak cannot join a group — and revocation never needs the raw token back,
// which means the token never has to travel in a URL, a log, or a Referer header.
//
// Deliberately NOT delete-on-read like handoff_codes: a handoff code is a machine-to-machine
// one-shot; an invite is a link pasted into a chat and clicked by several people.
import { randomUUID, randomBytes, createHash } from "node:crypto";
import { and, eq, isNull, lt } from "drizzle-orm";
import type { AppDb } from "./schema.js";
import { groupInvites } from "./schema.js";
import { grantInvite, type GroupRole } from "./groups.js";

const sha256hex = (s: string): string => createHash("sha256").update(s).digest("hex");

/** "gone" covers expired AND revoked: to the person clicking the link they are the same story,
 *  and the token is high-entropy, so there is no enumeration oracle to protect. */
export type RedeemResult = "ok" | "not-found" | "gone";
export interface InviteSummary { id: string; role: GroupRole; expiresAt: Date; revokedAt: Date | null }

export async function createGroupInvite(
  db: AppDb, opts: { groupId: string; role: GroupRole; createdBy: string; ttlMs: number },
): Promise<{ id: string; token: string; expiresAt: string }> {
  const id = randomUUID();
  const token = randomBytes(24).toString("base64url");
  const expiresAt = new Date(Date.now() + opts.ttlMs);
  await db.insert(groupInvites).values({
    id, tokenHash: sha256hex(token), groupId: opts.groupId, role: opts.role, createdBy: opts.createdBy, expiresAt,
  });
  return { id, token, expiresAt: expiresAt.toISOString() };
}

/** Join the invite's group with a via_invite grant. Multi-use: the row survives redemption.
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
  await grantInvite(db, row.groupId, accountId, row.role as GroupRole);
  await db.delete(groupInvites).where(lt(groupInvites.expiresAt, new Date(now - 86_400_000)));
  return "ok";
}

/** Revoke by id, scoped to the group the caller administers. An id from another group is refused,
 *  so an admin of group A cannot revoke group B's invites by guessing a uuid. Returns false when
 *  nothing was revoked (unknown id, wrong group, or already revoked). */
export async function revokeGroupInvite(
  db: AppDb, groupId: string, inviteId: string, now: number = Date.now(),
): Promise<boolean> {
  const rows = await db
    .update(groupInvites)
    .set({ revokedAt: new Date(now) })
    .where(and(eq(groupInvites.id, inviteId), eq(groupInvites.groupId, groupId), isNull(groupInvites.revokedAt)))
    .returning({ id: groupInvites.id });
  return rows.length > 0;
}

/** Outstanding invites for an admin UI. Returns ids, never token_hash — the hash is useless to a
 *  caller and its presence in a JSON response invites someone to try using it as a token. */
export async function listGroupInvites(db: AppDb, groupId: string): Promise<InviteSummary[]> {
  const rows = await db
    .select({ id: groupInvites.id, role: groupInvites.role, expiresAt: groupInvites.expiresAt, revokedAt: groupInvites.revokedAt })
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
Expected: PASS, 10 tests.

- [ ] **Step 6: Commit**

```bash
git add packages/aggregator/src/groupInvites.ts packages/aggregator/src/index.ts src/aggregator/__tests__/groupInvites.test.ts
git commit -m "feat(aggregator): multi-use group invites, revocable by id, sha256-only"
```

---

### Task 4: HTTP routes

**Files:**
- Create: `src/groups/install.ts`
- Create: `src/groups/__tests__/install.test.ts`

**Interfaces:**
- Consumes: Tasks 2 and 3; `resolveSession` (`webAuth.ts:44`); `SESSION_COOKIE`, `parseCookies` (`src/auth/cookie.ts`).
- Produces: `interface GroupsDeps { db: AppDb; webOrigins: string[] }`, `installGroups(expressApp, deps)`.

| Method | Path | Auth | Behavior |
|---|---|---|---|
| `GET` | `/api/catalog/groups` | session | my groups, with effective role |
| `POST` | `/api/catalog/groups` | session | create a native group; creator is admin |
| `DELETE` | `/api/catalog/groups?id=` | **admin** | native only; federated → 409 |
| `GET` | `/api/catalog/group-members?id=` | member | list members |
| `DELETE` | `/api/catalog/group-members?id=&account=` | admin, **or self** | remove; last admin → 409 |
| `GET` | `/api/catalog/group-invites?id=` | **admin** | outstanding invites, by id |
| `POST` | `/api/catalog/group-invites?id=` | **admin** | mint; raw token returned once |
| `DELETE` | `/api/catalog/group-invites?id=&invite=` | **admin** | revoke by id |
| `POST` | `/api/catalog/group-invite-redeem` | session | join; body `{ token }` |

**Status codes.** 401 no session. **404 for both "no such group" and "not a member"** — a 403 would confirm existence, which the spec forbids for gems and which becomes exploitable the day a route accepts `?scope=acme`. 403 only for a *member* who is not an admin: they have already proven they can see the group. 409 for the two refusals that are not about permission (deleting a federated group; removing the last admin). 410 for an expired or revoked invite.

- [ ] **Step 1: Write the failing test**

Create `src/groups/__tests__/install.test.ts`:

```ts
// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
import { describe, it, expect } from "vitest";
import { sql } from "drizzle-orm";
import { makeTestDb, upsertAccount, createSession, generateSessionToken, createNativeGroup, grantInvite, groupMemberRole } from "@agentgem/aggregator";
import type { AppDb } from "@agentgem/aggregator";
import { groupsHandler, groupMembersHandler, groupInvitesHandler, groupInviteRedeemHandler } from "../install.js";

const ORIGINS = ["https://app.agentgem.ai"];
const deps = (db: AppDb) => ({ db, webOrigins: ORIGINS });

function res() {
  const r: any = { code: 200, body: undefined as unknown, headers: {} as Record<string, string> };
  r.status = (c: number) => { r.code = c; return r; };
  r.set = (k: string, v: string) => { r.headers[k] = v; return r; };
  r.json = (b: unknown) => { r.body = b; return r; };
  r.send = (b: unknown) => { r.body = b; return r; };
  return r;
}
const req = (over: Record<string, unknown> = {}) => ({ method: "GET", path: "/", query: {}, body: {}, headers: {}, ...over }) as any;

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
    await groupsHandler(deps(db))(req(), r);
    expect(r.code).toBe(401);
  });

  it("OPTIONS preflight → 204, echoes an allowlisted origin with credentials", async () => {
    const db = await makeTestDb();
    const r = res();
    await groupsHandler(deps(db))(req({ method: "OPTIONS", headers: { origin: "https://app.agentgem.ai" } }), r);
    expect(r.code).toBe(204);
    expect(r.headers["Access-Control-Allow-Origin"]).toBe("https://app.agentgem.ai");
    expect(r.headers["Access-Control-Allow-Credentials"]).toBe("true");
  });

  it("OPTIONS from a foreign origin sets no ACAO header", async () => {
    const db = await makeTestDb();
    const r = res();
    await groupsHandler(deps(db))(req({ method: "OPTIONS", headers: { origin: "https://evil.example" } }), r);
    expect(r.headers["Access-Control-Allow-Origin"]).toBeUndefined();
  });

  it("POST /groups creates a native group, lists it, and makes the creator admin", async () => {
    const db = await makeTestDb();
    const me = await signedIn(db, "neo");
    const c = res();
    await groupsHandler(deps(db))(req({ method: "POST", headers: me.headers, body: { name: "Friends" } }), c);
    expect(c.code).toBe(200);
    expect((c.body as any).group).toMatchObject({ name: "Friends", kind: "native", scope: null });
    const l = res();
    await groupsHandler(deps(db))(req({ headers: me.headers }), l);
    expect((l.body as any).groups).toEqual([expect.objectContaining({ name: "Friends", role: "admin" })]);
  });

  it("POST /groups rejects an empty or over-long name → 400", async () => {
    const db = await makeTestDb();
    const me = await signedIn(db, "neo");
    for (const name of ["  ", "x".repeat(81)]) {
      const r = res();
      await groupsHandler(deps(db))(req({ method: "POST", headers: me.headers, body: { name } }), r);
      expect(r.code).toBe(400);
    }
  });

  it("a non-member gets 404 — never 403 — so group existence never leaks", async () => {
    const db = await makeTestDb();
    const owner = await signedIn(db, "owner");
    const stranger = await signedIn(db, "stranger");
    const g = await createNativeGroup(db, owner.acct.id, "Secret");
    for (const [handler, query] of [[groupMembersHandler, { id: g.id }], [groupInvitesHandler, { id: g.id }]] as const) {
      const r = res();
      await handler(deps(db))(req({ headers: stranger.headers, query }), r);
      expect(r.code).toBe(404);
    }
    // an id that does not exist is also 404 — indistinguishable
    const r = res();
    await groupMembersHandler(deps(db))(req({ headers: stranger.headers, query: { id: "00000000-0000-0000-0000-000000000000" } }), r);
    expect(r.code).toBe(404);
  });

  it("a member who is not an admin gets 403 on invite routes (existence already known)", async () => {
    const db = await makeTestDb();
    const owner = await signedIn(db, "owner");
    const member = await signedIn(db, "member");
    const g = await createNativeGroup(db, owner.acct.id, "Club");
    await grantInvite(db, g.id, member.acct.id, "member");
    const r = res();
    await groupInvitesHandler(deps(db))(req({ method: "POST", headers: member.headers, query: { id: g.id }, body: {} }), r);
    expect(r.code).toBe(403);
  });

  it("TWO IDENTITIES: admin mints, a different user redeems and joins", async () => {
    const db = await makeTestDb();
    const owner = await signedIn(db, "owner");
    const joiner = await signedIn(db, "joiner");
    const g = await createNativeGroup(db, owner.acct.id, "Club");

    const mint = res();
    await groupInvitesHandler(deps(db))(req({ method: "POST", headers: owner.headers, query: { id: g.id }, body: { role: "member", ttlDays: 7 } }), mint);
    expect(mint.code).toBe(200);
    const { token, id } = mint.body as any;
    expect(typeof token).toBe("string");
    expect(typeof id).toBe("string");

    const join = res();
    await groupInviteRedeemHandler(deps(db))(req({ method: "POST", headers: joiner.headers, body: { token } }), join);
    expect(join.code).toBe(200);
    expect(await groupMemberRole(db, g.id, joiner.acct.id)).toBe("member");
  });

  it("GET /group-invites returns ids, and the response contains no token", async () => {
    const db = await makeTestDb();
    const owner = await signedIn(db, "owner");
    const g = await createNativeGroup(db, owner.acct.id, "Club");
    const mint = res();
    await groupInvitesHandler(deps(db))(req({ method: "POST", headers: owner.headers, query: { id: g.id }, body: {} }), mint);
    const list = res();
    await groupInvitesHandler(deps(db))(req({ headers: owner.headers, query: { id: g.id } }), list);
    expect((list.body as any).invites[0].id).toBe((mint.body as any).id);
    expect(JSON.stringify((list.body as any).invites)).not.toContain((mint.body as any).token);
  });

  it("revoke by id, then redeem → 410", async () => {
    const db = await makeTestDb();
    const owner = await signedIn(db, "owner");
    const joiner = await signedIn(db, "joiner");
    const g = await createNativeGroup(db, owner.acct.id, "Club");
    const mint = res();
    await groupInvitesHandler(deps(db))(req({ method: "POST", headers: owner.headers, query: { id: g.id }, body: {} }), mint);
    const { token, id } = mint.body as any;

    const rev = res();
    await groupInvitesHandler(deps(db))(req({ method: "DELETE", headers: owner.headers, query: { id: g.id, invite: id } }), rev);
    expect(rev.code).toBe(200);

    const join = res();
    await groupInviteRedeemHandler(deps(db))(req({ method: "POST", headers: joiner.headers, body: { token } }), join);
    expect(join.code).toBe(410);
  });

  it("redeeming an unknown token → 404", async () => {
    const db = await makeTestDb();
    const joiner = await signedIn(db, "joiner");
    const r = res();
    await groupInviteRedeemHandler(deps(db))(req({ method: "POST", headers: joiner.headers, body: { token: "bogus" } }), r);
    expect(r.code).toBe(404);
  });

  it("ttlDays is clamped to 30 and defaults to 7", async () => {
    const db = await makeTestDb();
    const owner = await signedIn(db, "owner");
    const g = await createNativeGroup(db, owner.acct.id, "Club");
    const far = res();
    await groupInvitesHandler(deps(db))(req({ method: "POST", headers: owner.headers, query: { id: g.id }, body: { ttlDays: 9999 } }), far);
    const ms = new Date((far.body as any).expiresAt).getTime() - Date.now();
    expect(ms).toBeLessThanOrEqual(30 * 86_400_000 + 5_000);
    expect(ms).toBeGreaterThan(29 * 86_400_000);
  });

  it("removing the last admin → 409; a member may always remove themselves", async () => {
    const db = await makeTestDb();
    const owner = await signedIn(db, "owner");
    const member = await signedIn(db, "member");
    const g = await createNativeGroup(db, owner.acct.id, "Club");
    await grantInvite(db, g.id, member.acct.id, "member");

    const lastAdmin = res();
    await groupMembersHandler(deps(db))(req({ method: "DELETE", headers: owner.headers, query: { id: g.id, account: owner.acct.id } }), lastAdmin);
    expect(lastAdmin.code).toBe(409);

    const selfLeave = res();
    await groupMembersHandler(deps(db))(req({ method: "DELETE", headers: member.headers, query: { id: g.id, account: member.acct.id } }), selfLeave);
    expect(selfLeave.code).toBe(200);
    expect(await groupMemberRole(db, g.id, member.acct.id)).toBeNull();
  });

  it("a plain member cannot remove somebody else → 403", async () => {
    const db = await makeTestDb();
    const owner = await signedIn(db, "owner");
    const a = await signedIn(db, "a");
    const b = await signedIn(db, "b");
    const g = await createNativeGroup(db, owner.acct.id, "Club");
    await grantInvite(db, g.id, a.acct.id, "member");
    await grantInvite(db, g.id, b.acct.id, "member");
    const r = res();
    await groupMembersHandler(deps(db))(req({ method: "DELETE", headers: a.headers, query: { id: g.id, account: b.acct.id } }), r);
    expect(r.code).toBe(403);
  });

  it("DELETE /groups: admin deletes native; federated → 409; non-member → 404", async () => {
    const db = await makeTestDb();
    const owner = await signedIn(db, "owner");
    const stranger = await signedIn(db, "stranger");
    const g = await createNativeGroup(db, owner.acct.id, "Club");
    await db.execute(sql`insert into groups (id, kind, installation_id, name) values (gen_random_uuid(), 'federated', 101, 'acme')`);
    const fed = ((await db.execute(sql`select id from groups where kind='federated'`)).rows as { id: string }[])[0];
    await grantInvite(db, fed.id, owner.acct.id, "admin");

    const nf = res();
    await groupsHandler(deps(db))(req({ method: "DELETE", headers: stranger.headers, query: { id: g.id } }), nf);
    expect(nf.code).toBe(404);

    const conflict = res();
    await groupsHandler(deps(db))(req({ method: "DELETE", headers: owner.headers, query: { id: fed.id } }), conflict);
    expect(conflict.code).toBe(409);

    const ok = res();
    await groupsHandler(deps(db))(req({ method: "DELETE", headers: owner.headers, query: { id: g.id } }), ok);
    expect(ok.code).toBe(200);
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
// cookie OR Bearer → 401). CSRF on writes is stopped by the SameSite=Lax session cookie plus the
// 401, NOT by CORS: a cross-site form POST carries no Lax cookie, and a cross-site fetch cannot set
// an Authorization header without a preflight this origin allowlist refuses.
//
// Status codes, and why:
//   401  no session
//   404  no such group OR you are not a member — collapsed on purpose. A 403 here would confirm a
//        group exists to a stranger, and this handler will serve ?scope=acme addressing later.
//   403  you ARE a member but not an admin. Existence is already known to you, so nothing leaks.
//   409  refusals that are not about permission: deleting a federated group, removing the last admin.
//   410  the invite expired or was revoked.
//
// Membership is checked against group_members, never against a GitHub login. That is the point of
// the table.
import type { AppDb } from "@agentgem/aggregator";
import {
  resolveSession, createNativeGroup, deleteNativeGroup, listGroupsForAccount, listGroupMembers,
  groupMemberRole, countGroupAdmins, revokeInviteGrant,
  createGroupInvite, redeemGroupInvite, revokeGroupInvite, listGroupInvites,
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
const MAX_GROUP_NAME = 80;

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

async function requireSession(deps: GroupsDeps, req: Req, res: Res): Promise<{ accountId: string; login: string } | null> {
  const who = await whoami(deps, req);
  if (!who) { res.status(401).json({ error: "sign in required" }); return null; }
  return who;
}

/** The group gate. Note there is no getGroup() call: a group you are not in is indistinguishable
 *  from one that does not exist, which is both the security property and one fewer query. */
async function requireGroupRole(
  deps: GroupsDeps, req: Req, res: Res, needAdmin: boolean,
): Promise<{ accountId: string; groupId: string; role: GroupRole } | null> {
  const who = await requireSession(deps, req, res);
  if (!who) return null;
  const groupId = String((req.query.id as string | undefined) ?? "");
  if (!groupId) { res.status(400).json({ error: "id required" }); return null; }
  const role = await groupMemberRole(deps.db, groupId, who.accountId);
  if (!role) { res.status(404).json({ error: "group not found" }); return null; }
  if (needAdmin && role !== "admin") { res.status(403).json({ error: "group admin required" }); return null; }
  return { accountId: who.accountId, groupId, role };
}

/** GET → my groups. POST {name} → create native. DELETE ?id= → delete native (admin). */
export function groupsHandler(deps: GroupsDeps) {
  return async (req: Req, res: Res): Promise<void> => {
    cors(req, res, deps.webOrigins);
    if (req.method === "OPTIONS") { preflight(res); return; }

    if (req.method === "DELETE") {
      const ok = await requireGroupRole(deps, req, res, true);
      if (!ok) return;
      const result = await deleteNativeGroup(deps.db, ok.groupId);
      if (result === "federated") { res.status(409).json({ error: "managed by the GitHub App installation" }); return; }
      if (result === "not-found") { res.status(404).json({ error: "group not found" }); return; }
      res.json({ deleted: true });
      return;
    }

    const who = await requireSession(deps, req, res);
    if (!who) return;

    if (req.method === "POST") {
      const name = String((req.body.name as string | undefined) ?? "").trim();
      if (!name || name.length > MAX_GROUP_NAME) { res.status(400).json({ error: `name required (1-${MAX_GROUP_NAME} chars)` }); return; }
      res.json({ group: await createNativeGroup(deps.db, who.accountId, name) });
      return;
    }
    res.json({ groups: await listGroupsForAccount(deps.db, who.accountId) });
  };
}

/** GET → members (any member). DELETE ?account= → remove (admin, or yourself). */
export function groupMembersHandler(deps: GroupsDeps) {
  return async (req: Req, res: Res): Promise<void> => {
    cors(req, res, deps.webOrigins);
    if (req.method === "OPTIONS") { preflight(res); return; }
    const ok = await requireGroupRole(deps, req, res, false);
    if (!ok) return;

    if (req.method === "DELETE") {
      const target = String((req.query.account as string | undefined) ?? "");
      if (!target) { res.status(400).json({ error: "account required" }); return; }
      const isSelf = target === ok.accountId;
      if (!isSelf && ok.role !== "admin") { res.status(403).json({ error: "group admin required" }); return; }
      const targetRole = await groupMemberRole(deps.db, ok.groupId, target);
      if (!targetRole) { res.status(404).json({ error: "not a member" }); return; }
      if (targetRole === "admin" && (await countGroupAdmins(deps.db, ok.groupId)) === 1) {
        res.status(409).json({ error: "a group must keep at least one admin" });
        return;
      }
      await revokeInviteGrant(deps.db, ok.groupId, target);
      res.json({ removed: true });
      return;
    }
    res.json({ members: await listGroupMembers(deps.db, ok.groupId) });
  };
}

/** GET → outstanding invites (ids). POST → mint. DELETE ?invite= → revoke. All admin-only. */
export function groupInvitesHandler(deps: GroupsDeps) {
  return async (req: Req, res: Res): Promise<void> => {
    cors(req, res, deps.webOrigins);
    if (req.method === "OPTIONS") { preflight(res); return; }
    const ok = await requireGroupRole(deps, req, res, true);
    if (!ok) return;

    if (req.method === "DELETE") {
      const inviteId = String((req.query.invite as string | undefined) ?? "");
      if (!inviteId) { res.status(400).json({ error: "invite required" }); return; }
      if (!(await revokeGroupInvite(deps.db, ok.groupId, inviteId))) { res.status(404).json({ error: "invite not found" }); return; }
      res.json({ revoked: true });
      return;
    }

    if (req.method === "POST") {
      const role: GroupRole = req.body.role === "admin" ? "admin" : "member";
      const requested = Number(req.body.ttlDays ?? DEFAULT_INVITE_TTL_DAYS);
      const days = Number.isFinite(requested) && requested > 0 ? Math.min(requested, MAX_INVITE_TTL_DAYS) : DEFAULT_INVITE_TTL_DAYS;
      // The raw token is returned exactly once, here, and never stored or logged.
      res.json(await createGroupInvite(deps.db, { groupId: ok.groupId, role, createdBy: ok.accountId, ttlMs: days * 86_400_000 }));
      return;
    }
    res.json({ invites: await listGroupInvites(deps.db, ok.groupId) });
  };
}

/** POST {token} → join. Any signed-in user may redeem; the token IS the authorization. */
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
  for (const [path, handler] of [
    ["/api/catalog/groups", groupsHandler(deps)],
    ["/api/catalog/group-members", groupMembersHandler(deps)],
    ["/api/catalog/group-invites", groupInvitesHandler(deps)],
    ["/api/catalog/group-invite-redeem", groupInviteRedeemHandler(deps)],
  ] as const) {
    expressApp.get(path, handler);
    expressApp.post(path, handler);
    expressApp.delete(path, handler);
    expressApp.options(path, handler);
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
tsc -b && pnpm exec vitest run dist/groups/__tests__/install.test.js
```
Expected: PASS, 14 tests.

- [ ] **Step 5: Commit**

```bash
git add src/groups/install.ts src/groups/__tests__/install.test.ts
git commit -m "feat(groups): membership + invite routes under /api/catalog"
```

---

### Task 5: Mount and drive it

**Files:**
- Modify: `src/index.ts:65` (import), `src/index.ts:195-200` (mount)

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
curl -s -o /dev/null -w '%{http_code}\n' http://localhost:3000/api/catalog/groups
# → 401

TOKEN=$(node -e "console.log(JSON.parse(require('fs').readFileSync(process.env.HOME + '/.agentgem/session.json','utf8')).sessionToken)")
GID=$(curl -s -X POST http://localhost:3000/api/catalog/groups \
  -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d '{"name":"Friends"}' | node -pe 'JSON.parse(require("fs").readFileSync(0)).group.id')

curl -s "http://localhost:3000/api/catalog/group-invites?id=$GID" -X POST \
  -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' -d '{}'
# → {"id":"…","token":"…","expiresAt":"…"}   token appears ONCE

curl -s "http://localhost:3000/api/catalog/group-invites?id=$GID" -H "authorization: Bearer $TOKEN"
# → {"invites":[{"id":"…","role":"member","expiresAt":"…","revokedAt":null}]}   no token, no hash

curl -s -o /dev/null -w '%{http_code}\n' "http://localhost:3000/api/catalog/group-members?id=00000000-0000-0000-0000-000000000000" \
  -H "authorization: Bearer $TOKEN"
# → 404, not 403
```

- [ ] **Step 5: Commit**

```bash
git add src/index.ts
git commit -m "feat: mount group routes"
```

---

## NOT in scope

| Deferred | Rationale |
|---|---|
| Federated groups, the GitHub App reconciler, `captureOrgMemberships` | Plan 1b. It is the only PR where enterprise access can regress; it gets its own review and its own blast radius. Plan 1a writes no `via_sync` rows. |
| `catalog_gems.visibility`, `gem_shares`, `canReadGem`, the private read surface, the three write-side guards | Plan 2. Depends on 1a only. |
| Promote/demote endpoint | `grantInvite` with an admin-role invite is the only promotion path today. A dedicated `PATCH /group-members` belongs with the admin UI. |
| Cap on native groups per account | No abuse signal. An authenticated user creating rows is bounded by having an account at all. |
| `gh_user_id` on `org_members` (match by GitHub numeric id, not login) | TODOS.md. Inherited debt; belongs with the `account_identities` sequel. |
| Shared `routeKit.ts` for `cors`/`preflight`/`whoami` | TODOS.md. Cross-cutting refactor across four modules; hides the real diff. Copy-paste twice before you abstract. |
| Batching `syncFederatedMemberships` into two queries | Sign-in already makes two ~100ms GitHub calls; the local queries are noise. Comment it, do not optimize it. |
| A real HTTP E2E harness | The repo has none. Route handlers are tested directly against PGlite with two real sessions, which catches the cross-identity bugs that matter. |

## What already exists

| Existing | Reused, or rebuilt? |
|---|---|
| `resolveSession` (`webAuth.ts:44`), the `ag_session` cookie, and Bearer parity | **Reused.** No new session concept. |
| Credentialed CORS + originGuard exemption on `/api/catalog/*` (`catalog/install.ts:19-26`, `originGuard.ts:64`) | **Reused.** New routes inherit both by living under that prefix. `PUBLIC_READ_PATHS` is untouched. |
| `redeemHandoffCode` (`webAuth.ts:68`) — sha256-only storage, opportunistic expiry sweep | **Reused as a pattern**, not as code. Its delete-on-read lifecycle is deliberately *not* copied. |
| `makeTestDb()` PGlite harness (`testDb.ts`) | **Reused.** Every test gets a fresh in-memory Postgres; no fixtures, no teardown. |
| `accounts` table, `upsertAccount` | **Reused.** Membership keys on `accounts.id`; no new user concept. |
| `resolveOrgAccess` / `org_members` (`githubApp.ts:104`) | **Not touched by 1a.** Plan 1b mirrors into `via_sync` grants; usage dashboards keep using `resolveOrgAccess` directly. |
| `accountOwnsScope(db, accountId, scope)` (`webAuth.ts:106`) | **Left alone.** Already accountId-shaped; the *values* it compares are login strings, which the `published_by` re-key sequel fixes. |

## Failure modes

| Codepath | Realistic production failure | Test? | Error handling? | Silent? |
|---|---|---|---|---|
| `grantInvite` | Concurrent redeem by two users promotes then demotes | ✅ Task 2 Step 1 + SQL `case` makes it atomic | N/A — DB-level | No |
| `redeemGroupInvite` | Invite's group was deleted between mint and click | ✅ Task 3 Step 1 | 404 | No |
| `revokeInviteGrant` | Removes the last admin | ✅ Task 4 Step 1 | 409 | No |
| `deleteNativeGroup` | Called on a federated group | ✅ Task 2 + Task 4 | 409 | No |
| `requireGroupRole` | Stranger probes a group id | ✅ Task 4 Step 1 | 404, identical to absent | No |
| `createGroupInvite` | Token collides with an existing hash | ❌ (2^192 space) | `token_hash` unique → 500 | **Yes, but unreachable** |
| Expiry sweep in `redeemGroupInvite` | Deletes an invite an admin was about to inspect | ❌ | none | Yes — sweeps only invites expired >24h, which are already unusable |

No critical gaps: every failure mode with real probability has both a test and an explicit status code.

## Worktree parallelization strategy

| Step | Modules touched | Depends on |
|---|---|---|
| Task 1 schema | `packages/aggregator/` | — |
| Task 2 groups store | `packages/aggregator/` | Task 1 |
| Task 3 invite store | `packages/aggregator/` | Task 2 |
| Task 4 routes | `src/groups/` | Tasks 2, 3 |
| Task 5 mount | `src/` | Task 4 |

**Sequential implementation, no parallelization opportunity.** Tasks 1–3 all edit `packages/aggregator/src/`, and Task 3 imports Task 2's `grantInvite`. Task 4 cannot begin before the store's exported signatures exist. Plan 1a and Plan 2 could run in parallel worktrees *after* 1a's Task 3 lands, since Plan 2 touches `catalog_gems` and `gem_shares` while 1b touches `githubApp.ts` and `sync.ts` — no shared module.

**Cross-plan conflict flag:** Plan 1b and Plan 2 both add DDL to `ensureSchema` in `packages/aggregator/src/schema.ts`. If run in parallel worktrees, expect a merge conflict there and in `src/aggregator/__tests__/schema.test.ts`'s table array. Both are trivial to resolve, but do not `git rebase --skip` past them.

## Implementation Tasks

Synthesized from this review's findings. Each task derives from a specific finding above. Run with Claude Code or Codex; checkbox as you ship.

- [ ] **T1 (P1, human: ~4h / CC: ~20min)** — schema/store — Replace the `source` enum with the `via_sync`/`via_invite` lattice
  - Surfaced by: Outside voice (Codex) — "the `source` column is the wrong abstraction… an invited guest who later appears in the GitHub org is converted to `sync`, and the next offboard deletes them"
  - Files: `packages/aggregator/src/schema.ts`, `packages/aggregator/src/groups.ts`
  - Verify: `tsc -b && pnpm exec vitest run dist/aggregator/__tests__/groups.test.js` — "revokeInviteGrant KEEPS the row when a sync grant remains"
- [ ] **T2 (P1, human: ~2h / CC: ~12min)** — schema — Key federated groups on `installation_id`, not `scope`
  - Surfaced by: Outside voice (Codex) — "GitHub org logins can change. The stable key is installation id"
  - Files: `packages/aggregator/src/schema.ts`, `packages/aggregator/src/groupsFederation.ts` (Plan 1b)
  - Verify: Plan 1b — "renaming an org renames the group in place and keeps its members"
- [ ] **T3 (P1, human: ~1h / CC: ~8min)** — invites — Add `group_invites.id`; revoke by id; never put a raw token in a URL
  - Surfaced by: Code quality review — "revoking needs the raw token, but only sha256 is stored, so the capability is unreachable; and `DELETE ?token=` logs a live credential"
  - Files: `packages/aggregator/src/schema.ts`, `packages/aggregator/src/groupInvites.ts`, `src/groups/install.ts`
  - Verify: `dist/aggregator/__tests__/groupInvites.test.js` — "revoke by ID — no raw token needed"
- [ ] **T4 (P1, human: ~45min / CC: ~6min)** — store — `grantInvite` must never lower a role
  - Surfaced by: Code quality review — "an admin who clicks their own member-invite link demotes themselves; if they were the only admin the group is locked"
  - Files: `packages/aggregator/src/groups.ts`
  - Verify: `dist/aggregator/__tests__/groups.test.js` — "grantInvite NEVER lowers a role"
- [ ] **T5 (P1, human: ~15min / CC: ~3min)** — routes — Collapse "no such group" and "not a member" to 404
  - Surfaced by: Architecture review — "403 confirms existence; the spec forbids exactly this oracle for gems"
  - Files: `src/groups/install.ts`
  - Verify: `dist/groups/__tests__/install.test.js` — "a non-member gets 404 — never 403"
- [ ] **T6 (P2, human: ~1.5h / CC: ~10min)** — routes/store — `DELETE /api/catalog/groups`, native-only, admin-gated
  - Surfaced by: Architecture review — "nothing can delete a group, yet Plan 2's cascade assumes deletion exists"
  - Files: `packages/aggregator/src/groups.ts`, `src/groups/install.ts`
  - Verify: `dist/groups/__tests__/install.test.js` — "federated → 409; non-member → 404"
- [ ] **T7 (P2, human: ~3h / CC: ~18min)** — schema/routes — CHECK constraints on every enum; last-admin guard
  - Surfaced by: Outside voice (Codex) — "`kind`, `role`, `source` are free text"; "no last-admin invariant"
  - Files: `packages/aggregator/src/schema.ts`, `src/groups/install.ts`
  - Verify: `dist/aggregator/__tests__/schema.test.js` — "kind is a closed set"; `install.test.js` — "removing the last admin → 409"
- [ ] **T8 (P2, human: ~1.5 days / CC: ~35min)** — tests — Close all 29 coverage gaps, unit + route-level with two identities
  - Surfaced by: Test review — "28% of paths tested; 11 of 12 CRITICAL gaps are branches the six fixes just created"
  - Files: `src/aggregator/__tests__/*.test.ts`, `src/groups/__tests__/install.test.ts`
  - Verify: `pnpm clean && pnpm test`
- [ ] **T9 (P3, human: ~5min / CC: ~2min)** — docs — Comment the O(orgs) sign-in loop as deliberate
  - Surfaced by: Performance review — "2 queries per org scope; GitHub round trips dominate"
  - Files: `packages/aggregator/src/webAuth.ts` (Plan 1b)
  - Verify: code read

_Plan 1b's own tasks (transaction around the reconcile, suspend-drops-sync, active-installation gate, truncation regression test) live in `2026-07-08-groups-plan-1b-federation.md`._

## GSTACK REVIEW REPORT

| Review | Trigger | Why | Runs | Status | Findings |
|--------|---------|-----|------|--------|----------|
| CEO Review | `/plan-ceo-review` | Scope & strategy | 0 | — | — |
| Codex Review | `/codex review` | Independent 2nd opinion | 1 | issues_found | 15 raised, 4 folded in, 2 stale, 2 deferred to TODOS.md |
| Eng Review | `/plan-eng-review` | Architecture & tests (required) | 1 | clean | 11 issues, 0 critical gaps |
| Design Review | `/plan-design-review` | UI/UX gaps | 0 | — | — |
| DX Review | `/plan-devex-review` | Developer experience gaps | 0 | — | — |

**CODEX:** Outside voice found the `source`-enum collapse (an invited guest converted to `sync` is deleted on the next offboard) and the org-rename group fork. Both were accepted and folded in as the `via_sync`/`via_invite` lattice and `installation_id` keying. Two of its bullets were stale (it read the pre-amendment plan); one specific (`kind='garbage'` passing the check) was factually wrong while its conclusion — unconstrained enums — was right and taken.

**CROSS-MODEL:** One genuine tension. The eng review examined the one-row-per-person collapse in the direction invite→sync (a guest joins the org) and accepted it; Codex pointed at the exit (that person later leaves the company and loses the invite an admin gave them). Codex was right about the direction the review did not examine. Resolved in Codex's favor: two independent grant bits, each owned by exactly one authority. Both reviewers independently arrived at the same strategic conclusion — split federation out of the first PR.

**VERDICT:** ENG CLEARED — ready to implement. Plan 1a is purely additive and touches no existing behavior; Plan 1b is the only PR in this line where enterprise access can regress and carries a mandatory truncation regression test.

NO UNRESOLVED DECISIONS
