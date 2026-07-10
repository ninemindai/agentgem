// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
import { describe, it, expect } from "vitest";
import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { makeTestDb, ensureSchema, buildProfile, upsertReview, accounts, accountBindings, catalogGems, curatedSkills, producers, gemAdoptions, stars } from "@agentgem/aggregator";

// Creates BOTH a GitHub `accounts` row and a `"user"` row with the SAME id and a claimed handle —
// account_scopes/ownership FK to accounts.id, while the handle lives on "user", and the two are
// the same row by construction (Task 5b's auto-claim). `handle` defaults to `login` but can diverge
// to prove the profile's canonical name now comes from the handle, not accounts.login.
async function ghUser(db: never, login: string, opts: { handle?: string; avatarUrl?: string | null; providerAccountId?: string } = {}) {
  const id = randomUUID();
  await (db as any).insert(accounts).values({ id, provider: "github", providerAccountId: opts.providerAccountId ?? id, login, avatarUrl: opts.avatarUrl ?? null });
  await (db as any).execute(sql`insert into "user" (id, email, email_verified, handle) values (${id}, ${id + "@e.com"}, false, ${opts.handle ?? login})`);
  return id as string;
}
async function star(db: never, gemKey: string, n: number) {
  for (let i = 0; i < n; i++) {
    const accountId = randomUUID();
    await (db as any).insert(accounts).values({ id: accountId, provider: "github", providerAccountId: "s" + randomUUID(), login: "starrer" });
    await (db as any).insert(stars).values({ id: randomUUID(), accountId, targetKind: "gem", targetId: gemKey });
  }
}
async function install(db: never, gemKey: string, n: number) {
  for (let i = 0; i < n; i++) {
    const pubkey = "ed25519:" + randomUUID();
    await (db as any).insert(producers).values({ pubkey });
    await (db as any).insert(gemAdoptions).values({ gemKey, gemDigest: "d", producerPubkey: pubkey, event: "install" });
  }
}

