// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
import type { Auth, BetterAuthOptions } from "better-auth";

// Verified server-side session-creation helper for the device-flow and SSO handoff (Plan 1b).
// internalAdapter.createSession(userId, undefined) returns a bearer-acceptable token (verified spike).
// Generic over the options type so any makeAuth(...)-produced Auth<O> is accepted — Auth<O> is
// invariant in O, so a non-generic `Auth<BetterAuthOptions>` parameter would reject it.
export async function mintSession<O extends BetterAuthOptions>(
  auth: Auth<O>,
  userId: string,
): Promise<{ token: string; expiresAt: string }> {
  const ctx = await auth.$context;
  const session = await ctx.internalAdapter.createSession(userId, undefined);
  if (!session?.token) throw new Error("better-auth returned no session token");
  return { token: session.token, expiresAt: new Date(session.expiresAt).toISOString() };
}
