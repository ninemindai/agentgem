// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
// src/watchEvents.ts
//
// SSE endpoint for the Watch tab's live EVENT feed (Flavor A): tails ONE coding-
// session transcript and streams its ordered SessionEvents — messages, tool_calls,
// and (separately) tool_results — as they are appended. Sibling of watchStream.ts,
// which streams the HTML ARTIFACTS a session builds; this one streams the session's
// activity itself, for a CopilotKit-style live feed of hand-authored cards.
//
// The feed is append-only: detectEvents re-folds the whole (append-only) transcript
// on each mtime change, and we emit only the suffix we haven't sent yet (count-based,
// like watchStream's artifact versions). Because tool_call and tool_result are kept
// UNFOLDED (separate events), a result that lands in a later record simply becomes a
// later event — no prior event is ever re-sent or mutated. Which parser runs is the
// SourceSpec's detectEvents, so adding an agent is a change in @agentgem/insight.
// Every string is already scrubbed inside detectEvents (the secret-safe boundary).
import { statSync, readFileSync } from "node:fs";
import { resolveTranscriptFile, sourceForFile } from "./watchSessions.js";

interface SseReq {
  query: Record<string, unknown>;
  on?(event: string, cb: () => void): void;
}
interface SseRes {
  writeHead(status: number, headers: Record<string, string>): void;
  write(chunk: string): void;
  end(): void;
}

const POLL_MS = 1000;
const HEARTBEAT_MS = 15000;

export function streamWatchEvents(req: SseReq, res: SseRes): void {
  const fileParam = typeof req.query.file === "string" ? req.query.file : "";
  const resolved = resolveTranscriptFile(fileParam); // pins ?file= to a registered watch root
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

  if (!resolved || !source?.detectEvents) {
    send("failed", { message: "unknown or out-of-scope transcript file" });
    res.end();
    return;
  }

  // Re-fold the whole (append-only) transcript when its mtime changes and emit only
  // the suffix past what we've already sent. `sent` doubles as the global event index.
  let sent = 0, lastMtime = -1;
  const tick = () => {
    let mtimeMs: number;
    try { mtimeMs = statSync(resolved).mtimeMs; } catch { return; }
    if (mtimeMs === lastMtime) return;
    lastMtime = mtimeMs;
    let text: string; try { text = readFileSync(resolved, "utf8"); } catch { return; }
    const events = source.detectEvents!(text, resolved);
    for (; sent < events.length; sent++) send("event", { index: sent, ...events[sent] });
  };

  send("phase", { phase: "watching", agent: source.id });
  tick(); // flush the backlog immediately

  const poll = setInterval(tick, POLL_MS);
  const beat = setInterval(() => { try { res.write(": ping\n\n"); } catch { /* closed */ } }, HEARTBEAT_MS);
  req.on?.("close", () => { clearInterval(poll); clearInterval(beat); try { res.end(); } catch { /* ended */ } });
}
