// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
// Assemble the child-process environment for a spawned stdio MCP connector gem (spec 2A).
//
// The rule is an ALLOWLIST, never a process.env spread: a connector gem is third-party-installable
// code, and handing it the whole environment would leak every local credential to any gem the viewer
// runs. The child sees exactly three sources, in precedence order:
//   1. { PATH, HOME } — so the binary resolves and tools that need a home dir work.
//   2. the gem's OWN raw config.env — the literal values the user configured in .mcp.json for THIS
//      server (read unredacted; the redacted inventory replaces these with "<redacted>").
//   3. each secretRefs-declared NAME, resolved from process.env when the gem config didn't carry a
//      concrete value — covers the common pattern of relying on an ambient env var rather than
//      inlining the secret. Only names the gem itself declared as secrets are eligible; an arbitrary
//      process.env var is never pulled.
//
// `missingSecrets` lists declared secretRefs names that end up with no real value in either source —
// the D14 fast-fail signal, so a connect surfaces "GITHUB_TOKEN not set" instead of a cryptic
// upstream auth error.

const REDACTION_SENTINEL = "<redacted>";

function realString(v: unknown): string | undefined {
  return typeof v === "string" && v.length > 0 && v !== REDACTION_SENTINEL ? v : undefined;
}

export function buildSpawnEnv(
  gem: { config: Record<string, unknown>; secretRefs?: { name: string }[] },
  processEnv: NodeJS.ProcessEnv = process.env,
): { env: Record<string, string>; missingSecrets: string[] } {
  const env: Record<string, string> = {};
  if (typeof processEnv.PATH === "string") env.PATH = processEnv.PATH;
  if (typeof processEnv.HOME === "string") env.HOME = processEnv.HOME;

  const configEnv = gem.config.env;
  if (configEnv && typeof configEnv === "object" && !Array.isArray(configEnv)) {
    for (const [k, v] of Object.entries(configEnv as Record<string, unknown>)) {
      const s = realString(v);
      if (s !== undefined) env[k] = s;
    }
  }

  const missingSecrets: string[] = [];
  for (const ref of gem.secretRefs ?? []) {
    if (realString(env[ref.name]) !== undefined) continue;      // already satisfied by config.env
    const fromProc = realString(processEnv[ref.name]);
    if (fromProc !== undefined) env[ref.name] = fromProc;       // allowlisted by name, pulled from ambient env
    else missingSecrets.push(ref.name);
  }
  return { env, missingSecrets };
}
