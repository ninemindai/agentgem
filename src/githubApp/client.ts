// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
// src/githubApp/client.ts
// Server-to-server GitHub App client: RS256 app JWT (node:crypto — no JWT dependency), cached
// installation tokens, and the three list APIs sync needs. Hand-rolled fetch, matching the
// registryGithub/accountVerifier style. Installation tokens live ~1h; the cache refreshes 5min
// early and NEVER persists tokens.
import { createSign } from "node:crypto";

export interface AppConfig { appId: string; privateKey: string; webhookSecret: string }

/** All three secrets or nothing — a partial config is treated as unconfigured (dormant). */
export function appConfigFromEnv(env: NodeJS.ProcessEnv = process.env): AppConfig | null {
  const appId = env.GITHUB_APP_ID;
  const privateKey = env.GITHUB_APP_PRIVATE_KEY;
  const webhookSecret = env.GITHUB_APP_WEBHOOK_SECRET;
  return appId && privateKey && webhookSecret ? { appId, privateKey, webhookSecret } : null;
}

const b64url = (buf: Buffer): string => buf.toString("base64url");

/** 9-minute app JWT (GitHub max is 10; iat backdated 60s for clock skew). */
export function appJwt(cfg: { appId: string; privateKey: string }, nowSec: number = Math.floor(Date.now() / 1000)): string {
  const header = b64url(Buffer.from(JSON.stringify({ alg: "RS256", typ: "JWT" })));
  const payload = b64url(Buffer.from(JSON.stringify({ iat: nowSec - 60, exp: nowSec + 540, iss: cfg.appId })));
  const sig = createSign("RSA-SHA256").update(`${header}.${payload}`).sign(cfg.privateKey);
  return `${header}.${payload}.${b64url(sig)}`;
}

const ghHeaders = (bearer: string): Record<string, string> =>
  ({ Authorization: `Bearer ${bearer}`, Accept: "application/vnd.github+json", "User-Agent": "agentgem" });

export class InstallationTokens {
  private cache = new Map<number, { token: string; expiresAtMs: number }>();
  constructor(private cfg: { appId: string; privateKey: string }, private fetchImpl: typeof fetch = fetch) {}

  async tokenFor(installationId: number, now: number = Date.now()): Promise<string> {
    const hit = this.cache.get(installationId);
    if (hit && hit.expiresAtMs - 5 * 60_000 > now) return hit.token;
    const res = await this.fetchImpl(`https://api.github.com/app/installations/${installationId}/access_tokens`, {
      method: "POST", headers: ghHeaders(appJwt(this.cfg, Math.floor(now / 1000))),
    });
    if (!res.ok) throw new Error(`installation token ${installationId}: ${res.status}`);
    const j = (await res.json()) as { token?: unknown; expires_at?: unknown };
    if (typeof j.token !== "string") throw new Error("installation token: unexpected shape");
    const expiresAtMs = typeof j.expires_at === "string" ? new Date(j.expires_at).getTime() : now + 3_600_000;
    this.cache.set(installationId, { token: j.token, expiresAtMs });
    return j.token;
  }
}

/** Org installations of this App (User installs are out of scope). Paginated; login lowercased. */
export async function listAppInstallations(
  cfg: { appId: string; privateKey: string }, fetchImpl: typeof fetch = fetch,
): Promise<{ installationId: number; orgScope: string; repoSelection: "all" | "selected"; suspended: boolean }[]> {
  const out: { installationId: number; orgScope: string; repoSelection: "all" | "selected"; suspended: boolean }[] = [];
  for (let page = 1; page <= 10; page++) {
    const res = await fetchImpl(`https://api.github.com/app/installations?per_page=100&page=${page}`, { headers: ghHeaders(appJwt(cfg)) });
    if (!res.ok) throw new Error(`app/installations: ${res.status}`);
    const batch = (await res.json()) as { id?: unknown; account?: { login?: unknown; type?: unknown }; repository_selection?: unknown; suspended_at?: unknown }[];
    if (!Array.isArray(batch) || batch.length === 0) break;
    for (const i of batch) {
      if (typeof i.id !== "number" || i.account?.type !== "Organization" || typeof i.account.login !== "string") continue;
      out.push({
        installationId: i.id, orgScope: i.account.login.toLowerCase(),
        repoSelection: i.repository_selection === "all" ? "all" : "selected",
        suspended: i.suspended_at != null,
      });
    }
    if (batch.length < 100) break;
  }
  return out;
}

/** Full member list with roles: the admin page then the (non-admin) member page, both paginated.
 *  Includes PRIVATE members — that's the entire point of the App. Logins lowercased. */
export async function listOrgMembers(token: string, org: string, fetchImpl: typeof fetch = fetch): Promise<{ login: string; role: "admin" | "member" }[]> {
  const byLogin = new Map<string, "admin" | "member">();
  for (const role of ["admin", "member"] as const) {
    for (let page = 1; page <= 20; page++) {
      const res = await fetchImpl(`https://api.github.com/orgs/${encodeURIComponent(org)}/members?role=${role}&per_page=100&page=${page}`, { headers: ghHeaders(token) });
      if (!res.ok) throw new Error(`orgs/${org}/members: ${res.status}`);
      const batch = (await res.json()) as { login?: unknown }[];
      if (!Array.isArray(batch) || batch.length === 0) break;
      for (const m of batch) if (typeof m.login === "string" && !byLogin.has(m.login.toLowerCase())) byLogin.set(m.login.toLowerCase(), role);
      if (batch.length < 100) break;
    }
  }
  return [...byLogin].map(([login, role]) => ({ login, role }));
}

/** Repos this installation can see, with default branches (the only ref we ever index). */
export async function listInstallationRepos(token: string, fetchImpl: typeof fetch = fetch): Promise<{ repo: string; defaultBranch: string }[]> {
  const out: { repo: string; defaultBranch: string }[] = [];
  for (let page = 1; page <= 20; page++) {
    const res = await fetchImpl(`https://api.github.com/installation/repositories?per_page=100&page=${page}`, { headers: ghHeaders(token) });
    if (!res.ok) throw new Error(`installation/repositories: ${res.status}`);
    const j = (await res.json()) as { repositories?: { full_name?: unknown; default_branch?: unknown }[] };
    const repos = Array.isArray(j.repositories) ? j.repositories : [];
    for (const r of repos) {
      if (typeof r.full_name === "string") out.push({ repo: r.full_name, defaultBranch: typeof r.default_branch === "string" ? r.default_branch : "main" });
    }
    if (repos.length < 100) break;
  }
  return out;
}
