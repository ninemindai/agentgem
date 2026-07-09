# Groups & Membership — Plan 1b: Federated Groups (of 3)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Mirror GitHub org membership into the group model as `via_sync` grants, without ever disturbing an invited guest and without weakening the offboarding guarantee that `resolveOrgAccess` already provides.

**Architecture:** A federated group is created per GitHub App installation and keyed on `installation_id`, so an org rename renames the group rather than forking it. Its `via_sync` grants are materialized at sign-in, because an org roster holds bare GitHub logins and most have no `accounts` row. Every path the App owns — reconcile, `member_removed`, suspend, uninstall — clears only the `via_sync` bit; a row disappears only when `via_invite` is also clear.

**Depends on:** Plan 1a (`2026-07-08-groups-plan-1-membership.md`). The tables, the lattice, and `grantInvite`/`revokeInviteGrant` must exist first.

**Reviewed:** `/plan-eng-review` 2026-07-08, as part of the combined plan. This is the risky half: **this is the only PR in the groups line where enterprise access can regress.**

## Global Constraints

Inherits every constraint from Plan 1a. Additionally:

- **`resolveOrgAccess` (`packages/aggregator/src/githubApp.ts:104`) is not modified.** Usage dashboards keep asking it directly. Two gates coexist until a later spec collapses them.
- **An active installation means `app_installations` has a row for the scope and `suspended = false`.** This is exactly the predicate `resolveOrgAccess:110` already uses. Every group write and delete in this plan agrees with it.
- **`groups.ts` must not import `githubApp.ts`.** `githubApp.ts` imports `groups.ts`. The active-installation *policy* therefore lives in `webAuth.ts`, which filters the scope list before handing it to the sync. Break this and you get a cycle.

---

## The three delete paths, and the one predicate they share

```
                     ┌──────────────────────────────────────────┐
   GitHub org        │  active installation?                    │
   roster / webhook  │    app_installations row AND NOT suspended│
                     └──────────────────────────────────────────┘
                                      │
              ┌───────────────────────┼───────────────────────┐
              │ yes                   │ no                    │
              ▼                       ▼                       │
    grant / refresh via_sync    NEVER grant via_sync          │
                                                              │
   ┌──────────────────────────────────────────────────────────┴────────┐
   │  CLEAR via_sync (never via_invite):                               │
   │    member_removed webhook   →  one account                        │
   │    replaceSyncGrants        →  whole group, in ONE transaction    │
   │    setInstallationSuspended →  whole group                        │
   │    deleteInstallation       →  whole group                        │
   └───────────────────────────────────────────────────────────────────┘
                                      │
                                      ▼
                      DELETE the row iff NOT via_sync AND NOT via_invite

   A pure org member  (via_invite=false) → row vanishes. Offboarded in seconds. ✓
   An invited guest   (via_invite=true)  → row stays.    Never GitHub's to revoke. ✓
```

**The trap this plan exists to avoid:** `deleteInstallation` clears sync grants, but the group row survives (so guests and `gem_shares` persist) and `account_scopes` still lists the org. Without the active-installation gate, the very next sign-in re-grants `via_sync` to every org member and the uninstall is undone. That is why the gate is a *write* predicate, not only a *delete* one.

---

### Task 1: Federation store

**Files:**
- Create: `packages/aggregator/src/groupsFederation.ts`
- Create: `src/aggregator/__tests__/groupFederation.test.ts`
- Modify: `packages/aggregator/src/index.ts`

**Interfaces:**
- Consumes: `groups`, `groupMembers`, `accounts`, `appInstallations` tables; `GroupRole`, `Group`, `groupMemberRole`, `listGroupMembers` (Plan 1a).
- Produces:
  ```ts
  ensureFederatedGroup(db, installationId: number, scope: string): Promise<Group>
  groupByScope(db, scope: string): Promise<Group | null>
  groupByInstallation(db, installationId: number): Promise<Group | null>
  accountIdForLogin(db, login: string): Promise<string | null>
  grantSync(db, groupId, accountId, role: GroupRole): Promise<void>
  clearSyncGrant(db, groupId, accountId): Promise<void>
  clearSyncGrants(db, groupId): Promise<void>
  replaceSyncGrants(db, groupId, logins: { login: string; role: GroupRole }[]): Promise<void>
  syncFederatedMemberships(db, accountId, scopes: { scope: string; role: GroupRole }[]): Promise<void>
  ```

- [ ] **Step 1: Write the failing test**

Create `src/aggregator/__tests__/groupFederation.test.ts`:

