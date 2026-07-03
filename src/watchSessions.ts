// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
// src/watchSessions.ts
//
// Active-session discovery for the Watch tab. Walks the local Claude + Codex
// transcript stores, keeps the recently-touched ones, and returns light metadata
// (never message text) so the console can offer a live picker of "sessions running
// right now". Also exports resolveTranscriptFile: the security gate that pins the
// SSE stream's ?file= to a path *inside* a known transcript root, so the endpoint
// can never be aimed at an arbitrary file on disk.
import { statSync } from "node:fs";
import { readFileSync } from "node:fs";
import { join, basename, resolve, sep } from "node:path";
import { resolveDirs } from "@agentgem/model";
import { listFiles, parseClaudeTranscript, parseCodexTranscript } from "@agentgem/insight";

export interface WatchSession {
  /** Canonical session id (transcript filename UUID for Claude). */
  id: string;
  /** Absolute transcript path — the handle the stream endpoint re-opens. */
  file: string;
  agent: "claude" | "codex";
  project: string | null;
  model: string | null;
  msgs: number;
  startMs: number;
  endMs: number;
  /** How long ago the transcript file was last written (ms). */
  ageMs: number;
}

export interface WatchRoots {
  claudeProjects: string;
  codexSessions: string;
}

/** The two transcript roots we watch, derived from the resolved agent home. */
export function watchRoots(baseDir?: string): WatchRoots {
  const dirs = resolveDirs(baseDir);
  return {
    claudeProjects: join(dirs.claudeDir, "projects"),
    codexSessions: join(dirs.codexDir, "sessions"),
  };
}

interface CandidateFile { file: string; mtimeMs: number; agent: "claude" | "codex" }

// mtime-sort candidate transcripts newest-first, so we only parse the freshest
// slice (parsing every historical transcript on each poll would be wasteful).
function candidates(roots: WatchRoots): CandidateFile[] {
  const out: CandidateFile[] = [];
  const push = (file: string, agent: "claude" | "codex") => {
    try { out.push({ file, mtimeMs: statSync(file).mtimeMs, agent }); } catch { /* vanished */ }
  };
  for (const f of listFiles(roots.claudeProjects, ".jsonl")) push(f, "claude");
  for (const f of listFiles(roots.codexSessions, ".jsonl")) {
    if (basename(f).startsWith("rollout-")) push(f, "codex");
  }
  return out.sort((a, b) => b.mtimeMs - a.mtimeMs);
}

export interface ListOpts {
  baseDir?: string;
  /** Wall clock, injectable for tests. */
  now?: number;
  /** Only sessions written within this window count as "active". Default 6h. */
  withinMs?: number;
  /** Cap on parsed/returned sessions. Default 30. */
  limit?: number;
}

/**
 * List recently-active transcripts, newest first. Reads metadata only (via the
 * existing metadata-only parsers), degrading past malformed files rather than
 * throwing — a missing store yields an empty list.
 */
export function listActiveSessions(opts: ListOpts = {}): WatchSession[] {
  const now = opts.now ?? Date.now();
  const withinMs = opts.withinMs ?? 6 * 60 * 60 * 1000;
  const limit = opts.limit ?? 30;
  const roots = watchRoots(opts.baseDir);

  const out: WatchSession[] = [];
  for (const c of candidates(roots)) {
    if (now - c.mtimeMs > withinMs) break; // sorted newest-first → the rest are older
    if (out.length >= limit) break;
    let text: string; try { text = readFileSync(c.file, "utf8"); } catch { continue; }
    const stat = c.agent === "claude" ? parseClaudeTranscript(text, c.file) : parseCodexTranscript(text, c.file);
    if (!stat) continue;
    out.push({
      id: stat.sessionId, file: c.file, agent: c.agent,
      project: stat.project, model: stat.model, msgs: stat.msgs,
      startMs: stat.startMs, endMs: stat.endMs, ageMs: Math.max(0, now - c.mtimeMs),
    });
  }
  return out;
}

// A path is inside a root only if, once resolved, it is the root or sits beneath it
// (guarding against `..` traversal and prefix-sibling tricks like `/a/projects-evil`).
function isInside(root: string, file: string): boolean {
  const r = resolve(root);
  const f = resolve(file);
  return f === r || f.startsWith(r + sep);
}

/**
 * Validate a client-supplied transcript path: it must end in .jsonl and live under
 * one of the watch roots. Returns the resolved absolute path, or null to reject.
 * This is the ONLY sanctioned way the stream endpoint turns ?file= into a read.
 */
export function resolveTranscriptFile(file: string, baseDir?: string): string | null {
  if (!file || !file.endsWith(".jsonl")) return null;
  const roots = watchRoots(baseDir);
  if (!isInside(roots.claudeProjects, file) && !isInside(roots.codexSessions, file)) return null;
  return resolve(file);
}

/** The agent a validated transcript path belongs to (claude unless under codex). */
export function agentForFile(file: string, baseDir?: string): "claude" | "codex" {
  return isInside(watchRoots(baseDir).codexSessions, file) ? "codex" : "claude";
}
