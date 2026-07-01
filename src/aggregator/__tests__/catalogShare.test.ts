// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
import { describe, it, expect } from "vitest";
import { generateKeyPairSync, sign as edSign } from "node:crypto";
import { makeTestDb, producers, accountBindings, catalogSigningPayload, recordCatalogShare, listCatalogGems, type CatalogManifest } from "@agentgem/aggregator";

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
    await db.insert(producers).values({ pubkey: s.pubkey });
    await db.insert(accountBindings).values({ pubkey: s.pubkey, provider: "github", accountId: "42", accountLogin: "octocat" });
    const now = 1_000_000;
    const sig = s.sign(catalogSigningPayload(M, s.pubkey, now));
    const res = await recordCatalogShare(db, { manifest: M, pubkey: s.pubkey, signedAt: now, signature: sig }, now);
    expect(res).toEqual({ shared: true, publishedBy: "octocat", gemKey: "@octocat/kit", version: "1.0.0" });
    const rows = await listCatalogGems(db);
    expect(rows[0]).toMatchObject({ publishedBy: "octocat", grade: 3 }); // 5 clamped to 3
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
