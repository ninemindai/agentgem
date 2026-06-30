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
import type { WorkflowSignal, SessionSequence } from "./workflowScan.js";
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

// Total cap on sessions judged (most-recent first). Bounds cost on projects with
// hundreds of sessions. Chunked (below) so each agent call stays small.
export const DEFAULT_MAX_JUDGE = 30;
// Sessions per agent call. A multi-session judge prompt reasons over every session
// at once and scales with batch size — at ~20 it neared a 60s deadline. Small
// chunks each complete comfortably; coverage scales by judging several chunks.
export const JUDGE_CHUNK_SIZE = 10;

// Judge ONE batch of sessions in a single agent call. Never throws: a failed call
// degrades to deterministicFacets for THIS batch only. `subSignal` is the
// authoritative source for validateFacets (only these sessions exist to it).
async function judgeBatch(
  subSignal: WorkflowSignal, sessions: SessionSequence[],
  connectFn: AcpConnectFn, timeoutMs: number, onDelta?: (chunk: string) => void,
): Promise<{ facets: SessionFacet[]; degraded: boolean }> {
  let conn: { ctx: AcpCtx; close: () => void } | null = null;
  let handle: AcpSessionHandle | null = null;
  try {
    const payload = sessions.map((s) => ({ sessionId: s.sessionId, goal: s.missionHint!.task, result: s.missionHint!.outcome }));
    const prompt = JUDGE(JSON.stringify(payload));
    const deadline = Date.now() + timeoutMs;
    const left = () => Math.max(0, deadline - Date.now());
    conn = await withTimeout(connectFn(CLAUDE_AGENT, null), left());
    handle = await withTimeout(conn.ctx.open(analysisWorkspace()), left());  // neutral cwd — don't pollute the project
    await withTimeout(handle.setMode("plan"), left());                       // explicit — never edits files
    const text = await withTimeout(handle.promptText(prompt, onDelta), left());
    return { facets: validateFacets(text, subSignal), degraded: false };
  } catch (err) {
    console.error("insights: session judge chunk fell back to heuristic:", (err as Error).message);
    return { facets: deterministicFacets(subSignal), degraded: true };
  } finally {
    try { handle?.dispose(); } catch { /* ignore */ }
    try { conn?.close(); } catch { /* ignore */ }
  }
}

/**
 * Judge the most-recent missioned sessions in `signal`, in chunks so each agent
 * call stays small + reliable. Never throws. degraded:true if ANY chunk's agent
 * call failed (that chunk's sessions get deterministic facets; the rest succeed).
 */
export async function judgeSessions(
  signal: WorkflowSignal,
  opts: { connectFn?: AcpConnectFn; timeoutMs?: number; maxSessions?: number; chunkSize?: number; onDelta?: (chunk: string) => void } = {},
): Promise<{ facets: SessionFacet[]; degraded: boolean }> {
  const allMissioned = (signal.sequences?.sessions ?? []).filter((s) => s.missionHint);
  if (!allMissioned.length) return { facets: [], degraded: false };   // nothing to judge — agent never invoked

  const max = opts.maxSessions ?? DEFAULT_MAX_JUDGE;
  const chunkSize = Math.max(1, opts.chunkSize ?? JUDGE_CHUNK_SIZE);
  const selected = [...allMissioned].sort((a, b) => b.atMs - a.atMs).slice(0, max);
  const connectFn = opts.connectFn ?? currentTestConnectFn() ?? defaultConnectFn;
  const timeoutMs = opts.timeoutMs ?? 90_000;   // per chunk; small chunks fit easily
  const root = signal.sequences!.root;

  const facets: SessionFacet[] = [];
  let degraded = false;
  for (let i = 0; i < selected.length; i += chunkSize) {
    const chunk = selected.slice(i, i + chunkSize);
    const subSignal = { ...signal, sequences: { root, sessions: chunk } };
    const r = await judgeBatch(subSignal, chunk, connectFn, timeoutMs, opts.onDelta);
    facets.push(...r.facets);
    if (r.degraded) degraded = true;
  }
  return { facets, degraded };
}
