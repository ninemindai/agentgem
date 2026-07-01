// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
// src/bind/cli.ts — `agentgem bind`: device-flow auth, then bind the local key to a GitHub account.
import { bindConfig, startDeviceBind, completeDeviceBind } from "./bindCore.js";

export async function main(_argv: string[]): Promise<void> {
  const cfg = bindConfig();
  if (!cfg.clientId) { console.error("agentgem bind: set AGENTGEM_GITHUB_CLIENT_ID (GitHub OAuth app client id)"); process.exitCode = 1; return; }
  if (!cfg.base) { console.error("agentgem bind: set AGENTGEM_AGGREGATOR_URL (hosted aggregator base URL)"); process.exitCode = 1; return; }

  const dc = await startDeviceBind(cfg);
  console.log(`\nTo bind this machine's key to your GitHub account:\n  1. open ${dc.verificationUri}\n  2. enter code: ${dc.userCode}\n`);
  const out = await completeDeviceBind(cfg, { deviceCode: dc.deviceCode, interval: dc.interval });
  if (!out.bound) { console.error(`agentgem bind: rejected (${out.rejected})`); process.exitCode = 1; return; }
  console.log(`✓ bound to ${out.provider}:@${out.login}`);
}
