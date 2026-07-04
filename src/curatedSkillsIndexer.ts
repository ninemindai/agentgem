// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
// src/curatedSkillsIndexer.ts
//
// App-layer bridge: @agentgem/distribute (curated-source adapters) -> the aggregator DB. Walks
// every CURATED_SOURCES repo, fetches its GitHub star count and skill list, and upserts a
// curated_skills row per skill so the marketplace "Popular Skills" board (GET
// /api/aggregator/popular-skills) can rank without hitting GitHub on every request. Run via
// `agentgem index-sources` (indexSourcesCli.ts).
import { upsertCuratedSkills, type CuratedSkillRow, type AppDb } from "@agentgem/aggregator";
import { CURATED_SOURCES, cfgForCuratedSource, listSourceSkills, defaultHttp } from "@agentgem/distribute";
import type { CuratedSource, Http } from "@agentgem/distribute";

// GET /repos/{owner}/{name} -> stargazers_count. Defaults to 0 on any error (rate limit, 404,
// malformed body) — a stars lookup failing must not sink the whole source's skill list.
async function fetchStars(source: CuratedSource, http: Http): Promise<number> {
  try {
    const headers: Record<string, string> = { Accept: "application/vnd.github+json", "User-Agent": "agentgem" };
    if (process.env.GITHUB_TOKEN) headers.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
    const res = await http(`https://api.github.com/repos/${source.repo}`, { headers });
    if (res.status >= 300) return 0;
    const body = JSON.parse(await res.text()) as { stargazers_count?: number };
    return typeof body.stargazers_count === "number" ? body.stargazers_count : 0;
  } catch {
    return 0;
  }
}

export async function indexCuratedSkills(
  db: AppDb,
  opts: { sources?: CuratedSource[]; http?: Http } = {},
): Promise<{ sources: number; skills: number }> {
  const sources = opts.sources ?? CURATED_SOURCES;
  const http = opts.http ?? defaultHttp;
  let sourceCount = 0;
  let skillCount = 0;
  for (const source of sources) {
    try {
      const cfg = cfgForCuratedSource(source);
      const stars = await fetchStars(source, http);
      const skills = await listSourceSkills(source, cfg, http);
      const rows: CuratedSkillRow[] = skills.map((s) => ({
        sourceId: source.id,
        source: source.label,
        division: s.division,
        name: s.name,
        path: s.path,
        repo: source.repo,
        homepage: source.homepage ?? null,
        stars,
        installs: null,
      }));
      await upsertCuratedSkills(db, rows);
      sourceCount += 1;
      skillCount += rows.length;
    } catch (e) {
      // A failing repo (rate limit, 404, network error) is skipped, not fatal to the whole run.
      console.error(`indexCuratedSkills: skipping '${source.id}': ${(e as Error).message}`);
    }
  }
  return { sources: sourceCount, skills: skillCount };
}
