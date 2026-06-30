import { describe, it, expect } from "vitest";
import { sql } from "drizzle-orm";
import { makeTestDb } from "../testDb.js";
import { shareCards } from "../schema.js";

describe("share_cards schema", () => {
  it("stores and reads a certificate record", async () => {
    const db = await makeTestDb();
    await db.insert(shareCards).values({
      id: "abc1234567", kind: "certificate",
      counts: { breadth: 14, battleTested: 3, portable: 5 },
      generatedAtMs: 111, createdAtMs: 222,
    });
    const rows = await db.select().from(shareCards).where(sql`id = 'abc1234567'`);
    expect(rows).toHaveLength(1);
    expect(rows[0].counts).toEqual({ breadth: 14, battleTested: 3, portable: 5 });
    expect(Number(rows[0].generatedAtMs)).toBe(111);
  });

  it("stores a gem row (payload set, counts null)", async () => {
    const db = await makeTestDb();
    await db.insert(shareCards).values({
      id: "gem1234567", kind: "gem", counts: null,
      payload: { name: "my-workflow", provenance: "Distilled from 5 sessions" },
      generatedAtMs: 111, createdAtMs: 222,
    });
    const rows = await db.select().from(shareCards).where(sql`id = 'gem1234567'`);
    expect(rows[0].payload).toEqual({ name: "my-workflow", provenance: "Distilled from 5 sessions" });
    expect(rows[0].counts).toBeNull();
  });
});
