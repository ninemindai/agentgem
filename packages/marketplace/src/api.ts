import type { AggIngredient, AggCoOccurrence, AdoptionPoint, RegistryGem, Profile, OrgCatalog,
  CuratedSource, SourceDivision, SourceAgentRef, ImportedSkill, PopularSkill } from "./types";

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
  return (import.meta.env?.VITE_API_BASE as string | undefined) ?? "https://agentgem.onrender.com";
}