describe("buildProfile", () => {
  it("assembles account + gems + stars, sorted by stars desc, totalStars summed", async () => {
    const db = await makeTestDb();
    const id = await ghUser(db as never, "octocat", { avatarUrl: "https://avatars/octocat" });
    await db.insert(catalogGems).values({ gemKey: "@octocat/a", version: "1.0.0", publishedBy: "octocat", description: "aa", grade: 2, createdAtMs: 10, ownerAccountId: id });
    await db.insert(catalogGems).values({ gemKey: "@octocat/b", version: "1.0.0", publishedBy: "octocat", description: "bb", grade: 3, createdAtMs: 20, ownerAccountId: id });
    await star(db as never, "@octocat/a", 2);
    await star(db as never, "@octocat/b", 5);

    const p = await buildProfile(db, "octocat");
    expect(p).not.toBeNull();
    expect(p!.login).toBe("octocat");
    expect(p!.avatarUrl).toBe("https://avatars/octocat");
    expect(p!.githubUrl).toBe("https://github.com/octocat");
    expect(p!.totalStars).toBe(7);
    expect(p!.gems.map((g) => g.key)).toEqual(["@octocat/b", "@octocat/a"]); // stars desc
    expect(p!.gems[0]).toMatchObject({ key: "@octocat/b", stars: 5, grade: 3, description: "bb" });
  });

  it("lists gems by owner_account_id, not by the published_by string", async () => {
    const db = await makeTestDb();
    const id = await ghUser(db as never, "raymond");
    // owned: resolves to the account
    await db.insert(catalogGems).values({ gemKey: "@r/owned", version: "1.0.0", publishedBy: "raymond", createdAtMs: 1, ownerAccountId: id });
    // an impostor row: the STRING matches, the owner does not. It must not appear.
    await db.insert(catalogGems).values({ gemKey: "@r/impostor", version: "1.0.0", publishedBy: "raymond", createdAtMs: 1, ownerAccountId: null });

    const p = await buildProfile(db, "raymond");
    expect(p!.gems.map((g) => g.key)).toEqual(["@r/owned"]);
  });

  it("reports k-anonymized install counts (DEFAULT_K = 5)", async () => {
    const db = await makeTestDb();
    const id = await ghUser(db as never, "octocat");
    await db.insert(catalogGems).values({ gemKey: "@o/low", version: "1.0.0", publishedBy: "octocat", createdAtMs: 1, ownerAccountId: id });
    await db.insert(catalogGems).values({ gemKey: "@o/hi", version: "1.0.0", publishedBy: "octocat", createdAtMs: 2, ownerAccountId: id });
    await install(db as never, "@o/low", 4);  // below k → 0
    await install(db as never, "@o/hi", 5);   // at k → 5
    const p = await buildProfile(db, "octocat");
    const byKey = Object.fromEntries(p!.gems.map((g) => [g.key, g.installs]));
    expect(byKey["@o/low"]).toBe(0);
    expect(byKey["@o/hi"]).toBe(5);
  });

  // Replaces the old "renders a bind-only user with no accounts row" case: that behavior is the
  // deleted one. A device-flow-only binding never gets a "user" row or a claimed handle, so there
  // is no handle to resolve and no profile — not even a partial one.
  it("returns null for a bind-only login that never claimed a handle (no user row)", async () => {
    const db = await makeTestDb();
    const pubkey = "ed25519:" + randomUUID();
    await db.insert(producers).values({ pubkey });
    await db.insert(accountBindings).values({ pubkey, provider: "github", accountId: "9", accountLogin: "binder" });
    await db.insert(catalogGems).values({ gemKey: "@binder/g", version: "1.0.0", publishedBy: "binder", createdAtMs: 1, ownerAccountId: null });
    expect(await buildProfile(db, "binder")).toBeNull();
  });

  // Corrects the brief's original bind lookup (a string compare of account_bindings.account_login
  // against the handle, which would silently un-verify anyone who renamed). `verified` instead
  // follows the ACCOUNT: join account_bindings to accounts on (provider, provider_account_id), and
  // test the resolved accountId — proven here by giving the binding a DIFFERENT account_login than
  // the handle, so a login-string match would (wrongly) report unverified.
  it("verified follows the account via the (provider, provider_account_id) anchor, not the account_login string", async () => {
    const db = await makeTestDb();
    const id = await ghUser(db as never, "binder", { providerAccountId: "42" });
    const pubkey = "ed25519:" + randomUUID();
    await db.insert(producers).values({ pubkey });
    await db.insert(accountBindings).values({ pubkey, provider: "github", accountId: "42", accountLogin: "old-name-before-rename" });
    await db.insert(catalogGems).values({ gemKey: "@binder/g", version: "1.0.0", publishedBy: "binder", createdAtMs: 1, ownerAccountId: id });

    const p = await buildProfile(db, "binder");
    expect(p).not.toBeNull();
    expect(p!.verified).toBe(true);
    expect(p!.gems).toHaveLength(1);
  });

  it("keeps only the latest version per gemKey", async () => {
    const db = await makeTestDb();
    const id = await ghUser(db as never, "octocat");
    await db.insert(catalogGems).values({ gemKey: "@o/g", version: "1.0.0", publishedBy: "octocat", description: "old", createdAtMs: 1, ownerAccountId: id });
    await db.insert(catalogGems).values({ gemKey: "@o/g", version: "2.0.0", publishedBy: "octocat", description: "new", createdAtMs: 2, ownerAccountId: id });
    const p = await buildProfile(db, "octocat");
    expect(p!.gems).toHaveLength(1);
    expect(p!.gems[0]).toMatchObject({ version: "2.0.0", description: "new" });
  });

  it("dedupes deterministically when two versions share createdAtMs (version tiebreak)", async () => {
    const db = await makeTestDb();
    const id = await ghUser(db as never, "octocat");
    await db.insert(catalogGems).values({ gemKey: "@o/g", version: "1.0.0", publishedBy: "octocat", description: "one", createdAtMs: 5, ownerAccountId: id });
    await db.insert(catalogGems).values({ gemKey: "@o/g", version: "2.0.0", publishedBy: "octocat", description: "two", createdAtMs: 5, ownerAccountId: id });
    const p = await buildProfile(db, "octocat");
    expect(p!.gems).toHaveLength(1);
    expect(p!.gems[0]).toMatchObject({ version: "2.0.0", description: "two" }); // higher version wins the tie, deterministically
  });

  // Fix pass (Task 7/8 review — case sensitivity), Finding 2: buildProfile used to echo the
  // caller's raw input casing (`login: handle`), so `/@RayMond` rendered a profile displayed as
  // "RayMond" even though the stored handle is "raymond". Profile.login now carries the CANONICAL
  // stored casing, re-read via handleForAccountId after the case-insensitive resolve. Proven by
  // giving the stored handle a DIFFERENT casing than what's passed to buildProfile.
  it("resolves the handle case-insensitively; Profile.login echoes the STORED handle's casing, not the caller's input", async () => {
    const db = await makeTestDb();
    const id = await ghUser(db as never, "somelogin", { handle: "OctoCat" });
    await db.insert(catalogGems).values({ gemKey: "@o/g", version: "1.0.0", publishedBy: "somelogin", createdAtMs: 1, ownerAccountId: id });
    const p = await buildProfile(db, "octocat"); // different case than the stored handle "OctoCat"
    expect(p).not.toBeNull();
    expect(p!.gems).toHaveLength(1);
    expect(p!.login).toBe("OctoCat");
  });

  it("buildProfile('RayMond') resolves and returns the stored casing 'raymond'", async () => {
    const db = await makeTestDb();
    const id = await ghUser(db as never, "raymond", { handle: "raymond" });
    await db.insert(catalogGems).values({ gemKey: "@r/g", version: "1.0.0", publishedBy: "raymond", createdAtMs: 1, ownerAccountId: id });
    const p = await buildProfile(db, "RayMond");
    expect(p).not.toBeNull();
    expect(p!.login).toBe("raymond");
  });

  it("verified is false with no binding", async () => {
    const db = await makeTestDb();
    await ghUser(db as never, "octocat");
    const p = await buildProfile(db, "octocat");
    expect(p!.verified).toBe(false);
  });

  it("includes the account's authored skill reviews, newest first, parsed into sourceId/path/name", async () => {
    const db = await makeTestDb();
    const id = await ghUser(db as never, "octocat");
    await upsertReview(db, id, "skill", "agency-agents/engineering/ai-engineer.md", 5, "top notch");
    await upsertReview(db, id, "skill", "matt-skills/productivity/brainstorming.md", 3, null);
    const p = await buildProfile(db, "octocat");
    expect(p!.reviews).toHaveLength(2);
    const byName = Object.fromEntries(p!.reviews.map((r) => [r.name, r]));
    expect(byName["brainstorming"]).toMatchObject({ sourceId: "matt-skills", path: "productivity/brainstorming.md", rating: 3, body: null });
    expect(byName["ai-engineer"]).toMatchObject({ sourceId: "agency-agents", path: "engineering/ai-engineer.md", rating: 5, body: "top notch" });
  });

  it("uses the curated skill name (not the file basename) for a SKILL.md-convention review", async () => {
    const db = await makeTestDb();
    const id = await ghUser(db as never, "octocat");
    await db.insert(curatedSkills).values({ sourceId: "matt-skills", path: "skills/engineering/ask-matt/SKILL.md", division: "engineering", name: "ask-matt", repo: "mattpocock/skills", sourceLabel: "mattpocock/skills" });
    await upsertReview(db, id, "skill", "matt-skills/skills/engineering/ask-matt/SKILL.md", 5, "great router");
    const p = await buildProfile(db, "octocat");
    expect(p!.reviews[0]).toMatchObject({ name: "ask-matt", sourceId: "matt-skills", rating: 5 }); // NOT "SKILL"
  });

  it("falls back to the parent dir name for an uncurated SKILL.md review", async () => {
    const db = await makeTestDb();
    const id = await ghUser(db as never, "octocat");
    await upsertReview(db, id, "skill", "some-src/foo/bar-skill/SKILL.md", 4, null); // not in curated_skills
    const p = await buildProfile(db, "octocat");
    expect(p!.reviews[0].name).toBe("bar-skill"); // parent dir, not "SKILL"
  });

  it("has an empty reviews array for a profile with no authored reviews", async () => {
    const db = await makeTestDb();
    await ghUser(db as never, "octocat");
    const p = await buildProfile(db, "octocat");
    expect(p!.reviews).toEqual([]);
  });

  it("survives a gem_adoptions table created before the quarantine columns existed (regression: profile 500)", async () => {
    const db = await makeTestDb();
    // Simulate a database provisioned before commit 52e3d3c: recreate gem_adoptions in its original
    // shape, without trust_score / quarantined. `create table if not exists` won't touch it, so only
    // the paired `alter table ... add column if not exists` in ensureSchema can back-fill the columns.
    await db.execute(sql`drop table if exists gem_adoptions`);
    await db.execute(sql`create table gem_adoptions (gem_key text not null, gem_digest text not null, producer_pubkey text not null references producers(pubkey), account_login text, event text not null default 'install', adopted_at timestamptz not null default now(), primary key (gem_key, producer_pubkey))`);
    await ensureSchema(db); // must forward-migrate the old table, not skip it

    // An author with a published gem exercises gemAdoption(), which reads `quarantined` — the query
    // that threw "column g.quarantined does not exist" on the live profile page before the fix.
    const id = await ghUser(db as never, "octocat");
    await db.insert(catalogGems).values({ gemKey: "@octocat/g", version: "1.0.0", publishedBy: "octocat", createdAtMs: 1, ownerAccountId: id });
    const p = await buildProfile(db, "octocat");
    expect(p).not.toBeNull();
    expect(p!.gems).toHaveLength(1);
  });

  it("returns null for a handle nobody holds", async () => {
    const db = await makeTestDb();
    expect(await buildProfile(db, "nobody")).toBeNull();
  });

  it("returns null (no query) for a bad-charset handle", async () => {
    const db = await makeTestDb();
    expect(await buildProfile(db, "foo/bar")).toBeNull();
    expect(await buildProfile(db, "a b")).toBeNull();
    expect(await buildProfile(db, "")).toBeNull();
  });
});
