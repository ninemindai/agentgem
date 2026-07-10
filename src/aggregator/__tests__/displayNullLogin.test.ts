// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
// Display sites tolerate accounts.login = NULL (identity re-key Task 10). listReviews is the
// concrete reader exercised here: `a.login` (Task 3 made it nullable) must fall back to
// "user".handle, then "user".name, then '' — never render `null`.
import { describe, it, expect } from "vitest";
import { sql } from "drizzle-orm";
import { makeTestDb, upsertAccount, upsertReview, listReviews } from "@agentgem/aggregator";

describe("display sites tolerate a NULL accounts.login", () => {
  it("a review by a login-less author renders their handle, not null", async () => {
    const db = await makeTestDb();
    const account = await upsertAccount(db, { provider: "fakeprov", accountId: "1", login: null });
    await db.execute(sql`insert into "user" (id, email, email_verified, handle, name) values (${account.id}, 'g@e.com', false, 'gwen', 'Gwen')`);
    await upsertReview(db, account.id, "skill", "src/a.md", 5, "good");

    const rows = await listReviews(db, "skill", "src/a.md");
    expect(rows[0]!.login).toBe("gwen");
  });

  it("falls back to name when neither login nor handle exists", async () => {
    const db = await makeTestDb();
    const account = await upsertAccount(db, { provider: "fakeprov", accountId: "2", login: null });
    await db.execute(sql`insert into "user" (id, email, email_verified, name) values (${account.id}, 'h@e.com', false, 'Hank')`);
    await upsertReview(db, account.id, "skill", "src/b.md", 4, "ok");

    const rows = await listReviews(db, "skill", "src/b.md");
    expect(rows[0]!.login).toBe("Hank");
  });

  it("falls back to '' when the account has no companion \"user\" row at all", async () => {
    const db = await makeTestDb();
    // Mirrors reviews.test.ts's acct() helper: upsertAccount alone, no "user" row — must not
    // vanish behind an inner join.
    const account = await upsertAccount(db, { provider: "fakeprov", accountId: "3", login: null });
    await upsertReview(db, account.id, "skill", "src/c.md", 3, "meh");

    const rows = await listReviews(db, "skill", "src/c.md");
    expect(rows[0]!.login).toBe("");
  });
});
