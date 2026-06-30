// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
// packages/insight/src/judgeSession.ts
//
// Drives a local ACP coding agent (Claude, plan mode / read-only) over the
// mission hints of a WorkflowSignal to produce one SessionFacet per session — a
// typed judgment of goal + outcome + friction. Batched: every missioned session
// goes in one prompt. Never throws: short-circuits to [] when nothing is
// missioned, degrades to deterministicFacets on agent error. The signal is the
// source of truth for which sessions exist (validateFacets enforces it).
// Mirrors recommendWorkflow / distillWorkflow in acpRecommender.ts.
import type { WorkflowSignal } from "./workflowScan.js";
import type { SessionFacet } from "./facets.js";
import { deterministicFacets, validateFacets } from "./facets.js";
import {
  type AcpConnectFn, type AcpCtx, type AcpSessionHandle,
  CLAUDE_AGENT, analysisWorkspace, currentTestConnectFn, defaultConnectFn,
} from "./acpRecommender.js";

const JUDGE = (sessionsJson: string) =>
  `You are analysing a developer's past coding-agent sessions. For EACH session below, ` +
  `judge what the user was trying to accomplish and how it went.\n` +
  `SESSIONS (goal = the user's first request; result = the agent's final message):\n${sessionsJson}\n\n` +
  `For each session return a facet:\n` +
  `- underlying_goal: one sentence — what the user actually wanted.\n` +
  `- brief_summary: one sentence — what happened.\n` +
  `- outcome: one of "mostly_achieved" | "partially_achieved" | "not_achieved".\n` +
  `- friction_detail: one sentence on what slowed it down, or "" if none.\n` +
  `Return ONLY a JSON object: {"facets":[{"sessionId","underlying_goal","outcome",` +
  `"friction_detail","brief_summary"}]}. Use the exact sessionId values given; do not invent sessions.`;

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return Promise.race([p, new Promise<T>((_, rej) => setTimeout(() => rej(new Error(`agent timeout after ${ms}ms`)), ms))]);
}

/**
 * Judge every missioned session in `signal`. Never throws. Returns degraded:true
 * only when the agent call itself failed (an unusable response still yields
 * deterministic facets with degraded:false — the call succeeded).
 */
// Default cap on sessions sent to the agent in one batch. Bounds prompt size on
// projects with hundreds of sessions; we judge the most-recent ones. Tuned to
// fit ONE agent pass within its timeout — at 50, judging "All projects" timed
// out (~58s vs the 60s default) and the whole report degraded to neutral. 20
// completes comfortably; chunking is the durable fix for full coverage.
export const DEFAULT_MAX_JUDGE = 20;

export async function judgeSessions(
  signal: WorkflowSignal,
  opts: { connectFn?: AcpConnectFn; timeoutMs?: number; maxSessions?: number; onDelta?: (chunk: string) => void } = {},
): Promise<{ facets: SessionFacet[]; degraded: boolean }> {
  const allMissioned = (signal.sequences?.sessions ?? []).filter((s) => s.missionHint);
  if (!allMissioned.length) return { facets: [], degraded: false };   // nothing to judge — agent never invoked
  // Cap to the most-recent N and trim the signal so every downstream consumer
  // (payload, validateFacets, deterministicFacets) sees the same judged set.
  const max = opts.maxSessions ?? DEFAULT_MAX_JUDGE;
  const selected = [...allMissioned].sort((a, b) => b.atMs - a.atMs).slice(0, max);
  signal = { ...signal, sequences: { root: signal.sequences!.root, sessions: selected } };
  const missioned = selected;

  const connectFn = opts.connectFn ?? currentTestConnectFn() ?? defaultConnectFn;
  // A multi-session judge prompt reasons over every session at once; observed
  // ~58s even for 20 sessions, blowing a 60s deadline and degrading the whole
  // report. Give the single pass real room (chunking is the durable fix).
  const timeoutMs = opts.timeoutMs ?? 180_000;
  let conn: { ctx: AcpCtx; close: () => void } | null = null;
  let handle: AcpSessionHandle | null = null;
  try {
    const payload = missioned.map((s) => ({ sessionId: s.sessionId, goal: s.missionHint!.task, result: s.missionHint!.outcome }));
    const prompt = JUDGE(JSON.stringify(payload));
    // One shared deadline across connect + open + setMode + prompt (the ACP
    // handshake is otherwise unbounded). Mirrors recommendWorkflow.
    const deadline = Date.now() + timeoutMs;
    const left = () => Math.max(0, deadline - Date.now());
    conn = await withTimeout(connectFn(CLAUDE_AGENT, null), left());
    handle = await withTimeout(conn.ctx.open(analysisWorkspace()), left());  // neutral cwd — don't pollute the project
    await withTimeout(handle.setMode("plan"), left());                       // explicit — never edits files
    const text = await withTimeout(handle.promptText(prompt, opts.onDelta), left());
    return { facets: validateFacets(text, signal), degraded: false };
  } catch (err) {
    console.error("insights: session judge fell back to heuristic:", (err as Error).message);
    return { facets: deterministicFacets(signal), degraded: true };
  } finally {
    try { handle?.dispose(); } catch { /* ignore */ }
    try { conn?.close(); } catch { /* ignore */ }
  }
}
