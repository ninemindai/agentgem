// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
//
// Discover (Optimize Plan 2, Stage 1): derive the user's active workflow topics
// from real usage, search skills.sh per topic, drop what they already have, and
// rank what's left. Deterministic and free — no LLM. Stage 2 (ACP re-rank) lives
// in discoverRerank.ts. Degrades gracefully: an unreachable registry yields a
// `degraded` payload, never an exception.
import type { ConfigInventory } from "@agentgem/model";
import type { ArtifactUsage } from "./workflowScan.js";
import { searchSkills, type RegistrySkill } from "./skillsRegistry.js";

export interface DiscoverCandidate {
  name: string;
  source: string;          // "owner/repo"
  skillId: string;         // canonical slug; the install target for `skills add <source>@<skillId>`
  registry: "skills.sh";   // future-proof: other registries can join
  installs?: number;       // registry-reported
  url: string;             // https://skills.sh/<id>
  reason: string;          // topics this matched (Stage 1) or AI rationale (Stage 2)
  installCmd: string;      // "npx skills add owner/repo@skillId"
}
export interface DiscoverPayload {
  candidates: DiscoverCandidate[];
  topics: string[];
  reranked?: boolean;
  degraded?: { reason: string };
}

/** Top workflow topics: most-invoked skill/mcp names, falling back to installed skill names. */
export function deriveTopics(usage: Map<string, ArtifactUsage>, inv: ConfigInventory, max = 5): string[] {
  const used = [...usage.values()]
    .filter((a) => a.invocations > 0 && (a.type === "skill" || a.type === "mcp_server"))
    .sort((a, b) => b.invocations - a.invocations || a.name.localeCompare(b.name))
    .map((a) => a.name);
  const seeds = used.length ? used : inv.skills.map((s) => s.name);
  const seen = new Set<string>();
  const topics: string[] = [];
  for (const t of seeds) {
    const key = t.toLowerCase();
    if (!t || seen.has(key)) continue;
    seen.add(key);
    topics.push(t);
    if (topics.length >= max) break;
  }
  return topics;
}

export async function buildDiscover(
  usage: Map<string, ArtifactUsage>,
  inv: ConfigInventory,
  opts: { search?: typeof searchSkills; max?: number; perTopic?: number } = {},
): Promise<DiscoverPayload> {
  const search = opts.search ?? searchSkills;
  const max = opts.max ?? 8;
  const topics = deriveTopics(usage, inv);
  if (!topics.length)
    return { candidates: [], topics: [], reranked: false, degraded: { reason: "No workflow signal yet — use some skills first." } };

  const installed = new Set(inv.skills.map((s) => s.name.toLowerCase()));
  // id → { row, matchedTopics }
  const hits = new Map<string, { row: RegistrySkill; topics: string[] }>();
  try {
    for (const topic of topics) {
      const rows = await search(topic, { limit: opts.perTopic ?? 10 });
      for (const row of rows) {
        if (installed.has(row.name.toLowerCase())) continue;
        const existing = hits.get(row.id);
        if (existing) { if (!existing.topics.includes(topic)) existing.topics.push(topic); }
        else hits.set(row.id, { row, topics: [topic] });
      }
    }
  } catch {
    return { candidates: [], topics, reranked: false, degraded: { reason: "skills.sh returned no new recommendations (or is unreachable)." } };
  }

  if (hits.size === 0)
    return { candidates: [], topics, reranked: false, degraded: { reason: "skills.sh returned no new recommendations (or is unreachable)." } };

  // Round-robin across topics rather than a single global sort, so one topic whose
  // results all survive the already-installed filter (e.g. an MCP server like
  // `playwright`, which has no same-named installed skill) can't fill every slot and
  // bury the lower-install survivors of self-colliding skill topics. Within a topic,
  // multi-topic matches still come first, then install count.
  const byTopic = new Map<string, Array<{ row: RegistrySkill; topics: string[] }>>(topics.map((t) => [t, []]));
  for (const hit of hits.values())
    for (const t of hit.topics) byTopic.get(t)?.push(hit);
  for (const bucket of byTopic.values())
    bucket.sort((a, b) => b.topics.length - a.topics.length || (b.row.installs ?? 0) - (a.row.installs ?? 0));

  const picked = new Set<string>();
  const ordered: Array<{ row: RegistrySkill; topics: string[] }> = [];
  for (let progressed = true; progressed && ordered.length < max; ) {
    progressed = false;
    for (const topic of topics) {
      const bucket = byTopic.get(topic)!;
      let hit = bucket.shift();
      while (hit && picked.has(hit.row.id)) hit = bucket.shift();
      if (!hit) continue;
      picked.add(hit.row.id);
      ordered.push(hit);
      progressed = true;
      if (ordered.length >= max) break;
    }
  }

  const candidates = ordered
    .map(({ row, topics: ts }): DiscoverCandidate => ({
      name: row.name,
      source: row.source,
      skillId: row.skillId,
      registry: "skills.sh",
      installs: row.installs,
      url: `https://skills.sh/${row.id}`,
      reason: `matches your ${ts.join(" + ")} ${ts.length > 1 ? "workflows" : "workflow"}`,
      installCmd: `npx skills add ${row.source}@${row.skillId}`,
    }));
  return { candidates, topics, reranked: false };
}