```ts
// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
import { describe, it, expect } from "vitest";
import { sql } from "drizzle-orm";
import {
  makeTestDb, upsertAccount, upsertInstallation, setInstallationSuspended, deleteInstallation,
  ensureFederatedGroup, groupByScope, groupByInstallation, accountIdForLogin,
  replaceSyncGrants, clearSyncGrants, grantSync, grantInvite,
  groupMemberRole, listGroupMembers, captureOrgMemberships, getAccountScopes,
} from "@agentgem/aggregator";

const inst = (over = {}) => ({ installationId: 101, orgScope: "acme", repoSelection: "selected" as const, suspended: false, ...over });
const acct = (db: any, n: string) => upsertAccount(db, { provider: "github", accountId: n, login: n });

describe("federated groups", () => {
  it("upsertInstallation creates the federated group, keyed on installation_id", async () => {
    const db = await makeTestDb();
    await upsertInstallation(db, inst({ orgScope: "Acme" }));
    const g = await groupByScope(db, "acme");
    expect(g).toMatchObject({ kind: "federated", scope: "acme", installationId: 101 });
    expect((await groupByInstallation(db, 101))?.id).toBe(g!.id);
  });

  it("CRITICAL: renaming the org renames the group in place, keeping members", async () => {
    const db = await makeTestDb();
    await upsertInstallation(db, inst());
    const g = (await groupByScope(db, "acme"))!;
    const alice = await acct(db, "alice");
    await grantSync(db, g.id, alice.id, "member");

    await upsertInstallation(db, inst({ orgScope: "acmecorp" }));   // same installation_id

    expect(await groupByScope(db, "acme")).toBeNull();
    const renamed = (await groupByScope(db, "acmecorp"))!;
    expect(renamed.id).toBe(g.id);                                   // SAME group, not a fork
    expect(await groupMemberRole(db, g.id, alice.id)).toBe("member");
    const count = await db.execute(sql`select count(*)::int as n from groups where kind='federated'`);
    expect((count.rows as { n: number }[])[0].n).toBe(1);
  });

  it("accountIdForLogin is case-insensitive and github-scoped", async () => {
    const db = await makeTestDb();
    const me = await upsertAccount(db, { provider: "github", accountId: "1", login: "Neo" });
    expect(await accountIdForLogin(db, "neo")).toBe(me.id);
    expect(await accountIdForLogin(db, "NEO")).toBe(me.id);
    expect(await accountIdForLogin(db, "nobody")).toBeNull();
  });

  it("replaceSyncGrants skips logins with no account", async () => {
    const db = await makeTestDb();
    await upsertInstallation(db, inst());
    const g = (await groupByScope(db, "acme"))!;
    await replaceSyncGrants(db, g.id, [{ login: "never-signed-in", role: "member" }]);
    expect(await listGroupMembers(db, g.id)).toEqual([]);
  });

  it("INVARIANT: an invited guest survives a sync that removes every synced member", async () => {
    const db = await makeTestDb();
    await upsertInstallation(db, inst());
    const g = (await groupByScope(db, "acme"))!;
    const alice = await acct(db, "alice");
    const guest = await acct(db, "guest");

    await replaceSyncGrants(db, g.id, [{ login: "alice", role: "member" }]);
    await grantInvite(db, g.id, guest.id, "member");

    await replaceSyncGrants(db, g.id, []);                            // everyone leaves the org

    expect(await groupMemberRole(db, g.id, alice.id)).toBeNull();
    expect(await groupMemberRole(db, g.id, guest.id)).toBe("member");
    expect((await listGroupMembers(db, g.id)).map((m) => m.login)).toEqual(["guest"]);
  });

  it("INVARIANT: the hired contractor keeps guest access after leaving the org", async () => {
    const db = await makeTestDb();
    await upsertInstallation(db, inst());
    const g = (await groupByScope(db, "acme"))!;
    const hire = await acct(db, "hire");

    await grantInvite(db, g.id, hire.id, "admin");                    // invited as a contractor
    await replaceSyncGrants(db, g.id, [{ login: "hire", role: "member" }]);   // later hired
    expect(await groupMemberRole(db, g.id, hire.id)).toBe("admin");   // max(member, admin)

    await replaceSyncGrants(db, g.id, []);                            // leaves the company
    expect(await groupMemberRole(db, g.id, hire.id)).toBe("admin");   // still a guest ✓
    expect((await listGroupMembers(db, g.id))[0]).toMatchObject({ viaSync: false, viaInvite: true });
  });

  it("replaceSyncGrants is atomic: a failure mid-replace leaves the old roster", async () => {
    const db = await makeTestDb();
    await upsertInstallation(db, inst());
    const g = (await groupByScope(db, "acme"))!;
    await acct(db, "alice");
    await replaceSyncGrants(db, g.id, [{ login: "alice", role: "member" }]);
    // A role outside the CHECK set aborts the transaction; the prior roster must survive.
    await expect(replaceSyncGrants(db, g.id, [{ login: "alice", role: "owner" as never }])).rejects.toThrow();
    expect((await listGroupMembers(db, g.id)).map((m) => m.login)).toEqual(["alice"]);
  });

  it("captureOrgMemberships grants via_sync only for an ACTIVE installation", async () => {
    const db = await makeTestDb();
    await upsertInstallation(db, inst());
    const me = await acct(db, "neo");
    await captureOrgMemberships(db, me.id, [{ scope: "neo", role: "self" }, { scope: "acme", role: "admin" }]);
    const g = (await groupByScope(db, "acme"))!;
    expect(await groupMemberRole(db, g.id, me.id)).toBe("admin");
    expect(await groupByScope(db, "neo")).toBeNull();                 // "self" is not a group
    expect((await getAccountScopes(db, me.id)).map((s) => s.scope).sort()).toEqual(["acme", "neo"]);
  });

  it("CRITICAL: a SUSPENDED installation grants nothing at sign-in", async () => {
    const db = await makeTestDb();
    await upsertInstallation(db, inst());
    const g = (await groupByScope(db, "acme"))!;
    const me = await acct(db, "neo");
    await setInstallationSuspended(db, 101, true);
    await captureOrgMemberships(db, me.id, [{ scope: "acme", role: "member" }]);
    expect(await groupMemberRole(db, g.id, me.id)).toBeNull();
  });

  it("CRITICAL: after uninstall, signing in does NOT re-grant via_sync", async () => {
    const db = await makeTestDb();
    await upsertInstallation(db, inst());
    const g = (await groupByScope(db, "acme"))!;
    const me = await acct(db, "neo");
    await captureOrgMemberships(db, me.id, [{ scope: "acme", role: "member" }]);
    expect(await groupMemberRole(db, g.id, me.id)).toBe("member");

    await deleteInstallation(db, 101);
    expect(await groupMemberRole(db, g.id, me.id)).toBeNull();

    await captureOrgMemberships(db, me.id, [{ scope: "acme", role: "member" }]);   // next sign-in
    expect(await groupMemberRole(db, g.id, me.id)).toBeNull();                     // still gone ✓
  });

  it("CRITICAL: suspend drops existing sync grants but keeps guests; unsuspend is caller's job", async () => {
    const db = await makeTestDb();
    await upsertInstallation(db, inst());
    const g = (await groupByScope(db, "acme"))!;
    const alice = await acct(db, "alice");
    const guest = await acct(db, "guest");
    await grantSync(db, g.id, alice.id, "member");
    await grantInvite(db, g.id, guest.id, "member");

    await setInstallationSuspended(db, 101, true);

    expect((await listGroupMembers(db, g.id)).map((m) => m.login)).toEqual(["guest"]);
  });

  it("deleteInstallation drops sync grants but keeps the group and its guests", async () => {
    const db = await makeTestDb();
    await upsertInstallation(db, inst());
    const g = (await groupByScope(db, "acme"))!;
    const alice = await acct(db, "alice");
    const guest = await acct(db, "guest");
    await grantSync(db, g.id, alice.id, "member");
    await grantInvite(db, g.id, guest.id, "member");

    await deleteInstallation(db, 101);

    expect(await groupByInstallation(db, 101)).not.toBeNull();        // group survives
    expect((await listGroupMembers(db, g.id)).map((m) => m.login)).toEqual(["guest"]);
  });

  it("syncFederatedMemberships drops a grant for a scope the account has left", async () => {
    const db = await makeTestDb();
    await upsertInstallation(db, inst());
    await upsertInstallation(db, inst({ installationId: 102, orgScope: "other" }));
    const me = await acct(db, "neo");
    await captureOrgMemberships(db, me.id, [{ scope: "acme", role: "member" }, { scope: "other", role: "member" }]);
    await captureOrgMemberships(db, me.id, [{ scope: "acme", role: "member" }]);
    expect(await groupMemberRole(db, (await groupByScope(db, "other"))!.id, me.id)).toBeNull();
    expect(await groupMemberRole(db, (await groupByScope(db, "acme"))!.id, me.id)).toBe("member");
  });

  it("clearSyncGrants never touches via_invite", async () => {
    const db = await makeTestDb();
    await upsertInstallation(db, inst());
    const g = (await groupByScope(db, "acme"))!;
    const both = await acct(db, "both");
    await grantSync(db, g.id, both.id, "admin");
    await grantInvite(db, g.id, both.id, "member");
    await clearSyncGrants(db, g.id);
    expect(await groupMemberRole(db, g.id, both.id)).toBe("member");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
tsc -b && pnpm exec vitest run dist/aggregator/__tests__/groupFederation.test.js
```
Expected: FAIL — `ensureFederatedGroup` is not exported.

