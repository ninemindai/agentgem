// src/gem/acpRun.ts
//
// Runs a materialized Gem by driving a locally-installed ACP coding agent (Claude)
// against a task, and captures what the agent DID — its message text plus the
// trace of tool invocations. This is the trust-inversion of acpRecommender:
//   recommender                     runner (here)
//   ───────────                     ─────────────
//   neutral analysisWorkspace()  →  the materialized testbed dir
//   mode "plan" (never edits)    →  a tool-capable mode (agent uses the Gem)
//   captures agent_message_chunk →  also captures tool_call updates
//
// As with the recommender, the SDK details live behind a single connectFn seam so
// tests inject a plain fake. Unlike the recommender there is no deterministic
// fallback — a failed run is a real outcome the caller (e.g. verification) needs,
// so we never throw: failures surface as { ok:false, error }.
//
// NOTE (consolidation): the ACP façade is duplicated from acpRecommender on purpose
// while this path is prototyped. Once both are proven, the two connectFns should be
// unified into a shared acpSession module.
import type { AgentDescriptor } from "./acpRecommender.js";

// One tool the agent invoked during the run. Mirrors the fields of an ACP
// `tool_call` session update that matter for verification/observability.
export interface ToolInvocation {
  toolCallId: string;
  title: string;
  kind?: string;
  status?: string;
}

// Everything the agent produced for one prompt: the assembled message text and the
// ordered list of tools it invoked.
export interface RunResult {
  text: string;
  toolCalls: ToolInvocation[];
}

// ── Session-update reducer ───────────────────────────────────────────────────
// Pure folding of ACP session updates into a RunResult, extracted from the SDK
// loop so it's unit-testable. Handles message text plus the tool_call lifecycle:
// `tool_call` records a tool (status usually "pending"); `tool_call_update` merges
// the later status/title into the SAME tool by id so the final result reflects
// "completed"/"failed" rather than the initial "pending".
export type RunAccumulator = RunResult;

export function createAccumulator(): RunAccumulator {
  return { text: "", toolCalls: [] };
}

// A minimal shape of the SDK's `session_update.update`; we read only what we use.
interface UpdateLike {
  sessionUpdate?: string;
  content?: { type?: string; text?: string };
  toolCallId?: string;
  title?: string;
  kind?: string;
  status?: string;
}

export function applyUpdate(
  acc: RunAccumulator,
  update: UpdateLike,
  handlers?: { onDelta?: (chunk: string) => void; onToolCall?: (tool: ToolInvocation) => void },
): void {
  switch (update.sessionUpdate) {
    case "agent_message_chunk": {
      const block = update.content;
      if (block?.type === "text" && typeof block.text === "string") {
        acc.text += block.text;
        handlers?.onDelta?.(block.text);
      }
      return;
    }
    case "tool_call": {
      if (!update.toolCallId) return;
      const tool: ToolInvocation = {
        toolCallId: update.toolCallId,
        title: update.title ?? "",
        kind: update.kind,
        status: update.status,
      };
      acc.toolCalls.push(tool);
      handlers?.onToolCall?.(tool);   // fires once, on start — final status lands in the result
      return;
    }
    case "tool_call_update": {
      const existing = acc.toolCalls.find((t) => t.toolCallId === update.toolCallId);
      if (!existing) return;          // update for a tool we never saw start — ignore
      if (update.status !== undefined) existing.status = update.status;
      if (update.kind !== undefined) existing.kind = update.kind;
      if (update.title !== undefined && update.title !== "") existing.title = update.title;
      return;
    }
    default:
      return;
  }
}

// ── ACP façade (run flavor) ──────────────────────────────────────────────────
export interface RunSessionHandle {
  setMode(mode: string): Promise<void>;
  prompt(
    text: string,
    onDelta?: (chunk: string) => void,
    onToolCall?: (tool: ToolInvocation) => void,
  ): Promise<RunResult>;
  dispose(): void;
}
export interface RunCtx { open(cwd: string): Promise<RunSessionHandle> }
export type RunConnectFn = (descriptor: AgentDescriptor, app: unknown) => Promise<{ ctx: RunCtx; close: () => void }>;

// The outcome of a run. `ok:false` carries the failure reason; `result` is always
// present (empty on failure) so callers don't have to null-check.
export interface GemRunOutcome {
  ok: boolean;
  result: RunResult;
  error?: string;
}

// Pinned Claude ACP adapter, same binary the recommender spawns.
export const CLAUDE_RUN_AGENT: AgentDescriptor = { id: "claude-code", name: "Claude Code", command: ["claude-agent-acp"] };

// The default non-plan mode: lets the agent actually invoke the Gem's tools. The
// recommender pins "plan"; the runner pins its counterpart so the trust-inversion
// is explicit rather than incidental.
export const DEFAULT_RUN_MODE = "default";

