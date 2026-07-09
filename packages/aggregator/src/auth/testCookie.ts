// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
// Test-only helper (mirrors testDb.ts's makeTestDb — exported so root tests under
// src/aggregator/__tests__/ can use it without importing `better-auth` directly, which isn't a
// dependency of the root package).
import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { randomUUID } from "node:crypto";
import type { AppDb } from "../schema.js";

/** Drives a REAL better-auth email/password sign-up on a throwaway instance that shares `db` +
 *  `secret` + `baseURL` with the `makeAuth(...)` instance under test, and returns the raw
 *  Set-Cookie session_token header value it mints. Exists so tests can present an authentic
 *  better-auth session COOKIE (its name and HMAC signature are private to better-auth/better-call)
 *  instead of hand-rolling one — see webAuthShim.test.ts's cookie-path regression guard. */
export async function mintBetterAuthCookieForTest(
  db: AppDb,
  opts: { secret: string; baseURL: string },
  email = `test-${Date.now()}-${Math.random().toString(36).slice(2)}@example.com`,
): Promise<string> {
  const auth = betterAuth({
    database: drizzleAdapter(db as never, { provider: "pg" }),
    secret: opts.secret,
    baseURL: opts.baseURL,
    emailAndPassword: { enabled: true },
    // Force uuid ids (mirrors makeAuth's review fix #1/#14) — the shared schema's user/account_id
    // columns are `uuid`, but better-auth's own default id generator is a 32-char nanoid.
    advanced: { database: { generateId: () => randomUUID() } },
  });
  // better-auth appends its default basePath ("/api/auth") only when `baseURL` has no path of its
  // own (e.g. "http://localhost:4000"); a baseURL that already carries a path (e.g. the production
  // ".../api/betterauth") is used as-is. Mirrors better-auth's own `withPath` default, not an
  // internal it exports — this is its documented basePath default, not undocumented behavior.
  const u = new URL(opts.baseURL);
  const root = u.pathname === "" || u.pathname === "/";
  const signUpUrl = `${opts.baseURL.replace(/\/+$/, "")}${root ? "/api/auth" : ""}/sign-up/email`;
  const res = await auth.handler(new Request(signUpUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: "Test User", email, password: "s3cret-password" }),
  }));
  if (res.status !== 200) throw new Error(`test sign-up failed: ${res.status} ${await res.text()}`);
  const cookie = res.headers.getSetCookie().find((c) => c.includes("session_token"));
  if (!cookie) throw new Error("test sign-up did not set a session_token cookie");
  return cookie.split(";")[0];
}
