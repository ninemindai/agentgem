// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
// Regression: better-auth requires a non-null email STRING in both user creation and linkSocial's
// OAuth state (state.mjs `link.email: z.string()`). GitHub logins are frequently email-less (the
// `"user".email` column is deliberately nullable), so a null-email account threw an unhandled
// `internal_server_error` on the Connect (linkSocial) callback. Every email-less user gets GitHub's
// noreply address instead.
import { describe, it, expect } from "vitest";
import { sql } from "drizzle-orm";
import { makeTestDb, makeAuth, backfillUserEmails } from "@agentgem/aggregator";

const opts = {
  secret: "test-secret",
  baseURL: "http://localhost:4000",
  githubClientId: "gid",
  githubClientSecret: "gsecret",
  webOrigins: ["http://localhost:3000"],
};

describe("null-email backfill", () => {
  it("gives every null-email user a stable, unique noreply address; idempotent", async () => {
    const db = await makeTestDb();
    const auth = makeAuth({ db, ...opts });
    const ctx = await auth.$context;
    const u = await ctx.internalAdapter.createUser({ email: "seed@example.com", name: "R", emailVerified: false } as never);
    // A github account whose email is null (the real production shape — see the query in the fix).
    await db.execute(sql`update "user" set email = null, login = 'raymondfeng' where id = ${u.id}`);

    const { filled } = await backfillUserEmails(db);
    expect(filled).toBeGreaterThanOrEqual(1);
    const row = (await db.execute(sql`select email from "user" where id = ${u.id}`)).rows[0] as { email: string };
    expect(row.email).toBe("raymondfeng@users.noreply.github.com");

    // Idempotent: a second run fills nothing (no churn on already-backfilled rows).
    expect((await backfillUserEmails(db)).filled).toBe(0);
  });

  it("github mapProfileToUser falls back to a noreply email ONLY when github returns null", async () => {
    const db = await makeTestDb();
    const auth = makeAuth({ db, ...opts });
    const gh = (auth.options.socialProviders as { github?: { mapProfileToUser: (p: unknown) => { email?: string } } }).github!;
    expect(gh.mapProfileToUser({ login: "raymondfeng", name: "R", avatar_url: "a", email: null }).email)
      .toBe("raymondfeng@users.noreply.github.com");
    // A real email is preserved untouched.
    expect(gh.mapProfileToUser({ login: "x", name: "X", avatar_url: "a", email: "real@example.com" }).email)
      .toBe("real@example.com");
  });
});