// Default prompt timeout. Generous — a real Gem run can drive the agent through
// several tool calls — but bounded so a wedged agent can't hang the caller.
export const DEFAULT_RUN_TIMEOUT_MS = 300_000;

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`agent run timed out after ${ms}ms`)), ms);
    p.then((v) => { clearTimeout(timer); resolve(v); }, (e) => { clearTimeout(timer); reject(e); });
  });
}

export interface RunGemOptions {
  dir: string;
  task: string;
  mode?: string;
  connectFn?: RunConnectFn;
  timeoutMs?: number;
  onDelta?: (chunk: string) => void;
  onToolCall?: (tool: ToolInvocation) => void;
}

/**
 * Drive a local ACP agent against `task` inside the already-materialized `dir`,
 * returning what it did. Never throws — connection/spawn failures come back as
 * { ok:false, error }.
 */
export async function runGemWithAgent(opts: RunGemOptions): Promise<GemRunOutcome> {
  const connectFn = opts.connectFn ?? defaultRunConnectFn;
  const mode = opts.mode ?? DEFAULT_RUN_MODE;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_RUN_TIMEOUT_MS;
  let conn: { ctx: RunCtx; close: () => void } | null = null;
  let handle: RunSessionHandle | null = null;
  try {
    conn = await connectFn(CLAUDE_RUN_AGENT, null);
    handle = await conn.ctx.open(opts.dir);   // the testbed dir — NOT a neutral one
    await handle.setMode(mode);               // tool-capable — the agent uses the Gem
    const result = await withTimeout(handle.prompt(opts.task, opts.onDelta, opts.onToolCall), timeoutMs);
    return { ok: true, result };
  } catch (err) {
    return { ok: false, result: { text: "", toolCalls: [] }, error: (err as Error).message };
  } finally {
    try { handle?.dispose(); } catch { /* ignore */ }
    try { conn?.close(); } catch { /* ignore */ }
  }
}

/**
 * Real connect: spawn the ACP adapter and bridge stdio, capturing both message
 * chunks and tool_call updates. Mirrors acpRecommender.defaultConnectFn but runs
 * in a tool-capable mode and aggregates the tool-invocation trace.
 *
 * NEEDS LIVE VALIDATION: stdio bridging + tool_call capture against claude-agent-acp.
 */
export const defaultRunConnectFn: RunConnectFn = async (descriptor) => {
  const { client, ndJsonStream } = await import("@agentclientprotocol/sdk");
  const { spawn } = await import("node:child_process");
  const { mkdirSync } = await import("node:fs");
  const { Readable, Writable } = await import("node:stream");
  const [bin, ...args] = descriptor.command;
  const child = spawn(bin, args, { stdio: ["pipe", "pipe", "inherit"], env: process.env });
  await new Promise<void>((resolve, reject) => {
    child.once("spawn", () => resolve());
    child.once("error", (e) => reject(new Error(`failed to spawn ${bin}: ${e.message}`)));
  });
  const app: any = client({ name: "agentgem-gem-runner" });
  // Unlike the recommender we DO let the agent run tools; the testbed dir is the
  // blast-radius boundary. Auto-allow permission requests for this prototype.
  app.onRequest?.("session/request_permission", async () => ({ outcome: { outcome: "selected", optionId: "allow" } }));
  const input = Readable.toWeb(child.stdout!) as ReadableStream<Uint8Array>;
  const output = Writable.toWeb(child.stdin!) as WritableStream<Uint8Array>;
  const connection: any = app.connect(ndJsonStream(output, input));
  const agentCtx: any = connection.agent;

  const ctx: RunCtx = {
    async open(cwd: string) {
      try { mkdirSync(cwd, { recursive: true }); } catch { /* best-effort */ }
      const session: any = await agentCtx.buildSession(cwd).start();
      const sessionId = session.sessionId as string;
      return {
        async setMode(mode: string) {
          try { await agentCtx.request("session/set_mode", { sessionId, modeId: mode }); } catch { /* best-effort */ }
        },
        async prompt(text, onDelta, onToolCall) {
          const acc = createAccumulator();
          void session.prompt(text);
          for (;;) {
            const msg: any = await session.nextUpdate();
            if (msg.kind === "stop") break;
            if (msg.kind !== "session_update") continue;
            applyUpdate(acc, msg.update ?? {}, { onDelta, onToolCall });
          }
          return acc;
        },
        dispose() { try { session.dispose?.(); } catch { /* ignore */ } },
      };
    },
  };
  return {
    ctx,
    close: () => {
      try { connection.close(); } catch { /* ignore */ }
      try { child.kill(); } catch { /* ignore */ }
    },
  };
};
