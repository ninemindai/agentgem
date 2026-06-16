// src/resolveDir.ts
import { homedir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";

export function resolveDir(dir?: string): string {
  return dir && dir.length > 0 ? dir : join(homedir(), ".claude");
}

// Clamp an arbitrary path to within the user's home dir. Returns the resolved absolute path
// when it is home or under home, else home itself. This is the security boundary for the
// folder browser and project discovery: the server never lists or reads outside home.
export function resolveUnderHome(p?: string): string {
  const home = homedir();
  if (!p || !p.length) return home;
  const abs = resolve(p);
  return abs === home || abs.startsWith(home + sep) ? abs : home;
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
