// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
import { describe, it, expect } from "vitest";
import { sql } from "drizzle-orm";
import { makeTestDb } from "@agentgem/aggregator";

describe("catalog_gems.visibility column", () => {
  it("exists and defaults to 'public' for a row inserted without it", async () => {
    const db = await makeTestDb();
    await db.execute(sql`insert into catalog_gems (gem_key, version, published_by, created_at_ms) values ('@me/g', '0.1.0', 'me', 1000)`);
    const rows = await db.execute(sql`select visibility from catalog_gems where gem_key = '@me/g'`);
    // pglite returns { rows: [...] }
    const r = (rows as unknown as { rows: { visibility: string }[] }).rows[0];
    expect(r.visibility).toBe("public");
  });
});
