// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
import { describe, it, expect } from "vitest";
import { sql } from "drizzle-orm";
import { deleteCatalogGem, upsertCatalogGem, makeTestDb } from "@agentgem/aggregator";

const mkAccount = async (db: Awaited<ReturnType<typeof makeTestDb>>, login: string | null, pid: string) => {
  const id = crypto.randomUUID();
  await db.execute(sql`insert into accounts (id, provider, provider_account_id, login)
                       values (${id}, 'github', ${pid}, ${login})`);
  return id;
};

describe("gem ownership is the uuid, never the login string", () => {
  it("the owner may unpublish; a different account may not", async () => {
    const db = await makeTestDb();
    const owner = await mkAccount(db, "raymond", "1");
    const other = await mkAccount(db, "mallory", "2");
    await upsertCatalogGem(db, { gemKey: "@r/a", version: "1.0.0", publishedBy: "raymond", ownerAccountId: owner, createdAtMs: 1 });

    expect(await deleteCatalogGem(db, "@r/a", "1.0.0", other)).toBe("forbidden");
    expect(await deleteCatalogGem(db, "@r/a", "1.0.0", owner)).toBe("deleted");
  });

  // THE test. An unresolved row is owned by NOBODY. If a string-compare fallback ever creeps
  // back in for NULL owners, this fails — which is exactly what it is here to do.
  it("an unresolved gem is unpublishable by ANYONE, including a login-string match", async () => {
    const db = await makeTestDb();
    const raymond = await mkAccount(db, "raymond", "1");
    await upsertCatalogGem(db, { gemKey: "@r/orphan", version: "1.0.0", publishedBy: "raymond", ownerAccountId: null, createdAtMs: 1 });

    expect(await deleteCatalogGem(db, "@r/orphan", "1.0.0", raymond)).toBe("forbidden");
    const still = await db.execute(sql`select count(*)::int as n from catalog_gems where gem_key = '@r/orphan'`);
    expect((still.rows as { n: number }[])[0].n).toBe(1);
  });

  it("two login-less accounts cannot delete each other's gems (the '' === '' hole)", async () => {
    const db = await makeTestDb();
    const a = await mkAccount(db, null, "g1");
    const b = await mkAccount(db, null, "g2");
    await upsertCatalogGem(db, { gemKey: "@x/a", version: "1.0.0", publishedBy: "", ownerAccountId: a, createdAtMs: 1 });
    expect(await deleteCatalogGem(db, "@x/a", "1.0.0", b)).toBe("forbidden");
    expect(await deleteCatalogGem(db, "@x/a", "1.0.0", a)).toBe("deleted");
  });

  it("a missing gem is not-found, regardless of owner", async () => {
    const db = await makeTestDb();
    const a = await mkAccount(db, "x", "1");
    expect(await deleteCatalogGem(db, "@no/pe", "1.0.0", a)).toBe("not-found");
  });
});
