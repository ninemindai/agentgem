// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
import { describe, it, expect } from "vitest";
import { randomUUID } from "node:crypto";
import { makeTestDb, buildOrgCatalog, catalogGems, accounts, stars } from "@agentgem/aggregator";

async function star(db: never, gemKey: string, n: number) {
  for (let i = 0; i < n; i++) {
    const accountId = randomUUID();
    await (db as any).insert(accounts).values({ id: accountId, provider: "github", providerAccountId: "s" + randomUUID(), login: "starrer" });
    await (db as any).insert(stars).values({ id: randomUUID(), accountId, targetKind: "gem", targetId: gemKey });
  }
}

describe("buildOrgCatalog", () => {
  it("lists only @scope/* gems, with owner/counts, sorted by grade desc then stars desc", async () => {
    const db = await makeTestDb();
    await db.insert(catalogGems).values({ gemKey: "@acme/a", version: "1.0.0", publishedBy: "dev1", description: "aa", tags: ["x"], artifactKinds: ["skill"], type: "skill", grade: 2, createdAtMs: 10 });
    await db.insert(catalogGems).values({ gemKey: "@acme/b", version: "1.0.0", publishedBy: "dev2", description: "bb", tags: ["y"], artifactKinds: ["skill"], type: "kit", grade: 3, createdAtMs: 20 });
    await db.insert(catalogGems).values({ gemKey: "@other/c", version: "1.0.0", publishedBy: "dev3", description: "cc", tags: ["z"], artifactKinds: ["skill"], type: "skill", grade: 3, createdAtMs: 30 });

    const c = await buildOrgCatalog(db, "acme");
    expect(c).not.toBeNull();
    expect(c!.scope).toBe("acme");
    expect(c!.gemCount).toBe(2);
    expect(c!.ownerCount).toBe(2);
    expect(c!.gems.map((g) => g.key)).toEqual(["@acme/b", "@acme/a"]); // grade desc
    expect(c!.gems[0]).toMatchObject({ key: "@acme/b", cut: "kit", grade: 3, owner: "dev2" });
    expect(c!.gems[0].rubric.checks).toHaveLength(5);
  });

  it("attaches a rubric that reflects the row (fully-formed + starred → all pass)", async () => {
    const db = await makeTestDb();
    await db.insert(catalogGems).values({ gemKey: "@acme/g", version: "1.0.0", publishedBy: "dev", description: "d", tags: ["x"], artifactKinds: ["skill"], type: "skill", grade: 2, createdAtMs: 1 });
    await star(db as never, "@acme/g", 1);
    const c = await buildOrgCatalog(db, "acme");
    expect(c!.gems[0].stars).toBe(1);
    expect(c!.gems[0].rubric.score).toBe(1);
  });

  it("keeps only the latest version per gemKey", async () => {
    const db = await makeTestDb();
    await db.insert(catalogGems).values({ gemKey: "@acme/g", version: "1.0.0", publishedBy: "dev", description: "old", createdAtMs: 1 });
    await db.insert(catalogGems).values({ gemKey: "@acme/g", version: "2.0.0", publishedBy: "dev", description: "new", createdAtMs: 2 });
    const c = await buildOrgCatalog(db, "acme");
    expect(c!.gems).toHaveLength(1);
    expect(c!.gems[0]).toMatchObject({ version: "2.0.0", description: "new" });
  });

  it("is case-insensitive on scope and does not match a different scope prefix", async () => {
    const db = await makeTestDb();
    await db.insert(catalogGems).values({ gemKey: "@Acme/a", version: "1.0.0", publishedBy: "dev", createdAtMs: 1 });
    await db.insert(catalogGems).values({ gemKey: "@acme-corp/b", version: "1.0.0", publishedBy: "dev", createdAtMs: 2 });
    const c = await buildOrgCatalog(db, "acme");
    expect(c!.gems.map((g) => g.key)).toEqual(["@Acme/a"]); // not @acme-corp/b
  });

  it("returns an empty catalog (not null) for an unknown scope", async () => {
    const db = await makeTestDb();
    const c = await buildOrgCatalog(db, "nobody");
    expect(c).toEqual({ scope: "nobody", gemCount: 0, ownerCount: 0, gems: [] });
  });

  it("returns null for a malformed scope", async () => {
    const db = await makeTestDb();
    expect(await buildOrgCatalog(db, "bad/scope")).toBeNull();
    expect(await buildOrgCatalog(db, "a b")).toBeNull();
    expect(await buildOrgCatalog(db, "")).toBeNull();
  });
});
