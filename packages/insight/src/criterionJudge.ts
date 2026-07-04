// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
// packages/insight/src/criterionJudge.ts
//
// Phase 2: the LLM factor kind. Drives a local ACP agent (Claude, plan mode /
// read-only) to evaluate natural-language criteria — the thing a verb-pattern
// rule can't express ("did they verify the fix against the actual reported case?")
// — over each session's step spine, and returns DetectorFinding[] so the rest of
// the rubric engine treats it identically to a cheap detector. Mirrors
// judgeSession.ts: batched, chunked, never throws.
//
// The evidence contract (eng-review A-fix): unlike cheap detectors, which emit
// msgIndices mechanically, the judge can return invalid/hallucinated indices — so
// every returned index is intersected with the session's REAL index set. A finding
// whose evidence doesn't resolve is kept as a detail-only note (empty evidence),
// never surfaced as auditable. `detail` is built from the criterion + counts only
// (never the agent's free text or step args), preserving the scrubbing contract.
//
// No deterministic fallback: a natural-language criterion has no cheap heuristic,
// so on agent failure the chunk's criteria are simply skipped (degraded:true).
import type { WorkflowSignal, SessionSequence } from "./workflowScan.js";
import type { DetectorFinding, DetectorSeverity } from "./detectors.js";
import type { LlmCriterion } from "./rubrics.js";
import {
  type AcpConnectFn, type AcpCtx, type AcpSessionHandle,
  CLAUDE_AGENT, analysisWorkspace, currentTestConnectFn, defaultConnectFn,
} from "./acpRecommender.js";
import { createLogger } from "@agentgem/base";

const log = createLogger("insight");

// Bounds (mirror judgeSession): cap total sessions judged, chunk each agent call.
export const DEFAULT_MAX_CRITERION_SESSIONS = 30;
export const CRITERION_CHUNK_SIZE = 8;
// Cap steps shown per session so a long session can't blow the prompt.
const MAX_STEPS_PER_SESSION = 80;

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return Promise.race([p, new Promise<T>((_, rej) => setTimeout(() => rej(new Error(`agent timeout after ${ms}ms`)), ms))]);
}

const PROMPT = (criteriaJson: string, sessionsJson: string) =>
  `You are auditing a developer's past coding-agent sessions against specific criteria.\n` +
  `For EACH session, evaluate EACH criterion: did the described thing occur in that session? ` +
  `If it did, cite the step indices (the "i" values) that evidence it.\n\n` +
  `CRITERIA (id → question):\n${criteriaJson}\n\n` +
  `SESSIONS (each step is {i: index, verb, arg}):\n${sessionsJson}\n\n` +
  `Return ONLY a JSON object: {"results":[{"sessionId","criterionId","fired":true|false,"msgIndices":[<step i values>]}]}.\n` +
  `Use the exact sessionId and criterionId values given. Cite only real step "i" values from that session. ` +
  `Omit or set fired:false for criteria that did not occur. Do not invent sessions, criteria, or indices.`;

interface RawResult { sessionId?: unknown; criterionId?: unknown; fired?: unknown; msgIndices?: unknown }

/**
 * Turn one agent response into findings. The signal's sessions and the criteria
 * set are the source of truth: results for unknown sessions/criteria are dropped,
 * and every msgIndex is intersected with the session's real index set.
 */
export function validateCriterionResults(
  text: string, sessions: SessionSequence[], criteria: LlmCriterion[],
): DetectorFinding[] {
  let parsed: unknown;
  try { parsed = JSON.parse(text); } catch { return []; }
  const results = (parsed as { results?: unknown })?.results;
  if (!Array.isArray(results)) return [];

  const byId = new Map(criteria.map((c) => [c.id, c]));
  const sessById = new Map(sessions.map((s) => [s.sessionId, s]));
  const realIdx = new Map(sessions.map((s) => [s.sessionId, new Set(s.steps.map((st) => st.msgIndex))]));

  const out: DetectorFinding[] = [];
  for (const r of results as RawResult[]) {
    if (!r || r.fired !== true) continue;
    if (typeof r.sessionId !== "string" || typeof r.criterionId !== "string") continue;
    const crit = byId.get(r.criterionId);
    const session = sessById.get(r.sessionId);
    if (!crit || !session) continue;   // unknown criterion or invented session — drop

    const real = realIdx.get(r.sessionId)!;
    const cited = Array.isArray(r.msgIndices) ? r.msgIndices.filter((n): n is number => typeof n === "number") : [];
    const valid = [...new Set(cited.filter((n) => real.has(n)))].sort((a, b) => a - b);   // drop hallucinated indices

    const severity: DetectorSeverity = crit.severity ?? "info";
    out.push({
      detectorId: crit.id,
      sessionId: session.sessionId,
      transcript: session.transcript,
      atMs: session.atMs,
      severity,
      // Coordinates + counts only — never the agent's free text or step args.
      detail: valid.length > 0 ? `${crit.title} — ${valid.length} step(s)` : `${crit.title} — flagged (evidence unresolved)`,
      evidence: { msgIndices: valid },
    });
  }
  return out;
}

