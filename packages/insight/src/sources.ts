// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
//
// The inbound SourceSpec registry: one entry per coding agent AgentGem can ingest. Mirrors the
// outbound TargetSpec. FS-touching + returns SessionStat, so it lives here (Node), not in the
// pure @agentgem/model. The DI extension point (SourceRegistry) is app-layer (see src/gem/sourceRegistry.ts).
import { readFile } from "node:fs/promises";
import { join, basename } from "node:path";
import { resolveDirs } from "@agentgem/model";
import type { AgentBinding, GemArtifact } from "@agentgem/model";
import type { AgentId, SessionStat } from "./observeAggregate.js";
import { listFiles, parseClaudeTranscript, parseCodexTranscript } from "./observeScan.js";

export interface SourceEnv { baseDir?: string }
export interface ImportResult { artifacts: GemArtifact[]; binding: AgentBinding }

export interface SourceSpec {
  id: AgentId;
  label: string;
  traits: { storage: "jsonl" | "json" | "sqlite" | "mixed" };
  roots(env: SourceEnv): string[];                        // may be empty when the agent is absent
  scanSessions?(roots: string[]): Promise<SessionStat[]>; // capability: telemetry
  readArtifacts?(roots: string[]): Promise<ImportResult>; // capability: authoring
}

async function scanJsonl(files: string[], parse: (t: string, p: string) => SessionStat | null): Promise<SessionStat[]> {
  const out: SessionStat[] = [];
  for (const f of files) {
    let text: string; try { text = await readFile(f, "utf8"); } catch { continue; }
    const s = parse(text, f); if (s) out.push(s);
  }
  return out;
}

const claudeSource: SourceSpec = {
  id: "claude", label: "Claude Code", traits: { storage: "jsonl" },
  roots: (env) => [join(resolveDirs(env.baseDir).claudeDir, "projects")],
  scanSessions: (roots) => scanJsonl(roots.flatMap((r) => listFiles(r, ".jsonl")), parseClaudeTranscript),
};

const codexSource: SourceSpec = {
  id: "codex", label: "Codex", traits: { storage: "jsonl" },
  roots: (env) => [join(resolveDirs(env.baseDir).codexDir, "sessions")],
  scanSessions: (roots) =>
    scanJsonl(roots.flatMap((r) => listFiles(r, ".jsonl")).filter((f) => basename(f).startsWith("rollout-")), parseCodexTranscript),
};

export const BUILTIN_SOURCES: SourceSpec[] = [claudeSource, codexSource];
