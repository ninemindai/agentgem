// src/gem/acpRecommender.ts
//
// Turns a deterministic WorkflowSignal + inventory into a GemRecommendation by
// grounding a local ACP coding agent (Claude) with the signal and asking it to
// cluster/name/justify a Gem. The agent only ranks and explains — its output is
// re-validated against the inventory (the source of truth), and any failure
// degrades to a deterministic frequency-based recommendation. Never throws.
import { spawn } from "node:child_process";
import { Readable, Writable } from "node:stream";
import type { ArtifactType } from "./types.js";
import type { WorkflowSignal, ScanInventory } from "./workflowScan.js";
import type { GemSelection, ProjectSelection } from "./buildGem.js";

// `root` is the namespace: a project root path, or null for a global/plugin artifact.
export interface RecommendedItem { type: ArtifactType; name: string; reason: string; root: string | null }

// One recommended Gem = one coherent recurring flow. A project may yield several
// (e.g. diagram generation vs web scraping).
export interface GemCandidate {
  name: string;
  description: string;
  root: string;
  includeInstructions: boolean;
  include: RecommendedItem[];
  confidence: "high" | "medium" | "low";
}

// The full result of analysing a project: zero or more candidate Gems plus the
// project-level gaps (artifacts used in transcripts but absent from the inventory).
export interface WorkflowAnalysis {
  candidates: GemCandidate[];
  gaps: string[];
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

// ── Deterministic analysis (fallback + the agent's baseline) ─────────────────
// One frequency-based candidate. Multi-candidate splitting is the agent's value-add;
// the deterministic fallback stays a single coherent Gem.
export function deterministicAnalysis(signal: WorkflowSignal): WorkflowAnalysis {
  const include: RecommendedItem[] = [];
  let includeInstructions = false;
  for (const a of signal.artifacts) {
    if (a.type === "instructions") { if (a.invocations > 0) includeInstructions = true; continue; }
    if (!SELECTABLE.includes(a.type)) continue;
    if (a.invocations > 0 && a.confidence === "high")
      include.push({ type: a.type, name: a.name, reason: `${a.invocations} use(s) across ${a.sessionsUsedIn} session(s)`, root: a.root });
  }
  const gaps = signal.unresolved.filter((u) => u.kind !== "builtin").map((u) => u.name);
  const candidates: GemCandidate[] = include.length ? [{
    name: signal.root.split("/").pop() || "workflow",
    description: `Recommended from ${signal.sessions.scanned} session(s) of usage.`,
    root: signal.root,
    includeInstructions,
    include,
    confidence: "medium",
  }] : [];
  return { candidates, gaps };
}

/**
 * Map a validated candidate to a GemSelection. Global artifacts (root===null)
 * go top-level; project artifacts go under projects[root]; instructions are a
 * project boolean. buildGem resolves both namespaces from introspectAll.
 */
export function recommendationToSelection(c: GemCandidate): GemSelection {
  const sel: Exclude<GemSelection, { all: true }> = {};
  const globalNames = (t: ArtifactType) => c.include.filter((i) => i.type === t && i.root === null).map((i) => i.name);
  const gSkills = globalNames("skill"), gMcp = globalNames("mcp_server"), gHooks = globalNames("hook");
  if (gSkills.length) sel.skills = gSkills;
  if (gMcp.length) sel.mcpServers = gMcp;
  if (gHooks.length) sel.hooks = gHooks;

  const projects: Record<string, ProjectSelection> = {};
  const ensure = (root: string) => (projects[root] ??= {});
  for (const i of c.include) {
    if (i.root === null) continue;
    const ps = ensure(i.root);
    if (i.type === "skill") (ps.skills ??= []).push(i.name);
    else if (i.type === "mcp_server") (ps.mcpServers ??= []).push(i.name);
    else if (i.type === "hook") (ps.hooks ??= []).push(i.name);
  }
  if (c.includeInstructions) ensure(c.root).includeInstructions = true;
  if (Object.keys(projects).length) sel.projects = projects;
  return sel;
}

// Pull the first {...} block out of an agent message that may wrap JSON in prose/fences.
function extractJson(text: string): string {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  return start >= 0 && end > start ? text.slice(start, end + 1) : text;
}

/**
 * Validate a raw agent response against the inventory. Each candidate's include
 * names are checked against the inventory; hallucinated names are dropped
 * (logged) and a candidate with no surviving includes is discarded. On any
 * structural failure or zero valid candidates, fall back to the deterministic
 * analysis. The inventory is authoritative.
 */
export function validateAnalysis(raw: unknown, inv: ScanInventory, signal: WorkflowSignal): WorkflowAnalysis {
  const fallback = deterministicAnalysis(signal);
  let obj: any = raw;
  if (typeof raw === "string") { try { obj = JSON.parse(extractJson(raw)); } catch { return fallback; } }
  if (!obj || typeof obj !== "object" || !Array.isArray(obj.candidates)) return fallback;

  const g = inv.global ?? { skills: [], mcpServers: [], hooks: [] };
  // Resolve a name to its namespace: project root if present there, else global
  // (null), else undefined (hallucinated). Project is preferred on collision.
  const proj: Record<string, Set<string>> = {
    skill: new Set(inv.project.skills.map((s) => s.name)),
    mcp_server: new Set(inv.project.mcpServers.map((m) => m.name)),
    hook: new Set(inv.project.hooks.map((h) => h.name)),
  };
  const glob: Record<string, Set<string>> = {
    skill: new Set(g.skills.map((s) => s.name)),
    mcp_server: new Set(g.mcpServers.map((m) => m.name)),
    hook: new Set(g.hooks.map((h) => h.name)),
  };
  const resolveRoot = (type: string, name: string): string | null | undefined =>
    proj[type]?.has(name) ? inv.project.root : glob[type]?.has(name) ? null : undefined;

  const candidates: GemCandidate[] = [];
  for (const c of obj.candidates) {
    if (!c || typeof c !== "object" || !Array.isArray(c.include)) continue;
    const include: RecommendedItem[] = [];
    for (const it of c.include) {
      if (!it || !SELECTABLE.includes(it.type) || typeof it.name !== "string") continue;
      const root = resolveRoot(it.type, it.name);
      if (root === undefined) { console.error(`workflow: dropping hallucinated ${it.type} '${it.name}'`); continue; }
      include.push({ type: it.type, name: it.name, reason: typeof it.reason === "string" ? it.reason : "", root });
    }
    if (!include.length) continue;
    candidates.push({
      name: typeof c.name === "string" ? c.name : (signal.root.split("/").pop() || "workflow"),
      description: typeof c.description === "string" ? c.description : "",
      root: signal.root,
      includeInstructions: c.includeInstructions === true,
      include,
      confidence: ["high", "medium", "low"].includes(c.confidence) ? c.confidence : "medium",
    });
  }
  if (!candidates.length) return fallback;
  const gaps = Array.isArray(obj.gaps) ? obj.gaps.filter((g: unknown) => typeof g === "string") : fallback.gaps;
  return { candidates, gaps };
}

// ── The agent run ────────────────────────────────────────────────────────────
const GROUNDING = (signalJson: string, inventoryJson: string) =>
  `You recommend reusable "Gems" — bundles of installed artifacts for a recurring workflow.\n` +
  `A project often exercises SEVERAL distinct flows (e.g. diagram generation vs web scraping). ` +
  `Use the per-session "shapes" (sets of artifacts used together) plus co-occurrence to identify each ` +
  `recurring flow, and propose ONE Gem per flow.\n` +
  `The inventory has PROJECT artifacts (scoped to this repo) and GLOBAL artifacts (from the machine / ` +
  `installed plugins). Include either by exact name — both get bundled into the Gem.\n` +
  `USAGE SIGNAL (authoritative — invocation counts and shapes are facts):\n${signalJson}\n\n` +
  `INVENTORY (the only artifacts that exist — never invent names outside this):\n${inventoryJson}\n\n` +
  `Return ONLY a JSON object: {"candidates":[{"name","description","includeInstructions":bool,` +
  `"include":[{"type":"skill"|"mcp_server"|"hook","name","reason"}],"confidence":"high"|"medium"|"low"}],"gaps":[string]}.\n` +
  `Each candidate is one coherent flow. Prefer 1–4 candidates; don't split trivially or duplicate. Use exact inventory names.`;

// Skill bodies are large; send descriptions only. Global section is limited to
// artifacts that actually fired (the global catalog can be huge) — `usedGlobal`.
function trimInventory(inv: ScanInventory, usedGlobal: Set<string>) {
  const p = inv.project;
  const g = inv.global ?? { skills: [], mcpServers: [], hooks: [] };
  return {
    projectRoot: p.root, name: p.name,
    project: {
      skills: p.skills.map((s) => ({ name: s.name, description: s.description ?? "" })),
      mcpServers: p.mcpServers.map((m) => ({ name: m.name, transport: m.transport })),
      instructions: p.instructions.map((i) => ({ name: i.name })),
      hooks: p.hooks.map((h) => ({ name: h.name, event: h.event, matcher: h.matcher ?? null })),
    },
    global: {
      skills: g.skills.filter((s) => usedGlobal.has(s.name)).map((s) => ({ name: s.name })),
      mcpServers: g.mcpServers.filter((m) => usedGlobal.has(m.name)).map((m) => ({ name: m.name })),
      hooks: g.hooks.filter((h) => usedGlobal.has(h.name)).map((h) => ({ name: h.name, event: h.event })),
    },
  };
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return Promise.race([p, new Promise<T>((_, rej) => setTimeout(() => rej(new Error(`agent timeout after ${ms}ms`)), ms))]);
}

/**
 * Analyse `signal`/`inventory` into candidate Gems. Total: never throws. On any
 * agent error/timeout/junk, returns the deterministic analysis with degraded:true.
 */
export async function recommendWorkflow(
  signal: WorkflowSignal,
  inv: ScanInventory,
  opts: { connectFn?: AcpConnectFn; timeoutMs?: number; onDelta?: (chunk: string) => void } = {},
): Promise<{ analysis: WorkflowAnalysis; degraded: boolean }> {
  const connectFn = opts.connectFn ?? testConnectFn ?? defaultConnectFn;
  const timeoutMs = opts.timeoutMs ?? 60_000;
  let conn: { ctx: AcpCtx; close: () => void } | null = null;
  let handle: AcpSessionHandle | null = null;
  try {
    const usedGlobal = new Set(signal.artifacts.filter((a) => a.root === null && a.invocations > 0).map((a) => a.name));
    const trimmedInv = trimInventory(inv, usedGlobal);
    conn = await connectFn(CLAUDE_AGENT, null);
    handle = await conn.ctx.open(signal.root);
    await handle.setMode("plan");                 // explicit — never edits files
    const prompt = GROUNDING(JSON.stringify(signal), JSON.stringify(trimmedInv));
    const text = await withTimeout(handle.promptText(prompt, opts.onDelta), timeoutMs);
    return { analysis: validateAnalysis(text, inv, signal), degraded: false };
  } catch (err) {
    console.error("workflow: recommender fell back to deterministic:", (err as Error).message);
    return { analysis: deterministicAnalysis(signal), degraded: true };
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
