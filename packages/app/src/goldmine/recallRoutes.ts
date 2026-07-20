// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
// src/goldmine/recallRoutes.ts
//
// REST + SSE endpoints for the goldmine Recall tab. Five routes:
//   GET    /api/recall/search   ?q&project&agent&since&limit → { moments }  (instant BM25, read handle)
//   GET    /api/recall/status   → { ready, indexed, total, facets: { projects, agents } }
//   POST   /api/recall/run      body: { sessionIds, prompt, mode } → { jobId }
//   GET    /api/recall/stream   ?jobId → SSE FunnelEvent stream (the capped ask_session fan-out)
//   DELETE /api/recall/:jobId   → { ok: true }
//
// Mirrors chatRoutes.ts's pattern: duck-typed Express (no @types/express dependency),
// SSE via res.write, an in-closure Map for job tracking. A job is a mint from /run
// (sessionIds/prompt/mode + a fresh AbortController); /stream drives recallFunnel
// against it and evicts the job when the stream ends; DELETE cancels + evicts early.
import { recallFunnel } from "@agentgem/recall";
import type { RecallIndex, FunnelDeps, FunnelEvent, FunnelMode, SessionRef,
  MomentHit, RecallFilters, ProvenUseLookup } from "@agentgem/recall";

/** A/B recall (validation instrument #1). Baseline (pure BM25) is always
 *  returned; the boosted (proven-use) ordering is returned only when `ab` is set
 *  AND a lookup is configured. One index handle serves both arms — the lookup is
 *  passed per-call, so the default path stays pure BM25 (the kill switch). Lets
 *  the operator eyeball both orderings on their own transcripts. */
export function abSearch(
  index: Pick<RecallIndex, "search">,
  lookup: ProvenUseLookup | undefined,
  q: string, filters: RecallFilters, limit: number, ab: boolean,
): { moments: MomentHit[]; momentsBoosted?: MomentHit[] } {
  const moments = index.search(q, filters, limit);
  if (!ab || !lookup) return { moments };
  return { moments, momentsBoosted: index.search(q, filters, limit, lookup) };
}

// Duck-typed Express request/response so this file carries no @types/express dependency
// (mirrors chatRoutes.ts:26-45). `on` is optional — only /stream's disconnect-abort uses it.
interface Req {
  body?: Record<string, unknown>;
  query: Record<string, unknown>;
  params: Record<string, string>;
  on?: (event: string, cb: () => void) => void;
}
interface Res {
  status(code: number): Res;
  json(body: unknown): void;
  setHeader(name: string, value: string): void;
  write(chunk: string): void;
  end(): void;
}
// Minimal Express middleware shape (same duck-typing as originGuard.ts).
type Middleware = (req: Req, res: Res, next: () => void) => void;
// Express app interface — just the subset of methods we call.
interface App {
  get(path: string, guard: Middleware, handler: (req: Req, res: Res) => void | Promise<void>): void;
  post(path: string, guard: Middleware, handler: (req: Req, res: Res) => Promise<void>): void;
  delete(path: string, guard: Middleware, handler: (req: Req, res: Res) => void): void;
}

export interface RecallRouteDeps {
  readIndex: RecallIndex;
  funnelDeps: FunnelDeps;
  indexStatus: () => { ready: boolean; indexed: number; total: number; facets: { projects: string[]; agents: string[] } };
  /** Optional proven-use boost (validation instrument #1). When present, a
   *  `?ab=1` search returns both the baseline and boosted orderings. Absent =
   *  the route is pure BM25 (kill switch). */
  provenUse?: ProvenUseLookup;
}

// No-op guard used when no CSRF/origin middleware is supplied (e.g. tests that
// register routes directly on a bare app) — mirrors chatRoutes.ts:97.
const noopGuard: Middleware = (_req, _res, next) => next();

interface RecallJob {
  input: { sessionIds: SessionRef[]; prompt: string; mode: FunnelMode };
  ctrl: AbortController;
}

