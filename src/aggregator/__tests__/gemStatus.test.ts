// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
import { describe, it, expect } from "vitest";
import { generateKeyPairSync, sign as edSign } from "node:crypto";
import { makeTestDb, catalogGems, gemStatusFor, gemStatusSigningPayload, resolveSignedAccount, producers, accountBindings, accounts } from "@agentgem/aggregator";

function signer() {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const pubkey = "ed25519:" + publicKey.export({ format: "der", type: "spki" }).toString("base64");
  return { pubkey, sign: (d: string) => edSign(null, Buffer.from(d, "utf8"), privateKey).toString("base64") };
}

describe("gemStatusFor", () => {
  it("reports not-exists for an unknown key", async () => {
    const db = await makeTestDb();
    const acct1 = crypto.randomUUID();
    await db.insert(accounts).values({ id: acct1, provider: "github", providerAccountId: "1", login: "user1" });
    expect(await gemStatusFor(db, "@me/none", acct1)).toEqual({ exists: false, ownedByMe: false, latestVersion: null });
  });

  it("reports the latest-published version and ownership for the owner", async () => {
    const db = await makeTestDb();
    const acct1 = crypto.randomUUID();
    await db.insert(accounts).values({ id: acct1, provider: "github", providerAccountId: "1", login: "user1" });
    await db.insert(catalogGems).values({ gemKey: "@me/game", version: "0.1.0", publishedBy: "me", createdAtMs: 1000, ownerAccountId: acct1 });
    await db.insert(catalogGems).values({ gemKey: "@me/game", version: "0.1.1", publishedBy: "me", createdAtMs: 2000, ownerAccountId: acct1 });
    expect(await gemStatusFor(db, "@me/game", acct1)).toEqual({ exists: true, ownedByMe: true, latestVersion: "0.1.1" });
  });

  it("latest is by publish time; a different account does not own it", async () => {
    const db = await makeTestDb();
    const acct1 = crypto.randomUUID();
    const acct2 = crypto.randomUUID();
    await db.insert(accounts).values({ id: acct1, provider: "github", providerAccountId: "1", login: "user1" });
    await db.insert(accounts).values({ id: acct2, provider: "github", providerAccountId: "2", login: "user2" });
    await db.insert(catalogGems).values({ gemKey: "@me/game", version: "9.9.9", publishedBy: "me", createdAtMs: 1000, ownerAccountId: acct1 });
    await db.insert(catalogGems).values({ gemKey: "@me/game", version: "0.1.0", publishedBy: "me", createdAtMs: 2000, ownerAccountId: acct1 });
    expect(await gemStatusFor(db, "@me/game", acct2)).toEqual({ exists: true, ownedByMe: false, latestVersion: "0.1.0" });
  });

  it("null accountId is never the owner", async () => {
    const db = await makeTestDb();
    const acct1 = crypto.randomUUID();
    await db.insert(accounts).values({ id: acct1, provider: "github", providerAccountId: "1", login: "user1" });
    await db.insert(catalogGems).values({ gemKey: "@me/game", version: "0.1.0", publishedBy: "me", createdAtMs: 1000, ownerAccountId: acct1 });
    expect(await gemStatusFor(db, "@me/game", null)).toEqual({ exists: true, ownedByMe: false, latestVersion: "0.1.0" });
  });

  it("gemStatusSigningPayload verifies through resolveSignedAccount", async () => {
    const db = await makeTestDb();
    const s = signer();
    const accountId = crypto.randomUUID();
    await db.insert(producers).values({ pubkey: s.pubkey });
    await db.insert(accounts).values({ id: accountId, provider: "github", providerAccountId: "42", login: "octocat" });
    await db.insert(accountBindings).values({ pubkey: s.pubkey, provider: "github", accountId: "42", accountLogin: "octocat" });
    const now = 1_000_000;
    const payload = gemStatusSigningPayload("@octocat/game", s.pubkey, now);
    const who = await resolveSignedAccount(db, { pubkey: s.pubkey, payload, signedAt: now, signature: s.sign(payload) }, now);
    expect(who).toEqual({ ok: true, accountId, login: "octocat" });
  });
});
