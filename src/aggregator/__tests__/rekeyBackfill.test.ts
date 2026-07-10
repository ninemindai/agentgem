// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
import { describe, it, expect } from "vitest";
import { sql } from "drizzle-orm";
import { backfillGemOwners, backfillBindingAnchors, ensureSchema, makeTestDb } from "@agentgem/aggregator";

const acct = (login: string | null, pid: string) =>
  sql`insert into accounts (id, provider, provider_account_id, login)
      values (gen_random_uuid(), 'github', ${pid}, ${login}) returning id`;
const gem = (key: string, by: string) =>
  sql`insert into catalog_gems (gem_key, version, published_by, created_at_ms)
      values (${key}, '1.0.0', ${by}, 1)`;
// account_bindings FKs to producers(pubkey), so seed that first (two statements: pglite's
// execute() takes one statement at a time).
const seedBinding = async (db: Awaited<ReturnType<typeof makeTestDb>>, pubkey: string, pid: string, login: string) => {
  await db.execute(sql`insert into producers (pubkey) values (${pubkey})`);
  await db.execute(sql`insert into account_bindings (pubkey, provider, account_id, account_login)
      values (${pubkey}, 'github', ${pid}, ${login})`);
};
const ownerOf = async (db: Awaited<ReturnType<typeof makeTestDb>>, key: string) =>
  ((await db.execute(sql`select owner_account_id from catalog_gems where gem_key = ${key}`))
    .rows as { owner_account_id: string | null }[])[0].owner_account_id;
const anchorFor = async (db: Awaited<ReturnType<typeof makeTestDb>>, pid: string) =>
  ((await db.execute(sql`select id, login from accounts where provider = 'github' and provider_account_id = ${pid}`))
    .rows as { id: string; login: string }[])[0];

describe("backfillGemOwners", () => {
  it("resolves a gem to its sole matching account, case-insensitively", async () => {
    const db = await makeTestDb();
    const id = ((await db.execute(acct("Raymond", "1"))).rows as { id: string }[])[0].id;
    await db.execute(gem("@r/a", "raymond"));
    const r = await backfillGemOwners(db);
    expect(r).toEqual({ resolved: 1, unresolved: 0 });
    expect(await ownerOf(db, "@r/a")).toBe(id);
  });

  it("leaves BOTH gems unresolved when two accounts share a login", async () => {
    const db = await makeTestDb();
    await db.execute(acct("dup", "1"));
    await db.execute(acct("DUP", "2"));       // no unique constraint on accounts.login
    await db.execute(gem("@d/a", "dup"));
    await db.execute(gem("@d/b", "DUP"));
    const r = await backfillGemOwners(db);
    expect(r).toEqual({ resolved: 0, unresolved: 2 });
    expect(await ownerOf(db, "@d/a")).toBeNull();
    expect(await ownerOf(db, "@d/b")).toBeNull();
  });

  it("leaves a gem unresolved when no account matches, and is idempotent", async () => {
    const db = await makeTestDb();
    await db.execute(gem("@ghost/a", "deleted-user"));
    expect(await backfillGemOwners(db)).toEqual({ resolved: 0, unresolved: 1 });
    expect(await backfillGemOwners(db)).toEqual({ resolved: 0, unresolved: 1 });
    expect(await ownerOf(db, "@ghost/a")).toBeNull();
  });

  it("never re-assigns a row that already has an owner", async () => {
    const db = await makeTestDb();
    const a = ((await db.execute(acct("keep", "1"))).rows as { id: string }[])[0].id;
    await db.execute(acct("other", "2"));
    await db.execute(gem("@k/a", "other"));
    await db.execute(sql`update catalog_gems set owner_account_id = ${a} where gem_key = '@k/a'`);
    await backfillGemOwners(db);
    expect(await ownerOf(db, "@k/a")).toBe(a);   // not reassigned to 'other'
  });

  it("resolved counts ALL owned rows, not just the ones assigned on this call", async () => {
    const db = await makeTestDb();
    await db.execute(acct("first", "1"));
    await db.execute(gem("@r/a", "first"));
    expect(await backfillGemOwners(db)).toEqual({ resolved: 1, unresolved: 0 });

    // A second resolvable gem for a DIFFERENT account, assigned on this call. A per-run-count
    // implementation would report resolved: 1 here (only @r/b was touched by this UPDATE); the
    // contract requires resolved: 2, because @r/a is still owned too.
    await db.execute(acct("second", "2"));
    await db.execute(gem("@r/b", "second"));
    expect(await backfillGemOwners(db)).toEqual({ resolved: 2, unresolved: 0 });
  });
});

describe("backfillBindingAnchors", () => {
  it("creates an anchor for a binding with no accounts row, copying provider/account_id/login off the binding", async () => {
    const db = await makeTestDb();
    await seedBinding(db, "pk1", "42", "octocat");
    expect(await backfillBindingAnchors(db)).toEqual({ created: 1 });
    const a = await anchorFor(db, "42");
    expect(a).toMatchObject({ login: "octocat" });
    expect(a.id).toBeTruthy();
  });

  it("is idempotent: a second run creates nothing, and no duplicate anchor is left behind", async () => {
    const db = await makeTestDb();
    await seedBinding(db, "pk1", "42", "octocat");
    expect(await backfillBindingAnchors(db)).toEqual({ created: 1 });
    expect(await backfillBindingAnchors(db)).toEqual({ created: 0 });
    const rows = (await db.execute(
      sql`select count(*)::int as n from accounts where provider = 'github' and provider_account_id = '42'`,
    )).rows as { n: number }[];
    expect(rows[0].n).toBe(1);
  });

  it("leaves an already-existing anchor completely untouched — same id, same login", async () => {
    const db = await makeTestDb();
    const existingId = ((await db.execute(acct("keep-me", "42"))).rows as { id: string }[])[0].id;
    await seedBinding(db, "pk1", "42", "binding-login"); // binding disagrees with the anchor's login
    expect(await backfillBindingAnchors(db)).toEqual({ created: 0 });
    const a = await anchorFor(db, "42");
    expect(a.id).toBe(existingId);      // not re-keyed
    expect(a.login).toBe("keep-me");    // not overwritten by the binding's login
  });

  // The ordering property: backfillBindingAnchors MUST run before backfillGemOwners (see the
  // comment in ensureSchema, schema.ts). If it ran after, the gem below would still resolve
  // to owner_account_id = NULL on this pass, because backfillGemOwners would have already run
  // with no `accounts` row to match "octocat" against.
  it("an anchor created by this backfill resolves a gem owned by the same login, when run before backfillGemOwners", async () => {
    const db = await makeTestDb(); // ensureSchema already ran once, against empty tables
    await seedBinding(db, "pk1", "42", "octocat");
    await db.execute(gem("@octocat/kit", "octocat"));
    await ensureSchema(db); // re-run: this is exactly what every boot does
    const a = await anchorFor(db, "42");
    expect(a).toBeTruthy();
    expect(await ownerOf(db, "@octocat/kit")).toBe(a.id);
  });
});
