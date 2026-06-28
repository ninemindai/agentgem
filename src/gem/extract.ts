// src/gem/extract.ts
//
// The deterministic extractor seam between procedure mining and the LLM. Takes
// the Phase-0 gated candidates and enriches each with: source provenance, a
// heuristic skeleton draft, and a precision prior. Also emits a second
// `Reflection[]` stream (Task 6). Pure; no I/O. The LLM (distill.ts) becomes an
// enricher over this output, with the skeleton as the degrade path.
import { spineWithIndices, type WorkflowSignal, type ScanInventory, type SessionSequence } from "./workflowScan.js";
import type { Provenance, Occurrence, ProcedureCandidate, Reflection, GatedCandidate, DistilledSkill } from "./distillTypes.js";

// skillify Phase-0 thresholds (proposal §4): "invoked 2+ times" and ">20 lines of
// logic" (~4 distinct action verbs). The third criterion (clear trigger phrase) is
// deferred to the agent + validation.
export const MIN_RECURRENCE = 2;
export const MIN_STEPS = 3;   // procedures are mined as >=3-gram action runs (§3c)

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

export interface ExtractionResult { candidates: ProcedureCandidate[]; reflections: Reflection[] }

// Locate the contiguous verb-run `verbs` inside `spine` and return the source
// msgIndices of the matched positions, or [] if the run is absent.
function locateRun(spine: { verb: string; msgIndex: number }[], verbs: string[]): number[] {
  for (let i = 0; i + verbs.length <= spine.length; i++) {
    let ok = true;
    for (let j = 0; j < verbs.length; j++) if (spine[i + j].verb !== verbs[j]) { ok = false; break; }
    if (ok) return spine.slice(i, i + verbs.length).map((e) => e.msgIndex);
  }
  return [];
}

// Map a procedure's verb-run back to one Occurrence per exercising session.
// Sessions where the run cannot be located contribute nothing (defensive).
export function buildProvenance(verbs: string[], sessions: SessionSequence[], sessionIdxs: number[]): Provenance {
  const occurrences: Occurrence[] = [];
  for (const idx of sessionIdxs) {
    const sess = sessions[idx];
    if (!sess) continue;
    const messageIndices = locateRun(spineWithIndices(sess.steps), verbs);
    if (!messageIndices.length) continue;
    occurrences.push({ sessionId: sess.sessionId, transcript: sess.transcript, messageIndices, atMs: sess.atMs });
  }
  return { occurrences };
}

const MUTATING_TOOL_RE = /^(Bash|Edit|Write|NotebookEdit)$/;
const OUTCOME_CUES = ["shipped", "fixed", "migrated", "merged", "released", "deployed", "done", "resolved"];
const STOPWORDS = new Set(["the", "a", "an", "to", "of", "and", "for", "with", "please", "my", "our", "this", "that", "it"]);

function slugify(text: string): string {
  const slug = text.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").split("-").filter((w) => w && !STOPWORDS.has(w)).slice(0, 5).join("-");
  return slug || "workflow";
}

// Unique kebab slug not colliding with any installed skill (append -2, -3, …).
function uniqueSlug(base: string, inv: ScanInventory): string {
  const installed = new Set<string>([...inv.project.skills.map((s) => s.name), ...(inv.global?.skills ?? []).map((s) => s.name)]);
  if (!installed.has(base)) return base;
  for (let n = 2; ; n++) { const cand = `${base}-${n}`; if (!installed.has(cand)) return cand; }
}

// Deterministic draft from the procedure spine + mission hint. Always emits ≥1
// trigger and a non-empty body so it survives validateDistilled.
export function heuristicSkeleton(c: GatedCandidate, provenance: Provenance, inv: ScanInventory): DistilledSkill {
  const task = c.sample.missionHint?.task?.trim() || c.verbs[0] || "workflow";
  const name = uniqueSlug(slugify(task), inv);
  const tools = [...new Set(c.sample.steps.map((s) => s.tool))];
  const mutating = tools.some((t) => MUTATING_TOOL_RE.test(t));
  const phases = c.verbs.map((v, i) => `${i + 1}. ${v}`).join("\n");
  const body = [
    "## Contract", "_Skeleton distilled deterministically — review and flesh out._", "",
    "## Phases", phases, "",
    "## Output Format", "_Describe the deliverable._",
  ].join("\n");
  return {
    name,
    description: c.sample.missionHint ? `${c.sample.missionHint.task} → ${c.sample.missionHint.outcome}`.slice(0, 280) : `Recurring workflow across ${c.sessions} sessions.`,
    triggers: [task.slice(0, 80)],
    tools,
    mutating,
    body,
    evidence: { sessions: c.sessions, exampleSequence: c.verbs, root: inv.project.root, provenance },
    status: "draft",
    confidence: "low",
    origin: "heuristic",
  };
}

