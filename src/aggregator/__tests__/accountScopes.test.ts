// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
import { describe, it, expect } from "vitest";
import { sql } from "drizzle-orm";
import { makeTestDb, upsertAccount, setAccountScopes, accountOwnsScope, accountScopeStatus, getAccountScopes } from "@agentgem/aggregator";

async function acct(db: Awaited<ReturnType<typeof makeTestDb>>, login: string): Promise<string> {
  const a = await upsertAccount(db, { provider: "github", accountId: `id-${login}`, login });
  return a.id;
}

/** The account's own namespace is `"user".handle`, not a scope row — so an ownership test for the
 *  caller's own name has to give them the handle. Mirrors what anchorAndScopes claims at sign-in. */
async function withHandle(db: Awaited<ReturnType<typeof makeTestDb>>, id: string, handle: string): Promise<void> {
  await db.execute(sql`
    insert into "user" (id, name, email, handle) values (${id}, ${handle}, ${`${handle}@example.com`}, ${handle})
    on conflict (id) do update set handle = ${handle}`);
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

  it("matches case-insensitively — a handle stored as `Raymond` (a GitHub login with a\n     capital) is owned when queried as the lowercase `raymond` the publish gate uses, and vice versa", async () => {
    const db = await makeTestDb();
    const id = await acct(db, "Raymond");
    await withHandle(db, id, "Raymond");
    expect(await accountOwnsScope(db, id, "raymond")).toBe(true);
    expect(await accountOwnsScope(db, id, "Raymond")).toBe(true);
    expect(await accountOwnsScope(db, id, "RAYMOND")).toBe(true);
  });

  it("security: a legacy role='self' scope row grants NOTHING — the handle is the only self grant", async () => {
    const db = await makeTestDb();
    const id = await acct(db, "alice");
    // Simulate a row written by the pre-re-key code (ScopeGrant no longer admits "self", so this
    // has to go in as raw SQL — which is exactly the point: only a stale DB row can look like this).
    await db.execute(sql`insert into account_scopes (account_id, scope, role) values (${id}, 'alice', 'self')`);
    expect(await accountOwnsScope(db, id, "alice")).toBe(false);
    // ...and it stays false even once the account has a DIFFERENT handle: the stale row is inert.
    await withHandle(db, id, "carol");
    expect(await accountOwnsScope(db, id, "alice")).toBe(false);
    expect(await accountOwnsScope(db, id, "carol")).toBe(true);
  });

  it("matches an org scope captured as `NineMindAI` when queried as lowercase `ninemindai`", async () => {
    const db = await makeTestDb();
    const id = await acct(db, "alice");
    await setAccountScopes(db, id, [{ scope: "NineMindAI", role: "admin" }]);
    expect(await accountOwnsScope(db, id, "ninemindai")).toBe(true);
  });

  it("security: an account with no row for a scope still gets false, in any casing", async () => {
    const db = await makeTestDb();
    const id = await acct(db, "alice");
    await setAccountScopes(db, id, ["alice"]);
    expect(await accountOwnsScope(db, id, "bob")).toBe(false);
    expect(await accountOwnsScope(db, id, "Bob")).toBe(false);
    expect(await accountOwnsScope(db, id, "BOB")).toBe(false);
  });

  it("security: a handle belonging to a different account never grants ownership, regardless of casing", async () => {
    const db = await makeTestDb();
    const raymond = await acct(db, "Raymond");
    const other = await acct(db, "someone-else");
    await withHandle(db, raymond, "Raymond");
    expect(await accountOwnsScope(db, other, "raymond")).toBe(false);
    expect(await accountOwnsScope(db, other, "Raymond")).toBe(false);
  });
});

describe("scope roles + freshness", () => {
  it("persists roles and lists them via getAccountScopes", async () => {
    const db = await makeTestDb();
    const id = await acct(db, "alice");
    // account_scopes now holds ORG memberships only; the account's own name lives in "user".handle.
    await setAccountScopes(db, id, [{ scope: "ninemind", role: "admin" }, "acme"]);
    const scopes = await getAccountScopes(db, id);
    expect(Object.fromEntries(scopes.map((s) => [s.scope, s.role]))).toEqual({ ninemind: "admin", acme: "member" });
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
