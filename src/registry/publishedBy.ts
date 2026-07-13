// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
// src/registry/publishedBy.ts
//
// Resolve the VERIFIED publisher name for an account-bound publish: the caller's claimed HANDLE,
// or undefined for the local/trusted path (no session) and for a caller who has not claimed one.
// This lands in the git registry index's public discovery JSON (buildDiscovery), so it must be
// human-readable — it is attribution, NOT authorization. Publishing is gated separately, by
// accountOwnsScope(accountId, scope), which is uuid-keyed.
import { resolveSession } from "@agentgem/aggregator/webAuth";
import { handleForAccountId } from "@agentgem/aggregator/handles";
import type { makeAuth, AppDb } from "@agentgem/aggregator";

// Structural — the injected Express request only needs to expose its headers (better-auth reads
// its own cookie/bearer off them — see webAuth.ts resolveSession).
type HasHeaders = { headers: Record<string, string | undefined> };

export async function resolvePublishedBy(
  req: HasHeaders | undefined,
  auth: ReturnType<typeof makeAuth> | undefined,
  db: AppDb | undefined,
): Promise<string | undefined> {
  if (!req || !auth || !db) return undefined;                // local/trusted path — no session
  // Fail-closed: a transient error degrades to an un-attributed publish (undefined),
  // never a 500 — attribution is best-effort, not a gate on publishing.
  try {
    const who = await resolveSession(auth, req.headers);
    if (!who) return undefined;
    return (await handleForAccountId(db, who.accountId)) ?? undefined; // claimed handle, or undefined
  } catch {
    return undefined;
  }
}
