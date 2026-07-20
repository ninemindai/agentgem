// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
// src/goldmine/recall.ts
//
// Server wiring for @agentgem/recall: the on-disk index path, and the
// FunnelDeps that turn recallFunnel's abstract askOne/synthesize into real
// work — ask_session per hit (via @agentgem/insight's askSession) and a
// cross-session synthesis pass over an ephemeral ACP subprocess (same
// deny-perms/neutral-cwd pattern as acpRecommender/sessionAsk). The default
// synthesizer never throws: any connect/prompt failure degrades to the
// deterministic join of the per-session answers.
import { join } from "node:path";
import { agentgemHome } from "@agentgem/model";
import { connectAcpAdapter, AGENTS, createLogger, type AgentDescriptor } from "@agentgem/base";
import { askSession } from "@agentgem/insight";
import { analysisWorkspace } from "@agentgem/insight";
import type { FunnelDeps, SessionAnswer, FunnelMode } from "@agentgem/recall";

const log = createLogger("goldmine");

// Bounds the real ACP synth path (connect/open/setMode/prompt) so a stalled
// adapter degrades instead of hanging the generator forever — mirrors
// packages/insight/src/sessionAsk.ts's withTimeout/DEFAULT_TIMEOUT_MS.
const DEFAULT_TIMEOUT_MS = 120_000;

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return Promise.race([p, new Promise<T>((_, rej) => setTimeout(() => rej(new Error(`timed out after ${ms}ms`)), ms))]);
}

/** ~/.agentgem/recall-index.db — the on-disk node:sqlite database file for the local recall index. */
export function defaultRecallDbPath(): string {
  return join(agentgemHome(), ".agentgem", "recall-index.db");
}

/** Bridges a real (or fake, in tests) synthesis agent into the funnel's streaming contract. */
export type SynthConnect = (question: string, onDelta: (t: string) => void, signal: AbortSignal) => Promise<string>;

function buildSynthesisPrompt(answered: SessionAnswer[], prompt: string): string {
  const findings = answered.map((a) => `### ${a.agent}:${a.sessionId}\n${a.answer}`).join("\n\n");
  return `You are synthesizing findings from ${answered.length} past sessions to answer: ${prompt}. Per-session findings:\n\n${findings}`;
}

function deterministicJoin(answered: SessionAnswer[]): string {
  return answered.map((a) => `### ${a.agent}:${a.sessionId}\n${a.answer}`).join("\n\n") || "No sessions produced an answer.";
}

// Neutral claude-code descriptor for the synthesis pass — same family as
// acpRecommender/sessionAsk's default agent; synthesis reasons only over the
// collected answers, so the descriptor is not tied to any one session's agent.
function synthesisDescriptor(): AgentDescriptor | null {
  return AGENTS.find((a) => a.id === "claude-code") ?? null;
}

// Real ACP connect: deny perms, neutral cwd, plan mode (never edits files),
// aggregate only agent_message_chunk text — mirrors sessionAsk.defaultAskConnectFn.
const defaultSynthConnect: SynthConnect = async (question, onDelta, signal) => {
  const descriptor = synthesisDescriptor();
  // No descriptor is a degrade case, not a silent empty result — route it
  // through the same catch()-driven fallback as a connect/prompt failure
  // (see synthesize's `streamed` guard below) so the caller still gets the
  // deterministic join instead of nothing.
  if (!descriptor) throw new Error("no synthesis descriptor available");
  const deadline = Date.now() + DEFAULT_TIMEOUT_MS;
  const left = () => Math.max(0, deadline - Date.now());
  const raw = await withTimeout(
    connectAcpAdapter(descriptor, { clientName: "agentgem-recall-synth", permission: "deny" }),
    left(),
  );
  try {
    const session = await withTimeout(raw.open(analysisWorkspace()), left());
    try {
      await withTimeout(session.setMode("plan"), left());
      let out = "";
      await withTimeout(
        session.prompt(question, (u) => {
          if (signal.aborted) return;
          const update = u as { sessionUpdate?: string; content?: { type?: string; text?: string } };
          if (update?.sessionUpdate === "agent_message_chunk" && update.content?.type === "text" && typeof update.content.text === "string") {
            out += update.content.text;
            onDelta(update.content.text);
          }
        }),
        left(),
      );
      return out;
    } finally { try { session.dispose(); } catch { /* ignore */ } }
  } finally { try { raw.close(); } catch { /* ignore */ } }
};

export function serverFunnelDeps(opts: { synthConnect?: SynthConnect } = {}): FunnelDeps {
  const synthConnect = opts.synthConnect ?? defaultSynthConnect;
  return {
    async askOne(ref, prompt) {
      const r = await askSession(ref.sessionId, ref.agent, prompt);
      return { answered: r.answered, answer: r.answer };
    },
    async *synthesize(answers: SessionAnswer[], prompt: string, _mode: FunnelMode, signal: AbortSignal) {
      const answered = answers.filter((a) => a.answered);
      const synthesisPrompt = buildSynthesisPrompt(answered, prompt);

      // Bridge the connect fn's push-style onDelta callback into this
      // generator's pull-style yields (queue+wake, mirrors chatSession.ts).
      const queue: string[] = [];
      let wake: (() => void) | null = null;
      const bump = () => { if (wake) { wake(); wake = null; } };
      let settled = false;
      let error: Error | undefined;

      const running = synthConnect(synthesisPrompt, (chunk) => { queue.push(chunk); bump(); }, signal)
        .catch((e) => { error = e as Error; })
        .finally(() => { settled = true; bump(); });

      // Whether any real chunk was ever yielded to the caller. A mid-stream
      // failure that already produced output must not also append the full
      // deterministicJoin fallback — that would duplicate the (truncated)
      // prose with a complete restatement. The join is reserved for the
      // clean-failure case: nothing streamed before things went wrong.
      let streamed = false;
      while (true) {
        if (signal.aborted) return;
        while (queue.length) {
          if (signal.aborted) return;
          streamed = true;
          yield queue.shift()!;
        }
        if (settled) break;
        await new Promise<void>((res) => { wake = res; });
      }
      await running;

      if (error) {
        log.warn("recall synth degraded: %s", error.message ?? error);
        if (!signal.aborted && !streamed) yield deterministicJoin(answered);
      }
    },
  };
}
