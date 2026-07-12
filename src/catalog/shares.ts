// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
// Owner-gated gem-share management (raw express, sibling of catalog/install.ts): reachable
// cross-site, own credentialed CORS, originGuard-exempt via the /api/catalog/ prefix. All routes
// authed (session → 401). Owner-gate is no-leak: a caller who does not own `key` gets 404, never a
// 403 that would confirm the gem exists. The only 403 is "you own the gem but are not in that group".
import type { AppDb, makeAuth } from "@agentgem/aggregator";
import { resolveSession, catalogGemForOwner, groupMemberRole, shareGemWithGroup, unshareGemFromGroup, listGroupsForGem } from "@agentgem/aggregator";

export interface SharesDeps { db: AppDb; auth: ReturnType<typeof makeAuth>; webOrigins: string[] }

interface Req { method: string; query: Record<string, unknown>; body: Record<string, unknown>; headers: Record<string, string | undefined> }
interface Res { status(c: number): Res; set(k: string, v: string): Res; json(b: unknown): Res; send(b: unknown): Res }
type ExpressApp = {
  get(p: string, h: (req: Req, res: Res) => unknown): unknown;
  post(p: string, h: (req: Req, res: Res) => unknown): unknown;
  delete(p: string, h: (req: Req, res: Res) => unknown): unknown;
  options(p: string, h: (req: Req, res: Res) => unknown): unknown;
};

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function cors(req: Req, res: Res, origins: string[]): void {
  const origin = req.headers["origin"];
  if (origin && origins.includes(origin)) {
    res.set("Access-Control-Allow-Origin", origin);
    res.set("Access-Control-Allow-Credentials", "true");
    res.set("Vary", "Origin");
  }
}
function preflight(res: Res): void {
  res.set("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS").set("Access-Control-Allow-Headers", "content-type").status(204).send("");
}

// Resolve the session and confirm the caller owns `key`. Returns the accountId, or null after
// having already sent the correct no-leak response (401 signed out, 400 bad key, 404 not owner).
async function requireGemOwner(deps: SharesDeps, req: Req, res: Res, key: string): Promise<string | null> {
  const who = await resolveSession(deps.auth, req.headers);
  if (!who) { res.status(401).json({ error: "sign in required" }); return null; }
  if (!key) { res.status(400).json({ error: "key required" }); return null; }
  const owned = await catalogGemForOwner(deps.db, key, who.accountId);
  if (!owned) { res.status(404).json({ error: "gem not found" }); return null; }
  return who.accountId;
}

export function shareGemHandler(deps: SharesDeps) {
  return async (req: Req, res: Res): Promise<void> => {
    cors(req, res, deps.webOrigins);
    if (req.method === "OPTIONS") { preflight(res); return; }

    if (req.method === "GET") {
      const key = String((req.query.key as string | undefined) ?? "");
      const accountId = await requireGemOwner(deps, req, res, key);
      if (!accountId) return;
      res.json({ shares: await listGroupsForGem(deps.db, key) });
      return;
    }

    if (req.method === "POST") {
      const key = String((req.body.key as string | undefined) ?? "");
      const groupId = String((req.body.groupId as string | undefined) ?? "");
      const accountId = await requireGemOwner(deps, req, res, key);
      if (!accountId) return;
      if (!UUID_RE.test(groupId)) { res.status(400).json({ error: "groupId must be a UUID" }); return; }
      // You can only share INTO a group you belong to.
      if (!(await groupMemberRole(deps.db, groupId, accountId))) { res.status(403).json({ error: "join the group first" }); return; }
      await shareGemWithGroup(deps.db, key, groupId, accountId);
      res.json({ shared: true });
      return;
    }

    if (req.method === "DELETE") {
      const key = String((req.query.key as string | undefined) ?? "");
      const groupId = String((req.query.groupId as string | undefined) ?? "");
      const accountId = await requireGemOwner(deps, req, res, key);
      if (!accountId) return;
      if (!UUID_RE.test(groupId)) { res.status(400).json({ error: "groupId must be a UUID" }); return; }
      res.json({ removed: await unshareGemFromGroup(deps.db, key, groupId) });
      return;
    }

    res.status(405).json({ error: "method not allowed" });
  };
}

export function installGemShares(app: ExpressApp, deps: SharesDeps): void {
  const h = shareGemHandler(deps);
  app.get("/api/catalog/gem-shares", h);
  app.post("/api/catalog/gem-shares", h);
  app.delete("/api/catalog/gem-shares", h);
  app.options("/api/catalog/gem-shares", h);
}
