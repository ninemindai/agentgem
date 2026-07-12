// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT

/** The WebAuthn Relying Party ID for the passkey plugin. A passkey created on app.agentgem.ai must
 *  use an RP ID that is a registrable suffix of that origin, so the api.agentgem.ai baseURL default
 *  would fail verification. We derive it from the cross-subdomain cookie domain already configured
 *  (agentgem.ai), or fall back to localhost in dev. An explicit AGENTGEM_PASSKEY_RP_ID always wins. */
export function deriveRpId(explicit: string | undefined, cookieDomain: string | undefined): string {
  if (explicit) return explicit;
  if (cookieDomain) return cookieDomain.replace(/^\./, "");
  return "localhost";
}
