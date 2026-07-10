// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
// packages/capture/src/transcriptIndex.ts
//
// A persistent, incremental index of session transcripts, backed by the on-disk node:sqlite we
// already ship (see docs/superpowers/specs/2026-07-01-transcript-index-design.md, and
// docs/superpowers/specs/2026-07-10-transcript-index-raw-rows-design.md).
//
// Phase 2 stores each transcript's RAW contribution — the tokens the file itself carried — so the
// stored rows are a pure function of the file's bytes. Resolution against the inventory happens at
// query time (see resolveUsage). Installing a skill or an MCP server therefore reparses NOTHING;
// previously it wiped the table and re-read the whole corpus (17.4s on a 3.1GB home).
//
// Hooks are the exception and the reason `hook_digest` survives: a hook has no token, it is matched
// by searching each record for that hook's own event/command from the inventory. So hook hits are
// resolved at parse time, and a hook change forces a reparse. `hook_digest` is a column on
// `transcript_file` (NOT a `meta` row) — staleness is decided per file, never by wiping the whole
// table, so raw rows always survive a hook-digest change and the prune loop below stays correct.
//
// The core is I/O-injected: `parseFile` comes from the caller, so the store is testable without
// touching real config/introspection.
//
// Diagram maintenance is part of the change: if a future edit adds another invalidation trigger,
// update the state machine above `doSync` in the same commit.
import { DatabaseSync } from "node:sqlite";
import { statSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { createLogger } from "@agentgem/base";
import { agentgemHome } from "@agentgem/model";
import type { FileUsage } from "@agentgem/insight";
import type { StoredRawRow, StoredHookRow } from "./resolveUsage.js";

const log = createLogger("capture");

// "2": raw_usage/hook_usage replace global_usage; inv_digest is gone; hook_digest moved from a
// meta row onto transcript_file. A bump drops derived rows and rebuilds from scratch.
const SCHEMA_VERSION = "2";

export interface TranscriptIndex {
  /**
   * Reconcile the index against `paths` and return the stored rows.
   * Reparses only new/changed files (by mtime+size) or files whose stored `hook_digest` no
   * longer matches `hookDigest` (hook hits are resolved at parse time, so a hook change forces
   * a reparse of just that file — raw rows are re-derived from the same parse, not wiped).
   * Prunes files gone from `paths`. The skill/mcp inventory is NOT an input — resolution
   * happens in resolveUsage, at query time.
   */
  syncUsage(
    paths: string[],
    hookDigest: string,
    parseFile: (path: string) => FileUsage,
  ): Promise<{ raw: StoredRawRow[]; hooks: StoredHookRow[] }>;
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
  db.exec(`CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT);`);

  // Schema-version guard: a bump means the on-disk layout may be incompatible (transcript_file
  // gained a hook_digest column; global_usage/raw_usage/hook_usage's shapes changed), so drop
  // everything derived and the orphaned v1 inventory digest. meta itself is stable, and
  // schema_version is (re)written unconditionally so the next open is a no-op. This IS the
  // migration — there is no hand-written data migration, derived rows just rebuild on sync.
  const ver = (db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get() as { value: string } | undefined)?.value;
  if (ver !== SCHEMA_VERSION) {
    db.exec("DROP TABLE IF EXISTS global_usage;");
    db.exec("DROP TABLE IF EXISTS transcript_file;");
    db.exec("DROP TABLE IF EXISTS raw_usage;");
    db.exec("DROP TABLE IF EXISTS hook_usage;");
    db.exec("DELETE FROM meta WHERE key = 'inv_digest';");
    db.prepare(
      "INSERT INTO meta(key, value) VALUES('schema_version', ?1) ON CONFLICT(key) DO UPDATE SET value = ?1",
    ).run(SCHEMA_VERSION);
  }

  db.exec(`
    CREATE TABLE IF NOT EXISTS transcript_file (
      path        TEXT PRIMARY KEY,
      mtime_ms    REAL NOT NULL,
      size        REAL NOT NULL,
      hook_digest TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS raw_usage (
      path        TEXT NOT NULL,
      kind        TEXT NOT NULL,
      token       TEXT NOT NULL,
      invocations INTEGER NOT NULL,
      PRIMARY KEY (path, kind, token)
    );
    -- no secondary index: the read is a full scan folded in JS (~hundreds of rows); an index
    -- would only slow the per-file upserts.
    CREATE TABLE IF NOT EXISTS hook_usage (
      path        TEXT NOT NULL,
      name        TEXT NOT NULL,
      invocations INTEGER NOT NULL,
      PRIMARY KEY (path, name)
    );
  `);

  // Single-flight: the SWR caller can fire overlapping syncs; serialize them so two passes
  // never interleave writes to the same rows.
  let chain: Promise<unknown> = Promise.resolve();
  let closed = false;

  return {
    syncUsage(paths, hookDigest, parseFile) {
      const run = chain.then(() => doSync(db, paths, hookDigest, parseFile));
      chain = run.catch(() => {}); // keep the chain alive past a failed sync
      return run;
    },
    async close() {
      if (!closed) { db.close(); closed = true; }
    },
  };
}

//                          per file, in doSync:
//   ┌────────────────────────────────────────────────────────────────────┐
//   │  stat(path) fails ────────────────────────────► skip (vanished)     │
//   │  row.mtime==st.mtime && row.size==st.size                           │
//   │     && row.hook_digest == current  ───────────► SKIP (up to date)   │
//   │  else ─────────────► reparse: scanFileUsage(path, hooks)            │
//   │      throws OR returns failed:true ───────────► leave rows/row as-is,│
//   │                                                  seen.add, continue  │
//   │      else ─────────► DELETE raw_usage/hook_usage WHERE path          │
//   │                      re-INSERT rows                                  │
//   │                      UPSERT transcript_file(path, mtime, size,       │
//   │                                             hook_digest=current)     │
//   └────────────────────────────────────────────────────────────────────┘
//   prune: for path in transcript_file NOT in `seen`: DELETE all three   ← now always correct
async function doSync(
  db: DatabaseSync,
  paths: string[],
  hookDigest: string,
  parseFile: (path: string) => FileUsage,
): Promise<{ raw: StoredRawRow[]; hooks: StoredHookRow[] }> {
  // 1. Load current file identities, including each file's hook_digest as of its last
  //    successful parse. There is no meta-level guard/wipe here (A1): staleness is decided
  //    per file below, so transcript_file is never wiped wholesale and this map is always a
  //    complete, trustworthy record of every path we've ever successfully recorded.
  const existing = new Map<string, { mtime: number; size: number; hookDigest: string }>();
  for (const r of db.prepare("SELECT path, mtime_ms, size, hook_digest FROM transcript_file").all() as
    { path: string; mtime_ms: number; size: number; hook_digest: string }[]) {
    existing.set(r.path, { mtime: Number(r.mtime_ms), size: Number(r.size), hookDigest: r.hook_digest });
  }

  const seen = new Set<string>();
  db.exec("BEGIN");
  try {
    // 2. Reparse only new/changed/hook-digest-stale files.
    for (const path of paths) {
      let st: ReturnType<typeof statSync>;
      try { st = statSync(path); } catch { continue; } // vanished between listing and stat
      const prev = existing.get(path);
      if (prev && prev.mtime === st.mtimeMs && prev.size === st.size && prev.hookDigest === hookDigest) {
        seen.add(path);
        continue; // up to date
      }

      let u: FileUsage;
      try {
        u = parseFile(path);
      } catch (e) {
        // An uncaught exception from parseFile (a latent bug, a pathological transcript, a
        // future implementation that throws instead of returning `failed: true`) must converge
        // on the exact same handling as the typed read-failure path below: it is not this
        // sync's job to let one bad file roll back the whole transaction and reject the whole
        // corpus. Leave transcript_file un-upserted (retried next sync), leave prior rows
        // untouched, and still mark it `seen` so it isn't pruned out from under a file that's
        // still genuinely on disk and was previously recorded successfully.
        log.warn("parseFile threw for transcript, will retry next sync: %s: %s", path, e);
        seen.add(path);
        continue;
      }
      if (u.failed) {
        // A3: a read failure is not an empty parse. Leave transcript_file un-upserted (so this
        // path stays stale and is retried next sync) and leave any prior rows untouched — but
        // still mark it `seen` so a merely-flaky read doesn't get pruned out from under a file
        // that's still genuinely on disk and was previously recorded successfully.
        log.warn("failed to read transcript, will retry next sync: %s", path);
        seen.add(path);
        continue;
      }
      seen.add(path);
      db.prepare("DELETE FROM raw_usage WHERE path = ?1").run(path);
      db.prepare("DELETE FROM hook_usage WHERE path = ?1").run(path);
      for (const r of u.raw) {
        db.prepare(
          `INSERT INTO raw_usage(path, kind, token, invocations) VALUES(?1, ?2, ?3, ?4)
           ON CONFLICT(path, kind, token) DO UPDATE SET invocations = ?4`,
        ).run(path, r.kind, r.token, r.invocations);
      }
      for (const h of u.hooks) {
        db.prepare(
          `INSERT INTO hook_usage(path, name, invocations) VALUES(?1, ?2, ?3)
           ON CONFLICT(path, name) DO UPDATE SET invocations = ?3`,
        ).run(path, h.name, h.invocations);
      }
      db.prepare(
        `INSERT INTO transcript_file(path, mtime_ms, size, hook_digest) VALUES(?1, ?2, ?3, ?4)
         ON CONFLICT(path) DO UPDATE SET mtime_ms = ?2, size = ?3, hook_digest = ?4`,
      ).run(path, st.mtimeMs, st.size, hookDigest);
    }
    // 3. Prune files that are gone from `paths` (or never made it past a failed read this sync
    //    — those are `seen` above and thus protected). This is always correct now: transcript_file
    //    is never wiped wholesale, so `existing` reflects every path ever successfully recorded.
    for (const path of existing.keys()) {
      if (seen.has(path)) continue;
      db.prepare("DELETE FROM raw_usage WHERE path = ?1").run(path);
      db.prepare("DELETE FROM hook_usage WHERE path = ?1").run(path);
      db.prepare("DELETE FROM transcript_file WHERE path = ?1").run(path);
    }
    db.exec("COMMIT");
  } catch (e) {
    try { db.exec("ROLLBACK"); } catch { /* keep the original error */ }
    throw e;
  }

  // 4. Hand the stored rows to the caller; resolution + folding happens in resolveUsage.
  //    lastUsedMs (A2) is not stored on the row — it's joined from transcript_file.mtime_ms.
  const raw = (db.prepare(
    `SELECT r.path, r.kind, r.token, r.invocations, f.mtime_ms AS last_used_ms
     FROM raw_usage r JOIN transcript_file f USING(path)
     ORDER BY r.path, r.kind, r.token`,
  ).all() as { path: string; kind: string; token: string; invocations: number; last_used_ms: number }[])
    .map((r) => ({ path: r.path, kind: r.kind as StoredRawRow["kind"], token: r.token, invocations: Number(r.invocations), lastUsedMs: Number(r.last_used_ms) }));
  const hooks = (db.prepare(
    `SELECT h.path, h.name, h.invocations, f.mtime_ms AS last_used_ms
     FROM hook_usage h JOIN transcript_file f USING(path)
     ORDER BY h.path, h.name`,
  ).all() as { path: string; name: string; invocations: number; last_used_ms: number }[])
    .map((h) => ({ path: h.path, name: h.name, invocations: Number(h.invocations), lastUsedMs: Number(h.last_used_ms) }));
  return { raw, hooks };
}