- [ ] **Step 3: Write the federation store**

Create `packages/aggregator/src/groupsFederation.ts`:

```ts
// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
// The GitHub App's half of the membership lattice: it owns `via_sync` and nothing else.
//
// Identity is `installation_id`, NOT `scope`. GitHub org logins change (rebrands, acquisitions)
// and the installation survives the rename — which is why app_installations keys on it. Keying the
// group on `scope` would fork the group on rename, orphaning every gem_share and every guest.
//
// This module must NOT import githubApp.ts (which imports this file's sibling, groups.ts). The
// active-installation policy therefore lives in webAuth.ts, which filters scopes before calling in.
import { randomUUID } from "node:crypto";
import { and, eq, inArray, sql } from "drizzle-orm";
import type { AppDb } from "./schema.js";
import { accounts, groups, groupMembers } from "./schema.js";
import { type Group, type GroupRole } from "./groups.js";

const groupCols = { id: groups.id, kind: groups.kind, installationId: groups.installationId, scope: groups.scope, name: groups.name };
const asGroup = (r: { id: string; kind: string; installationId: number | null; scope: string | null; name: string }): Group =>
  ({ id: r.id, kind: r.kind as "federated" | "native", installationId: r.installationId, scope: r.scope, name: r.name });

/** The federated group for an installation, creating it if absent and RENAMING it in place when the
 *  org's login changed. Idempotent. Scope is lowercased, matching org_members' convention. */
export async function ensureFederatedGroup(db: AppDb, installationId: number, scope: string): Promise<Group> {
  const s = scope.toLowerCase();
  const rows = await db
    .insert(groups)
    .values({ id: randomUUID(), kind: "federated", installationId, scope: s, name: s })
    .onConflictDoUpdate({ target: groups.installationId, set: { scope: s, name: s } })
    .returning(groupCols);
  return asGroup(rows[0]);
}

export async function groupByScope(db: AppDb, scope: string): Promise<Group | null> {
  const rows = await db.select(groupCols).from(groups).where(eq(groups.scope, scope.toLowerCase())).limit(1);
  return rows[0] ? asGroup(rows[0]) : null;
}

export async function groupByInstallation(db: AppDb, installationId: number): Promise<Group | null> {
  const rows = await db.select(groupCols).from(groups).where(eq(groups.installationId, installationId)).limit(1);
  return rows[0] ? asGroup(rows[0]) : null;
}

/** The account behind a GitHub login, or null. Case-insensitive; accounts.login keeps GitHub's casing.
 *  TODO(TODOS.md): logins are mutable — key on accounts.provider_account_id once org_members carries it. */
export async function accountIdForLogin(db: AppDb, login: string): Promise<string | null> {
  const rows = await db
    .select({ id: accounts.id })
    .from(accounts)
    .where(and(eq(accounts.provider, "github"), sql`lower(${accounts.login}) = ${login.toLowerCase()}`))
    .limit(1);
  return rows[0]?.id ?? null;
}

/** Set the via_sync bit. Leaves via_invite exactly as it was — an admin's grant is not ours. */
export async function grantSync(db: AppDb, groupId: string, accountId: string, role: GroupRole): Promise<void> {
  await db.execute(sql`
    insert into group_members (group_id, account_id, via_sync, sync_role)
    values (${groupId}, ${accountId}, true, ${role})
    on conflict (group_id, account_id) do update set via_sync = true, sync_role = ${role}`);
}

/** Clear one account's via_sync bit; drop the row only if no invite grant remains. */
export async function clearSyncGrant(db: AppDb, groupId: string, accountId: string): Promise<void> {
  await db.execute(sql`
    update group_members set via_sync = false, sync_role = null
    where group_id = ${groupId} and account_id = ${accountId} and via_invite`);
  await db.delete(groupMembers).where(
    and(eq(groupMembers.groupId, groupId), eq(groupMembers.accountId, accountId), eq(groupMembers.viaInvite, false)));
}

/** Clear the whole group's via_sync bits. Guests (via_invite) survive untouched — this is the
 *  predicate the entire `source`→lattice redesign exists to make expressible. */
export async function clearSyncGrants(db: AppDb, groupId: string): Promise<void> {
  await db.execute(sql`
    update group_members set via_sync = false, sync_role = null
    where group_id = ${groupId} and via_sync and via_invite`);
  await db.delete(groupMembers).where(
    and(eq(groupMembers.groupId, groupId), eq(groupMembers.viaSync, true), eq(groupMembers.viaInvite, false)));
}

/** Replace a federated group's synced roster, ATOMICALLY. A crash, a rate-limit error, or a bad
 *  role between the clear and the grants would otherwise leave an enterprise group with zero synced
 *  members until the next reconcile. Logins with no AgentGem account are skipped: they have no
 *  session and can read nothing, and their grant appears the first time they sign in. */
export async function replaceSyncGrants(
  db: AppDb, groupId: string, logins: { login: string; role: GroupRole }[],
): Promise<void> {
  await db.transaction(async (tx) => {
    await clearSyncGrants(tx as unknown as AppDb, groupId);
    if (logins.length === 0) return;
    const lowered = logins.map((l) => l.login.toLowerCase());
    const known = await tx
      .select({ id: accounts.id, login: accounts.login })
      .from(accounts)
      .where(and(eq(accounts.provider, "github"), inArray(sql`lower(${accounts.login})`, lowered)));
    const roleFor = new Map(logins.map((l) => [l.login.toLowerCase(), l.role]));
    for (const a of known) {
      await grantSync(tx as unknown as AppDb, groupId, a.id, roleFor.get(a.login.toLowerCase()) ?? "member");
    }
  });
}

/** Materialize this account's via_sync grants from the org scopes captured at sign-in. `scopes` has
 *  ALREADY been filtered to orgs with an active installation by captureOrgMemberships — do not
 *  re-derive that here, and do not import githubApp.ts to try (it imports groups.ts). Scopes the
 *  account no longer belongs to lose their grant: sign-in is a full re-capture. */
export async function syncFederatedMemberships(
  db: AppDb, accountId: string, scopes: { scope: string; role: GroupRole }[],
): Promise<void> {
  const current = await db
    .select({ groupId: groupMembers.groupId })
    .from(groupMembers)
    .where(and(eq(groupMembers.accountId, accountId), eq(groupMembers.viaSync, true)));
  const keep = new Set<string>();
  for (const s of scopes) {
    const g = await groupByScope(db, s.scope);
    if (!g) continue;
    keep.add(g.id);
    await grantSync(db, g.id, accountId, s.role);
  }
  for (const row of current) {
    if (!keep.has(row.groupId)) await clearSyncGrant(db, row.groupId, accountId);
  }
}
```

