// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
// packages/insight/src/optimizeScan.ts
//
// Usage inputs for GET /api/optimize. Two scopes, two sources:
//
//  - GLOBAL scope goes through the persistent transcript index (@agentgem/capture's
//    getGlobalUsageIndexed): incremental, off the event loop, ~0.03s warm — the same
//    source /api/usage serves. The controller owns that call (insight must not depend
//    on capture) and hands the resolved artifacts to `optimizeUsageMap` here to shape
//    them into the `${type}:${name}` map the payload builder expects. This is what
//    retired the old 16s synchronous corpus scan + its broken 15s cache (issue #321).
//
//  - PROJECT (cwd) scope stays on the synchronous `scanWorkflow` below: it scans only
//    ONE project's transcripts (a small slice, not the whole corpus), so the global
//    stall that motivated the index doesn't apply here — and the index can't serve a
//    path-subset anyway (syncUsage prunes every file not in the passed paths, which
//    would corrupt the shared global table). It also backs the global path's fallback
//    when the index is unavailable.
//
// buildOptimizePayload reads the installed set from the inventory and only annotates it
// with this usage, so the map needs only artifacts that actually FIRED — unused installs
// come from the inventory, keyed the same `${type}:${name}`.
import type { ArtifactType, ConfigInventory, ProjectInventory } from "@agentgem/model";
import { scanWorkflow, allClaudeTranscripts, claudeTranscriptsForCwd, type ArtifactUsage } from "./workflowScan.js";

function syntheticProject(inv: ConfigInventory): ProjectInventory {
  // Carry the installed skills/mcp/hooks as a single synthetic "project" so scanWorkflow
  // emits all of them with usage counts. Instructions are handled separately (presence-only).
  return { root: "", name: "", skills: inv.skills, mcpServers: inv.mcpServers, instructions: [], hooks: inv.hooks, subagents: inv.subagents };
}

/**
 * Project/cwd-scoped usage — scan one project's transcripts synchronously. Also the global
 * path's fallback (called with no cwd) when the transcript index is unavailable. Emits every
 * installed skill/mcp, including unused ones (invocations: 0) — unused is what the prune view needs.
 */
export function scanArtifactUsage(inv: ConfigInventory, claudeDir: string, cwd?: string): Map<string, ArtifactUsage> {
  const paths = cwd ? claudeTranscriptsForCwd(claudeDir, cwd) : allClaudeTranscripts(claudeDir);
  const signal = scanWorkflow(paths, { project: syntheticProject(inv), global: { skills: [], mcpServers: [], hooks: [] } });
  const map = new Map<string, ArtifactUsage>();
  for (const a of signal.artifacts) {
    if (a.type === "skill" || a.type === "mcp_server") map.set(`${a.type}:${a.name}`, a);
  }
  return map;
}

// The subset of a resolved global-usage artifact this view needs — structural so insight
// stays free of any @agentgem/capture type (GlobalUsageResult lives there).
export interface IndexedUsageArtifact {
  type: string;
  name: string;
  root: string | null;
  invocations: number;
  sessionsUsedIn: number;
  lastUsedMs: number | null;
}

/**
 * Shape the transcript index's resolved global-usage artifacts into the `${type}:${name}` map
 * that buildOptimizePayload / buildDiscover consume. Only skill and mcp_server rows are relevant
 * to Optimize; hooks and anything else are dropped. Skills/mcp are token-driven (not heuristically
 * matched), so they are always high-confidence — the same confidence scanWorkflow assigns them.
 */
export function optimizeUsageMap(artifacts: IndexedUsageArtifact[]): Map<string, ArtifactUsage> {
  const map = new Map<string, ArtifactUsage>();
  for (const a of artifacts) {
    if (a.type !== "skill" && a.type !== "mcp_server") continue;
    map.set(`${a.type}:${a.name}`, {
      type: a.type as ArtifactType,
      name: a.name,
      root: a.root,
      invocations: a.invocations,
      sessionsUsedIn: a.sessionsUsedIn,
      lastUsedMs: a.lastUsedMs,
      confidence: "high",
    });
  }
  return map;
}
