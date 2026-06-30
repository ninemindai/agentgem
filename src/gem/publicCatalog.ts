// Copyright NineMind, Inc. 2026. All Rights Reserved.
// Browse-only public gem catalog: flatten the registry index's discovery metadata and cache it.
import type { RegistryIndex } from "./registry.js";

export interface RegistryGem {
  key: string;
  version: string;
  author?: string;
  description?: string;
  tags?: string[];
  artifactKinds?: string[];
}

/** Flatten the index's per-item discovery block into a browse list. No ingredients (browse-only). */
export function mapIndexToGems(index: RegistryIndex): RegistryGem[] {
  return Object.entries(index.items).map(([key, item]) => ({
    key,
    version: item.latest,
    author: item.discovery?.author,
    description: item.discovery?.description,
    tags: item.discovery?.tags,
    artifactKinds: item.discovery?.artifactKinds,
  }));
}

export interface GemCache {
  get(getIndex: (() => Promise<RegistryIndex>) | null, now: number): Promise<RegistryGem[]>;
}

/** TTL cache over the (network) index fetch. Graceful: a null source or a thrown fetch yields [].
 *  One fetch per TTL window across all callers — the GitHub-rate-limit protection. */
export function createGemCache(ttlMs: number): GemCache {
  let entry: { at: number; gems: RegistryGem[] } | null = null;
  return {
    async get(getIndex, now) {
      if (!getIndex) return []; // unconfigured → empty, regardless of any stale cache
      if (entry && now - entry.at < ttlMs) return entry.gems;
      try {
        const gems = mapIndexToGems(await getIndex());
        entry = { at: now, gems };
        return gems;
      } catch {
        return []; // never poison the cache or 500 the public path
      }
    },
  };
}
