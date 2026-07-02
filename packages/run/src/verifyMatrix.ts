// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
//
// The cross-agent verification matrix: run one Gem, against its own contract,
// across the local ACP adapter roster — each agent in a fresh dir — and return a
// deterministic per-agent verdict list. Aggregation is judging, never synthesis:
// the verdict list IS the matrix. Failures are data (a per-agent problem becomes
// a verdict, not an exception); only a missing contract throws, before any run.
import { join, resolve, sep } from "node:path";
import type { Gem, GemContract } from "@agentgem/model";
import { InvalidInputError, agentgemHome } from "@agentgem/model";
import { readGemMeta, writeGemArchive } from "@agentgem/archive";
import { AGENT_ADAPTERS, resolveOrFetchAdapter, materializeAndRunGem, type AgentId } from "./runGem.js";
import { hasTestConnectFn, type RunConnectFn } from "./acpRun.js";
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
