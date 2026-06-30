// src/gem/agentcoreRun.ts
// Deploy a workspace's rendered AgentCore project via the `agentcore` CLI. Peer of run.ts;
// reuses its ProcessRunner injection so command/state logic is unit-testable without a real CLI/AWS.
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { workspaceDir } from "@agentgem/base";
import { readGemArchive } from "@agentgem/archive";
import { readArchiveDir, writeArchiveDir } from "@agentgem/archive";
import { materialize } from "@agentgem/model";
import { pushLog, runToEnd, realRunner, type ProcessRunner, type RunPhase } from "@agentgem/run";

export interface AgentcoreDeployState { state: RunPhase; url?: string; logTail: string[] }

// Resolve the agentcore CLI: an explicit AGENTCORE_BIN, else the first `agentcore` on PATH.
export function resolveAgentcoreBin(): string | null {
  const explicit = process.env.AGENTCORE_BIN;
  if (explicit && existsSync(explicit)) return explicit;
  for (const dir of (process.env.PATH ?? "").split(":")) {
    if (!dir) continue;
    const p = join(dir, "agentcore");
    if (existsSync(p)) return p;
  }
  return null;
}

export function agentcoreReadiness(): { cli: boolean; awsCreds: boolean } {
  const hasId = !!(process.env.AWS_ACCESS_KEY_ID || process.env.AWS_PROFILE);
  const hasRegion = !!(process.env.AWS_REGION || process.env.AWS_DEFAULT_REGION);
  return { cli: !!resolveAgentcoreBin(), awsCreds: hasId && hasRegion };
}

// `agentcore deploy` prints the created harness ARN (and/or a console URL). Prefer the ARN.
export function parseAgentcoreEndpoint(lines: string[]): string | undefined {
  for (const l of lines) {
    const arn = l.match(/arn:aws:bedrock-agentcore:[^\s"']+harness[^\s"']*/);
    if (arn) return arn[0];
  }
  for (const l of lines) {
    const u = l.match(/https?:\/\/[^\s"']+/);
    if (u) return u[0];
  }
  return undefined;
}

// Re-render the workspace's gem to the agentcore target into a stable .run/agentcore dir.
export async function ensureAgentcoreProject(name: string, _runner: ProcessRunner, _log: string[]): Promise<string> {
  const dir = workspaceDir(name);
  if (!existsSync(join(dir, "gem.json"))) throw new Error(`no workspace '${name}'`);
  const gem = readGemArchive(readArchiveDir(dir));
  const { files } = materialize(gem, "agentcore");
  const runDir = join(dir, ".run", "agentcore");
  rmSync(runDir, { recursive: true, force: true }); // drop stale renders
  mkdirSync(runDir, { recursive: true });
  writeArchiveDir(runDir, files);
  return runDir;
}

const registry = new Map<string, AgentcoreDeployState>();

export async function deployAgentcore(name: string, runner: ProcessRunner = realRunner): Promise<AgentcoreDeployState> {
  const bin = resolveAgentcoreBin();
  if (!bin) throw new Error("agentcore CLI not found — install `@aws/agentcore@preview` or set AGENTCORE_BIN.");
  if (!agentcoreReadiness().awsCreds) throw new Error("AWS credentials/region not configured (set AWS_PROFILE or AWS_ACCESS_KEY_ID + AWS_REGION).");
  const state: AgentcoreDeployState = { state: "deploying", logTail: [] };
  registry.set(name, state);
  try {
    const runDir = await ensureAgentcoreProject(name, runner, state.logTail);
    const code = await runToEnd(runner, bin, ["deploy"], runDir, process.env, state.logTail);
    if (code !== 0) { state.state = "failed"; return state; }
    state.url = parseAgentcoreEndpoint(state.logTail);
    state.state = "idle";
    return state;
  } catch (err) {
    state.state = "failed";
    pushLog(state.logTail, err instanceof Error ? err.message : String(err));
    return state;
  }
}

export function getAgentcoreStatus(name: string): AgentcoreDeployState {
  return registry.get(name) ?? { state: "idle", logTail: [] };
}
