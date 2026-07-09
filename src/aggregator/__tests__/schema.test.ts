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
    expect((t.rows as { table_name: string }[]).map((x) => x.table_name)).toEqual(["account_bindings", "account_scopes", "accounts", "api_keys", "app_installations", "attestations", "catalog_gems", "curated_skills", "gem_adoptions", "gem_archives", "group_invites", "group_members", "groups", "handoff_codes", "ingredients", "model_outcomes", "org_members", "org_settings", "producers", "reviews", "share_cards", "stars", "usage_day_models", "usage_days", "usage_edges", "web_sessions"]);
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
  });
});
