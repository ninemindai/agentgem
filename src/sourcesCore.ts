// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
// Shared "install a curated persona as a local skill" core, used by both the
// /api/sources/install route and the `agentgem sources install` CLI so the two
// can't drift. Writes ~/.agents/skills/<name>/SKILL.md (the dir introspect reads).
import { homedir } from "node:os";
import { join } from "node:path";
import { mkdir, writeFile } from "node:fs/promises";
import { curatedSourceById, cfgForCuratedSource, importAgencyAgentSkill } from "@agentgem/distribute";
import { InvalidInputError } from "@agentgem/model";

const SKILL_NAME_RE = /^[a-z0-9][a-z0-9-]*$/;
const AGENCY_PATH_RE = /^[a-z0-9-]+\/[A-Za-z0-9._-]+\.md$/;

export interface InstallAgencyResult { ok: boolean; skill: string; dir: string; content: string }

export async function installAgencySkill(
  sourceId: string,
  path: string,
  opts: { dryRun?: boolean; home?: string } = {},
): Promise<InstallAgencyResult> {
  const source = curatedSourceById(sourceId);
  if (!source) throw new InvalidInputError(`Unknown curated source '${sourceId}'.`);
  if (path.includes("..") || !AGENCY_PATH_RE.test(path)) throw new InvalidInputError(`Invalid agent path '${path}'.`);
  const skill = await importAgencyAgentSkill(path, cfgForCuratedSource(source));
  if (!SKILL_NAME_RE.test(skill.name)) throw new InvalidInputError(`Unsafe skill name '${skill.name}'.`);
  const dir = join(opts.home ?? homedir(), ".agents", "skills", skill.name);
  if (!opts.dryRun) {
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "SKILL.md"), skill.content, "utf8");
  }
  return { ok: !opts.dryRun, skill: skill.name, dir, content: skill.content };
}
