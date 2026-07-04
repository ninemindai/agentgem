// src/aggregator/__tests__/binding.test.ts
import { describe, it, expect } from "vitest";
import { generateKeyPairSync, sign as edSign } from "node:crypto";
import { sql } from "drizzle-orm";
import { makeTestDb } from "@agentgem/aggregator";
import { producers, accountBindings, accounts } from "@agentgem/aggregator";
import { recordBinding, bindSigningPayload, resolveSession, type BindRequest } from "@agentgem/aggregator";
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
    expect(res).toMatchObject({ bound: true, provider: "github", login: "octocat", accountId: "42" });
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
  it("self-registers a new identity (no prior producer row) and binds", async () => {
    const db = await makeTestDb();
    const s = makeSigner();
    const now = 1_000_000;
    // No producer seeded — a valid signature + verified token is enough to bind now.
    const res = await recordBinding(db, await req(s, "tok", now), fakeVerifier(OCTOCAT), now);
    expect(res).toMatchObject({ bound: true, provider: "github", login: "octocat", accountId: "42" });
    // The identity is now a registered (zero-attestation) producer.
    const prod = await db.select().from(producers).where(sql`pubkey = ${s.pubkey}`);
    expect(prod).toHaveLength(1);
    const rows = await db.select().from(accountBindings);
    expect(rows).toHaveLength(1);
    expect(rows[0].accountId).toBe("42");
  });
  it("returns a session token the web session store accepts (bearer ≡ cookie)", async () => {
    const db = await makeTestDb();
    const s = makeSigner();
    await db.insert(producers).values({ pubkey: s.pubkey });
    const now = 1_000_000;
    const res = await recordBinding(db, await req(s, "tok", now), fakeVerifier(OCTOCAT), now);
    expect(res.bound).toBe(true);
    if (!res.bound) return;
    expect(typeof res.sessionToken).toBe("string");
    expect(res.expiresAt).toBeTruthy();
    // The minted session bearer resolves to the same account — same token the web cookie carries.
    const who = await resolveSession(db, res.sessionToken!);
    expect(who?.login).toBe("octocat");
  });
  it("does NOT register a producer when the token is invalid", async () => {
    const db = await makeTestDb();
    const s = makeSigner();
    const now = 1_000_000;
    expect(await recordBinding(db, await req(s, "tok", now), throwingVerifier, now)).toEqual({ bound: false, rejected: "provider-error" });
    const prod = await db.select().from(producers).where(sql`pubkey = ${s.pubkey}`);
    expect(prod).toHaveLength(0); // bogus token must not create an identity
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
  it("reconciles the accounts row with avatar and returns avatarUrl", async () => {
    const db = await makeTestDb();
    const s = makeSigner();
    await db.insert(producers).values({ pubkey: s.pubkey });
    const now = 1_000_000;
    const verifier = fakeVerifier({ provider: "github", accountId: "42", login: "octocat", avatarUrl: "https://a/42.png" });
    const res = await recordBinding(db, await req(s, "tok", now), verifier, now);
    expect(res).toMatchObject({ bound: true, login: "octocat", avatarUrl: "https://a/42.png" });
    const rows = await db.select().from(accounts).where(sql`provider = 'github' and provider_account_id = '42'`);
    expect(rows[0]?.avatarUrl).toBe("https://a/42.png");
  });
});
