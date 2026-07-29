// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
// Shared "install a curated persona as a local skill" core, used by both the
// /api/sources/install route and the `agentgem sources install` CLI so the two
// can't drift. Writes ~/.agents/skills/<name>/SKILL.md (the dir introspect reads).
import { homedir } from "node:os";
import { join, dirname, relative, isAbsolute } from "node:path";
import { mkdir, writeFile } from "node:fs/promises";
import { curatedSourceById, cfgForCuratedSource, assertSourcePath, importSourceSkill, safeBundlePath } from "@agentgem/distribute";
import { InvalidInputError } from "@agentgem/model";

const SKILL_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

export interface InstallAgencyResult {
  ok: boolean; skill: string; dir: string; content: string;
  files: number;            // sibling files written alongside SKILL.md
  filesTruncated?: boolean; // the bundle is known-incomplete (bound hit, or listing failed)
}

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
  const files = skill.files ?? [];
  // Re-check every bundle path here, before any write. The importer already filters, but these
  // paths originate in a remote git tree — this is the last gate before they become filesystem
  // writes, and it must reject BEFORE SKILL.md lands so a bad bundle leaves nothing behind.
  for (const f of files) {
    if (!safeBundlePath(f.path) || !isInside(dir, join(dir, f.path))) {
      throw new InvalidInputError(`Unsafe bundle path '${f.path}'.`);
    }
  }
  if (!opts.dryRun) {
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "SKILL.md"), skill.content, "utf8");
    for (const f of files) {
      const dest = join(dir, f.path);
      await mkdir(dirname(dest), { recursive: true });
      await writeFile(dest, f.content, "utf8");
    }
  }
  return {
    ok: !opts.dryRun, skill: skill.name, dir, content: skill.content,
    files: opts.dryRun ? 0 : files.length,
    ...(skill.filesTruncated ? { filesTruncated: true } : {}),
  };
}

// Containment check independent of the string form: the resolved destination must sit under the
// skill dir. Belt-and-braces with safeBundlePath — that one rejects "..", this one catches any
// path that still resolves outside (symlinked or platform-specific joins).
function isInside(parent: string, child: string): boolean {
  const rel = relative(parent, child);
  return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
}