// Precision prior: reward a clear mission (task + an outcome cue) and recurrence;
// penalize an empty mission at exactly the minimum recurrence.
export function scoreCandidate(c: GatedCandidate, minRecurrence: number): "high" | "medium" | "low" {
  const mission = c.sample.missionHint;
  const hasTask = !!mission?.task?.trim();
  const hasOutcomeCue = !!mission && OUTCOME_CUES.some((cue) => `${mission.task} ${mission.outcome}`.toLowerCase().includes(cue));
  if (hasTask && hasOutcomeCue && c.sessions > minRecurrence) return "high";
  if (hasTask) return "medium";
  return "low";
}

export function extractCandidates(
  signal: WorkflowSignal,
  inv: ScanInventory,
  opts: { minRecurrence?: number; minSteps?: number } = {},
): ExtractionResult {
  const minRecurrence = opts.minRecurrence ?? MIN_RECURRENCE;
  const gated = distillCandidates(signal, opts);
  const sessions = signal.sequences?.sessions ?? [];
  const candidates: ProcedureCandidate[] = [];
  for (const g of gated) {
    const priorConfidence = scoreCandidate(g, minRecurrence);
    // Junk filter: empty-mission candidates at exactly the floor waste LLM spend.
    if (priorConfidence === "low" && !g.sample.missionHint && g.sessions <= minRecurrence) continue;
    const provenance = buildProvenance(g.verbs, sessions, g.sessionIdxs ?? [g.sampleSessionIdx]);
    const skeleton = heuristicSkeleton(g, provenance, inv);
    candidates.push({ ...g, provenance, priorConfidence, skeleton });
  }
  // Strongest priors first, so a downstream prompt cap keeps the best candidates.
  const rank = { high: 0, medium: 1, low: 2 } as const;
  candidates.sort((a, b) => rank[a.priorConfidence] - rank[b.priorConfidence] || b.sessions - a.sessions);
  return { candidates, reflections: extractReflections(signal) };
}

const TERMINAL_RE = /^Bash:git (commit|push)$|^Bash:gh pr/;
const WORK_RE = /^(Edit|Write|NotebookEdit)$/;
const RECURRING_PATTERN_MIN = 3;   // "you do this a lot" threshold (above Phase-0 floor)

// Second stream, derived ONLY from already-mined procedures (no new pass):
//  - unresolved-task: a recurring procedure that does real work (Edit/Write) but
//    never reaches a terminal commit/push/PR verb.
//  - recurring-pattern: a procedure exercised in >= RECURRING_PATTERN_MIN sessions.
export function extractReflections(signal: WorkflowSignal): Reflection[] {
  const procedures = signal.procedures ?? [];
  const sessions = signal.sequences?.sessions ?? [];
  const out: Reflection[] = [];
  for (const p of procedures) {
    const provenance = buildProvenance(p.verbs, sessions, p.sessionIdxs ?? [p.sampleSessionIdx]);
    const doesWork = p.verbs.some((v) => WORK_RE.test(v));
    const reachesTerminal = p.verbs.some((v) => TERMINAL_RE.test(v));
    if (doesWork && !reachesTerminal) {
      out.push({ kind: "unresolved-task", importance: "high",
        detail: `Repeated workflow edits files but never commits/pushes: ${p.verbs.join(" → ")} (${p.sessions} sessions).`, provenance });
    }
    if (p.sessions >= RECURRING_PATTERN_MIN) {
      out.push({ kind: "recurring-pattern", importance: "medium",
        detail: `Frequently repeated flow (${p.sessions} sessions): ${p.verbs.join(" → ")}.`, provenance });
    }
  }
  return out;
}
