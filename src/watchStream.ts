// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
// src/watchStream.ts
//
// SSE endpoint for the Watch tab: tails ONE coding-session transcript and streams
// the HTML artifacts it builds (see artifactScan.ts) as versioned, sandbox-ready
// snapshots. The transcript is append-only, so we poll its mtime once a second and
// re-fold only when it grew — emitting any artifact versions not sent yet. Every
// snapshot passes through scrubText first: this is the secret-safe boundary, so the
// HTML that reaches the browser has home paths and secret tokens redacted while the
// document stays renderable.
//
// Raw handler (registered directly on expressApp) because the decorator framework
// only returns single JSON bodies — same pattern as insightsStream/gemRunStream.
import { readFileSync, statSync } from "node:fs";
import { basename } from "node:path";
import { scrubText, jsonLines, detectHtmlArtifacts } from "@agentgem/insight";
import { resolveTranscriptFile } from "./watchSessions.js";

interface SseReq {
  query: Record<string, unknown>;
  // Express req is an EventEmitter; we only need "close" to stop the poller.
  on?(event: string, cb: () => void): void;
}
interface SseRes {
  writeHead(status: number, headers: Record<string, string>): void;
  write(chunk: string): void;
  end(): void;
}

// Cap a single artifact payload so a pathological multi-megabyte document can't
// wedge the stream; the UI shows a truncation notice via the `truncated` flag.
const MAX_HTML = 1_000_000;
const POLL_MS = 1000;
const HEARTBEAT_MS = 15000;

export function streamWatch(req: SseReq, res: SseRes): void {
  const fileParam = typeof req.query.file === "string" ? req.query.file : "";
  const resolved = resolveTranscriptFile(fileParam);

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

  if (!resolved) {
    send("failed", { message: "unknown or out-of-scope transcript file" });
    res.end();
    return;
  }
  send("phase", { phase: "watching", file: resolved });

  let sent = 0;        // artifact versions already emitted
  let lastMtime = -1;  // last mtime we folded

  const tick = () => {
    let mtimeMs: number;
    try { mtimeMs = statSync(resolved).mtimeMs; } catch { return; } // file gone → wait
    if (mtimeMs === lastMtime) return;
    lastMtime = mtimeMs;

    let text: string;
    try { text = readFileSync(resolved, "utf8"); } catch { return; }
    const versions = detectHtmlArtifacts(jsonLines(text));
    for (; sent < versions.length; sent++) {
      const v = versions[sent];
      const scrubbed = scrubText(v.html);
      const html = scrubbed.slice(0, MAX_HTML);
      send("artifact", {
        index: sent,
        path: v.path,
        name: basename(v.path),
        tool: v.tool,
        version: v.version,
        tsMs: v.tsMs,
        truncated: scrubbed.length > MAX_HTML,
        html,
      });
    }
  };

  tick(); // emit any backlog immediately

  const poll = setInterval(tick, POLL_MS);
  const beat = setInterval(() => { try { res.write(": ping\n\n"); } catch { /* closed */ } }, HEARTBEAT_MS);
  const cleanup = () => { clearInterval(poll); clearInterval(beat); try { res.end(); } catch { /* already ended */ } };
  req.on?.("close", cleanup);
}
