// src/aggregator/__tests__/db.test.ts
import { describe, it, expect } from "vitest";
import { createDb } from "../db.js";

describe("createDb", () => {
  it("creates the schema and runs real Postgres SQL", async () => {
    const db = await createDb();
    await db.exec("insert into producers(pubkey) values ('ed25519:p1');");
    const r = await db.query<{ c: number }>("select count(*)::int as c from producers");
    expect(r.rows[0].c).toBe(1);
    // the four tables exist
    const t = await db.query<{ n: string }>(
      "select table_name as n from information_schema.tables where table_schema='public' order by 1");
    expect(t.rows.map((x) => x.n)).toEqual(["attestations", "ingredients", "producers", "usage_edges"]);
  });
});
