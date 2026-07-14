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

// Proven-use ranking (D7). ALPHA scales the boost so relevance (BM25) stays
// primary: search() multiplies a proven session's bm25 magnitude by up to
// (1 + ALPHA), so among comparably-relevant results the proven one is preferred,
// while a weakly-relevant match is nudged only in proportion to its relevance —
// it is never yanked to the top. Injected, so recall keeps its own sqlite and no
// query-time insight dependency; absent = the kill switch (today's BM25 ordering).
export const ALPHA = 0.3;
export interface ProvenUseLookup {
  /** Per-session boost in [0,1] from that session's OWN judged outcome (already
   *  mapped via outcomeCredit by the adapter). Sessions absent from the map get
   *  no boost — a cold/empty store degrades to pure BM25. */
  boostForSessions(sessionIds: string[]): Map<string, number>;
}

export class RecallIndex {
  private db: DatabaseSync;
  private opened = true;

  constructor(dbPath: string) {
    mkdirSync(dirname(dbPath), { recursive: true });
    this.db = new DatabaseSync(dbPath);
    this.db.exec("PRAGMA journal_mode = WAL");
    // Wait up to 5s on a lock instead of throwing SQLITE_BUSY immediately — the
    // warmable writer and route/MCP readers can overlap under WAL.
    this.db.exec("PRAGMA busy_timeout = 5000");
    this.ensureSchema();
  }

  private tx(fn: () => void): void {
    this.db.exec("BEGIN");
    try { fn(); this.db.exec("COMMIT"); }
    catch (e) { try { this.db.exec("ROLLBACK"); } catch { /* keep the original error */ } throw e; }
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

  // Distinct projects/agents seen in the index, for populating the panel's filter <select>s.
  facets(): { projects: string[]; agents: string[] } {
    const projects = (this.db.prepare("SELECT DISTINCT project FROM chunks WHERE project IS NOT NULL ORDER BY project").all() as { project: string }[]).map((r) => r.project);
    const agents = (this.db.prepare("SELECT DISTINCT agent FROM chunks ORDER BY agent").all() as { agent: string }[]).map((r) => r.agent);
    return { projects, agents };
  }

  // Build the FTS5 MATCH expr: drop quotes, keep words > 2 chars, prefix-OR them.
  private matchExpr(query: string): string {
    return query.replace(/['"]/g, "").split(/\s+/).filter((w) => w.length > 2).map((w) => `"${w}"*`).join(" OR ");
  }

  search(query: string, filters: RecallFilters, limit: number, provenUse?: ProvenUseLookup): MomentHit[] {
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
    const hits = [...bySession.values()];
    if (provenUse && hits.length) {
      const boosts = provenUse.boostForSessions(hits.map((h) => h.sessionId));
      for (const h of hits) {
        const b = boosts.get(h.sessionId) ?? 0;   // unknown/unjudged session → no boost
        // FTS5 bm25() is NEGATIVE (more negative = better match), sorted ascending.
        // Amplifying the magnitude pulls a proven session toward the top; b=0 is a
        // no-op. (Multiply, not divide — dividing would demote good matches.)
        h.score = h.score * (1 + ALPHA * b);
      }
    }
    return hits.sort((a, b) => a.score - b.score).slice(0, limit);
  }

  clear(): void {
    this.tx(() => {
      this.db.exec(`DELETE FROM chunks_fts; DELETE FROM chunks; DELETE FROM sessions;`);
    });
  }

  close(): void { if (this.opened) { this.db.close(); this.opened = false; } }
}
