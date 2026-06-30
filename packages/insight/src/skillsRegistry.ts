// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
//
// Client for skills.sh's UNDOCUMENTED, unauthenticated search endpoint — the same
// one the `skills` CLI itself calls (the documented /api/v1/* API is OIDC-walled).
// Because it is undocumented it may change without notice, so every failure path
// resolves to [] and never throws. Isolated here so other registries can be added
// (or this one swapped) without touching callers — the "aggregator above registries"
// design (see docs/.../local-control-plane strategy).

const DEFAULT_BASE = "https://skills.sh";

export interface RegistrySkill {
  id: string;       // "owner/repo/skillId"
  skillId: string;  // canonical slug used by `npx skills add owner/repo@skillId`
  name: string;     // display name (usually === skillId)
  source: string;   // "owner/repo"
  installs?: number; // registry-reported, not an endorsement
}

function asString(v: unknown): string { return typeof v === "string" ? v : ""; }

export async function searchSkills(
  query: string,
  opts: { owner?: string; limit?: number; base?: string; fetchImpl?: typeof fetch } = {},
): Promise<RegistrySkill[]> {
  const f = opts.fetchImpl ?? fetch;
  const params = new URLSearchParams({ q: query, limit: String(opts.limit ?? 10) });
  if (opts.owner) params.set("owner", opts.owner);
  const url = `${opts.base ?? DEFAULT_BASE}/api/search?${params.toString()}`;
  try {
    const res = await f(url);
    if (!res.ok) return [];
    const body = (await res.json()) as { skills?: unknown };
    if (!Array.isArray(body?.skills)) return [];
    const rows: RegistrySkill[] = [];
    for (const r of body.skills as Array<Record<string, unknown>>) {
      const name = asString(r?.name);
      const source = asString(r?.source);
      if (!name || !source) continue;
      const installs = typeof r?.installs === "number" ? r.installs : undefined;
      rows.push({ id: asString(r?.id), skillId: asString(r?.skillId) || name, name, source, installs });
    }
    return rows.sort((a, b) => (b.installs ?? 0) - (a.installs ?? 0));
  } catch {
    return [];
  }
}
