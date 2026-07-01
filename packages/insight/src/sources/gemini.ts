// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
//
// Gemini CLI ingestion. Session files are append-only JSONL that MIX a header line, message
// lines, and mutation lines ($rewindTo / $set). To count messages + sum tokens correctly we
// replay the CLI's own fold: an insertion-ordered Map<id,msg>; a re-set id overwrites in place;
// $rewindTo deletes from the id inclusive; $set.messages is a checkpoint replace. Metadata only —
// never reads `content`. Total: malformed lines are skipped, a malformed file yields null.
import { readFile } from "node:fs/promises";
import { readdirSync } from "node:fs";
import { basename, join, relative, sep } from "node:path";
import { firstPackage, isPublicNpm } from "@agentgem/model";
import type { GemArtifact, McpServerArtifact, ReferenceArtifact } from "@agentgem/model";
import type { SessionStat } from "../observeAggregate.js";
import type { ImportResult } from "../sources.js";

interface GemTokens { input?: number; output?: number; cached?: number; thoughts?: number; tool?: number; total?: number }
interface GemMsg { id: string; timestamp?: string; type?: string; model?: string; tokens?: GemTokens }

function* lines(text: string): Generator<Record<string, unknown>> {
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try { yield JSON.parse(line) as Record<string, unknown>; } catch { /* skip malformed */ }
  }
}

export function parseGeminiSession(jsonl: string, fallbackSessionId: string, project: string | null): SessionStat | null {
  const map = new Map<string, GemMsg>();       // insertion-ordered survivors
  let sessionId = "", model: string | null = null;
  for (const rec of lines(jsonl)) {
    if (typeof rec.$rewindTo === "string") {    // drop the id AND everything after it
      const target = rec.$rewindTo;
      if (!map.has(target)) { map.clear(); continue; }
      let seen = false;
      for (const id of [...map.keys()]) { if (id === target) seen = true; if (seen) map.delete(id); }
      continue;
    }
    if (rec.$set && typeof rec.$set === "object") {    // metadata; a messages[] payload is a checkpoint replace
      const set = rec.$set as Record<string, unknown>;
      if (Array.isArray(set.messages)) { map.clear(); for (const m of set.messages as GemMsg[]) if (m && typeof m.id === "string") map.set(m.id, m); }
      continue;
    }
    if (typeof rec.sessionId === "string" && typeof rec.projectHash === "string") { sessionId = rec.sessionId; continue; } // header
    if (typeof rec.id === "string") {                  // message record
      const m = rec as unknown as GemMsg;
      map.set(m.id, m);
    }
  }
  const msgsArr = [...map.values()].filter((m) => m.type === "user" || m.type === "gemini");
  if (msgsArr.length === 0) return null;
  let startMs = Infinity, endMs = -Infinity, tokensIn = 0, tokensOut = 0, tokensCache = 0;
  for (const m of msgsArr) {
    if (m.type === "gemini" && typeof m.model === "string") model = m.model;
    const ts = m.timestamp ? Date.parse(m.timestamp) : NaN;
    if (!Number.isNaN(ts)) { startMs = Math.min(startMs, ts); endMs = Math.max(endMs, ts); }
    if (m.type === "gemini" && m.tokens) {
      const t = m.tokens;
      tokensIn += Math.max(0, (t.input ?? 0) - (t.cached ?? 0));
      tokensOut += (t.output ?? 0) + (t.thoughts ?? 0);
      tokensCache += t.cached ?? 0;
    }
  }
  if (endMs < startMs) return null;
  return { agent: "gemini", sessionId: sessionId || fallbackSessionId, project, model, gitBranch: null, startMs, endMs, msgs: msgsArr.length, tokensIn, tokensOut, tokensCache };
}

// Derive the <slug> project from a `~/.gemini/tmp/<slug>/chats/...` path.
function slugOf(path: string): string | null {
  const m = path.match(/[/\\]tmp[/\\]([^/\\]+)[/\\]chats[/\\]/);
  return m ? m[1] : null;
}

