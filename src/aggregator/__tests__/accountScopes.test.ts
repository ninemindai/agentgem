// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
import { describe, it, expect } from "vitest";
import { sql } from "drizzle-orm";
import { makeTestDb, upsertAccount, setAccountScopes, accountOwnsScope, accountScopeStatus, getAccountScopes } from "@agentgem/aggregator";

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

describe("scope roles + freshness", () => {
  it("persists roles and lists them via getAccountScopes", async () => {
    const db = await makeTestDb();
    const id = await acct(db, "alice");
    await setAccountScopes(db, id, [{ scope: "alice", role: "self" }, { scope: "ninemind", role: "admin" }, "acme"]);
    const scopes = await getAccountScopes(db, id);
    expect(Object.fromEntries(scopes.map((s) => [s.scope, s.role]))).toEqual({ alice: "self", ninemind: "admin", acme: "member" });
    for (const s of scopes) expect(s.capturedAt).toBeInstanceOf(Date);
  });

  it("accountScopeStatus: ok when fresh, stale when the capture aged out, none when absent", async () => {
    const db = await makeTestDb();
    const id = await acct(db, "alice");
    await setAccountScopes(db, id, ["ninemind"]);
    const week = 7 * 86_400_000;
    expect(await accountScopeStatus(db, id, "ninemind", week)).toBe("ok");
    expect(await accountScopeStatus(db, id, "elsewhere", week)).toBe("none");
    // Backdate the capture past the TTL: the grant still exists but must read as stale.
    await db.execute(sql`update account_scopes set captured_at = now() - interval '8 days' where account_id = ${id}::uuid`);
    expect(await accountScopeStatus(db, id, "ninemind", week)).toBe("stale");
    // A re-capture (fresh sign-in/bind) makes it ok again.
    await setAccountScopes(db, id, ["ninemind"]);
    expect(await accountScopeStatus(db, id, "ninemind", week)).toBe("ok");
  });
});
