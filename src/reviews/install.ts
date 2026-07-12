// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
// Reviews endpoints (raw express, like stars/install.ts): reachable cross-site, own credentialed
// CORS, originGuard-exempt. Writes (POST/DELETE) are authed (session → 401); CSRF on those is
// stopped by the SameSite=Lax session cookie + the 401, NOT by CORS. GET is a public read (+ the
// caller's own review when a session cookie is present). Reviews key on the concrete catalog skill
// (kind "skill", id "<sourceId>/<path>") — content must not cross-attribute same-named skills.
import type { AppDb, makeAuth } from "@agentgem/aggregator";
import { resolveSession, upsertReview, deleteReview, reviewSummary, reviewSummaries, listReviews, myReview } from "@agentgem/aggregator";
import { cors, preflight, type Req, type Res, type ExpressApp } from "../publicCors.js";

export interface ReviewsDeps { db: AppDb; auth: ReturnType<typeof makeAuth>; webOrigins: string[] }

const KINDS = new Set(["skill"]);           // catalog-skill reviews only; no gem UI yet
const MAX_BODY = 4000;

// Minimal per-account write guard: a sliding 60s window, max 20 writes. In-memory (per instance)
// on purpose — a cheap brake on loops/floods for a new public write path; a persistent limiter is
// a follow-up if it's ever needed at scale.
const RL_WINDOW_MS = 60_000, RL_MAX = 20, RL_MAX_ACCOUNTS = 10_000;
const writeLog = new Map<string, number[]>();
function rateLimited(accountId: string): boolean {
  const now = Date.now();
  const arr = (writeLog.get(accountId) ?? []).filter((t) => now - t < RL_WINDOW_MS);
  if (arr.length === 0) writeLog.delete(accountId); else writeLog.set(accountId, arr);
  if (arr.length >= RL_MAX) return true;
  arr.push(now);
  writeLog.set(accountId, arr); // re-store with this write recorded (arr is now non-empty)
  // Backstop against unbounded growth from many one-off reviewers: evict the oldest account once
  // over the cap. Worst case just resets a stranger's window; the limiter is a cheap brake anyway.
  if (writeLog.size > RL_MAX_ACCOUNTS) {
    const oldest = writeLog.keys().next().value;
    if (oldest !== undefined && oldest !== accountId) writeLog.delete(oldest);
  }
  return false;
}

async function account(deps: ReviewsDeps, req: Req): Promise<string | null> {
  const who = await resolveSession(deps.auth, req.headers);
  return who?.accountId ?? null;
}
function validTarget(kind: string, id: string): boolean {
  return KINDS.has(kind) && id.length > 0 && id.length <= 512;
}

export function postHandler(deps: ReviewsDeps) {
  return async (req: Req, res: Res): Promise<void> => {
    cors(req, res, deps.webOrigins);
    if (req.method === "OPTIONS") { preflight(res, "GET, POST, DELETE, OPTIONS"); return; }
    const accountId = await account(deps, req);
    if (!accountId) { res.status(401).json({ error: "sign in required" }); return; }
    const kind = String((req.body.kind as string | undefined) ?? "");
    const id = String((req.body.id as string | undefined) ?? "");
    const rating = Number(req.body.rating);
    const bodyRaw = req.body.body;
    const body = bodyRaw == null ? null : String(bodyRaw);
    if (!validTarget(kind, id) || !Number.isInteger(rating) || rating < 1 || rating > 5 || (body !== null && body.length > MAX_BODY)) {
      res.status(400).json({ error: "invalid review" }); return;
    }
    if (rateLimited(accountId)) { res.status(429).json({ error: "too many reviews, slow down" }); return; }
    const mine = await upsertReview(deps.db, accountId, kind, id, rating, body);
    res.json({ mine, summary: await reviewSummary(deps.db, kind, id) });
  };
}

export function deleteHandler(deps: ReviewsDeps) {
  return async (req: Req, res: Res): Promise<void> => {
    cors(req, res, deps.webOrigins);
    if (req.method === "OPTIONS") { preflight(res, "GET, POST, DELETE, OPTIONS"); return; }
    const accountId = await account(deps, req);
    if (!accountId) { res.status(401).json({ error: "sign in required" }); return; }
    const kind = String((req.query.kind as string | undefined) ?? "");
    const id = String((req.query.id as string | undefined) ?? "");
    if (!validTarget(kind, id)) { res.status(400).json({ error: "invalid target" }); return; }
    await deleteReview(deps.db, accountId, kind, id);
    res.json({ summary: await reviewSummary(deps.db, kind, id) });
  };
}

export function getHandler(deps: ReviewsDeps) {
  return async (req: Req, res: Res): Promise<void> => {
    cors(req, res, deps.webOrigins);
    if (req.method === "OPTIONS") { preflight(res, "GET, POST, DELETE, OPTIONS"); return; }
    const kind = String((req.query.kind as string | undefined) ?? "");
    const id = String((req.query.id as string | undefined) ?? "");
    if (!validTarget(kind, id)) { res.status(400).json({ error: "invalid target" }); return; }
    const [summary, reviews] = await Promise.all([reviewSummary(deps.db, kind, id), listReviews(deps.db, kind, id)]);
    const accountId = await account(deps, req);
    const mine = accountId ? await myReview(deps.db, accountId, kind, id) : null;
    res.json({ summary, reviews, mine });
  };
}

export function summaryHandler(deps: ReviewsDeps) {
  return async (req: Req, res: Res): Promise<void> => {
    cors(req, res, deps.webOrigins);
    if (req.method === "OPTIONS") { preflight(res, "GET, POST, DELETE, OPTIONS"); return; }
    const kind = String((req.query.kind as string | undefined) ?? "");
    if (!KINDS.has(kind)) { res.status(400).json({ error: "invalid kind" }); return; }
    const ids = String((req.query.ids as string | undefined) ?? "").split(",").map((s) => s.trim()).filter(Boolean).slice(0, 100);
    res.json({ summaries: await reviewSummaries(deps.db, kind, ids) });
  };
}

export function installReviews(expressApp: ExpressApp, deps: ReviewsDeps): void {
  expressApp.post("/api/reviews", postHandler(deps));
  expressApp.delete("/api/reviews", deleteHandler(deps));
  expressApp.get("/api/reviews", getHandler(deps));
  expressApp.get("/api/reviews/summary", summaryHandler(deps));
  expressApp.options("/api/reviews", postHandler(deps));
  expressApp.options("/api/reviews/summary", summaryHandler(deps));
}
