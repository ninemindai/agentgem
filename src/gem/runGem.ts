// src/gem/runGem.ts
//
// The end-to-end "run my Gem" path: materialize a portable Gem into a runnable
// testbed dir, then drive a local ACP agent against it (optionally verifying).
//
// Why not targets.materialize(gem, "claude")? That renders the gem-archive layout
// (skills under `skills/<n>/SKILL.md`), which is NOT where Claude Code discovers
// skills at runtime. The runnable layout (`.claude/skills/<n>/SKILL.md`, etc.) is
// produced by the testbed import writer — so we adapt the Gem's self-contained
// artifacts into a ConfigInventory and reuse that tested writer.
import { randomUUID } from "node:crypto";
import type { Gem, ConfigInventory } from "./types.js";
import { scaffoldTestbed, importArtifacts, type ImportedRef, type ImportSkip } from "./testbed.js";
import type { TestbedFlavorId } from "./testbedFlavors.js";
import { runGemWithAgent, CLAUDE_RUN_AGENT, type RunConnectFn, type GemRunOutcome, type ToolInvocation, type AgentDescriptor } from "./acpRun.js";
import { verifyGemRun, type GemExpectations, type VerificationReport } from "./gemVerify.js";

// Which local coding agent to drive. Each maps an ACP adapter (the binary to
// spawn) to the testbed flavor that lays skills/instructions where that agent
// discovers them. `validated` records whether the adapter has been run live:
// only Claude has — codex-agent-acp isn't published/installed, so the codex
// adapter is wired but unproven.
export type AgentId = "claude" | "codex";

// ── Opaque run registry ──────────────────────────────────────────────────────
// The streaming UI prepares a run (materialize) over POST, then streams it over a
// GET. We hand the client an opaque runId — NOT the raw runDir — so a crafted GET
// can't point the agent at an arbitrary path; the id maps server-side to the dir
// (always under AGENTGEM_HOME) and the agent chosen at prepare time.
const RUN_REGISTRY = new Map<string, { dir: string; agent: AgentId }>();

export function registerRun(dir: string, agent: AgentId): string {
  const id = randomUUID();
  RUN_REGISTRY.set(id, { dir, agent });
  return id;
}
export function resolveRun(id: string): { dir: string; agent: AgentId } | undefined {
  return RUN_REGISTRY.get(id);
}
export interface AgentAdapter { id: AgentId; descriptor: AgentDescriptor; flavor: TestbedFlavorId; validated: boolean }
export const AGENT_ADAPTERS: Record<AgentId, AgentAdapter> = {
  claude: { id: "claude", descriptor: CLAUDE_RUN_AGENT, flavor: "claude", validated: true },
  codex: { id: "codex", descriptor: { id: "codex", name: "Codex", command: ["codex-agent-acp"] }, flavor: "codex", validated: false },
};

// Partition a Gem's flat artifact list into the inventory shape importArtifacts wants.
// A Gem is self-contained (each artifact carries its content), so no disk read needed.
export function gemToInventory(gem: Gem): ConfigInventory {
  const inv: ConfigInventory = { skills: [], mcpServers: [], instructions: [], hooks: [] };
  for (const a of gem.artifacts) {
    if (a.type === "skill") inv.skills.push(a);
    else if (a.type === "mcp_server") inv.mcpServers.push(a);
    else if (a.type === "instructions") inv.instructions.push(a);
    else if (a.type === "hook") inv.hooks.push(a);
  }
  return inv;
}

/**
 * Scaffold a runnable testbed at `dir` and write every artifact the Gem carries
 * into the flavor's discoverable locations (`.claude/skills/...`, CLAUDE.md, etc.).
 */
export function materializeGemToTestbed(
  gem: Gem,
  dir: string,
  flavor: TestbedFlavorId = "claude",
): { written: ImportedRef[]; skipped: ImportSkip[] } {
  scaffoldTestbed(dir, gem.name, flavor);
  const inv = gemToInventory(gem);
  const selection = {
    skills: inv.skills.map((s) => s.name),
    mcpServers: inv.mcpServers.map((s) => s.name),
    hooks: inv.hooks.map((h) => h.name),
    includeInstructions: inv.instructions.length > 0,
  };
  return importArtifacts(dir, selection, inv, flavor);
}

export interface MaterializeAndRunOptions {
  gem: Gem;
  dir: string;
  task: string;
  // Which local agent to drive. Determines both the ACP adapter and the testbed
  // flavor; overridden by an explicit `flavor` if given. Defaults to "claude".
  agent?: AgentId;
  flavor?: TestbedFlavorId;
  // When provided, the run is verified against these and a report is attached.
  expectations?: GemExpectations;
  // Passed through to runGemWithAgent.
  mode?: string;
  connectFn?: RunConnectFn;
  timeoutMs?: number;
  onDelta?: (chunk: string) => void;
  onToolCall?: (tool: ToolInvocation) => void;
}

export interface MaterializeAndRunResult {
  agent: AgentId;
  materialized: { written: ImportedRef[]; skipped: ImportSkip[] };
  run: GemRunOutcome;
  verification?: VerificationReport;
}

/**
 * Gem → dir → run → (verify). The one call that turns a portable Gem into an
 * observed agent run. Verification is attached only when `expectations` are given.
 */
export async function materializeAndRunGem(opts: MaterializeAndRunOptions): Promise<MaterializeAndRunResult> {
  const agent = opts.agent ?? "claude";
  const adapter = AGENT_ADAPTERS[agent];
  const flavor = opts.flavor ?? adapter.flavor;
  const materialized = materializeGemToTestbed(opts.gem, opts.dir, flavor);
  const run = await runGemWithAgent({
    dir: opts.dir,
    task: opts.task,
    mode: opts.mode,
    descriptor: adapter.descriptor,
    connectFn: opts.connectFn,
    timeoutMs: opts.timeoutMs,
    onDelta: opts.onDelta,
    onToolCall: opts.onToolCall,
  });
  const verification = opts.expectations ? verifyGemRun(run, opts.expectations) : undefined;
  return { agent, materialized, run, verification };
}
