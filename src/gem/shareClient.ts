// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
export type ShareHttp = (url: string, init: { method: string; headers: Record<string, string>; body: string }) => Promise<{ status: number; json(): Promise<unknown> }>;

const defaultHttp: ShareHttp = async (url, init) => {
  const res = await fetch(url, { ...init, signal: AbortSignal.timeout(10_000) });
  return { status: res.status, json: () => res.json() };
};

type CreateBody =
  | { kind: "certificate"; counts: { breadth: number; battleTested: number; portable: number }; generatedAtMs: number }
  | { kind: "gem"; name: string; provenance: string; generatedAtMs: number };

// The hosted aggregator, Cloudflare-fronted. Sharing must work with zero config on a fresh desktop
// install, and going through app.agentgem.ai is what lets Cloudflare inject the X-Origin-Auth the
// backend's origin guard requires (a create that skips CF is rejected). Override with
// AGENTGEM_AGGREGATOR_URL (e.g. http://127.0.0.1:PORT for local dev against an in-process aggregator).
export const DEFAULT_AGGREGATOR_URL = "https://app.agentgem.ai";

// Resolve the backend base: explicit endpoint (incl. "" to disable) -> AGENTGEM_AGGREGATOR_URL ->
// the hosted default. Clicking "Share" is explicit intent to publish, so defaulting to the hosted
// aggregator is correct rather than silently skipping.
function resolveBase(endpoint: string | undefined): string {
  if (endpoint !== undefined) return endpoint;
  if (process.env.AGENTGEM_AGGREGATOR_URL) return process.env.AGENTGEM_AGGREGATOR_URL;
  return DEFAULT_AGGREGATOR_URL;
}

export async function postShare(args: {
  body: CreateBody; endpoint?: string; http?: ShareHttp;
}): Promise<{ id: string; url: string } | { skipped: true }> {
  const base = resolveBase(args.endpoint);
  if (!base) return { skipped: true };
  const http = args.http ?? defaultHttp;
  const res = await http(`${base}/api/aggregator/share`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(args.body),
  });
  if (res.status < 200 || res.status >= 300) throw new Error(`share ${res.status}`);
  const b = (await res.json()) as { id?: string; url?: string };
  if (!b.id || !b.url) throw new Error("share: response missing id/url");
  return { id: b.id, url: b.url };
}
