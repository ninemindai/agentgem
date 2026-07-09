// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
import { describe, it, expect } from "vitest";
import { makeTestDb, makeAuth } from "@agentgem/aggregator";

const opts = {
  secret: "test-secret",
  baseURL: "http://localhost:4000",
  githubClientId: "gid",
  githubClientSecret: "gsecret",
  webOrigins: ["http://localhost:3000"],
};

describe("betterAuth factory", () => {
  it("constructs over makeTestDb() and rejects an unknown bearer", async () => {
    const db = await makeTestDb();
    const auth = makeAuth({ db, ...opts });
    const session = await auth.api.getSession({ headers: new Headers({ authorization: "Bearer nope" }) });
    expect(session).toBeNull();
  });

  it("forces uuid ids via advanced.database.generateId", async () => {
    const db = await makeTestDb();
    const auth = makeAuth({ db, ...opts });
    const ctx = await auth.$context;
    const user = await ctx.internalAdapter.createUser({ email: "neo@example.com", name: "Neo", emailVerified: false } as never);
    expect(user.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
  });

  it("mints a session with a 30-day TTL", async () => {
    const db = await makeTestDb();
    const auth = makeAuth({ db, ...opts });
    const ctx = await auth.$context;
    const user = await ctx.internalAdapter.createUser({ email: "trinity@example.com", name: "Trinity", emailVerified: false } as never);
    const before = Date.now();
    const session = await ctx.internalAdapter.createSession(user.id, undefined);
    const expiresAt = new Date(session.expiresAt).getTime();
    const thirtyDaysMs = 30 * 24 * 60 * 60 * 1000;
    expect(expiresAt).toBeGreaterThan(before + thirtyDaysMs - 60_000);
    expect(expiresAt).toBeLessThan(before + thirtyDaysMs + 60_000);
  });
});
