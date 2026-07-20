// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
// `agentgem sources install <sourceId> <path>` — install a curated persona as a
// local skill (the command the marketplace /sources page tells visitors to copy).
import { installAgencySkill } from "@agentgem/app/sourcesCore";

const USAGE = "usage: agentgem sources install <sourceId> <path>\n  e.g. agentgem sources install agency-agents engineering/ai-engineer.md\n  flags: --dry-run  (print the SKILL.md without writing)";

export async function runSourcesCommand(argv: string[]): Promise<number> {
  const positional = argv.filter((a) => !a.startsWith("--"));
  const [sub, sourceId, path] = positional;
  if (sub !== "install" || !sourceId || !path) {
    console.error(USAGE);
    return 1;
  }
  // Fail closed: match "--dry-run" and "--dry-run=<value>", not just an exact "--dry-run" element —
  // a missed dry-run flag means we silently WRITE when a preview was intended.
  const dryRun = argv.some((a) => a === "--dry-run" || a.startsWith("--dry-run="));
  try {
    const r = await installAgencySkill(sourceId, path, { dryRun });
    if (dryRun) {
      console.log(r.content);
      console.error(`(dry-run) would install '${r.skill}' -> ${r.dir}/SKILL.md`);
    } else {
      console.log(`installed '${r.skill}' -> ${r.dir}/SKILL.md`);
    }
    return 0;
  } catch (e) {
    console.error(`error: ${(e as Error).message}`);
    return 1;
  }
}
