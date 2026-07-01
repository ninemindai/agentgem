// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
// src/dream/dreamPass.ts
//
// Reads the (cache-hit) analyze payload for a root and enqueues new drafts +
// a diary entry. v1 harvests only the `analyze` payload — DEEP; REM/insights
// harvesting is a deferred fast-follow, so `computeInsights` is intentionally
// NOT called here.
import type { DistilledSkill, Reflection } from "@agentgem/insight";
import { computeWorkflowAnalysis } from "../workflowCore.js";
import { dreamEnabled } from "./config.js";
import { harvestEntries } from "./harvest.js";
import { enqueueNew, appendDiary } from "./store.js";

interface DreamDeps {
  enabled?: boolean;
  base?: string;
  now?: () => number;
  analyze?: typeof computeWorkflowAnalysis;
  dir?: string;
}

export async function dreamRoot(root: string, deps: DreamDeps = {}): Promise<"warmed" | "hit"> {
  const enabled = deps.enabled ?? dreamEnabled(deps.base);
  if (!enabled) return "hit";
  const now = deps.now ?? Date.now;
  const analyze = deps.analyze ?? computeWorkflowAnalysis;

  // Cache hit in a normal pass (analyze ran earlier this pass). No force → no LLM.
  // Un-forced: in a normal pass the analyze warmable already populated this root's cache, so this is a cache hit (no LLM). Narrow exception: if analyze was skipped for this root (foreground busy) but the foreground frees before dream's turn, this un-forced call can miss cache and do a real analysis — bounded to one analyze/root/pass.
  const a = await analyze(root, { dir: deps.dir });

  const distilled = (a.payload.distilled as DistilledSkill[] | undefined) ?? [];
  const reflections = (a.payload.reflections as Reflection[] | undefined) ?? [];
  const nowMs = now();
  const added = enqueueNew(harvestEntries(root, distilled, reflections, nowMs), deps.base);
  appendDiary({
    atMs: nowMs, passId: nowMs, rootsProcessed: [root], phasesLit: ["DEEP"],
    enqueued: { skills: added.filter((e) => e.kind === "skill").length, lessons: added.filter((e) => e.kind === "lesson").length },
    degraded: Boolean(a.payload.degraded),
  }, deps.base);
  return added.length ? "warmed" : "hit";
}
