// src/gem/acpRecommender.ts
//
// Turns a deterministic WorkflowSignal + inventory into a GemRecommendation by
// grounding a local ACP coding agent (Claude) with the signal and asking it to
// cluster/name/justify a Gem. The agent only ranks and explains — its output is
// re-validated against the inventory (the source of truth), and any failure
// degrades to a deterministic frequency-based recommendation. Never throws.
import { spawn } from "node:child_process";
import { Readable, Writable } from "node:stream";
import type { ArtifactType, ProjectInventory } from "./types.js";
import type { WorkflowSignal } from "./workflowScan.js";
import type { GemSelection, ProjectSelection } from "./buildGem.js";

export interface RecommendedItem { type: ArtifactType; name: string; reason: string }
export interface GemRecommendation {
  name: string;
  description: string;
  root: string;
  includeInstructions: boolean;
  include: RecommendedItem[];
  exclude: RecommendedItem[];
  gaps: string[];
  confidence: "high" | "medium" | "low";
}

// Instructions are a boolean on ProjectSelection, not a named include.
const SELECTABLE: ArtifactType[] = ["skill", "mcp_server", "hook"];

// ── ACP façade ─────────────────────────────────────────────────────────────
// Thin seam over @agentclientprotocol/sdk so tests inject a plain object and the
// SDK details live in exactly one place (defaultConnectFn).
export interface AgentDescriptor { id: string; name: string; command: string[] }
export interface AcpSessionHandle {
  setMode(mode: string): Promise<void>;
  promptText(text: string, onDelta?: (chunk: string) => void): Promise<string>;
  dispose(): void;
}
export interface AcpCtx { open(cwd: string): Promise<AcpSessionHandle> }
export type AcpConnectFn = (descriptor: AgentDescriptor, app: unknown) => Promise<{ ctx: AcpCtx; close: () => void }>;

// Pinned Claude ACP adapter (npm: @agentclientprotocol/claude-agent-acp).
export const CLAUDE_AGENT: AgentDescriptor = { id: "claude-code", name: "Claude Code", command: ["claude-agent-acp"] };

let testConnectFn: AcpConnectFn | null = null;
/** Test-only seam: route recommendWorkflow through an in-process fake agent. */
export function setConnectFnForTests(fn: AcpConnectFn | null): void { testConnectFn = fn; }

// ── Deterministic recommendation (fallback + the agent's baseline) ───────────
export function deterministicRecommendation(signal: WorkflowSignal): GemRecommendation {
  const include: RecommendedItem[] = [];
  const exclude: RecommendedItem[] = [];
  let includeInstructions = false;
  for (const a of signal.artifacts) {
    if (a.type === "instructions") { if (a.invocations > 0) includeInstructions = true; continue; }
    if (!SELECTABLE.includes(a.type)) continue;
    if (a.invocations > 0 && a.confidence === "high")
      include.push({ type: a.type, name: a.name, reason: `${a.invocations} use(s) across ${a.sessionsUsedIn} session(s)` });
    else
      exclude.push({ type: a.type, name: a.name, reason: a.invocations === 0 ? "installed but never used" : "low-confidence signal" });
  }
  return {
    name: signal.root.split("/").pop() || "workflow",
    description: `Recommended from ${signal.sessions.scanned} session(s) of usage.`,
    root: signal.root,
    includeInstructions,
    include, exclude,
    gaps: signal.unresolved.filter((u) => u.kind !== "builtin").map((u) => u.name),
    confidence: include.length ? "medium" : "low",
  };
}

/** Map a validated recommendation to a project-namespaced GemSelection. */
export function recommendationToSelection(rec: GemRecommendation): GemSelection {
  const ps: ProjectSelection = {};
  const skills = rec.include.filter((i) => i.type === "skill").map((i) => i.name);
  const mcpServers = rec.include.filter((i) => i.type === "mcp_server").map((i) => i.name);
  const hooks = rec.include.filter((i) => i.type === "hook").map((i) => i.name);
  if (skills.length) ps.skills = skills;
  if (mcpServers.length) ps.mcpServers = mcpServers;
  if (hooks.length) ps.hooks = hooks;
  if (rec.includeInstructions) ps.includeInstructions = true;
  return { projects: { [rec.root]: ps } };
}

