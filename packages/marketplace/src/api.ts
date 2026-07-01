import type { AggIngredient, AggCoOccurrence, AdoptionPoint, RegistryGem } from "./types";

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
    getCoOccurrence: (q: { id: string; limit?: number }) =>
      get<AggCoOccurrence[]>(base, "/api/aggregator/co-occurrence", q),
    getAdoption: (q: { id: string; bucket?: "week" | "month" }) =>
      get<AdoptionPoint[]>(base, "/api/aggregator/adoption", q),
    getGems: () =>
      get<{ gems: RegistryGem[] }>(base, "/api/registry/gems").then((r) => r.gems),
    gemAdoption: (keys: string[]): Promise<Record<string, number>> =>
      keys.length === 0 ? Promise.resolve({}) :
      get<{ items: { gemKey: string; installs: number }[] }>(base, "/api/aggregator/gem-adoption", { keys: keys.join(",") })
        .then((r) => Object.fromEntries(r.items.map((i) => [i.gemKey, i.installs])))
        .catch(() => ({})),                       // adoption is best-effort; never breaks the page
  };
}

export function defaultApiBase(): string {
  return (import.meta.env?.VITE_API_BASE as string | undefined) ?? "https://agentgem.onrender.com";
}
