// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
// src/watchStream.ts
//
// SSE endpoint for the Watch tab: tails ONE coding-session transcript and streams
// the HTML artifacts it builds as versioned, sandbox-ready snapshots. Which strategy
// runs is decided by the session's SourceSpec adapter, not hardcoded here:
//
//   • detectArtifacts (Claude)  — transcript-driven: the transcript carries whole-file
//     writes, so we re-fold it on each append and emit new full-document versions.
//   • resolveArtifactPaths (Codex) — file-driven fallback: the transcript only names
//     the *.html files it touched (diffs, not whole writes), so we watch those real
//     files on disk and emit each version from the file itself.
//
// Both share the same SSE scaffold, mtime polling (transcripts are append-only; files
// are re-read on change), and the scrubText secret-safe boundary — the HTML that
// reaches the browser has home paths and secret tokens redacted while staying
// renderable. Raw handler (registered on expressApp), like insightsStream/gemRunStream.
import { readFileSync, statSync } from "node:fs";
import { basename } from "node:path";
import { scrubText } from "@agentgem/insight";
import { resolveTranscriptFile, sourceForFile } from "./watchSessions.js";

interface SseReq {
  query: Record<string, unknown>;
  on?(event: string, cb: () => void): void; // express req is an EventEmitter; we use "close"
}
interface SseRes {
  writeHead(status: number, headers: Record<string, string>): void;
  write(chunk: string): void;
  end(): void;
}

const MAX_HTML = 1_000_000;
const POLL_MS = 1000;
const HEARTBEAT_MS = 15000;

interface ArtifactMsg {
  index: number; path: string; name: string; tool: string;
  version: number; tsMs: number | null; truncated: boolean; html: string;
}

export function streamWatch(req: SseReq, res: SseRes): void {
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

  if (!resolved || !source) {
    send("failed", { message: "unknown or out-of-scope transcript file" });
    res.end();
    return;
  }

  let sent = 0; // global artifact-version counter (the `index` field)
  const emit = (m: Omit<ArtifactMsg, "index">) => { send("artifact", { index: sent++, ...m }); };
  const scrubHtml = (raw: string) => {
    const s = scrubText(raw);
    return { html: s.slice(0, MAX_HTML), truncated: s.length > MAX_HTML };
  };

  // Choose the strategy the adapter declares. detectArtifacts wins when present
  // (best fidelity); otherwise the file-driven fallback watches the named files.
  const tick = source.detectArtifacts
    ? transcriptDriven(resolved, source, emit, scrubHtml)
    : fileDriven(resolved, source, emit, scrubHtml);

  send("phase", { phase: "watching", file: resolved, mode: source.detectArtifacts ? "transcript" : "file" });
  tick(); // emit any backlog immediately

  const poll = setInterval(tick, POLL_MS);
  const beat = setInterval(() => { try { res.write(": ping\n\n"); } catch { /* closed */ } }, HEARTBEAT_MS);
  const cleanup = () => { clearInterval(poll); clearInterval(beat); try { res.end(); } catch { /* ended */ } };
  req.on?.("close", cleanup);
}

type Emit = (m: Omit<ArtifactMsg, "index">) => void;
type Scrub = (raw: string) => { html: string; truncated: boolean };
type Source = NonNullable<ReturnType<typeof sourceForFile>>;

// Transcript-driven: re-fold the whole (append-only) transcript when it grows and
// emit any reconstructed versions we haven't sent yet.
function transcriptDriven(file: string, source: Source, emit: Emit, scrub: Scrub): () => void {
  let count = 0, lastMtime = -1;
  return () => {
    let mtimeMs: number;
    try { mtimeMs = statSync(file).mtimeMs; } catch { return; }
    if (mtimeMs === lastMtime) return;
    lastMtime = mtimeMs;
    let text: string; try { text = readFileSync(file, "utf8"); } catch { return; }
    const versions = source.detectArtifacts!(text, file);
    for (; count < versions.length; count++) {
      const v = versions[count];
      const { html, truncated } = scrub(v.html);
      emit({ path: v.path, name: basename(v.path), tool: v.tool, version: v.version, tsMs: v.tsMs, truncated, html });
    }
  };
}

// File-driven: the transcript only names the touched *.html files. Re-scan the
// transcript for target paths when it grows, then watch each real file's mtime and
// emit its content (scrubbed) whenever it changes — versioning per path.
function fileDriven(file: string, source: Source, emit: Emit, scrub: Scrub): () => void {
  let transcriptMtime = -1;
  const targets: string[] = [];              // discovery order
  const fileMtime = new Map<string, number>();
  const version = new Map<string, number>();

  const refreshTargets = () => {
    let tMtime: number;
    try { tMtime = statSync(file).mtimeMs; } catch { return; }
    if (tMtime === transcriptMtime) return;
    transcriptMtime = tMtime;
    let text: string; try { text = readFileSync(file, "utf8"); } catch { return; }
    for (const p of source.resolveArtifactPaths!(text)) {
      if (!fileMtime.has(p)) { fileMtime.set(p, -1); version.set(p, 0); targets.push(p); }
    }
  };

  return () => {
    refreshTargets();
    for (const p of targets) {
      let mtimeMs: number;
      try { mtimeMs = statSync(p).mtimeMs; } catch { continue; } // not written yet / removed
      if (mtimeMs === fileMtime.get(p)) continue;
      fileMtime.set(p, mtimeMs);
      let raw: string; try { raw = readFileSync(p, "utf8"); } catch { continue; }
      const ver = (version.get(p) ?? 0) + 1;
      version.set(p, ver);
      const { html, truncated } = scrub(raw);
      emit({ path: p, name: basename(p), tool: "file", version: ver, tsMs: mtimeMs, truncated, html });
    }
  };
}
