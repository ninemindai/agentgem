// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
import { describe, it, expect } from "vitest";
import { sql } from "drizzle-orm";
import { claimHandle, accountIdForHandle, handleForAccountId, accountOwnsScope, setAccountScopes, makeTestDb } from "@agentgem/aggregator";

type Db = Awaited<ReturnType<typeof makeTestDb>>;
const mkUser = async (db: Db, pid: string) => {
  const id = crypto.randomUUID();
  await db.execute(sql`insert into accounts (id, provider, provider_account_id, login) values (${id}, 'fakeprov', ${pid}, null)`);
  await db.execute(sql`insert into "user" (id, email, email_verified) values (${id}, ${`${pid}@e.com`}, false)`);
  return id;
};

describe("claimHandle", () => {
  it("claims a free handle, sets the self-scope, and is resolvable both ways", async () => {
    const db = await makeTestDb();
    const a = await mkUser(db, "1");
    expect(await claimHandle(db, a, "raymond")).toEqual({ ok: true, handle: "raymond" });
    expect(await accountIdForHandle(db, "RAYMOND")).toBe(a);   // case-insensitive lookup
    expect(await handleForAccountId(db, a)).toBe("raymond");
    expect(await accountOwnsScope(db, a, "raymond")).toBe(true);
  });

  it("rejects an out-of-charset or empty handle with `charset`", async () => {
    const db = await makeTestDb();
    const a = await mkUser(db, "1");
    for (const bad of ["", "has space", "under_score", "a".repeat(40), "emoji🙂"]) {
      expect(await claimHandle(db, a, bad)).toEqual({ ok: false, reason: "charset" });
    }
  });

  it("rejects a handle already taken by another account", async () => {
    const db = await makeTestDb();
    const a = await mkUser(db, "1");
    const b = await mkUser(db, "2");
    await claimHandle(db, a, "taken");
    expect(await claimHandle(db, b, "taken")).toEqual({ ok: false, reason: "unavailable" });
  });

  // THE privilege-escalation guard. Claiming an org's name would grant a role='self' scope row,
  // and accountOwnsScope ignores role — so it would authorize publishing under that org.
  it("rejects a handle that names a known GitHub org, indistinguishably from `taken`", async () => {
    const db = await makeTestDb();
    const a = await mkUser(db, "1");
    await db.execute(sql`insert into org_members (org_scope, gh_login, role) values ('ninemindai', 'someone', 'member')`);
    await db.execute(sql`insert into org_settings (scope, updated_by) values ('acme', 'admin')`);

    expect(await claimHandle(db, a, "ninemindai")).toEqual({ ok: false, reason: "unavailable" });
    expect(await claimHandle(db, a, "NINEMINDAI")).toEqual({ ok: false, reason: "unavailable" });
    expect(await claimHandle(db, a, "acme")).toEqual({ ok: false, reason: "unavailable" });
    expect(await accountOwnsScope(db, a, "ninemindai")).toBe(false);   // no scope row was written
  });

  it("renaming preserves the account, org memberships, and frees the old handle, which grants the next claimant nothing", async () => {
    const db = await makeTestDb();
    const a = await mkUser(db, "1");
    const b = await mkUser(db, "2");
    await claimHandle(db, a, "old");
    // Simulate an org membership captured alongside the self-scope (e.g. from a GitHub sign-in) —
    // setAccountScopes REPLACES the whole set, so a naive rename could silently drop this.
    await setAccountScopes(db, a, [{ scope: "old", role: "self" }, { scope: "myorg", role: "admin" }]);
    await claimHandle(db, a, "new");
    expect(await handleForAccountId(db, a)).toBe("new");
    expect(await accountOwnsScope(db, a, "old")).toBe(false);   // stale self-scope is gone
    expect(await accountOwnsScope(db, a, "new")).toBe(true);
    expect(await accountOwnsScope(db, a, "myorg")).toBe(true);   // org membership survived the rename

    expect(await claimHandle(db, b, "old")).toEqual({ ok: true, handle: "old" });
    expect(await accountIdForHandle(db, "old")).toBe(b);
    expect(await accountOwnsScope(db, b, "old")).toBe(true);
  });

  it("a concurrent claim of the same handle is arbitrated by the unique index, not a prior SELECT", async () => {
    const db = await makeTestDb();
    const a = await mkUser(db, "1");
    const b = await mkUser(db, "2");
    const [ra, rb] = await Promise.all([claimHandle(db, a, "race"), claimHandle(db, b, "race")]);
    expect([ra.ok, rb.ok].filter(Boolean)).toHaveLength(1);   // exactly one winner
  });
});
