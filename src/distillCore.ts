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
  type DistilledSkill, type DistilledLesson,
} from "@agentgem/insight";

export interface DistillPayload { skills: DistilledSkill[]; lessons: DistilledLesson[]; degraded: boolean }
export interface DistillResult { payload: DistillPayload; cached: boolean; updatedAt: number | null }

export async function computeDistill(
  root: string,
  opts: {
    dir?: string; force?: boolean; now?: () => number;
    distillWf?: typeof distillWorkflow;
    distillLessons?: typeof distillSessionLessons;
  } = {},
): Promise<DistillResult> {
  const now = opts.now ?? Date.now;
  const dirs = resolveDirs(opts.dir);
  const project = introspectProject(resolveProject(root));
  const globalInv = introspectConfig(dirs);
  const scanInv = { project, global: { skills: globalInv.skills, mcpServers: globalInv.mcpServers, hooks: globalInv.hooks } };

  const paths = claudeTranscriptsForCwd(dirs.claudeDir, root);
  const token = distillToken(paths);
  if (!opts.force) {
    const entry = readDistillCacheEntry(root, token);
    if (entry) return { payload: entry.result as DistillPayload, cached: true, updatedAt: entry.ts };
  }

  const signal = scanWorkflow(paths, scanInv, { retainSequences: true });
  const [wf, ls] = await Promise.all([
    (opts.distillWf ?? distillWorkflow)(signal, scanInv),
    (opts.distillLessons ?? distillSessionLessons)(signal, scanInv),
  ]);
  const degraded = wf.degraded || ls.degraded;
  const payload: DistillPayload = { skills: wf.distilled, lessons: ls.lessons, degraded };
  let updatedAt: number | null = null;
  if (!degraded) { const ts = now(); writeDistillCache(root, token, payload, ts); updatedAt = ts; }
  return { payload, cached: false, updatedAt };
}
