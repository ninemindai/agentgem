// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
//
// ATIF trajectory → TranscriptView (the Inspect drill-down shape). One turn per
// non-system step; observation results pair onto tool_call spans by
// source_call_id (mirror of parseClaudeTranscriptView pass 1). Scrub boundary
// identical to atifImport.
import { join } from "node:path";
import { agentgemHome } from "@agentgem/model";
import { scrubTruncate } from "../scrub.js";
import type { TranscriptSpan, TranscriptTurn, TranscriptView, TokenBreakdown } from "../inspectSession.js";
import { parseAtifDocument, flattenAtifContent, type AtifStep } from "./atifTypes.js";
import { parseAtifMeta } from "./atifImport.js";

/** The drop directory the atif source scans: <agentgemHome>/atif (baseDir = test
 *  override pointing at an alternative drop dir directly). */
export function atifDropDir(baseDir?: string): string {
  return baseDir ?? join(agentgemHome(), "atif");
}

function stepTokens(step: AtifStep): TokenBreakdown {
  const m = step.metrics;
  if (!m) return { in: 0, out: 0, cache: 0 };
  const cache = m.cached_tokens ?? 0;
  return { in: Math.max(0, (m.prompt_tokens ?? 0) - cache), out: m.completion_tokens ?? 0, cache };
}

export function parseAtifTranscriptView(text: string, path: string): TranscriptView | null {
  const doc = parseAtifDocument(text);
  const meta = parseAtifMeta(text, path);
  if (!doc || !meta) return null;
  const turns: TranscriptTurn[] = [];
  let lastMs = meta.startMs;
  for (const step of doc.steps) {
    if (step.source === "system") continue;
    const role = step.source === "user" ? "user" as const : "assistant" as const;
    const ts = typeof step.timestamp === "string" ? Date.parse(step.timestamp) : NaN;
    const tsMs = Number.isNaN(ts) ? lastMs : ts;
    lastMs = tsMs;
    const spans: TranscriptSpan[] = [];
    const txt = flattenAtifContent(step.message);
    if (txt.trim()) spans.push({ kind: "message", role, text: scrubTruncate(txt) });
    if (typeof step.reasoning_content === "string" && step.reasoning_content.trim()) {
      spans.push({ kind: "message", role: "assistant", text: scrubTruncate(step.reasoning_content) });
    }
    const outputs = new Map<string, string>();
    for (const res of step.observation?.results ?? []) {
      if (typeof res.source_call_id === "string") outputs.set(res.source_call_id, flattenAtifContent(res.content));
    }
    for (const call of step.tool_calls ?? []) {
      let input: string; try { input = JSON.stringify(call.arguments); } catch { input = String(call.arguments); }
      const out = outputs.get(call.tool_call_id);
      spans.push({
        kind: "tool_call", name: call.function_name, input: scrubTruncate(input),
        ...(out !== undefined ? { output: scrubTruncate(out) } : {}),
      });
    }
    if (!spans.length) continue;
    turns.push({ id: `${meta.sessionId}-${step.step_id}`, role, tsMs, spans, tokens: stepTokens(step) });
  }
  return { sessionId: meta.sessionId, agent: "atif", meta, turns };
}
