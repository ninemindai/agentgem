// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
import { describe, it, expect } from "vitest";
import { generateKeyPairSync, sign as edSign } from "node:crypto";
import { makeTestDb, catalogGems, myGemsSigningPayload, producers, accountBindings, accounts } from "@agentgem/aggregator";
import { AggregatorController } from "../../aggregator.controller.js";

function signer() {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const pubkey = "ed25519:" + publicKey.export({ format: "der", type: "spki" }).toString("base64");
  return { pubkey, sign: (d: string) => edSign(null, Buffer.from(d, "utf8"), privateKey).toString("base64") };
}

describe("AggregatorController.myGems", () => {
  it("my-gems returns the signed-in producer's owned gems", async () => {
    const db = await makeTestDb();
    const s = signer();
    const accountId = crypto.randomUUID();
    await db.insert(producers).values({ pubkey: s.pubkey });
    await db.insert(accounts).values({ id: accountId, provider: "github", providerAccountId: "42", login: "octocat" });
    await db.insert(accountBindings).values({ pubkey: s.pubkey, provider: "github", accountId: "42", accountLogin: "octocat" });
    await db.insert(catalogGems).values({ gemKey: "@octocat/demo", version: "0.1.0", publishedBy: "octocat", createdAtMs: 1000, ownerAccountId: accountId });
    const now = Date.now(); // must be within the 5-min freshness window (controller uses Date.now())
    const payload = myGemsSigningPayload(s.pubkey, now);
    const ctrl = new AggregatorController(db);
    const r = await ctrl.myGems({ body: { pubkey: s.pubkey, signedAt: now, signature: s.sign(payload) } });
    expect(r.gems.map((g) => g.name)).toContain("demo");
  });

  it("my-gems returns [] for an unbound / bad-signature key", async () => {
    const db = await makeTestDb();
    const s = signer();
    const ctrl = new AggregatorController(db);
    const r = await ctrl.myGems({ body: { pubkey: s.pubkey, signedAt: Date.now(), signature: "bogus" } });
    expect(r.gems).toEqual([]);
  });
});
