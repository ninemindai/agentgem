// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
// src/watchDashboard.ts
//
// SSE endpoint for the Watch "Dashboard" mode (Flavor B). Tails ONE transcript,
// coalesces bursts of events, and streams a living HTML dashboard the ACP agent
// evolves in place. Sibling of watchEvents.ts (event feed) and watchStream.ts (HTML
// artifacts). Debounced: one render per work-burst. Renders only when there are
// unreflected events and no render is in flight. A bad render keeps the last good HTML.
import { statSync, readFileSync } from "node:fs";
import { resolveTranscriptFile, sourceForFile } from "./watchSessions.js";
import { renderDashboard, type RenderInput, type RenderResult, type SessionEvent } from "@agentgem/insight";

interface SseReq { query: Record<string, unknown>; on?(event: string, cb: () => void): void; }
interface SseRes { writeHead(s: number, h: Record<string, string>): void; write(c: string): void; end(): void; }
type RenderFn = (input: RenderInput) => Promise<RenderResult>;

const POLL_MS = 1000, HEARTBEAT_MS = 15000;

export function streamWatchDashboard(
  req: SseReq, res: SseRes,
  deps: { render?: RenderFn; debounceMs?: number; ceiling?: number; fullRegenEvery?: number } = {},
): void {
  const render = deps.render ?? renderDashboard;
  const debounceMs = deps.debounceMs ?? 4000;
  const ceiling = deps.ceiling ?? 40;
  const fullRegenEvery = deps.fullRegenEvery ?? 15;

  const fileParam = typeof req.query.file === "string" ? req.query.file : "";
  const resolved = resolveTranscriptFile(fileParam);
  const source = resolved ? sourceForFile(resolved) : null;

  res.writeHead(200, {
    "Content-Type": "text/event-stream", "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive", "X-Accel-Buffering": "no",
  });
  let closed = false; // set on req close; guards every send/render (eng-review #6)
  const send = (event: string, data: unknown) => { if (closed) return; res.write(`event: ${event}\n`); res.write(`data: ${JSON.stringify(data)}\n\n`); };

  if (!resolved) {
    send("failed", { message: "unknown or out-of-scope transcript file", fatal: true }); res.end(); return;
  }
  if (!source?.detectEvents) {
    // The session is valid but its agent can't drive the dashboard yet (eng-review #5).
    send("failed", { message: `the dashboard doesn't support ${source?.id ?? "this agent"} yet`, fatal: true });
    res.end(); return;
  }

  let prevHtml = "", reflectedCount = 0, rendersSinceFull = 0, version = 0;
  let inFlight = false, dirtyDuringRender = false, lastMtime = -1, prevTruncated = false;
  let latestEvents: SessionEvent[] = [];        // events from the MOST RECENT tick parse (eng-review A1)
  let project: string | null = null;
  let debounceTimer: ReturnType<typeof setTimeout> | null = null;

  // Render against the latest parsed events. Single-in-flight; on failure keep prevHtml
  // and do NOT advance reflectedCount so the delta retries next burst.
  const runRender = async () => {
    if (closed) return;
    const events = latestEvents;
    inFlight = true; dirtyDuringRender = false;
    send("rendering", {});
    const full = rendersSinceFull >= fullRegenEvery || prevTruncated; // regen after an oversize/clipped doc (#7)
    const input: RenderInput = {
      prevHtml: full ? "" : prevHtml,
      deltaEvents: full ? events : events.slice(reflectedCount),
      meta: { project, agent: source.id },
    };
    try {
      const { html, ok, truncated } = await render(input);
      if (closed) return;                                       // client left mid-render — drop the result (#6)
      if (ok) {
        prevHtml = html; prevTruncated = truncated ?? false;
        reflectedCount = events.length; rendersSinceFull = full ? 0 : rendersSinceFull + 1;
        send("render", { html, version: ++version });
      } else {
        send("failed", { message: "render failed", fatal: false }); // recoverable: keep prevHtml, don't advance, don't close (#3)
      }
    } finally {
      inFlight = false;
      if (!closed && dirtyDuringRender && latestEvents.length > reflectedCount) arm(); // events arrived mid-render
    }
  };

  const arm = () => {
    if (inFlight) { dirtyDuringRender = true; return; }          // let the in-flight render finish, then re-arm
    if (debounceTimer) clearTimeout(debounceTimer);
    if (latestEvents.length - reflectedCount >= ceiling) { debounceTimer = null; void runRender(); return; } // ceiling: don't wait
    debounceTimer = setTimeout(() => {
      debounceTimer = null;
      if (!inFlight && latestEvents.length > reflectedCount) void runRender();
    }, debounceMs);
  };

  const tick = () => {
    let m: number; try { m = statSync(resolved).mtimeMs; } catch { return; }
    if (m === lastMtime) return;
    lastMtime = m;
    const text = safeRead(resolved);                             // read ONCE per tick, thread the parse
    if (project === null && source.parseMeta) project = source.parseMeta(text, resolved)?.project ?? null;
    latestEvents = source.detectEvents!(text, resolved);
    if (latestEvents.length > reflectedCount) arm();
  };

  send("phase", { phase: "watching", agent: source.id });
  tick(); // pick up backlog

  const poll = setInterval(tick, POLL_MS);
  const beat = setInterval(() => { try { res.write(": ping\n\n"); } catch { /* closed */ } }, HEARTBEAT_MS);
  req.on?.("close", () => {
    closed = true; // stop any in-flight render from writing / re-arming (#6)
    clearInterval(poll); clearInterval(beat); if (debounceTimer) clearTimeout(debounceTimer);
    try { res.end(); } catch { /* ended */ }
  });
}

function safeRead(file: string): string { try { return readFileSync(file, "utf8"); } catch { return ""; } }