export async function scanGeminiSessions(files: string[]): Promise<SessionStat[]> {
  const out: SessionStat[] = [];
  for (const f of files) {
    let text: string; try { text = await readFile(f, "utf8"); } catch { continue; }
    const fallback = basename(f).replace(/^session-/, "").replace(/\.jsonl$/, "");
    const s = parseGeminiSession(text, fallback, slugOf(f)); if (s) out.push(s);
  }
  return out;
}

// Artifact (authoring) face: GEMINI.md -> instructions, settings.json mcpServers -> mcp_server /
// package reference (mirrors cline.ts's classifier), commands/**/*.toml -> namespaced skills.
// firstPackage/isPublicNpm from @agentgem/model so every source adapter shares one classifier.
// Secret-bearing `env` is never ingested (redacted allowlist copy of command/args/url only).

// No TOML parser is a declared dependency of @agentgem/insight or its deps (checked: smol-toml
// appears in the lockfile only as a transitive dep of unrelated `vercel` CLI tooling, not
// resolvable here under pnpm's strict node_modules). So: a minimal field reader for the two
// known command fields (prompt/description), handling TOML basic ("..."), multi-line basic
// ("""..."""), and literal ('''...''') strings. Does not handle arbitrary TOML (tables, arrays,
// nested escapes beyond \" \n \\) — sufficient for Gemini's flat command files.
function tomlField(text: string, key: string): string | null {
  const triple = text.match(new RegExp(`${key}\\s*=\\s*("""|''')([\\s\\S]*?)\\1`));
  if (triple) return triple[2];
  const basic = text.match(new RegExp(`${key}\\s*=\\s*"((?:[^"\\\\]|\\\\.)*)"`));
  if (basic) return basic[1].replace(/\\"/g, '"').replace(/\\n/g, "\n").replace(/\\\\/g, "\\");
  return null;
}

function commandName(commandsDir: string, file: string): string {
  return relative(commandsDir, file).replace(/\.toml$/i, "").split(sep).join(":");
}

function listToml(dir: string): string[] {
  const out: string[] = [];
  let entries: import("node:fs").Dirent[]; try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...listToml(p));
    else if (e.name.toLowerCase().endsWith(".toml")) out.push(p);
  }
  return out;
}

export async function readGeminiArtifacts(env: { contextFile?: string; settingsFile?: string; commandsDir?: string }): Promise<ImportResult> {
  const artifacts: GemArtifact[] = [];
  let model: string | undefined;

  if (env.contextFile) {
    try { const c = await readFile(env.contextFile, "utf8"); if (c.trim()) artifacts.push({ type: "instructions", name: "gemini", content: c }); } catch { /* absent */ }
  }
  if (env.settingsFile) {
    try {
      const s = JSON.parse(await readFile(env.settingsFile, "utf8")) as { model?: { name?: string }; mcpServers?: Record<string, { command?: string; args?: unknown; env?: unknown; url?: string; httpUrl?: string }> };
      if (typeof s.model?.name === "string") model = s.model.name;
      for (const [name, cfg] of Object.entries(s.mcpServers ?? {})) {
        const pkg = firstPackage(cfg.args);
        if (cfg.command === "npx" && pkg && isPublicNpm(pkg)) {
          artifacts.push({ type: "reference", name, refKind: "mcp_server", ref: { kind: "package", id: `npx:${pkg}` } } satisfies ReferenceArtifact);
        } else {
          const url = cfg.url ?? cfg.httpUrl;
          const server: McpServerArtifact = { type: "mcp_server", name, transport: url ? "http" : "stdio", config: url ? { url } : { command: cfg.command, args: cfg.args } };  // env redacted (allowlist copy)
          artifacts.push(server);
        }
      }
    } catch { /* absent/malformed */ }
  }
  if (env.commandsDir) {
    for (const file of listToml(env.commandsDir)) {
      let text: string; try { text = await readFile(file, "utf8"); } catch { continue; }
      const prompt = tomlField(text, "prompt");
      if (prompt == null) continue;                              // prompt is required
      const skill = { type: "skill" as const, name: commandName(env.commandsDir, file), source: "gemini-command", content: prompt };
      const desc = tomlField(text, "description"); if (desc != null) (skill as { description?: string }).description = desc;
      artifacts.push(skill);
    }
  }
  const binding = { agent: "gemini", origin: "imported" as const, ...(model ? { model } : {}) };
  return { artifacts, binding };
}
