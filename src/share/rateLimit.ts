// src/share/rateLimit.ts
// IP rate-limit for the anonymous public create endpoint (POST /api/aggregator/share).
//
// The share-card create endpoint takes no auth (frictionless viral loop), so without a limit a
// script could insert unbounded rows. originGuard does NOT help here: a non-browser client sends
// no Origin/Sec-Fetch-Site and is intentionally allowed through, so this limiter is the only
// defense against scripted abuse. In-memory fixed-window, keyed by client IP — per-instance state
// (adequate for the single-instance Render deploy; a shared store can replace it if we scale out).
//
// req/res are duck-typed (Express shape) to avoid an @types/express dependency, matching
// originGuard.ts and the raw SSE handlers.

interface RLReq { method: string; path: string; ip?: string; get(name: string): string | undefined }
interface RLRes { status(code: number): RLRes; type(t: string): RLRes; set(name: string, value: string): RLRes; send(body: string): unknown }
type RLNext = () => void;

const SHARE_PATH = "/api/aggregator/share";

// Client IP behind a proxy/CDN: CF-Connecting-IP is set by Cloudflare and is the real client;
// X-Forwarded-For's first hop is the next fallback; then the socket IP. "unknown" buckets together
// any request we can't attribute (so a spoofer stripping all hints shares one budget, not a bypass).
export function clientIp(req: { ip?: string; get(name: string): string | undefined }): string {
  const cf = req.get("cf-connecting-ip");
  if (cf) return cf.trim();
  const xff = req.get("x-forwarded-for");
  if (xff) return xff.split(",")[0].trim();
  if (req.ip) return req.ip;
  return "unknown";
}

export interface HitResult { allowed: boolean; retryAfterMs: number }

export class FixedWindowLimiter {
  private hits = new Map<string, { count: number; resetAt: number }>();
  private lastSweep: number;
  constructor(private max: number, private windowMs: number, private now: () => number = Date.now) {
    this.lastSweep = now();
  }

  hit(key: string): HitResult {
    const t = this.now();
    this.maybeSweep(t);
    const e = this.hits.get(key);
    if (!e || t >= e.resetAt) {
      this.hits.set(key, { count: 1, resetAt: t + this.windowMs });
      return { allowed: true, retryAfterMs: 0 };
    }
    if (e.count < this.max) {
      e.count++;
      return { allowed: true, retryAfterMs: 0 };
    }
    return { allowed: false, retryAfterMs: e.resetAt - t };
  }

  // Drop expired buckets so distinct-IP traffic over time can't grow the map without bound.
  private maybeSweep(t: number): void {
    if (t - this.lastSweep < this.windowMs) return;
    for (const [k, e] of this.hits) if (t >= e.resetAt) this.hits.delete(k);
    this.lastSweep = t;
  }
}

// Build the middleware with explicit config (used by tests with an injected clock + small limits).
export function makeShareRateLimit(opts: { max: number; windowMs: number; now?: () => number }): (req: RLReq, res: RLRes, next: RLNext) => void {
  const limiter = new FixedWindowLimiter(opts.max, opts.windowMs, opts.now);
  return (req, res, next) => {
    if (req.method.toUpperCase() !== "POST" || (req.path !== SHARE_PATH && req.path !== SHARE_PATH + "/")) {
      next();
      return;
    }
    const r = limiter.hit(clientIp(req));
    if (r.allowed) { next(); return; }
    res
      .status(429)
      .set("Retry-After", String(Math.ceil(r.retryAfterMs / 1000)))
      .type("application/json")
      .send(JSON.stringify({ error: "rate limit exceeded, try again later" }));
  };
}

// The app-wired middleware: limits read from env with sane defaults (10 creates / 10 min / IP).
const MAX = Number(process.env.SHARE_RATELIMIT_MAX ?? 10);
const WINDOW_MS = Number(process.env.SHARE_RATELIMIT_WINDOW_MS ?? 600_000);
export const shareRateLimit = makeShareRateLimit({ max: MAX, windowMs: WINDOW_MS });
