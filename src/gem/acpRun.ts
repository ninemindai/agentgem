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
import { connectAcpAdapter, type AgentDescriptor } from "./acpSession.js";
export type { AgentDescriptor } from "./acpSession.js";

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

// Test seam: route runGemWithAgent through an in-process fake agent (mirrors
// acpRecommender.setConnectFnForTests). Lets the REST/SSE surface be exercised
// without spawning a real coding agent.
let testConnectFn: RunConnectFn | null = null;
export function setRunConnectFnForTests(fn: RunConnectFn | null): void { testConnectFn = fn; }
/** True when a fake agent is injected — callers skip adapter resolution/fetch. */
export function hasTestConnectFn(): boolean { return testConnectFn !== null; }

export interface RunGemOptions {
  dir: string;
  task: string;
  mode?: string;
  descriptor?: AgentDescriptor;   // which ACP adapter to spawn; defaults to Claude
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
  const connectFn = opts.connectFn ?? testConnectFn ?? defaultRunConnectFn;
  const mode = opts.mode ?? DEFAULT_RUN_MODE;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_RUN_TIMEOUT_MS;
  let conn: { ctx: RunCtx; close: () => void } | null = null;
  let handle: RunSessionHandle | null = null;
  try {
    conn = await connectFn(opts.descriptor ?? CLAUDE_RUN_AGENT, null);
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
 * Real connect: route through the shared adapter plumbing and fold each update into a RunResult via
 * applyUpdate, capturing the tool trace.
 *
 * SECURITY: permission is "deny" by default. Auto-allow grants the agent's tool calls — including
 * shell — which run with the user's full privileges (the run dir is only the cwd, NOT a sandbox, so
 * it does NOT bound the blast radius). Auto-allow is therefore opt-in: set AGENTGEM_GEM_RUN_AUTOALLOW=1
 * to enable it for a trusted local session. Combined with the loopback origin guard (cross-site
 * requests are rejected) and the server-derived run dir, this keeps a malicious browser tab from
 * driving a fully-permissioned local agent. A real isolation boundary (container/sandbox) is the
 * stronger follow-up that would let auto-allow be safe by default.
 */
export const defaultRunConnectFn: RunConnectFn = async (descriptor) => {
  const permission = process.env.AGENTGEM_GEM_RUN_AUTOALLOW === "1" ? "allow" : "deny";
  const raw = await connectAcpAdapter(descriptor, { clientName: "agentgem-gem-runner", permission });
  const ctx: RunCtx = {
    async open(cwd: string) {
      const session = await raw.open(cwd);
      return {
        setMode: (mode: string) => session.setMode(mode),
        async prompt(text, onDelta, onToolCall) {
          const acc = createAccumulator();
          await session.prompt(text, (u) => applyUpdate(acc, (u ?? {}) as Parameters<typeof applyUpdate>[1], { onDelta, onToolCall }));
          return acc;
        },
        dispose: () => session.dispose(),
      };
    },
  };
  return { ctx, close: raw.close };
};
