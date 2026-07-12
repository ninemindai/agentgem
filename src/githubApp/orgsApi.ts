// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
// src/githubApp/orgsApi.ts
// Member-gated org endpoints (raw express, the src/usage/install.ts pattern: Bearer ≡ session
// cookie, credentialed CORS for AGENTGEM_WEB_ORIGINS, originGuard-exempt via the /api/orgs prefix):
//   GET /api/orgs/app        — install + viewer-membership status (drives the marketplace UI).
//   GET /api/orgs/skills     — the org's private skill metadata (403 non-member).
//   GET /api/orgs/skill-body — on-demand body proxy via installation token. Bodies are never
//                              stored server-side (metadata-only custody); orgSkillExists pins
//                              (source,path) to THIS org before anything is fetched.
import type { AppDb, makeAuth } from "@agentgem/aggregator";
import { resolveSession, resolveOrgAccess, installationForScope, listOrgSkills, orgSkillExists } from "@agentgem/aggregator";
import { ghContents, decodeFile, assertSkillsPath, type Http, type GithubCfg } from "@agentgem/distribute";
import { defaultScopeTtlMs } from "../usage/install.js";
import type { InstallationTokens } from "./client.js";
import { cors, preflight, type Req, type Res, type ExpressApp } from "../publicCors.js";

export interface OrgsApiDeps { db: AppDb; auth: ReturnType<typeof makeAuth>; webOrigins: string[]; tokens: InstallationTokens | null; http: Http; scopeTtlMs?: number }

async function whoami(deps: OrgsApiDeps, req: Req): Promise<{ accountId: string; login: string } | null> {
  const who = await resolveSession(deps.auth, req.headers);
  return who ? { accountId: who.accountId, login: who.login } : null;
}
function scopeParam(req: Req): string | null {
  const scope = String((req.query.scope as string | undefined) ?? "").trim();
  return scope.length > 0 && scope.length <= 100 ? scope : null;
}

export function orgAppHandler(deps: OrgsApiDeps) {
  return async (req: Req, res: Res): Promise<void> => {
    cors(req, res, deps.webOrigins);
    if (req.method === "OPTIONS") { preflight(res, "GET, OPTIONS", "content-type, authorization"); return; }
    const scope = scopeParam(req);
    if (!scope) { res.status(400).json({ error: "invalid scope" }); return; }
    const inst = await installationForScope(deps.db, scope);
    const installed = !!inst && !inst.suspended;
    const who = await whoami(deps, req);
    const access = who ? await resolveOrgAccess(deps.db, who, scope, deps.scopeTtlMs ?? defaultScopeTtlMs()) : null;
    const isMember = access?.status === "ok";
    res.json({ installed, isMember, role: isMember ? access.role : null }); // no member-list leakage to outsiders
  };
}

/** Shared 401/403 gate for the two private reads. Returns the caller on success, null after responding. */
async function requireMember(deps: OrgsApiDeps, req: Req, res: Res, scope: string): Promise<{ accountId: string; login: string } | null> {
  const who = await whoami(deps, req);
  if (!who) { res.status(401).json({ error: "sign in required" }); return null; }
  const access = await resolveOrgAccess(deps.db, who, scope, deps.scopeTtlMs ?? defaultScopeTtlMs());
  if (access.status === "stale") { res.status(403).json({ error: "membership check expired — sign in again to refresh", reason: "stale" }); return null; }
  if (access.status !== "ok") { res.status(403).json({ error: "not a member of this org" }); return null; }
  return who;
}

export function orgSkillsHandler(deps: OrgsApiDeps) {
  return async (req: Req, res: Res): Promise<void> => {
    cors(req, res, deps.webOrigins);
    if (req.method === "OPTIONS") { preflight(res, "GET, OPTIONS", "content-type, authorization"); return; }
    const scope = scopeParam(req);
    if (!scope) { res.status(400).json({ error: "invalid scope" }); return; }
    if (!(await requireMember(deps, req, res, scope))) return;
    // Suspended behaves as uninstalled: rows persist in curated_skills until uninstall, but a
    // suspended installation must not keep serving private metadata (mirrors /api/orgs/app).
    const inst = await installationForScope(deps.db, scope);
    if (!inst || inst.suspended) { res.json({ scope: scope.toLowerCase(), skills: [] }); return; }
    res.json({ scope: scope.toLowerCase(), skills: await listOrgSkills(deps.db, scope) });
  };
}

export function orgSkillBodyHandler(deps: OrgsApiDeps) {
  return async (req: Req, res: Res): Promise<void> => {
    cors(req, res, deps.webOrigins);
    if (req.method === "OPTIONS") { preflight(res, "GET, OPTIONS", "content-type, authorization"); return; }
    const scope = scopeParam(req);
    const source = String((req.query.source as string | undefined) ?? "");
    const path = String((req.query.path as string | undefined) ?? "");
    if (!scope || !source.startsWith("org:")) { res.status(400).json({ error: "invalid scope or source" }); return; }
    try { assertSkillsPath(path); } catch { res.status(400).json({ error: "invalid path" }); return; }
    if (!(await requireMember(deps, req, res, scope))) return;
    // The (source, path) row must belong to THIS org — the cross-org read boundary.
    if (!(await orgSkillExists(deps.db, scope, source, path))) { res.status(404).json({ error: "unknown skill" }); return; }
    const inst = await installationForScope(deps.db, scope);
    if (!inst || inst.suspended) { res.status(404).json({ error: "no active installation" }); return; }
    if (!deps.tokens) { res.status(503).json({ error: "github app not configured" }); return; }
    try {
      const token = await deps.tokens.tokenFor(inst.installationId);
      const cfg: GithubCfg = { repo: source.slice("org:".length), ref: "HEAD", token }; // HEAD = default branch
      const node = await ghContents(deps.http, cfg, path);
      if (Array.isArray(node)) { res.status(404).json({ error: "unknown skill" }); return; }
      res.type("text/markdown; charset=utf-8").send(decodeFile(node));
    } catch (e) {
      // ghContents' error carries the full GitHub response body; keep it server-side only.
      console.error("orgs skill-body upstream fetch failed:", (e as Error).message);
      res.status(502).json({ error: "upstream fetch failed" });
    }
  };
}

export function installOrgsApi(expressApp: ExpressApp, deps: OrgsApiDeps): void {
  expressApp.get("/api/orgs/app", orgAppHandler(deps));
  expressApp.get("/api/orgs/skills", orgSkillsHandler(deps));
  expressApp.get("/api/orgs/skill-body", orgSkillBodyHandler(deps));
  expressApp.options("/api/orgs/app", orgAppHandler(deps));
  expressApp.options("/api/orgs/skills", orgSkillsHandler(deps));
  expressApp.options("/api/orgs/skill-body", orgSkillBodyHandler(deps));
}
