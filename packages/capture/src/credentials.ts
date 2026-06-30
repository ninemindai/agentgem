// src/gem/credentials.ts
// Server-side credentials the deploy/publish backends gate on (Claude Managed → ANTHROPIC_API_KEY,
// eve → VERCEL_TOKEN, flue → CLOUDFLARE_API_TOKEN). These are agentgem-SERVER secrets — the machine's
// own auth — NOT Gem artifacts. They never enter a Gem; they are set in the running process and
// persisted (plaintext, 0600) to ~/.agentgem/.env so they survive a restart.
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { agentgemHome } from "@agentgem/model";
import { InvalidInputError } from "@agentgem/model";

// Only these keys may be set/persisted via the API — never arbitrary env vars.
export const CREDENTIAL_KEYS = ["ANTHROPIC_API_KEY", "VERCEL_TOKEN", "CLOUDFLARE_API_TOKEN"] as const;
export type CredentialKey = (typeof CREDENTIAL_KEYS)[number];

export function credentialsEnvPath(home: string = agentgemHome()): string {
  return join(home, ".agentgem", ".env");
}

// Upsert KEY=value in ~/.agentgem/.env (created 0600) and set it in the running process so the next
// deploy picks it up without a restart. Rejects empty/multi-line values (would corrupt the .env).
export function setCredential(key: CredentialKey, value: string, home: string = agentgemHome()): void {
  const v = value.trim();
  if (!v) throw new InvalidInputError("credential value is empty");
  if (/[\r\n]/.test(v)) throw new InvalidInputError("credential value must be a single line");
  process.env[key] = v;
  const abs = credentialsEnvPath(home);
  const kept = (existsSync(abs) ? readFileSync(abs, "utf8") : "")
    .split("\n")
    .filter((l) => l.trim().length > 0 && !l.startsWith(`${key}=`));
  kept.push(`${key}=${v}`);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, kept.join("\n") + "\n", "utf8");
  try { chmodSync(abs, 0o600); } catch { /* best-effort on platforms without POSIX modes */ }
}
