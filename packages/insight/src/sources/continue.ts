// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
//
// Continue.dev ingestion. Sessions are plain JSON: an index (sessions.json) of metadata + one
// <sessionId>.json per session carrying history + an optional `usage` token block + chatModelTitle.
// Continue records NO per-message timestamp, so start time comes from the index `dateCreated`
// (ms-epoch) and end time from the session file mtime. Metadata only — never reads message
// `content` and never the session `title` (a content-derived summary). Total: malformed → null/skip.
import { readFile, readdir, stat } from "node:fs/promises";
import { statSync } from "node:fs";
import { join, basename, isAbsolute, resolve } from "node:path";
import { parse as parseYaml } from "yaml";
import { classifyMcpServer } from "@agentgem/model";
import type { GemArtifact } from "@agentgem/model";
import type { SessionStat } from "../observeAggregate.js";
import type { ImportResult } from "../sources.js";

interface CUsage { promptTokens?: number; completionTokens?: number; promptTokensDetails?: { cachedTokens?: number } }
interface CSession { sessionId?: string; workspaceDirectory?: string; chatModelTitle?: string | null;
  history?: { message?: { role?: string; usage?: CUsage } }[]; usage?: CUsage }

const n = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);

function tokensFrom(u: CUsage | undefined): { in: number; out: number; cache: number } {
  const cache = n(u?.promptTokensDetails?.cachedTokens);
  return { in: Math.max(0, n(u?.promptTokens) - cache), out: n(u?.completionTokens), cache };
}

export function parseContinueSession(
  sessionJson: string,
  meta: { dateCreated?: string; messageCount?: number; mtimeMs: number },
): SessionStat | null {
  let s: CSession;
  try { s = JSON.parse(sessionJson) as CSession; } catch { return null; }
  if (!s || typeof s !== "object") return null;
  const history = Array.isArray(s.history) ? s.history : [];
  const msgs = meta.messageCount ?? history.filter((h) => h.message?.role === "user" || h.message?.role === "assistant").length;
  if (msgs === 0 && !s.sessionId) return null;

  let tIn = 0, tOut = 0, tCache = 0;
  if (s.usage) { const t = tokensFrom(s.usage); tIn = t.in; tOut = t.out; tCache = t.cache; }
  else for (const h of history) if (h.message?.role === "assistant" && h.message.usage) { const t = tokensFrom(h.message.usage); tIn += t.in; tOut += t.out; tCache += t.cache; }

  let startMs = meta.dateCreated ? parseInt(meta.dateCreated, 10) : meta.mtimeMs;
  if (Number.isNaN(startMs)) startMs = meta.mtimeMs;
  const endMs = Math.max(meta.mtimeMs, startMs);
  return {
    agent: "continue", sessionId: s.sessionId ?? "", project: s.workspaceDirectory ? basename(s.workspaceDirectory) : null,
    model: s.chatModelTitle ?? null, gitBranch: null,
    startMs, endMs, msgs, tokensIn: tIn, tokensOut: tOut, tokensCache: tCache,
  };
}

// ── Watch capabilities ────────────────────────────────────────────────────────
// One session = one <sessionId>.json file. parseMeta stats the file for the end
// time (Continue records no per-message timestamps) and falls back to the filename
// for the id.
export function parseContinueMeta(text: string, path: string): SessionStat | null {
  let mtimeMs = 0; try { mtimeMs = statSync(path).mtimeMs; } catch { /* just written */ }
  const s = parseContinueSession(text, { mtimeMs });
  if (s && !s.sessionId) s.sessionId = basename(path, ".json");
  return s;
}

