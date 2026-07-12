// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
import { createAuthClient } from "better-auth/client";
import { passkeyClient } from "@better-auth/passkey/client";

/** Passkey-only better-auth client. Social sign-in and session reads stay on the hand-rolled fetch
 *  client in auth.ts; this exists solely to run the WebAuthn ceremony correctly (base64url<->
 *  ArrayBuffer, navigator.credentials), which is error-prone to hand-roll. baseURL is the API origin;
 *  better-auth appends its default "/api/auth" base path. credentials:"include" so the cross-subdomain
 *  session cookie travels, matching auth.ts. Pure factory (no module-scoped cache) — callers that
 *  re-render memoize with useMemo (see Account.tsx). */
export function makePasskeyAuth(base: string) {
  return createAuthClient({
    baseURL: base,
    plugins: [passkeyClient()],
    fetchOptions: { credentials: "include" },
  });
}

/** True when the browser can do WebAuthn at all. Gates every "Use a passkey" affordance. */
export function passkeySupported(): boolean {
  return typeof window !== "undefined" && typeof window.PublicKeyCredential !== "undefined";
}

/** Extract a readable message from a better-auth client `{ error }` value, a thrown Error, or a
 *  thrown string; falls back to a caller-supplied default. Both the sign-in and passkey-management
 *  flows use this so error text is handled one way. */
export function passkeyErrorMessage(e: unknown, fallback = "Something went wrong"): string {
  if (typeof e === "string") return e;
  if (e && typeof e === "object" && "message" in e && typeof (e as { message: unknown }).message === "string") {
    return (e as { message: string }).message;
  }
  return fallback;
}
