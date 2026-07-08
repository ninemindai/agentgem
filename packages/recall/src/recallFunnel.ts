// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
// The "A engine": fan `ask_session` across the selected sessions under a hard cap
// and bounded concurrency, then synthesize. Raw transcripts never reach here — a
// sub-agent reads each (scrubbed) transcript inside askSession and returns only
// text; synthesis sees only those per-session answers. Batches of `concurrency`
// keep the subprocess count bounded. All ACP/LLM work is injected via FunnelDeps
// so the orchestration is deterministically testable.
import { askSession } from "@agentgem/insight";

export type FunnelMode = "chat" | "extract";
export interface SessionRef { sessionId: string; agent: string }
export interface SessionAnswer { sessionId: string; agent: string; answered: boolean; answer: string }
export type FunnelEvent =
  | { type: "session_started"; sessionId: string }
  | { type: "session_done"; sessionId: string; answered: boolean }
  | { type: "capped"; scanned: number; requested: number; cap: number }
  | { type: "synthesis_delta"; text: string }
  | { type: "done"; answers: SessionAnswer[]; synthesis: string }
  | { type: "cancelled" };
export interface FunnelInput { sessions: SessionRef[]; prompt: string; mode: FunnelMode; signal?: AbortSignal }
export interface FunnelDeps {
  askOne(ref: SessionRef, prompt: string, signal: AbortSignal): Promise<{ answered: boolean; answer: string }>;
  synthesize(answers: SessionAnswer[], prompt: string, mode: FunnelMode, signal: AbortSignal): AsyncIterable<string>;
  cap?: number;
  concurrency?: number;
}

export const RECALL_CAP = 12;
export const RECALL_CONCURRENCY = 3;

// Default wiring for real runs. Plan 2 replaces `synthesize` with a streaming LLM
// pass; this deterministic structured join is the working fallback.
export function defaultFunnelDeps(): FunnelDeps {
  return {
    async askOne(ref, prompt, signal) {
      const r = await askSession(ref.sessionId, ref.agent, prompt, { timeoutMs: signalTimeout(signal) });
      return { answered: r.answered, answer: r.answer };
    },
    async *synthesize(answers) {
      const ok = answers.filter((a) => a.answered);
      yield ok.map((a) => `### ${a.agent}:${a.sessionId}\n${a.answer}`).join("\n\n") || "No sessions produced an answer.";
    },
  };
}
function signalTimeout(_signal: AbortSignal): number { return 120_000; }

export async function* recallFunnel(input: FunnelInput, deps: FunnelDeps): AsyncGenerator<FunnelEvent> {
  const cap = deps.cap ?? RECALL_CAP;
  const concurrency = Math.max(1, deps.concurrency ?? RECALL_CONCURRENCY);
  const signal = input.signal ?? new AbortController().signal;

  const scoped = input.sessions.slice(0, cap);
  if (input.sessions.length > cap) yield { type: "capped", scanned: scoped.length, requested: input.sessions.length, cap };

  const answers: SessionAnswer[] = [];
  for (let i = 0; i < scoped.length; i += concurrency) {
    if (signal.aborted) { yield { type: "cancelled" }; return; }
    const batch = scoped.slice(i, i + concurrency);
    for (const ref of batch) yield { type: "session_started", sessionId: ref.sessionId };
    const results = await Promise.all(batch.map((ref) => deps.askOne(ref, input.prompt, signal)));
    for (let j = 0; j < batch.length; j++) {
      const ref = batch[j], r = results[j];
      answers.push({ sessionId: ref.sessionId, agent: ref.agent, answered: r.answered, answer: r.answer });
      yield { type: "session_done", sessionId: ref.sessionId, answered: r.answered };
    }
  }
  if (signal.aborted) { yield { type: "cancelled" }; return; }

  let synthesis = "";
  for await (const delta of deps.synthesize(answers, input.prompt, input.mode, signal)) {
    if (signal.aborted) { yield { type: "cancelled" }; return; }
    synthesis += delta; yield { type: "synthesis_delta", text: delta };
  }
  yield { type: "done", answers, synthesis };
}
