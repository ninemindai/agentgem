// src/aggregator/__tests__/binding.test.ts
import { describe, it, expect } from "vitest";
import { generateKeyPairSync, sign as edSign } from "node:crypto";
import { sql } from "drizzle-orm";
import { makeTestDb, makeAuth, resolveSession } from "@agentgem/aggregator";
import { producers, accountBindings, accounts } from "@agentgem/aggregator";
import { recordBinding, bindSigningPayload, accountOwnsScope, getAccountScopes, type BindRequest } from "@agentgem/aggregator";
import { claimHandle, handleForAccountId } from "@agentgem/aggregator";
import type { AccountVerifier, VerifiedAccount } from "@agentgem/aggregator";

const AUTH_OPTS = {
  secret: "test-secret",
  baseURL: "http://localhost:4000",
  githubClientId: "gid",
  githubClientSecret: "gsecret",
  webOrigins: ["http://localhost:3000"],
};

function makeSigner() {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const pubkey = "ed25519:" + publicKey.export({ format: "der", type: "spki" }).toString("base64");
  return { pubkey, sign: (d: string) => edSign(null, Buffer.from(d, "utf8"), privateKey).toString("base64") };
}
const fakeVerifier = (acct: VerifiedAccount): AccountVerifier => ({ verify: async () => acct });
const throwingVerifier: AccountVerifier = { verify: async () => { throw new Error("bad token"); } };
const OCTOCAT: VerifiedAccount = { provider: "github", accountId: "42", login: "octocat" };
// Stub the org-membership fetch so unit tests never touch the real GitHub API.
const NO_ORGS = async () => [] as { login: string; role: "admin" | "member" }[];

async function req(signer: ReturnType<typeof makeSigner>, token: string, signedAt: number): Promise<BindRequest> {
  return { pubkey: signer.pubkey, token, signedAt, signature: signer.sign(bindSigningPayload(signer.pubkey, token, signedAt)) };
}

