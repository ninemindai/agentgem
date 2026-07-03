// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
//
// The inbound SourceSpec registry: one entry per coding agent AgentGem can ingest. Mirrors the
// outbound TargetSpec. FS-touching + returns SessionStat, so it lives here (Node), not in the
// pure @agentgem/model. The DI extension point (SourceRegistry) is app-layer (see src/gem/sourceRegistry.ts).
import { readFile } from "node:fs/promises";
import { readdirSync, existsSync } from "node:fs";
import { join, basename } from "node:path";
import { homedir } from "node:os";
import { resolveDirs } from "@agentgem/model";
import type { AgentBinding, GemArtifact } from "@agentgem/model";
import type { AgentId, SessionStat } from "./observeAggregate.js";
import { listFiles, jsonLines, parseClaudeTranscript, parseCodexTranscript } from "./observeScan.js";
import { detectHtmlArtifacts, type HtmlArtifactVersion } from "./artifactScan.js";
import { claudeSessionEvents, codexSessionEvents, type SessionEvent } from "./inspectSession.js";
import { resolveCodexHtmlPaths } from "./sources/codexArtifacts.js";
import { scanClineSessions, readClineArtifacts, parseClineMeta, detectClineArtifacts } from "./sources/cline.js";
import { scanGeminiSessions, readGeminiArtifacts, parseGeminiMeta, resolveGeminiHtmlPaths } from "./sources/gemini.js";
import { scanContinueSessions, readContinueArtifacts, parseContinueMeta, resolveContinueHtmlPaths } from "./sources/continue.js";
import { scanCursorSessions, readCursorArtifacts } from "./sources/cursor.js";

// codexDir is a legacy independent override (scanSessions({ claudeDir, codexDir })); when absent it
// derives from baseDir's parent via resolveDirs, same as every other agent root.
//
// baseDir is overloaded per source: for claude/codex it is the .claude dir (siblings derived via
// resolveDirs); for cline/gemini/continue/cursor it is that source's OWN config/data home (and a
// test override). Callers of readArtifacts must pass the per-source home, never claudeDir.
export interface SourceEnv { baseDir?: string; codexDir?: string }
export interface ImportResult { artifacts: GemArtifact[]; binding: AgentBinding }

export interface SourceSpec {
  id: AgentId;
  label: string;
  traits: { storage: "jsonl" | "json" | "sqlite" | "mixed" };
  roots(env: SourceEnv): string[];                        // may be empty when the agent is absent
  scanSessions?(roots: string[]): Promise<SessionStat[]>; // capability: telemetry
  readArtifacts?(env: SourceEnv): Promise<ImportResult>;  // capability: authoring — global config only, per-repo is future work
  // ── Watch capabilities (live HTML-artifact preview) ─────────────────────────
  // An agent is "watchable" when it supplies watchFiles + parseMeta and at least
  // one detection method. detectArtifacts is the rich, full-content path (best
  // fidelity, survives file deletion); resolveArtifactPaths is the thin, agent-
  // agnostic fallback (returns just the *.html paths, watched on disk directly).
  /** Transcript files eligible to watch live; encapsulates per-agent name filters. */
  watchFiles?(roots: string[]): string[];
  /** Light metadata for the Watch picker — reuses the telemetry parser. */
  parseMeta?(text: string, path: string): SessionStat | null;
  /** Reconstruct ordered full-document HTML snapshots from one transcript. */
  detectArtifacts?(text: string, path: string): HtmlArtifactVersion[];
  /** Absolute *.html paths the session touched, for the file-driven fallback. */
  resolveArtifactPaths?(text: string): string[];
  /** Flatten a transcript into ordered, unfolded SessionEvents for the live feed. */
  detectEvents?(text: string, path: string): SessionEvent[];
}

/** Sources that can drive the Watch tab (have discovery + at least one detector). */
export function watchableSources(specs: SourceSpec[] = BUILTIN_SOURCES): SourceSpec[] {
  return specs.filter((s) => s.watchFiles && s.parseMeta && (s.detectArtifacts || s.resolveArtifactPaths));
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
  watchFiles: (roots) => roots.flatMap((r) => listFiles(r, ".jsonl")),
  parseMeta: parseClaudeTranscript,
  // Claude's Write/Edit records carry the full document, so we reconstruct snapshots.
  detectArtifacts: (text) => detectHtmlArtifacts(jsonLines(text)),
  detectEvents: claudeSessionEvents,
};

