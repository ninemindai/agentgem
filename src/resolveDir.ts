// src/resolveDir.ts
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export function resolveDir(dir?: string): string {
  return dir && dir.length > 0 ? dir : join(homedir(), ".claude");
}

// Derive every discovery root from one base. In production `dir` is undefined, so the
// claude dir is ~/.claude and its parent is the home dir — giving ~/.agents/skills and
// ~/.codex. When `dir` is overridden (tests, non-default homes) the agent/codex roots
// resolve relative to that same parent, keeping introspection self-contained.
export function resolveDirs(dir?: string): { claudeDir: string; agentDir: string; codexDir: string } {
  const claudeDir = resolveDir(dir);
  const home = dirname(claudeDir);
  return { claudeDir, agentDir: join(home, ".agents", "skills"), codexDir: join(home, ".codex") };
}
