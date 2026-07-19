// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
// src/gemitCli.ts
//
// `agentgem gemit [--dir <claude-home>] [--out <file>] [--theme rpg] [--no-open]`
// Score the operator's last 30 days of local coding-agent sessions and write a
// self-contained HTML steering report. Fully local and deterministic: existing
// detectors over local transcripts, no LLM, no server, nothing published.
// Exit codes: 0 success (including the insufficient-data doorway), 2 usage.
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { agentgemHome } from "@agentgem/model";
import { collectGemitInputs } from "./gemit/collect.js";
import { computeGemitData, type GemitData } from "./gemit/score.js";
import { renderRpgTheme, TIER_NAMES } from "./gemit/themeRpg.js";
import { openInBrowser } from "./gemit/openBrowser.js";

export const GEMIT_HELP = `agentgem gemit — score your agent steering into a local report

Usage:
  agentgem gemit [options]

Options:
  --dir <path>     Claude home to scan (default: ~/.claude)
  --out <file>     Report path (default: <agentgem-home>/reports/gemit-<date>.html)
  --theme <name>   Report theme (rpg)
  --no-open        Don't open the report in the browser
  -h, --help       Show this help

Scores the last 30 days (context discipline · process quality · setup maturity)
with the same deterministic detectors the console uses. Local only — nothing
leaves this machine.`;

export interface GemitArgs {
  dir?: string;
  out?: string;
  theme: string;
  open: boolean;
  help: boolean;
}

const THEMES = ["rpg"];

export function parseGemitArgs(argv: string[]): GemitArgs | { error: string } {
  const args: GemitArgs = { theme: "rpg", open: true, help: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "-h" || a === "--help") args.help = true;
    else if (a === "--no-open") args.open = false;
    else if (a === "--dir" || a === "--out" || a === "--theme") {
      const v = argv[i + 1];
      if (!v || v.startsWith("--")) return { error: `${a} requires a value` };
      if (a === "--dir") args.dir = v;
      else if (a === "--out") args.out = v;
      else args.theme = v;
      i++;
    } else return { error: `unknown option '${a}'` };
  }
  if (!THEMES.includes(args.theme)) {
    return { error: `unknown theme '${args.theme}' (available: ${THEMES.join(", ")})` };
  }
  return args;
}

export interface GemitCliDeps {
  collect?: typeof collectGemitInputs;
  compute?: typeof computeGemitData;
  render?: (data: GemitData) => string;
  writeFile?: (path: string, content: string) => void;
  open?: (path: string) => void;
  out?: (line: string) => void;
  err?: (line: string) => void;
  isTTY?: boolean;
  nowMs?: number;
}

export async function runGemitCommand(argv: string[], deps: GemitCliDeps = {}): Promise<number> {
  const out = deps.out ?? ((l: string) => console.log(l));
  const err = deps.err ?? ((l: string) => console.error(l));
  const parsed = parseGemitArgs(argv);
  if ("error" in parsed) {
    err(`gemit: ${parsed.error}`);
    err(GEMIT_HELP);
    return 2;
  }
  if (parsed.help) {
    out(GEMIT_HELP);
    return 0;
  }

  const nowMs = deps.nowMs ?? Date.now();
  const collect = deps.collect ?? collectGemitInputs;
  const compute = deps.compute ?? computeGemitData;
  const render = deps.render ?? renderRpgTheme;
  const write = deps.writeFile ?? ((p: string, c: string) => {
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, c);
  });

  out("Scanning sessions (last 30 days)…");
  const { qualifying, scored } = await collect(parsed.dir, nowMs);
  const data = compute(qualifying, scored, nowMs);

  // agentgemHome() is the home ROOT (AGENTGEM_HOME override or ~); state lives under .agentgem.
  const outPath = resolve(parsed.out ?? join(agentgemHome(), ".agentgem", "reports", `gemit-${data.windowTo}.html`));
  write(outPath, render(data));

  if (data.insufficient) {
    out(`Not enough steering yet: ${data.qualifyingSessions} substantial session(s) in the last 30 days (need 5).`);
  } else {
    out(`Tier: ${TIER_NAMES[data.tierLevel - 1]} — ${data.composite}/100`);
    out(`  Context discipline ${data.ctx} · Process quality ${data.proc} · Setup maturity ${data.setup}`);
    out(`  Scored ${data.scoredSessions} of ${data.qualifyingSessions} sessions across ${data.projects} projects.`);
  }
  out(`Report: ${outPath}`);

  const isTTY = deps.isTTY ?? Boolean(process.stdout.isTTY);
  if (parsed.open && isTTY) (deps.open ?? openInBrowser)(outPath);
  return 0;
}
