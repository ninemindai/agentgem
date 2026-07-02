// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
// src/dream/dreamPass.ts
//
// Reads the (cache-hit) analyze + insights payloads for a root and enqueues new
// drafts + a diary entry. DEEP: analyze's DistilledSkill[]/Reflection[] → skill/
// lesson drafts. REM: insights' PublishCandidate[] → "opportunity" entries.
import type { DistilledSkill, Reflection, PublishCandidate } from "@agentgem/insight";
import { computeWorkflowAnalysis } from "../workflowCore.js";
import { computeInsights } from "../insightsCore.js";
import { dreamEnabled } from "./config.js";
import { harvestEntries, opportunityEntries } from "./harvest.js";
import { enqueueNew, appendDiary } from "./store.js";

interface DreamDeps {
  enabled?: boolean;
  base?: string;
  now?: () => number;
  analyze?: typeof computeWorkflowAnalysis;
  insights?: typeof computeInsights;
  dir?: string;
}

export async function dreamRoot(root: string, deps: DreamDeps = {}): Promise<"warmed" | "hit"> {
  const enabled = deps.enabled ?? dreamEnabled(deps.base);
  if (!enabled) return "hit";
  const now = deps.now ?? Date.now;
  const analyze = deps.analyze ?? computeWorkflowAnalysis;
  const insights = deps.insights ?? computeInsights;

  // cacheOnly: harvest only what the analyze/insights warmables already cached this pass.
  // On a cache miss they return an empty payload instead of computing, so the harvest never
  // spends LLM — regardless of foreground timing.
  const a = await analyze(root, { dir: deps.dir, cacheOnly: true });
  const ins = await insights(root, { dir: deps.dir, cacheOnly: true });

  const distilled = (a.payload.distilled as DistilledSkill[] | undefined) ?? [];
  const reflections = (a.payload.reflections as Reflection[] | undefined) ?? [];
  const candidates = (ins.payload.report?.publish_candidates as PublishCandidate[] | undefined) ?? [];
  const nowMs = now();
  const added = enqueueNew([
    ...harvestEntries(root, distilled, reflections, nowMs),
    ...opportunityEntries(root, candidates, nowMs),
  ], deps.base);
  appendDiary({
    atMs: nowMs, passId: nowMs, rootsProcessed: [root], phasesLit: ["DEEP", "REM"],
    enqueued: {
      skills: added.filter((e) => e.kind === "skill").length,
      lessons: added.filter((e) => e.kind === "lesson").length,
      opportunities: added.filter((e) => e.kind === "opportunity").length,
    },
    degraded: Boolean(a.payload.degraded || ins.payload.degraded),
  }, deps.base);
  return added.length ? "warmed" : "hit";
}
