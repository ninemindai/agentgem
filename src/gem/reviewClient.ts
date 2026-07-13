// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
// Local sign+forward client for the aggregator review-staging routes. Mirrors gemPublishClient, but
// signs the review-specific payloads (never catalogSigningPayload) so a captured review request can't
// be replayed to /publish-gem.
import type { Identity } from "@agentgem/model";
import { InvalidInputError } from "@agentgem/model";
import { createLogger } from "@agentgem/base";
import { reviewSubmitPayload, reviewResubmitPayload, reviewActionPayload, type CatalogManifest } from "@agentgem/aggregator/catalog";

const log = createLogger("review");

export type ReviewHttp = (url: string, init: { method: string; headers: Record<string, string>; body: string; signal?: AbortSignal }) => Promise<{ status: number; json(): Promise<unknown> }>;

const defaultHttp: ReviewHttp = async (url, init) => {
  const res = await fetch(url, { ...init, signal: AbortSignal.timeout(30_000) });
  return { status: res.status, json: () => res.json() };
};

const DEFAULT_AGGREGATOR_URL = "https://api.agentgem.ai";

// Resolve the backend base: explicit endpoint -> AGENTGEM_AGGREGATOR_URL -> the hosted default.
function resolveBase(endpoint: string | undefined): string {
  if (endpoint !== undefined) return endpoint;
  if (process.env.AGENTGEM_AGGREGATOR_URL) return process.env.AGENTGEM_AGGREGATOR_URL;
  return DEFAULT_AGGREGATOR_URL;
}

async function forward(base: string, path: string, body: unknown, http: ReviewHttp): Promise<any> {
  const res = await http(`${base}/api/aggregator${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (res.status < 200 || res.status >= 300) {
    log.warn("review POST to %s%s failed: HTTP %d", base, path, res.status);
    throw new InvalidInputError(`could not reach the review service (HTTP ${res.status}); try again in a moment`);
  }
  return res.json();
}

export async function postReviewRequest(args: {
  manifest: CatalogManifest; archiveBase64: string; groupId: string; description?: string;
  identity: Identity; endpoint?: string; http?: ReviewHttp; now?: () => number;
}): Promise<{ ok: true; requestId: string } | { ok: false; rejected: string }> {
  const now = (args.now ?? (() => Date.now()))();
  const signature = args.identity.sign(reviewSubmitPayload(args.manifest, args.groupId, args.identity.publicKey, now));
  const body = {
    manifest: args.manifest, archiveBase64: args.archiveBase64, groupId: args.groupId, description: args.description,
    pubkey: args.identity.publicKey, signedAt: now, signature,
  };
  const r = (await forward(resolveBase(args.endpoint), "/review/request", body, args.http ?? defaultHttp)) as {
    ok?: boolean; requestId?: string; rejected?: string;
  };
  if (!r.ok) log.info("review request rejected: %s", r.rejected ?? "unknown");
  return r.ok && r.requestId ? { ok: true, requestId: r.requestId } : { ok: false, rejected: r.rejected ?? "unknown" };
}

export async function postReviewResubmit(args: {
  manifest: CatalogManifest; archiveBase64: string; requestId: string; description?: string;
  identity: Identity; endpoint?: string; http?: ReviewHttp; now?: () => number;
}): Promise<{ ok: true } | { ok: false; rejected: string }> {
  const now = (args.now ?? (() => Date.now()))();
  const signature = args.identity.sign(reviewResubmitPayload(args.manifest, args.requestId, args.identity.publicKey, now));
  const body = {
    manifest: args.manifest, archiveBase64: args.archiveBase64, requestId: args.requestId, description: args.description,
    pubkey: args.identity.publicKey, signedAt: now, signature,
  };
  const r = (await forward(resolveBase(args.endpoint), "/review/resubmit", body, args.http ?? defaultHttp)) as {
    ok?: boolean; rejected?: string;
  };
  if (!r.ok) log.info("review resubmit rejected: %s", r.rejected ?? "unknown");
  return r.ok ? { ok: true } : { ok: false, rejected: r.rejected ?? "unknown" };
}

// Generic signed action → returns the aggregator's JSON verbatim (caller shapes it). Covers inbox
// (action:"inbox", requestId:"", path:"/review/inbox"), get, message (action:"message:"+body,
// extra:{body}), approve/changes/withdraw/seen. `action` MUST match what the aggregator verifies.
export async function postReviewAction(args: {
  action: string; requestId: string; path: string; extra?: Record<string, unknown>;
  identity: Identity; endpoint?: string; http?: ReviewHttp; now?: () => number;
}): Promise<any> {
  const now = (args.now ?? (() => Date.now()))();
  const signature = args.identity.sign(reviewActionPayload(args.action, args.requestId, args.identity.publicKey, now));
  const body = { requestId: args.requestId, ...args.extra, pubkey: args.identity.publicKey, signedAt: now, signature };
  return forward(resolveBase(args.endpoint), args.path, body, args.http ?? defaultHttp);
}

export async function fetchReviewArchive(args: {
  requestId: string; identity: Identity; endpoint?: string; http?: ReviewHttp; now?: () => number;
}): Promise<Buffer | null> {
  const r = (await postReviewAction({
    action: "archive", requestId: args.requestId, path: "/review/archive",
    identity: args.identity, endpoint: args.endpoint, http: args.http, now: args.now,
  })) as { archiveBase64?: string | null };
  return r.archiveBase64 == null ? null : Buffer.from(r.archiveBase64, "base64");
}