// File-driven detector: Continue's edit tools reference the target file by an
// ABSOLUTE path in a `filepath` / `file_path` / `absolute_path` arg, so we surface
// those *.html paths and let the live layer render the real file on disk. Continue
// stores toolCalls with `arguments` as a JSON STRING, so the field's quotes are often
// escaped (\"filepath\") — the `\\?"` fragments tolerate both the escaped and plain
// forms. Provisional: the exact tool-arg shape isn't pinned by a fixture yet, so
// relative paths and other field names degrade to "nothing to show", never a wrong
// render.
const CONTINUE_FILE_PATH = /\\?"(?:filepath|file_path|absolute_path)\\?"\s*:\s*\\?"((?:[^"\\]|\\.)*?\.html?)(?=\\?")/gi;

export function resolveContinueHtmlPaths(text: string): string[] {
  const seen = new Set<string>();
  const order: string[] = [];
  for (const m of text.matchAll(CONTINUE_FILE_PATH)) {
    const p = m[1].replace(/\\(.)/g, "$1");
    if (!isAbsolute(p)) continue;
    const abs = resolve(p);
    if (!seen.has(abs)) { seen.add(abs); order.push(abs); }
  }
  return order;
}

export async function scanContinueSessions(sessionsDir: string): Promise<SessionStat[]> {
  let indexRaw: string;
  try { indexRaw = await readFile(join(sessionsDir, "sessions.json"), "utf8"); } catch { return []; }
  let index: { sessionId?: string; dateCreated?: string; messageCount?: number }[];
  try { index = JSON.parse(indexRaw) as typeof index; } catch { return []; }
  if (!Array.isArray(index)) return [];
  const byId = new Map(index.filter((e) => e && typeof e.sessionId === "string").map((e) => [e.sessionId!, e]));

  const out: SessionStat[] = [];
  let files: string[]; try { files = (await readdir(sessionsDir)).filter((f) => f.endsWith(".json") && f !== "sessions.json"); } catch { return out; }
  for (const f of files) {
    const path = join(sessionsDir, f);
    let text: string, mtimeMs: number;
    try { text = await readFile(path, "utf8"); mtimeMs = (await stat(path)).mtimeMs; } catch { continue; }
    const id = basename(f, ".json");
    const e = byId.get(id);
    const stat_ = parseContinueSession(text, { dateCreated: e?.dateCreated, messageCount: e?.messageCount, mtimeMs });
    if (stat_) { if (!stat_.sessionId) stat_.sessionId = id; out.push(stat_); }
  }
  return out;
}

// Artifact (authoring) face: config.yaml (or legacy config.json — parseYaml reads both, since JSON
// is valid YAML) -> mcpServers/rules/prompts. Unlike Cline/Gemini, Continue's mcpServers is an
// ARRAY of {name, ...} rather than an object-map. Public npx servers become a package reference;
// everything else stays a redacted McpServerArtifact — secret-bearing `env` is never ingested
// (allowlist copy of command/args/url only). classifyMcpServer from @agentgem/model so every
// source adapter shares one classifier.

interface CConfig {
  models?: { name?: string; model?: string; roles?: string[] }[];
  mcpServers?: { name?: string; command?: string; args?: unknown; env?: unknown; url?: string; type?: string }[];
  rules?: (string | { name?: string; rule?: string })[];
  prompts?: { name?: string; prompt?: string; description?: string }[];
}

export async function readContinueArtifacts(env: { configFile?: string }): Promise<ImportResult> {
  const artifacts: GemArtifact[] = [];
  let model: string | undefined;
  if (env.configFile) {
    try {
      const cfg = (parseYaml(await readFile(env.configFile, "utf8")) ?? {}) as CConfig;   // parseYaml also handles JSON

      // model for the binding: the chat-role model's id, else the first model's id.
      const chat = (cfg.models ?? []).find((m) => Array.isArray(m.roles) && m.roles.includes("chat")) ?? (cfg.models ?? [])[0];
      if (chat && typeof chat.model === "string") model = chat.model;

      // Each of these is unvalidated YAML shape: a scalar (e.g. bare `rules: "..."` string) would
      // make for...of iterate CHARACTERS, not entries — guard every one with Array.isArray.
      for (const srv of Array.isArray(cfg.mcpServers) ? cfg.mcpServers : []) {
        if (!srv || typeof srv.name !== "string") continue;
        artifacts.push(classifyMcpServer(srv.name, srv));
      }
      let ri = 0;
      for (const r of Array.isArray(cfg.rules) ? cfg.rules : []) {
        if (typeof r === "string") { if (r.trim()) artifacts.push({ type: "instructions", name: `rule-${++ri}`, content: r }); }
        else if (r && typeof r.rule === "string") artifacts.push({ type: "instructions", name: r.name ?? `rule-${++ri}`, content: r.rule });
      }
      for (const p of Array.isArray(cfg.prompts) ? cfg.prompts : []) {
        if (p && typeof p.name === "string" && typeof p.prompt === "string") {
          artifacts.push({
            type: "skill", name: p.name, source: "continue-prompt", content: p.prompt,
            ...(typeof p.description === "string" ? { description: p.description } : {}),
          });
        }
      }
    } catch { /* absent/malformed */ }
  }
  const binding = { agent: "continue", origin: "imported" as const, ...(model ? { model } : {}) };
  return { artifacts, binding };
}
