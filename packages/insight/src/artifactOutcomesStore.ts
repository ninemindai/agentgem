// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
//
// The proven-use store: its OWN local sqlite (~/.agentgem/artifact-outcomes.db),
// deliberately SEPARATE from transcript-index.db. That store holds byte-derived
// data and DROPS every derived table on a schema bump; these rows are expensive,
// non-deterministic LLM judgments that must never be dropped that way. Opposite
// lifecycles → separate stores. Append/upsert-only; own schema version.
//
// Two read paths:
//   - outcomeForSessions(): each session's OWN outcome. Recall's v1 signal (D7).
//   - scoreForSessions(): max over a session's artifacts of the artifact's
//     cross-session Wilson score. FOUNDATION for the future recommender
//     consumer — unit-tested here, NOT on recall's path in v1.
import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { agentgemHome } from "@agentgem/model";
import { wilsonLowerBound, outcomeCredit, type Outcome } from "./outcomeScore.js";
import type { ArtifactOutcomeRow } from "./artifactOutcomes.js";

const SCHEMA_VERSION = "1";

// Every schema version this build can read. A bump means appending the new version here AND
// writing the DDL that gets an existing file from the old shape to the new one (see
// addColumnIfMissing) — an unlisted version is refused rather than silently opened.
const KNOWN_SCHEMA_VERSIONS: ReadonlySet<string> = new Set([SCHEMA_VERSION]);

/**
 * Add a column to an existing table if it isn't already there. SQLite has no
 * `ADD COLUMN IF NOT EXISTS`, so this checks `pragma table_info` first. Returns true when it
 * added the column, false when it was already present (so it is safe to call on every open).
 *
 * This is the paired-ALTER discipline the enterprise aggregator learned the hard way:
 * `CREATE TABLE IF NOT EXISTS` is TABLE-level, so a column added inside the CREATE never
 * reaches a database that already had the table. Fresh DBs get it and stay green, which is
 * exactly why the drift is invisible in tests and only shows on a long-lived file.
 */
