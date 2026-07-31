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
// The applicability contract: a criterion that never applied and one that applied
// everywhere and passed are NOT the same result, so the judge also returns a roster
// — one entry per session naming the criteria that don't apply there. That roster is
// the denominator ("2 fires in 9 applicable sessions"), and it exists because silence
// is unfalsifiable: a judge that simply never mentions a criterion is indistinguishable
// from one that considered it and found it fine. Three things are therefore counted as
// UNJUDGED rather than passed — a session missing from the roster, a session whose step
// list was truncated (we only ever showed the judge the first MAX_STEPS_PER_SESSION),
// and every session in a chunk whose reply could not be parsed:
//
//   reply parsed? ──no──> whole chunk unjudged (degraded)
//        │yes
//   session in roster? ──no──> unjudged
//        │yes
//   steps truncated? ──yes──> unjudged (we saw only part of it)
//        │no
//   criterion in notApplicable? ──yes──> judged, not applicable
//        │no
//   fired row present? ──yes──> judged, applicable, FIRED
//        └──no──────────────> judged, applicable, passed
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
import type { JudgeCoverage } from "./judgeSession.js";
import {
  type AcpConnectFn, type AcpCtx, type AcpSessionHandle,
  analysisWorkspace, currentTestConnectFn, defaultConnectFn,
} from "./acpRecommender.js";
import { createLogger, taskAgent } from "@agentgem/base";
import { extractJson } from "./jsonReply.js";

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
  `For EACH session, evaluate EACH criterion in two steps:\n` +
  `  1. Could this criterion meaningfully apply to this session at all? If the session is not the ` +
  `kind of session the criterion is about, OR you cannot determine either way, it does NOT apply.\n` +
  `  2. If it applies, did the described thing occur? If it did, cite the step indices ` +
  `(the "i" values) that evidence it.\n\n` +
  `CRITERIA (id → question):\n${criteriaJson}\n\n` +
  `SESSIONS (each step is {i: index, verb, arg}):\n${sessionsJson}\n\n` +
  `Return ONLY a JSON object with BOTH keys:\n` +
  `{"sessions":[{"sessionId","notApplicable":["<criterionId>"]}],` +
  `"results":[{"sessionId","criterionId","fired":true,"msgIndices":[<step i values>]}]}\n` +
  `"sessions" MUST contain one entry for EVERY session listed above — use an empty notApplicable ` +
  `array when every criterion applies. Do not omit a session; a missing session counts as unjudged.\n` +
  `"results" carries only the criteria that FIRED.\n` +
  `A criterion that applied and did not occur appears in neither list.\n` +
  `Use the exact sessionId and criterionId values given. Cite only real step "i" values from that ` +
  `session. Do not invent sessions, criteria, or indices.`;

interface RawResult { sessionId?: unknown; criterionId?: unknown; fired?: unknown; msgIndices?: unknown }
interface RawRoster { sessionId?: unknown; notApplicable?: unknown }

/** What one agent reply told us. `rostered` is the set of sessions the judge actually
 *  answered for — a session absent from it was NOT judged and must enter no count. */
export interface CriterionResults {
  ok: boolean;                                          // false => unreadable reply, not a judgment
  findings: DetectorFinding[];
  rostered: Set</*sessionId*/ string>;
  notApplicable: Map</*criterionId*/ string, Set</*sessionId*/ string>>;
}

const EMPTY_RESULTS = (): CriterionResults => ({ ok: false, findings: [], rostered: new Set(), notApplicable: new Map() });

/** Per criterion, the honest denominator: sessions we can say were examined, and how
 *  many of those the criterion could apply to. `judged` is NOT "sessions that returned
 *  a fired row" — most sessions return nothing, and those silences are the passes. */
export interface CriterionApplicability { judged: number; applicable: number }

/**
 * Turn one agent response into findings. The signal's sessions and the criteria
 * set are the source of truth: results for unknown sessions/criteria are dropped,
 * and every msgIndex is intersected with the session's real index set.
 */
