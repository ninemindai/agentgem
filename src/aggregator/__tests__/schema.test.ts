import { describe, it, expect } from "vitest";
import { sql } from "drizzle-orm";
import { makeTestDb } from "@agentgem/aggregator";
import { producers } from "@agentgem/aggregator";

describe("schema/testDb", () => {
  it("creates the schema and runs drizzle queries on pglite", async () => {
    const db = await makeTestDb();
    await db.insert(producers).values({ pubkey: "ed25519:p1" });
    const rows = await db.select().from(producers);
    expect(rows.map((r) => r.pubkey)).toEqual(["ed25519:p1"]);
    const t = await db.execute(sql`select table_name from information_schema.tables where table_schema='public' order by 1`);
    expect((t.rows as { table_name: string }[]).map((x) => x.table_name)).toEqual(["account_bindings", "account_scopes", "accounts", "api_keys", "app_installations", "attestations", "catalog_gems", "curated_skills", "gem_adoptions", "handoff_codes", "ingredients", "model_outcomes", "org_members", "org_settings", "producers", "reviews", "share_cards", "stars", "usage_day_models", "usage_days", "usage_edges", "web_sessions"]);
  });
});
