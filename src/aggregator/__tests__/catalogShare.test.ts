// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
import { describe, it, expect } from "vitest";
import { generateKeyPairSync, sign as edSign } from "node:crypto";
import { makeTestDb, producers, accountBindings, accounts, catalogSigningPayload, recordCatalogShare, listCatalogGems, backfillBindingAnchors, type CatalogManifest } from "@agentgem/aggregator";

function signer() {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const pubkey = "ed25519:" + publicKey.export({ format: "der", type: "spki" }).toString("base64");
  return { pubkey, sign: (d: string) => edSign(null, Buffer.from(d, "utf8"), privateKey).toString("base64") };
}
const M: CatalogManifest = { gemKey: "@octocat/kit", version: "1.0.0", description: "d", grade: 5 };

describe("recordCatalogShare", () => {
  it("rejects not-connected when no binding exists", async () => {
    const db = await makeTestDb();
    const s = signer();
    const now = 1_000_000;
    const sig = s.sign(catalogSigningPayload(M, s.pubkey, now));
    const res = await recordCatalogShare(db, { manifest: M, pubkey: s.pubkey, signedAt: now, signature: sig }, now);
    expect(res).toEqual({ shared: false, rejected: "not-connected" });
  });

  it("shares with server-derived publishedBy + clamped grade when bound", async () => {
    const db = await makeTestDb();
    const s = signer();
    const accountId = crypto.randomUUID();
    await db.insert(producers).values({ pubkey: s.pubkey });
    // account_bindings.account_id is the PROVIDER's id (text); recordCatalogShare pairs it with
    // `provider` against the accounts anchor row to resolve the uuid that owns the gem.
    await db.insert(accounts).values({ id: accountId, provider: "github", providerAccountId: "42", login: "octocat" });
    await db.insert(accountBindings).values({ pubkey: s.pubkey, provider: "github", accountId: "42", accountLogin: "octocat" });
    const now = 1_000_000;
    const sig = s.sign(catalogSigningPayload(M, s.pubkey, now));
    const res = await recordCatalogShare(db, { manifest: M, pubkey: s.pubkey, signedAt: now, signature: sig }, now);
    expect(res).toEqual({ shared: true, publishedBy: "octocat", gemKey: "@octocat/kit", version: "1.0.0" });
    const rows = await listCatalogGems(db);
    expect(rows[0]).toMatchObject({ publishedBy: "octocat", grade: 3 }); // 5 clamped to 3
  });

  it("overwrite preserves created_at and bumps updated_at", async () => {
    const db = await makeTestDb();
    const s = signer();
    const accountId = crypto.randomUUID();
    await db.insert(producers).values({ pubkey: s.pubkey });
    await db.insert(accounts).values({ id: accountId, provider: "github", providerAccountId: "42", login: "octocat" });
    await db.insert(accountBindings).values({ pubkey: s.pubkey, provider: "github", accountId: "42", accountLogin: "octocat" });
    const t1 = 1_000_000;
    await recordCatalogShare(db, { manifest: M, pubkey: s.pubkey, signedAt: t1, signature: s.sign(catalogSigningPayload(M, s.pubkey, t1)) }, t1);
    // Re-publish the SAME (key, version) later — the overwrite path.
    const M2 = { ...M, description: "updated" };
    const t2 = 2_000_000;
    await recordCatalogShare(db, { manifest: M2, pubkey: s.pubkey, signedAt: t2, signature: s.sign(catalogSigningPayload(M2, s.pubkey, t2)) }, t2);
    const rows = await listCatalogGems(db);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ createdAtMs: t1, updatedAtMs: t2, description: "updated" });
  });

  it("rejects not-connected when bound but no accounts anchor row resolves (recordBinding's best-effort write can fail)", async () => {
    const db = await makeTestDb();
    const s = signer();
    await db.insert(producers).values({ pubkey: s.pubkey });
    await db.insert(accountBindings).values({ pubkey: s.pubkey, provider: "github", accountId: "42", accountLogin: "octocat" });
    const now = 1_000_000;
    const sig = s.sign(catalogSigningPayload(M, s.pubkey, now));
    const res = await recordCatalogShare(db, { manifest: M, pubkey: s.pubkey, signedAt: now, signature: sig }, now);
    expect(res).toEqual({ shared: false, rejected: "not-connected" });
  });

  it("a previously-stranded binding (no accounts anchor) succeeds once backfillBindingAnchors has run", async () => {
    const db = await makeTestDb();
    const s = signer();
    await db.insert(producers).values({ pubkey: s.pubkey });
    await db.insert(accountBindings).values({ pubkey: s.pubkey, provider: "github", accountId: "42", accountLogin: "octocat" });
    expect(await backfillBindingAnchors(db)).toEqual({ created: 1 });
    const now = 1_000_000;
    const sig = s.sign(catalogSigningPayload(M, s.pubkey, now));
    const res = await recordCatalogShare(db, { manifest: M, pubkey: s.pubkey, signedAt: now, signature: sig }, now);
    expect(res).toEqual({ shared: true, publishedBy: "octocat", gemKey: "@octocat/kit", version: "1.0.0" });
  });

  it("rejects a cross-account overwrite of an existing gem (supply-chain takeover)", async () => {
    const db = await makeTestDb();
    const alice = signer(), bob = signer();
    await db.insert(producers).values({ pubkey: alice.pubkey });
    await db.insert(accounts).values({ id: crypto.randomUUID(), provider: "github", providerAccountId: "1", login: "alice" });
    await db.insert(accountBindings).values({ pubkey: alice.pubkey, provider: "github", accountId: "1", accountLogin: "alice" });
    await db.insert(producers).values({ pubkey: bob.pubkey });
    await db.insert(accounts).values({ id: crypto.randomUUID(), provider: "github", providerAccountId: "2", login: "bob" });
    await db.insert(accountBindings).values({ pubkey: bob.pubkey, provider: "github", accountId: "2", accountLogin: "bob" });
    const now = 1_000_000;
    const aliceRes = await recordCatalogShare(db, { manifest: M, pubkey: alice.pubkey, signedAt: now, signature: alice.sign(catalogSigningPayload(M, alice.pubkey, now)) }, now);
    expect(aliceRes).toMatchObject({ shared: true, publishedBy: "alice" });
    // Bob signs the SAME gemKey/version with his own key and tries to overwrite it.
    const bobRes = await recordCatalogShare(db, { manifest: M, pubkey: bob.pubkey, signedAt: now, signature: bob.sign(catalogSigningPayload(M, bob.pubkey, now)) }, now);
    expect(bobRes).toEqual({ shared: false, rejected: "conflict" });
    // Alice still owns the row — no takeover.
    expect((await listCatalogGems(db))[0]).toMatchObject({ publishedBy: "alice" });
  });

  it("allows the same owner to re-publish their own gem version", async () => {
    const db = await makeTestDb();
    const alice = signer();
    await db.insert(producers).values({ pubkey: alice.pubkey });
    await db.insert(accounts).values({ id: crypto.randomUUID(), provider: "github", providerAccountId: "1", login: "alice" });
    await db.insert(accountBindings).values({ pubkey: alice.pubkey, provider: "github", accountId: "1", accountLogin: "alice" });
    const now = 1_000_000;
    expect(await recordCatalogShare(db, { manifest: M, pubkey: alice.pubkey, signedAt: now, signature: alice.sign(catalogSigningPayload(M, alice.pubkey, now)) }, now)).toMatchObject({ shared: true });
    const m2 = { ...M, description: "updated" };
    expect(await recordCatalogShare(db, { manifest: m2, pubkey: alice.pubkey, signedAt: now, signature: alice.sign(catalogSigningPayload(m2, alice.pubkey, now)) }, now)).toMatchObject({ shared: true });
  });

  it("rejects a bad signature", async () => {
    const db = await makeTestDb();
    const s = signer();
    const now = 1_000_000;
    const res = await recordCatalogShare(db, { manifest: M, pubkey: s.pubkey, signedAt: now, signature: "AA==" }, now);
    expect(res).toEqual({ shared: false, rejected: "bad-signature" });
  });

  it("rejects a stale signedAt", async () => {
    const db = await makeTestDb();
    const s = signer();
    const signedAt = 1_000_000;
    const sig = s.sign(catalogSigningPayload(M, s.pubkey, signedAt));
    const res = await recordCatalogShare(db, { manifest: M, pubkey: s.pubkey, signedAt, signature: sig }, signedAt + 400_000);
    expect(res).toEqual({ shared: false, rejected: "stale" });
  });
});
