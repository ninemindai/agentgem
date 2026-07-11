// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
// GET /api/account/providers — lists the providers linked to the caller's account (raw express,
// like handles/stars/reviews install.ts): reachable cross-site, own credentialed CORS.
//
// Descoped post-spike (Task 6): only this credentialed read ships. POST /api/account/absorb and
// the bespoke /api/account/connect/:provider/callback OAuth-exchange route are DEFERRED with Flow
// B — absorb has no server-verified pendingLink producer without the callback, so wiring it now
// would be dead, unreachable code. absorbAccount (Task 5) stays as tested backend logic for that
// follow-up.
import type { AppDb, makeAuth } from "@agentgem/aggregator";
import { resolveSession, connectedProviders } from "@agentgem/aggregator";

export interface AccountDeps { db: AppDb; auth: ReturnType<typeof makeAuth>; webOrigins: string[] }

interface Req { method: string; path: string; query: Record<string, unknown>; body: Record<string, unknown>; headers: Record<string, string | undefined> }
interface Res { status(c: number): Res; set(k: string, v: string): Res; json(b: unknown): Res; send(b: unknown): Res }
type ExpressApp = { get(p: string, h: (req: Req, res: Res) => unknown): unknown; options(p: string, h: (req: Req, res: Res) => unknown): unknown };

function cors(req: Req, res: Res, origins: string[]): void {
  const origin = req.headers["origin"];
  if (origin && origins.includes(origin)) {
    res.set("Access-Control-Allow-Origin", origin);
    res.set("Access-Control-Allow-Credentials", "true");
    res.set("Vary", "Origin");
  }
}
function preflight(res: Res): void {
  res.set("Access-Control-Allow-Methods", "GET, OPTIONS").set("Access-Control-Allow-Headers", "content-type").status(204).send("");
}

export function providersHandler(deps: AccountDeps) {
  return async (req: Req, res: Res): Promise<void> => {
    cors(req, res, deps.webOrigins);
    if (req.method === "OPTIONS") { preflight(res); return; }

    const who = await resolveSession(deps.auth, req.headers);
    if (!who) { res.status(401).json({ error: "sign in required" }); return; }

    res.json({ connected: await connectedProviders(deps.db, who.accountId) });
  };
}

export function installAccount(expressApp: ExpressApp, deps: AccountDeps): void {
  expressApp.get("/api/account/providers", providersHandler(deps));
  expressApp.options("/api/account/providers", providersHandler(deps));
}