export function validateCriterionResults(
  text: string, sessions: SessionSequence[], criteria: LlmCriterion[],
): CriterionResults {
  let parsed: unknown;
  try { parsed = JSON.parse(extractJson(text)); } catch { return EMPTY_RESULTS(); }
  const results = (parsed as { results?: unknown })?.results;
  if (!Array.isArray(results)) return EMPTY_RESULTS();
  // BOTH keys are required. A reply with only `results` is the pre-applicability
  // shape. We still keep whatever fires it reported — an observed fire is real
  // evidence and hiding it would be its own dishonesty — but the run degrades and
  // claims NO denominators, because nothing here says which sessions were examined.
  const roster = (parsed as { sessions?: unknown })?.sessions;
  const rosterOk = Array.isArray(roster);

  const byId = new Map(criteria.map((c) => [c.id, c]));
  const sessById = new Map(sessions.map((s) => [s.sessionId, s]));
  const realIdx = new Map(sessions.map((s) => [s.sessionId, new Set(s.steps.map((st) => st.msgIndex))]));

  // The roster: which sessions the judge answered for, and what didn't apply there.
  // A roster entry naming a session we never sent is dropped — an invented session
  // must not move a denominator.
  const rostered = new Set<string>();
  const notApplicable = new Map<string, Set<string>>();
  for (const raw of rosterOk ? (roster as RawRoster[]) : []) {
    if (!raw || typeof raw.sessionId !== "string" || !sessById.has(raw.sessionId)) continue;
    rostered.add(raw.sessionId);
    const ids = Array.isArray(raw.notApplicable) ? raw.notApplicable : [];
    for (const id of ids) {
      if (typeof id !== "string" || !byId.has(id)) continue;   // unknown criterion — drop
      const set = notApplicable.get(id) ?? new Set<string>();
      set.add(raw.sessionId);
      notApplicable.set(id, set);
    }
  }

  // Roster compliance, measured HERE — before fired rows below add their own sessions
  // and paper over a gap. The prompt asks for one entry per session in the chunk; a
  // shortfall means the judge ignored part of the contract, and those sessions drop out
  // of every denominator (they are never counted as passes, so the number shrinks rather
  // than lies). Nothing else observes this: the judge prompt has no eval harness, so
  // real runs are the only place compliance can be measured. If this line stays quiet in
  // practice, the contract holds; if it fires often, the prompt needs work before anyone
  // trusts a denominator.
  if (rosterOk && rostered.size < sessions.length) {
    log.warn("criterion-judge: judge rostered %d of %d sessions — the rest count as unjudged",
      rostered.size, sessions.length);
  }

  // Collapse to one fire per (session, criterion), unioning evidence. A repeated row
  // would otherwise inflate `count` past the number of sessions the criterion could
  // fire in, so the row reads as more fires than there were opportunities.
  const fires = new Map<string, { crit: LlmCriterion; session: SessionSequence; indices: Set<number> }>();
  for (const r of results as RawResult[]) {
    if (!r || r.fired !== true) continue;
    if (typeof r.sessionId !== "string" || typeof r.criterionId !== "string") continue;
    const crit = byId.get(r.criterionId);
    const session = sessById.get(r.sessionId);
    if (!crit || !session) continue;   // unknown criterion or invented session — drop

    const real = realIdx.get(r.sessionId)!;
    const cited = Array.isArray(r.msgIndices) ? r.msgIndices.filter((n): n is number => typeof n === "number") : [];
    const key = `${r.sessionId}\u0000${r.criterionId}`;
    const entry = fires.get(key) ?? { crit, session, indices: new Set<number>() };
    for (const n of cited) if (real.has(n)) entry.indices.add(n);   // drop hallucinated indices
    fires.set(key, entry);

    // A criterion that fired is self-evidently applicable — the finding wins over a
    // contradicting roster entry.
    notApplicable.get(r.criterionId)?.delete(r.sessionId);

    // A fire IS an answer about this session, so the session belongs in the
    // denominator the fire will be reported against. Without this the numerator and
    // denominator come from different populations, and "2 in 2 of 9 applicable" can
    // count fires from sessions that are not among the 9.
    rostered.add(r.sessionId);
  }

  const out: DetectorFinding[] = [];
  for (const { crit, session, indices } of fires.values()) {
    const valid = [...indices].sort((a, b) => a - b);
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
  // Without a roster there is no honest denominator, so surrender the counts rather
  // than let a fire-derived roster stand in for "these are the sessions we examined".
  return rosterOk
    ? { ok: true, findings: out, rostered, notApplicable }
    : { ok: false, findings: out, rostered: new Set(), notApplicable: new Map() };
}

async function judgeBatch(
  sessions: SessionSequence[], criteria: LlmCriterion[],
  connectFn: AcpConnectFn, timeoutMs: number, onDelta?: (chunk: string) => void,
): Promise<{ findings: DetectorFinding[]; degraded: boolean; results: CriterionResults }> {
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
    const agent = taskAgent("judge");
    log.debug("criterion-judge: requesting %s for %d session(s) × %d criteria", agent.name, sessions.length, criteria.length);
    conn = await withTimeout(connectFn(agent, null), left());
    handle = await withTimeout(conn.ctx.open(analysisWorkspace()), left());   // neutral cwd — don't pollute the project
    await withTimeout(handle.setMode("plan"), left());                        // explicit — never edits files
    const text = await withTimeout(handle.promptText(prompt, onDelta), left());
    // A successful agent call is not a successful JUDGMENT: an unparseable reply
    // yields no verdicts, so the chunk must degrade rather than read as all-clear.
    const r = validateCriterionResults(text, sessions, criteria);
    return { findings: r.findings, degraded: !r.ok, results: r };
  } catch (err) {
    log.warn("criterion-judge chunk skipped after %dms: %s", Date.now() - t0, (err as Error)?.message ?? err);
    return { findings: [], degraded: true, results: EMPTY_RESULTS() };   // no cheap heuristic — skip, don't fake
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
): Promise<{
  findings: DetectorFinding[]; degraded: boolean; coverage: JudgeCoverage;
  applicability: Map</*criterionId*/ string, CriterionApplicability>;
}> {
  const noCoverage: JudgeCoverage = { eligible: 0, judged: 0, sampled: false, truncated: 0 };
  const none = { findings: [], degraded: false, coverage: noCoverage, applicability: new Map<string, CriterionApplicability>() };
  if (!criteria.length) return none;
  const judgeable = (signal.sequences?.sessions ?? []).filter((s) => s.steps.length > 0);
  if (!judgeable.length) return none;

  const max = opts.maxSessions ?? DEFAULT_MAX_CRITERION_SESSIONS;
  const chunkSize = Math.max(1, opts.chunkSize ?? CRITERION_CHUNK_SIZE);
  const selected = [...judgeable].sort((a, b) => b.atMs - a.atMs).slice(0, max);
  const connectFn = opts.connectFn ?? currentTestConnectFn() ?? defaultConnectFn;
  const timeoutMs = opts.timeoutMs ?? 90_000;

  const findings: DetectorFinding[] = [];
  let degraded = false;
  let truncated = 0;
  // Per criterion: how many sessions we can honestly say were examined, and of those
  // how many the criterion could apply to. Only sessions the judge ROSTERED and saw in
  // full are counted — an unrostered, truncated, or unreadable session is an unanswered
  // question, and counting it as a pass is how a denominator starts lying.
  const applicability = new Map<string, CriterionApplicability>();
  for (const c of criteria) applicability.set(c.id, { judged: 0, applicable: 0 });

  for (let i = 0; i < selected.length; i += chunkSize) {
    const chunk = selected.slice(i, i + chunkSize);
    const r = await judgeBatch(chunk, criteria, connectFn, timeoutMs, opts.onDelta);
    findings.push(...r.findings);
    if (r.degraded) degraded = true;

    for (const s of chunk) {
      const wasTruncated = s.steps.length > MAX_STEPS_PER_SESSION;
      if (wasTruncated) truncated++;
      if (wasTruncated || !r.results.rostered.has(s.sessionId)) continue;
      for (const c of criteria) {
        const acc = applicability.get(c.id)!;
        acc.judged++;
        if (!r.results.notApplicable.get(c.id)?.has(s.sessionId)) acc.applicable++;
      }
    }
  }
  // A criterion nothing could be said about carries no denominator at all, rather than
  // a defensible-looking 0/0.
  for (const [id, acc] of applicability) if (acc.judged === 0) applicability.delete(id);
  // Mirrors judgeSessions: the cap is a second, silent way criteria go
  // unevaluated. Callers must not present a criterion all-clear as covering
  // sessions this pass never looked at.
  const coverage: JudgeCoverage = {
    eligible: judgeable.length,
    judged: selected.length,
    sampled: selected.length < judgeable.length,
    truncated,
  };
  return { findings, degraded, coverage, applicability };
}
