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

/** Remove a member's invite grant, refusing to drop the group's LAST admin — atomically, so two
 *  concurrent removals cannot both pass the check and leave zero admins. The member's row survives
 *  iff a via_sync grant remains (revoking an invite must not evict an org member). */
export async function removeMemberGuarded(
  db: AppDb, groupId: string, accountId: string,
): Promise<"removed" | "not-member" | "last-admin"> {
  return db.transaction(async (tx) => {
    // Lock this group's member rows so concurrent removals serialize on the admin count.
    const rows = (await tx.execute(sql`
      select account_id, sync_role, invite_role from group_members
      where group_id = ${groupId} for update`)).rows as
      { account_id: string; sync_role: string | null; invite_role: string | null }[];
    // Postgres normalizes uuid columns to lowercase on SELECT; the route accepts case-insensitive
    // UUIDs, so normalize the needle before comparing or an uppercase id would never match.
    const needle = accountId.toLowerCase();
    const target = rows.find((r) => r.account_id === needle);
    if (!target) return "not-member";
    const isAdmin = (r: { sync_role: string | null; invite_role: string | null }) =>
      r.sync_role === "admin" || r.invite_role === "admin";
    if (isAdmin(target) && rows.filter(isAdmin).length === 1) return "last-admin";
    // Same semantics as revokeInviteGrant: clear the invite grant; keep the row iff via_sync remains.
    await tx.execute(sql`
      update group_members set via_invite = false, invite_role = null
      where group_id = ${groupId} and account_id = ${accountId} and via_sync`);
    await tx.execute(sql`
      delete from group_members
      where group_id = ${groupId} and account_id = ${accountId} and not via_sync`);
    return "removed";
  });
}
