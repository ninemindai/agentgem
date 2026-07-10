// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
import { describe, it, expect } from "vitest";
import { randomUUID } from "node:crypto";
import { makeTestDb, accounts, upsertGemArchive, getGemArchive, deleteGemArchiveOwned, archiveOnlyVersion } from "@agentgem/aggregator";

async function acct(db: Awaited<ReturnType<typeof makeTestDb>>): Promise<string> {
  const id = randomUUID();
  await db.insert(accounts).values({ id, provider: "github", providerAccountId: id, login: "u" });
  return id;
}

describe("gem_archives ownership", () => {
  it("stores an owner and lets that owner delete it", async () => {
    const db = await makeTestDb();
    const owner = await acct(db);
    await upsertGemArchive(db, { gemKey: "xK3f9a2Bq1", version: "1", bytes: new Uint8Array([1, 2, 3]), digest: "d", createdAtMs: 1, ownerAccountId: owner });
    expect(await getGemArchive(db, "xK3f9a2Bq1", "1")).not.toBeNull();
    expect(await deleteGemArchiveOwned(db, "xK3f9a2Bq1", owner)).toBe("deleted");
    expect(await getGemArchive(db, "xK3f9a2Bq1", "1")).toBeNull();
  });

  it("forbids a different account from deleting (fail-closed on wrong owner)", async () => {
    const db = await makeTestDb();
    const owner = await acct(db), other = await acct(db);
    await upsertGemArchive(db, { gemKey: "xK3f9a2Bq1", version: "1", bytes: new Uint8Array([1]), digest: "d", createdAtMs: 1, ownerAccountId: owner });
    expect(await deleteGemArchiveOwned(db, "xK3f9a2Bq1", other)).toBe("forbidden");
    expect(await getGemArchive(db, "xK3f9a2Bq1", "1")).not.toBeNull();
  });

  it("forbids deleting a NULL-owner archive — owned by nobody", async () => {
    const db = await makeTestDb();
    const someone = await acct(db);
    await upsertGemArchive(db, { gemKey: "@octocat/tetris", version: "1.0.0", bytes: new Uint8Array([1]), digest: "d", createdAtMs: 1 }); // no owner
    expect(await deleteGemArchiveOwned(db, "@octocat/tetris", someone)).toBe("forbidden");
  });

  it("returns not-found for an absent key", async () => {
    const db = await makeTestDb();
    expect(await deleteGemArchiveOwned(db, "nope", await acct(db))).toBe("not-found");
  });

  it("archiveOnlyVersion returns the version of an unlisted (catalog-less) archive", async () => {
    const db = await makeTestDb();
    await upsertGemArchive(db, { gemKey: "xK3f9a2Bq1", version: "1", bytes: new Uint8Array([1]), digest: "d", createdAtMs: 1, ownerAccountId: await acct(db) });
    expect(await archiveOnlyVersion(db, "xK3f9a2Bq1")).toBe("1");
  });

  it("deletes only the caller's own row, never a co-key row owned by someone else", async () => {
    const db = await makeTestDb();
    const a = await acct(db), b = await acct(db);
    await upsertGemArchive(db, { gemKey: "shared", version: "1", bytes: new Uint8Array([1]), digest: "d", createdAtMs: 1, ownerAccountId: a });
    await upsertGemArchive(db, { gemKey: "shared", version: "2", bytes: new Uint8Array([2]), digest: "d", createdAtMs: 2, ownerAccountId: b });
    expect(await deleteGemArchiveOwned(db, "shared", a)).toBe("deleted");
    expect(await getGemArchive(db, "shared", "1")).toBeNull();          // a's row gone
    expect(await getGemArchive(db, "shared", "2")).not.toBeNull();      // b's row SURVIVES
  });
});
