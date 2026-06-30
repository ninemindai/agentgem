// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
// packages/insight/src/narrateInsights.ts
//
// Cross-session narrative: drives the ACP agent (plan mode) over all session
// facets to produce a short prose characterization of how the user works — the
// "interaction_style" paragraph that makes Claude Code's /insights feel
// insightful. Never throws: returns the deterministic fallback (the templated
// narrative from synthesizeInsights) when there's nothing to narrate or the
// agent is unavailable. Mirrors judgeSessions.
import type { SessionFacet } from "./facets.js";
import {
  type AcpConnectFn, type AcpCtx, type AcpSessionHandle,
  CLAUDE_AGENT, analysisWorkspace, currentTestConnectFn, defaultConnectFn,
} from "./acpRecommender.js";

const NARRATE = (facetsJson: string) =>
  `You are characterising how a developer works, based on a set of their past ` +
  `coding-agent sessions (each judged for goal, outcome, and friction).\n` +
  `SESSIONS:\n${facetsJson}\n\n` +
  `Write 2–3 sentences in the second person ("You…") capturing their working style: ` +
  `what they consistently pursue, how they drive the agent, and where things tend to break down. ` +
  `Be concrete and grounded in the sessions; no flattery, no generic advice.\n` +
  `Return ONLY a JSON object: {"narrative":"..."}.`;

function extractJson(text: string): string {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  return start >= 0 && end > start ? text.slice(start, end + 1) : text;
}

/** Pull the narrative string from an agent response; fall back on any failure. */
export function validateNarrative(raw: unknown, fallback: string): string {
  let obj: any = raw;
  if (typeof raw === "string") { try { obj = JSON.parse(extractJson(raw)); } catch { return fallback; } }
  if (!obj || typeof obj !== "object" || typeof obj.narrative !== "string" || !obj.narrative.trim()) return fallback;
  return obj.narrative;
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return Promise.race([p, new Promise<T>((_, rej) => setTimeout(() => rej(new Error(`agent timeout after ${ms}ms`)), ms))]);
}

/**
 * Narrate the facets. `fallback` is the deterministic narrative to return when
 * the agent can't help. degraded:true only when the agent call itself failed.
 */
export async function narrateInsights(
  facets: SessionFacet[],
  fallback: string,
  opts: { connectFn?: AcpConnectFn; timeoutMs?: number; onDelta?: (chunk: string) => void } = {},
): Promise<{ narrative: string; degraded: boolean }> {
  if (!facets.length) return { narrative: fallback, degraded: false };

  const connectFn = opts.connectFn ?? currentTestConnectFn() ?? defaultConnectFn;
  const timeoutMs = opts.timeoutMs ?? 60_000;
  let conn: { ctx: AcpCtx; close: () => void } | null = null;
  let handle: AcpSessionHandle | null = null;
  try {
    const payload = facets.map((f) => ({ goal: f.underlying_goal, outcome: f.outcome, friction: f.friction_detail }));
    const prompt = NARRATE(JSON.stringify(payload));
    const deadline = Date.now() + timeoutMs;
    const left = () => Math.max(0, deadline - Date.now());
    conn = await withTimeout(connectFn(CLAUDE_AGENT, null), left());
    handle = await withTimeout(conn.ctx.open(analysisWorkspace()), left());
    await withTimeout(handle.setMode("plan"), left());
    const text = await withTimeout(handle.promptText(prompt, opts.onDelta), left());
    return { narrative: validateNarrative(text, fallback), degraded: false };
  } catch (err) {
    console.error("insights: narrative fell back to template:", (err as Error).message);
    return { narrative: fallback, degraded: true };
  } finally {
    try { handle?.dispose(); } catch { /* ignore */ }
    try { conn?.close(); } catch { /* ignore */ }
  }
}
