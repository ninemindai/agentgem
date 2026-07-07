// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
// src/watchHygiene.ts
//
// SSE endpoint for the Watch tab's live context-hygiene nudge. Tails ONE Claude
// session transcript (same mtime-poll scaffold as watchEvents.ts) and, on each
// change, re-runs the #161 hygiene scan (hygieneReportForFile) and sends the
// per-tick events assembled by buildTickEvents — a live `hygiene` snapshot every
// tick, and a `nudge` only when the verdict CLIMBS. Claude-only (the bloat curve
// needs per-turn usage). Never throws on a bad tick; robustness mirrors watchEvents.
import { statSync } from "node:fs";
import { resolveTranscriptFile, sourceForFile } from "./watchSessions.js";
import { hygieneReportForFile } from "./sessionHygieneCore.js";
import { buildTickEvents, type Verdict } from "./watchHygieneNudge.js";

interface SseReq { query: Record<string, unknown>; on?(event: string, cb: () => void): void }
interface SseRes { writeHead(status: number, headers: Record<string, string>): void; write(chunk: string): void; end(): void }

const POLL_MS = 1000;
const HEARTBEAT_MS = 15000;

export function streamWatchHygiene(req: SseReq, res: SseRes): void {
  const fileParam = typeof req.query.file === "string" ? req.query.file : "";
  const resolved = resolveTranscriptFile(fileParam);
  const source = resolved ? sourceForFile(resolved) : null;

  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });
  const send = (event: string, data: unknown) => {
    res.write(`event: ${event}\n`);
    res.write(`data: ${JSON.stringify(data)}\n\n`);
  };

  if (!resolved || source?.id !== "claude") {
    send("phase", { phase: "unsupported" });
    // keep the connection open with heartbeats but stream nothing else
    const beatOnly = setInterval(() => { try { res.write(": ping\n\n"); } catch { /* closed */ } }, HEARTBEAT_MS);
    req.on?.("close", () => { clearInterval(beatOnly); try { res.end(); } catch { /* ended */ } });
    return;
  }

  let prev: Verdict | null = null;
  let lastMtime = -1;
  const tick = () => {
    let mtimeMs: number;
    try { mtimeMs = statSync(resolved).mtimeMs; } catch { return; }
    if (mtimeMs === lastMtime) return;
    lastMtime = mtimeMs;
    let events;
    try { events = buildTickEvents(prev, hygieneReportForFile(resolved)); }
    catch { return; }   // never crash the stream on a bad tick
    send("hygiene", events.hygiene);
    if (events.nudge) send("nudge", events.nudge);
    prev = events.nextVerdict;
  };

  send("phase", { phase: "watching", agent: source.id });
  tick(); // flush immediately

  const poll = setInterval(tick, POLL_MS);
  const beat = setInterval(() => { try { res.write(": ping\n\n"); } catch { /* closed */ } }, HEARTBEAT_MS);
  req.on?.("close", () => { clearInterval(poll); clearInterval(beat); try { res.end(); } catch { /* ended */ } });
}
