// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
// src/registry/publishedBy.ts
//
// Resolve the VERIFIED publisher identity for an account-bound publish: the GitHub
// login of the M2-A web session carried on the request, or undefined for the
// local/trusted path (no session — your own machine/server token). The login is
// server-derived (never caller-supplied), so it can't be spoofed like `scope`.
import { parseCookies, SESSION_COOKIE } from "../auth/cookie.js";
import { resolveSession, type AppDb } from "@agentgem/aggregator";

// Structural — the injected Express request only needs to expose its cookie header.
type HasCookies = { headers: { cookie?: string } };

export async function resolvePublishedBy(req: HasCookies | undefined, db: AppDb | undefined): Promise<string | undefined> {
  if (!req || !db) return undefined;                       // local/trusted path — no session
  const token = parseCookies(req.headers.cookie)[SESSION_COOKIE];
  if (!token) return undefined;
  // Fail-closed: a transient DB error degrades to an un-attributed publish (undefined),
  // never a 500 — attribution is best-effort, not a gate on publishing.
  try {
    const who = await resolveSession(db, token);
    return who?.login;                                     // verified GitHub login, or undefined
  } catch {
    return undefined;
  }
}
