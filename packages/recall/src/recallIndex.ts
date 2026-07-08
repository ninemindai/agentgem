// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
// The on-disk BM25 index over scrubbed transcript turns. A standalone FTS5 table
// (`chunks_fts`) holds the searchable text; a parallel `chunks` table holds the
// per-turn metadata, joined by rowid. `sessions` tracks each session's change
// stamp for incremental sync. Bump SCHEMA_VERSION whenever the schema OR the
// upstream scrub pipeline changes — a version mismatch wipes and rebuilds so a
// stale scrubber can never leave un-scrubbed rows behind.
import { DatabaseSync } from "node:sqlite";
import { dirname } from "node:path";
import { mkdirSync } from "node:fs";
import type { Chunk } from "./chunkTranscript.js";

const SCHEMA_VERSION = "1";
export const HL_OPEN = "⌈";   // ⌈  — console maps to <mark>
export const HL_CLOSE = "⌉";  // ⌉

export interface MomentHit {
  sessionId: string; agent: string; turn: number;
  project: string | null; branch: string | null; startMs: number;
  snippet: string; score: number; turnsMatched: number;
}
export interface RecallFilters { project?: string; agent?: string; since?: number }
export interface SessionMeta { sessionId: string; agent: string; project: string | null; branch: string | null; startMs: number }

interface ChunkRow { session_id: string; agent: string; turn: number; project: string | null; branch: string | null; start_ms: number; score: number; snip: string }

export class RecallIndex {
  private db: DatabaseSync;
  private opened = true;

  constructor(dbPath: string) {
    mkdirSync(dirname(dbPath), { recursive: true });
    this.db = new DatabaseSync(dbPath);
    this.db.exec("PRAGMA journal_mode = WAL");
    this.ensureSchema();
  }

  private tx(fn: () => void): void {
    this.db.exec("BEGIN");
    try { fn(); this.db.exec("COMMIT"); }
    catch (e) { this.db.exec("ROLLBACK"); throw e; }
  }

  private ensureSchema(): void {
    this.db.exec(`CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT)`);
    const row = this.db.prepare("SELECT v FROM meta WHERE k = 'schema'").get() as { v: string } | undefined;
    if (row && row.v !== SCHEMA_VERSION) this.drop();
    if (!row || row.v !== SCHEMA_VERSION) {
      this.db.exec(`
        CREATE VIRTUAL TABLE IF NOT EXISTS chunks_fts USING fts5(text);
        CREATE TABLE IF NOT EXISTS chunks (
          id INTEGER PRIMARY KEY,
          session_id TEXT NOT NULL, agent TEXT NOT NULL, turn INTEGER NOT NULL,
          project TEXT, branch TEXT, start_ms INTEGER NOT NULL);
        CREATE INDEX IF NOT EXISTS chunks_session ON chunks(agent, session_id);
        CREATE TABLE IF NOT EXISTS sessions (
          agent TEXT NOT NULL, session_id TEXT NOT NULL, stamp TEXT NOT NULL,
          PRIMARY KEY (agent, session_id));
      `);
      this.db.prepare("INSERT OR REPLACE INTO meta (k, v) VALUES ('schema', ?)").run(SCHEMA_VERSION);
    }
  }

  private drop(): void {
    this.db.exec(`DROP TABLE IF EXISTS chunks_fts; DROP TABLE IF EXISTS chunks; DROP TABLE IF EXISTS sessions;`);
  }

  private removeRows(agent: string, sessionId: string): void {
    this.db.prepare(`DELETE FROM chunks_fts WHERE rowid IN (SELECT id FROM chunks WHERE agent = ? AND session_id = ?)`).run(agent, sessionId);
    this.db.prepare(`DELETE FROM chunks WHERE agent = ? AND session_id = ?`).run(agent, sessionId);
  }

