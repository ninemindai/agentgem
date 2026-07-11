// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
//
// Task 0 SPIKE — does better-auth persist the resolved identity of a provider that linkSocial
// REJECTS because it already belongs to another user, scoped to the caller's session?
//
// A real linkSocial round-trip is not reproducible in-process (it needs a live GitHub/Google
// redirect and a genuine OAuth code exchange). Instead this spike reproduces the DB effects of
// better-auth's OWN conflict branch, which is inline in its callback route and does exactly one
// server-side resolution of the provider identity:
//
//   better-auth@1.6.23 dist/api/routes/callback.mjs, the `if (link) { ... }` block:
//     const providerAccountId = String(userInfo.id);                    // resolved in-memory (l.88)
//     const existingAccount =
//       await internalAdapter.findAccountByProviderId(providerAccountId, provider.id);   // (l.99)
//     if (existingAccount) {
//       if (existingAccount.userId !== link.userId)
//         redirectOnError(c, errorURL, "account_already_linked_to_different_user");      // (l.101)
//       ...
//     }
//
//   `link` comes from the OAuth state, which linkSocial (dist/api/routes/account.mjs l.178-181)
//   populated with ONLY `{ userId, email }` — the CALLER's own session identity — BEFORE the OAuth
//   round-trip, when the other provider's id is not yet known. On the conflict, `redirectOnError`
//   throws a redirect and NOTHING is written: `createAccount` is never called (so the
//   `databaseHooks.account.create` anchor hook never fires) and the resolved `providerAccountId` is
//   discarded. This test asserts that residue == nothing-tying-the-identity-to-the-caller.
import { describe, it, expect } from "vitest";
import { sql } from "drizzle-orm";
import { makeTestDb, makeAuth } from "@agentgem/aggregator";

describe("absorb seam spike", () => {
  it("shows what better-auth leaves behind when linkSocial hits an already-linked provider", async () => {
    const db = await makeTestDb();
    const auth = makeAuth({ db, secret: "s", baseURL: "http://localhost:4000/api/auth",
      githubClientId: "gid", githubClientSecret: "gsec",
      googleClientId: "ggid", googleClientSecret: "ggsec",
      webOrigins: ["http://localhost:3000"] });
    const ctx = await auth.$context;
    // user A (caller) with github; user B owning the google identity we will try to link to A.
    const a = await ctx.internalAdapter.createUser({ email: "a@x.com", name: "A", emailVerified: false } as never);
    const b = await ctx.internalAdapter.createUser({ email: "b@y.com", name: "B", emailVerified: false } as never);
    await db.execute(sql`insert into account (id, user_id, account_id, provider_id, created_at, updated_at)
      values (gen_random_uuid()::text, ${b.id}, 'google-123', 'google', now(), now())`);

    // Reproduce better-auth's conflict branch with the exact internalAdapter call its callback uses.
    // This is the ONLY server-side resolution of the provider identity, and it resolves to the OWNER
    // (B) — never to the caller (A). On mismatch, the callback redirects and writes nothing.
    const resolved = await ctx.internalAdapter.findAccountByProviderId("google-123", "google");
    const conflict = !!resolved && resolved.userId.toString() !== a.id.toString(); // -> redirectOnError

    // Residue after the (simulated) conflict redirect: what, if anything, ties google-123 to A?
    const accountRows = await db.execute(sql`select provider_id, account_id, user_id from account`);
    const aGoogle = await db.execute(
      sql`select 1 from account where user_id = ${a.id} and provider_id = 'google'`);
    const verifRefs = await db.execute(
      sql`select id, identifier from verification where value like '%google-123%' or identifier like '%google-123%'`);
    console.log("account rows after attempted link:", accountRows.rows);
    console.log("rows tying google-123 to caller A:", aGoogle.rows.length);
    console.log("verification rows referencing google-123:", verifRefs.rows.length);

    // FINDING (seam b): the identity IS resolvable server-side, but ONLY keyed to its owner B.
    expect(conflict).toBe(true);
    expect(resolved?.userId.toString()).toBe(b.id.toString());
    // NOTHING scoped to caller A's session records google-123: no account row, no verification row.
    expect(aGoogle.rows.length).toBe(0);
    expect(verifRefs.rows.length).toBe(0);
    // Exactly one account row for google-123 total — B's — and it is untouched by A's attempt.
    expect(accountRows.rows.filter((r: any) => r.account_id === "google-123")).toHaveLength(1);
  });
});
