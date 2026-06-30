// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
// Three-bucket rate limiting for the aggregator: anonymous reads (per-IP, low ceiling), keyed
// reads (per-key, high ceiling), and a separate ingest bucket (per-IP, 120/min by default) so
// publish bursts and read traffic never share a budget. Each bucket is a separate mount, routed
// by `skip`. Admin endpoints (/keys*, /sweep) are excluded from all three buckets.
import { installRateLimit } from "@agentback/extension-rate-limit";
import { makeApiKeyIdentity } from "./apiKeyIdentity.js";
import type { AppDb } from "@agentgem/aggregator";

const AGG_PATH = "/api/aggregator";
export const WINDOW_SECS = 60;

// NaN-guard: env values that parse as non-numeric fall back to the default.
export function posIntEnv(name: string, def: number): number {
  const n = Number(process.env[name]);
  return Number.isFinite(n) && n > 0 ? n : def;
}

export const ANON_POINTS = posIntEnv("AGG_ANON_POINTS", 60);
export const KEYED_POINTS = posIntEnv("AGG_KEYED_POINTS", 600);
export const INGEST_POINTS = posIntEnv("AGG_INGEST_POINTS", 120);

type GReq = {
  ip?: string;
  gemTier?: string;
  gemKeyId?: string;
  originalUrl?: string;
  baseUrl?: string;
  path?: string;
  headers?: Record<string, string | string[] | undefined>;
};

// Resolve the caller's IP for per-IP rate limiting. Behind a proxy/CDN (e.g. Render is fronted
// by Cloudflare), `req.ip` is the proxy's address — and trust-proxy hop-counting is fragile when
// the depth varies, so each rotating edge IP lands in its own bucket and the limit never binds.
// If CLIENT_IP_HEADER names a header the fronting proxy sets to the true client IP (e.g.
// `cf-connecting-ip`), key on that instead. Env-gated so the header is trusted only on hosts where
// a known proxy sets it — otherwise a client could spoof it to evade the limit.
export function clientIp(req: GReq): string {
  const headerName = process.env.CLIENT_IP_HEADER;
  if (headerName) {
    const raw = req.headers?.[headerName.toLowerCase()];
    const val = Array.isArray(raw) ? raw[0] : raw;
    if (typeof val === "string" && val.trim()) return val.split(",")[0].trim();
  }
  return req.ip ?? "anon";
}

function isIngestPath(req: GReq): boolean {
  const full = req.originalUrl ? req.originalUrl.split("?")[0] : (req.baseUrl ?? "") + (req.path ?? "");
  return full === `${AGG_PATH}/ingest`;
}

// Admin paths (key management + sweep) must not consume the public rate-limit buckets.
// When the limiter is mounted at AGG_PATH the skip callback may receive a path already
// stripped of that prefix (e.g. `/keys`). Derive the full path robustly: prefer
// req.originalUrl (strip any ?query), fall back to baseUrl + path concatenation.
function isAdminPath(req: GReq): boolean {
  const full = req.originalUrl
    ? req.originalUrl.split("?")[0]
    : (req.baseUrl ?? "") + (req.path ?? "");
  return full.startsWith(`${AGG_PATH}/keys`) || full === `${AGG_PATH}/sweep`;
}

export function anonRateLimitOptions(points: number = ANON_POINTS) {
  return {
    path: AGG_PATH,
    points,
    durationSecs: WINDOW_SECS,
    keyGenerator: (req: GReq) => clientIp(req),
    skip: (req: GReq) => isAdminPath(req) || isIngestPath(req) || req.gemTier === "keyed",
  };
}

export function keyedRateLimitOptions(points: number = KEYED_POINTS) {
  return {
    path: AGG_PATH,
    points,
    durationSecs: WINDOW_SECS,
    // gemKeyId is guaranteed present when gemTier === "keyed" at runtime, but the type is
    // optional, so the ?? "anon" fallback is kept to satisfy tsc (removing it causes a
    // TS2322: Type 'string | undefined' is not assignable to 'string').
    keyGenerator: (req: GReq) => req.gemKeyId ?? "anon",
    skip: (req: GReq) => isAdminPath(req) || isIngestPath(req) || req.gemTier !== "keyed",
  };
}

export function ingestRateLimitOptions(points: number = INGEST_POINTS) {
  return {
    path: AGG_PATH,
    points,
    durationSecs: WINDOW_SECS,
    keyGenerator: (req: GReq) => clientIp(req),
    skip: (req: GReq) => !isIngestPath(req), // this mount applies ONLY to /ingest
  };
}

// Mounts identity (scoped to /api/aggregator) ahead of the two limiter mounts. Call in
// createApp after the aggregator db is registered and before app.start().
export async function mountGating(app: import("@agentback/rest").RestApplication, db: AppDb): Promise<void> {
  const server = await app.restServer;
  server.expressApp.use(AGG_PATH, makeApiKeyIdentity(db));
  await installRateLimit(app, anonRateLimitOptions());
  await installRateLimit(app, keyedRateLimitOptions());
  await installRateLimit(app, ingestRateLimitOptions());
}
