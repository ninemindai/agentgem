// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
import { describe, it, expect } from "vitest";
import { makeTestDb, makeAuth, mintSession } from "@agentgem/aggregator";

const opts = {
  secret: "test-secret",
  baseURL: "http://localhost:4000",
  githubClientId: "gid",
  githubClientSecret: "gsecret",
  webOrigins: ["http://localhost:3000"],
};

describe("mintSession", () => {
  it("mints a bearer-acceptable token and an ISO expiresAt ~30d out", async () => {
    const db = await makeTestDb();
    const auth = makeAuth({ db, ...opts });
    const ctx = await auth.$context;
    const user = await ctx.internalAdapter.createUser({
      name: "Morpheus",
      email: "morpheus@example.com",
      emailVerified: true,
      login: "morpheus",
    } as never);

    const before = Date.now();
    const { token, expiresAt } = await mintSession(auth, user.id);

    expect(typeof token).toBe("string");
    expect(token.length).toBeGreaterThan(0);

    const session = await auth.api.getSession({ headers: new Headers({ authorization: `Bearer ${token}` }) });
    expect(session?.user?.id).toBe(user.id);

    expect(new Date(expiresAt).toISOString()).toBe(expiresAt);
    const expiresAtMs = new Date(expiresAt).getTime();
    const thirtyDaysMs = 30 * 24 * 60 * 60 * 1000;
    expect(expiresAtMs).toBeGreaterThan(before + thirtyDaysMs - 60_000);
    expect(expiresAtMs).toBeLessThan(before + thirtyDaysMs + 60_000);
  });
});
