// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
// src/gem/optimizeScan.ts
//
// IO seam for GET /api/optimize: scan all Claude transcripts into a per-artifact usage
// map by reusing scanWorkflow (which already detects Skill(...) and mcp__server__ calls
// and resolves them to inventory names). The installed inventory is passed as the
// `project` inventory so scanWorkflow emits EVERY artifact, including unused ones
// (invocations: 0) — unused is exactly what the prune view needs.
import { homedir } from "node:os";
import { join } from "node:path";
import type { ConfigInventory, ProjectInventory } from "@agentgem/model";
import { scanWorkflow, allClaudeTranscripts, type ArtifactUsage } from "./workflowScan.js";

const SCAN_TTL_MS = 15_000;
let cache: { atMs: number; map: Map<string, ArtifactUsage> } | null = null;

function syntheticProject(inv: ConfigInventory): ProjectInventory {
  // Carry the installed skills/mcp/hooks as a single synthetic "project" so scanWorkflow
  // emits all of them with usage counts. Instructions are handled separately (presence-only).
  return { root: "", name: "", skills: inv.skills, mcpServers: inv.mcpServers, instructions: [], hooks: inv.hooks };
}

export function scanArtifactUsage(inv: ConfigInventory, claudeDir: string): Map<string, ArtifactUsage> {
  const paths = allClaudeTranscripts(claudeDir);
  const signal = scanWorkflow(paths, { project: syntheticProject(inv), global: { skills: [], mcpServers: [], hooks: [] } });
  const map = new Map<string, ArtifactUsage>();
  for (const a of signal.artifacts) {
    if (a.type === "skill" || a.type === "mcp_server") map.set(`${a.type}:${a.name}`, a);
  }
  return map;
}

export async function scanArtifactUsageCached(inv: ConfigInventory, nowMs: number, claudeDir?: string, refresh = false): Promise<Map<string, ArtifactUsage>> {
  if (claudeDir) return scanArtifactUsage(inv, claudeDir);   // custom dir bypasses cache
  const dir = join(homedir(), ".claude");
  if (!refresh && cache && nowMs - cache.atMs < SCAN_TTL_MS) return cache.map;
  const map = scanArtifactUsage(inv, dir);
  cache = { atMs: nowMs, map };
  return map;
}

export function clearOptimizeScanCache(): void {
  cache = null;
}
