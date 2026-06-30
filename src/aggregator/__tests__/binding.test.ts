// src/aggregator/__tests__/binding.test.ts
import { describe, it, expect } from "vitest";
import { generateKeyPairSync, sign as edSign } from "node:crypto";
import { makeTestDb } from "@agentgem/aggregator";
import { producers, accountBindings } from "@agentgem/aggregator";
import { recordBinding, bindSigningPayload, type BindRequest } from "@agentgem/aggregator";
import type { AccountVerifier, VerifiedAccount } from "@agentgem/aggregator";

function makeSigner() {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const pubkey = "ed25519:" + publicKey.export({ format: "der", type: "spki" }).toString("base64");
  return { pubkey, sign: (d: string) => edSign(null, Buffer.from(d, "utf8"), privateKey).toString("base64") };
}
const fakeVerifier = (acct: VerifiedAccount): AccountVerifier => ({ verify: async () => acct });
const throwingVerifier: AccountVerifier = { verify: async () => { throw new Error("bad token"); } };
const OCTOCAT: VerifiedAccount = { provider: "github", accountId: "42", login: "octocat" };

async function req(signer: ReturnType<typeof makeSigner>, token: string, signedAt: number): Promise<BindRequest> {
  return { pubkey: signer.pubkey, token, signedAt, signature: signer.sign(bindSigningPayload(signer.pubkey, token, signedAt)) };
}

describe("recordBinding", () => {
  it("records a binding for a valid signature + verified token + existing producer", async () => {
    const db = await makeTestDb();
    const s = makeSigner();
    await db.insert(producers).values({ pubkey: s.pubkey });
    const now = 1_000_000;
    const res = await recordBinding(db, await req(s, "tok", now), fakeVerifier(OCTOCAT), now);
    expect(res).toEqual({ bound: true, provider: "github", login: "octocat", accountId: "42" });
    const rows = await db.select().from(accountBindings);
    expect(rows).toHaveLength(1);
    expect(rows[0].accountId).toBe("42");
  });
  it("rejects a bad signature", async () => {
    const db = await makeTestDb();
    const s = makeSigner();
    await db.insert(producers).values({ pubkey: s.pubkey });
    const now = 1_000_000;
    const bad = { ...(await req(s, "tok", now)), signature: "AAAA" };
    expect(await recordBinding(db, bad, fakeVerifier(OCTOCAT), now)).toEqual({ bound: false, rejected: "bad-signature" });
  });
  it("rejects a stale signedAt (> 300s skew)", async () => {
    const db = await makeTestDb();
    const s = makeSigner();
    await db.insert(producers).values({ pubkey: s.pubkey });
    const signedAt = 1_000_000;
    const res = await recordBinding(db, await req(s, "tok", signedAt), fakeVerifier(OCTOCAT), signedAt + 300_001);
    expect(res).toEqual({ bound: false, rejected: "stale" });
  });
  it("rejects an unknown producer (no producer row)", async () => {
    const db = await makeTestDb();
    const s = makeSigner();
    const now = 1_000_000;
    expect(await recordBinding(db, await req(s, "tok", now), fakeVerifier(OCTOCAT), now)).toEqual({ bound: false, rejected: "unknown-producer" });
  });
  it("maps a provider error", async () => {
    const db = await makeTestDb();
    const s = makeSigner();
    await db.insert(producers).values({ pubkey: s.pubkey });
    const now = 1_000_000;
    expect(await recordBinding(db, await req(s, "tok", now), throwingVerifier, now)).toEqual({ bound: false, rejected: "provider-error" });
  });
  it("is idempotent and updates in place on rebind to a different account", async () => {
    const db = await makeTestDb();
    const s = makeSigner();
    await db.insert(producers).values({ pubkey: s.pubkey });
    const now = 1_000_000;
    await recordBinding(db, await req(s, "tok", now), fakeVerifier(OCTOCAT), now);
    await recordBinding(db, await req(s, "tok2", now), fakeVerifier({ provider: "github", accountId: "99", login: "hubot" }), now);
    const rows = await db.select().from(accountBindings);
    expect(rows).toHaveLength(1);              // still one row for this pubkey
    expect(rows[0].accountId).toBe("99");      // updated in place
  });
});
