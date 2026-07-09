// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
import { describe, it, expect } from "vitest";
import { sql } from "drizzle-orm";
import {
  makeTestDb, upsertAccount,
  createNativeGroup, getGroup, deleteNativeGroup, listGroupsForAccount, listGroupMembers,
  groupMemberRole, countGroupAdmins, grantInvite, revokeInviteGrant, removeMemberGuarded,
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

  it("removeMemberGuarded: 'not-member' when the account is not in the group", async () => {
    const db = await makeTestDb();
    const owner = await acct(db, "owner");
    const stranger = await acct(db, "stranger");
    const g = await createNativeGroup(db, owner.id, "G");
    expect(await removeMemberGuarded(db, g.id, stranger.id)).toBe("not-member");
  });

  it("removeMemberGuarded: 'last-admin' refuses to drop the sole admin", async () => {
    const db = await makeTestDb();
    const owner = await acct(db, "owner");
    const g = await createNativeGroup(db, owner.id, "G");
    expect(await removeMemberGuarded(db, g.id, owner.id)).toBe("last-admin");
    expect(await groupMemberRole(db, g.id, owner.id)).toBe("admin");   // untouched
  });

  it("removeMemberGuarded: 'removed' for a non-last-admin member, and the row is gone", async () => {
    const db = await makeTestDb();
    const owner = await acct(db, "owner");
    const member = await acct(db, "member");
    const g = await createNativeGroup(db, owner.id, "G");
    await grantInvite(db, g.id, member.id, "member");
    expect(await removeMemberGuarded(db, g.id, member.id)).toBe("removed");
    expect(await groupMemberRole(db, g.id, member.id)).toBeNull();
    expect((await listGroupMembers(db, g.id)).map((m) => m.login)).toEqual(["owner"]);
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