async function judgeBatch(
  sessions: SessionSequence[], criteria: LlmCriterion[],
  connectFn: AcpConnectFn, timeoutMs: number, onDelta?: (chunk: string) => void,
): Promise<{ findings: DetectorFinding[]; degraded: boolean }> {
  let conn: { ctx: AcpCtx; close: () => void } | null = null;
  let handle: AcpSessionHandle | null = null;
  const t0 = Date.now();
  try {
    const critPayload = criteria.map((c) => ({ id: c.id, question: c.question }));
    const sessPayload = sessions.map((s) => ({
      sessionId: s.sessionId,
      goal: s.missionHint?.task ?? "",
      steps: s.steps.slice(0, MAX_STEPS_PER_SESSION).map((st) => ({ i: st.msgIndex, verb: st.verb, arg: st.arg })),
    }));
    const prompt = PROMPT(JSON.stringify(critPayload), JSON.stringify(sessPayload));
    const deadline = Date.now() + timeoutMs;
    const left = () => Math.max(0, deadline - Date.now());
    log.debug("criterion-judge: requesting %s for %d session(s) × %d criteria", CLAUDE_AGENT.name, sessions.length, criteria.length);
    conn = await withTimeout(connectFn(CLAUDE_AGENT, null), left());
    handle = await withTimeout(conn.ctx.open(analysisWorkspace()), left());   // neutral cwd — don't pollute the project
    await withTimeout(handle.setMode("plan"), left());                        // explicit — never edits files
    const text = await withTimeout(handle.promptText(prompt, onDelta), left());
    return { findings: validateCriterionResults(text, sessions, criteria), degraded: false };
  } catch (err) {
    log.warn("criterion-judge chunk skipped after %dms: %s", Date.now() - t0, (err as Error)?.message ?? err);
    return { findings: [], degraded: true };   // no cheap heuristic for a criterion — skip, don't fake
  } finally {
    try { handle?.dispose(); } catch { /* ignore */ }
    try { conn?.close(); } catch { /* ignore */ }
  }
}

/**
 * Evaluate `criteria` over the most-recent sessions that have steps, in chunks so
 * each agent call stays small. Never throws. Short-circuits to [] (no agent) when
 * there are no criteria or no judgeable sessions. degraded:true if any chunk's
 * agent call failed (that chunk contributes no findings; the rest succeed).
 */
export async function judgeCriteria(
  signal: WorkflowSignal,
  criteria: LlmCriterion[],
  opts: { connectFn?: AcpConnectFn; timeoutMs?: number; maxSessions?: number; chunkSize?: number; onDelta?: (chunk: string) => void } = {},
): Promise<{ findings: DetectorFinding[]; degraded: boolean }> {
  if (!criteria.length) return { findings: [], degraded: false };
  const judgeable = (signal.sequences?.sessions ?? []).filter((s) => s.steps.length > 0);
  if (!judgeable.length) return { findings: [], degraded: false };

  const max = opts.maxSessions ?? DEFAULT_MAX_CRITERION_SESSIONS;
  const chunkSize = Math.max(1, opts.chunkSize ?? CRITERION_CHUNK_SIZE);
  const selected = [...judgeable].sort((a, b) => b.atMs - a.atMs).slice(0, max);
  const connectFn = opts.connectFn ?? currentTestConnectFn() ?? defaultConnectFn;
  const timeoutMs = opts.timeoutMs ?? 90_000;

  const findings: DetectorFinding[] = [];
  let degraded = false;
  for (let i = 0; i < selected.length; i += chunkSize) {
    const chunk = selected.slice(i, i + chunkSize);
    const r = await judgeBatch(chunk, criteria, connectFn, timeoutMs, opts.onDelta);
    findings.push(...r.findings);
    if (r.degraded) degraded = true;
  }
  return { findings, degraded };
}
