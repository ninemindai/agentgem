// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
import { describe, it, expect } from "vitest";
import { generateKeyPairSync, sign as edSign, randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import {
  makeTestDb, makeAuth, stashPendingLink, pendingLink, upsertAccount, accountIdForProvider,
  producers, accountBindings, catalogGems, catalogSigningPayload, recordCatalogShare, deleteCatalogGem, buildProfile,
} from "@agentgem/aggregator";

function signer() {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const pubkey = "ed25519:" + publicKey.export({ format: "der", type: "spki" }).toString("base64");
  return { pubkey, sign: (d: string) => edSign(null, Buffer.from(d, "utf8"), privateKey).toString("base64") };
}

const opts = {
  secret: "test-secret",
  baseURL: "http://localhost:4000",
  githubClientId: "gid",
  githubClientSecret: "gsecret",
  webOrigins: ["http://localhost:3000"],
};

describe("pendingLink (Flow B connect-OAuth seam)", () => {
  it("returns the OAuth-verified other-provider identity for this session, else null", async () => {
    const db = await makeTestDb();
    const auth = makeAuth({ db, ...opts });
    const ctx = await auth.$context;
    // Two real sessions' subjects. U is the caller who just OAuth'd a second provider; V is unrelated.
    const u = await ctx.internalAdapter.createUser({ email: "u@x.com", name: "U", emailVerified: false } as never);
    const v = await ctx.internalAdapter.createUser({ email: "v@y.com", name: "V", emailVerified: false } as never);

    // Drive seam (b): the bespoke connect-OAuth callback resolved google-123 server-side for U and
    // stashed it. (In Task 6 this write is the ONLY place the resolved id enters the store.)
    await stashPendingLink(db, u.id, { providerId: "google", providerAccountId: "google-123" });

    // U reads back exactly its own server-verified pending identity.
    expect(await pendingLink(db, u.id)).toEqual({ providerId: "google", providerAccountId: "google-123" });

    // Discriminating #1: an unrelated session V has no pending link — cannot see U's.
    expect(await pendingLink(db, v.id)).toBeNull();

    // Discriminating #2: a client cannot fabricate a pending link by NAMING a victim id. pendingLink
    // takes only the server-verified session subject and reads only server state — there is no
    // request-supplied id it could honor. Even though google-123 exists in the store (keyed to U),
    // V's session resolves to null.
    expect(await pendingLink(db, v.id)).toBeNull();
  });

  it("returns null once the pending link has expired", async () => {
    const db = await makeTestDb();
    const auth = makeAuth({ db, ...opts });
    const ctx = await auth.$context;
    const u = await ctx.internalAdapter.createUser({ email: "u2@x.com", name: "U2", emailVerified: false } as never);

    await stashPendingLink(db, u.id, { providerId: "github", providerAccountId: "gh-999" }, -1);
    expect(await pendingLink(db, u.id)).toBeNull();
  });
});

describe("accountIdForProvider (resolve a linked, non-primary provider back to its owner)", () => {
  it("resolves a linked provider whose identity is NOT the anchor stamp", async () => {
    const db = await makeTestDb();
    const auth = makeAuth({ db, ...opts });
    const ctx = await auth.$context;
    const u = await ctx.internalAdapter.createUser({ email: "u3@x.com", name: "U3", emailVerified: false } as never);
    // Anchor stamped with the PRIMARY provider (github), per Task 1. In production this is always
    // paired with a same-identity better-auth `account` row (anchorAndScopes on web sign-in,
    // ensureBetterAuthUser on desktop bind — see migrateAccounts.ts) — mirror that here.
    await upsertAccount(db, { provider: "github", accountId: "gh-primary", login: "u3", id: u.id });
    await db.execute(sql`insert into account (id, user_id, account_id, provider_id, created_at, updated_at)
      values (gen_random_uuid()::text, ${u.id}, 'gh-primary', 'github', now(), now())`);
    // A LINKED google provider lives ONLY in better-auth's `account` table — Task 1 gives the
    // anchor no second row for it.
    await db.execute(sql`insert into account (id, user_id, account_id, provider_id, created_at, updated_at)
      values (gen_random_uuid()::text, ${u.id}, 'goog-u3', 'google', now(), now())`);
    expect(await accountIdForProvider(db, "google", "goog-u3")).toBe(u.id); // was null via the legacy anchor join
    expect(await accountIdForProvider(db, "github", "gh-primary")).toBe(u.id);
    expect(await accountIdForProvider(db, "google", "nope")).toBeNull();
  });
});

// Regression coverage for the two call sites that used to resolve a desktop `account_bindings`
// identity via the legacy `accounts.provider`/`provider_account_id` columns directly, and so broke
// for a LINKED (non-primary) provider after Task 1 made the anchor per-user.
describe("linked-provider regression: a Google-primary account whose desktop binding is a linked GitHub identity", () => {
  it("recordCatalogShare (catalog.ts gem-publish ownership) records ownership to the primary account, not null", async () => {
    const db = await makeTestDb();
    const auth = makeAuth({ db, ...opts });
    const ctx = await auth.$context;
    const u = await ctx.internalAdapter.createUser({ email: "u4@x.com", name: "U4", emailVerified: false } as never);
    // Anchor stamped with the PRIMARY provider (google), per Task 1.
    await upsertAccount(db, { provider: "google", accountId: "goog-u4", login: null, id: u.id });
    await db.execute(sql`insert into account (id, user_id, account_id, provider_id, created_at, updated_at)
      values (gen_random_uuid()::text, ${u.id}, 'goog-u4', 'google', now(), now())`);
    // GitHub linked via native linking (Task 3) — lives ONLY in better-auth's `account` table; the
    // anchor gets no second row for it (Task 1).
    await db.execute(sql`insert into account (id, user_id, account_id, provider_id, created_at, updated_at)
      values (gen_random_uuid()::text, ${u.id}, 'gh-linked', 'github', now(), now())`);

    // The desktop app's device-flow bind (recordBinding, binding.ts) records the GITHUB identity in
    // account_bindings independent of better-auth. recordCatalogShare must resolve THIS binding's
    // provider identity back to the google-primary account.
    const s = signer();
    await db.insert(producers).values({ pubkey: s.pubkey });
    await db.insert(accountBindings).values({ pubkey: s.pubkey, provider: "github", accountId: "gh-linked", accountLogin: "octocat4" });

    const manifest = { gemKey: "@octocat4/linked", version: "1.0.0", description: "d" };
    const signedAt = Date.now();
    const signature = s.sign(catalogSigningPayload(manifest, s.pubkey, signedAt));
    const res = await recordCatalogShare(db, { manifest, pubkey: s.pubkey, signedAt, signature }, signedAt);
    expect(res).toMatchObject({ shared: true, publishedBy: "octocat4" });

    // Ownership resolved to the google-primary account (u.id): it may unpublish, proving
    // ownerAccountId is u.id and not null/a stray row (deleteCatalogGem's guard is fail-closed).
    expect(await deleteCatalogGem(db, manifest.gemKey, manifest.version, u.id)).toBe("deleted");
  });

  it("buildProfile (profile.ts verified badge) returns verified: true for the primary account via its linked GitHub desktop binding", async () => {
    const db = await makeTestDb();
    const auth = makeAuth({ db, ...opts });
    const ctx = await auth.$context;
    const u = await ctx.internalAdapter.createUser({ email: "u5@x.com", name: "U5", emailVerified: false } as never);
    await upsertAccount(db, { provider: "google", accountId: "goog-u5", login: null, id: u.id });
    await db.execute(sql`insert into account (id, user_id, account_id, provider_id, created_at, updated_at)
      values (gen_random_uuid()::text, ${u.id}, 'goog-u5', 'google', now(), now())`);
    await db.execute(sql`insert into account (id, user_id, account_id, provider_id, created_at, updated_at)
      values (gen_random_uuid()::text, ${u.id}, 'gh-linked5', 'github', now(), now())`);
    // A Google sign-in never auto-claims a handle (anchorAndScopes only claims for github logins);
    // claim one directly so buildProfile has a handle to resolve.
    await db.execute(sql`update "user" set handle = 'u5handle' where id = ${u.id}`);

    const pubkey = "ed25519:" + randomUUID();
    await db.insert(producers).values({ pubkey });
    await db.insert(accountBindings).values({ pubkey, provider: "github", accountId: "gh-linked5", accountLogin: "octocat5" });
    await db.insert(catalogGems).values({ gemKey: "@u5/g", version: "1.0.0", publishedBy: "octocat5", createdAtMs: 1, ownerAccountId: u.id });

    const p = await buildProfile(db, "u5handle");
    expect(p).not.toBeNull();
    expect(p!.verified).toBe(true); // was false via the legacy accounts.provider join
  });
});

describe("connectedProviders (Flow A: list every provider linked to an account)", () => {
  it("connectedProviders lists every provider linked to the account, sorted", async () => {
    const db = await makeTestDb();
    const auth = makeAuth({ db, ...opts, googleClientId: "g", googleClientSecret: "g" });
    const ctx = await auth.$context;
    const u = await ctx.internalAdapter.createUser({ email: "u@x.com", name: "U", emailVerified: false } as never);
    await db.execute(sql`insert into account (id, user_id, account_id, provider_id, created_at, updated_at) values
      (gen_random_uuid()::text, ${u.id}, 'gh', 'github', now(), now()),
      (gen_random_uuid()::text, ${u.id}, 'go', 'google', now(), now())`);
    const { connectedProviders } = await import("@agentgem/aggregator");
    expect(await connectedProviders(db, u.id)).toEqual(["github", "google"]);
  });
});
