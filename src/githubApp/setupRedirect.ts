// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
// src/githubApp/setupRedirect.ts
// GET /api/github/setup — the GitHub App's post-install Setup URL. GitHub appends
// ?installation_id=N&setup_action=install but never substitutes the org name, so a static Setup
// URL strands the admin on the marketplace home. This handler resolves the installation to its
// org via the app JWT (GET /app/installations/{id} — answers only for OUR app's installations)
// and 302s to the org's catalog page. Every failure path (dormant config, unknown/user-type
// install, GitHub error, garbage id) degrades to the marketplace home — a redirect must never
// error in the installing admin's face.
import { appJwt, type AppConfig } from "./client.js";

const APP_BASE = "https://app.agentgem.ai";

export interface SetupRedirectDeps { cfg: AppConfig | null; fetchImpl?: typeof fetch }

interface Req { query: Record<string, unknown> }
interface Res { redirect(code: number, url: string): unknown }

export function setupRedirectHandler(deps: SetupRedirectDeps) {
  return async (req: Req, res: Res): Promise<void> => {
    const fetchImpl = deps.fetchImpl ?? fetch;
    const raw = String((req.query.installation_id as string | undefined) ?? "");
    const home = `${APP_BASE}/`;
    if (!deps.cfg || !/^\d{1,15}$/.test(raw)) { res.redirect(302, home); return; }
    try {
      const r = await fetchImpl(`https://api.github.com/app/installations/${raw}`, {
        headers: { Authorization: `Bearer ${appJwt(deps.cfg)}`, Accept: "application/vnd.github+json", "User-Agent": "agentgem" },
      });
      if (!r.ok) { res.redirect(302, home); return; }
      const j = (await r.json()) as { account?: { login?: unknown; type?: unknown } };
      if (j.account?.type !== "Organization" || typeof j.account.login !== "string") { res.redirect(302, home); return; }
      res.redirect(302, `${APP_BASE}/orgs/${encodeURIComponent(j.account.login.toLowerCase())}?installed=1`);
    } catch {
      res.redirect(302, home);
    }
  };
}

export function installGithubSetup(expressApp: { get(p: string, h: unknown): unknown }, deps: SetupRedirectDeps): void {
  expressApp.get("/api/github/setup", setupRedirectHandler(deps));
}
