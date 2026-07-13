// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
// Browse-only public gem catalog: flatten the registry index's discovery metadata and cache it.
import type { RegistryIndex } from "@agentgem/distribute";
import { type CatalogRow, clampGrade } from "@agentgem/aggregator/catalog";
import { createLogger } from "@agentgem/base";

const log = createLogger("catalog");

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
  artifacts?: { name: string; type: string }[];
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

/** DB-shared gems: installable when their .gem archive was uploaded (row.installable, derived from
 *  the gem_archives join), and they carry the per-artifact preview list. Grade is re-clamped
 *  defensively: writes already clamp (recordCatalogShare), but an out-of-band DB row with an
 *  out-of-range grade must not reach the response schema's min(1).max(3) and 500 the public catalog. */
export function mapDbToGems(rows: CatalogRow[]): RegistryGem[] {
  return rows.map((r) => ({
    key: r.gemKey, version: r.version, author: r.author, description: r.description,
    tags: r.tags, artifactKinds: r.artifactKinds, type: r.type, publishedBy: r.publishedBy,
    grade: clampGrade(r.grade), installable: r.installable ?? false, artifacts: r.artifacts,
  }));
}

/** DB-shared gems for the public browse path. Graceful: any read error yields [] so /registry/gems never 500s. */
export async function safeDbGems(list: () => Promise<CatalogRow[]>): Promise<RegistryGem[]> {
  try {
    return mapDbToGems(await list());
  } catch (err) {
    log.warn("safeDbGems read failed (empty list): %s", (err as Error)?.message ?? err);
    return [];
  }
}

/** Union both sources; DB (freshly shared) wins on key collision. Intentional (design spec):
 *  a freshly shared teaser reflects the author's latest intent. Note the trade-off — if a key
 *  exists in BOTH the registry (installable) and the DB (teaser), the merged row is the
 *  browse-only teaser and loses its install affordance. Acceptable while share and publish are
 *  distinct verbs; revisit if a single key is expected to be both.
 *
 *  `dbGems` arrives newest-first (listCatalogGems orders by created_at_ms DESC). A gem republished
 *  as a new version has multiple DB rows sharing one key; we keep the FIRST (newest) so the merged
 *  browse row shows the current version, not the original — RegistryGem carries no timestamp to
 *  sort on here, so this relies on the caller's newest-first ordering. */
export function mergeGems(dbGems: RegistryGem[], indexGems: RegistryGem[]): RegistryGem[] {
  const byKey = new Map<string, RegistryGem>();
  for (const g of indexGems) byKey.set(g.key, g);
  const seenDbKeys = new Set<string>();
  for (const g of dbGems) {
    if (seenDbKeys.has(g.key)) continue; // an older version of a key we already took
    seenDbKeys.add(g.key);
    byKey.set(g.key, g); // newest DB row overrides both older DB versions and the registry index
  }
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
      } catch (err) {
        log.warn("gem cache index fetch failed (empty list): %s", (err as Error)?.message ?? err);
        return []; // never poison the cache or 500 the public path
      }
    },
  };
}
