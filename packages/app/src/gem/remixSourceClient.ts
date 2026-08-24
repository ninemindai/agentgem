// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
// Remix-source fetch: pull a published game's meta + sealed html from the hosted aggregator so the
// console can fork it locally. FAIL-CLOSED on allowRemix — an aggregator that doesn't state
// allowRemix (a pre-remix deploy) refuses too; the creator's opt-out must never default open.
// Public-only enforcement is DELEGATED to the aggregator (spec §5 E-PR1): game-meta must report
// allowRemix true only for public games — this client deliberately adds no second visibility check.
import { InvalidInputError } from "@agentgem/model";

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

export async function fetchRemixSource(args: { key: string; endpoint?: string; http?: RemixHttp }): Promise<RemixSource> {
  const base = resolveBase(args.endpoint);
  const http = args.http ?? defaultHttp;
  const metaRes = await http(`${base}/api/aggregator/game-meta?key=${encodeURIComponent(args.key)}`);
  if (metaRes.status === 404) throw new InvalidInputError("that game is not available to remix");
  if (metaRes.status < 200 || metaRes.status >= 300) throw new InvalidInputError(`could not fetch the game (HTTP ${metaRes.status}); try again in a moment`);
  const meta = (await metaRes.json()) as { title?: string; genre?: string; version?: string; allowRemix?: boolean };
  if (meta.allowRemix !== true) throw new InvalidInputError("the creator hasn't allowed remixing for this game");
  if (!meta.title || !meta.version) throw new InvalidInputError("that game is not available to remix");
  const htmlRes = await http(`${base}/api/aggregator/game-html?key=${encodeURIComponent(args.key)}&version=${encodeURIComponent(meta.version)}`);
  if (htmlRes.status < 200 || htmlRes.status >= 300) throw new InvalidInputError(`could not fetch the game (HTTP ${htmlRes.status}); try again in a moment`);
  const body = (await htmlRes.json()) as { html?: string };
  if (!body.html) throw new InvalidInputError("that game is not available to remix");
  return { title: meta.title, genre: meta.genre ?? "project-fun", version: meta.version, html: body.html };
}
