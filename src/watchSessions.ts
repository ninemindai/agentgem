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

type ParsedMeta = NonNullable<ReturnType<NonNullable<SourceSpec["parseMeta"]>>>;
type MetaCache = Map<string, { mtimeMs: number; stat: ParsedMeta }>;

function listSessionsCore(opts: ListOpts, cache?: MetaCache): WatchSession[] {
  const now = opts.now ?? Date.now();
  const withinMs = opts.withinMs ?? 6 * 60 * 60 * 1000;
  const limit = opts.limit ?? 30;

  const out: WatchSession[] = [];
  const seen = new Set<string>();
  for (const c of candidates(opts.baseDir)) {
    if (now - c.mtimeMs > withinMs) break; // sorted newest-first → the rest are older
    if (out.length >= limit) break;
    let stat: ParsedMeta;
    const hit = cache?.get(c.file);
    if (hit && hit.mtimeMs === c.mtimeMs) {
      stat = hit.stat;
    } else {
      let text: string; try { text = readFileSync(c.file, "utf8"); } catch { continue; }
      const parsed = c.spec.parseMeta!(text, c.file);
      if (!parsed) continue;
      stat = parsed;
      cache?.set(c.file, { mtimeMs: c.mtimeMs, stat });
    }
    seen.add(c.file);
    out.push({
      id: stat.sessionId, file: c.file, agent: c.spec.id,
      project: stat.project, model: stat.model, msgs: stat.msgs,
      startMs: stat.startMs, endMs: stat.endMs, ageMs: Math.max(0, now - c.mtimeMs),
    });
  }
  if (cache) for (const key of cache.keys()) if (!seen.has(key)) cache.delete(key); // aged-out sessions
  return out;
}

/**
 * List recently-active transcripts across all watchable agents, newest first.
 * Reads metadata only, degrading past malformed files rather than throwing.
 * Uncached — every call re-reads and re-parses each candidate. Fine for
 * on-demand callers; anything polling should hold a createSessionLister().
 */
export function listActiveSessions(opts: ListOpts = {}): WatchSession[] {
  return listSessionsCore(opts);
}

/**
 * Per-instance cached lister (cache lives in the closure — no module-scoped
 * state). Meta is cached per file keyed by mtime, so steady-state polls cost a
 * stat per candidate instead of a full read + parse; `ageMs` is always derived
 * from the fresh stat. Entries for sessions that age out of the window are
 * swept so the cache stays bounded.
 */
export function createSessionLister(): (opts?: ListOpts) => WatchSession[] {
  const cache: MetaCache = new Map();
  return (opts: ListOpts = {}) => listSessionsCore(opts, cache);
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

// The file extension each storage kind exposes as a watchable transcript. The
// owning source's storage decides which suffix is allowed, so a json-storage agent
// (Cline, Continue) is accepted while a sqlite DB (Cursor) is not — its sessions
// aren't file-per-session and need a different, DB-polling watch mode.
const SUFFIX_BY_STORAGE: Record<string, string> = { jsonl: ".jsonl", json: ".json" };

/**
 * Validate a client-supplied transcript path: it must live under one of the
 * registered watch roots AND carry the file suffix its owning source's storage
 * exposes. Returns the resolved absolute path, or null. This is the ONLY sanctioned
 * way the stream endpoint turns ?file= into a read.
 */
export function resolveTranscriptFile(file: string, baseDir?: string): string | null {
  if (!file) return null;
  const src = sourceForFile(file, baseDir);
  if (!src) return null;
  const suffix = SUFFIX_BY_STORAGE[src.traits.storage];
  if (!suffix || !file.endsWith(suffix)) return null;
  return resolve(file);
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