// Pull the first {...} block out of an agent message that may wrap JSON in prose/fences.
function extractJson(text: string): string {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  return start >= 0 && end > start ? text.slice(start, end + 1) : text;
}

/**
 * Validate a raw agent response against the inventory. Any include[].name not
 * present in the inventory is dropped (logged). On any structural failure, fall
 * back to the deterministic recommendation. The inventory is authoritative.
 */
export function validateRecommendation(raw: unknown, inventory: ProjectInventory, signal: WorkflowSignal): GemRecommendation {
  const fallback = deterministicRecommendation(signal);
  let obj: any = raw;
  if (typeof raw === "string") { try { obj = JSON.parse(extractJson(raw)); } catch { return fallback; } }
  if (!obj || typeof obj !== "object" || !Array.isArray(obj.include)) return fallback;

  const known: Record<string, Set<string>> = {
    skill: new Set(inventory.skills.map((s) => s.name)),
    mcp_server: new Set(inventory.mcpServers.map((m) => m.name)),
    hook: new Set(inventory.hooks.map((h) => h.name)),
  };

  const include: RecommendedItem[] = [];
  for (const it of obj.include) {
    if (!it || !SELECTABLE.includes(it.type) || typeof it.name !== "string") continue;
    if (!known[it.type]?.has(it.name)) { console.error(`workflow: dropping hallucinated ${it.type} '${it.name}'`); continue; }
    include.push({ type: it.type, name: it.name, reason: typeof it.reason === "string" ? it.reason : "" });
  }
  if (!include.length) return fallback;

  return {
    name: typeof obj.name === "string" ? obj.name : fallback.name,
    description: typeof obj.description === "string" ? obj.description : fallback.description,
    root: signal.root,
    includeInstructions: obj.includeInstructions === true || fallback.includeInstructions,
    include,
    exclude: fallback.exclude.filter((e) => !include.some((i) => i.name === e.name)),
    gaps: Array.isArray(obj.gaps) ? obj.gaps.filter((g: unknown) => typeof g === "string") : fallback.gaps,
    confidence: ["high", "medium", "low"].includes(obj.confidence) ? obj.confidence : "medium",
  };
}

// ── The agent run ────────────────────────────────────────────────────────────
const GROUNDING = (signalJson: string, inventoryJson: string) =>
  `You recommend which installed artifacts to bundle into a reusable "Gem".\n` +
  `USAGE SIGNAL (authoritative — invocation counts are facts):\n${signalJson}\n\n` +
  `INVENTORY (the only artifacts that exist — never invent names outside this):\n${inventoryJson}\n\n` +
  `Return ONLY a JSON object: {"name","description","includeInstructions":bool,` +
  `"include":[{"type":"skill"|"mcp_server"|"hook","name","reason"}],"gaps":[string],"confidence":"high"|"medium"|"low"}.\n` +
  `Cluster the high-usage artifacts into one coherent Gem. Use exact inventory names.`;

// Skill bodies are large; send descriptions only to stay within context.
function trimInventory(inv: ProjectInventory) {
  return {
    root: inv.root, name: inv.name,
    skills: inv.skills.map((s) => ({ name: s.name, description: s.description ?? "" })),
    mcpServers: inv.mcpServers.map((m) => ({ name: m.name, transport: m.transport })),
    instructions: inv.instructions.map((i) => ({ name: i.name })),
    hooks: inv.hooks.map((h) => ({ name: h.name, event: h.event, matcher: h.matcher ?? null })),
  };
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return Promise.race([p, new Promise<T>((_, rej) => setTimeout(() => rej(new Error(`agent timeout after ${ms}ms`)), ms))]);
}

