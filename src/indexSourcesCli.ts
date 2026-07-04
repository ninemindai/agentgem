// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
// src/indexSourcesCli.ts — `agentgem index-sources`: walk CURATED_SOURCES, upsert their skill
// list + GitHub star count into curated_skills (the "Popular Skills" board's DB index). Builds
// the AppDb the same way the server does (resolveAggregatorDb: Postgres when DATABASE_URL is
// set, else embedded pglite), so running it against prod is `DATABASE_URL=<neon-url> agentgem
// index-sources`.
import { resolveAggregatorDb } from "@agentgem/aggregator";
import { indexCuratedSkills } from "./curatedSkillsIndexer.js";

export async function runIndexSourcesCommand(): Promise<number> {
  const { db, onStop } = await resolveAggregatorDb();
  try {
    const { sources, skills } = await indexCuratedSkills(db);
    console.log(`indexed ${skills} skills across ${sources} sources`);
    return 0;
  } finally {
    await onStop();
  }
}
