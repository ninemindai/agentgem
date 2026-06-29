// Two-tier rate limiting for the aggregator: anonymous callers are limited per-IP at a low
// ceiling; callers presenting a valid API key are limited per-key at a high ceiling. The
// extension can't vary `points` per request, so each tier is a separate mount, routed by `skip`.
import { installRateLimit } from "@agentback/extension-rate-limit";
import { makeApiKeyIdentity } from "./apiKeyIdentity.js";
import type { AppDb } from "./aggregator/schema.js";

const AGG_PATH = "/api/aggregator";
export const WINDOW_SECS = 60;
export const ANON_POINTS = Number(process.env.AGG_ANON_POINTS ?? 60);
export const KEYED_POINTS = Number(process.env.AGG_KEYED_POINTS ?? 600);

type GReq = { ip?: string; gemTier?: string; gemKeyId?: string };

export function anonRateLimitOptions(points: number = ANON_POINTS) {
  return {
    path: AGG_PATH,
    points,
    durationSecs: WINDOW_SECS,
    keyGenerator: (req: GReq) => req.ip ?? "anon",
    skip: (req: GReq) => req.gemTier === "keyed",
  };
}

export function keyedRateLimitOptions(points: number = KEYED_POINTS) {
  return {
    path: AGG_PATH,
    points,
    durationSecs: WINDOW_SECS,
    keyGenerator: (req: GReq) => req.gemKeyId ?? "anon",
    skip: (req: GReq) => req.gemTier !== "keyed",
  };
}

// Mounts identity (scoped to /api/aggregator) ahead of the two limiter mounts. Call in
// createApp after the aggregator db is registered and before app.start().
export async function mountGating(app: import("@agentback/rest").RestApplication, db: AppDb): Promise<void> {
  const server = await app.restServer;
  server.expressApp.use(AGG_PATH, makeApiKeyIdentity(db));
  await installRateLimit(app, anonRateLimitOptions());
  await installRateLimit(app, keyedRateLimitOptions());
}
