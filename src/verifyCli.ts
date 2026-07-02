// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
// src/verifyCli.ts — `agentgem verify <archive-dir>`: run the cross-agent
// verification matrix from the terminal, no server needed. Exit codes:
// 0 = ≥1 agent available and every available agent passed; 1 = any failure or
// nothing available; 2 = usage/contract error.
import { readArchiveDir, readGemArchive, readGemMeta } from "@agentgem/archive";
import { verifyGemAcrossAgents, deriveMatrixBaseDir, AGENT_ADAPTERS, type AgentId, type AgentVerdict } from "@agentgem/run";
import { InvalidInputError } from "@agentgem/model";

interface VerifyCliDeps {
  verify?: typeof verifyGemAcrossAgents;
  out?: (line: string) => void;
  err?: (line: string) => void;
}

function renderVerdict(v: AgentVerdict): string {
  if (v.status === "passed") return `✓ ${v.agent} passed · ${v.verification!.checks.length} check(s)`;
  if (v.status === "failed") {
    const firstFail = v.verification?.checks.find((c) => !c.passed);
    return `✗ ${v.agent} failed — ${firstFail ? `${firstFail.name}: ${firstFail.detail}` : v.detail ?? "run failed"}`;
  }
  return `– ${v.agent} unavailable — ${v.detail ?? "adapter not installed"}`;
}

export async function runVerifyCommand(args: string[], deps: VerifyCliDeps = {}): Promise<number> {
  const out = deps.out ?? ((l) => console.log(l));
  const err = deps.err ?? ((l) => console.error(l));
  const verify = deps.verify ?? verifyGemAcrossAgents;

  const positional = args.filter((a, i) => !a.startsWith("--") && args[i - 1] !== "--agents");
  const archiveDir = positional[0];
  if (!archiveDir) { err("usage: agentgem verify <archive-dir> [--agents claude,codex] [--fetch]"); return 2; }
  const agentsFlag = args.includes("--agents") ? args[args.indexOf("--agents") + 1] : undefined;
  const fetch = args.includes("--fetch");

  if (args.includes("--agents") && (agentsFlag === undefined || agentsFlag.startsWith("--"))) {
    err("--agents requires a comma-separated list (e.g. --agents claude,codex)");
    return 2;
  }

  let roster: AgentId[] | undefined;
  if (agentsFlag !== undefined) {
    const known = Object.keys(AGENT_ADAPTERS);
    const ids = agentsFlag.split(",").map((s) => s.trim()).filter(Boolean);
    const unknown = ids.filter((a) => !known.includes(a));
    if (!ids.length || unknown.length) { err(`unknown agent(s): ${unknown.join(", ") || "(none given)"}. Known: ${known.join(", ")}`); return 2; }
    roster = ids as AgentId[];
  }

  try {
    const files = readArchiveDir(archiveDir);
    const gem = readGemArchive(files);
    const gemDigest = readGemMeta(files).gemDigest;
    // Print via onVerdict as agents finish; an injected test `verify` won't call
    // onVerdict, so print any remainder from the returned list afterwards.
    let printed = 0;
    const verdicts = await verify({
      gem,
      gemDigest,
      baseDir: deriveMatrixBaseDir(gem.name),
      roster,
      fetch,
      onVerdict: (v) => { printed++; out(renderVerdict(v)); },
    });
    for (const v of verdicts.slice(printed)) out(renderVerdict(v));
    const available = verdicts.filter((v) => v.status !== "unavailable");
    const allPassed = available.length > 0 && available.every((v) => v.status === "passed");
    out(`${available.filter((v) => v.status === "passed").length}/${available.length} available agent(s) passed` +
        (verdicts.length !== available.length ? ` · ${verdicts.length - available.length} unavailable` : ""));
    return allPassed ? 0 : 1;
  } catch (e) {
    if (e instanceof InvalidInputError) { err(e.message); return 2; }
    err((e as Error).message);
    return 2;
  }
}
