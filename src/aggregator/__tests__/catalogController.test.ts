// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
import { describe, it, expect } from "vitest";
import { generateKeyPairSync, sign as edSign } from "node:crypto";
import { makeTestDb, producers, accountBindings, catalogSigningPayload } from "@agentgem/aggregator";
import { AggregatorController } from "../../aggregator.controller.js";

function signer() {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const pubkey = "ed25519:" + publicKey.export({ format: "der", type: "spki" }).toString("base64");
  return { pubkey, sign: (d: string) => edSign(null, Buffer.from(d, "utf8"), privateKey).toString("base64") };
}

describe("AggregatorController.catalog", () => {
  it("shares a bound producer's manifest", async () => {
    const db = await makeTestDb();
    const s = signer();
    await db.insert(producers).values({ pubkey: s.pubkey });
    await db.insert(accountBindings).values({ pubkey: s.pubkey, provider: "github", accountId: "1", accountLogin: "octocat" });
    const c = new AggregatorController(db);
    const manifest = { gemKey: "@octocat/kit", version: "1.0.0", description: "d" };
    const signedAt = Date.now();
    const signature = s.sign(catalogSigningPayload(manifest, s.pubkey, signedAt));
    const res = await c.catalog({ body: { manifest, pubkey: s.pubkey, signedAt, signature } });
    expect(res).toMatchObject({ shared: true, publishedBy: "octocat" });
  });

  it("returns not-connected for an unbound producer", async () => {
    const db = await makeTestDb();
    const s = signer();
    const c = new AggregatorController(db);
    const manifest = { gemKey: "@x/y", version: "1.0.0" };
    const signedAt = Date.now();
    const signature = s.sign(catalogSigningPayload(manifest, s.pubkey, signedAt));
    const res = await c.catalog({ body: { manifest, pubkey: s.pubkey, signedAt, signature } });
    expect(res).toMatchObject({ shared: false, rejected: "not-connected" });
  });
});
