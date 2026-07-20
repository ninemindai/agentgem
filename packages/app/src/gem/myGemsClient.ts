// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
// Signs a "prove key possession" pre-flight with the local producer key and asks the hosted
// aggregator which gems this producer owns. Mirrors gemStatusClient.ts (same base resolution,
// same sign call), but degrades to [] on any failure instead of throwing — this feeds a listing
// UI, not a blocking publish flow.
import type { Identity } from "@agentgem/model";
import { createLogger } from "@agentgem/base";
import { myGemsSigningPayload } from "@agentgem/contract";

const log = createLogger("share");

export type MyGemsHttp = (url: string, init: { method: string; headers: Record<string, string>; body: string }) => Promise<{ status: number; json(): Promise<unknown> }>;

const defaultHttp: MyGemsHttp = async (url, init) => {
  const res = await fetch(url, { ...init, signal: AbortSignal.timeout(30_000) });
  return { status: res.status, json: () => res.json() };
};

const DEFAULT_AGGREGATOR_URL = "https://api.agentgem.ai";
function resolveBase(endpoint: string | undefined): string {
  if (endpoint !== undefined) return endpoint;
  if (process.env.AGENTGEM_AGGREGATOR_URL) return process.env.AGENTGEM_AGGREGATOR_URL;
  return DEFAULT_AGGREGATOR_URL;
}

export interface OwnedGem { key: string; version: string; name: string }

export async function postMyGems(args: {
  identity: Identity; endpoint?: string; http?: MyGemsHttp; now?: () => number;
}): Promise<OwnedGem[]> {
  const base = resolveBase(args.endpoint);
  const http = args.http ?? defaultHttp;
  const now = (args.now ?? (() => Date.now()))();
  const signature = args.identity.sign(myGemsSigningPayload(args.identity.publicKey, now));
  try {
    const res = await http(`${base}/api/aggregator/my-gems`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ pubkey: args.identity.publicKey, signedAt: now, signature }),
    });
    if (res.status < 200 || res.status >= 300) {
      log.warn("my-gems POST to %s failed: HTTP %d", base, res.status);
      return [];
    }
    const body = (await res.json()) as { gems?: OwnedGem[] };
    return Array.isArray(body.gems) ? body.gems : [];
  } catch (err) {
    log.warn("my-gems POST to %s threw: %s", base, err instanceof Error ? err.message : String(err));
    return [];
  }
}
