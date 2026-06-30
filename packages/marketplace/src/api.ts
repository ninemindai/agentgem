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
  };
}

export function defaultApiBase(): string {
  return (import.meta.env?.VITE_API_BASE as string | undefined) ?? "https://agentgem.onrender.com";
}
