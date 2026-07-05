// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
// Team usage endpoints (raw express, like stars/install.ts): reachable cross-site, own credentialed
// CORS, originGuard-exempt via the /api/usage prefix. Both are authed (session → 401):
//   POST /api/usage/report — the local agentgem process pushes daily rollups (Bearer session).
//   GET  /api/usage/org    — the org dashboard read; 403 unless the caller's captured scopes
//                            (account_scopes, from GitHub org membership at sign-in) include it.
import type { AppDb } from "@agentgem/aggregator";
import { resolveSession, accountOwnsScope, normalizeUsageReport, recordUsageDays, buildOrgUsage, RANGE_DAYS, type OrgUsageRange } from "@agentgem/aggregator";
import { SESSION_COOKIE, parseCookies } from "../auth/cookie.js";

export interface UsageDeps { db: AppDb; webOrigins: string[] }

interface Req { method: string; path: string; query: Record<string, unknown>; body: Record<string, unknown>; headers: Record<string, string | undefined>; get(n: string): string | undefined }
interface Res { status(c: number): Res; set(k: string, v: string): Res; setHeader(k: string, v: string): Res; json(b: unknown): Res; send(b: unknown): Res }
type ExpressApp = { get(p: string, h: (req: Req, res: Res) => unknown): unknown; post(p: string, h: (req: Req, res: Res) => unknown): unknown; options(p: string, h: (req: Req, res: Res) => unknown): unknown };

function cors(req: Req, res: Res, origins: string[]): void {
  const origin = req.headers["origin"];
  if (origin && origins.includes(origin)) {
    res.set("Access-Control-Allow-Origin", origin);
    res.set("Access-Control-Allow-Credentials", "true");
    res.set("Vary", "Origin");
  }
}
function preflight(res: Res): void {
  res.set("Access-Control-Allow-Methods", "GET, POST, OPTIONS").set("Access-Control-Allow-Headers", "content-type, authorization").status(204).send("");
}

/** Session from `Authorization: Bearer <token>` (local process) OR the web session cookie. */
async function whoami(deps: UsageDeps, req: Req): Promise<{ accountId: string; login: string } | null> {
  const auth = req.headers["authorization"];
  const bearer = auth && /^Bearer\s+/i.test(auth) ? auth.replace(/^Bearer\s+/i, "").trim() : "";
  const token = bearer || parseCookies(req.headers["cookie"])[SESSION_COOKIE];
  const who = token ? await resolveSession(deps.db, token) : null;
  return who ? { accountId: who.accountId, login: who.login } : null;
}

export function reportHandler(deps: UsageDeps) {
  return async (req: Req, res: Res): Promise<void> => {
    cors(req, res, deps.webOrigins);
    if (req.method === "OPTIONS") { preflight(res); return; }
    const who = await whoami(deps, req);
    if (!who) { res.status(401).json({ error: "sign in required" }); return; }
    const report = normalizeUsageReport(req.body ?? {});
    if (!report) { res.status(400).json({ error: "invalid report" }); return; }
    res.json(await recordUsageDays(deps.db, who.accountId, report.machine, report.days));
  };
}

export function orgUsageHandler(deps: UsageDeps) {
  return async (req: Req, res: Res): Promise<void> => {
    cors(req, res, deps.webOrigins);
    if (req.method === "OPTIONS") { preflight(res); return; }
    const who = await whoami(deps, req);
    if (!who) { res.status(401).json({ error: "sign in required" }); return; }
    const scope = String((req.query.scope as string | undefined) ?? "").trim();
    const range = String((req.query.range as string | undefined) ?? "7d");
    if (scope.length === 0 || scope.length > 100 || !(range in RANGE_DAYS)) { res.status(400).json({ error: "invalid scope or range" }); return; }
    // Internal dashboard: the caller must be a member of the org (captured at sign-in). Their own
    // login scope always exists, so /api/usage/org?scope=<their-login> doubles as a personal view.
    if (!(await accountOwnsScope(deps.db, who.accountId, scope))) { res.status(403).json({ error: "not a member of this org" }); return; }
    res.json(await buildOrgUsage(deps.db, scope, range as OrgUsageRange));
  };
}

export function installUsage(expressApp: ExpressApp, deps: UsageDeps): void {
  expressApp.post("/api/usage/report", reportHandler(deps));
  expressApp.get("/api/usage/org", orgUsageHandler(deps));
  expressApp.options("/api/usage/report", reportHandler(deps));
  expressApp.options("/api/usage/org", orgUsageHandler(deps));
}
