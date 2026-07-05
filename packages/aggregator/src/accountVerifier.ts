// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
// src/aggregator/accountVerifier.ts
// The provider seam: the only network dependency in the binding path. Tests inject a fake.
export interface VerifiedAccount { provider: string; accountId: string; login: string; avatarUrl?: string; }
export interface AccountVerifier { verify(token: string): Promise<VerifiedAccount>; }

export class GitHubVerifier implements AccountVerifier {
  constructor(private fetchImpl: typeof fetch = fetch) {}
  async verify(token: string): Promise<VerifiedAccount> {
    const res = await this.fetchImpl("https://api.github.com/user", {
      headers: { Authorization: `Bearer ${token}`, "User-Agent": "agentgem", Accept: "application/vnd.github+json" },
    });
    if (!res.ok) throw new Error(`github /user: ${res.status}`);
    const u = (await res.json()) as { id?: unknown; login?: unknown; avatar_url?: unknown };
    if (typeof u.id !== "number" || typeof u.login !== "string") throw new Error("github /user: unexpected shape");
    // accountId is the numeric id as text (stable across login renames); login is for display only.
    return { provider: "github", accountId: String(u.id), login: u.login, ...(typeof u.avatar_url === "string" ? { avatarUrl: u.avatar_url } : {}) };
  }
}

export interface OrgMembership { login: string; role: "admin" | "member" }

/**
 * GitHub org memberships (with role) for the token's user, via /user/memberships/orgs — unlike
 * /user/orgs it carries `role` (admin|member), which downstream ACL can gate on. Failure-tolerant
 * by design: any non-2xx, malformed, or thrown error yields [] so sign-in/bind never fails over it.
 * Both auth flows request `read:org`, so PRIVATE memberships are included; tokens granted before
 * that scope change (or restricted by an org's OAuth-app policy) degrade to public-only.
 */
export async function fetchOrgMemberships(token: string, fetchImpl: typeof fetch = fetch): Promise<OrgMembership[]> {
  try {
    const res = await fetchImpl("https://api.github.com/user/memberships/orgs?state=active&per_page=100", {
      headers: { Authorization: `Bearer ${token}`, "User-Agent": "agentgem", Accept: "application/vnd.github+json" },
    });
    if (!res.ok) return [];
    const body = (await res.json()) as unknown;
    if (!Array.isArray(body)) return [];
    return body
      .map((m) => {
        const login = (m as { organization?: { login?: unknown } })?.organization?.login;
        if (typeof login !== "string") return null;
        const role = (m as { role?: unknown }).role === "admin" ? "admin" as const : "member" as const;
        return { login, role };
      })
      .filter((m): m is OrgMembership => m !== null);
  } catch {
    return [];
  }
}
