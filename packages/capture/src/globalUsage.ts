// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
// src/gem/globalUsage.ts
//
// Pure global-usage scan: count which GLOBAL artifacts fired across the given
// transcripts. An empty project inventory means every resolved call attributes
// to a global (no project shadowing).
import { createHash } from "node:crypto";
import { introspectConfig } from "./introspect.js";
import { scanWorkflow } from "@agentgem/insight";
import type { resolveDirs } from "@agentgem/model";
import { openTranscriptIndex, defaultIndexDir, type TranscriptIndex, type UsageRow } from "./transcriptIndex.js";

export interface GlobalUsageResult {
  artifacts: { type: string; name: string; root: null; invocations: number; sessionsUsedIn: number; lastUsedMs: number | null }[];
}

export function computeGlobalUsage(dirs: ReturnType<typeof resolveDirs>, paths: string[]): GlobalUsageResult {
  const globalInv = introspectConfig(dirs);
  const emptyProject = { root: "", name: "", skills: [], mcpServers: [], instructions: [], hooks: [] };
  const scanInv = { project: emptyProject, global: { skills: globalInv.skills, mcpServers: globalInv.mcpServers, hooks: globalInv.hooks } };
  const signal = scanWorkflow(paths, scanInv);
  return {
    artifacts: signal.artifacts
      .filter((a) => a.root === null)
      .map((a) => ({ type: a.type, name: a.name, root: a.root as null, invocations: a.invocations, sessionsUsedIn: a.sessionsUsedIn, lastUsedMs: a.lastUsedMs })),
  };
}

// A stable fingerprint of the GLOBAL inventory. Stored rows resolve raw tool calls
// against this inventory, so a change here invalidates them (the index rebuilds).
function inventoryDigest(global: { skills: { name: string }[]; mcpServers: { name: string }[]; hooks: { name: string; event?: string; config?: unknown }[] }): string {
  const norm = {
    skills: global.skills.map((s) => s.name).sort(),
    mcp: global.mcpServers.map((m) => m.name).sort(),
    hooks: global.hooks
      .map((h) => ({ n: h.name, e: h.event ?? "", c: h.config ?? null }))
      .sort((a, b) => a.n.localeCompare(b.n)),
  };
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
 * Global usage via the persistent incremental index: same result as
 * `computeGlobalUsage`, but only new/changed transcripts are reparsed. The caller
 * should fall back to `computeGlobalUsage` if this rejects.
 */
export async function getGlobalUsageIndexed(dirs: ReturnType<typeof resolveDirs>, paths: string[]): Promise<GlobalUsageResult> {
  const globalInv = introspectConfig(dirs);
  const emptyProject = { root: "", name: "", skills: [], mcpServers: [], instructions: [], hooks: [] };
  const scanInv = { project: emptyProject, global: { skills: globalInv.skills, mcpServers: globalInv.mcpServers, hooks: globalInv.hooks } };
  const digest = inventoryDigest(scanInv.global);
  const parseFile = (path: string): UsageRow[] =>
    scanWorkflow([path], scanInv).artifacts
      .filter((a) => a.root === null)
      .map((a) => ({ type: a.type, name: a.name, invocations: a.invocations, sessionsUsedIn: a.sessionsUsedIn, lastUsedMs: a.lastUsedMs }));
  const index = await sharedIndex();
  return index.syncGlobalUsage(paths, digest, parseFile);
}
