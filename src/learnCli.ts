// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
// src/learnCli.ts — `agentgem learn [root] [--session <id>] [--dir <claude-home>]`:
// distill one session into the dream review queue from the terminal, no server needed.
// Exit codes: 0 success (including "nothing distilled"); 2 usage/containment errors.
import { InvalidInputError } from "@agentgem/model";
import { learnFromSession } from "@agentgem/app/learnCore";

interface LearnCliDeps {
  learn?: typeof learnFromSession;
  out?: (line: string) => void;
  err?: (line: string) => void;
}

export async function runLearnCommand(args: string[], deps: LearnCliDeps = {}): Promise<number> {
  const out = deps.out ?? ((l) => console.log(l));
  const err = deps.err ?? ((l) => console.error(l));
  const learn = deps.learn ?? learnFromSession;

  const flagValue = (name: string): string | undefined =>
    args.includes(name) ? args[args.indexOf(name) + 1] : undefined;
  for (const name of ["--session", "--dir"]) {
    const v = flagValue(name);
    if (args.includes(name) && (v === undefined || v.startsWith("--"))) {
      err(`${name} requires a value`);
      return 2;
    }
  }
  const positional = args.filter((a, i) => !a.startsWith("--") && args[i - 1] !== "--session" && args[i - 1] !== "--dir");
  const root = positional[0] ?? process.cwd();

  try {
    const r = await learn({ root, session: flagValue("--session"), dir: flagValue("--dir") });
    if (r.enqueued === 0 && r.skills === 0 && r.lessons === 0 && r.guardrails === 0) {
      out(`nothing distilled from ${r.session}${r.degraded ? " (heuristic-only: LLM path unavailable)" : ""}`);
      return 0;
    }
    for (const e of r.entries) out(`+ ${e.kind} "${e.name}" queued`);
    out(`${r.session}: ${r.skills} skill candidate(s), ${r.lessons} lesson(s), ${r.guardrails} guardrail(s) — ${r.enqueued} queued for review` +
        (r.enqueued > 0 && r.enqueued < r.skills + r.lessons + r.guardrails ? " (rest already queued or reviewed)" : ""));
    out(`review in the Dreaming panel or GET /api/dream/queue`);
    return 0;
  } catch (e) {
    if (e instanceof InvalidInputError) { err(e.message); return 2; }
    err((e as Error).message);
    return 2;
  }
}