export function addColumnIfMissing(
  db: { prepare(sql: string): { all(): unknown[]; run(): unknown }; exec(sql: string): unknown },
  table: string,
  column: string,
  decl: string,
): boolean {
  // SQLite cannot bind IDENTIFIERS, so these three have to be interpolated. Today every caller
  // passes a literal from this file, but the helper is exported — validate so it is safe by
  // construction rather than by convention.
  if (!IDENT_RE.test(table)) throw new Error(`unsafe table identifier '${table}'`);
  if (!IDENT_RE.test(column)) throw new Error(`unsafe column identifier '${column}'`);
  if (!DECL_RE.test(decl)) throw new Error(`unsafe column declaration '${decl}'`);
  const cols = db.prepare(`pragma table_info(${table})`).all() as { name: string }[];
  if (cols.some((c) => c.name === column)) return false;
  db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${decl}`);
  return true;
}

const IDENT_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
// A type plus optional simple modifiers — "REAL", "TEXT NOT NULL", "INTEGER DEFAULT 0".
const DECL_RE = /^[A-Za-z][A-Za-z0-9_ ]*$/;

export function defaultArtifactOutcomesDbPath(): string {
  return join(agentgemHome(), ".agentgem", "artifact-outcomes.db");
}

export interface ArtifactOutcomesStore {
  /** Replace all rows for one session with `rows` (idempotent re-scan). */
  upsertSession(sessionId: string, rows: ArtifactOutcomeRow[]): void;
  /** Each candidate session's OWN judged outcome. Recall's v1 boost signal.
   *  Sessions with no rows are omitted. */
  outcomeForSessions(sessionIds: string[]): Map<string, Outcome>;
  /** For each candidate session, the max over its artifacts of that artifact's
   *  cross-session Wilson score. Foundation for the future recommender
   *  consumer; sessions with no rows are omitted. */
  scoreForSessions(sessionIds: string[]): Map<string, number>;
  close(): void;
}

function placeholders(xs: unknown[]): string {
  return xs.map((_, i) => `?${i + 1}`).join(",");
}

export function openArtifactOutcomesStore(dataDir?: string): ArtifactOutcomesStore {
  const dir = dataDir ?? defaultArtifactOutcomesDbPath();
  const file = dir === "memory://" ? ":memory:" : dir;
  if (file !== ":memory:") mkdirSync(dirname(file), { recursive: true });
  const db = new DatabaseSync(file);

  // WAL + a short busy wait so the long-lived recall reader and the transient
  // insights writer (separate handles) never collide on SQLITE_BUSY. Skipped for
  // :memory: (per-connection, no shared file, WAL is a no-op there).
  if (file !== ":memory:") db.exec("PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;");

  db.exec(`CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT);`);
  const ver = (db.prepare("SELECT value FROM meta WHERE key='schema_version'").get() as { value: string } | undefined)?.value;
  // A bump must MIGRATE IN PLACE — this store must never drop artifact_outcomes (the other two
  // local stores can, because their rows re-derive from bytes; these are paid LLM judgments).
  // Since there is no migration mechanism yet, an UNKNOWN version is refused loudly instead of
  // stamped-and-continued. Silently continuing is the column-drift bug: the CREATE below is
  // table-level, so an existing table keeps its old columns while this build reads new ones.
  // When a v2 arrives: add it to KNOWN_SCHEMA_VERSIONS and do the addColumnIfMissing work here.
  if (ver !== undefined && !KNOWN_SCHEMA_VERSIONS.has(ver)) {
    db.close();   // release the handle — the caller cannot use this store
    throw new Error(
      `artifact-outcomes schema version '${ver}' is not readable by this build ` +
      `(known: ${[...KNOWN_SCHEMA_VERSIONS].join(", ")}). Refusing to open rather than risk ` +
      `misreading it; the file is left untouched. Upgrade AgentGem, or move ${file} aside.`,
    );
  }
  if (ver !== SCHEMA_VERSION) {
    db.prepare("INSERT INTO meta(key,value) VALUES('schema_version',?1) ON CONFLICT(key) DO UPDATE SET value=?1").run(SCHEMA_VERSION);
  }
  db.exec(`
    CREATE TABLE IF NOT EXISTS artifact_outcomes (
      session_id    TEXT NOT NULL,
      artifact_type TEXT NOT NULL,
      artifact_name TEXT NOT NULL,
      outcome       TEXT NOT NULL,
      project       TEXT,
      agent         TEXT,
      model         TEXT,
      mission_hint  TEXT,
      at_ms         INTEGER,
      commits       INTEGER,
      PRIMARY KEY (session_id, artifact_type, artifact_name)
    );
    CREATE INDEX IF NOT EXISTS artifact_outcomes_lookup
      ON artifact_outcomes (artifact_type, artifact_name);
  `);
  // Paired ALTER for files whose table predates the commits column (the CREATE
  // above is table-level and never reaches an existing table). NULL there means
  // "recorded before commit evidence existed", which is distinct from 0.
  addColumnIfMissing(db, "artifact_outcomes", "commits", "INTEGER");

  return {
    upsertSession(sessionId, rows) {
      db.exec("BEGIN");
      try {
        db.prepare("DELETE FROM artifact_outcomes WHERE session_id = ?1").run(sessionId);
        const ins = db.prepare(
          `INSERT INTO artifact_outcomes
             (session_id, artifact_type, artifact_name, outcome, project, agent, model, mission_hint, at_ms, commits)
           VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10)
           ON CONFLICT(session_id, artifact_type, artifact_name) DO UPDATE SET outcome=?4, commits=?10`,
        );
        for (const r of rows) {
          ins.run(r.sessionId, r.artifactType, r.artifactName, r.outcome,
            r.project, r.agent, r.model, r.missionHint, r.atMs, r.commits);
        }
        db.exec("COMMIT");
      } catch (e) {
        try { db.exec("ROLLBACK"); } catch { /* keep original error */ }
        throw e;
      }
    },

    outcomeForSessions(sessionIds) {
      const out = new Map<string, Outcome>();
      if (!sessionIds.length) return out;
      const rows = db.prepare(
        `SELECT DISTINCT session_id, outcome FROM artifact_outcomes
         WHERE session_id IN (${placeholders(sessionIds)})`,
      ).all(...sessionIds) as { session_id: string; outcome: string }[];
      for (const r of rows) out.set(r.session_id, r.outcome as Outcome);
      return out;
    },

    scoreForSessions(sessionIds) {
      const out = new Map<string, number>();
      if (!sessionIds.length) return out;
      // 1. which artifacts each candidate session used
      const used = db.prepare(
        `SELECT session_id, artifact_type, artifact_name FROM artifact_outcomes
         WHERE session_id IN (${placeholders(sessionIds)})`,
      ).all(...sessionIds) as { session_id: string; artifact_type: string; artifact_name: string }[];
      if (!used.length) return out;
      // 2. grouped outcome counts for exactly those artifacts (one query, no N+1)
      const names = [...new Set(used.map((u) => u.artifact_name))];
      const counts = db.prepare(
        `SELECT artifact_type, artifact_name, outcome, COUNT(*) AS c
         FROM artifact_outcomes
         WHERE artifact_name IN (${placeholders(names)})
         GROUP BY artifact_type, artifact_name, outcome`,
      ).all(...names) as { artifact_type: string; artifact_name: string; outcome: string; c: number }[];
      // Wilson per artifact, from the grouped counts (successes = Σ count·credit).
      const agg = new Map<string, { successes: number; n: number }>();
      for (const row of counts) {
        const key = `${row.artifact_type}:${row.artifact_name}`;
        const a = agg.get(key) ?? { successes: 0, n: 0 };
        a.successes += Number(row.c) * outcomeCredit(row.outcome as Outcome);
        a.n += Number(row.c);
        agg.set(key, a);
      }
      const artifactScore = new Map<string, number>();
      for (const [key, a] of agg) artifactScore.set(key, wilsonLowerBound(a.successes, a.n));
      // 3. per candidate session: max over its artifacts
      for (const u of used) {
        const s = artifactScore.get(`${u.artifact_type}:${u.artifact_name}`) ?? 0;
        const prev = out.get(u.session_id);
        if (prev === undefined || s > prev) out.set(u.session_id, s);
      }
      return out;
    },

    close() { db.close(); },
  };
}
