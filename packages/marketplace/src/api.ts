import type { AggIngredient, AggCoOccurrence, AdoptionPoint, RegistryGem, Profile, OrgCatalog, OrgUsage, OrgUsageRange, OrgSettingsView,
  CuratedSource, SourceDivision, SourceAgentRef, ImportedSkill, PopularSkill, PopularSkillGroup } from "./types";

/** The team-usage read is auth-gated: the caller distinguishes "sign in" from "not a member"
 *  from "member, but the GitHub-org capture aged out" (stale → offer a one-click refresh). */
export type OrgUsageResult =
  | { status: "ok"; usage: OrgUsage }
  | { status: "unauthenticated" }
  | { status: "forbidden" }
  | { status: "stale" }
  | { status: "disabled" };

export type OrgSettingsResult =
  | { status: "ok"; settings: OrgSettingsView }
  | { status: "denied" };

type Query = Record<string, string | number | undefined>;

async function get<T>(base: string, path: string, query: Query = {}): Promise<T> {
  const qs = Object.entries(query)
    .filter(([, v]) => v !== undefined)
    .map(([k, v]) => `${k}=${encodeURIComponent(String(v))}`)
    .join("&");
  const res = await fetch(base + path + (qs ? `?${qs}` : ""));
  if (!res.ok) throw new Error(`${path} -> ${res.status}`);
  return JSON.parse(await res.text()) as T;
}

export function makeApi(base: string) {
  return {
    getPopularity: (q: { kind?: string; limit?: number } = {}) =>
      get<AggIngredient[]>(base, "/api/aggregator/popularity", q),
    getPopularSkills: (limit?: number) =>
      get<{ skills: PopularSkill[] }>(base, "/api/aggregator/popular-skills", limit ? { limit } : {}).then((r) => r.skills),
    getPopularSkillGroups: (sources = 12, perSource = 6) =>
      get<{ groups: PopularSkillGroup[] }>(base, "/api/aggregator/popular-skills", { sources, perSource }).then((r) => r.groups),
    getCoOccurrence: (q: { id: string; limit?: number }) =>
      get<AggCoOccurrence[]>(base, "/api/aggregator/co-occurrence", q),
    getAdoption: (q: { id: string; bucket?: "week" | "month" }) =>
      get<AdoptionPoint[]>(base, "/api/aggregator/adoption", q),
    getGems: () =>
      get<{ gems: RegistryGem[] }>(base, "/api/registry/gems").then((r) => r.gems),
    gemAdoption: (keys: string[]): Promise<Record<string, { installs: number; verifiedInstalls: number }>> =>
      keys.length === 0 ? Promise.resolve({}) :
      get<{ items: { gemKey: string; installs: number; verifiedInstalls: number }[] }>(base, "/api/aggregator/gem-adoption", { keys: keys.join(",") })
        .then((r) => Object.fromEntries(r.items.map((i) => [i.gemKey, { installs: i.installs, verifiedInstalls: i.verifiedInstalls }])))
        .catch(() => ({})),                       // adoption is best-effort; never breaks the page
    getProfile: async (login: string): Promise<Profile | null> => {
      const res = await fetch(base + "/api/aggregator/profile?login=" + encodeURIComponent(login));
      if (res.status === 404) return null;
      if (!res.ok) throw new Error(`/api/aggregator/profile -> ${res.status}`);
      return JSON.parse(await res.text()) as Profile;
    },
    getOrgCatalog: async (scope: string): Promise<OrgCatalog | null> => {
      const res = await fetch(base + "/api/aggregator/org-catalog?scope=" + encodeURIComponent(scope));
      if (res.status === 400 || res.status === 404) return null;
      if (!res.ok) throw new Error(`/api/aggregator/org-catalog -> ${res.status}`);
      return JSON.parse(await res.text()) as OrgCatalog;
    },
    getOrgUsage: async (scope: string, range: OrgUsageRange, member?: string): Promise<OrgUsageResult> => {
      // credentialed: the org dashboard is member-only, gated by the web session cookie.
      // `member` narrows to one member's org-attributed usage (the drill-down).
      const url = base + "/api/usage/org?scope=" + encodeURIComponent(scope) + "&range=" + range
        + (member ? "&member=" + encodeURIComponent(member) : "");
      const res = await fetch(url, { credentials: "include" });
      if (res.status === 401) return { status: "unauthenticated" };
      if (res.status === 403) {
        const body = await res.json().catch(() => ({})) as { reason?: string };
        if (body.reason === "stale") return { status: "stale" };
        if (body.reason === "disabled") return { status: "disabled" };
        return { status: "forbidden" };
      }
      if (!res.ok) throw new Error(`/api/usage/org -> ${res.status}`);
      return { status: "ok", usage: JSON.parse(await res.text()) as OrgUsage };
    },
    getOrgSettings: async (scope: string): Promise<OrgSettingsResult> => {
      const res = await fetch(base + "/api/usage/settings?scope=" + encodeURIComponent(scope), { credentials: "include" });
      if (res.status === 401 || res.status === 403) return { status: "denied" };
      if (!res.ok) throw new Error(`/api/usage/settings -> ${res.status}`);
      return { status: "ok", settings: JSON.parse(await res.text()) as OrgSettingsView };
    },
    putOrgSettings: async (scope: string, values: { retentionDays: number | null; dashboardEnabled: boolean }): Promise<OrgSettingsResult> => {
      const res = await fetch(base + "/api/usage/settings?scope=" + encodeURIComponent(scope), {
        method: "PUT", credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(values),
      });
      if (res.status === 401 || res.status === 403) return { status: "denied" };
      if (!res.ok) throw new Error(`/api/usage/settings -> ${res.status}`);
      return { status: "ok", settings: JSON.parse(await res.text()) as OrgSettingsView };
    },
    getSources: () =>
      get<{ sources: CuratedSource[] }>(base, "/api/sources").then((r) => r.sources),
    getSourceDivisions: (source: string) =>
      get<{ divisions: SourceDivision[] }>(base, "/api/sources/divisions", { source }).then((r) => r.divisions),
    getSourceAgents: (source: string, division: string) =>
      get<{ agents: SourceAgentRef[] }>(base, "/api/sources/agents", { source, division }).then((r) => r.agents),
    importSourceSkill: (source: string, path: string) =>
      get<ImportedSkill>(base, "/api/sources/import", { source, path }),
  };
}

export function defaultApiBase(): string {
  // Fallback must be the API's custom domain: the GitHub OAuth app + session cookies are
  // registered against api.agentgem.ai, so auth via the raw onrender.com host fails.
  return (import.meta.env?.VITE_API_BASE as string | undefined) ?? "https://api.agentgem.ai";
}
