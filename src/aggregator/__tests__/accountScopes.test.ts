// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
import { describe, it, expect } from "vitest";
import { makeTestDb, upsertAccount, setAccountScopes, accountOwnsScope } from "@agentgem/aggregator";

async function acct(db: Awaited<ReturnType<typeof makeTestDb>>, login: string): Promise<string> {
  const a = await upsertAccount(db, { provider: "github", accountId: `id-${login}`, login });
  return a.id;
}

describe("account_scopes", () => {
  it("owns a scope after it is set, and not a foreign scope", async () => {
    const db = await makeTestDb();
    const id = await acct(db, "alice");
    await setAccountScopes(db, id, ["alice", "ninemind"]);
    expect(await accountOwnsScope(db, id, "alice")).toBe(true);
    expect(await accountOwnsScope(db, id, "ninemind")).toBe(true);
    expect(await accountOwnsScope(db, id, "bob")).toBe(false);
  });

  it("REPLACE semantics — re-setting overwrites the previous set", async () => {
    const db = await makeTestDb();
    const id = await acct(db, "alice");
    await setAccountScopes(db, id, ["alice", "oldorg"]);
    await setAccountScopes(db, id, ["alice", "neworg"]);
    expect(await accountOwnsScope(db, id, "alice")).toBe(true);
    expect(await accountOwnsScope(db, id, "neworg")).toBe(true);
    expect(await accountOwnsScope(db, id, "oldorg")).toBe(false);
  });

  it("dedupes and tolerates an empty set", async () => {
    const db = await makeTestDb();
    const id = await acct(db, "alice");
    await setAccountScopes(db, id, ["alice", "alice"]);   // no PK conflict
    expect(await accountOwnsScope(db, id, "alice")).toBe(true);
    await setAccountScopes(db, id, []);                    // clears
    expect(await accountOwnsScope(db, id, "alice")).toBe(false);
  });

  it("scopes are per-account", async () => {
    const db = await makeTestDb();
    const alice = await acct(db, "alice");
    const bob = await acct(db, "bob");
    await setAccountScopes(db, alice, ["ninemind"]);
    expect(await accountOwnsScope(db, bob, "ninemind")).toBe(false);
  });
});
