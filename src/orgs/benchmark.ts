// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
// src/orgs/benchmark.ts
// Admin-gated org-scoped benchmark view (raw express, the src/usage/install.ts +
// src/githubApp/orgsApi.ts pattern: Bearer ≡ session cookie, credentialed CORS for
// AGENTGEM_WEB_ORIGINS, originGuard-exempt via the /api/orgs prefix):
//   GET /api/orgs/:scope/benchmark — the org's model benchmark + gem effectiveness + per-member
//                                     breakdown (packages/aggregator/src/orgBenchmark.ts),
//                                     de-anonymized within the org's trust boundary. Admin only —
//                                     stricter than the member-gated reads in orgsApi.ts.
import type { AppDb, makeAuth } from "@agentgem/aggregator";
import { resolveSession, resolveOrgAccess, orgModelBenchmark, orgEffectiveness, orgMemberBreakdown } from "@agentgem/aggregator";
import { defaultScopeTtlMs } from "../usage/install.js";
import { cors, preflight, type Req, type Res, type ExpressApp } from "../publicCors.js";

export interface OrgBenchmarkDeps { db: AppDb; auth: ReturnType<typeof makeAuth>; webOrigins: string[]; scopeTtlMs?: number }

async function whoami(deps: OrgBenchmarkDeps, req: Req): Promise<{ accountId: string; login: string } | null> {
  const who = await resolveSession(deps.auth, req.headers);
  return who ? { accountId: who.accountId, login: who.login } : null;
}

export function orgBenchmarkHandler(deps: OrgBenchmarkDeps) {
  return async (req: Req, res: Res): Promise<void> => {
    cors(req, res, deps.webOrigins);
    if (req.method === "OPTIONS") { preflight(res, "GET, OPTIONS", "content-type, authorization"); return; }
    const who = await whoami(deps, req);
    if (!who) { res.status(401).json({ error: "sign in required" }); return; }
    const scope = String(req.params?.scope ?? "").trim();
    if (!scope || scope.length > 100) { res.status(400).json({ error: "invalid scope" }); return; }
    const access = await resolveOrgAccess(deps.db, who, scope, deps.scopeTtlMs ?? defaultScopeTtlMs());
    if (access.status === "none") { res.status(403).json({ error: "not a member of this org", reason: "not-member" }); return; }
    if (access.status === "stale") { res.status(403).json({ error: "membership check expired — sign in again to refresh", reason: "stale" }); return; }
    if (access.role !== "admin") { res.status(403).json({ error: "admins only", reason: "not-admin" }); return; }
    const [modelBenchmark, effectiveness, members] = await Promise.all([
      orgModelBenchmark(deps.db, scope),
      orgEffectiveness(deps.db, scope),
      orgMemberBreakdown(deps.db, scope),
    ]);
    res.json({ scope: scope.toLowerCase(), modelBenchmark, effectiveness, members });
  };
}

export function installOrgBenchmark(expressApp: ExpressApp, deps: OrgBenchmarkDeps): void {
  expressApp.get("/api/orgs/:scope/benchmark", orgBenchmarkHandler(deps));
  expressApp.options("/api/orgs/:scope/benchmark", orgBenchmarkHandler(deps));
}
