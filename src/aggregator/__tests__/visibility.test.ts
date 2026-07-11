// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
import { describe, it, expect } from "vitest";
import { generateKeyPairSync, sign as edSign } from "node:crypto";
import { makeTestDb, upsertCatalogGem, listCatalogGems, catalogSigningPayload, recordCatalogShare, producers, accountBindings, accounts, catalogGems, type CatalogManifest } from "@agentgem/aggregator";
import { sql } from "drizzle-orm";

function signer() {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const pubkey = "ed25519:" + publicKey.export({ format: "der", type: "spki" }).toString("base64");
  return { pubkey, sign: (d: string) => edSign(null, Buffer.from(d, "utf8"), privateKey).toString("base64") };
}
async function bind(db: Awaited<ReturnType<typeof makeTestDb>>, pubkey: string) {
  const accountId = crypto.randomUUID();
  await db.insert(producers).values({ pubkey });
  await db.insert(accounts).values({ id: accountId, provider: "github", providerAccountId: "42", login: "octocat" });
  await db.insert(accountBindings).values({ pubkey, provider: "github", accountId: "42", accountLogin: "octocat" });
  return accountId;
}

describe("visibility threading + Explore filter", () => {
  it("upsertCatalogGem defaults visibility to public and round-trips a value", async () => {
    const db = await makeTestDb();
    await upsertCatalogGem(db, { gemKey: "@me/a", version: "0.1.0", publishedBy: "me", createdAtMs: 1 });
    await upsertCatalogGem(db, { gemKey: "@me/b", version: "0.1.0", publishedBy: "me", createdAtMs: 2, visibility: "unlisted" });
    const rows = (await db.execute(sql`select gem_key, visibility from catalog_gems order by gem_key`)) as unknown as { rows: { gem_key: string; visibility: string }[] };
    expect(rows.rows).toEqual([{ gem_key: "@me/a", visibility: "public" }, { gem_key: "@me/b", visibility: "unlisted" }]);
  });

  it("listCatalogGems returns only public rows", async () => {
    const db = await makeTestDb();
    await upsertCatalogGem(db, { gemKey: "@me/pub", version: "0.1.0", publishedBy: "me", createdAtMs: 1, visibility: "public" });
    await upsertCatalogGem(db, { gemKey: "@me/unl", version: "0.1.0", publishedBy: "me", createdAtMs: 2, visibility: "unlisted" });
    await upsertCatalogGem(db, { gemKey: "@me/prv", version: "0.1.0", publishedBy: "me", createdAtMs: 3, visibility: "private" });
    const listed = (await listCatalogGems(db)).map((g) => g.gemKey);
    expect(listed).toEqual(["@me/pub"]);
  });

  it("recordCatalogShare stores the manifest visibility", async () => {
    const db = await makeTestDb();
    const s = signer();
    await bind(db, s.pubkey);
    const m: CatalogManifest = { gemKey: "@octocat/g", version: "1.0.0", visibility: "unlisted" };
    const now = 1_000_000;
    const sig = s.sign(catalogSigningPayload(m, s.pubkey, now));
    const res = await recordCatalogShare(db, { manifest: m, pubkey: s.pubkey, signedAt: now, signature: sig }, now);
    expect(res).toMatchObject({ shared: true });
    const row = (await db.select({ v: catalogGems.visibility }).from(catalogGems))[0];
    expect(row.v).toBe("unlisted");
    // unlisted is excluded from Explore
    expect(await listCatalogGems(db)).toEqual([]);
  });

  it("recordCatalogShare defaults missing visibility to public (listed)", async () => {
    const db = await makeTestDb();
    const s = signer();
    await bind(db, s.pubkey);
    const m: CatalogManifest = { gemKey: "@octocat/g", version: "1.0.0" };
    const now = 1_000_000;
    const sig = s.sign(catalogSigningPayload(m, s.pubkey, now));
    await recordCatalogShare(db, { manifest: m, pubkey: s.pubkey, signedAt: now, signature: sig }, now);
    expect((await listCatalogGems(db)).map((g) => g.gemKey)).toEqual(["@octocat/g"]);
  });
});
