// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
// Signs a gem manifest with the local producer key AND uploads the .gem archive to the hosted
// aggregator's installable-publish endpoint. Mirrors catalogShareClient.ts, but carries the archive
// bytes so the shared gem becomes installable (not a browse-only teaser).
import type { Identity } from "@agentgem/model";
import { InvalidInputError } from "@agentgem/model";
import { createLogger } from "@agentgem/base";
import { catalogSigningPayload, type CatalogManifest } from "@agentgem/aggregator/catalog";
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

export async function postGemPublish(args: {
  manifest: CatalogManifest; archiveBase64: string; identity: Identity; endpoint?: string; http?: ShareHttp; now?: () => number;
}): Promise<{ shared: true; publishedBy: string } | { shared: false; rejected: string }> {
  const base = resolveBase(args.endpoint);
  const http = args.http ?? defaultHttp;
  const now = (args.now ?? (() => Date.now()))();
  const signature = args.identity.sign(catalogSigningPayload(args.manifest, args.identity.publicKey, now));
  const res = await http(`${base}/api/aggregator/publish-gem`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ manifest: args.manifest, archiveBase64: args.archiveBase64, pubkey: args.identity.publicKey, signedAt: now, signature }),
  });
  if (res.status < 200 || res.status >= 300) {
    log.warn("publish-gem POST to %s failed: HTTP %d", base, res.status);
    throw new InvalidInputError(`could not reach the publish service (HTTP ${res.status}); try again in a moment`);
  }
  const b = (await res.json()) as { shared?: boolean; publishedBy?: string; rejected?: string };
  if (!(b.shared && b.publishedBy)) log.info("gem publish rejected: %s", b.rejected ?? "unknown");
  return b.shared && b.publishedBy ? { shared: true, publishedBy: b.publishedBy } : { shared: false, rejected: b.rejected ?? "unknown" };
}