- [ ] **Step 4: Export from the barrel**

In `packages/aggregator/src/index.ts`, after `export * from "./groupInvites.js";`:

```ts
export * from "./groupsFederation.js";
```

- [ ] **Step 5: Add the `captureOrgMemberships` seam**

Append to `packages/aggregator/src/webAuth.ts`, and add `import { syncFederatedMemberships } from "./groupsFederation.js";` plus `import { installationForScope } from "./githubApp.js";` at the top:

```ts
/** The one place sign-in turns a GitHub org list into durable state: captured scopes (the legacy
 *  gate) AND federated group grants (the new one). Both web login and device bind call this instead
 *  of setAccountScopes, so the two can never drift.
 *
 *  The active-installation filter lives HERE, not in groupsFederation.ts: githubApp.ts imports
 *  groups.ts, so the store cannot import back. It is also the correct place for policy —
 *  groupsFederation takes a list and trusts it.
 *
 *  Without this filter, uninstalling the App would be undone by the next sign-in: the group row
 *  survives (guests + gem_shares depend on it), account_scopes still lists the org, and every org
 *  member would silently regain via_sync.
 *
 *  O(orgs) by choice. The caller has just made two GitHub API round trips (~100ms each); these
 *  queries run against a pooled local connection and do not meaningfully add to sign-in latency.
 *  Optimize only if a user with hundreds of org memberships shows up in the traces. */
export async function captureOrgMemberships(db: AppDb, accountId: string, scopes: ScopeGrant[]): Promise<void> {
  await setAccountScopes(db, accountId, scopes);
  const orgs = scopes
    .map((g) => (typeof g === "string" ? { scope: g, role: "member" as const } : g))
    .filter((g) => g.role !== "self");
  const active: { scope: string; role: "admin" | "member" }[] = [];
  for (const g of orgs) {
    const inst = await installationForScope(db, g.scope);
    if (inst && !inst.suspended) active.push({ scope: g.scope, role: g.role === "admin" ? "admin" : "member" });
  }
  await syncFederatedMemberships(db, accountId, active);
}
```

