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
import type { Gem, ConfigInventory } from "./types.js";
import { scaffoldTestbed, importArtifacts, type ImportedRef, type ImportSkip } from "./testbed.js";
import type { TestbedFlavorId } from "./testbedFlavors.js";
import { runGemWithAgent, type RunConnectFn, type GemRunOutcome, type ToolInvocation } from "./acpRun.js";
import { verifyGemRun, type GemExpectations, type VerificationReport } from "./gemVerify.js";

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
  materialized: { written: ImportedRef[]; skipped: ImportSkip[] };
  run: GemRunOutcome;
  verification?: VerificationReport;
}

/**
 * Gem → dir → run → (verify). The one call that turns a portable Gem into an
 * observed agent run. Verification is attached only when `expectations` are given.
 */
export async function materializeAndRunGem(opts: MaterializeAndRunOptions): Promise<MaterializeAndRunResult> {
  const flavor = opts.flavor ?? "claude";
  const materialized = materializeGemToTestbed(opts.gem, opts.dir, flavor);
  const run = await runGemWithAgent({
    dir: opts.dir,
    task: opts.task,
    mode: opts.mode,
    connectFn: opts.connectFn,
    timeoutMs: opts.timeoutMs,
    onDelta: opts.onDelta,
    onToolCall: opts.onToolCall,
  });
  const verification = opts.expectations ? verifyGemRun(run, opts.expectations) : undefined;
  return { materialized, run, verification };
}
