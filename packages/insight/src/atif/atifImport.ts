// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
//
// ATIF trajectory → AgentGem session model. parseAtifMeta mirrors
// parseClaudeTranscript (metadata only, never keeps text); atifSessionEvents
// mirrors claudeSessionEvents (ordered, unfolded, every string scrubbed).
// Timestamps are optional in ATIF: absent → startMs/endMs are 0 and the
// SourceSpec scanner backfills file mtime (parsers are fs-free).
import { basename } from "node:path";
import { scrubTruncate } from "../scrub.js";
import type { SessionStat } from "../observeAggregate.js";
import type { SessionEvent, SessionEventSpan } from "../inspectSession.js";
import { parseAtifDocument, flattenAtifContent, type AtifTrajectory, type AtifStep } from "./atifTypes.js";

export function atifSessionId(doc: AtifTrajectory, path: string): string {
  return doc.trajectory_id ?? doc.session_id ?? basename(path).replace(/\.json$/, "");
}

function stepMs(step: AtifStep): number {
  const ts = typeof step.timestamp === "string" ? Date.parse(step.timestamp) : NaN;
  return Number.isNaN(ts) ? 0 : ts;
}

export function parseAtifMeta(text: string, path: string): SessionStat | null {
  const doc = parseAtifDocument(text);
  if (!doc) return null;
  let startMs = Infinity, endMs = -Infinity, msgs = 0;
  let sumIn = 0, sumOut = 0, sumCache = 0;
  for (const step of doc.steps) {
    const ms = stepMs(step);
    if (ms > 0) { startMs = Math.min(startMs, ms); endMs = Math.max(endMs, ms); }
    if (step.source !== "system") msgs++;
    const m = step.metrics;
    if (m) {
      const cached = m.cached_tokens ?? 0;
      sumIn += Math.max(0, (m.prompt_tokens ?? 0) - cached);
      sumOut += m.completion_tokens ?? 0;
      sumCache += cached;
    }
  }
  const fm = doc.final_metrics;
  // Cache falls back to the per-step sum even when final_metrics exists but
  // omits total_cached_tokens, and tokensIn is always net of that same cache
  // value — so "fresh input" means the same thing on both paths.
  const cache = fm?.total_cached_tokens ?? sumCache;
  const tokensIn = fm ? Math.max(0, (fm.total_prompt_tokens ?? 0) - cache) : sumIn;
  const tokensOut = fm?.total_completion_tokens ?? sumOut;
  const cwd = (doc.extra as Record<string, unknown> | undefined)?.cwd;
  return {
    agent: "atif",
    sessionId: atifSessionId(doc, path),
    project: typeof cwd === "string" ? basename(cwd) : null,
    cwd: typeof cwd === "string" ? cwd : null,   // SessionStat.cwd (repo-owner attribution parity)
    model: doc.agent.model_name ?? null,
    gitBranch: null,
    startMs: startMs === Infinity ? 0 : startMs,
    endMs: endMs === -Infinity ? 0 : endMs,
    msgs, tokensIn, tokensOut, tokensCache: cache,
  };
}

export function atifSessionEvents(text: string, path: string): SessionEvent[] {
  const doc = parseAtifDocument(text);
  if (!doc) return [];
  void path;
  const out: SessionEvent[] = [];
  let lastMs = 0;
  for (const step of doc.steps) {
    if (step.source === "system") continue;
    const ms = stepMs(step) || lastMs;
    lastMs = ms;
    const push = (span: SessionEventSpan) => out.push({ tsMs: ms, span });
    const role = step.source === "user" ? "user" as const : "assistant" as const;
    const txt = flattenAtifContent(step.message);
    if (txt.trim()) push({ kind: "message", role, text: scrubTruncate(txt) });
    if (typeof step.reasoning_content === "string" && step.reasoning_content.trim()) {
      push({ kind: "message", role: "assistant", text: scrubTruncate(step.reasoning_content) });
    }
    for (const call of step.tool_calls ?? []) {
      let input: string; try { input = JSON.stringify(call.arguments); } catch { input = String(call.arguments); }
      push({ kind: "tool_call", toolId: call.tool_call_id ?? null, name: call.function_name, input: scrubTruncate(input) });
    }
    for (const res of step.observation?.results ?? []) {
      push({ kind: "tool_result", toolId: res.source_call_id ?? null, output: scrubTruncate(flattenAtifContent(res.content)), error: false });
    }
  }
  return out;
}
