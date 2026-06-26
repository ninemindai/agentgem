// src/gem/draftStage.ts
//
// Stage a distilled DRAFT skill so a Gem candidate can include it before it is
// installed (proposal §7b). The seam is at inventory assembly, NOT buildGem:
// buildGem resolves names against the in-memory ConfigInventory and throws on a
// miss (buildGem.ts), so we materialize each draft into a SkillArtifact and merge
// it into the inventory upstream. buildGem itself is unchanged.
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ConfigInventory, SkillArtifact } from "./types.js";
import type { DistilledSkill } from "./distill.js";
import { agentgemHome } from "../resolveDir.js";

// Assemble the SKILL.md text: skillify-shaped frontmatter + the captured body.
// This is also exactly what the draft-write handler persists to disk (§9).
export function distilledSkillMarkdown(s: DistilledSkill): string {
  return [
    "---",
    `name: ${s.name}`,
    `description: ${s.description}`,
    "triggers:",
    ...s.triggers.map((t) => `  - ${t}`),
    `tools: [${s.tools.join(", ")}]`,
    `mutating: ${s.mutating}`,
    "---",
    "",
    s.body.trim(),
    "",
  ].join("\n");
}

export function distilledToArtifact(s: DistilledSkill): SkillArtifact {
  return { type: "skill", name: s.name, description: s.description, source: "distilled-draft", content: distilledSkillMarkdown(s) };
}

/**
 * Stage every draft into the project named by its own `evidence.root` (drafts may
 * span projects). Pure; no-op (same reference) when there are no drafts. Used by the
 * build path so a candidate can include an accepted draft the server hasn't installed.
 */
export function stageDraftsByEvidence(inv: ConfigInventory, drafts: DistilledSkill[]): ConfigInventory {
  if (!drafts.length) return inv;
  const byRoot = new Map<string, DistilledSkill[]>();
  for (const d of drafts) {
    const r = d.evidence.root;
    const list = byRoot.get(r) ?? [];
    list.push(d);
    byRoot.set(r, list);
  }
  let out = inv;
  for (const [root, list] of byRoot) out = stageDistilledDrafts(out, list, root);
  return out;
}

/**
 * Persist an accepted draft to `<base>/.agentgem/distilled/<name>/SKILL.md` for the
 * user to review and promote (proposal §7) — NOT into `.claude/skills/`. Returns the
 * written path. `name` is a validated kebab slug (validateDistilled), so path-safe.
 */
export function writeDistilledDraft(s: DistilledSkill, base: string = agentgemHome()): string {
  const dir = join(base, ".agentgem", "distilled", s.name);
  mkdirSync(dir, { recursive: true });
  const path = join(dir, "SKILL.md");
  writeFileSync(path, distilledSkillMarkdown(s), "utf8");
  return path;
}

/**
 * Return a copy of `inv` with each draft materialized into the project (matching
 * `root`) skills, or top-level skills if no project matches. Pure — never mutates
 * the input. A no-op (returns the same reference) when there are no drafts.
 */
export function stageDistilledDrafts(inv: ConfigInventory, drafts: DistilledSkill[], root: string): ConfigInventory {
  if (!drafts.length) return inv;
  const arts = drafts.map(distilledToArtifact);
  const matched = (inv.projects ?? []).some((p) => p.root === root);
  const projects = (inv.projects ?? []).map((p) =>
    p.root === root ? { ...p, skills: [...p.skills, ...arts] } : p);
  return matched
    ? { ...inv, projects }
    : { ...inv, skills: [...inv.skills, ...arts], projects: inv.projects ? projects : undefined };
}
