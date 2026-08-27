// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
// Remix-source fetch: pull a published game's meta + sealed html from the hosted aggregator so the
// console can fork it locally. FAIL-CLOSED on allowRemix — an aggregator that doesn't state
// allowRemix (a pre-remix deploy) refuses too; the creator's opt-out must never default open.
// Public-only enforcement is DELEGATED to the aggregator (spec §5 E-PR1): game-meta must report
// allowRemix true only for public games — this client deliberately adds no second visibility check.
import { InvalidInputError } from "@agentgem/model";
import { createLogger } from "@agentgem/base";

const log = createLogger("remix");

export interface RemixSource { title: string; genre: string; version: string; html: string }

export type RemixHttp = (url: string) => Promise<{ status: number; json(): Promise<unknown> }>;
const defaultHttp: RemixHttp = async (url) => {
  const res = await fetch(url, { signal: AbortSignal.timeout(30_000) });
  return { status: res.status, json: () => res.json() };
};

// Resolve the hosted base: explicit endpoint -> AGENTGEM_AGGREGATOR_URL -> the hosted default.
function resolveBase(endpoint: string | undefined): string {
  if (endpoint !== undefined) return endpoint;
  if (process.env.AGENTGEM_AGGREGATOR_URL) return process.env.AGENTGEM_AGGREGATOR_URL;
  return "https://api.agentgem.ai";
}

// A thrown transport error (timeout AbortError, DNS TypeError, ...) is opaque and would otherwise
// surface to the confirm card as a raw fetch error / 500. Map it to the same clean InvalidInputError
// shape as every other rejection here (logging the real cause first, so a support/debug session can
// still see what actually failed). Only wraps the transport call itself — the explicit
// InvalidInputError throws below (allowRemix refusal, 404 mapping, missing html) happen after a
// normal resolution and pass through untouched.
async function safeCall(http: RemixHttp, url: string): Promise<{ status: number; json(): Promise<unknown> }> {
  try {
    return await http(url);
  } catch (err) {
    log.warn("remix source fetch failed (%s): %s", url, (err as Error)?.message ?? err);
    throw new InvalidInputError("could not reach the marketplace; try again in a moment");
  }
}

// A resolved HTTP response is not a guarantee the body actually arrives intact — a connection
// dropped mid-body, or a malformed body, surfaces as `.json()` rejecting rather than the fetch call
// itself throwing. Map that failure to the same clean message/log as safeCall, so it isn't left to
// surface opaquely. Wraps only the read itself — the explicit InvalidInputError throws that inspect
// the PARSED body (allowRemix refusal, missing title/version/html) happen after this resolves and
// pass through untouched.
async function safeJson<T>(res: { json(): Promise<unknown> }): Promise<T> {
  try {
    return (await res.json()) as T;
  } catch (err) {
    log.warn("remix source response body read failed: %s", (err as Error)?.message ?? err);
    throw new InvalidInputError("could not reach the marketplace; try again in a moment");
  }
}

export async function fetchRemixSource(args: { key: string; endpoint?: string; http?: RemixHttp }): Promise<RemixSource> {
  const base = resolveBase(args.endpoint);
  const http = args.http ?? defaultHttp;
  const metaRes = await safeCall(http, `${base}/api/aggregator/game-meta?key=${encodeURIComponent(args.key)}`);
  if (metaRes.status === 404) throw new InvalidInputError("that game is not available to remix");
  if (metaRes.status < 200 || metaRes.status >= 300) throw new InvalidInputError(`could not fetch the game (HTTP ${metaRes.status}); try again in a moment`);
  const meta = await safeJson<{ title?: string; genre?: string; version?: string; allowRemix?: boolean }>(metaRes);
  if (meta.allowRemix !== true) throw new InvalidInputError("the creator hasn't allowed remixing for this game");
  if (!meta.title || !meta.version) throw new InvalidInputError("that game is not available to remix");
  const htmlRes = await safeCall(http, `${base}/api/aggregator/game-html?key=${encodeURIComponent(args.key)}&version=${encodeURIComponent(meta.version)}`);
  if (htmlRes.status < 200 || htmlRes.status >= 300) throw new InvalidInputError(`could not fetch the game (HTTP ${htmlRes.status}); try again in a moment`);
  const body = await safeJson<{ html?: string }>(htmlRes);
  if (!body.html) throw new InvalidInputError("that game is not available to remix");
  return { title: meta.title, genre: meta.genre ?? "project-fun", version: meta.version, html: body.html };
}