describe("recordBinding", () => {
  it("records a binding for a valid signature + verified token + existing producer", async () => {
    const db = await makeTestDb();
    const s = makeSigner();
    await db.insert(producers).values({ pubkey: s.pubkey });
    const now = 1_000_000;
    const res = await recordBinding(db, await req(s, "tok", now), fakeVerifier(OCTOCAT), now, NO_ORGS);
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
    expect(await recordBinding(db, bad, fakeVerifier(OCTOCAT), now, NO_ORGS)).toEqual({ bound: false, rejected: "bad-signature" });
  });
  it("rejects a stale signedAt (> 300s skew)", async () => {
    const db = await makeTestDb();
    const s = makeSigner();
    await db.insert(producers).values({ pubkey: s.pubkey });
    const signedAt = 1_000_000;
    const res = await recordBinding(db, await req(s, "tok", signedAt), fakeVerifier(OCTOCAT), signedAt + 300_001, NO_ORGS);
    expect(res).toEqual({ bound: false, rejected: "stale" });
  });
  it("self-registers a new identity (no prior producer row) and binds", async () => {
    const db = await makeTestDb();
    const s = makeSigner();
    const now = 1_000_000;
    // No producer seeded — a valid signature + verified token is enough to bind now.
    const res = await recordBinding(db, await req(s, "tok", now), fakeVerifier(OCTOCAT), now, NO_ORGS);
    expect(res).toMatchObject({ bound: true, provider: "github", login: "octocat", accountId: "42" });
    // The identity is now a registered (zero-attestation) producer.
    const prod = await db.select().from(producers).where(sql`pubkey = ${s.pubkey}`);
    expect(prod).toHaveLength(1);
    const rows = await db.select().from(accountBindings);
    expect(rows).toHaveLength(1);
    expect(rows[0].accountId).toBe("42");
  });
  it("returns a session token a real better-auth session resolves (bearer ≡ cookie)", async () => {
    const db = await makeTestDb();
    const auth = makeAuth({ db, ...AUTH_OPTS });
    const s = makeSigner();
    await db.insert(producers).values({ pubkey: s.pubkey });
    const now = 1_000_000;
    const res = await recordBinding(db, await req(s, "tok", now), fakeVerifier(OCTOCAT), now, NO_ORGS, auth);
    expect(res.bound).toBe(true);
    if (!res.bound) return;
    expect(typeof res.sessionToken).toBe("string");
    expect(res.expiresAt).toBeTruthy();
    // The minted session bearer resolves to the same account through better-auth itself — the
    // real path resolveSession/the bearer plugin honors, not just a row in a table. `res.accountId`
    // is the GitHub provider id ("42"); the internal uuid is `accounts.id`, which is what the
    // better-auth "user" row is anchored to and what resolveSession returns.
    const rows = await db.select().from(accounts).where(sql`provider = 'github' and provider_account_id = '42'`);
    const who = await resolveSession(auth, { authorization: `Bearer ${res.sessionToken}` });
    expect(who).toEqual({ login: "octocat", avatarUrl: null, accountId: rows[0].id });
  });
  it("does not mint a session when no auth instance is supplied (session is additive)", async () => {
    const db = await makeTestDb();
    const s = makeSigner();
    await db.insert(producers).values({ pubkey: s.pubkey });
    const now = 1_000_000;
    const res = await recordBinding(db, await req(s, "tok", now), fakeVerifier(OCTOCAT), now, NO_ORGS);
    expect(res).toMatchObject({ bound: true, login: "octocat" });
    if (!res.bound) return;
    expect(res.sessionToken).toBeUndefined();
  });
  it("does NOT register a producer when the token is invalid", async () => {
    const db = await makeTestDb();
    const s = makeSigner();
    const now = 1_000_000;
    expect(await recordBinding(db, await req(s, "tok", now), throwingVerifier, now, NO_ORGS)).toEqual({ bound: false, rejected: "provider-error" });
    const prod = await db.select().from(producers).where(sql`pubkey = ${s.pubkey}`);
    expect(prod).toHaveLength(0); // bogus token must not create an identity
  });
  it("maps a provider error", async () => {
    const db = await makeTestDb();
    const s = makeSigner();
    await db.insert(producers).values({ pubkey: s.pubkey });
    const now = 1_000_000;
    expect(await recordBinding(db, await req(s, "tok", now), throwingVerifier, now, NO_ORGS)).toEqual({ bound: false, rejected: "provider-error" });
  });
  it("is idempotent and updates in place on rebind to a different account", async () => {
    const db = await makeTestDb();
    const s = makeSigner();
    await db.insert(producers).values({ pubkey: s.pubkey });
    const now = 1_000_000;
    await recordBinding(db, await req(s, "tok", now), fakeVerifier(OCTOCAT), now, NO_ORGS);
    await recordBinding(db, await req(s, "tok2", now), fakeVerifier({ provider: "github", accountId: "99", login: "hubot" }), now, NO_ORGS);
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
    const res = await recordBinding(db, await req(s, "tok", now), verifier, now, NO_ORGS);
    expect(res).toMatchObject({ bound: true, login: "octocat", avatarUrl: "https://a/42.png" });
    const rows = await db.select().from(accounts).where(sql`provider = 'github' and provider_account_id = '42'`);
    expect(rows[0]?.avatarUrl).toBe("https://a/42.png");
  });
});

