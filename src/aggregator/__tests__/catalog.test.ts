// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
import { describe, it, expect } from "vitest";
import { sql } from "drizzle-orm";
import { makeTestDb, upsertCatalogGem, upsertGemArchive, getGemArchive, listCatalogGems, deleteCatalogGem, clampGrade } from "@agentgem/aggregator";

// catalog_gems.owner_account_id FK-references accounts(id), so ownership tests need a real anchor row.
const mkAccount = async (db: Awaited<ReturnType<typeof makeTestDb>>, login: string, pid: string) => {
  const id = crypto.randomUUID();
  await db.execute(sql`insert into accounts (id, provider, provider_account_id, login) values (${id}, 'github', ${pid}, ${login})`);
  return id;
};

describe("catalog store", () => {
  it("inserts and lists a catalog gem", async () => {
    const db = await makeTestDb();
    await upsertCatalogGem(db, { gemKey: "@octocat/kit", version: "1.0.0", publishedBy: "octocat", description: "d", tags: ["x"], artifactKinds: ["skill"], grade: 2, createdAtMs: 1000 });
    const rows = await listCatalogGems(db);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ gemKey: "@octocat/kit", version: "1.0.0", publishedBy: "octocat", grade: 2, tags: ["x"] });
  });

  it("upserts on (gemKey, version) — no duplicate rows", async () => {
    const db = await makeTestDb();
    await upsertCatalogGem(db, { gemKey: "@o/k", version: "1.0.0", publishedBy: "o", description: "first", createdAtMs: 1 });
    await upsertCatalogGem(db, { gemKey: "@o/k", version: "1.0.0", publishedBy: "o", description: "second", createdAtMs: 2 });
    const rows = await listCatalogGems(db);
    expect(rows).toHaveLength(1);
    expect(rows[0].description).toBe("second");
  });
});

describe("deleteCatalogGem (owner unpublish)", () => {
  it("deletes the catalog row AND the archive bytes when the owner requests it", async () => {
    const db = await makeTestDb();
    const owner = await mkAccount(db, "octocat", "1");
    await upsertCatalogGem(db, { gemKey: "@octocat/game", version: "1.0.0", publishedBy: "octocat", ownerAccountId: owner, createdAtMs: 1 });
    await upsertGemArchive(db, { gemKey: "@octocat/game", version: "1.0.0", bytes: new Uint8Array([1, 2, 3]), digest: "d", createdAtMs: 1 });
    expect(await deleteCatalogGem(db, "@octocat/game", "1.0.0", owner)).toBe("deleted");
    expect(await listCatalogGems(db)).toHaveLength(0);
    expect(await getGemArchive(db, "@octocat/game", "1.0.0")).toBeNull();
  });

  // Ownership is the accounts.id uuid, not the `publishedBy` display string — so a mismatched
  // publishedBy casing (or content at all) has no bearing on authorization.
  it("authorizes by owner_account_id regardless of publishedBy's casing", async () => {
    const db = await makeTestDb();
    const owner = await mkAccount(db, "OctoCat", "1");
    await upsertCatalogGem(db, { gemKey: "@o/g", version: "1.0.0", publishedBy: "OctoCat", ownerAccountId: owner, createdAtMs: 1 });
    expect(await deleteCatalogGem(db, "@o/g", "1.0.0", owner)).toBe("deleted");
  });

  it("refuses a non-owner (forbidden) and leaves the gem intact", async () => {
    const db = await makeTestDb();
    const owner = await mkAccount(db, "octocat", "1");
    await upsertCatalogGem(db, { gemKey: "@o/g", version: "1.0.0", publishedBy: "octocat", ownerAccountId: owner, createdAtMs: 1 });
    expect(await deleteCatalogGem(db, "@o/g", "1.0.0", crypto.randomUUID())).toBe("forbidden");
    expect(await listCatalogGems(db)).toHaveLength(1);
  });

  it("returns not-found for an unknown gem", async () => {
    const db = await makeTestDb();
    expect(await deleteCatalogGem(db, "@no/such", "9.9.9", crypto.randomUUID())).toBe("not-found");
  });
});

describe("clampGrade", () => {
  it("clamps to the 1..3 floor and passes through undefined", () => {
    expect(clampGrade(undefined)).toBeUndefined();
    expect(clampGrade(0)).toBe(1);
    expect(clampGrade(2)).toBe(2);
    expect(clampGrade(7)).toBe(3);
    expect(clampGrade(2.9)).toBe(2); // truncates
  });

  it("is NaN-safe (a non-numeric grade collapses to undefined, never NaN)", () => {
    expect(clampGrade(NaN)).toBeUndefined();
  });
});
