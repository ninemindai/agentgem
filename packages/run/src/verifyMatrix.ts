// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
//
// The cross-agent verification matrix: run one Gem, against its own contract,
// across the local ACP adapter roster — each agent in a fresh dir — and return a
// deterministic per-agent verdict list. Aggregation is judging, never synthesis:
// the verdict list IS the matrix. Failures are data (a per-agent problem becomes
// a verdict, not an exception); only a missing contract throws, before any run.
import { randomUUID } from "node:crypto";
import { join, resolve, sep } from "node:path";
import type { Gem, GemContract } from "@agentgem/model";
import { InvalidInputError, agentgemHome } from "@agentgem/model";
import { readGemMeta, writeGemArchive } from "@agentgem/archive";
import { AGENT_ADAPTERS, resolveOrFetchAdapter, materializeAndRunGem, type AgentId } from "./runGem.js";
import { hasTestConnectFn, type RunConnectFn, type ToolInvocation } from "./acpRun.js";
import { contractToExpectations, type VerificationReport } from "./gemVerify.js";
import { appendVerification } from "./evidenceLedger.js";

export interface AgentVerdict {
  agent: AgentId;
  status: "passed" | "failed" | "unavailable";
  verification?: VerificationReport;   // present for passed/failed
  detail?: string;                     // adapter-resolve error or run error
}

export interface VerifyMatrixOptions {
  gem: Gem;
  baseDir: string;                     // caller-derived (deriveMatrixBaseDir); agent id appended per run
  contract?: GemContract;              // default gem.contract; neither → InvalidInputError
  roster?: AgentId[];                  // default: every AGENT_ADAPTERS key
  fetch?: boolean;                     // default false: missing adapter → "unavailable"
  onVerdict?: (v: AgentVerdict) => void;
  connectFn?: RunConnectFn;            // test seam → skips availability, passed to materializeAndRunGem
  resolveAdapter?: typeof resolveOrFetchAdapter; // test seam for hermetic "unavailable"
  home?: string;                       // ledger home (test seam; default agentgemHome())
  gemDigest?: string;                  // precomputed (e.g. the archive's true digest); default: recomputed from the gem at archive-write defaults
  // Streaming seams for the SSE endpoint: fired per agent as it works. Optional and
  // additive — the blocking endpoint and CLI never set them.
  onAgentStart?: (agent: AgentId) => void;
  onDelta?: (agent: AgentId, chunk: string) => void;
  onToolCall?: (agent: AgentId, tool: ToolInvocation) => void;
}

// Shared hardened base-dir derivation for the matrix (endpoint + CLI use the same
// sanitizer). Mirrors gem.controller's deriveRunDir: one path segment, '..' can't
// escape the runs root.
export function deriveMatrixBaseDir(gemName: string, home?: string): string {
  let safeName = gemName.replace(/[^A-Za-z0-9._-]/g, "-");
  if (safeName === "" || safeName === "." || safeName === "..") safeName = "gem";
  const runsRoot = resolve(home ?? agentgemHome(), ".agentgem", "runs");
  const baseDir = resolve(runsRoot, `${safeName}-matrix`);
  if (!baseDir.startsWith(runsRoot + sep)) throw new Error("derived matrix dir escaped the runs root");
  return baseDir;
}

export async function verifyGemAcrossAgents(opts: VerifyMatrixOptions): Promise<AgentVerdict[]> {
  const contract = opts.contract ?? opts.gem.contract;
  if (!contract) throw new InvalidInputError("this Gem carries no contract — the matrix verifies a Gem's own claim");
  const roster = opts.roster ?? (Object.keys(AGENT_ADAPTERS) as AgentId[]);
  const resolveAdapter = opts.resolveAdapter ?? resolveOrFetchAdapter;
  const expectations = contractToExpectations(contract);
  const gemDigest = opts.gemDigest ?? readGemMeta(writeGemArchive(opts.gem).files).gemDigest;

  const verdicts: AgentVerdict[] = [];
  for (const agent of roster) {
    opts.onAgentStart?.(agent);
    const adapter = AGENT_ADAPTERS[agent];
    // Availability BEFORE materialize: an unavailable agent must leave no run dir
    // behind. Skipped when a connectFn seam is injected (fakes never spawn).
    if (!opts.connectFn && !hasTestConnectFn()) {
      try {
        await resolveAdapter(adapter, { allowFetch: opts.fetch ?? false });
      } catch (err) {
        const v: AgentVerdict = { agent, status: "unavailable", detail: (err as Error).message };
        verdicts.push(v);
        opts.onVerdict?.(v);
        continue;
      }
    }
    const out = await materializeAndRunGem({
      gem: opts.gem,
      dir: join(opts.baseDir, agent),  // AgentId is a safe literal ("claude" | "codex")
      task: contract.task,
      agent,
      expectations,
      connectFn: opts.connectFn,
      allowFetch: opts.fetch ?? false,
      onDelta: opts.onDelta ? (c) => opts.onDelta!(agent, c) : undefined,
      onToolCall: opts.onToolCall ? (t) => opts.onToolCall!(agent, t) : undefined,
    });
    const verification = out.verification as VerificationReport; // expectations always set → always present
    appendVerification({
      gemName: opts.gem.name,
      gemDigest,
      agent,
      adapterVersion: adapter.version,
      contractApplied: true,
      run: { ok: out.run.ok, toolCalls: out.run.ok ? out.run.result.toolCalls.length : 0 },
      verification,
    }, opts.home);
    const v: AgentVerdict = {
      agent,
      status: verification.passed ? "passed" : "failed",
      verification,
      ...(out.run.ok ? {} : { detail: out.run.error }),
    };
    verdicts.push(v);
    opts.onVerdict?.(v);
  }
  return verdicts;
}

// ── Opaque verify registry ───────────────────────────────────────────────────
// The streaming UI prepares a matrix run over POST, then streams it over GET.
// The client holds only the opaque verifyId — the gem body, baseDir, and roster
// stay server-side (same discipline as the run registry in runGem.ts).
export interface VerifySpec {
  gem: Gem;
  baseDir: string;
  roster?: AgentId[];
  fetch?: boolean;
  gemDigest: string;
  gemName: string;
}
const VERIFY_REGISTRY = new Map<string, VerifySpec>();
const VERIFY_REGISTRY_MAX = 1000;
export function registerVerify(spec: VerifySpec): string {
  const id = randomUUID();
  VERIFY_REGISTRY.set(id, spec);
  // Each spec holds a full Gem; a prepare that never opens the stream is never consumed, so cap the
  // registry and evict the oldest once over it (Map preserves insertion order).
  if (VERIFY_REGISTRY.size > VERIFY_REGISTRY_MAX) {
    const oldest = VERIFY_REGISTRY.keys().next().value;
    if (oldest !== undefined) VERIFY_REGISTRY.delete(oldest);
  }
  return id;
}
export function resolveVerify(id: string): VerifySpec | undefined {
  return VERIFY_REGISTRY.get(id);
}
// One-shot consume for the stream endpoint: a resolved spec is deleted so an
// EventSource auto-reconnect can never replay a full matrix run — the retry GET
// gets the clean unknown-id failure instead. resolveVerify stays as the
// read-only peek (tests, diagnostics).
export function consumeVerify(id: string): VerifySpec | undefined {
  const spec = VERIFY_REGISTRY.get(id);
  if (spec) VERIFY_REGISTRY.delete(id);
  return spec;
}
