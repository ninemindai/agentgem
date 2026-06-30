// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
import { describe, it, expect } from "vitest";
import { makeTestDb, upsertAccount, toggleStar, starCounts, starredIds } from "@agentgem/aggregator";

async function acct(db: Awaited<ReturnType<typeof makeTestDb>>, id: string) {
  return upsertAccount(db, { provider: "github", accountId: id, login: "u" + id });
}

describe("stars store", () => {
  it("toggleStar inserts then deletes (idempotent round-trip), with live count", async () => {
    const db = await makeTestDb();
    const a = await acct(db, "1");
    const on = await toggleStar(db, a.id, "gem", "brainstorming-kit");
    expect(on).toEqual({ starred: true, count: 1 });
    const off = await toggleStar(db, a.id, "gem", "brainstorming-kit");
    expect(off).toEqual({ starred: false, count: 0 });
  });

  it("counts reflect multiple accounts; starCounts batches by id", async () => {
    const db = await makeTestDb();
    const a = await acct(db, "1"); const b = await acct(db, "2");
    await toggleStar(db, a.id, "gem", "x"); await toggleStar(db, b.id, "gem", "x");
    await toggleStar(db, a.id, "gem", "y");
    const c = await starCounts(db, "gem", ["x", "y", "z"]);
    expect(c.x).toBe(2); expect(c.y).toBe(1); expect(c.z ?? 0).toBe(0);
  });

  it("starredIds returns only this account's stars for the given kind", async () => {
    const db = await makeTestDb();
    const a = await acct(db, "1"); const b = await acct(db, "2");
    await toggleStar(db, a.id, "ingredient", "skill:s/a");
    await toggleStar(db, b.id, "ingredient", "skill:s/b");
    expect(await starredIds(db, a.id, "ingredient", ["skill:s/a", "skill:s/b"])).toEqual(["skill:s/a"]);
  });

  it("kinds are independent (same id under gem vs ingredient)", async () => {
    const db = await makeTestDb();
    const a = await acct(db, "1");
    await toggleStar(db, a.id, "gem", "dup");
    expect((await starCounts(db, "ingredient", ["dup"])).dup ?? 0).toBe(0);
  });
});