describe("recordBinding org-scope capture", () => {
  it("captures ORG scopes (with role) and auto-claims the handle, so CLI-only users pass membership gates", async () => {
    const db = await makeTestDb();
    const s = makeSigner();
    const now = 1_000_000;
    const orgs = async () => [{ login: "ninemind", role: "admin" as const }, { login: "acme", role: "member" as const }];
    await recordBinding(db, await req(s, "tok", now), fakeVerifier(OCTOCAT), now, orgs);
    const rows = await db.select().from(accounts);
    // account_scopes carries ORG memberships only. The caller's own namespace is "user".handle,
    // auto-claimed at bind exactly as anchorAndScopes claims it at web sign-in.
    const scopes = await getAccountScopes(db, rows[0].id);
    expect(Object.fromEntries(scopes.map((x) => [x.scope, x.role]))).toEqual({ ninemind: "admin", acme: "member" });
    expect(await handleForAccountId(db, rows[0].id)).toBe("octocat");
    expect(await accountOwnsScope(db, rows[0].id, "ninemind")).toBe(true);
    expect(await accountOwnsScope(db, rows[0].id, "octocat")).toBe(true);   // via the handle
  });

  // REGRESSION, P1(a) — the bug this whole seam existed to hide. recordBinding used to write
  // `{ scope: acct.login, role: "self" }` through setAccountScopes, which REPLACES the account's
  // whole scope set. So: rename your handle, let someone claim the name you abandoned, run
  // `agentgem bind` again — and you would silently get a `self` grant on THEIR namespace (the
  // publish gate at uploadPublish.ts reads accountOwnsScope), while losing publish rights on your
  // own. The self grant now derives from "user".handle, and claimHandleIfUnset's `handle IS NULL`
  // guard means a re-bind never touches a handle the user has already renamed.
  it("a re-bind after a rename does NOT revert the handle, and grants nothing on the abandoned name", async () => {
    const db = await makeTestDb();
    const auth = makeAuth({ db, ...AUTH_OPTS });
    const alice = makeSigner();
    const now = 1_000_000;

    await recordBinding(db, await req(alice, "tok-a", now), fakeVerifier(OCTOCAT), now, NO_ORGS, auth);
    const aliceId = (await db.select().from(accounts).where(sql`provider_account_id = '42'`))[0].id;
    expect(await handleForAccountId(db, aliceId)).toBe("octocat");

    // Alice renames away from her GitHub login.
    expect(await claimHandle(db, aliceId, "octocat-new")).toMatchObject({ ok: true });

    // A re-bind with the name still FREE must not reclaim it: claimHandleIfUnset's `handle IS NULL`
    // guard is the only thing stopping a bind from dragging her back to her GitHub login.
    await recordBinding(db, await req(alice, "tok-a1", now), fakeVerifier(OCTOCAT), now, NO_ORGS, auth);
    expect(await handleForAccountId(db, aliceId)).toBe("octocat-new");
    expect(await accountOwnsScope(db, aliceId, "octocat")).toBe(false);

    // Mallory claims the freed name.
    const mallory = makeSigner();
    const MALLORY = { provider: "github", accountId: "43", login: "mallory" } as const;
    await recordBinding(db, await req(mallory, "tok-m", now), fakeVerifier(MALLORY), now, NO_ORGS, auth);
    const malloryId = (await db.select().from(accounts).where(sql`provider_account_id = '43'`))[0].id;
    expect(await claimHandle(db, malloryId, "octocat")).toMatchObject({ ok: true });

    // Alice re-binds from the CLI, still authenticating as GitHub login "octocat".
    await recordBinding(db, await req(alice, "tok-a2", now), fakeVerifier(OCTOCAT), now, NO_ORGS, auth);

    expect(await handleForAccountId(db, aliceId)).toBe("octocat-new");        // not reverted
    expect(await accountOwnsScope(db, aliceId, "octocat-new")).toBe(true);    // keeps her own
    expect(await accountOwnsScope(db, aliceId, "octocat")).toBe(false);       // NOT Mallory's
    expect(await accountOwnsScope(db, malloryId, "octocat")).toBe(true);      // still Mallory's

    // And the bind wrote NO scope row naming her login — the mechanism of the original bug. A row
    // with any role would resurrect it, so pin the absence of the name, not merely of role='self'.
    expect((await getAccountScopes(db, aliceId)).map((s) => s.scope)).not.toContain("octocat");
  });
  it("an org-fetch failure still captures the self scope and never fails the bind", async () => {
    const db = await makeTestDb();
    const s = makeSigner();
    const now = 1_000_000;
    const res = await recordBinding(db, await req(s, "tok", now), fakeVerifier(OCTOCAT), now, async () => { throw new Error("orgs down"); });
    expect(res).toMatchObject({ bound: true });
    const rows = await db.select().from(accounts);
    expect(await accountOwnsScope(db, rows[0].id, "octocat")).toBe(true);
  });
});