// Drain a FunnelEvent generator to the client as SSE frames, then end the
// response once. Exported so the test can drive it against a hand-rolled
// generator + a fake Res without an HTTP server. Mirrors chatRoutes.ts's
// /api/chat/stream pattern: a generator throw is caught and reported as a
// `failed` SSE frame (never rethrown — the stream has already started), and
// res.end() runs in a finally so it fires on every path.
export async function streamFunnel(res: Res, gen: AsyncGenerator<FunnelEvent>): Promise<void> {
  const send = (event: string, data: unknown) =>
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  try {
    for await (const ev of gen) {
      send(ev.type, ev);
    }
  } catch (err) {
    send("failed", { error: String((err as Error)?.message ?? err) });
  } finally {
    res.end();
  }
}

export function registerRecallRoutes(app: App, deps: RecallRouteDeps, guard: Middleware = noopGuard): void {
  const jobs = new Map<string, RecallJob>();
  let counter = 0;

  // GET /api/recall/search — instant BM25 search over the on-disk index.
  app.get("/api/recall/search", guard, (req, res) => {
    const q = String(req.query.q ?? "");
    if (!q.trim()) { res.json({ moments: [] }); return; }
    const project = req.query.project !== undefined ? String(req.query.project) : undefined;
    const agent = req.query.agent !== undefined ? String(req.query.agent) : undefined;
    const sinceNum = req.query.since !== undefined ? Number(req.query.since) : undefined;
    const since = Number.isFinite(sinceNum) ? sinceNum : undefined;
    const limitNum = req.query.limit !== undefined ? Number(req.query.limit) : 12;
    const limit = Number.isFinite(limitNum) ? Math.min(50, Math.max(1, Math.floor(limitNum))) : 12;
    const ab = req.query.ab === "1";
    res.json(abSearch(deps.readIndex, deps.provenUse, q, { project, agent, since }, limit, ab));
  });

  // GET /api/recall/status — index freshness for the Recall panel's header.
  app.get("/api/recall/status", guard, (_req, res) => {
    res.json(deps.indexStatus());
  });

  // POST /api/recall/run — mint a job for the capped ask_session fan-out; the
  // work itself only starts once the caller opens /api/recall/stream?jobId=.
  app.post("/api/recall/run", guard, async (req, res) => {
    const body = req.body ?? {};
    const sessionIds = body.sessionIds;
    const prompt = body.prompt;
    const mode = body.mode;
    if (!Array.isArray(sessionIds) || sessionIds.length === 0) {
      res.status(400).json({ error: "sessionIds required" });
      return;
    }
    for (const s of sessionIds) {
      const ok = s && typeof s === "object" && typeof (s as SessionRef).sessionId === "string" && typeof (s as SessionRef).agent === "string";
      if (!ok) { res.status(400).json({ error: "sessionIds must be {sessionId,agent} objects" }); return; }
    }
    if (typeof prompt !== "string" || !prompt.trim()) { res.status(400).json({ error: "prompt required" }); return; }
    if (mode !== "chat" && mode !== "extract") { res.status(400).json({ error: "mode must be chat or extract" }); return; }

    const jobId = `recall_${++counter}`;
    jobs.set(jobId, { input: { sessionIds: sessionIds as SessionRef[], prompt, mode }, ctrl: new AbortController() });
    res.json({ jobId });
  });

  // GET /api/recall/stream?jobId=... — SSE stream of FunnelEvents for a job minted by /run.
  app.get("/api/recall/stream", guard, async (req, res) => {
    const jobId = String(req.query.jobId ?? "");
    const job = jobs.get(jobId);
    if (!job) { res.status(404).json({ error: "unknown job" }); return; }

    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("X-Accel-Buffering", "no");
    res.setHeader("Connection", "keep-alive");

    if (req.on) req.on("close", () => job.ctrl.abort());

    try {
      await streamFunnel(
        res,
        recallFunnel({ sessions: job.input.sessionIds, prompt: job.input.prompt, mode: job.input.mode, signal: job.ctrl.signal }, deps.funnelDeps),
      );
    } finally {
      jobs.delete(jobId);
    }
  });

  // DELETE /api/recall/:jobId — cancel + evict a job early (before /stream is opened, or mid-stream).
  app.delete("/api/recall/:jobId", guard, (req, res) => {
    const jobId = req.params.jobId;
    const job = jobs.get(jobId);
    if (!job) { res.status(404).json({ error: "unknown job" }); return; }
    job.ctrl.abort();
    jobs.delete(jobId);
    res.json({ ok: true });
  });
}
