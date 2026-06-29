// src/originSecret.ts
// Origin lock for the anonymous share-create endpoint (POST /api/aggregator/share).
//
// The per-IP rate limit (gating's anon bucket) keys on CLIENT_IP_HEADER (e.g. cf-connecting-ip),
// which is only trustworthy if the request actually came through Cloudflare — otherwise an attacker
// hitting the origin directly (*.onrender.com) can forge that header and get a fresh bucket per
// request. This middleware proves CF origin: Cloudflare adds a secret request header (a Transform
// Rule), the app requires it. A request that didn't pass through CF lacks the secret -> 403, so the
// CLIENT_IP_HEADER the limiter reads can only have arrived via CF.
//
// Scoped to the create write only: public reads (popularity/co-occurrence/adoption) and /healthz
// must stay reachable directly, so they are never gated. No-op when ORIGIN_SHARED_SECRET is unset,
// so local/dev and pre-config deploys are unaffected. req/res are duck-typed (Express shape) to
// avoid an @types/express dependency, matching originGuard.ts.
import { timingSafeEqual } from "node:crypto";

interface OSReq { method: string; path: string; get(name: string): string | undefined }
interface OSRes { status(code: number): OSRes; type(t: string): OSRes; send(body: string): unknown }
type OSNext = () => void;

const SHARE_PATH = "/api/aggregator/share";
const HEADER = "x-origin-auth";

// Constant-time equality so the secret can't be recovered by timing the comparison.
function secretMatches(provided: string | undefined, expected: string): boolean {
  if (!provided) return false;
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

export function requireShareOriginSecret(req: OSReq, res: OSRes, next: OSNext): void {
  const secret = process.env.ORIGIN_SHARED_SECRET;
  if (!secret) { next(); return; }                                  // unset -> no-op (local/dev)
  if (req.method.toUpperCase() !== "POST" || (req.path !== SHARE_PATH && req.path !== SHARE_PATH + "/")) {
    next(); return;                                                 // only gate the create write
  }
  if (secretMatches(req.get(HEADER), secret)) { next(); return; }
  res.status(403).type("application/json").send(JSON.stringify({ error: "origin not verified" }));
}
