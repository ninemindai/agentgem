// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
import { describe, it, expect } from "vitest";
import { generateKeyPairSync, sign as edSign } from "node:crypto";
import { makeTestDb, catalogGems, gemStatusSigningPayload, producers, accountBindings, accounts } from "@agentgem/aggregator";
import { AggregatorController } from "../../aggregator.controller.js";

function signer() {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const pubkey = "ed25519:" + publicKey.export({ format: "der", type: "spki" }).toString("base64");
  return { pubkey, sign: (d: string) => edSign(null, Buffer.from(d, "utf8"), privateKey).toString("base64") };
}

describe("AggregatorController.gemStatus", () => {
  it("returns ownedByMe:true for the signing owner", async () => {
    const db = await makeTestDb();
    const s = signer();
    const accountId = crypto.randomUUID();
    await db.insert(producers).values({ pubkey: s.pubkey });
    await db.insert(accounts).values({ id: accountId, provider: "github", providerAccountId: "42", login: "octocat" });
    await db.insert(accountBindings).values({ pubkey: s.pubkey, provider: "github", accountId: "42", accountLogin: "octocat" });
    await db.insert(catalogGems).values({ gemKey: "@octocat/game", version: "0.1.0", publishedBy: "octocat", createdAtMs: 1000, ownerAccountId: accountId });
    const now = Date.now(); // must be within the 5-min freshness window (controller uses Date.now())
    const payload = gemStatusSigningPayload("@octocat/game", s.pubkey, now);
    const ctrl = new AggregatorController(db);
    const res = await ctrl.gemStatus({ body: { key: "@octocat/game", pubkey: s.pubkey, signedAt: now, signature: s.sign(payload) } });
    expect(res).toEqual({ exists: true, ownedByMe: true, latestVersion: "0.1.0" });
  });

  it("returns ownedByMe:false on a bad signature but still reports existence", async () => {
    const db = await makeTestDb();
    // owner_account_id has a real FK to accounts(id) at the DB level (see ensureSchema migration),
    // so the "someone else owns this" row needs a matching accounts row, not a bare random uuid.
    const otherOwnerId = crypto.randomUUID();
    await db.insert(accounts).values({ id: otherOwnerId, provider: "github", providerAccountId: "99", login: "someoneelse" });
    await db.insert(catalogGems).values({ gemKey: "@octocat/game", version: "0.1.0", publishedBy: "octocat", createdAtMs: 1000, ownerAccountId: otherOwnerId });
    const s = signer();
    const ctrl = new AggregatorController(db);
    const res = await ctrl.gemStatus({ body: { key: "@octocat/game", pubkey: s.pubkey, signedAt: Date.now(), signature: "bogus" } });
    expect(res).toEqual({ exists: true, ownedByMe: false, latestVersion: "0.1.0" });
  });
});