- [ ] **Step 6: Make the installation own its group**

In `packages/aggregator/src/githubApp.ts`, add `import { ensureFederatedGroup, groupByInstallation, clearSyncGrants } from "./groupsFederation.js";` and rewrite three functions:

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
  // so a gem can be shared with it before anyone has signed in. Keyed on installationId, so a GitHub
  // org rename renames this group instead of forking it.
  await ensureFederatedGroup(db, inst.installationId, orgScope);
}

/** Suspended behaves as uninstalled for gating (see resolveOrgAccess's precedence), so it must also
 *  behave as uninstalled for group membership — otherwise a lapsed-billing customer's employees keep
 *  reading the org's private gems while resolveOrgAccess denies them. Unsuspend needs no code here:
 *  sync.ts's `unsuspend` branch already calls upsertInstallation + syncInstallation, which re-runs
 *  replaceOrgMembers and, via Task 2, replaceSyncGrants. */
export async function setInstallationSuspended(db: AppDb, installationId: number, suspended: boolean): Promise<void> {
  await db.update(appInstallations).set({ suspended, updatedAt: sql`now()` }).where(eq(appInstallations.installationId, installationId));
  if (!suspended) return;
  const g = await groupByInstallation(db, installationId);
  if (g) await clearSyncGrants(db, g.id);
}

