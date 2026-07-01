// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
// packages/capture/src/transcriptIndex.ts
//
// A persistent, incremental index of session transcripts, backed by the on-disk
// PGlite we already ship (see docs/superpowers/specs/2026-07-01-transcript-index-design.md).
//
// Phase 1 stores each transcript's RESOLVED global-usage contribution. Because
// scanWorkflow keys an artifact's `sessionsUsedIn` by the transcript PATH, a single
// file contributes sessionsUsedIn ∈ {0,1}, so the global result is a pure fold over
// files (SUM invocations, SUM sessions, MAX lastUsedMs) — behavior-identical to a
// full re-scan, but only changed files are reparsed.
//
// The core is I/O-injected: `parseFile` and `invDigest` come from the caller, so the
// store can be tested without touching real config/introspection.
import { PGlite } from "@electric-sql/pglite";
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

/** ~/.agentgem/index — the on-disk PGlite datadir for the local transcript index. */
export function defaultIndexDir(): string {
  return join(agentgemHome(), ".agentgem", "index");
}

/**
 * Open (creating if needed) the transcript index. `dataDir` defaults to the on-disk
 * location; pass `"memory://"` for an ephemeral instance (tests). Never opened for a
 * hosted Postgres — this is purely local machine state.
 */
export async function openTranscriptIndex(dataDir?: string): Promise<TranscriptIndex> {
  const dir = dataDir ?? defaultIndexDir();
  // Filesystem datadirs need their parent to exist; scheme URLs (memory://, idb://) don't.
  if (!dir.includes("://")) mkdirSync(dirname(dir), { recursive: true });
  const db = new PGlite(dir);
  await db.exec(`
    CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT);
    CREATE TABLE IF NOT EXISTS transcript_file (
      path      TEXT PRIMARY KEY,
      mtime_ms  DOUBLE PRECISION NOT NULL,
      size      DOUBLE PRECISION NOT NULL
    );
    CREATE TABLE IF NOT EXISTS global_usage (
      path             TEXT NOT NULL,
      type             TEXT NOT NULL,
      name             TEXT NOT NULL,
      invocations      INTEGER NOT NULL,
      sessions_used_in INTEGER NOT NULL,
      last_used_ms     DOUBLE PRECISION,
      PRIMARY KEY (path, type, name)
    );
    CREATE INDEX IF NOT EXISTS global_usage_agg ON global_usage (type, name);
  `);
  // Schema-version guard: a bump means the on-disk layout may be incompatible, so
  // drop the derived rows (they rebuild on next sync). meta itself is stable.
  const ver = (await db.query<{ value: string }>("SELECT value FROM meta WHERE key = 'schema_version'")).rows[0]?.value;
  if (ver !== SCHEMA_VERSION) {
    await db.exec("DELETE FROM global_usage; DELETE FROM transcript_file;");
    await db.query(
      "INSERT INTO meta(key, value) VALUES('schema_version', $1) ON CONFLICT(key) DO UPDATE SET value = $1",
      [SCHEMA_VERSION],
    );
  }

  // Single-flight: the SWR caller can fire overlapping syncs; serialize them so two
  // passes never interleave writes to the same rows.
  let chain: Promise<unknown> = Promise.resolve();

  return {
    syncGlobalUsage(paths, invDigest, parseFile) {
      const run = chain.then(() => doSync(db, paths, invDigest, parseFile));
      chain = run.catch(() => {}); // keep the chain alive past a failed sync
      return run;
    },
    async close() {
      await db.close();
    },
  };
}

async function doSync(
  db: PGlite,
  paths: string[],
  invDigest: string,
  parseFile: (path: string) => UsageRow[],
): Promise<GlobalUsageResult> {
  // 1. Inventory-digest guard. Stored rows are RESOLVED against the global inventory;
  //    if that changed, resolution changed, so wipe and rebuild.
  const stored = (await db.query<{ value: string }>("SELECT value FROM meta WHERE key = 'inv_digest'")).rows[0]?.value;
  if (stored !== invDigest) {
    await db.exec("DELETE FROM global_usage; DELETE FROM transcript_file;");
    await db.query(
      "INSERT INTO meta(key, value) VALUES('inv_digest', $1) ON CONFLICT(key) DO UPDATE SET value = $1",
      [invDigest],
    );
  }

  // 2. Load current file identities.
  const existing = new Map<string, { mtime: number; size: number }>();
  for (const r of (await db.query<{ path: string; mtime_ms: number; size: number }>(
    "SELECT path, mtime_ms, size FROM transcript_file",
  )).rows) {
    existing.set(r.path, { mtime: Number(r.mtime_ms), size: Number(r.size) });
  }

  const seen = new Set<string>();
  await db.query("BEGIN");
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
      await db.query("DELETE FROM global_usage WHERE path = $1", [path]);
      for (const c of contrib) {
        await db.query(
          `INSERT INTO global_usage(path, type, name, invocations, sessions_used_in, last_used_ms)
           VALUES($1, $2, $3, $4, $5, $6)
           ON CONFLICT(path, type, name) DO UPDATE SET invocations = $4, sessions_used_in = $5, last_used_ms = $6`,
          [path, c.type, c.name, c.invocations, c.sessionsUsedIn, c.lastUsedMs],
        );
      }
      await db.query(
        `INSERT INTO transcript_file(path, mtime_ms, size) VALUES($1, $2, $3)
         ON CONFLICT(path) DO UPDATE SET mtime_ms = $2, size = $3`,
        [path, st.mtimeMs, st.size],
      );
    }
    // 4. Prune files that are gone from disk.
    for (const path of existing.keys()) {
      if (seen.has(path)) continue;
      await db.query("DELETE FROM global_usage WHERE path = $1", [path]);
      await db.query("DELETE FROM transcript_file WHERE path = $1", [path]);
    }
    await db.query("COMMIT");
  } catch (e) {
    await db.query("ROLLBACK").catch(() => {});
    throw e;
  }

  // 5. Fold per-file contributions into the global result.
  const agg = (await db.query<{ type: string; name: string; invocations: number; sessions_used_in: number; last_used_ms: number | null }>(
    `SELECT type, name,
            SUM(invocations)::int      AS invocations,
            SUM(sessions_used_in)::int AS sessions_used_in,
            MAX(last_used_ms)          AS last_used_ms
     FROM global_usage
     GROUP BY type, name
     ORDER BY invocations DESC, name ASC`,
  )).rows;
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
