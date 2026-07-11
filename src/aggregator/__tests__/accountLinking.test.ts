// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
import { describe, it, expect } from "vitest";
import { makeTestDb, makeAuth, stashPendingLink, pendingLink } from "@agentgem/aggregator";

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
