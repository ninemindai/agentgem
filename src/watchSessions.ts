// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
// src/watchSessions.ts
//
// Active-session discovery for the Watch tab, driven entirely by the SourceSpec
// registry: every agent that declares the watch capabilities (watchFiles +
// parseMeta + a detector) is enumerated here, so adding a coding agent to the Watch
// feed is a change in @agentgem/insight/sources.ts, not here. We read metadata only
// (never message text). resolveTranscriptFile is the security gate that pins the
// SSE stream's ?file= to one of the registered watch roots, so the endpoint can
// never be aimed at an arbitrary file on disk.
import { statSync, readFileSync } from "node:fs";
import { basename, resolve, sep } from "node:path";
import { watchableSources, type SourceSpec, type AgentId } from "@agentgem/insight";

export interface WatchSession {
  /** Canonical session id (transcript filename UUID for Claude; session_meta for Codex). */
  id: string;
  /** Absolute transcript path — the handle the stream endpoint re-opens. */
  file: string;
  agent: AgentId;
  project: string | null;
  model: string | null;
  msgs: number;
  startMs: number;
  endMs: number;
  /** How long ago the transcript file was last written (ms). */
  ageMs: number;
}

// SourceEnv for the local machine: baseDir feeds every source's root resolver
// (claude derives .claude/projects, codex derives .codex/sessions from it, etc).
const envFor = (baseDir?: string) => ({ baseDir });

interface Candidate { file: string; mtimeMs: number; spec: SourceSpec }

// Enumerate watchable transcript files across all registered sources, newest first,
// so only the freshest slice is parsed.
function candidates(baseDir?: string): Candidate[] {
  const out: Candidate[] = [];
  for (const spec of watchableSources()) {
    let files: string[];
    try { files = spec.watchFiles!(spec.roots(envFor(baseDir))); } catch { continue; }
    for (const file of files) {
      try { out.push({ file, mtimeMs: statSync(file).mtimeMs, spec }); } catch { /* vanished */ }
    }
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
 * List recently-active transcripts across all watchable agents, newest first.
 * Reads metadata only, degrading past malformed files rather than throwing.
 */
export function listActiveSessions(opts: ListOpts = {}): WatchSession[] {
  const now = opts.now ?? Date.now();
  const withinMs = opts.withinMs ?? 6 * 60 * 60 * 1000;
  const limit = opts.limit ?? 30;

  const out: WatchSession[] = [];
  for (const c of candidates(opts.baseDir)) {
    if (now - c.mtimeMs > withinMs) break; // sorted newest-first → the rest are older
    if (out.length >= limit) break;
    let text: string; try { text = readFileSync(c.file, "utf8"); } catch { continue; }
    const stat = c.spec.parseMeta!(text, c.file);
    if (!stat) continue;
    out.push({
      id: stat.sessionId, file: c.file, agent: c.spec.id,
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

/** The registered watch source that owns `file`, or null if it's outside all roots. */
export function sourceForFile(file: string, baseDir?: string): SourceSpec | null {
  const f = resolve(file);
  for (const spec of watchableSources()) {
    if (spec.roots(envFor(baseDir)).some((r) => isInside(r, f))) return spec;
  }
  return null;
}

/**
 * Validate a client-supplied transcript path: it must end in .jsonl and live under
 * one of the registered watch roots. Returns the resolved absolute path, or null.
 * This is the ONLY sanctioned way the stream endpoint turns ?file= into a read.
 */
export function resolveTranscriptFile(file: string, baseDir?: string): string | null {
  if (!file || !file.endsWith(".jsonl")) return null;
  return sourceForFile(file, baseDir) ? resolve(file) : null;
}

// Kept for tests/back-compat: which agent a validated path belongs to.
export function agentForFile(file: string, baseDir?: string): AgentId | null {
  return sourceForFile(file, baseDir)?.id ?? null;
}

// Convenience for tests: the concrete roots basename lookups. (Not a security seam;
// resolveTranscriptFile is.)
export function watchRootBasenames(): string[] {
  return watchableSources().flatMap((s) => s.roots(envFor()).map((r) => basename(r)));
}
