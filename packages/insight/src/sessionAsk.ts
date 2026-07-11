// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
//
// Raw-trace interrogation for the goldmine chat WITHOUT putting raw content in
// the chat agent's context. The scrubbed transcript is handed to an ephemeral
// ACP subprocess running the session's own agent family (claude→claude-code,
// codex→codex); only the subprocess's text answer is returned. Mirrors the
// acpRecommender façade (AcpConnectFn seam + deny permission + neutral cwd).
// Never throws — connection/timeout/unknown-source all degrade to answered:false.
import { AGENTS } from "@agentgem/base";
import type { AgentDescriptor } from "@agentgem/base";
import { connectAcpAdapter } from "@agentgem/base";
import { createLogger } from "@agentgem/base";
import { loadSessionTranscript } from "./inspectSession.js";
import type { TranscriptView } from "./inspectSession.js";
import { analysisWorkspace } from "./acpRecommender.js";
import type { AcpConnectFn, AcpCtx } from "./acpRecommender.js";

const log = createLogger("insight");
const DEFAULT_MAX_CHARS = 60_000;
const DEFAULT_TIMEOUT_MS = 120_000;

export interface AskSessionResult { answered: boolean; answer: string; agentUsed: string | null }

let testConnectFn: AcpConnectFn | null = null;
export function setAskConnectFnForTests(fn: AcpConnectFn | null): void { testConnectFn = fn; }

// The session's source → its ACP agent family. Only claude/codex have adapters.
function agentDescriptorFor(agent: string): AgentDescriptor | null {
  if (agent === "claude" || agent === "claude-code") return AGENTS.find((a) => a.id === "claude-code") ?? null;
  if (agent === "codex") return AGENTS.find((a) => a.id === "codex") ?? null;
  return null;
}

// Render the scrubbed transcript to a bounded text block. Content is already
// secret-scrubbed by loadSessionTranscript; we only bound its size (head+tail
// window with an elision marker) so a long session doesn't blow the prompt.
function renderTranscript(view: TranscriptView, maxChars: number): string {
  const parts: string[] = [];
  for (const turn of view.turns) {
    for (const span of turn.spans) {
      if (span.kind === "message") parts.push(`${span.role}: ${span.text}`);
      else parts.push(`tool ${span.name}(${span.input})${span.output !== undefined ? ` -> ${span.output}` : ""}`);
    }
  }
  const full = parts.join("\n");
  if (full.length <= maxChars) return full;
  const half = Math.floor(maxChars / 2);
  return `${full.slice(0, half)}\n… [${full.length - maxChars} chars elided] …\n${full.slice(-half)}`;
}

const INSTRUCTION =
  "You are analyzing a past coding-agent session transcript to answer one question about it. " +
  "Use only the transcript below. Answer concisely and quote specific moments when relevant.\n\n";

export async function askSession(
  sessionId: string,
  agent: string,
  question: string,
  opts: { connectFn?: AcpConnectFn; timeoutMs?: number; maxChars?: number } = {},
): Promise<AskSessionResult> {
  const descriptor = agentDescriptorFor(agent);
  if (!descriptor) {
    return { answered: false, agentUsed: null,
      answer: `raw interrogation isn't available for ${agent} sessions — use summarize_session for their metrics and quality signal.` };
  }
  let view: TranscriptView | null;
  try { view = await loadSessionTranscript(sessionId, agent as never); } catch { view = null; }
  if (!view) return { answered: false, agentUsed: null, answer: `session '${sessionId}' not found.` };

  const connectFn = opts.connectFn ?? testConnectFn ?? defaultAskConnectFn;
  const prompt = INSTRUCTION + renderTranscript(view, opts.maxChars ?? DEFAULT_MAX_CHARS) + `\n\nQuestion: ${question}`;
  const deadline = Date.now() + (opts.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  const left = () => Math.max(0, deadline - Date.now());
  let conn: { ctx: AcpCtx; close: () => void } | null = null;
  try {
    conn = await withTimeout(connectFn(descriptor, null), left());
    const handle = await withTimeout(conn.ctx.open(analysisWorkspace()), left());
    try {
      await withTimeout(handle.setMode("plan"), left());          // never edits files
      const answer = await withTimeout(handle.promptText(prompt), left());
      return { answered: true, agentUsed: descriptor.id, answer };
    } finally { try { handle.dispose(); } catch { /* ignore */ } }
  } catch (err) {
    // The raw adapter error (which can carry binary paths / system details) stays in the log; the
    // client-facing answer is a fixed, non-revealing string.
    log.warn("askSession degraded: %s", (err as Error)?.message ?? err);
    return { answered: false, agentUsed: descriptor.id, answer: "session interrogation is temporarily unavailable" };
  } finally { try { conn?.close(); } catch { /* ignore */ } }
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return Promise.race([p, new Promise<T>((_, rej) => setTimeout(() => rej(new Error(`timed out after ${ms}ms`)), ms))]);
}

// Real connect: same plumbing as acpRecommender.defaultConnectFn, deny perms,
// aggregate only agent_message_chunk text.
export const defaultAskConnectFn: AcpConnectFn = async (descriptor) => {
  const raw = await connectAcpAdapter(descriptor as AgentDescriptor, { clientName: "agentgem-goldmine-ask", permission: "deny" });
  const ctx: AcpCtx = {
    async open(cwd: string) {
      const session = await raw.open(cwd);
      return {
        setMode: (mode: string) => session.setMode(mode),
        async promptText(text: string, onDelta?: (chunk: string) => void) {
          let out = "";
          await session.prompt(text, (u) => {
            const update = u as { sessionUpdate?: string; content?: { type?: string; text?: string } };
            if (update?.sessionUpdate === "agent_message_chunk" && update.content?.type === "text" && typeof update.content.text === "string") {
              out += update.content.text; onDelta?.(update.content.text);
            }
          });
          return out;
        },
        dispose: () => session.dispose(),
      };
    },
  };
  return { ctx, close: raw.close };
};
