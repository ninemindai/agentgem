// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
import type { Auth, BetterAuthOptions } from "better-auth";
import { mintSession } from "./mintSession.js";

// SSO handoff redeem needs a genuine better-auth Set-Cookie for an account the browser has no
// existing session for — mintSession only creates the session row and hands back its RAW token
// (bearer-acceptable, not a cookie). better-auth signs its own cookies (HMAC over a secret that's
// private to its `better-call` dependency); hand-rolling that signature would be reaching into an
// undocumented internal. Instead this drives TWO REAL better-auth endpoints in-process — the
// `one-time-token` plugin's generate + verify (registered in betterAuth.ts) — so the Set-Cookie
// comes out of better-auth's own setSessionCookie(), never fabricated here:
//   1) generate, bearer-authenticated with the minted session's raw token, mints a short-lived
//      exchange token bound to that exact session (real endpoint, real sessionMiddleware resolve).
//   2) verify, presented with that exchange token, consumes it (delete-on-read) and calls
//      better-auth's setSessionCookie for the SAME session — its Set-Cookie is what we forward.
// Both calls go through `auth.handler(request)` directly (no network hop, no Express routing).
export async function mintSessionCookie<O extends BetterAuthOptions>(
  auth: Auth<O>,
  userId: string,
): Promise<string> {
  const { token } = await mintSession(auth, userId);
  const ctx = await auth.$context;
  const base = ctx.baseURL.replace(/\/+$/, "");

  const genRes = await auth.handler(new Request(`${base}/one-time-token/generate`, {
    headers: { authorization: `Bearer ${token}` },
  }));
  if (!genRes.ok) throw new Error(`mintSessionCookie: one-time-token/generate failed (${genRes.status})`);
  const { token: ott } = (await genRes.json()) as { token?: string };
  if (!ott) throw new Error("mintSessionCookie: no one-time-token returned");

  const verifyRes = await auth.handler(new Request(`${base}/one-time-token/verify`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ token: ott }),
  }));
  if (!verifyRes.ok) throw new Error(`mintSessionCookie: one-time-token/verify failed (${verifyRes.status})`);
  const cookies = verifyRes.headers.getSetCookie?.() ?? [];
  const sessionCookie = cookies.find((c) => c.includes("session_token")) ?? cookies[0];
  if (!sessionCookie) throw new Error("mintSessionCookie: better-auth did not return a session cookie");
  return sessionCookie;
}
