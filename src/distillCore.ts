// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
// src/distillCore.ts
//
// Headless, cache-aware core for per-project playbook distillation (skills +
// session lessons). Shared by /playbook/prepare and the distill warmable.
import { introspectConfig, introspectProject } from "@agentgem/capture";
import { resolveDirs, resolveProject } from "@agentgem/model";
import {
  claudeTranscriptsForCwd, scanWorkflow,
  distillWorkflow, distillSessionLessons,
  distillToken, readDistillCacheEntry, writeDistillCache,
  computeCached, type CacheHit,
  type DistilledSkill, type DistilledLesson,
} from "@agentgem/insight";

export interface DistillPayload { skills: DistilledSkill[]; lessons: DistilledLesson[]; degraded: boolean }
export interface DistillResult { payload: DistillPayload; cached: boolean; updatedAt: number | null }

// The interactive /playbook/prepare path caps the distill agents aggressively so a
// user who clicks "Publish" isn't stuck on the full 60s LLM budget — it falls back
// to heuristic skeletons if the agents can't finish in time. The background `distill`
// warmable keeps the default (full) budget and caches a high-quality, non-degraded
// result, which a later prepare of the same project then serves instantly.
export const PREPARE_DISTILL_TIMEOUT_MS = 15_000;

export async function computeDistill(
  root: string,
  opts: {
    dir?: string; force?: boolean; now?: () => number;
    timeoutMs?: number;   // per-agent deadline; undefined ⇒ distill's own 60s default
    distillWf?: typeof distillWorkflow;
    distillLessons?: typeof distillSessionLessons;
  } = {},
): Promise<DistillResult> {
  const now = opts.now ?? Date.now;
  const dirs = resolveDirs(opts.dir);
  const project = introspectProject(resolveProject(root));
  const globalInv = introspectConfig(dirs);
  // Dedup the distill against genuinely-installed skills only — NOT the pipeline's
  // own prior distilled DRAFTS. Including drafts here self-poisons: a degraded run
  // persists heuristic skeletons as drafts, the next distill sees them as "installed"
  // and concludes every candidate is already covered → emits nothing → degraded → loop.
  const notDraft = <T extends { source: string }>(s: T): boolean => s.source !== "distilled-draft";
  const scanInv = {
    project: { ...project, skills: project.skills.filter(notDraft) },
    global: { skills: globalInv.skills.filter(notDraft), mcpServers: globalInv.mcpServers, hooks: globalInv.hooks },
  };

  const paths = claudeTranscriptsForCwd(dirs.claudeDir, root);
  const token = distillToken(paths);
  return computeCached<DistillPayload>({
    token, force: opts.force, now,
    read: (t) => readDistillCacheEntry(root, t) as CacheHit<DistillPayload> | null,
    write: (t, payload, ts) => writeDistillCache(root, t, payload, ts),
    degraded: (p) => p.degraded,
    compute: async () => {
      const signal = scanWorkflow(paths, scanInv, { retainSequences: true });
      const distillOpts = { timeoutMs: opts.timeoutMs };   // undefined ⇒ each agent's 60s default
      const [wf, ls] = await Promise.all([
        (opts.distillWf ?? distillWorkflow)(signal, scanInv, distillOpts),
        (opts.distillLessons ?? distillSessionLessons)(signal, scanInv, distillOpts),
      ]);
      return { skills: wf.distilled, lessons: ls.lessons, degraded: wf.degraded || ls.degraded };
    },
  });
}
