// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
// packages/insight/src/sessionLessons.ts
//
// LLM distillation of LESSONS from ONE session (the "✦ Distill this session"
// companion to distillWorkflow's skills). Single sessions can't yield lessons via
// the recurrence reflection path (needs ≥3 sessions), so a meaningful session's
// lessons come from the agent reading it. Friction-seeded: the prompt first names
// what was hard, then distills the durable lesson. Mirrors distillWorkflow:
// ACP Claude / plan mode / shared deadline / degrade-to-empty / never throws.
// Provenance is server-attached (coordinates only); the agent supplies only text.
import type { WorkflowSignal, SessionSequence, ScanInventory } from "./workflowScan.js"; // same source distill.ts uses
import type { DistilledLesson, Occurrence, Provenance } from "./distillTypes.js";
import { lessonSlug } from "./distillTypes.js";
import { sanitizeShareText, scrubText } from "./scrub.js";
import {
  type AcpConnectFn, CLAUDE_AGENT, analysisWorkspace, currentTestConnectFn, defaultConnectFn,
} from "./acpRecommender.js";

// Friction-seeded lessons prompt. One session's mission + redacted verb spine in;
// durable lessons out. Counts/coordinates are facts; never ask for provenance.
export const SESSION_LESSONS = (missionJson: string, spineJson: string): string =>
  `You are reviewing ONE coding-agent session to extract the durable LESSONS a ` +
  `developer should remember — the non-obvious gotchas, the things that went wrong ` +
  `and how they were resolved, what to do differently next time.\n` +
  `First identify the FRICTION (what was hard or surprising in this session), then ` +
  `distill each into a reusable lesson. Skip the routine; a lesson must be worth ` +
  `telling a teammate. Each lesson: one or two sentences, imperative, self-contained.\n` +
  `SESSION (mission = the user's goal + the final outcome; spine = the redacted ` +
  `ordered tool verbs):\nmission: ${missionJson}\nspine: ${spineJson}\n\n` +
  `Return ONLY JSON: {"lessons":[{"body":"...","importance":"high"|"medium"}]}. ` +
  `Return {"lessons":[]} if the session has no lesson worth sharing.`;

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return Promise.race([p, new Promise<T>((_, rej) => setTimeout(() => rej(new Error(`session-lessons agent timeout after ${ms}ms`)), ms))]);
}

// Locate a JSON object in possibly-fenced agent text (local copy — the established
// per-module pattern in distill.ts / facets.ts / acpRecommender.ts).
function extractJson(text: string): string {
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fence) return fence[1].trim();
  const a = text.indexOf("{"), b = text.lastIndexOf("}");
  return a >= 0 && b > a ? text.slice(a, b + 1) : text;
}

function provenanceOf(session: SessionSequence): Provenance {
  const occ: Occurrence = {
    sessionId: session.sessionId,
    transcript: session.transcript,
    messageIndices: session.steps.map((s) => s.msgIndex),
    atMs: session.atMs,
  };
  return { occurrences: [occ] };
}

export function validateSessionLessons(raw: unknown, session: SessionSequence, root: string): DistilledLesson[] {
  let obj: unknown = raw;
  if (typeof raw === "string") { try { obj = JSON.parse(extractJson(raw)); } catch { return []; } }
  const arr = (obj as { lessons?: unknown })?.lessons;
  if (!Array.isArray(arr)) return [];
  const provenance = provenanceOf(session);
  const out: DistilledLesson[] = [];
  const seen = new Map<string, number>();
  for (const item of arr) {
    const body0 = (item as { body?: unknown })?.body;
    if (typeof body0 !== "string" || !body0.trim()) continue;
    const body = sanitizeShareText(scrubText(body0), 400);
    if (!body.trim()) continue; // a body that was entirely a secret/path scrubs to nothing — drop it
    const imp = (item as { importance?: unknown })?.importance;
    const importance: DistilledLesson["importance"] = imp === "high" ? "high" : "medium";
    const base = lessonSlug(body);
    const n = seen.get(base) ?? 0; seen.set(base, n + 1);
    const name = n === 0 ? base : `${base}-${n + 1}`;
    out.push({ name, body, importance, status: "draft", evidence: { sessions: 1, root, provenance } });
  }
  return out;
}

/**
 * Distil durable lessons from ONE session via the agent. Never throws.
 * No mission hint → empty, non-degraded (agent not invoked). Agent error/junk →
 * empty, degraded:true (no single-session heuristic fallback exists).
 */
export async function distillSessionLessons(
  signal: WorkflowSignal,
  _inv: ScanInventory,
  opts: { connectFn?: AcpConnectFn; timeoutMs?: number } = {},
): Promise<{ lessons: DistilledLesson[]; degraded: boolean }> {
  const session = signal.sequences?.sessions?.[0];
  if (!session?.missionHint) return { lessons: [], degraded: false };
  const root = signal.sequences!.root;

  const connectFn = opts.connectFn ?? currentTestConnectFn() ?? defaultConnectFn;
  const timeoutMs = opts.timeoutMs ?? 60_000;
  let conn: { ctx: { open(cwd: string): Promise<{ setMode(m: string): Promise<void>; promptText(t: string): Promise<string>; dispose(): void }> }; close: () => void } | null = null;
  let handle: { setMode(m: string): Promise<void>; promptText(t: string): Promise<string>; dispose(): void } | null = null;
  try {
    const spine = session.steps.map((s) => s.verb);
    const prompt = SESSION_LESSONS(JSON.stringify(session.missionHint), JSON.stringify(spine));
    const deadline = Date.now() + timeoutMs;
    const left = () => Math.max(0, deadline - Date.now());
    conn = await withTimeout(connectFn(CLAUDE_AGENT, null), left());
    handle = await withTimeout(conn.ctx.open(analysisWorkspace()), left());
    await withTimeout(handle.setMode("plan"), left());
    const text = await withTimeout(handle.promptText(prompt), left());
    // The agent ran: a valid empty result ({"lessons":[]}) is a legitimate "no
    // lesson worth sharing" — NOT degraded. `degraded` for lessons means only "the
    // agent couldn't run" (it drives the "set ANTHROPIC_API_KEY" hint); reserve it
    // for the catch. There is no heuristic lesson fallback, so success → false.
    return { lessons: validateSessionLessons(text, session, root), degraded: false };
  } catch (err) {
    console.error("session-lessons: agent unavailable, no lessons:", (err as Error).message);
    return { lessons: [], degraded: true };
  } finally {
    try { handle?.dispose(); } catch { /* ignore */ }
    try { conn?.close(); } catch { /* ignore */ }
  }
}
