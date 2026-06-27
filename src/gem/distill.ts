// src/gem/distill.ts
//
// Distillation track: turn the builtin procedure recovered by the scan into draft
// skills folded back into Gem candidates. See
// docs/proposals/skill-distillation-from-transcripts.md.
import type { WorkflowSignal, ScanInventory } from "./workflowScan.js";
import { CLAUDE_AGENT, analysisWorkspace, defaultConnectFn, currentTestConnectFn, type AcpConnectFn } from "./acpRecommender.js";
import type { GatedCandidate, ProcedureCandidate, DistilledSkill, Provenance, Occurrence } from "./distillTypes.js";

// Back-compat re-export: existing importers (draftStage.ts, acpRecommender.ts)
// import these from "./distill.js".
export type { ProcedureCandidate, DistilledSkill } from "./distillTypes.js";

// skillify Phase-0 thresholds (proposal §4): "invoked 2+ times" and ">20 lines of
// logic" (~4 distinct action verbs). The third criterion (clear trigger phrase) is
// deferred to the agent + validation.
export const MIN_RECURRENCE = 2;
export const MIN_STEPS = 3;   // procedures are mined as >=3-gram action runs (§3c)

const KEBAB_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const MUTATING_TOOL_RE = /^(Bash|Edit|Write|NotebookEdit)$/;

function extractJson(text: string): string {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  return start >= 0 && end > start ? text.slice(start, end + 1) : text;
}

/**
 * Validate a raw agent response into DistilledSkills. A distilled skill cannot be
 * checked against the inventory (it is new), so validation is shape + evidence-
 * grounding (proposal §6): kebab name, non-empty triggers + body, slug not already
 * installed, and every claimed tool present in the candidates' sampled evidence.
 * `mutating` is forced true when the procedure touches Bash/Edit/Write. Never throws.
 */
export function validateDistilled(raw: unknown, inv: ScanInventory, candidates: ProcedureCandidate[]): DistilledSkill[] {
  let obj: any = raw;
  if (typeof raw === "string") { try { obj = JSON.parse(extractJson(raw)); } catch { return []; } }
  if (!obj || typeof obj !== "object" || !Array.isArray(obj.distilled)) return [];

  const installed = new Set<string>([
    ...inv.project.skills.map((s) => s.name),
    ...(inv.global?.skills ?? []).map((s) => s.name),
  ]);
  const evidenceTools = new Set<string>();
  for (const c of candidates) for (const st of c.sample.steps) evidenceTools.add(st.tool);
  const evidenceIsMutating = [...evidenceTools].some((t) => MUTATING_TOOL_RE.test(t));
  const sessions = candidates.reduce((m, c) => Math.max(m, c.sessions), 0);
  const exampleSequence = candidates[0]?.verbs ?? [];
  const root = inv.project.root;
  // Pooled provenance: the union of every candidate's occurrences (deduped by
  // sessionId). The LLM output cannot be mapped 1:1 back to a single candidate,
  // so we attach the evidence pool the distillation drew from. (Skeletons, by
  // contrast, carry their own candidate's exact provenance — see extract.ts.)
  const provenance = poolProvenance(candidates);

  const out: DistilledSkill[] = [];
  for (const it of obj.distilled) {
    if (!it || typeof it !== "object") continue;
    if (typeof it.name !== "string" || !KEBAB_RE.test(it.name)) { console.error(`distill: dropping non-kebab name '${it.name}'`); continue; }
    if (installed.has(it.name)) { console.error(`distill: dropping slug colliding with installed skill '${it.name}'`); continue; }
    const triggers = Array.isArray(it.triggers) ? it.triggers.filter((t: unknown): t is string => typeof t === "string" && t.trim().length > 0) : [];
    if (!triggers.length) continue;
    if (typeof it.body !== "string" || !it.body.trim()) continue;
    const tools = Array.isArray(it.tools) ? it.tools.filter((t: unknown): t is string => typeof t === "string") : [];
    if (tools.some((t: string) => !evidenceTools.has(t))) { console.error(`distill: dropping '${it.name}' — fabricated tool not in evidence`); continue; }
    out.push({
      name: it.name,
      description: typeof it.description === "string" ? it.description : "",
      triggers,
      tools,
      mutating: evidenceIsMutating || tools.some((t: string) => MUTATING_TOOL_RE.test(t)),
      body: it.body,
      evidence: { sessions, exampleSequence, root, provenance },
      status: "draft",
      confidence: ["high", "medium", "low"].includes(it.confidence) ? it.confidence : "medium",
      origin: "llm",
    });
  }
  return out;
}

// Union the occurrences of every candidate, deduped by sessionId (first wins).
export function poolProvenance(candidates: { provenance: Provenance }[]): Provenance {
  const seen = new Set<string>();
  const occurrences: Occurrence[] = [];
  for (const c of candidates) for (const o of c.provenance.occurrences) {
    if (seen.has(o.sessionId)) continue;
    seen.add(o.sessionId);
    occurrences.push(o);
  }
  return { occurrences };
}

