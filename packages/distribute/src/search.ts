// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
// src/gem/search.ts
// Discovery over the registry index. Index-only and in-memory: getIndex() already
// fetches the whole index in one call, so search is a pure weighted scan — no extra
// network, no DB. Right at tens-to-thousands of gems; revisit only past fetch-whole scale.
import type { RegistryIndex } from "./registry.js";

export interface SearchHit {
  key: string;
  latest: string;
  score: number;
  description?: string;
  tags?: string[];
  author?: string;
  artifactKinds?: string[];
  updatedAt?: string;
}

export interface SearchOpts { kind?: string; tag?: string; limit?: number }

// Weighted field match: name >> tags > description. An empty query (with optional
// kind/tag filter) browses the catalog — every gem returns, score 0.
export function searchIndex(index: RegistryIndex, query: string, opts: SearchOpts = {}): SearchHit[] {
  const terms = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  const hits: SearchHit[] = [];

  for (const [key, item] of Object.entries(index.items)) {
    const d = item.discovery ?? {};
    if (opts.kind && !(d.artifactKinds ?? []).includes(opts.kind)) continue;
    if (opts.tag && !(d.tags ?? []).includes(opts.tag)) continue;

    const name = key.toLowerCase();
    const tags = (d.tags ?? []).join(" ").toLowerCase();
    const desc = (d.description ?? "").toLowerCase();
    let score = 0;
    for (const t of terms) {
      if (name === t) score += 100;
      else if (name.includes(t)) score += 10;
      if (tags.split(/\s+/).includes(t)) score += 5;
      else if (tags.includes(t)) score += 3;
      if (desc.includes(t)) score += 1;
    }
    if (terms.length && score === 0) continue; // query given but nothing matched

    hits.push({ key, latest: item.latest, score, description: d.description, tags: d.tags, author: d.author, artifactKinds: d.artifactKinds, updatedAt: d.updatedAt });
  }

  hits.sort((a, b) => b.score - a.score || a.key.localeCompare(b.key));
  return hits.slice(0, opts.limit ?? 25);
}
