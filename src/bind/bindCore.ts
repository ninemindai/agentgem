// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
// src/bind/bindCore.ts
// Shared core for device-flow binding. Extracted so both the CLI and the console
// REST endpoints share identical logic without duplication.
import { writeFileSync, mkdirSync, readFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { loadOrCreateIdentity, type Identity } from "@agentgem/model";
import { bindSigningPayload } from "@agentgem/aggregator";
import { requestDeviceCode, pollForToken } from "./deviceFlow.js";

export interface BindConfig { clientId?: string; base?: string }

// The canonical hosted OAuth app + aggregator. The GitHub *device-flow* client ID is
// public (device flow has no client secret), so shipping it as a default lets
// "Connect GitHub" work with zero configuration against api.agentgem.ai. Self-hosters
// override either value via env.
const DEFAULT_GITHUB_CLIENT_ID = "Ov23liCbBVnhr7AH9FkF";
const DEFAULT_AGGREGATOR_URL = "https://api.agentgem.ai";

export function bindConfig(): BindConfig {
  return {
    clientId: process.env.AGENTGEM_GITHUB_CLIENT_ID ?? DEFAULT_GITHUB_CLIENT_ID,
    base: process.env.AGENTGEM_AGGREGATOR_URL ?? DEFAULT_AGGREGATOR_URL,
  };
}

const bindingPath = () => join(homedir(), ".agentgem", "binding.json");

export interface StartDeps { requestCode?: typeof requestDeviceCode }

export async function startDeviceBind(cfg: BindConfig, deps: StartDeps = {}) {
  if (!cfg.clientId) throw new Error("not configured");
  return (deps.requestCode ?? requestDeviceCode)(cfg.clientId);
}

export interface CompleteDeps {
  poll?: typeof pollForToken;
  identity?: Identity;
  fetchImpl?: typeof fetch;
  now?: number;
}

export async function completeDeviceBind(
  cfg: BindConfig,
  args: { deviceCode: string; interval?: number },
  deps: CompleteDeps = {},
): Promise<{ bound: true; provider: string; login: string; accountId: string } | { bound: false; rejected: string }> {
  if (!cfg.clientId || !cfg.base) return { bound: false, rejected: "not-configured" };
  const token = await (deps.poll ?? pollForToken)(cfg.clientId, args.deviceCode, { intervalSec: args.interval ?? 5 });
  const id = deps.identity ?? loadOrCreateIdentity();
  const signedAt = deps.now ?? Date.now();
  const signature = id.sign(bindSigningPayload(id.publicKey, token, signedAt));
  const res = await (deps.fetchImpl ?? fetch)(new URL("/api/aggregator/bind", cfg.base), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ pubkey: id.publicKey, token, signedAt, signature }),
  });
  const out = (await res.json()) as { bound: boolean; provider?: string; login?: string; accountId?: string; rejected?: string };
  if (!out.bound) return { bound: false, rejected: out.rejected ?? "unknown" };
  const dir = join(homedir(), ".agentgem");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  writeFileSync(
    bindingPath(),
    JSON.stringify({ provider: out.provider, login: out.login, accountId: out.accountId, boundAt: new Date().toISOString() }),
    { mode: 0o600 },
  );
  return { bound: true, provider: out.provider!, login: out.login!, accountId: out.accountId! };
}

export function readBindingStatus(): { bound: boolean; login?: string; provider?: string } {
  try {
    if (!existsSync(bindingPath())) return { bound: false };
    const j = JSON.parse(readFileSync(bindingPath(), "utf8")) as { login?: string; provider?: string };
    return j.login ? { bound: true, login: j.login, provider: j.provider } : { bound: false };
  } catch {
    return { bound: false };
  }
}
