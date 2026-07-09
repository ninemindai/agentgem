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
