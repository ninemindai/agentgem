// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
// Stars endpoints (raw express, like auth/install.ts): reachable cross-site, own credentialed CORS,
// originGuard-exempt. POST /api/stars/toggle is authed (session → 401); GET /api/stars is a public
// count read + the caller's `mine` when a session cookie is present.
import type { AppDb, makeAuth } from "@agentgem/aggregator";
import { resolveSession, toggleStar, starCounts, starredIds } from "@agentgem/aggregator";
import { cors, preflight, type Req, type Res, type ExpressApp } from "../publicCors.js";

export interface StarsDeps { db: AppDb; auth: ReturnType<typeof makeAuth>; webOrigins: string[] }

const KINDS = new Set(["gem", "ingredient"]);

async function account(deps: StarsDeps, req: Req): Promise<string | null> {
  const who = await resolveSession(deps.auth, req.headers);
  return who?.accountId ?? null;
}

export function toggleHandler(deps: StarsDeps) {
  return async (req: Req, res: Res): Promise<void> => {
    cors(req, res, deps.webOrigins);
    if (req.method === "OPTIONS") { preflight(res, "GET, POST, OPTIONS"); return; }
    const accountId = await account(deps, req);
    if (!accountId) { res.status(401).json({ error: "sign in required" }); return; }
    const kind = String((req.body.kind as string | undefined) ?? "");
    const id = String((req.body.id as string | undefined) ?? "");
    if (!KINDS.has(kind) || id.length === 0 || id.length > 512) { res.status(400).json({ error: "invalid target" }); return; }
    res.json(await toggleStar(deps.db, accountId, kind, id));
  };
}

export function listHandler(deps: StarsDeps) {
  return async (req: Req, res: Res): Promise<void> => {
    cors(req, res, deps.webOrigins);
    if (req.method === "OPTIONS") { preflight(res, "GET, POST, OPTIONS"); return; }
    const kind = String((req.query.kind as string | undefined) ?? "");
    if (!KINDS.has(kind)) { res.status(400).json({ error: "invalid kind" }); return; }
    const ids = String((req.query.ids as string | undefined) ?? "").split(",").map((s) => s.trim()).filter(Boolean).slice(0, 100);
    const counts = await starCounts(deps.db, kind, ids);
    const accountId = await account(deps, req);
    const mine = accountId ? await starredIds(deps.db, accountId, kind, ids) : [];
    res.json({ counts, mine });
  };
}

export function installStars(expressApp: ExpressApp, deps: StarsDeps): void {
  expressApp.post("/api/stars/toggle", toggleHandler(deps));
  expressApp.get("/api/stars", listHandler(deps));
  expressApp.options("/api/stars/toggle", toggleHandler(deps));
  expressApp.options("/api/stars", listHandler(deps));
}
