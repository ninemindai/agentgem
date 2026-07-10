// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
import { describe, it, expect } from "vitest";
import { sql } from "drizzle-orm";
import { makeTestDb, upsertAccount } from "@agentgem/aggregator";

describe("accounts anchor, generalized past GitHub", () => {
  it("writes an anchor row with a NULL login for a login-less provider", async () => {
    const db = await makeTestDb();
    const id = crypto.randomUUID();
    const a = await upsertAccount(db, { provider: "fakeprov", accountId: "ext-1", login: null, id });
    expect(a.id).toBe(id);
    expect(a.login).toBeNull();
  });

  it("the ten accounts.id foreign keys are satisfiable for a login-less account", async () => {
    const db = await makeTestDb();
    const id = crypto.randomUUID();
    await upsertAccount(db, { provider: "fakeprov", accountId: "ext-2", login: null, id });
    // stars is one of the ten FK tables; if the anchor exists, this insert must not throw.
    await db.execute(sql`insert into stars (id, account_id, target_kind, target_id) values (${crypto.randomUUID()}, ${id}, 'gem', '@a/b')`);
    const r = await db.execute(sql`select count(*)::int as n from stars where account_id = ${id}`);
    expect((r.rows as { n: number }[])[0].n).toBe(1);
  });

  it("a re-login upsert on the same (provider, provider_account_id) keeps the id stable", async () => {
    const db = await makeTestDb();
    const id = crypto.randomUUID();
    await upsertAccount(db, { provider: "fakeprov", accountId: "ext-3", login: null, id });
    const again = await upsertAccount(db, { provider: "fakeprov", accountId: "ext-3", login: null, id: crypto.randomUUID() });
    expect(again.id).toBe(id);
  });
});
