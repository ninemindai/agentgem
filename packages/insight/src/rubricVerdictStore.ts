// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
// packages/insight/src/rubricVerdictStore.ts
//
// Human verdicts on rubric findings, in their OWN local sqlite
// (~/.agentgem/rubric-verdicts.db). Separate from transcript-index.db AND from
// artifact-outcomes.db, extending the argument that file already makes: the index
// DROPS derived tables on a schema bump because its rows re-derive from bytes;
// artifact outcomes must not, because they are paid LLM judgments. A human verdict
// is the least reproducible row in the system — it cost someone attention and no
// amount of compute regenerates it — so it gets its own file rather than riding
// along in a store whose schema will move for unrelated reasons.
//
// Append-only. A pair can carry several rows; the readers return them in
// (at_ms, id) order and rubricVerdicts.latestPerKey collapses them. Nothing here
// counts or folds — that math is pure and lives next door.
import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { agentgemHome } from "@agentgem/model";
import { NOTE_MAX, type RubricVerdict, type VerdictValue } from "./rubricVerdicts.js";

const SCHEMA_VERSION = "1";

// Every schema version this build can read. A bump means appending the new version here AND
// migrating in place — this store must NEVER drop its table.
const KNOWN_SCHEMA_VERSIONS: ReadonlySet<string> = new Set([SCHEMA_VERSION]);

export function defaultRubricVerdictsDbPath(): string {
  return join(agentgemHome(), ".agentgem", "rubric-verdicts.db");
}

export interface RubricVerdictStore {
  /** Append one verdict. Throws on failure — a dropped verdict is user input lost —
   *  and on a note longer than NOTE_MAX. */
  recordVerdict(v: RubricVerdict): void;
  /** Every row for these factors WITHIN this rubric, ascending by (at_ms, id). */
  verdictRowsForFactors(rubricId: string, factorIds: string[]): RubricVerdict[];
  /** Every row for these sessions WITHIN this rubric, ascending by (at_ms, id). */
  verdictRowsForSessions(rubricId: string, sessionIds: string[]): RubricVerdict[];
  close(): void;
}

/** ?n placeholders starting at `from` (1-based), so a leading bound param can take ?1. */
function placeholders(xs: unknown[], from: number): string {
  return xs.map((_, i) => `?${i + from}`).join(",");
}

interface Row {
  session_id: string; factor_id: string; verdict: string;
  note: string | null; rubric_id: string; at_ms: number;
}

function toVerdict(r: Row): RubricVerdict {
  return {
    sessionId: r.session_id,
    factorId: r.factor_id,
    verdict: r.verdict as VerdictValue,
    ...(r.note !== null ? { note: r.note } : {}),
    rubricId: r.rubric_id,
    atMs: r.at_ms,
  };
}

export function openRubricVerdictStore(dbPath?: string): RubricVerdictStore {
  const target = dbPath ?? defaultRubricVerdictsDbPath();
  const file = target === "memory://" ? ":memory:" : target;
  if (file !== ":memory:") mkdirSync(dirname(file), { recursive: true });
  const db = new DatabaseSync(file);

  // WAL + a short busy wait: the console can write a verdict while a report read is
  // in flight on a separate handle. No-op for :memory: (per-connection, no shared file).
  if (file !== ":memory:") db.exec("PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;");

  db.exec(`CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT);`);
  const ver = (db.prepare("SELECT value FROM meta WHERE key='schema_version'").get() as { value: string } | undefined)?.value;
  // An unknown version is refused loudly rather than stamped-and-continued: CREATE TABLE
  // IF NOT EXISTS is table-level, so an existing table keeps its old columns while this
  // build reads new ones. Fresh databases stay green, which is exactly why that drift is
  // invisible in tests and only shows on a long-lived file.
  if (ver !== undefined && !KNOWN_SCHEMA_VERSIONS.has(ver)) {
    db.close();
    throw new Error(
      `rubric-verdicts schema version '${ver}' is not readable by this build ` +
      `(known: ${[...KNOWN_SCHEMA_VERSIONS].join(", ")}). Refusing to open rather than risk ` +
      `misreading it; the file is left untouched. Upgrade AgentGem, or move ${file} aside.`,
    );
  }
  if (ver !== SCHEMA_VERSION) {
    db.prepare("INSERT INTO meta(key,value) VALUES('schema_version',?1) ON CONFLICT(key) DO UPDATE SET value=?1").run(SCHEMA_VERSION);
  }
  db.exec(`
    CREATE TABLE IF NOT EXISTS rubric_verdicts (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT    NOT NULL,
      factor_id  TEXT    NOT NULL,
      verdict    TEXT    NOT NULL,
      note       TEXT,
      rubric_id  TEXT    NOT NULL,
      at_ms      INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS rubric_verdicts_key    ON rubric_verdicts (rubric_id, session_id, factor_id);
    CREATE INDEX IF NOT EXISTS rubric_verdicts_factor ON rubric_verdicts (rubric_id, factor_id);
  `);

  const select = (rubricId: string, column: "factor_id" | "session_id", keys: string[]): RubricVerdict[] => {
    if (!keys.length) return [];
    const rows = db.prepare(
      `SELECT session_id, factor_id, verdict, note, rubric_id, at_ms
       FROM rubric_verdicts
       WHERE rubric_id = ?1 AND ${column} IN (${placeholders(keys, 2)})
       ORDER BY at_ms ASC, id ASC`,
    ).all(rubricId, ...keys) as unknown as Row[];
    return rows.map(toVerdict);
  };

  return {
    recordVerdict(v) {
      // Enforced here, not only in the route: the constant lives at this layer, so a
      // direct caller or a test must not be able to walk past a guard the route owns.
      if (v.note !== undefined && v.note.length > NOTE_MAX) {
        throw new Error(`note exceeds NOTE_MAX (${v.note.length} > ${NOTE_MAX})`);
      }
      db.prepare(
        `INSERT INTO rubric_verdicts (session_id, factor_id, verdict, note, rubric_id, at_ms)
         VALUES (?1,?2,?3,?4,?5,?6)`,
      ).run(v.sessionId, v.factorId, v.verdict, v.note ?? null, v.rubricId, v.atMs);
    },
    verdictRowsForFactors(rubricId, factorIds) { return select(rubricId, "factor_id", factorIds); },
    verdictRowsForSessions(rubricId, sessionIds) { return select(rubricId, "session_id", sessionIds); },
    close() { db.close(); },
  };
}
