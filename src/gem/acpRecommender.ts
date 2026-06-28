// src/gem/acpRecommender.ts
//
// Turns a deterministic WorkflowSignal + inventory into a GemRecommendation by
// grounding a local ACP coding agent (Claude) with the signal and asking it to
// cluster/name/justify a Gem. The agent only ranks and explains — its output is
// re-validated against the inventory (the source of truth), and any failure
// degrades to a deterministic frequency-based recommendation. Never throws.
import { join } from "node:path";
import { agentgemHome } from "../resolveDir.js";
import { connectAcpAdapter, type AgentDescriptor } from "./acpSession.js";
export type { AgentDescriptor } from "./acpSession.js";
import type { ArtifactType } from "./types.js";
import type { WorkflowSignal, ScanInventory } from "./workflowScan.js";
import type { GemSelection, ProjectSelection } from "./buildGem.js";
import type { DistilledSkill } from "./distill.js";
import type { Reflection } from "./distillTypes.js";

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
  // Draft skills distilled from the builtin procedure, referenced by candidates
  // (proposal §2). Empty on the selective-only path and on every fallback.
  distilled: DistilledSkill[];
  reflections: Reflection[];   // secondary signal; filled by the controller/stream, not the recommender
}

// Instructions are a boolean on ProjectSelection, not a named include.
const SELECTABLE: ArtifactType[] = ["skill", "mcp_server", "hook"];

// ── ACP façade ─────────────────────────────────────────────────────────────
// Thin seam over the shared adapter plumbing so tests inject a plain object.
// AgentDescriptor now lives in acpSession (re-exported above).
export interface AcpSessionHandle {
  setMode(mode: string): Promise<void>;
  promptText(text: string, onDelta?: (chunk: string) => void): Promise<string>;
  dispose(): void;
}
export interface AcpCtx { open(cwd: string): Promise<AcpSessionHandle> }
export type AcpConnectFn = (descriptor: AgentDescriptor, app: unknown) => Promise<{ ctx: AcpCtx; close: () => void }>;

// Pinned Claude ACP adapter (npm: @agentclientprotocol/claude-agent-acp).
export const CLAUDE_AGENT: AgentDescriptor = { id: "claude-code", name: "Claude Code", command: ["claude-agent-acp"] };

// Neutral working dir for the recommender's ACP session. We do NOT open the
// session in the analyzed project, or claude-agent-acp would log a session
// transcript THERE — inflating that project's own session history (skewing
// future analyses and busting the per-project cache). The agent only reasons
// over the JSON brief, so its cwd is irrelevant to the result.
export function analysisWorkspace(): string { return join(agentgemHome(), ".agentgem", "analysis"); }

let testConnectFn: AcpConnectFn | null = null;
/** Test-only seam: route recommendWorkflow + distillWorkflow through an in-process fake agent. */
export function setConnectFnForTests(fn: AcpConnectFn | null): void { testConnectFn = fn; }
/** The active test connect fn (or null). distillWorkflow shares this seam. */
export function currentTestConnectFn(): AcpConnectFn | null { return testConnectFn; }

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
  return { candidates, gaps, distilled: [], reflections: [] };
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
  return { candidates, gaps, distilled: [], reflections: [] };
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
    const prompt = GROUNDING(JSON.stringify(signal), JSON.stringify(trimmedInv));
    // Bound EVERY step against one shared deadline — connect + session open +
    // setMode + prompt. The ACP `initialize` handshake and session start are
    // otherwise unbounded (acpSession), so a stalled adapter/auth would hang
    // forever, past the prompt-only timeout.
    const deadline = Date.now() + timeoutMs;
    const left = () => Math.max(0, deadline - Date.now());
    conn = await withTimeout(connectFn(CLAUDE_AGENT, null), left());
    handle = await withTimeout(conn.ctx.open(analysisWorkspace()), left());   // neutral cwd — don't pollute the project
    await withTimeout(handle.setMode("plan"), left());                 // explicit — never edits files
    const text = await withTimeout(handle.promptText(prompt, opts.onDelta), left());
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
 * Real connect: route through the shared adapter plumbing in plan mode with
 * permissions auto-denied (the recommender must never run tools), aggregating
 * only the agent's message text into a string.
 */
export const defaultConnectFn: AcpConnectFn = async (descriptor) => {
  const raw = await connectAcpAdapter(descriptor, { clientName: "agentgem-workflow-recommender", permission: "deny" });
  const ctx: AcpCtx = {
    async open(cwd: string) {
      const session = await raw.open(cwd);
      return {
        setMode: (mode: string) => session.setMode(mode),
        async promptText(text: string, onDelta?: (chunk: string) => void) {
          let out = "";
          await session.prompt(text, (u) => {
            const update = u as { sessionUpdate?: string; content?: { type?: string; text?: string } };
            if (update?.sessionUpdate === "agent_message_chunk") {
              const block = update.content;
              if (block?.type === "text" && typeof block.text === "string") { out += block.text; onDelta?.(block.text); }
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
