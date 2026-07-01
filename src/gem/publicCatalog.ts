// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
// Browse-only public gem catalog: flatten the registry index's discovery metadata and cache it.
import type { RegistryIndex } from "@agentgem/distribute";
import type { CatalogRow } from "@agentgem/aggregator";

export interface RegistryGem {
  key: string;
  version: string;
  author?: string;
  description?: string;
  tags?: string[];
  artifactKinds?: string[];
  type?: string;
  publishedBy?: string;
  grade?: number;
  installable: boolean;
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
    type: item.discovery?.type,
    publishedBy: item.discovery?.publishedBy,
    grade: item.discovery?.grade,
    installable: true,
  }));
}

/** DB-shared gems are browse-only teasers, never installable. */
export function mapDbToGems(rows: CatalogRow[]): RegistryGem[] {
  return rows.map((r) => ({
    key: r.gemKey, version: r.version, author: r.author, description: r.description,
    tags: r.tags, artifactKinds: r.artifactKinds, type: r.type, publishedBy: r.publishedBy,
    grade: r.grade, installable: false,
  }));
}

/** Union both sources; DB (freshly shared) wins on key collision. */
export function mergeGems(dbGems: RegistryGem[], indexGems: RegistryGem[]): RegistryGem[] {
  const byKey = new Map<string, RegistryGem>();
  for (const g of indexGems) byKey.set(g.key, g);
  for (const g of dbGems) byKey.set(g.key, g); // DB overwrites
  return [...byKey.values()];
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
