// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
// Catalog owner endpoints (raw express, like stars/reviews install.ts): reachable cross-site, own
// credentialed CORS, originGuard-exempt (its prefix is allowlisted in originGuard.ts). DELETE is authed
// (session cookie → 401) and owner-gated: the session's GitHub login must equal the gem's server-derived
// publishedBy (403 otherwise). CSRF on the write is stopped by the SameSite=Lax session cookie + the 401,
// NOT by CORS. Unpublish is a hard delete of the catalog row + archive bytes (visibility scope is a
// separate, later feature).
import type { AppDb, makeAuth } from "@agentgem/aggregator";
import { resolveSession, deleteCatalogGem } from "@agentgem/aggregator";

export interface CatalogDeps { db: AppDb; auth: ReturnType<typeof makeAuth>; webOrigins: string[] }

interface Req { method: string; path: string; query: Record<string, unknown>; headers: Record<string, string | undefined> }
interface Res { status(c: number): Res; set(k: string, v: string): Res; json(b: unknown): Res; send(b: unknown): Res }
type ExpressApp = { delete(p: string, h: (req: Req, res: Res) => unknown): unknown; options(p: string, h: (req: Req, res: Res) => unknown): unknown };

function cors(req: Req, res: Res, origins: string[]): void {
  const origin = req.headers["origin"];
  if (origin && origins.includes(origin)) {
    res.set("Access-Control-Allow-Origin", origin);
    res.set("Access-Control-Allow-Credentials", "true");
    res.set("Vary", "Origin");
  }
}
function preflight(res: Res): void {
  res.set("Access-Control-Allow-Methods", "DELETE, OPTIONS").set("Access-Control-Allow-Headers", "content-type").status(204).send("");
}
// The caller's verified GitHub login (not just accountId) — publishedBy is a login, so ownership is a
// login match.
async function sessionLogin(deps: CatalogDeps, req: Req): Promise<string | null> {
  const who = await resolveSession(deps.auth, req.headers);
  return who?.login ?? null;
}

export function unpublishHandler(deps: CatalogDeps) {
  return async (req: Req, res: Res): Promise<void> => {
    cors(req, res, deps.webOrigins);
    if (req.method === "OPTIONS") { preflight(res); return; }
    const login = await sessionLogin(deps, req);
    if (!login) { res.status(401).json({ error: "sign in required" }); return; }
    const key = String((req.query.key as string | undefined) ?? "");
    const version = String((req.query.version as string | undefined) ?? "");
    if (!key || !version) { res.status(400).json({ error: "key and version required" }); return; }
    const result = await deleteCatalogGem(deps.db, key, version, login);
    if (result === "not-found") { res.status(404).json({ error: "gem not found" }); return; }
    if (result === "forbidden") { res.status(403).json({ error: "not your gem" }); return; }
    res.json({ deleted: true, key, version });
  };
}

export function installCatalog(expressApp: ExpressApp, deps: CatalogDeps): void {
  expressApp.delete("/api/catalog/gem", unpublishHandler(deps));
  expressApp.options("/api/catalog/gem", unpublishHandler(deps));
}
