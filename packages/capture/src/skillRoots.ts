// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
// packages/capture/src/skillRoots.ts
//
// Single source of truth for the source → on-disk skills-root mapping, shared by the
// reader (introspect.ts) and the writer (disableArtifact.ts) so the two never drift.
// Only the four non-plugin, globally-installed skill sources live here; plugin skills
// (installPath/skills) and distilled drafts are resolved elsewhere.
import { homedir } from "node:os";
import { join } from "node:path";

export const SKILL_SOURCES = ["standalone", "agent", "codex", "hermes"] as const;
export type SkillSource = (typeof SKILL_SOURCES)[number];

export interface SkillRootOptions {
  claudeDir?: string;
  agentDir?: string;
  codexDir?: string;
  hermesDir?: string;
}

// Defaults match introspect.ts exactly: ~/.claude/skills, ~/.agents/skills,
// ~/.codex/skills, ~/.hermes/skills.
export function resolveSkillRoot(source: SkillSource, opts: SkillRootOptions = {}): string {
  const home = homedir();
  const claudeDir = opts.claudeDir ?? join(home, ".claude");
  const agentDir = opts.agentDir ?? join(home, ".agents", "skills");
  const codexDir = opts.codexDir ?? join(home, ".codex");
  const hermesDir = opts.hermesDir ?? join(home, ".hermes");
  switch (source) {
    case "standalone": return join(claudeDir, "skills");
    case "agent": return agentDir;
    case "codex": return join(codexDir, "skills");
    case "hermes": return join(hermesDir, "skills");
  }
}
