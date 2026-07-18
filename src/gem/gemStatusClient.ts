// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
// Signs a gem-status pre-flight with the local producer key and asks the hosted aggregator whether
// a key already exists, whether we own it, and its latest version. Mirrors gemPublishClient.ts.
import type { Identity } from "@agentgem/model";
import { InvalidInputError } from "@agentgem/model";
import { createLogger } from "@agentgem/base";
import { gemStatusSigningPayload, type GemStatus } from "@agentgem/contract";
import type { ShareHttp } from "./catalogShareClient.js";

const log = createLogger("share");

const defaultHttp: ShareHttp = async (url, init) => {
  const res = await fetch(url, { ...init, signal: AbortSignal.timeout(30_000) });
  return { status: res.status, json: () => res.json() };
};

const DEFAULT_AGGREGATOR_URL = "https://api.agentgem.ai";
function resolveBase(endpoint: string | undefined): string {
  if (endpoint !== undefined) return endpoint;
  if (process.env.AGENTGEM_AGGREGATOR_URL) return process.env.AGENTGEM_AGGREGATOR_URL;
  return DEFAULT_AGGREGATOR_URL;
}

export async function postGemStatus(args: {
  gemKey: string; identity: Identity; endpoint?: string; http?: ShareHttp; now?: () => number;
}): Promise<GemStatus> {
  const base = resolveBase(args.endpoint);
  const http = args.http ?? defaultHttp;
  const now = (args.now ?? (() => Date.now()))();
  const signature = args.identity.sign(gemStatusSigningPayload(args.gemKey, args.identity.publicKey, now));
  const res = await http(`${base}/api/aggregator/gem-status`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ key: args.gemKey, pubkey: args.identity.publicKey, signedAt: now, signature }),
  });
  if (res.status < 200 || res.status >= 300) {
    log.warn("gem-status POST to %s failed: HTTP %d", base, res.status);
    throw new InvalidInputError(`could not reach the publish service (HTTP ${res.status}); try again in a moment`);
  }
  return (await res.json()) as GemStatus;
}
