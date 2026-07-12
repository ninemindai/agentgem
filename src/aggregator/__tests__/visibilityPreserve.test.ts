// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
import { describe, it, expect } from "vitest";
import { generateKeyPairSync, sign as edSign } from "node:crypto";
import { makeTestDb, catalogSigningPayload, recordCatalogShare, gemAccessInfo, producers, accountBindings, accounts, type CatalogManifest } from "@agentgem/aggregator";

function signer() {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const pubkey = "ed25519:" + publicKey.export({ format: "der", type: "spki" }).toString("base64");
  return { pubkey, sign: (d: string) => edSign(null, Buffer.from(d, "utf8"), privateKey).toString("base64") };
}
async function share(db: Awaited<ReturnType<typeof makeTestDb>>, s: ReturnType<typeof signer>, m: CatalogManifest, now: number) {
  return recordCatalogShare(db, { manifest: m, pubkey: s.pubkey, signedAt: now, signature: s.sign(catalogSigningPayload(m, s.pubkey, now)) }, now);
}

describe("recordCatalogShare preserves visibility on republish-without-visibility", () => {
  it("a republish that omits visibility keeps the prior private scope", async () => {
    const db = await makeTestDb();
    const s = signer();
    const accountId = crypto.randomUUID();
    await db.insert(producers).values({ pubkey: s.pubkey });
    await db.insert(accounts).values({ id: accountId, provider: "github", providerAccountId: "42", login: "octocat" });
    await db.insert(accountBindings).values({ pubkey: s.pubkey, provider: "github", accountId: "42", accountLogin: "octocat" });
    await share(db, s, { gemKey: "@octocat/g", version: "1.0.0", visibility: "private" }, 1_000_000);
    // republish same key/version, no visibility field
    await share(db, s, { gemKey: "@octocat/g", version: "1.0.0" }, 1_000_100);
    expect((await gemAccessInfo(db, "@octocat/g", "1.0.0"))?.visibility).toBe("private");
  });
  it("a brand-new gem with no visibility still defaults to public", async () => {
    const db = await makeTestDb();
    const s = signer();
    const accountId = crypto.randomUUID();
    await db.insert(producers).values({ pubkey: s.pubkey });
    await db.insert(accounts).values({ id: accountId, provider: "github", providerAccountId: "42", login: "octocat" });
    await db.insert(accountBindings).values({ pubkey: s.pubkey, provider: "github", accountId: "42", accountLogin: "octocat" });
    await share(db, s, { gemKey: "@octocat/new", version: "1.0.0" }, 1_000_000);
    expect((await gemAccessInfo(db, "@octocat/new", "1.0.0"))?.visibility).toBe("public");
  });
});
