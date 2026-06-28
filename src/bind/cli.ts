// src/bind/cli.ts — `agentgem bind`: device-flow auth, then bind the local key to a GitHub account.
import { writeFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { loadOrCreateIdentity } from "../gem/identity.js";
import { bindSigningPayload } from "../aggregator/binding.js";
import { requestDeviceCode, pollForToken } from "./deviceFlow.js";

export async function main(_argv: string[]): Promise<void> {
  const clientId = process.env.AGENTGEM_GITHUB_CLIENT_ID;
  const base = process.env.AGENTGEM_AGGREGATOR_URL;
  if (!clientId) { console.error("agentgem bind: set AGENTGEM_GITHUB_CLIENT_ID (GitHub OAuth app client id)"); process.exitCode = 1; return; }
  if (!base) { console.error("agentgem bind: set AGENTGEM_AGGREGATOR_URL (hosted aggregator base URL)"); process.exitCode = 1; return; }

  const id = loadOrCreateIdentity();
  const dc = await requestDeviceCode(clientId);
  console.log(`\nTo bind this machine's key to your GitHub account:\n  1. open ${dc.verificationUri}\n  2. enter code: ${dc.userCode}\n`);
  const token = await pollForToken(clientId, dc.deviceCode, { intervalSec: dc.interval });

  const signedAt = Date.now();
  const signature = id.sign(bindSigningPayload(id.publicKey, token, signedAt));
  // CLI client: Node fetch sends no Origin/Sec-Fetch-Site, so originGuard treats it as a non-browser caller.
  const res = await fetch(new URL("/api/aggregator/bind", base), {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ pubkey: id.publicKey, token, signedAt, signature }),
  });
  const out = (await res.json()) as { bound: boolean; provider?: string; login?: string; accountId?: string; rejected?: string };
  if (!out.bound) { console.error(`agentgem bind: rejected (${out.rejected ?? "unknown"})`); process.exitCode = 1; return; }

  const dir = join(homedir(), ".agentgem");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  writeFileSync(join(dir, "binding.json"), JSON.stringify({ provider: out.provider, login: out.login, accountId: out.accountId, boundAt: new Date().toISOString() }), { mode: 0o600 });
  console.log(`✓ bound to ${out.provider}:@${out.login}`);
}
