// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
// src/gem/globalUsage.ts
//
// Pure global-usage scan: count which GLOBAL artifacts fired across the given
// transcripts. An empty project inventory means every resolved call attributes
// to a global (no project shadowing).
import { createHash } from "node:crypto";
import { introspectConfig } from "./introspect.js";
import { scanWorkflow, scanFileUsage } from "@agentgem/insight";
import type { HookArtifact, resolveDirs } from "@agentgem/model";
import { openTranscriptIndex, defaultIndexDir, type TranscriptIndex, type OffThreadParse } from "./transcriptIndex.js";
import { resolveUsage } from "./resolveUsage.js";

export interface GlobalUsageResult {
  artifacts: { type: string; name: string; root: null; invocations: number; sessionsUsedIn: number; lastUsedMs: number | null }[];
}

export function computeGlobalUsage(dirs: ReturnType<typeof resolveDirs>, paths: string[]): GlobalUsageResult {
  const globalInv = introspectConfig(dirs);
  const emptyProject = { root: "", name: "", skills: [], mcpServers: [], instructions: [], hooks: [], subagents: [] };
  const scanInv = { project: emptyProject, global: { skills: globalInv.skills, mcpServers: globalInv.mcpServers, hooks: globalInv.hooks } };
  const signal = scanWorkflow(paths, scanInv);
  return {
    artifacts: signal.artifacts
      .filter((a) => a.root === null)
      .map((a) => ({ type: a.type, name: a.name, root: a.root as null, invocations: a.invocations, sessionsUsedIn: a.sessionsUsedIn, lastUsedMs: a.lastUsedMs })),
  };
}

// A stable fingerprint of the HOOK inventory only. Hook hits are resolved at PARSE time (a hook
// has no token — it is matched by its own event/command), so a hook change invalidates stored hook
// rows and forces a reparse. Skills and mcp servers are resolved at QUERY time and therefore do NOT
// belong in this digest: installing one must reparse nothing.
export function hookDigest(hooks: HookArtifact[]): string {
  const norm = hooks
    .map((h) => ({ n: h.name, e: h.event ?? "", c: h.config ?? null }))
    .sort((a, b) => a.n.localeCompare(b.n));
  return createHash("sha1").update(JSON.stringify(norm)).digest("hex");
}

// Lazily-created shared index, keyed by its datadir. Keying by datadir means a
// changed AGENTGEM_HOME (tests, or a relocated home) transparently opens a fresh
// instance at the new location instead of reusing a stale one. On open failure we
// reset the promise so the next request retries rather than being stuck on a dead
// instance.
let indexPromise: Promise<TranscriptIndex> | null = null;
let indexDir: string | null = null;
function sharedIndex(): Promise<TranscriptIndex> {
  const dir = defaultIndexDir();
  if (indexPromise && indexDir === dir) return indexPromise;
  if (indexPromise) {
    const old = indexPromise;
    old.then((i) => i.close()).catch(() => {}); // best-effort close the relocated instance
  }
  indexDir = dir;
  indexPromise = openTranscriptIndex(dir).catch((e) => { indexPromise = null; indexDir = null; throw e; });
  return indexPromise;
}

/**
 * Close the shared transcript index if one was opened, flushing its persistent
 * on-disk SQLite. Register this on graceful shutdown (symmetric with the
 * aggregator DB's onStop) so SIGTERM closes it cleanly instead of leaving the
 * WASM instance resident until process exit. Idempotent, safe when nothing was
 * opened, and resets the singleton so a later request transparently reopens.
 */
export async function closeSharedIndex(): Promise<void> {
  const p = indexPromise;
  if (!p) return;
  indexPromise = null;
  indexDir = null;
  await p.then((i) => i.close()).catch(() => {}); // best-effort: a rejected/dead instance needs no close
}

/**
 * Global usage via the persistent incremental index: same result as `computeGlobalUsage`, but only
 * new/changed transcripts are reparsed — and, unlike before, an inventory change reparses NOTHING
 * (raw tokens are stored; resolution happens here, per call). The caller should fall back to
 * `computeGlobalUsage` if this rejects.
 */
export async function getGlobalUsageIndexed(
  dirs: ReturnType<typeof resolveDirs>, paths: string[], offThreadParse?: OffThreadParse,
): Promise<GlobalUsageResult> {
  const globalInv = introspectConfig(dirs);
  const parseFile = (path: string) => scanFileUsage(path, globalInv.hooks);
  const index = await sharedIndex();
  const stored = await index.syncUsage(paths, hookDigest(globalInv.hooks), parseFile, offThreadParse, globalInv.hooks);
  return resolveUsage(stored.raw, stored.hooks, { skills: globalInv.skills, mcpServers: globalInv.mcpServers });
}