export function distillCandidates(
  signal: WorkflowSignal,
  opts: { minRecurrence?: number; minSteps?: number } = {},
): GatedCandidate[] {
  const minRecurrence = opts.minRecurrence ?? MIN_RECURRENCE;
  const minSteps = opts.minSteps ?? MIN_STEPS;
  const sessions = signal.sequences?.sessions;
  if (!signal.procedures || !sessions) return [];
  return signal.procedures
    .filter((p) => p.sessions >= minRecurrence && p.verbs.length >= minSteps)
    .map((p) => ({ ...p, sample: sessions[p.sampleSessionIdx] }))
    .filter((c): c is GatedCandidate => c.sample !== undefined);
}

// ── The generative ACP step (proposal §5) ───────────────────────────────────
// Distinct from the selective recommender's GROUNDING prompt. Names/scopes a
// skill by the MISSION it accomplished; dedups against installed skills.
export const DISTILL = (candidatesJson: string, installedSkillsJson: string): string =>
  `You distill the WORKFLOW a coding agent used to accomplish a mission into a ` +
  `reusable skill. Each candidate carries: a mission hint (the task the user set ` +
  `out to do + the outcome), an ordered redacted sequence of tool calls, and how ` +
  `many sessions it recurred across.\n` +
  `Name and scope each skill by the MISSION it accomplished — not by its tool ` +
  `fingerprint. For each genuinely reusable workflow, emit a skill with:\n` +
  `  frontmatter: name (kebab), description (one paragraph), triggers (phrases a ` +
  `user would actually type), tools (from the sequence), mutating (bool)\n` +
  `  body: ## Contract (guarantees) / ## Phases (reproduce the ordered ` +
  `instructions/steps the agent followed) / ## Output Format (the deliverable)\n` +
  `DEDUP — do NOT propose a skill that overlaps any installed skill:\n${installedSkillsJson}\n` +
  `Drop a candidate that is one-off, trivial, or has no clear trigger phrase.\n` +
  `MISSIONS + WORKFLOWS (redacted; counts are facts):\n${candidatesJson}\n\n` +
  `Return ONLY JSON: {"distilled":[{"name","description","triggers":[],"tools":[],` +
  `"mutating":bool,"body","confidence":"high"|"medium"|"low"}]}.`;

// Bound the prompt: send each candidate's verbs, recurrence, mission hint, and a
// capped slice of its sampled steps.
function trimCandidate(c: GatedCandidate) {
  return {
    verbs: c.verbs,
    sessions: c.sessions,
    missionHint: c.sample.missionHint ?? null,
    steps: c.sample.steps.slice(0, 30).map((s) => ({ verb: s.verb, arg: s.arg })),
  };
}

function installedSkillNames(inv: ScanInventory): string[] {
  return [...inv.project.skills.map((s) => s.name), ...(inv.global?.skills ?? []).map((s) => s.name)];
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return Promise.race([p, new Promise<T>((_, rej) => setTimeout(() => rej(new Error(`distill agent timeout after ${ms}ms`)), ms))]);
}

/**
 * Distil draft skills from a WorkflowSignal. Total: never throws. Short-circuits to
 * an empty (non-degraded) result when no procedure clears Phase-0 — the agent is
 * not even spawned. Any agent error/timeout/junk → { distilled: [], degraded: true }.
 */
export async function distillWorkflow(
  signal: WorkflowSignal,
  inv: ScanInventory,
  opts: { connectFn?: AcpConnectFn; timeoutMs?: number; minRecurrence?: number; minSteps?: number } = {},
): Promise<{ distilled: DistilledSkill[]; degraded: boolean }> {
  const candidates = distillCandidates(signal, opts);
  if (!candidates.length) return { distilled: [], degraded: false };

  const connectFn = opts.connectFn ?? currentTestConnectFn() ?? defaultConnectFn;
  const timeoutMs = opts.timeoutMs ?? 60_000;
  let conn: { ctx: { open(cwd: string): Promise<{ setMode(m: string): Promise<void>; promptText(t: string): Promise<string>; dispose(): void }> }; close: () => void } | null = null;
  let handle: { setMode(m: string): Promise<void>; promptText(t: string): Promise<string>; dispose(): void } | null = null;
  try {
    const prompt = DISTILL(JSON.stringify(candidates.map(trimCandidate)), JSON.stringify(installedSkillNames(inv)));
    // Bound EVERY step against one shared deadline — connect + session open +
    // setMode + prompt — since the ACP handshake/session start are otherwise
    // unbounded (acpSession) and would hang past the prompt-only timeout.
    const deadline = Date.now() + timeoutMs;
    const left = () => Math.max(0, deadline - Date.now());
    conn = await withTimeout(connectFn(CLAUDE_AGENT, null), left());
    handle = await withTimeout(conn.ctx.open(analysisWorkspace()), left());   // neutral cwd — don't pollute the project
    await withTimeout(handle.setMode("plan"), left());                          // explicit — never edits files
    const text = await withTimeout(handle.promptText(prompt), left());
    // TODO(Task 5): replace cast with enriched ProcedureCandidate[] from extractCandidates.
    return { distilled: validateDistilled(text, inv, candidates as ProcedureCandidate[]), degraded: false };
  } catch (err) {
    console.error("distill: fell back to empty:", (err as Error).message);
    return { distilled: [], degraded: true };
  } finally {
    try { handle?.dispose(); } catch { /* ignore */ }
    try { conn?.close(); } catch { /* ignore */ }
  }
}