  upsertSession(meta: SessionMeta, chunks: Chunk[], stamp: string): void {
    const insFts = this.db.prepare(`INSERT INTO chunks_fts(text) VALUES (?)`);
    const insChunk = this.db.prepare(`INSERT INTO chunks (id, session_id, agent, turn, project, branch, start_ms) VALUES (?, ?, ?, ?, ?, ?, ?)`);
    const upSession = this.db.prepare(`INSERT OR REPLACE INTO sessions (agent, session_id, stamp) VALUES (?, ?, ?)`);
    this.tx(() => {
      this.removeRows(meta.agent, meta.sessionId);
      for (const c of chunks) {
        const id = Number(insFts.run(c.text).lastInsertRowid);
        insChunk.run(id, meta.sessionId, meta.agent, c.turn, meta.project, meta.branch, meta.startMs);
      }
      upSession.run(meta.agent, meta.sessionId, stamp);
    });
  }

  deleteSession(agent: string, sessionId: string): void {
    this.tx(() => {
      this.removeRows(agent, sessionId);
      this.db.prepare(`DELETE FROM sessions WHERE agent = ? AND session_id = ?`).run(agent, sessionId);
    });
  }

  indexedSessions(): Map<string, string> {
    const rows = this.db.prepare(`SELECT agent, session_id, stamp FROM sessions`).all() as { agent: string; session_id: string; stamp: string }[];
    return new Map(rows.map((r) => [`${r.agent}:${r.session_id}`, r.stamp]));
  }

  // Build the FTS5 MATCH expr: drop quotes, keep words > 2 chars, prefix-OR them.
  private matchExpr(query: string): string {
    return query.replace(/['"]/g, "").split(/\s+/).filter((w) => w.length > 2).map((w) => `"${w}"*`).join(" OR ");
  }

  search(query: string, filters: RecallFilters, limit: number): MomentHit[] {
    const expr = this.matchExpr(query);
    if (!expr) return [];
    let rows: ChunkRow[];
    try {
      rows = this.db.prepare(`
        SELECT c.session_id, c.agent, c.turn, c.project, c.branch, c.start_ms,
               bm25(chunks_fts) AS score,
               snippet(chunks_fts, 0, '${HL_OPEN}', '${HL_CLOSE}', ' … ', 14) AS snip
        FROM chunks_fts JOIN chunks c ON c.id = chunks_fts.rowid
        WHERE chunks_fts MATCH @expr
          AND (@project IS NULL OR c.project = @project)
          AND (@agent   IS NULL OR c.agent   = @agent)
          AND (@since   IS NULL OR c.start_ms >= @since)
        ORDER BY score
        LIMIT @scan
      `).all({
        expr, scan: limit * 20,
        project: filters.project ?? null, agent: filters.agent ?? null, since: filters.since ?? null,
      }) as unknown as ChunkRow[];
    } catch { return []; } // malformed FTS expr → empty, never throw
    // Roll chunk hits up per session: best (lowest bm25) turn wins; count matched turns.
    const bySession = new Map<string, MomentHit>();
    for (const r of rows) {
      const key = `${r.agent}:${r.session_id}`;
      const existing = bySession.get(key);
      if (!existing) {
        bySession.set(key, { sessionId: r.session_id, agent: r.agent, turn: r.turn,
          project: r.project, branch: r.branch, startMs: r.start_ms,
          snippet: r.snip, score: r.score, turnsMatched: 1 });
      } else {
        existing.turnsMatched++;
        if (r.score < existing.score) { existing.score = r.score; existing.turn = r.turn; existing.snippet = r.snip; }
      }
    }
    return [...bySession.values()].sort((a, b) => a.score - b.score).slice(0, limit);
  }

  clear(): void {
    this.tx(() => {
      this.db.exec(`DELETE FROM chunks_fts; DELETE FROM chunks; DELETE FROM sessions;`);
    });
  }

  close(): void { if (this.opened) { this.db.close(); this.opened = false; } }
}