/** Uninstall = forget: the installation row, its synced members, and its private skill rows.
 *  The federated GROUP survives, with its invited guests and any gems shared with it — an invite was
 *  never GitHub's to revoke. Same via_sync predicate as member-removal, reconcile, and suspend.
 *  The group keeps its installation_id, so a reinstall reclaims it rather than forking. */
export async function deleteInstallation(db: AppDb, installationId: number): Promise<void> {
  const rows = await db.select({ orgScope: appInstallations.orgScope }).from(appInstallations)
    .where(eq(appInstallations.installationId, installationId)).limit(1);
  const orgScope = rows[0]?.orgScope;
  const g = await groupByInstallation(db, installationId);
  await db.delete(appInstallations).where(eq(appInstallations.installationId, installationId));
  if (g) await clearSyncGrants(db, g.id);
  if (orgScope) {
    await db.delete(orgMembers).where(eq(orgMembers.orgScope, orgScope));
    await deleteOrgSkills(db, orgScope);
  }
}
```

- [ ] **Step 7: Point the two sign-in call sites at the seam**

`packages/aggregator/src/binding.ts:70` and `src/auth/install.ts:88` both call `setAccountScopes(...)`. Replace each call with `captureOrgMemberships(...)` and update the import on that file's import line. Same arguments; the seam wraps `setAccountScopes`.

- [ ] **Step 8: Run test to verify it passes**

```bash
tsc -b && pnpm exec vitest run dist/aggregator/__tests__/groupFederation.test.js
```
Expected: PASS, 13 tests.

- [ ] **Step 9: Commit**

```bash
git add packages/aggregator/src/groupsFederation.ts packages/aggregator/src/index.ts packages/aggregator/src/webAuth.ts packages/aggregator/src/githubApp.ts packages/aggregator/src/binding.ts src/auth/install.ts src/aggregator/__tests__/groupFederation.test.ts
git commit -m "feat(githubApp): federated groups keyed on installation_id; sync grants gated on an active install"
```

---

### Task 2: Webhook mirroring, and the truncation regression test

**Files:**
- Modify: `src/githubApp/sync.ts:8-12` (imports), `:30-37` (roster), `:95-102` (member deltas)
- Create: `src/githubApp/__tests__/syncMirror.test.ts`

**Interfaces:**
- Consumes: `groupByScope`, `replaceSyncGrants`, `grantSync`, `clearSyncGrant`, `accountIdForLogin` (Task 1).

- [ ] **Step 1: Write the REGRESSION test first**

`sync.ts:30-37` already guards a truncated GitHub roster, with a comment explaining that a truncated replace "would REVOKE real members under the App-authoritative gate." Task 2 puts `replaceSyncGrants` inside that `else`. If anyone hoists it out, a truncated roster silently empties every federated group. **This test is mandatory, not optional.**

Create `src/githubApp/__tests__/syncMirror.test.ts`:

```ts
// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
// The truncation guard is a REGRESSION test. sync.ts:30-37 refuses to replace org_members when
// GitHub's roster came back truncated, because a partial replace revokes real members. The group
// mirror lives inside that same `else`. If it is ever hoisted out, this test fails loudly.
import { describe, it, expect, vi } from "vitest";
import { makeTestDb, upsertAccount, upsertInstallation, groupByScope, grantSync, grantInvite, listGroupMembers, groupMemberRole } from "@agentgem/aggregator";
import { syncInstallation, handleWebhookEvent } from "../sync.js";

