// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
// Signs a gem manifest with the local producer key and forwards it to the hosted aggregator's
// catalog endpoint. Mirrors shareClient.ts (same base resolution, same http seam).
import type { Identity } from "@agentgem/model";
import { InvalidInputError } from "@agentgem/model";
import { catalogSigningPayload, type CatalogManifest } from "@agentgem/aggregator";

export type ShareHttp = (url: string, init: { method: string; headers: Record<string, string>; body: string }) => Promise<{ status: number; json(): Promise<unknown> }>;

const defaultHttp: ShareHttp = async (url, init) => {
  const res = await fetch(url, { ...init, signal: AbortSignal.timeout(10_000) });
  return { status: res.status, json: () => res.json() };
};

const DEFAULT_AGGREGATOR_URL = "https://api.agentgem.ai";

// Resolve the backend base: explicit endpoint -> AGENTGEM_AGGREGATOR_URL -> the hosted default.
function resolveBase(endpoint: string | undefined): string {
  if (endpoint !== undefined) return endpoint;
  if (process.env.AGENTGEM_AGGREGATOR_URL) return process.env.AGENTGEM_AGGREGATOR_URL;
  return DEFAULT_AGGREGATOR_URL;
}

export async function postCatalogShare(args: {
  manifest: CatalogManifest; identity: Identity; endpoint?: string; http?: ShareHttp; now?: () => number;
}): Promise<{ shared: true; publishedBy: string } | { shared: false; rejected: string }> {
  const base = resolveBase(args.endpoint);
  const http = args.http ?? defaultHttp;
  const now = (args.now ?? (() => Date.now()))();
  const signature = args.identity.sign(catalogSigningPayload(args.manifest, args.identity.publicKey, now));
  const res = await http(`${base}/api/aggregator/catalog`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ manifest: args.manifest, pubkey: args.identity.publicKey, signedAt: now, signature }),
  });
  if (res.status < 200 || res.status >= 300) throw new InvalidInputError(`could not reach the share service (HTTP ${res.status}); try again in a moment`);
  const b = (await res.json()) as { shared?: boolean; publishedBy?: string; rejected?: string };
  return b.shared && b.publishedBy ? { shared: true, publishedBy: b.publishedBy } : { shared: false, rejected: b.rejected ?? "unknown" };
}

/** Map a hosted-catalog rejection reason to a client-surfacing 400 (not a redacted 500). */
export function shareRejectedError(rejected: string): InvalidInputError {
  return new InvalidInputError(
    rejected === "not-connected" ? "connect your GitHub account first" : `share rejected: ${rejected}`,
  );
}
