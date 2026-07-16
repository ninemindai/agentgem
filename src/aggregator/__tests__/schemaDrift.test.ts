// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
// The aggregator schema is defined twice on purpose: the drizzle pgTables are the query-side
// source of truth, and ensureSchema's raw DDL is the authority that actually creates columns
// (see the comment above ensureSchema). A pgTable column whose paired
// `alter table ... add column if not exists` was forgotten only surfaces at runtime, on the
// first typed insert that touches it — in production, after deploy. This guard makes that
// drift a CI failure instead: build the database exactly the way every boot does, then demand
// that every drizzle-declared column exists in information_schema.
//
// One-way check by design: columns that exist only in the DDL (dropped-but-not-yet-removed,
// operational extras) are harmless to typed queries and are NOT flagged.
import { describe, it, expect } from "vitest";
import { sql } from "drizzle-orm";
import { pgTable, text, getTableConfig, type PgTable } from "drizzle-orm/pg-core";
import { makeTestDb, schema, type AppDb } from "@agentgem/aggregator";

/** Every (table, column) a set of pgTables declares that the live database lacks. */
async function missingColumns(db: AppDb, tables: PgTable[]): Promise<string[]> {
  const res = await db.execute(sql`
    select table_name, column_name from information_schema.columns where table_schema = 'public'`);
  const rows = res.rows as { table_name: string; column_name: string }[];
  const present = new Set(rows.map((r) => `${r.table_name}.${r.column_name}`));
  const missing: string[] = [];
  for (const table of tables) {
    const cfg = getTableConfig(table);
    for (const col of cfg.columns) {
      if (!present.has(`${cfg.name}.${col.name}`)) missing.push(`${cfg.name}.${col.name}`);
    }
  }
  return missing;
}

describe("schema drift guard", () => {
  it("every column the drizzle schema declares exists after ensureSchema", async () => {
    const db = await makeTestDb();
    expect(await missingColumns(db, Object.values(schema))).toEqual([]);
  });

  it("reports a column the DDL never created", async () => {
    const db = await makeTestDb();
    // A pgTable claiming a column ensureSchema doesn't know about — the exact shape of the
    // drift this guard exists for (pgTable edited, paired `alter table` forgotten).
    const drifted = pgTable("producers", { ghost: text("ghost_column") });
    expect(await missingColumns(db, [drifted])).toEqual(["producers.ghost_column"]);
  });
});
