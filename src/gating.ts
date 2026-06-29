// Three-bucket rate limiting for the aggregator: anonymous reads (per-IP, low ceiling), keyed
// reads (per-key, high ceiling), and a separate ingest bucket (per-IP, 120/min by default) so
// publish bursts and read traffic never share a budget. Each bucket is a separate mount, routed
// by `skip`. Admin endpoints (/keys*, /sweep) are excluded from all three buckets.
import { installRateLimit } from "@agentback/extension-rate-limit";
import { makeApiKeyIdentity } from "./apiKeyIdentity.js";
import type { AppDb } from "./aggregator/schema.js";

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
};

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
    keyGenerator: (req: GReq) => req.ip ?? "anon",
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
    keyGenerator: (req: GReq) => req.ip ?? "anon",
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
