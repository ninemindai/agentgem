// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
import { describe, it, expect } from "vitest";
import { randomUUID } from "node:crypto";
import { makeTestDb, buildOrgCatalog, catalogGems, accounts, accountScopes, stars, producers, gemAdoptions } from "@agentgem/aggregator";

async function star(db: never, gemKey: string, n: number) {
  for (let i = 0; i < n; i++) {
    const accountId = randomUUID();
    await (db as any).insert(accounts).values({ id: accountId, provider: "github", providerAccountId: "s" + randomUUID(), login: "starrer" });
    await (db as any).insert(stars).values({ id: randomUUID(), accountId, targetKind: "gem", targetId: gemKey });
  }
}
// Record that `login` owns `scope` (a captured GitHub org membership, the same signal the publish
// path checks). Self-scope (login === scope) needs no such row — buildOrgCatalog allows it directly.
async function own(db: never, login: string, scope: string) {
  const accountId = randomUUID();
  await (db as any).insert(accounts).values({ id: accountId, provider: "github", providerAccountId: "o" + randomUUID(), login });
  await (db as any).insert(accountScopes).values({ accountId, scope });
}
async function install(db: never, gemKey: string, n: number) {
  for (let i = 0; i < n; i++) {
    const pubkey = "ed25519:" + randomUUID();
    await (db as any).insert(producers).values({ pubkey });
    await (db as any).insert(gemAdoptions).values({ gemKey, gemDigest: "d", producerPubkey: pubkey, event: "install" });
  }
}

describe("buildOrgCatalog", () => {
  it("lists only @scope/* gems, with owner/counts, sorted by grade desc then stars desc", async () => {
    const db = await makeTestDb();
    await own(db as never, "dev1", "acme");
    await own(db as never, "dev2", "acme");
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

  it("only lists gems whose publisher owns the scope — self-scope and org-members in, impersonators out", async () => {
    const db = await makeTestDb();
    await own(db as never, "alice", "acme"); // alice's captured org membership includes acme
    await db.insert(catalogGems).values({ gemKey: "@acme/self", version: "1.0.0", publishedBy: "acme", createdAtMs: 3 });   // self-scope, no account_scopes row
    await db.insert(catalogGems).values({ gemKey: "@acme/member", version: "1.0.0", publishedBy: "alice", createdAtMs: 2 }); // owned via account_scopes
    await db.insert(catalogGems).values({ gemKey: "@acme/spoof", version: "1.0.0", publishedBy: "attacker", createdAtMs: 1 }); // impersonation

    const c = await buildOrgCatalog(db, "acme");
    expect(c!.gems.map((g) => g.key).sort()).toEqual(["@acme/member", "@acme/self"]);
    expect(c!.gems.some((g) => g.key === "@acme/spoof")).toBe(false); // impersonated gem is excluded
  });

  it("attaches a rubric that reflects the row (fully-formed + starred → all pass)", async () => {
    const db = await makeTestDb();
    await db.insert(catalogGems).values({ gemKey: "@acme/g", version: "1.0.0", publishedBy: "acme", description: "d", tags: ["x"], artifactKinds: ["skill"], type: "skill", grade: 2, createdAtMs: 1 });
    await star(db as never, "@acme/g", 1);
    const c = await buildOrgCatalog(db, "acme");
    expect(c!.gems[0].stars).toBe(1);
    expect(c!.gems[0].rubric.score).toBe(1);
  });

  it("reports k-anonymized install counts (DEFAULT_K = 5)", async () => {
    const db = await makeTestDb();
    await db.insert(catalogGems).values({ gemKey: "@acme/low", version: "1.0.0", publishedBy: "acme", createdAtMs: 1 });
    await db.insert(catalogGems).values({ gemKey: "@acme/hi", version: "1.0.0", publishedBy: "acme", createdAtMs: 2 });
    await install(db as never, "@acme/low", 4); // below k → 0
    await install(db as never, "@acme/hi", 5);  // at k → 5
    const c = await buildOrgCatalog(db, "acme");
    const byKey = Object.fromEntries(c!.gems.map((g) => [g.key, g.installs]));
    expect(byKey["@acme/low"]).toBe(0);
    expect(byKey["@acme/hi"]).toBe(5);
  });

  it("keeps only the latest version per gemKey", async () => {
    const db = await makeTestDb();
    await db.insert(catalogGems).values({ gemKey: "@acme/g", version: "1.0.0", publishedBy: "acme", description: "old", createdAtMs: 1 });
    await db.insert(catalogGems).values({ gemKey: "@acme/g", version: "2.0.0", publishedBy: "acme", description: "new", createdAtMs: 2 });
    const c = await buildOrgCatalog(db, "acme");
    expect(c!.gems).toHaveLength(1);
    expect(c!.gems[0]).toMatchObject({ version: "2.0.0", description: "new" });
  });

  it("is case-insensitive on scope and does not match a different scope prefix", async () => {
    const db = await makeTestDb();
    await db.insert(catalogGems).values({ gemKey: "@Acme/a", version: "1.0.0", publishedBy: "acme", createdAtMs: 1 });
    await db.insert(catalogGems).values({ gemKey: "@acme-corp/b", version: "1.0.0", publishedBy: "acme", createdAtMs: 2 });
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
