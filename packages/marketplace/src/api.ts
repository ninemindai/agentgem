import type { AggIngredient, AggCoOccurrence, AggEffectiveness, AdoptionPoint, RegistryGem, Profile, OrgCatalog, OrgUsage, OrgUsageRange, OrgSettingsView,
  CuratedSource, SourceDivision, SourceAgentRef, ImportedSkill, PopularSkill, PopularSkillGroup, OrgAppStatus, OrgSkill } from "./types";

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

// The ONE querystring encoder: undefined params are dropped, everything else (incl. "" and 0)
// serializes. Callers that treat empty-string as absent pass undefined instead.
function buildQs(query: Query): string {
  const qs = Object.entries(query)
    .filter(([, v]) => v !== undefined)
    .map(([k, v]) => `${k}=${encodeURIComponent(String(v))}`)
    .join("&");
  return qs ? `?${qs}` : "";
}

async function get<T>(base: string, path: string, query: Query = {}): Promise<T> {
  const res = await fetch(base + path + buildQs(query));
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
    getEffectiveness: (q: { gemName?: string; sort?: "producers" | "score"; minConfidence?: number } = {}) =>
      get<AggEffectiveness[]>(base, "/api/aggregator/effectiveness", q),
    getAdoption: (q: { id: string; bucket?: "week" | "month" }) =>
      get<AdoptionPoint[]>(base, "/api/aggregator/adoption", q),
    getGems: () =>
      get<{ gems: RegistryGem[] }>(base, "/api/registry/gems").then((r) => r.gems),
    // Owner-only unpublish (hard delete) of a published gem. Credentialed so the parent-domain session
    // cookie travels; the server enforces ownership (login === publishedBy). Throws with the status so
    // the caller can distinguish 401 (signed out) / 403 (not owner) / other.
    unpublishGem: async (key: string, version: string): Promise<void> => {
      const res = await fetch(base + "/api/catalog/gem" + buildQs({ key, version }), { method: "DELETE", credentials: "include" });
      if (!res.ok) throw new Error(`unpublish -> ${res.status}`);
    },
    // Sealed HTML of a gem's game artifact (for the playable Minigames arcade). 404s a non-game gem.
    getGameHtml: (key: string, version: string) =>
      get<{ html: string }>(base, "/api/aggregator/game-html", { key, version }).then((r) => r.html),
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
    getOrgUsage: async (scope: string, range: OrgUsageRange, filters: { member?: string; agent?: string; model?: string } = {}): Promise<OrgUsageResult> => {
      // credentialed: the org dashboard is member-only, gated by the web session cookie.
      // Filters compose: member (drill-down), agent, model — all inside the org-scope boundary.
      const url = base + "/api/usage/org" + buildQs({
        scope, range,
        member: filters.member || undefined, agent: filters.agent || undefined, model: filters.model || undefined,
      });
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
    // Partial update: send only the fields being changed — the server keeps the rest, so
    // concurrent edits from two tabs can't clobber each other's untouched settings.
    putOrgSettings: async (scope: string, values: { retentionDays?: number | null; dashboardEnabled?: boolean }): Promise<OrgSettingsResult> => {
      const res = await fetch(base + "/api/usage/settings?scope=" + encodeURIComponent(scope), {
        method: "PUT", credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(values),
      });
      if (res.status === 401 || res.status === 403) return { status: "denied" };
      if (!res.ok) throw new Error(`/api/usage/settings -> ${res.status}`);
      return { status: "ok", settings: JSON.parse(await res.text()) as OrgSettingsView };
    },
    getOrgApp: async (scope: string): Promise<OrgAppStatus | null> => {
      try {
        const res = await fetch(base + "/api/orgs/app?scope=" + encodeURIComponent(scope), { credentials: "include" });
        return res.ok ? ((await res.json()) as OrgAppStatus) : null;
      } catch { return null; }
    },
    getOrgSkills: async (scope: string): Promise<OrgSkill[] | null> => {
      try {
        const res = await fetch(base + "/api/orgs/skills?scope=" + encodeURIComponent(scope), { credentials: "include" });
        if (!res.ok) return null;
        return ((await res.json()) as { skills: OrgSkill[] }).skills;
      } catch { return null; }
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
