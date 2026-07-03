// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
//
// Cline / Roo task ingestion. Clean flat JSON (contrast Cursor's SQLite): each task dir holds
// ui_messages.json (UI timeline). Usage lives in say:"api_req_started" whose .text is a
// JSON-STRINGIFIED ClineApiReqInfo (parse twice). Metadata only — never message text.
import { readFile } from "node:fs/promises";
import { join, basename, dirname } from "node:path";
import type { SessionStat } from "../observeAggregate.js";
import type { GemArtifact } from "@agentgem/model";
import { classifyMcpServer } from "@agentgem/model";
import type { ImportResult } from "../sources.js";
import type { HtmlArtifactVersion } from "../artifactScan.js";

interface ClineMsg { ts?: number; type?: string; say?: string; text?: string }

export function parseClineTask(uiMessagesJson: string, taskId: string): SessionStat | null {
  let msgs: ClineMsg[];
  try { msgs = JSON.parse(uiMessagesJson) as ClineMsg[]; } catch { return null; }
  if (!Array.isArray(msgs) || msgs.length === 0) return null;
  let startMs = Infinity, endMs = -Infinity, count = 0, tokensIn = 0, tokensOut = 0, tokensCache = 0;
  for (const m of msgs) {
    if (typeof m.ts === "number") { startMs = Math.min(startMs, m.ts); endMs = Math.max(endMs, m.ts); }
    if (m.type === "say" && m.say === "text") count++;
    if (m.say === "api_req_started" && typeof m.text === "string") {
      try {
        const info = JSON.parse(m.text) as Record<string, number>;
        tokensIn += info.tokensIn ?? 0;
        tokensOut += info.tokensOut ?? 0;
        tokensCache += (info.cacheReads ?? 0) + (info.cacheWrites ?? 0);
      } catch { /* skip malformed api_req_started */ }
    }
  }
  if (endMs < startMs) return null;
  return { agent: "cline", sessionId: taskId, project: null, model: null, gitBranch: null, startMs, endMs, msgs: count, tokensIn, tokensOut, tokensCache };
}

export async function scanClineSessions(taskDirs: string[]): Promise<SessionStat[]> {
  const out: SessionStat[] = [];
  for (const dir of taskDirs) {
    let text: string; try { text = await readFile(join(dir, "ui_messages.json"), "utf8"); } catch { continue; }
    const s = parseClineTask(text, basename(dir)); if (s) out.push(s);
  }
  return out;
}

// ── Watch capabilities ────────────────────────────────────────────────────────
// The watched file is <taskDir>/ui_messages.json; the session id is the task dir name.
export function parseClineMeta(text: string, path: string): SessionStat | null {
  return parseClineTask(text, basename(dirname(path)));
}

// Cline records file mutations as ui_messages entries whose `.text` is a JSON string
// carrying { tool, path, content } — critically, the FULL file content is present for
// creates/edits (like Claude's Write), so Cline is transcript-driven: we reconstruct
// snapshots directly. We key on "a path ending in .html + a string content" rather
// than a specific tool name, so it's robust to Cline/Roo's tool-name variants
// (newFileCreated / editedExistingFile / write_to_file / …). Consecutive identical
// content for a path is de-duplicated so the ask→say pair doesn't double a version.
export function detectClineArtifacts(text: string): HtmlArtifactVersion[] {
  let msgs: unknown;
  try { msgs = JSON.parse(text); } catch { return []; }
  if (!Array.isArray(msgs)) return [];

  const counts = new Map<string, number>();
  const last = new Map<string, string>();
  const out: HtmlArtifactVersion[] = [];
  for (const m of msgs) {
    const rec = m as { ts?: unknown; text?: unknown };
    if (typeof rec.text !== "string") continue;
    let payload: Record<string, unknown>;
    try { payload = JSON.parse(rec.text) as Record<string, unknown>; } catch { continue; }
    if (!payload || typeof payload !== "object") continue;
    const path = payload.path, content = payload.content;
    if (typeof path !== "string" || !/\.html?$/i.test(path.trim())) continue;
    if (typeof content !== "string") continue;
    if (last.get(path) === content) continue;            // skip the ask/say duplicate
    last.set(path, content);
    const version = (counts.get(path) ?? 0) + 1;
    counts.set(path, version);
    out.push({
      path, html: content,
      tool: typeof payload.tool === "string" ? payload.tool : "cline",
      tsMs: typeof rec.ts === "number" ? rec.ts : null,
      version,
    });
  }
  return out;
}

// Artifact (authoring) face: .clinerules -> instructions, cline_mcp_settings.json -> mcp_server /
// package reference. Public npx packages are referenced (not embedded); everything else is kept
// as a redacted McpServerArtifact — secret-bearing `env` is never ingested.
// classifyMcpServer hoisted to @agentgem/model (packages/model/src/publicPackage.ts) so every
// source adapter shares one classifier.

export async function readClineArtifacts(env: { rulesFile?: string; mcpSettingsFile?: string }): Promise<ImportResult> {
  const artifacts: GemArtifact[] = [];
  if (env.rulesFile) {
    try {
      const content = await readFile(env.rulesFile, "utf8");
      if (content.trim()) artifacts.push({ type: "instructions", name: "clinerules", content });
    } catch { /* absent */ }
  }
  if (env.mcpSettingsFile) {
    try {
      const raw = JSON.parse(await readFile(env.mcpSettingsFile, "utf8")) as { mcpServers?: Record<string, { command?: string; args?: unknown; env?: Record<string, unknown>; url?: string }> };
      for (const [name, cfg] of Object.entries(raw.mcpServers ?? {})) {
        artifacts.push(classifyMcpServer(name, cfg));
      }
    } catch { /* absent/malformed */ }
  }
  return { artifacts, binding: { agent: "cline", origin: "imported" } };
}
