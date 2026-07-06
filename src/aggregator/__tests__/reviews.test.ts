// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
import { describe, it, expect } from "vitest";
import { sql } from "drizzle-orm";
import { makeTestDb, upsertAccount, upsertReview, deleteReview, reviewSummary, reviewSummaries, listReviews, myReview } from "@agentgem/aggregator";

async function acct(db: Awaited<ReturnType<typeof makeTestDb>>, id: string, login = "u" + id) {
  return upsertAccount(db, { provider: "github", accountId: id, login });
}
const ID = "matt-skills/productivity/brainstorming.md";

describe("reviews store", () => {
  it("upsertReview inserts then EDITS in place (one row, updated fields)", async () => {
    const db = await makeTestDb();
    const a = await acct(db, "1");
    const first = await upsertReview(db, a.id, "skill", ID, 4, "solid");
    expect(first.rating).toBe(4);
    const edit = await upsertReview(db, a.id, "skill", ID, 2, "changed my mind");
    expect(edit.rating).toBe(2);
    expect(edit.body).toBe("changed my mind");
    const n = await db.execute<{ n: number }>(sql`select count(*)::int as n from reviews`);
    expect(n.rows[0]!.n).toBe(1); // edit, not a second row
    expect(new Date(edit.updatedAt).getTime()).toBeGreaterThanOrEqual(new Date(first.createdAt).getTime());
  });

  it("reviewSummary averages + counts; zero rows → {avg:0,count:0}", async () => {
    const db = await makeTestDb();
    expect(await reviewSummary(db, "skill", ID)).toEqual({ avg: 0, count: 0 });
    const a = await acct(db, "1"); const b = await acct(db, "2");
    await upsertReview(db, a.id, "skill", ID, 5, null);
    await upsertReview(db, b.id, "skill", ID, 2, null);
    expect(await reviewSummary(db, "skill", ID)).toEqual({ avg: 3.5, count: 2 });
  });

  it("reviewSummaries batches per target; absent targets omitted", async () => {
    const db = await makeTestDb();
    const a = await acct(db, "1");
    await upsertReview(db, a.id, "skill", "src/a.md", 5, null);
    await upsertReview(db, a.id, "skill", "src/b.md", 3, null);
    const s = await reviewSummaries(db, "skill", ["src/a.md", "src/b.md", "src/none.md"]);
    expect(s["src/a.md"]).toEqual({ avg: 5, count: 1 });
    expect(s["src/b.md"]).toEqual({ avg: 3, count: 1 });
    expect(s["src/none.md"]).toBeUndefined();
    expect(await reviewSummaries(db, "skill", [])).toEqual({});
  });

  it("listReviews joins the reviewer, newest first, honoring limit", async () => {
    const db = await makeTestDb();
    const a = await acct(db, "1", "alice"); const b = await acct(db, "2", "bob");
    await upsertReview(db, a.id, "skill", ID, 4, "from alice");
    // Deterministic ordering: both inserts can land in the same now() tick under load, making
    // "newest first" a coin flip — backdate alice's row so bob's is strictly newer.
    await db.execute(sql`update reviews set created_at = created_at - interval '1 minute' where account_id = ${a.id}::uuid`);
    await upsertReview(db, b.id, "skill", ID, 5, "from bob");
    const all = await listReviews(db, "skill", ID);
    expect(all).toHaveLength(2);
    expect(all[0]!.login).toBe("bob"); // newest first
    expect(all[0]!.body).toBe("from bob");
    expect(all.map((r) => r.login).sort()).toEqual(["alice", "bob"]);
    expect(await listReviews(db, "skill", ID, 1)).toHaveLength(1);
  });

  it("myReview returns the caller's row or null; deleteReview removes it", async () => {
    const db = await makeTestDb();
    const a = await acct(db, "1");
    expect(await myReview(db, a.id, "skill", ID)).toBeNull();
    await upsertReview(db, a.id, "skill", ID, 3, "mine");
    expect((await myReview(db, a.id, "skill", ID))?.body).toBe("mine");
    await deleteReview(db, a.id, "skill", ID);
    expect(await myReview(db, a.id, "skill", ID)).toBeNull();
    expect(await reviewSummary(db, "skill", ID)).toEqual({ avg: 0, count: 0 });
  });

  it("rejects an out-of-range rating (DB CHECK constraint)", async () => {
    const db = await makeTestDb();
    const a = await acct(db, "1");
    await expect(upsertReview(db, a.id, "skill", ID, 6, null)).rejects.toThrow();
  });
});
