// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
// Shared "install a curated persona as a local skill" core, used by both the
// /api/sources/install route and the `agentgem sources install` CLI so the two
// can't drift. Writes ~/.agents/skills/<name>/SKILL.md (the dir introspect reads).
import { homedir } from "node:os";
import { join } from "node:path";
import { mkdir, writeFile } from "node:fs/promises";
import { curatedSourceById, cfgForCuratedSource, assertSourcePath, importSourceSkill } from "@agentgem/distribute";
import { InvalidInputError } from "@agentgem/model";

const SKILL_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

export interface InstallAgencyResult { ok: boolean; skill: string; dir: string; content: string }

// Dispatches by `source.kind` (agency-layout vs skills-layout) via @agentgem/distribute's
// sourceImport.ts — kept under the name `installAgencySkill` to avoid churn at call sites.
export async function installAgencySkill(
  sourceId: string,
  path: string,
  opts: { dryRun?: boolean; home?: string } = {},
): Promise<InstallAgencyResult> {
  const source = curatedSourceById(sourceId);
  if (!source) throw new InvalidInputError(`Unknown curated source '${sourceId}'.`);
  const skill = await importSourceSkill(source, assertSourcePath(source, path), cfgForCuratedSource(source));
  if (skill.name.includes("..") || !SKILL_NAME_RE.test(skill.name)) throw new InvalidInputError(`Unsafe skill name '${skill.name}'.`);
  const dir = join(opts.home ?? homedir(), ".agents", "skills", skill.name);
  if (!opts.dryRun) {
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "SKILL.md"), skill.content, "utf8");
  }
  return { ok: !opts.dryRun, skill: skill.name, dir, content: skill.content };
}
