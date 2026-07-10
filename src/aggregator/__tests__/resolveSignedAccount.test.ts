// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
import { describe, it, expect } from "vitest";
import { generateKeyPairSync, sign as edSign, randomUUID } from "node:crypto";
import { makeTestDb, producers, accountBindings, accounts, resolveSignedAccount } from "@agentgem/aggregator";

function signer() {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const pubkey = "ed25519:" + publicKey.export({ format: "der", type: "spki" }).toString("base64");
  return { pubkey, sign: (d: string) => edSign(null, Buffer.from(d, "utf8"), privateKey).toString("base64") };
}

async function boundDb() {
  const db = await makeTestDb();
  const s = signer();
  await db.insert(producers).values({ pubkey: s.pubkey });
  await db.insert(accounts).values({ id: randomUUID(), provider: "github", providerAccountId: "1", login: "octocat" });
  await db.insert(accountBindings).values({ pubkey: s.pubkey, provider: "github", accountId: "1", accountLogin: "octocat" });
  return { db, s };
}

describe("resolveSignedAccount", () => {
  it("resolves a bound key over an arbitrary payload to its accounts.id + login", async () => {
    const { db, s } = await boundDb();
    const signedAt = Date.now();
    const payload = "revoke:xK3f9a2Bq1";
    const r = await resolveSignedAccount(db, { pubkey: s.pubkey, payload, signedAt, signature: s.sign(payload) });
    expect(r.ok).toBe(true);
    if (r.ok) { expect(r.login).toBe("octocat"); expect(r.accountId).toMatch(/[0-9a-f-]{36}/); }
  });

  it("rejects a bad signature", async () => {
    const { db, s } = await boundDb();
    const r = await resolveSignedAccount(db, { pubkey: s.pubkey, payload: "p", signedAt: Date.now(), signature: s.sign("other") });
    expect(r).toEqual({ ok: false, rejected: "bad-signature" });
  });

  it("rejects a stale signedAt (> 300s skew)", async () => {
    const { db, s } = await boundDb();
    const signedAt = Date.now() - 400_000;
    const r = await resolveSignedAccount(db, { pubkey: s.pubkey, payload: "p", signedAt, signature: s.sign("p") });
    expect(r).toEqual({ ok: false, rejected: "stale" });
  });

  it("rejects an unbound key as not-connected", async () => {
    const db = await makeTestDb();
    const s = signer();
    const r = await resolveSignedAccount(db, { pubkey: s.pubkey, payload: "p", signedAt: Date.now(), signature: s.sign("p") });
    expect(r).toEqual({ ok: false, rejected: "not-connected" });
  });
});