const codexSource: SourceSpec = {
  id: "codex", label: "Codex", traits: { storage: "jsonl" },
  roots: (env) => [join(env.codexDir ?? resolveDirs(env.baseDir).codexDir, "sessions")],
  scanSessions: (roots) =>
    scanJsonl(roots.flatMap((r) => listFiles(r, ".jsonl")).filter((f) => basename(f).startsWith("rollout-")), parseCodexTranscript),
  watchFiles: (roots) => roots.flatMap((r) => listFiles(r, ".jsonl")).filter((f) => basename(f).startsWith("rollout-")),
  parseMeta: parseCodexTranscript,
  // Codex mutates files via apply_patch/shell (diffs, not whole writes), so we only
  // resolve the touched *.html paths and let the live layer watch them on disk.
  resolveArtifactPaths: resolveCodexHtmlPaths,
  detectEvents: codexSessionEvents,
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
  // roots are per-task DIRS; the watched file is <taskDir>/ui_messages.json.
  watchFiles: (roots) => roots.map((d) => join(d, "ui_messages.json")),
  parseMeta: parseClineMeta,
  // ui_messages carries full file content on writes → transcript-driven snapshots.
  detectArtifacts: (text) => detectClineArtifacts(text),
  readArtifacts: async (env) => {
    // cline's global config-home isn't reliably locatable across editor forks (VS Code / Cursor /
    // etc globalStorage); needs baseDir until a follow-up discovers it.
    if (!env.baseDir) return readClineArtifacts({});
    return readClineArtifacts({
      mcpSettingsFile: join(env.baseDir, "cline_mcp_settings.json"),
      rulesFile: join(env.baseDir, ".clinerules"),
    });
  },
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
  watchFiles: (roots) => roots.flatMap((r) => listFiles(r, ".jsonl")).filter((f) => basename(f).startsWith("session-")),
  parseMeta: parseGeminiMeta,
  // write_file/replace use absolute paths → resolve + watch the real files (file-driven).
  resolveArtifactPaths: resolveGeminiHtmlPaths,
  readArtifacts: async (env) => {
    const home = env.baseDir || join(homedir(), ".gemini");  // || not ??: "" must mean absent, never a cwd-relative read
    return readGeminiArtifacts({
      contextFile: join(home, "GEMINI.md"),
      settingsFile: join(home, "settings.json"),
      commandsDir: join(home, "commands"),
    });
  },
};

// ~/.continue/sessions holds the session index + per-session JSON. baseDir overrides for tests
// (points at a ~/.continue root). scanSessions takes the sessions dir (one root).
function continueSessionsDir(baseDir?: string): string {
  return join(baseDir ?? join(homedir(), ".continue"), "sessions");
}

const continueSource: SourceSpec = {
  id: "continue", label: "Continue", traits: { storage: "json" },
  roots: (env) => [continueSessionsDir(env.baseDir)],
  scanSessions: async (roots) => (await Promise.all(roots.map((r) => scanContinueSessions(r)))).flat(),
  // One <sessionId>.json per session; sessions.json is the index, not a session.
  watchFiles: (roots) => roots.flatMap((r) => listFiles(r, ".json")).filter((f) => basename(f) !== "sessions.json"),
  parseMeta: parseContinueMeta,
  // Provisional file-driven detector (tool-arg shape not yet pinned by a fixture).
  resolveArtifactPaths: resolveContinueHtmlPaths,
  readArtifacts: async (env) => {
    const home = env.baseDir || join(homedir(), ".continue");
    // prefer config.yaml; fall back to the legacy config.json when yaml is absent.
    const configFile = ["config.yaml", "config.json"].map((f) => join(home, f)).find(existsSync) ?? join(home, "config.yaml");
    return readContinueArtifacts({ configFile });
  },
};

// Cursor's global session DB. macOS default; baseDir overrides for tests (points at a dir holding state.vscdb).
function cursorDbPath(baseDir?: string): string {
  return baseDir
    ? join(baseDir, "state.vscdb")
    : join(homedir(), "Library", "Application Support", "Cursor", "User", "globalStorage", "state.vscdb");
}

const cursorSource: SourceSpec = {
  id: "cursor", label: "Cursor", traits: { storage: "sqlite" },
  roots: (env) => [cursorDbPath(env.baseDir)],
  scanSessions: async (roots) => (await Promise.all(roots.map((r) => scanCursorSessions(r)))).flat(),
  readArtifacts: async (env) => {
    // .cursor/rules, .cursorrules, and AGENTS.md are per-repo (out of scope here); only mcp.json
    // has a meaningful global config-home.
    const home = env.baseDir || join(homedir(), ".cursor");
    return readCursorArtifacts({ mcpFile: join(home, "mcp.json") });
  },
};

export const BUILTIN_SOURCES: SourceSpec[] = [claudeSource, codexSource, clineSource, geminiSource, continueSource, cursorSource];
