import { describe, it, expect } from "vitest";
import { sql } from "drizzle-orm";
import { makeTestDb, upsertAccount } from "@agentgem/aggregator";
import { producers } from "@agentgem/aggregator";

describe("schema/testDb", () => {
  it("creates the schema and runs drizzle queries on pglite", async () => {
    const db = await makeTestDb();
    await db.insert(producers).values({ pubkey: "ed25519:p1" });
    const rows = await db.select().from(producers);
    expect(rows.map((r) => r.pubkey)).toEqual(["ed25519:p1"]);
    const t = await db.execute(sql`select table_name from information_schema.tables where table_schema='public' order by 1`);
    expect((t.rows as { table_name: string }[]).map((x) => x.table_name)).toEqual(["account", "account_bindings", "account_scopes", "accounts", "api_keys", "app_installations", "attestations", "catalog_gems", "curated_skills", "game_plays", "gem_adoptions", "gem_archives", "group_invites", "group_members", "groups", "handoff_codes", "ingredients", "model_outcomes", "org_members", "org_settings", "producers", "reviews", "session", "share_cards", "stars", "usage_day_models", "usage_days", "usage_edges", "user", "verification"]);
  });

  it("groups: kind is a closed set, and federated iff installation_id", async () => {
    const db = await makeTestDb();
    const g = sql`insert into groups (id, kind, installation_id, scope, name) values`;
    await expect(db.execute(sql`${g} (gen_random_uuid(), 'garbage', null, null, 'x')`)).rejects.toThrow();
    await expect(db.execute(sql`${g} (gen_random_uuid(), 'native', 101, null, 'x')`)).rejects.toThrow();
    await expect(db.execute(sql`${g} (gen_random_uuid(), 'federated', null, 'acme', 'x')`)).rejects.toThrow();
    await expect(db.execute(sql`${g} (gen_random_uuid(), 'native', null, null, 'ok')`)).resolves.toBeDefined();
  });

  it("group_members: a row with no grant cannot exist, and roles track their flags", async () => {
    const db = await makeTestDb();
    const acct = await upsertAccount(db, { provider: "github", accountId: "1", login: "neo" });
    const rows = await db.execute(sql`insert into groups (id, kind, name) values (gen_random_uuid(), 'native', 'g') returning id`);
    const gid = (rows.rows as { id: string }[])[0].id;
    const m = sql`insert into group_members (group_id, account_id, via_sync, via_invite, sync_role, invite_role) values`;
    // no grant at all
    await expect(db.execute(sql`${m} (${gid}, ${acct.id}, false, false, null, null)`)).rejects.toThrow();
    // via_invite set but no invite_role
    await expect(db.execute(sql`${m} (${gid}, ${acct.id}, false, true, null, null)`)).rejects.toThrow();
    // invite_role set but via_invite false
    await expect(db.execute(sql`${m} (${gid}, ${acct.id}, false, false, null, 'member')`)).rejects.toThrow();
    // role outside the closed set
    await expect(db.execute(sql`${m} (${gid}, ${acct.id}, false, true, null, 'owner')`)).rejects.toThrow();
    // via_sync set but no sync_role
    await expect(db.execute(sql`${m} (${gid}, ${acct.id}, true, false, null, null)`)).rejects.toThrow();
    // sync role outside the closed set
    await expect(db.execute(sql`${m} (${gid}, ${acct.id}, true, false, 'owner', null)`)).rejects.toThrow();
  });

  it("group_invites: role is a closed set", async () => {
    const db = await makeTestDb();
    const acct = await upsertAccount(db, { provider: "github", accountId: "1", login: "neo" });
    const rows = await db.execute(sql`insert into groups (id, kind, name) values (gen_random_uuid(), 'native', 'g') returning id`);
    const gid = (rows.rows as { id: string }[])[0].id;
    await expect(db.execute(sql`insert into group_invites (id, token_hash, group_id, role, expires_at, created_by) values (gen_random_uuid(), 'hash1', ${gid}, 'owner', now() + interval '1 day', ${acct.id})`)).rejects.toThrow();
  });

  it("handle: nullable, unique, charset-constrained at the DDL level", async () => {
    const db = await makeTestDb();
    const u = (h: string | null) =>
      sql`insert into "user" (id, email, email_verified, handle) values (gen_random_uuid()::text, ${`${Math.random()}@e.com`}, false, ${h})`;

    await db.execute(u(null));                 // NULL is legal
    await db.execute(u(null));                 // ...and repeatable: UNIQUE permits many NULLs
    await db.execute(u("raymond"));
    await expect(db.execute(u("raymond"))).rejects.toThrow();   // taken
    await expect(db.execute(u(""))).rejects.toThrow();          // empty string is NOT a handle
    await expect(db.execute(u("has space"))).rejects.toThrow(); // charset
    await expect(db.execute(u("a".repeat(40)))).rejects.toThrow(); // length
  });

  it("accounts.login is nullable; catalog_gems has a nullable owner FK", async () => {
    const db = await makeTestDb();
    await db.execute(sql`insert into accounts (id, provider, provider_account_id, login)
                         values (gen_random_uuid(), 'google', 'g1', null)`);
    const r = await db.execute(sql`select login from accounts where provider_account_id = 'g1'`);
    expect((r.rows as { login: string | null }[])[0].login).toBeNull();

    await expect(db.execute(
      sql`insert into catalog_gems (gem_key, version, published_by, created_at_ms, owner_account_id)
          values ('@a/b', '1.0.0', 'x', 1, gen_random_uuid())`,
    )).rejects.toThrow();  // owner_account_id must reference a real account
  });
});