/**
 * Recommend a Gem for `signal`/`inventory`. Total: never throws. On any agent
 * error/timeout/junk, returns the deterministic recommendation with degraded:true.
 */
export async function recommendWorkflow(
  signal: WorkflowSignal,
  inventory: ProjectInventory,
  opts: { connectFn?: AcpConnectFn; timeoutMs?: number; onDelta?: (chunk: string) => void } = {},
): Promise<{ recommendation: GemRecommendation; degraded: boolean }> {
  const connectFn = opts.connectFn ?? testConnectFn ?? defaultConnectFn;
  const timeoutMs = opts.timeoutMs ?? 60_000;
  let conn: { ctx: AcpCtx; close: () => void } | null = null;
  let handle: AcpSessionHandle | null = null;
  try {
    const trimmedInv = trimInventory(inventory);
    conn = await connectFn(CLAUDE_AGENT, null);
    handle = await conn.ctx.open(signal.root);
    await handle.setMode("plan");                 // explicit — never edits files
    const prompt = GROUNDING(JSON.stringify(signal), JSON.stringify(trimmedInv));
    const text = await withTimeout(handle.promptText(prompt, opts.onDelta), timeoutMs);
    return { recommendation: validateRecommendation(text, inventory, signal), degraded: false };
  } catch (err) {
    console.error("workflow: recommender fell back to deterministic:", (err as Error).message);
    return { recommendation: deterministicRecommendation(signal), degraded: true };
  } finally {
    try { handle?.dispose(); } catch { /* ignore */ }
    try { conn?.close(); } catch { /* ignore */ }
  }
}

/**
 * Real connect: spawn the ACP adapter and bridge stdio via the SDK. Wrapped so
 * the rest of the module is SDK-agnostic. Mirrors agentback console-chat's
 * defaultConnectFn, minus the workspace PATH walk and permission routing — this
 * agent runs in plan mode and we auto-deny any permission request.
 *
 * NEEDS LIVE VALIDATION: stdio bridging + set_mode against claude-agent-acp.
 */
export const defaultConnectFn: AcpConnectFn = async (descriptor) => {
  const { client, ndJsonStream } = await import("@agentclientprotocol/sdk");
  const [bin, ...args] = descriptor.command;
  const child = spawn(bin, args, { stdio: ["pipe", "pipe", "inherit"], env: process.env });
  await new Promise<void>((resolve, reject) => {
    child.once("spawn", () => resolve());
    child.once("error", (e) => reject(new Error(`failed to spawn ${bin}: ${e.message}`)));
  });
  const app: any = client({ name: "agentgem-workflow-recommender" });
  // Auto-deny any permission request — the recommender must not run tools.
  app.onRequest?.("session/request_permission", async () => ({ outcome: { outcome: "cancelled" } }));
  const input = Readable.toWeb(child.stdout!) as ReadableStream<Uint8Array>;
  const output = Writable.toWeb(child.stdin!) as WritableStream<Uint8Array>;
  const connection: any = app.connect(ndJsonStream(output, input));
  const agentCtx: any = connection.agent;

  const ctx: AcpCtx = {
    async open(cwd: string) {
      const session: any = await agentCtx.buildSession(cwd).start();
      const sessionId = session.sessionId as string;
      return {
        async setMode(mode: string) {
          try { await agentCtx.request("session/set_mode", { sessionId, modeId: mode }); } catch { /* best-effort */ }
        },
        async promptText(text: string, onDelta?: (chunk: string) => void) {
          let out = "";
          void session.prompt(text);
          for (;;) {
            const msg: any = await session.nextUpdate();
            if (msg.kind === "stop") break;
            if (msg.kind === "session_update" && msg.update?.sessionUpdate === "agent_message_chunk") {
              const block = msg.update.content;
              if (block?.type === "text" && typeof block.text === "string") { out += block.text; onDelta?.(block.text); }
            }
          }
          return out;
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
