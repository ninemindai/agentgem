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
});