const inst = { installationId: 101, orgScope: "acme", repoSelection: "selected" as const, suspended: false };
const acct = (db: any, n: string) => upsertAccount(db, { provider: "github", accountId: n, login: n });

function deps(db: any, listOrgMembers: () => Promise<{ members: { login: string; role: "admin" | "member" }[]; truncated: boolean }>) {
  return { db, cfg: {} as never, tokens: { forInstallation: async () => "t" } as never, http: {} as never, fetchImpl: (async () => new Response("{}")) as never, listOrgMembersImpl: listOrgMembers };
}

describe("github sync → group mirror", () => {
  it("CRITICAL REGRESSION: a truncated roster must NOT touch sync grants", async () => {
    const db = await makeTestDb();
    await upsertInstallation(db, inst);
    const g = (await groupByScope(db, "acme"))!;
    const alice = await acct(db, "alice");
    await grantSync(db, g.id, alice.id, "member");

    const spy = vi.fn(async () => ({ members: [], truncated: true }));
    await syncInstallation(deps(db, spy) as never, inst);

    expect(await groupMemberRole(db, g.id, alice.id)).toBe("member");   // survived
  });

  it("a complete roster replaces sync grants and spares guests", async () => {
    const db = await makeTestDb();
    await upsertInstallation(db, inst);
    const g = (await groupByScope(db, "acme"))!;
    const alice = await acct(db, "alice");
    const bob = await acct(db, "bob");
    const guest = await acct(db, "guest");
    await grantSync(db, g.id, alice.id, "member");
    await grantInvite(db, g.id, guest.id, "member");

    await syncInstallation(deps(db, async () => ({ members: [{ login: "bob", role: "member" }], truncated: false })) as never, inst);

    expect((await listGroupMembers(db, g.id)).map((m) => m.login).sort()).toEqual(["bob", "guest"]);
    void alice; void bob;
  });

  it("member_added grants via_sync when the account exists, and no-ops when it does not", async () => {
    const db = await makeTestDb();
    await upsertInstallation(db, inst);
    const g = (await groupByScope(db, "acme"))!;
    const alice = await acct(db, "alice");

    await handleWebhookEvent(deps(db, async () => ({ members: [], truncated: false })) as never, "organization",
      { action: "member_added", organization: { login: "acme" }, membership: { user: { login: "alice" }, role: "admin" } } as never);
    expect(await groupMemberRole(db, g.id, alice.id)).toBe("admin");

    await handleWebhookEvent(deps(db, async () => ({ members: [], truncated: false })) as never, "organization",
      { action: "member_added", organization: { login: "acme" }, membership: { user: { login: "ghost" }, role: "member" } } as never);
    expect((await listGroupMembers(db, g.id)).map((m) => m.login)).toEqual(["alice"]);
  });

  it("member_removed clears via_sync but leaves an invited guest in place", async () => {
    const db = await makeTestDb();
    await upsertInstallation(db, inst);
    const g = (await groupByScope(db, "acme"))!;
    const hire = await acct(db, "hire");
    await grantSync(db, g.id, hire.id, "member");
    await grantInvite(db, g.id, hire.id, "admin");

    await handleWebhookEvent(deps(db, async () => ({ members: [], truncated: false })) as never, "organization",
      { action: "member_removed", organization: { login: "acme" }, membership: { user: { login: "hire" } } } as never);

    expect(await groupMemberRole(db, g.id, hire.id)).toBe("admin");     // guest grant survives
    expect((await listGroupMembers(db, g.id))[0]).toMatchObject({ viaSync: false, viaInvite: true });
  });
});
```

> **Note on `listOrgMembersImpl`:** `sync.ts` currently calls the module-level `listOrgMembers(token, scope, fetchImpl)` directly. Thread it through `GithubAppDeps` as an optional `listOrgMembersImpl` (defaulting to the real one) so the truncation branch is reachable from a test without stubbing `fetch`. That is a two-line change in `sync.ts` and it is part of this task.

- [ ] **Step 2: Run test to verify it fails**

```bash
tsc -b && pnpm exec vitest run dist/githubApp/__tests__/syncMirror.test.js
```
Expected: FAIL — no group mirroring exists yet; `listOrgMembersImpl` is not a dep.

- [ ] **Step 3: Mirror the roster (inside the truncation guard)**

`src/githubApp/sync.ts:30-37` becomes:

```ts
const { members, truncated } = await (deps.listOrgMembersImpl ?? listOrgMembers)(token, inst.orgScope, deps.fetchImpl);
if (truncated) {
  // A truncated replace would REVOKE real members under the App-authoritative gate. Keep the
  // stored set; member_added/member_removed webhooks still apply single-row deltas.
  // The group mirror MUST stay inside this else — hoisting it out empties every federated group
  // on a truncated response. See __tests__/syncMirror.test.ts.
  console.error(`githubApp: ${inst.orgScope} member list truncated — keeping stored members`);
} else {
  await replaceOrgMembers(deps.db, inst.orgScope, members);
  const g = await groupByInstallation(deps.db, inst.installationId);
  if (g) await replaceSyncGrants(deps.db, g.id, members.map((m) => ({ login: m.login, role: m.role })));
}
```

- [ ] **Step 4: Mirror the single-row deltas**

`src/githubApp/sync.ts:95-102`'s two branches become:

```ts
if (action === "member_added") {
  const role = membership?.role === "admin" ? ("admin" as const) : ("member" as const);
  await upsertOrgMember(deps.db, org, login, role);
  const g = await groupByScope(deps.db, org);
  const accountId = g ? await accountIdForLogin(deps.db, login) : null;
  // No account yet: they have no session and can read nothing. Their grant appears at first sign-in.
  if (g && accountId) await grantSync(deps.db, g.id, accountId, role);
} else if (action === "member_removed") {
  await deleteOrgMember(deps.db, org, login);
  const g = await groupByScope(deps.db, org);
  const accountId = g ? await accountIdForLogin(deps.db, login) : null;
  // clearSyncGrant, never removeGroupMember: an invited guest who happened to be an org member
  // keeps the grant an admin gave them.
  if (g && accountId) await clearSyncGrant(deps.db, g.id, accountId);
}
return;
```

- [ ] **Step 5: Run test to verify it passes**

```bash
tsc -b && pnpm exec vitest run dist/githubApp/__tests__/syncMirror.test.js
```
Expected: PASS, 4 tests.

- [ ] **Step 6: Full suite**

```bash
pnpm clean && pnpm test
```
Expected: PASS. If `githubAppStore.test.js` or `webhook.test.js` fail, they assert the old `deleteInstallation` / `setInstallationSuspended` behavior — read them before changing them.

- [ ] **Step 7: Commit**

```bash
git add src/githubApp/sync.ts src/githubApp/__tests__/syncMirror.test.ts
git commit -m "feat(githubApp): mirror org roster + member deltas into via_sync grants"
```

---

## NOT in scope

| Deferred | Rationale |
|---|---|
| Collapsing `resolveOrgAccess` into group membership | Usage attribution (`usage_days.scope`) comes from the git-remote repo owner and has no group-shaped answer. A later spec. |
| Federated group admin semantics beyond GitHub's org role | `admin` maps from GitHub's org role at sync time. Who *else* may administer a federated group is a product question with no current caller. |
| `gh_user_id` on `org_members` | TODOS.md. Logins are mutable; a renamed account's `member_removed` no-ops until their next sign-in. |
| Batching `syncFederatedMemberships` | Accepted N+1. Comment, do not optimize. |
| Slack as a second sync source | Spec sequel. The lattice already admits one — a Slack reconciler would own `via_sync` for a differently-installed group. |

## Failure modes

| Codepath | Realistic production failure | Test? | Error handling? | Silent? |
|---|---|---|---|---|
| `replaceSyncGrants` | Crash or rate-limit between clear and grants | ✅ "atomic: a failure mid-replace leaves the old roster" | transaction rollback | No |
| `syncInstallation` | GitHub returns a truncated roster | ✅ **mandatory regression test** | keeps stored members, logs | No |
| `captureOrgMemberships` | App uninstalled, member signs in | ✅ "after uninstall, signing in does NOT re-grant" | grant withheld | No |
| `setInstallationSuspended` | Billing lapses | ✅ "suspend drops existing sync grants" | grants cleared | No |
| `ensureFederatedGroup` | Org renames | ✅ "renames the group in place" | upsert on installation_id | No |
| `accountIdForLogin` | Member renamed their GitHub account | ❌ | returns null → `member_removed` no-ops | **Yes** — self-heals at next sign-in; captured in TODOS.md |
| `grantSync` | Two webhooks race for the same account | ❌ | `on conflict do update` | No |

One silent failure: a renamed GitHub account's `member_removed` webhook no-ops, so an offboarded member who renamed keeps their grant until they next sign in (which clears it) or their captured scopes go stale. **Not a critical gap** — it has error handling (the null check) and a recorded remediation, but it is the one thing here that fails quietly. Fix it with the `gh_user_id` TODO.
