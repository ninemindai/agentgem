// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
// Console-driven GitHub device flow that binds the local producer key to a verified GitHub
// account on the HOSTED aggregator. Same trust construction as `agentgem bind`, but injectable.
import { bindSigningPayload } from "@agentgem/aggregator";
import type { Identity } from "@agentgem/model";
import type { Binding } from "./bindingFile.js";

export interface DeviceCode { deviceCode: string; userCode: string; verificationUri: string; interval: number }
type Http = (url: string, init: { method: string; headers: Record<string, string>; body: string }) => Promise<{ status: number; json(): Promise<unknown> }>;

export async function startConnect(deps: { clientId: string; requestDeviceCode: (id: string) => Promise<DeviceCode> }): Promise<DeviceCode> {
  return deps.requestDeviceCode(deps.clientId);
}

export interface FinishDeps {
  clientId: string; deviceCode: string; interval: number; base: string;
  identity: Identity;
  pollForToken: (id: string, code: string, o: { intervalSec: number }) => Promise<string>;
  http: Http; now: () => number; write: (b: Binding) => void;
}

export async function finishConnect(deps: FinishDeps): Promise<{ connected: true; login: string } | { connected: false; rejected: string }> {
  const token = await deps.pollForToken(deps.clientId, deps.deviceCode, { intervalSec: deps.interval });
  const signedAt = deps.now();
  const signature = deps.identity.sign(bindSigningPayload(deps.identity.publicKey, token, signedAt));
  const res = await deps.http(`${deps.base}/api/aggregator/bind`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ pubkey: deps.identity.publicKey, token, signedAt, signature }),
  });
  const b = (await res.json()) as { bound?: boolean; provider?: string; login?: string; accountId?: string; rejected?: string };
  if (!b.bound || !b.login || !b.provider || !b.accountId) return { connected: false, rejected: b.rejected ?? "unknown" };
  deps.write({ provider: b.provider, login: b.login, accountId: b.accountId, boundAt: new Date(signedAt).toISOString() });
  return { connected: true, login: b.login };
}
