// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
// Signs and calls PR 2a's unlisted share endpoints with the local producer key. Mirrors
// gemPublishClient.ts, but hits /share-archive (mint → {key,url}) and /share-archive/revoke.
import type { Identity } from "@agentgem/model";
import { catalogSigningPayload, type CatalogManifest } from "@agentgem/aggregator";
import type { ShareHttp } from "./catalogShareClient.js";

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

export async function postShareArchive(args: {
  manifest: CatalogManifest; archiveBase64: string; identity: Identity; endpoint?: string; http?: ShareHttp; now?: () => number;
}): Promise<{ ok: true; key: string; url: string } | { ok: false; rejected: string }> {
  const base = resolveBase(args.endpoint);
  const http = args.http ?? defaultHttp;
  const now = (args.now ?? (() => Date.now()))();
  const signature = args.identity.sign(catalogSigningPayload(args.manifest, args.identity.publicKey, now));
  const res = await http(`${base}/api/aggregator/share-archive`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ manifest: args.manifest, archiveBase64: args.archiveBase64, pubkey: args.identity.publicKey, signedAt: now, signature }),
  });
  if (res.status < 200 || res.status >= 300) return { ok: false, rejected: `HTTP ${res.status}` };
  const b = (await res.json()) as { key?: string; url?: string };
  return b.key && b.url ? { ok: true, key: b.key, url: b.url } : { ok: false, rejected: "unexpected response" };
}

export async function postShareArchiveRevoke(args: {
  key: string; identity: Identity; endpoint?: string; http?: ShareHttp; now?: () => number;
}): Promise<{ ok: true } | { ok: false; rejected: string }> {
  const base = resolveBase(args.endpoint);
  const http = args.http ?? defaultHttp;
  const now = (args.now ?? (() => Date.now()))();
  const signature = args.identity.sign(`revoke:${args.key}:${now}`);
  const res = await http(`${base}/api/aggregator/share-archive/revoke`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ key: args.key, pubkey: args.identity.publicKey, signedAt: now, signature }),
  });
  if (res.status < 200 || res.status >= 300) return { ok: false, rejected: `HTTP ${res.status}` };
  return { ok: true };
}
