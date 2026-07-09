// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
// src/registry/publishedBy.ts
//
// Resolve the VERIFIED publisher identity for an account-bound publish: the GitHub
// login of the M2-A web session carried on the request, or undefined for the
// local/trusted path (no session — your own machine/server token). The login is
// server-derived (never caller-supplied), so it can't be spoofed like `scope`.
import { resolveSession, type makeAuth } from "@agentgem/aggregator";

// Structural — the injected Express request only needs to expose its headers (better-auth reads
// its own cookie/bearer off them — see webAuth.ts resolveSession).
type HasHeaders = { headers: Record<string, string | undefined> };

export async function resolvePublishedBy(req: HasHeaders | undefined, auth: ReturnType<typeof makeAuth> | undefined): Promise<string | undefined> {
  if (!req || !auth) return undefined;                      // local/trusted path — no session
  // Fail-closed: a transient error degrades to an un-attributed publish (undefined),
  // never a 500 — attribution is best-effort, not a gate on publishing.
  try {
    const who = await resolveSession(auth, req.headers);
    return who?.login;                                     // verified GitHub login, or undefined
  } catch {
    return undefined;
  }
}
