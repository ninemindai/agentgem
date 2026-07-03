// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
// src/learnCore.ts
//
// The intent-driven distillation front door ("/learn on a session"): run the existing
// extractor pipeline over ONE transcript and land candidates in the dream review queue
// with phase "LEARN". Never auto-accepts (queue → accept/dismiss is the only exit) and
// never touches the project-scoped distill cache — a single session's results must not
// masquerade as the project-wide distill. The session ref selects from the server-derived
// transcript list by basename; it is never joined into a path.
import { statSync } from "node:fs";
import { basename } from "node:path";
import { introspectConfig, introspectProject } from "@agentgem/capture";
import { resolveDirs, resolveProject, InvalidInputError } from "@agentgem/model";
import {
  claudeTranscriptsForCwd, scanWorkflow, distillWorkflow, extractReflections,
} from "@agentgem/insight";
import { harvestEntries } from "./dream/harvest.js";
import { enqueueNew } from "./dream/store.js";

export interface LearnResult {
  session: string;   // basename of the distilled transcript
  enqueued: number;  // entries actually added (post-dedup)
  skills: number;    // candidate skills found (pre-dedup)
  lessons: number;   // candidate lessons found (pre-dedup, post reflectionToLesson filter)
  degraded: boolean; // LLM path unavailable → heuristic-only
}

export async function learnFromSession(opts: {
  root: string;
  dir?: string;
  session?: string;
  now?: () => number;
  distillWf?: typeof distillWorkflow;
  extractRefl?: typeof extractReflections;
  base?: string;
}): Promise<LearnResult> {
  const dirs = resolveDirs(opts.dir);
  const root = resolveProject(opts.root);
  const paths = claudeTranscriptsForCwd(dirs.claudeDir, root);
  if (!paths.length) throw new InvalidInputError(`no sessions recorded for ${root}`);

  let target: string;
  if (opts.session) {
    const want = opts.session.endsWith(".jsonl") ? opts.session : `${opts.session}.jsonl`;
    const hit = paths.find((p) => basename(p) === want);
    if (!hit) throw new InvalidInputError(`no session '${opts.session}' recorded for this project (${paths.length} known)`);
    target = hit;
  } else {
    target = paths
      .map((p) => ({ p, m: statSync(p).mtimeMs }))
      .sort((a, b) => b.m - a.m)[0].p;
  }

  const project = introspectProject(root);
  const g = introspectConfig(dirs);
  const scanInv = { project, global: { skills: g.skills, mcpServers: g.mcpServers, hooks: g.hooks } };
  const signal = scanWorkflow([target], scanInv, { retainSequences: true });
  const wf = await (opts.distillWf ?? distillWorkflow)(signal, scanInv);
  const reflections = (opts.extractRefl ?? extractReflections)(signal);

  const entries = harvestEntries(root, wf.distilled, reflections, (opts.now ?? Date.now)(), "LEARN");
  const added = enqueueNew(entries, opts.base);
  return {
    session: basename(target),
    enqueued: added.length,
    skills: wf.distilled.length,
    lessons: entries.filter((e) => e.kind === "lesson").length,
    degraded: wf.degraded,
  };
}
