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
import { createRequire } from "node:module";
import { spawn } from "node:child_process";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { agentgemHome } from "@agentgem/model";
import { binOnPath } from "@agentgem/model";
import type { Gem, ConfigInventory } from "@agentgem/model";
import { scaffoldTestbed, importArtifacts, type ImportedRef, type ImportSkip } from "@agentgem/testbed";
import type { TestbedFlavorId } from "@agentgem/testbed";
import { runGemWithAgent, hasTestConnectFn, type RunConnectFn, type GemRunOutcome, type ToolInvocation } from "./acpRun.js";
import { verifyGemRun, type GemExpectations, type VerificationReport } from "./gemVerify.js";

// Which local coding agent to drive. Each maps an ACP ADAPTER package to the
// testbed flavor that lays skills/instructions where that agent discovers them.
// The adapter is distinct from (and required regardless of) the agent's own CLI:
// codex-acp/claude-agent-acp bundle their engine (@openai/codex /
// @anthropic-ai/claude-agent-sdk) and speak ACP; the codex/claude CLI only
// provides the auth they reuse. Both adapters are validated live.
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
// An adapter "recipe": the npm package + bin + pinned version to fetch on demand,
// plus the testbed flavor. The spawnable command is resolved lazily at run time
// (resolveOrFetchAdapter) so nothing heavy installs until an agent is actually used.
export interface AgentAdapter {
  id: AgentId; name: string;
  pkg: string; bin: string; version: string;
  flavor: TestbedFlavorId; validated: boolean;
}

export const AGENT_ADAPTERS: Record<AgentId, AgentAdapter> = {
  claude: { id: "claude", name: "Claude Code", pkg: "@agentclientprotocol/claude-agent-acp", bin: "claude-agent-acp", version: "0.51.0", flavor: "claude", validated: true },
  codex: { id: "codex", name: "Codex", pkg: "@agentclientprotocol/codex-acp", bin: "codex-acp", version: "1.0.0", flavor: "codex", validated: true },
};

const require = createRequire(import.meta.url);

// Resolve a package's bin to `[node, <bin path>]` from a given module root (default:
// agentgem's own deps). Returns null if the package isn't installed there.
function resolveBinFrom(pkg: string, binName: string, fromDir?: string): string[] | null {
  try {
    const req = fromDir ? createRequire(join(fromDir, "noop.cjs")) : require;
    const pkgJsonPath = req.resolve(`${pkg}/package.json`);
    const pkgJson = req(pkgJsonPath) as { bin?: string | Record<string, string> };
    const binRel = typeof pkgJson.bin === "string" ? pkgJson.bin : pkgJson.bin?.[binName];
    if (binRel) return [process.execPath, join(dirname(pkgJsonPath), binRel)];
  } catch { /* not resolvable here */ }
  return null;
}

// Where on-demand-fetched adapters are cached (under AGENTGEM_HOME, never global).
export function adapterCacheDir(): string { return join(agentgemHome(), "adapters"); }

// Back-compat sync resolver (local dep → [node,path], else bare PATH name). The
// async resolveOrFetchAdapter below is the full chain used at run time.
export function resolveAdapterCommand(pkg: string, binName: string): string[] {
  return resolveBinFrom(pkg, binName) ?? [binName];
}

// Install <pkg>@<version> into a prefix dir via npm. Injected in tests.
export type AdapterInstaller = (pkg: string, version: string, prefixDir: string) => Promise<void>;
const npmInstaller: AdapterInstaller = (pkg, version, prefixDir) => new Promise((resolve, reject) => {
  mkdirSync(prefixDir, { recursive: true });
  const child = spawn("npm", ["install", `${pkg}@${version}`, "--prefix", prefixDir, "--no-audit", "--no-fund", "--loglevel", "error"], { stdio: "inherit" });
  child.once("error", reject);
  child.once("exit", (code) => (code === 0 ? resolve() : reject(new Error(`npm install ${pkg}@${version} exited with code ${code}`))));
});

// Dedupe concurrent fetches of the same package (two runs racing the install).
const inflightFetch = new Map<string, Promise<string[]>>();

export interface ResolveAdapterOptions {
  installer?: AdapterInstaller;   // test seam / custom installer
  onFetch?: () => void;           // fired once when an on-demand fetch starts (UI "preparing" phase)
  allowFetch?: boolean;           // default true; false = offline/air-gapped → throw instead of fetching
}

// Locate an adapter's spawnable command via a fallback chain, fetching on demand
// only as a last resort. Order (reuse what exists, fetch last):
//   1. global install on PATH        (the user explicitly installed the adapter)
//   2. agentgem's own dep            (bundled/optional dependency)
//   3. agentgem cache                (a prior on-demand fetch, under AGENTGEM_HOME)
//   4. on-demand fetch into the cache (pinned version), then resolve
export async function resolveOrFetchAdapter(adapter: AgentAdapter, opts: ResolveAdapterOptions = {}): Promise<string[]> {
  if (binOnPath(adapter.bin)) return [adapter.bin];
  const dep = resolveBinFrom(adapter.pkg, adapter.bin);
  if (dep) return dep;
  const cache = adapterCacheDir();
  const cached = resolveBinFrom(adapter.pkg, adapter.bin, cache);
  if (cached) return cached;
  if (opts.allowFetch === false) {
    throw new Error(`${adapter.name} adapter (${adapter.pkg}) is not installed and on-demand fetch is disabled`);
  }
  let fetching = inflightFetch.get(adapter.pkg);
  if (!fetching) {
    const installer = opts.installer ?? npmInstaller;
    fetching = (async () => {
      opts.onFetch?.();
      await installer(adapter.pkg, adapter.version, cache);
      const resolved = resolveBinFrom(adapter.pkg, adapter.bin, cache);
      if (!resolved) throw new Error(`fetched ${adapter.pkg} but its '${adapter.bin}' bin was not found`);
      return resolved;
    })();
    inflightFetch.set(adapter.pkg, fetching);
    void fetching.catch(() => {}).finally(() => inflightFetch.delete(adapter.pkg));
  }
  return fetching;
}

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
  // Adapter resolution (see resolveOrFetchAdapter): installer seam, a hook fired
  // when an on-demand fetch starts, and an offline switch.
  installer?: AdapterInstaller;
  onFetch?: () => void;
  allowFetch?: boolean;
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
  // Resolve (and if needed fetch) the adapter command, unless a connectFn is
  // injected — fakes never spawn, so don't trigger resolution/fetch in tests.
  const command = opts.connectFn || hasTestConnectFn()
    ? [adapter.bin]
    : await resolveOrFetchAdapter(adapter, { installer: opts.installer, onFetch: opts.onFetch, allowFetch: opts.allowFetch });
  const run = await runGemWithAgent({
    dir: opts.dir,
    task: opts.task,
    mode: opts.mode,
    descriptor: { id: adapter.id, name: adapter.name, command },
    connectFn: opts.connectFn,
    timeoutMs: opts.timeoutMs,
    onDelta: opts.onDelta,
    onToolCall: opts.onToolCall,
  });
  const verification = opts.expectations ? verifyGemRun(run, opts.expectations) : undefined;
  return { agent, materialized, run, verification };
}
