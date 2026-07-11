// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
// GET /api/account/providers — lists the providers linked to the caller's account, and POST
// /api/account/absorb — the Flow B consumer side: reads the server-stashed pendingLink (produced by
// Task 2's connect callback), resolves the other account, and runs absorbAccount. Both are raw
// express, like handles/stars/reviews install.ts: reachable cross-site, own credentialed CORS.
import { sql } from "drizzle-orm";
import type { AppDb, makeAuth } from "@agentgem/aggregator";
import { resolveSession, connectedProviders, pendingLink, accountIdForProvider, absorbAccount, mintSessionCookie } from "@agentgem/aggregator";

export interface AccountDeps { db: AppDb; auth: ReturnType<typeof makeAuth>; webOrigins: string[] }

interface Req { method: string; path: string; query: Record<string, unknown>; body: Record<string, unknown>; headers: Record<string, string | undefined> }
interface Res { status(c: number): Res; set(k: string, v: string): Res; json(b: unknown): Res; send(b: unknown): Res }
type ExpressApp = {
  get(p: string, h: (req: Req, res: Res) => unknown): unknown;
  post(p: string, h: (req: Req, res: Res) => unknown): unknown;
  options(p: string, h: (req: Req, res: Res) => unknown): unknown;
};

function cors(req: Req, res: Res, origins: string[]): void {
  const origin = req.headers["origin"];
  if (origin && origins.includes(origin)) {
    res.set("Access-Control-Allow-Origin", origin);
    res.set("Access-Control-Allow-Credentials", "true");
    res.set("Vary", "Origin");
  }
}
function preflight(res: Res): void {
  res.set("Access-Control-Allow-Methods", "GET, POST, OPTIONS").set("Access-Control-Allow-Headers", "content-type").status(204).send("");
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

export function absorbHandler(deps: AccountDeps) {
  return async (req: Req, res: Res): Promise<void> => {
    cors(req, res, deps.webOrigins);
    if (req.method === "OPTIONS") { preflight(res); return; }
    const who = await resolveSession(deps.auth, req.headers);
    if (!who) { res.status(401).json({ error: "sign in required" }); return; }
    // `other` comes ONLY from the server-verified pending link for THIS session — never req.body.
    const pending = await pendingLink(deps.db, who.accountId);
    if (!pending) { res.status(409).json({ error: "no provider awaiting connection" }); return; }
    const other = await accountIdForProvider(deps.db, pending.providerId, pending.providerAccountId);
    if (!other) { res.status(409).json({ error: "no provider awaiting connection" }); return; }
    const r = await absorbAccount(deps.db, { current: who.accountId, other });
    if (!r.ok) {
      res.status(409).json({ error: "Both accounts have activity on AgentGem. Merging accounts with existing gems or a claimed handle isn't supported yet." });
      return;
    }
    if (r.keep !== who.accountId) {
      res.set("Set-Cookie", await mintSessionCookie(deps.auth, r.keep));   // caller's fresh acct was dropped
    } else {
      // Caller's own account survived, so its pending-link row isn't cascade-deleted by absorbAccount
      // (that only fires for the DROPPED user's row) — consume it explicitly now that it's been acted on.
      await deps.db.execute(sql`delete from pending_account_links where session_user_id = ${who.accountId}`);
    }
    res.json({ keep: r.keep, connected: await connectedProviders(deps.db, r.keep) });
  };
}

export function installAccount(expressApp: ExpressApp, deps: AccountDeps): void {
  expressApp.get("/api/account/providers", providersHandler(deps));
  expressApp.options("/api/account/providers", providersHandler(deps));
  expressApp.post("/api/account/absorb", absorbHandler(deps));
  expressApp.options("/api/account/absorb", absorbHandler(deps));
}
