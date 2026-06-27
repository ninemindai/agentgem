// src/gem/configAccess.ts
//
// The sandboxed Gem runner keeps the agent on its REAL ~/.claude so Keychain/OAuth auth
// works (a relocated CLAUDE_CONFIG_DIR makes Claude Code fall into an interactive re-login
// and hang — verified against the live binary). Security therefore comes from the jail:
// it allows writes to the config dir EXCEPT the escalation vectors below, so a malicious
// Gem run can boot the agent but cannot plant a startup hook, drop a skill/plugin, or
// overwrite stored credentials — and the base jail still denies the user's source tree.
import { homedir } from "node:os";
import { join } from "node:path";
import { resolveDir } from "../resolveDir.js";

// Where Claude Code keeps its top-level identity file: $CLAUDE_CONFIG_DIR/.claude.json when
// set, else ~/.claude.json (in HOME — a sibling of ~/.claude, NOT inside it). The agent
// writes this at runtime, so it must stay writable.
export function claudeJsonPath(env: NodeJS.ProcessEnv = process.env, home: string = homedir()): string {
  return env.CLAUDE_CONFIG_DIR ? join(env.CLAUDE_CONFIG_DIR, ".claude.json") : join(home, ".claude.json");
}

// Files/dirs in the config dir a sandboxed run must NOT be able to write:
//   settings.json / settings.local.json — `hooks` run arbitrary host commands
//   .credentials.json                   — stored auth token
//   skills/ , plugins/                  — code/instructions auto-loaded by future sessions
export function sensitiveConfigPaths(configDir: string = resolveDir()): string[] {
  return [
    join(configDir, "settings.json"),
    join(configDir, "settings.local.json"),
    join(configDir, ".credentials.json"),
    join(configDir, "skills"),
    join(configDir, "plugins"),
  ];
}

// The writable + denied path sets the sandbox launcher needs to jail the agent's config:
// the config dir and its .claude.json are writable; the sensitive paths are carved back out.
export function configWriteAccess(
  configDir: string = resolveDir(),
  env: NodeJS.ProcessEnv = process.env,
  home: string = homedir(),
): { writable: string[]; denied: string[] } {
  return {
    writable: [configDir, claudeJsonPath(env, home)],
    denied: sensitiveConfigPaths(configDir),
  };
}
