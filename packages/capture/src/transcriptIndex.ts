// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
// packages/capture/src/transcriptIndex.ts
//
// A persistent, incremental index of session transcripts, backed by the on-disk
// node:sqlite we already ship (see docs/superpowers/specs/2026-07-01-transcript-index-design.md).
//
// Phase 1 stores each transcript's RESOLVED global-usage contribution. Because
// scanWorkflow keys an artifact's `sessionsUsedIn` by the transcript PATH, a single
// file contributes sessionsUsedIn ∈ {0,1}, so the global result is a pure fold over
// files (SUM invocations, SUM sessions, MAX lastUsedMs) — behavior-identical to a
// full re-scan, but only changed files are reparsed.
//
// The core is I/O-injected: `parseFile` and `invDigest` come from the caller, so the
// store can be tested without touching real config/introspection.
import { DatabaseSync } from "node:sqlite";
import { statSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { agentgemHome } from "@agentgem/model";
import type { GlobalUsageResult } from "./globalUsage.js";

const SCHEMA_VERSION = "1";

/** One transcript's resolved contribution to a global artifact (sessionsUsedIn is 0 or 1 per file). */
export interface UsageRow {
  type: string;
  name: string;
  invocations: number;
  sessionsUsedIn: number;
  lastUsedMs: number | null;
}

export interface TranscriptIndex {
  /**
   * Reconcile the index against `paths` and return the folded global usage.
   * Reparses only new/changed files (by mtime+size); prunes vanished files; a
   * changed `invDigest` (global inventory changed → resolution changed) rebuilds.
   */
  syncGlobalUsage(
    paths: string[],
    invDigest: string,
    parseFile: (path: string) => UsageRow[],
  ): Promise<GlobalUsageResult>;
  close(): Promise<void>;
}

/** ~/.agentgem/transcript-index.db — the on-disk node:sqlite file for the local transcript index. */
export function defaultIndexDir(): string {
  return join(agentgemHome(), ".agentgem", "transcript-index.db");
}

/**
 * Open (creating if needed) the transcript index. `dataDir` defaults to the on-disk
 * location; pass `"memory://"` for an ephemeral instance (tests). Never opened for a
 * hosted Postgres — this is purely local machine state.
 */
export async function openTranscriptIndex(dataDir?: string): Promise<TranscriptIndex> {
  const dir = dataDir ?? defaultIndexDir();
  // The in-memory sentinel translates to node:sqlite's own ":memory:" spelling.
  const file = dir === "memory://" ? ":memory:" : dir;
  if (file !== ":memory:") mkdirSync(dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec(`
    CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT);
    CREATE TABLE IF NOT EXISTS transcript_file (
      path      TEXT PRIMARY KEY,
      mtime_ms  REAL NOT NULL,
      size      REAL NOT NULL
    );
    CREATE TABLE IF NOT EXISTS global_usage (
      path             TEXT NOT NULL,
      type             TEXT NOT NULL,
      name             TEXT NOT NULL,
      invocations      INTEGER NOT NULL,
      sessions_used_in INTEGER NOT NULL,
      last_used_ms     REAL,
      PRIMARY KEY (path, type, name)
    );
    CREATE INDEX IF NOT EXISTS global_usage_agg ON global_usage (type, name);
  `);
  // Schema-version guard: a bump means the on-disk layout may be incompatible, so
  // drop the derived rows (they rebuild on next sync). meta itself is stable.
  const ver = (db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get() as { value: string } | undefined)?.value;
  if (ver !== SCHEMA_VERSION) {
    db.exec("DELETE FROM global_usage; DELETE FROM transcript_file;");
    db.prepare(
      "INSERT INTO meta(key, value) VALUES('schema_version', ?1) ON CONFLICT(key) DO UPDATE SET value = ?1",
    ).run(SCHEMA_VERSION);
  }

  // Single-flight: the SWR caller can fire overlapping syncs; serialize them so two
  // passes never interleave writes to the same rows.
  let chain: Promise<unknown> = Promise.resolve();
  let closed = false;

  return {
    syncGlobalUsage(paths, invDigest, parseFile) {
      const run = chain.then(() => doSync(db, paths, invDigest, parseFile));
      chain = run.catch(() => {}); // keep the chain alive past a failed sync
      return run;
    },
    async close() {
      if (!closed) { db.close(); closed = true; }
    },
  };
}

async function doSync(
  db: DatabaseSync,
  paths: string[],
  invDigest: string,
  parseFile: (path: string) => UsageRow[],
): Promise<GlobalUsageResult> {
  // 1. Inventory-digest guard. Stored rows are RESOLVED against the global inventory;
  //    if that changed, resolution changed, so wipe and rebuild.
  const stored = (db.prepare("SELECT value FROM meta WHERE key = 'inv_digest'").get() as { value: string } | undefined)?.value;
  if (stored !== invDigest) {
    db.exec("DELETE FROM global_usage; DELETE FROM transcript_file;");
    db.prepare(
      "INSERT INTO meta(key, value) VALUES('inv_digest', ?1) ON CONFLICT(key) DO UPDATE SET value = ?1",
    ).run(invDigest);
  }

  // 2. Load current file identities.
  const existing = new Map<string, { mtime: number; size: number }>();
  for (const r of db.prepare("SELECT path, mtime_ms, size FROM transcript_file").all() as { path: string; mtime_ms: number; size: number }[]) {
    existing.set(r.path, { mtime: Number(r.mtime_ms), size: Number(r.size) });
  }

  const seen = new Set<string>();
  db.exec("BEGIN");
  try {
    // 3. Reparse only new/changed files.
    for (const path of paths) {
      let st: ReturnType<typeof statSync>;
      try { st = statSync(path); } catch { continue; } // vanished between listing and stat
      seen.add(path);
      const prev = existing.get(path);
      if (prev && prev.mtime === st.mtimeMs && prev.size === st.size) continue; // unchanged

      let contrib: UsageRow[];
      try { contrib = parseFile(path); } catch { contrib = []; } // a corrupt file contributes nothing
      db.prepare("DELETE FROM global_usage WHERE path = ?1").run(path);
      for (const c of contrib) {
        db.prepare(
          `INSERT INTO global_usage(path, type, name, invocations, sessions_used_in, last_used_ms)
           VALUES(?1, ?2, ?3, ?4, ?5, ?6)
           ON CONFLICT(path, type, name) DO UPDATE SET invocations = ?4, sessions_used_in = ?5, last_used_ms = ?6`,
        ).run(path, c.type, c.name, c.invocations, c.sessionsUsedIn, c.lastUsedMs);
      }
      db.prepare(
        `INSERT INTO transcript_file(path, mtime_ms, size) VALUES(?1, ?2, ?3)
         ON CONFLICT(path) DO UPDATE SET mtime_ms = ?2, size = ?3`,
      ).run(path, st.mtimeMs, st.size);
    }
    // 4. Prune files that are gone from disk.
    for (const path of existing.keys()) {
      if (seen.has(path)) continue;
      db.prepare("DELETE FROM global_usage WHERE path = ?1").run(path);
      db.prepare("DELETE FROM transcript_file WHERE path = ?1").run(path);
    }
    db.exec("COMMIT");
  } catch (e) {
    try { db.exec("ROLLBACK"); } catch { /* keep the original error */ }
    throw e;
  }

  // 5. Fold per-file contributions into the global result.
  const agg = db.prepare(
    `SELECT type, name,
            SUM(invocations)      AS invocations,
            SUM(sessions_used_in) AS sessions_used_in,
            MAX(last_used_ms)     AS last_used_ms
     FROM global_usage
     GROUP BY type, name
     ORDER BY invocations DESC, name ASC`,
  ).all() as { type: string; name: string; invocations: number; sessions_used_in: number; last_used_ms: number | null }[];
  return {
    artifacts: agg.map((r) => ({
      type: r.type,
      name: r.name,
      root: null as null,
      invocations: Number(r.invocations),
      sessionsUsedIn: Number(r.sessions_used_in),
      lastUsedMs: r.last_used_ms == null ? null : Number(r.last_used_ms),
    })),
  };
}
