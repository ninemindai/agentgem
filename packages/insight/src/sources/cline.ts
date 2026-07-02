// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
//
// Cline / Roo task ingestion. Clean flat JSON (contrast Cursor's SQLite): each task dir holds
// ui_messages.json (UI timeline). Usage lives in say:"api_req_started" whose .text is a
// JSON-STRINGIFIED ClineApiReqInfo (parse twice). Metadata only — never message text.
import { readFile } from "node:fs/promises";
import { join, basename } from "node:path";
import type { SessionStat } from "../observeAggregate.js";
import type { GemArtifact } from "@agentgem/model";
import { classifyMcpServer } from "@agentgem/model";
import type { ImportResult } from "../sources.js";

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
