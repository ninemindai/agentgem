// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
//
// The inbound SourceSpec registry: one entry per coding agent AgentGem can ingest. Mirrors the
// outbound TargetSpec. FS-touching + returns SessionStat, so it lives here (Node), not in the
// pure @agentgem/model. The DI extension point (SourceRegistry) is app-layer (see src/gem/sourceRegistry.ts).
import { readFile } from "node:fs/promises";
import { readdirSync } from "node:fs";
import { join, basename } from "node:path";
import { homedir } from "node:os";
import { resolveDirs } from "@agentgem/model";
import type { AgentBinding, GemArtifact } from "@agentgem/model";
import type { AgentId, SessionStat } from "./observeAggregate.js";
import { listFiles, parseClaudeTranscript, parseCodexTranscript } from "./observeScan.js";
import { scanClineSessions, readClineArtifacts } from "./sources/cline.js";
import { scanGeminiSessions, readGeminiArtifacts } from "./sources/gemini.js";

// codexDir is a legacy independent override (scanSessions({ claudeDir, codexDir })); when absent it
// derives from baseDir's parent via resolveDirs, same as every other agent root.
export interface SourceEnv { baseDir?: string; codexDir?: string }
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
  roots: (env) => [join(env.codexDir ?? resolveDirs(env.baseDir).codexDir, "sessions")],
  scanSessions: (roots) =>
    scanJsonl(roots.flatMap((r) => listFiles(r, ".jsonl")).filter((f) => basename(f).startsWith("rollout-")), parseCodexTranscript),
};

// macOS globalStorage roots for VS Code + forks that host the Cline extension. baseDir overrides for tests.
function clineTaskDirs(baseDir?: string): string[] {
  const roots = baseDir ? [baseDir] : ["Code", "Code - Insiders", "Cursor", "VSCodium", "Windsurf"].map(
    (app) => join(homedir(), "Library", "Application Support", app, "User", "globalStorage", "saoudrizwan.claude-dev", "tasks"));
  const dirs: string[] = [];
  const seen = new Set<string>();               // dedup by taskId across editor forks
  for (const root of roots) {
    let entries: import("node:fs").Dirent[]; try { entries = readdirSync(root, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) if (e.isDirectory() && !seen.has(e.name)) { seen.add(e.name); dirs.push(join(root, e.name)); }
  }
  return dirs;
}

const clineSource: SourceSpec = {
  id: "cline", label: "Cline / Roo", traits: { storage: "json" },
  roots: (env) => clineTaskDirs(env.baseDir),
  scanSessions: (roots) => scanClineSessions(roots),
  readArtifacts: async (roots) => readClineArtifacts({}), // per-repo rules/mcp paths are supplied by the caller in Phase 3; roots here are task dirs
};

// Session files live under ~/.gemini/tmp/<slug>/chats/session-*.jsonl. baseDir overrides for tests
// and points at a ~/.gemini root. We glob all .jsonl under tmp and keep the `session-`-prefixed ones.
function geminiTmpDir(baseDir?: string): string {
  return join(baseDir ?? join(homedir(), ".gemini"), "tmp");
}

const geminiSource: SourceSpec = {
  id: "gemini", label: "Gemini CLI", traits: { storage: "jsonl" },
  roots: (env) => [geminiTmpDir(env.baseDir)],
  scanSessions: (roots) =>
    scanGeminiSessions(roots.flatMap((r) => listFiles(r, ".jsonl")).filter((f) => basename(f).startsWith("session-"))),
  readArtifacts: async () => readGeminiArtifacts({}),  // per-repo file paths supplied by callers in a later phase (mirrors cline)
};

export const BUILTIN_SOURCES: SourceSpec[] = [claudeSource, codexSource, clineSource, geminiSource];
