# Recall Package (`@agentgem/recall`) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the `@agentgem/recall` package — a local BM25 index over scrubbed session transcripts plus a bounded `ask_session` fan-out engine — as a pure, unit-tested library.

**Architecture:** A new workspace package depending on `@agentgem/insight` (transcript loading + `askSession`) and `@agentgem/base`. `RecallIndex` owns an on-disk SQLite FTS5 database (via `better-sqlite3`); `chunkTranscript` turns a `TranscriptView` into per-turn rows; `syncRecallIndex` is the fs glue that keeps the index current (incremental by `endMs`+`msgs`); `recallFunnel` is an async-generator orchestration that fans `askSession` across selected sessions under a hard cap and yields progress events. Every dependency that touches ACP or the filesystem is injected, so the whole package is deterministically testable with fakes.

**Tech Stack:** TypeScript 6 (ESM, `nodenext`), Node ≥24, `better-sqlite3` (SQLite FTS5), `vitest`.

**This is Plan 1 of 3.** Plan 2 wires the server (the `search_session_content` MCP tool, `recallRoutes.ts`, the `"recall"` Warmable, and the real streaming LLM synthesis). Plan 3 builds the console `#/recall` panel. This plan delivers a working, fully-tested library with injection seams the later plans fill.

## Global Constraints

- **Node ≥24, ESM.** Relative imports use the `.js` extension (`nodenext`). Copied verbatim from the spec/repo.
- **Every source file starts with the 2-line header** (matches `packages/insight/src/sessionAsk.ts`):
  ```ts
  // Copyright (c) 2026 NineMind, Inc.
  // SPDX-License-Identifier: MIT
  ```
- **Privacy boundary:** the index stores **only `scrubText`-processed** content. Chunk text comes exclusively from `TranscriptView` (already scrubbed by `loadSessionTranscript`). Never read or store raw transcript bytes.
- **Package tests run against `src`** via a package-local `vitest.config.ts` (`include: ["src/**/*.test.ts"]`). Run with `pnpm --filter @agentgem/recall test`. Tests live in `src/__tests__/*.test.ts` and import siblings via `../<module>.js`.
- **Commits:** end each commit message body with `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>` per repo rules. Author is Raymond Feng.
- **Types co-locate with their module** (house style — e.g. `SessionStat` lives in `observeAggregate.ts`). No central `types.ts`.

## File Structure

| File | Responsibility |
|---|---|
| `packages/recall/package.json` | Package manifest; `better-sqlite3` dep, workspace deps on insight/base. |
| `packages/recall/tsconfig.json` | Composite TS config; project references to insight/base. |
| `packages/recall/vitest.config.ts` | Package-local test config (src). |
| `packages/recall/src/index.ts` | Barrel — public exports. |
| `packages/recall/src/chunkTranscript.ts` | Pure: `TranscriptView` → per-turn `Chunk[]` (bounded). |
| `packages/recall/src/recallIndex.ts` | `RecallIndex` class — the FTS5 DB (schema+version, upsert/delete/search/clear) + `MomentHit`/`RecallFilters` types. |
| `packages/recall/src/syncIndex.ts` | `syncRecallIndex` — incremental fs glue (enumerate → load → chunk → upsert; prune vanished). |
| `packages/recall/src/recallFunnel.ts` | `recallFunnel` async generator + funnel types + `defaultFunnelDeps`. |
| `tsconfig.json` (root) | Add `{ "path": "packages/recall" }` to `references`. |

---

### Task 1: Package scaffold

**Files:**
- Create: `packages/recall/package.json`
- Create: `packages/recall/tsconfig.json`
- Create: `packages/recall/vitest.config.ts`
- Create: `packages/recall/src/index.ts`
- Modify: `tsconfig.json` (root) — append to `references`
- Test: `packages/recall/src/__tests__/smoke.test.ts`

**Interfaces:**
- Produces: the `@agentgem/recall` package builds and its test runner works. No exports yet.

- [ ] **Step 1: Write the failing smoke test**

`packages/recall/src/__tests__/smoke.test.ts`:
```ts
// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
import { describe, it, expect } from "vitest";
import Database from "better-sqlite3";

describe("recall package", () => {
  it("has a working better-sqlite3 with FTS5", () => {
    const db = new Database(":memory:");
    db.exec("CREATE VIRTUAL TABLE t USING fts5(x)");
    db.prepare("INSERT INTO t(rowid, x) VALUES (1, ?)").run("hello world");
    const row = db.prepare("SELECT rowid FROM t WHERE t MATCH ?").get("hello") as { rowid: number };
    expect(row.rowid).toBe(1);
    db.close();
  });
});
```

- [ ] **Step 2: Create the package manifest**

`packages/recall/package.json`:
```json
{
  "name": "@agentgem/recall",
  "version": "0.1.0",
  "description": "Local BM25 search over scrubbed session transcripts + bounded ask_session fan-out.",
  "license": "MIT",
  "private": true,
  "type": "module",
  "exports": {
    ".": { "types": "./dist/index.d.ts", "default": "./dist/index.js" }
  },
  "files": ["dist"],
  "scripts": { "build": "tsc -b", "test": "vitest run" },
  "dependencies": {
    "@agentgem/base": "workspace:*",
    "@agentgem/insight": "workspace:*",
    "better-sqlite3": "~12.10.0"
  },
  "devDependencies": {
    "@types/better-sqlite3": "~7.6.13"
  }
}
```

- [ ] **Step 3: Create tsconfig + vitest config + empty barrel**

`packages/recall/tsconfig.json`:
```json
{
  "compilerOptions": {
    "target": "es2022",
    "module": "nodenext",
    "moduleResolution": "nodenext",
    "lib": ["es2022"],
    "types": ["node"],
    "strict": true,
    "strictPropertyInitialization": false,
    "useUnknownInCatchVariables": false,
    "noFallthroughCasesInSwitch": true,
    "esModuleInterop": true,
    "allowSyntheticDefaultImports": true,
    "resolveJsonModule": true,
    "skipLibCheck": true,
    "composite": true,
    "declaration": true,
    "rootDir": "src",
    "outDir": "dist",
    "incremental": true
  },
  "include": ["src/**/*"],
  "exclude": ["dist", "node_modules"],
  "references": [{ "path": "../base" }, { "path": "../insight" }]
}
```

`packages/recall/vitest.config.ts`:
```ts
// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: { include: ["src/**/*.test.ts"], environment: "node", watch: false },
});
```

`packages/recall/src/index.ts`:
```ts
// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
export {};
```

- [ ] **Step 4: Register the package in the root tsconfig**

In `tsconfig.json` (root), append `{ "path": "packages/recall" }` to the `references` array (it currently ends with `{ "path": "packages/play" }`). The result's tail:
```json
{ "path": "packages/play" }, { "path": "packages/recall" }]
```
(`pnpm-workspace.yaml` globs `packages/*`, so no change there.)

- [ ] **Step 5: Install and build**

Run:
```bash
pnpm install
pnpm --filter @agentgem/recall build
```
Expected: install adds `better-sqlite3`; build succeeds (emits `packages/recall/dist/index.js`).

- [ ] **Step 6: Run the smoke test**

Run: `pnpm --filter @agentgem/recall test`
Expected: PASS (1 test) — confirms `better-sqlite3` FTS5 is available.

- [ ] **Step 7: Commit**

```bash
git add packages/recall tsconfig.json pnpm-lock.yaml
git commit -m "feat(recall): scaffold @agentgem/recall package"
```

---

### Task 2: `chunkTranscript` — TranscriptView → per-turn rows

**Files:**
- Create: `packages/recall/src/chunkTranscript.ts`
- Modify: `packages/recall/src/index.ts`
- Test: `packages/recall/src/__tests__/chunkTranscript.test.ts`

**Interfaces:**
- Consumes: `TranscriptView`, `TranscriptTurn`, `TranscriptSpan` from `@agentgem/insight` (`{ turns: { spans: ({kind:"message";role;text} | {kind:"tool_call";name;input;output?;error?})[] }[] }`).
- Produces: `interface Chunk { turn: number; text: string }` and `function chunkTranscript(view: TranscriptView, opts?: { maxCharsPerTurn?: number }): Chunk[]`.

- [ ] **Step 1: Write the failing test**

`packages/recall/src/__tests__/chunkTranscript.test.ts`:
```ts
// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
import { describe, it, expect } from "vitest";
import { chunkTranscript } from "../chunkTranscript.js";
import type { TranscriptView } from "@agentgem/insight";

const view = {
  sessionId: "s1", agent: "claude", model: null, project: "p", startMs: 0, endMs: 1,
  turns: [
    { index: 0, role: "user", spans: [{ kind: "message", role: "user", text: "fix the migration" }] },
    { index: 1, role: "assistant", spans: [
      { kind: "message", role: "assistant", text: "running it" },
      { kind: "tool_call", name: "Bash", input: "alter table x add column y", output: "OK" },
    ] },
    { index: 2, role: "assistant", spans: [{ kind: "message", role: "assistant", text: "   " }] },
  ],
} as unknown as TranscriptView;

describe("chunkTranscript", () => {
  it("emits one chunk per non-empty turn, rendering messages and tool calls", () => {
    const chunks = chunkTranscript(view);
    expect(chunks.map((c) => c.turn)).toEqual([0, 1]); // turn 2 is whitespace-only → dropped
    expect(chunks[0].text).toContain("fix the migration");
    expect(chunks[1].text).toContain("running it");
    expect(chunks[1].text).toContain("Bash(alter table x add column y) -> OK");
  });

  it("bounds each chunk to maxCharsPerTurn", () => {
    const big = { ...view, turns: [{ index: 0, role: "user", spans: [{ kind: "message", role: "user", text: "x".repeat(9000) }] }] } as unknown as TranscriptView;
    const chunks = chunkTranscript(big, { maxCharsPerTurn: 100 });
    expect(chunks[0].text.length).toBeLessThanOrEqual(100);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @agentgem/recall test`
Expected: FAIL — `chunkTranscript` is not a module.

- [ ] **Step 3: Implement `chunkTranscript`**

`packages/recall/src/chunkTranscript.ts`:
```ts
// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
// Turn a scrubbed TranscriptView into per-turn text rows for the BM25 index.
// Mirrors sessionAsk.renderTranscript's span rendering, but keeps each turn a
// separate row so search can rank moments (not whole sessions). Input is already
// scrub-processed by loadSessionTranscript — this file never touches raw bytes.
import type { TranscriptView, TranscriptSpan } from "@agentgem/insight";

export interface Chunk { turn: number; text: string }

const DEFAULT_MAX_CHARS_PER_TURN = 4000;

function renderSpan(span: TranscriptSpan): string {
  if (span.kind === "message") return `${span.role}: ${span.text}`;
  return `${span.name}(${span.input})${span.output !== undefined ? ` -> ${span.output}` : ""}`;
}

export function chunkTranscript(view: TranscriptView, opts: { maxCharsPerTurn?: number } = {}): Chunk[] {
  const max = opts.maxCharsPerTurn ?? DEFAULT_MAX_CHARS_PER_TURN;
  const chunks: Chunk[] = [];
  for (const turn of view.turns) {
    const text = turn.spans.map(renderSpan).join("\n").trim();
    if (!text) continue;
    chunks.push({ turn: turn.index, text: text.length > max ? text.slice(0, max) : text });
  }
  return chunks;
}
```

- [ ] **Step 4: Export from the barrel**

`packages/recall/src/index.ts`:
```ts
// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
export * from "./chunkTranscript.js";
```

- [ ] **Step 5: Run test to verify it passes**

Run: `pnpm --filter @agentgem/recall test`
Expected: PASS (both `chunkTranscript` tests + the smoke test).

- [ ] **Step 6: Commit**

```bash
git add packages/recall/src
git commit -m "feat(recall): chunkTranscript — per-turn rows from a TranscriptView"
```

---

### Task 3: `RecallIndex` — the FTS5 database

**Files:**
- Create: `packages/recall/src/recallIndex.ts`
- Modify: `packages/recall/src/index.ts`
- Test: `packages/recall/src/__tests__/recallIndex.test.ts`

**Interfaces:**
- Consumes: `Chunk` from `./chunkTranscript.js`.
- Produces:
  - `interface MomentHit { sessionId: string; agent: string; turn: number; project: string | null; branch: string | null; startMs: number; snippet: string; score: number; turnsMatched: number }`
  - `interface RecallFilters { project?: string; agent?: string; since?: number }`
  - `interface SessionMeta { sessionId: string; agent: string; project: string | null; branch: string | null; startMs: number }`
  - `const HL_OPEN = "⌈"; const HL_CLOSE = "⌉";` (snippet highlight markers the console maps to `<mark>`)
  - `class RecallIndex` with:
    - `constructor(dbPath: string)`
    - `upsertSession(meta: SessionMeta, chunks: Chunk[], stamp: string): void`
    - `deleteSession(agent: string, sessionId: string): void`
    - `indexedSessions(): Map<string, string>` (key `"<agent>:<sessionId>"` → stamp)
    - `search(query: string, filters: RecallFilters, limit: number): MomentHit[]`
    - `clear(): void`
    - `close(): void`

- [ ] **Step 1: Write the failing test**

`packages/recall/src/__tests__/recallIndex.test.ts`:
```ts
// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { RecallIndex, HL_OPEN } from "../recallIndex.js";
import type { SessionMeta } from "../recallIndex.js";

let dir: string; let dbPath: string; let idx: RecallIndex;
const meta = (id: string, over: Partial<SessionMeta> = {}): SessionMeta =>
  ({ sessionId: id, agent: "claude", project: "agentgem", branch: "main", startMs: 1000, ...over });

beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "recall-")); dbPath = join(dir, "i.db"); idx = new RecallIndex(dbPath); });
afterEach(() => { idx.close(); rmSync(dir, { recursive: true, force: true }); });

describe("RecallIndex", () => {
  it("ranks sessions by their best matching turn and rolls up matched-turn count", () => {
    idx.upsertSession(meta("s1"), [
      { turn: 0, text: "the prod database migration failed" },
      { turn: 3, text: "migration retried and the database recovered" },
    ], "a");
    idx.upsertSession(meta("s2", { project: "other" }), [{ turn: 1, text: "unrelated ui change" }], "b");
    const hits = idx.search("database migration", {}, 10);
    expect(hits.map((h) => h.sessionId)).toEqual(["s1"]);
    expect(hits[0].turnsMatched).toBe(2);
    expect(hits[0].turn).toBe(0); // best turn surfaced
    expect(hits[0].snippet).toContain(HL_OPEN); // highlighted
  });

  it("applies project / agent / since filters", () => {
    idx.upsertSession(meta("s1", { project: "agentgem", startMs: 5000 }), [{ turn: 0, text: "schema drift bug" }], "a");
    idx.upsertSession(meta("s2", { project: "goose", startMs: 5000 }), [{ turn: 0, text: "schema drift bug" }], "b");
    expect(idx.search("schema", { project: "goose" }, 10).map((h) => h.sessionId)).toEqual(["s2"]);
    expect(idx.search("schema", { since: 9000 }, 10)).toHaveLength(0);
  });

  it("upsert replaces a session's chunks and tracks its stamp", () => {
    idx.upsertSession(meta("s1"), [{ turn: 0, text: "first version alpha" }], "v1");
    idx.upsertSession(meta("s1"), [{ turn: 0, text: "second version beta" }], "v2");
    expect(idx.search("alpha", {}, 10)).toHaveLength(0);
    expect(idx.search("beta", {}, 10)).toHaveLength(1);
    expect(idx.indexedSessions().get("claude:s1")).toBe("v2");
  });

  it("deleteSession removes a session's rows", () => {
    idx.upsertSession(meta("s1"), [{ turn: 0, text: "deletable content" }], "a");
    idx.deleteSession("claude", "s1");
    expect(idx.search("deletable", {}, 10)).toHaveLength(0);
    expect(idx.indexedSessions().has("claude:s1")).toBe(false);
  });

  it("rebuilds when the on-disk schema version is stale", () => {
    idx.upsertSession(meta("s1"), [{ turn: 0, text: "surviving content" }], "a");
    idx.close();
    // Corrupt the stored version, reopen — index must self-wipe, not crash.
    const raw = new Database(dbPath);
    raw.prepare("UPDATE meta SET v = ? WHERE k = 'schema'").run("0");
    raw.close();
    const reopened = new RecallIndex(dbPath);
    expect(reopened.search("surviving", {}, 10)).toHaveLength(0);
    expect(reopened.indexedSessions().size).toBe(0);
    reopened.close();
  });

  it("clear empties the index", () => {
    idx.upsertSession(meta("s1"), [{ turn: 0, text: "wipe me" }], "a");
    idx.clear();
    expect(idx.search("wipe", {}, 10)).toHaveLength(0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @agentgem/recall test`
Expected: FAIL — `RecallIndex` is not a module.

- [ ] **Step 3: Implement `RecallIndex`**

`packages/recall/src/recallIndex.ts`:
```ts
// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
// The on-disk BM25 index over scrubbed transcript turns. A standalone FTS5 table
// (`chunks_fts`) holds the searchable text; a parallel `chunks` table holds the
// per-turn metadata, joined by rowid. `sessions` tracks each session's change
// stamp for incremental sync. Bump SCHEMA_VERSION whenever the schema OR the
// upstream scrub pipeline changes — a version mismatch wipes and rebuilds so a
// stale scrubber can never leave un-scrubbed rows behind.
import Database from "better-sqlite3";
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
  private db: Database.Database;

  constructor(dbPath: string) {
    mkdirSync(dirname(dbPath), { recursive: true });
    this.db = new Database(dbPath);
    this.db.pragma("journal_mode = WAL");
    this.ensureSchema();
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
    const tx = this.db.transaction(() => {
      this.removeRows(meta.agent, meta.sessionId);
      for (const c of chunks) {
        const id = insFts.run(c.text).lastInsertRowid as number;
        insChunk.run(id, meta.sessionId, meta.agent, c.turn, meta.project, meta.branch, meta.startMs);
      }
      upSession.run(meta.agent, meta.sessionId, stamp);
    });
    tx();
  }

  deleteSession(agent: string, sessionId: string): void {
    const tx = this.db.transaction(() => {
      this.removeRows(agent, sessionId);
      this.db.prepare(`DELETE FROM sessions WHERE agent = ? AND session_id = ?`).run(agent, sessionId);
    });
    tx();
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
      }) as ChunkRow[];
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
    const tx = this.db.transaction(() => {
      this.db.exec(`DELETE FROM chunks_fts; DELETE FROM chunks; DELETE FROM sessions;`);
    });
    tx();
  }

  close(): void { this.db.close(); }
}
```

- [ ] **Step 4: Export from the barrel**

Append to `packages/recall/src/index.ts`:
```ts
export * from "./recallIndex.js";
```

- [ ] **Step 5: Run test to verify it passes**

Run: `pnpm --filter @agentgem/recall test`
Expected: PASS (all `RecallIndex` tests). Note: `bm25()` returns negative scores (lower = better), so `ORDER BY score` ascending puts best first — the roll-up keeps the lowest.

- [ ] **Step 6: Commit**

```bash
git add packages/recall/src
git commit -m "feat(recall): RecallIndex — FTS5 BM25 index with per-session roll-up"
```

---

### Task 4: `syncRecallIndex` — incremental fs glue

**Files:**
- Create: `packages/recall/src/syncIndex.ts`
- Modify: `packages/recall/src/index.ts`
- Test: `packages/recall/src/__tests__/syncIndex.test.ts`

**Interfaces:**
- Consumes: `RecallIndex`, `SessionMeta` (Task 3); `chunkTranscript` (Task 2); `SessionStat` + `TranscriptView` types from `@agentgem/insight`.
- Produces:
  - `interface SyncDeps { loadTranscript(sessionId: string, agent: string): Promise<TranscriptView | null> }`
  - `function stampOf(stat: SessionStat): string` → `"<endMs>:<msgs>"`
  - `async function syncRecallIndex(index: RecallIndex, sessions: SessionStat[], deps: SyncDeps): Promise<{ indexed: number; skipped: number; removed: number }>`

- [ ] **Step 1: Write the failing test**

`packages/recall/src/__tests__/syncIndex.test.ts`:
```ts
// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RecallIndex } from "../recallIndex.js";
import { syncRecallIndex, stampOf } from "../syncIndex.js";
import type { SessionStat, TranscriptView } from "@agentgem/insight";

let dir: string; let idx: RecallIndex;
const stat = (id: string, over: Partial<SessionStat> = {}): SessionStat =>
  ({ agent: "claude", sessionId: id, project: "agentgem", cwd: null, model: null, gitBranch: "main",
     startMs: 1000, endMs: 2000, msgs: 4, tokensIn: 0, tokensOut: 0, tokensCache: 0, ...over });
const viewFor = (id: string, text: string): TranscriptView =>
  ({ sessionId: id, agent: "claude", model: null, project: "agentgem", startMs: 1000, endMs: 2000,
     turns: [{ index: 0, role: "user", spans: [{ kind: "message", role: "user", text }] }] } as unknown as TranscriptView);

beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "recall-sync-")); idx = new RecallIndex(join(dir, "i.db")); });
afterEach(() => { idx.close(); rmSync(dir, { recursive: true, force: true }); });

describe("syncRecallIndex", () => {
  it("indexes sessions and makes their content searchable", async () => {
    const deps = { loadTranscript: async (id: string) => viewFor(id, "prod migration " + id) };
    const r = await syncRecallIndex(idx, [stat("s1"), stat("s2")], deps);
    expect(r.indexed).toBe(2);
    expect(idx.search("migration", {}, 10).map((h) => h.sessionId).sort()).toEqual(["s1", "s2"]);
  });

  it("skips unchanged sessions on a second sync (same stamp)", async () => {
    let loads = 0;
    const deps = { loadTranscript: async (id: string) => { loads++; return viewFor(id, "content"); } };
    await syncRecallIndex(idx, [stat("s1")], deps);
    const r2 = await syncRecallIndex(idx, [stat("s1")], deps);
    expect(loads).toBe(1);            // not re-loaded
    expect(r2.indexed).toBe(0);
  });

  it("re-indexes a session whose stamp changed (msgs grew)", async () => {
    const deps = { loadTranscript: async (id: string) => viewFor(id, "grew") };
    await syncRecallIndex(idx, [stat("s1", { msgs: 4 })], deps);
    const r2 = await syncRecallIndex(idx, [stat("s1", { msgs: 9 })], deps);
    expect(r2.indexed).toBe(1);
  });

  it("prunes vanished sessions and counts unparseable ones as skipped", async () => {
    await syncRecallIndex(idx, [stat("s1")], { loadTranscript: async (id: string) => viewFor(id, "keep") });
    const r = await syncRecallIndex(idx, [stat("s2")], { loadTranscript: async () => null });
    expect(r.skipped).toBe(1);        // s2 unparseable
    expect(r.removed).toBe(1);        // s1 gone
    expect(idx.indexedSessions().size).toBe(0);
  });
});

describe("stampOf", () => {
  it("combines endMs and msgs", () => { expect(stampOf(stat("s", { endMs: 7, msgs: 3 }))).toBe("7:3"); });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @agentgem/recall test`
Expected: FAIL — `syncIndex` is not a module.

- [ ] **Step 3: Implement `syncRecallIndex`**

`packages/recall/src/syncIndex.ts`:
```ts
// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
// Keep the RecallIndex current against the live session set. Incremental: a
// session's change stamp is (endMs:msgs) — appending to a transcript grows both,
// so we re-index only what changed and prune what vanished. `loadTranscript` is
// injected (real: insight.loadSessionTranscript) so this is testable without fs.
import type { SessionStat, TranscriptView } from "@agentgem/insight";
import { RecallIndex } from "./recallIndex.js";
import { chunkTranscript } from "./chunkTranscript.js";

export interface SyncDeps {
  loadTranscript(sessionId: string, agent: string): Promise<TranscriptView | null>;
}

export function stampOf(stat: SessionStat): string { return `${stat.endMs}:${stat.msgs}`; }

export async function syncRecallIndex(
  index: RecallIndex, sessions: SessionStat[], deps: SyncDeps,
): Promise<{ indexed: number; skipped: number; removed: number }> {
  const have = index.indexedSessions();
  let indexed = 0, skipped = 0;
  for (const s of sessions) {
    const key = `${s.agent}:${s.sessionId}`;
    const stamp = stampOf(s);
    if (have.get(key) === stamp) { have.delete(key); continue; } // unchanged
    const view = await deps.loadTranscript(s.sessionId, s.agent);
    if (!view) { skipped++; have.delete(key); continue; }        // unparseable — leave as-is / drop key
    index.upsertSession(
      { sessionId: s.sessionId, agent: s.agent, project: s.project, branch: s.gitBranch, startMs: s.startMs },
      chunkTranscript(view), stamp,
    );
    indexed++; have.delete(key);
  }
  // Anything still in `have` was indexed before but is no longer present → prune.
  let removed = 0;
  for (const key of have.keys()) {
    const [agent, ...rest] = key.split(":");
    index.deleteSession(agent, rest.join(":"));
    removed++;
  }
  return { indexed, skipped, removed };
}
```

- [ ] **Step 4: Export from the barrel**

Append to `packages/recall/src/index.ts`:
```ts
export * from "./syncIndex.js";
```

- [ ] **Step 5: Run test to verify it passes**

Run: `pnpm --filter @agentgem/recall test`
Expected: PASS. Note the `have.delete(key)` on the unparseable path: a session that fails to load is dropped from the "seen" set so it is NOT pruned as vanished — its prior rows (if any) simply persist until it parses again.

- [ ] **Step 6: Commit**

```bash
git add packages/recall/src
git commit -m "feat(recall): syncRecallIndex — incremental index sync"
```

---

### Task 5: `recallFunnel` — bounded ask_session fan-out

**Files:**
- Create: `packages/recall/src/recallFunnel.ts`
- Modify: `packages/recall/src/index.ts`
- Test: `packages/recall/src/__tests__/recallFunnel.test.ts`

**Interfaces:**
- Consumes: `askSession` from `@agentgem/insight` (for `defaultFunnelDeps` only; signature `askSession(sessionId, agent, question, opts?) => Promise<{ answered: boolean; answer: string; agentUsed: string | null }>`).
- Produces:
  - `type FunnelMode = "chat" | "extract"`
  - `interface SessionRef { sessionId: string; agent: string }`
  - `interface SessionAnswer { sessionId: string; agent: string; answered: boolean; answer: string }`
  - `type FunnelEvent = { type:"session_started"; sessionId:string } | { type:"session_done"; sessionId:string; answered:boolean } | { type:"capped"; scanned:number; requested:number; cap:number } | { type:"synthesis_delta"; text:string } | { type:"done"; answers:SessionAnswer[]; synthesis:string } | { type:"cancelled" }`
  - `interface FunnelInput { sessions: SessionRef[]; prompt: string; mode: FunnelMode; signal?: AbortSignal }`
  - `interface FunnelDeps { askOne(ref: SessionRef, prompt: string, signal: AbortSignal): Promise<{ answered: boolean; answer: string }>; synthesize(answers: SessionAnswer[], prompt: string, mode: FunnelMode, signal: AbortSignal): AsyncIterable<string>; cap?: number; concurrency?: number }`
  - `const RECALL_CAP = 12; const RECALL_CONCURRENCY = 3`
  - `function defaultFunnelDeps(): FunnelDeps`
  - `async function* recallFunnel(input: FunnelInput, deps: FunnelDeps): AsyncGenerator<FunnelEvent>`

- [ ] **Step 1: Write the failing test**

`packages/recall/src/__tests__/recallFunnel.test.ts`:
```ts
// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
import { describe, it, expect } from "vitest";
import { recallFunnel, RECALL_CAP } from "../recallFunnel.js";
import type { FunnelDeps, FunnelEvent, SessionRef } from "../recallFunnel.js";

const refs = (n: number): SessionRef[] => Array.from({ length: n }, (_, i) => ({ sessionId: `s${i}`, agent: "claude" }));

function fakeDeps(over: Partial<FunnelDeps> = {}): FunnelDeps {
  return {
    async askOne(ref) { return { answered: true, answer: `answer for ${ref.sessionId}` }; },
    async *synthesize(answers) { yield `synthesis of ${answers.length}`; },
    ...over,
  };
}
async function collect(gen: AsyncGenerator<FunnelEvent>): Promise<FunnelEvent[]> {
  const out: FunnelEvent[] = []; for await (const e of gen) out.push(e); return out;
}

describe("recallFunnel", () => {
  it("asks each session, then synthesizes, ending with done", async () => {
    const events = await collect(recallFunnel({ sessions: refs(2), prompt: "q", mode: "extract" }, fakeDeps()));
    expect(events.filter((e) => e.type === "session_done")).toHaveLength(2);
    const done = events.at(-1);
    expect(done).toMatchObject({ type: "done", synthesis: "synthesis of 2" });
    expect((done as any).answers[0]).toMatchObject({ sessionId: "s0", answered: true });
  });

  it("caps the scanned set and emits a capped event", async () => {
    const events = await collect(recallFunnel({ sessions: refs(20), prompt: "q", mode: "extract" }, fakeDeps()));
    expect(events.find((e) => e.type === "capped")).toMatchObject({ scanned: RECALL_CAP, requested: 20, cap: RECALL_CAP });
    expect(events.filter((e) => e.type === "session_done")).toHaveLength(RECALL_CAP);
  });

  it("marks a failed session degraded but keeps going", async () => {
    const deps = fakeDeps({ async askOne(ref) { return ref.sessionId === "s1" ? { answered: false, answer: "failed" } : { answered: true, answer: "ok" }; } });
    const events = await collect(recallFunnel({ sessions: refs(3), prompt: "q", mode: "extract" }, deps));
    const done = events.find((e) => e.type === "session_done" && (e as any).sessionId === "s1");
    expect(done).toMatchObject({ answered: false });
    expect(events.at(-1)!.type).toBe("done");
  });

  it("stops early and emits cancelled when the signal aborts", async () => {
    const ctrl = new AbortController();
    const deps = fakeDeps({ async askOne(ref) { if (ref.sessionId === "s0") ctrl.abort(); return { answered: true, answer: "x" }; } });
    const events = await collect(recallFunnel({ sessions: refs(9), prompt: "q", mode: "extract", signal: ctrl.signal }, deps));
    expect(events.at(-1)!.type).toBe("cancelled");
    expect(events.some((e) => e.type === "done")).toBe(false);
  });

  it("never runs more than `concurrency` asks at once", async () => {
    let inFlight = 0, peak = 0;
    const deps = fakeDeps({ concurrency: 2, async askOne() {
      inFlight++; peak = Math.max(peak, inFlight);
      await new Promise((r) => setTimeout(r, 5)); inFlight--; return { answered: true, answer: "x" };
    } });
    await collect(recallFunnel({ sessions: refs(6), prompt: "q", mode: "extract" }, deps));
    expect(peak).toBeLessThanOrEqual(2);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @agentgem/recall test`
Expected: FAIL — `recallFunnel` is not a module.

- [ ] **Step 3: Implement `recallFunnel`**

`packages/recall/src/recallFunnel.ts`:
```ts
// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
// The "A engine": fan `ask_session` across the selected sessions under a hard cap
// and bounded concurrency, then synthesize. Raw transcripts never reach here — a
// sub-agent reads each (scrubbed) transcript inside askSession and returns only
// text; synthesis sees only those per-session answers. Batches of `concurrency`
// keep the subprocess count bounded. All ACP/LLM work is injected via FunnelDeps
// so the orchestration is deterministically testable.
import { askSession } from "@agentgem/insight";

export type FunnelMode = "chat" | "extract";
export interface SessionRef { sessionId: string; agent: string }
export interface SessionAnswer { sessionId: string; agent: string; answered: boolean; answer: string }
export type FunnelEvent =
  | { type: "session_started"; sessionId: string }
  | { type: "session_done"; sessionId: string; answered: boolean }
  | { type: "capped"; scanned: number; requested: number; cap: number }
  | { type: "synthesis_delta"; text: string }
  | { type: "done"; answers: SessionAnswer[]; synthesis: string }
  | { type: "cancelled" };
export interface FunnelInput { sessions: SessionRef[]; prompt: string; mode: FunnelMode; signal?: AbortSignal }
export interface FunnelDeps {
  askOne(ref: SessionRef, prompt: string, signal: AbortSignal): Promise<{ answered: boolean; answer: string }>;
  synthesize(answers: SessionAnswer[], prompt: string, mode: FunnelMode, signal: AbortSignal): AsyncIterable<string>;
  cap?: number;
  concurrency?: number;
}

export const RECALL_CAP = 12;
export const RECALL_CONCURRENCY = 3;

// Default wiring for real runs. Plan 2 replaces `synthesize` with a streaming LLM
// pass; this deterministic structured join is the working fallback.
export function defaultFunnelDeps(): FunnelDeps {
  return {
    async askOne(ref, prompt, signal) {
      const r = await askSession(ref.sessionId, ref.agent, prompt, { timeoutMs: signalTimeout(signal) });
      return { answered: r.answered, answer: r.answer };
    },
    async *synthesize(answers) {
      const ok = answers.filter((a) => a.answered);
      yield ok.map((a) => `### ${a.agent}:${a.sessionId}\n${a.answer}`).join("\n\n") || "No sessions produced an answer.";
    },
  };
}
function signalTimeout(_signal: AbortSignal): number { return 120_000; }

export async function* recallFunnel(input: FunnelInput, deps: FunnelDeps): AsyncGenerator<FunnelEvent> {
  const cap = deps.cap ?? RECALL_CAP;
  const concurrency = deps.concurrency ?? RECALL_CONCURRENCY;
  const signal = input.signal ?? new AbortController().signal;

  const scoped = input.sessions.slice(0, cap);
  if (input.sessions.length > cap) yield { type: "capped", scanned: scoped.length, requested: input.sessions.length, cap };

  const answers: SessionAnswer[] = [];
  for (let i = 0; i < scoped.length; i += concurrency) {
    if (signal.aborted) { yield { type: "cancelled" }; return; }
    const batch = scoped.slice(i, i + concurrency);
    for (const ref of batch) yield { type: "session_started", sessionId: ref.sessionId };
    const results = await Promise.all(batch.map((ref) => deps.askOne(ref, input.prompt, signal)));
    for (let j = 0; j < batch.length; j++) {
      const ref = batch[j], r = results[j];
      answers.push({ sessionId: ref.sessionId, agent: ref.agent, answered: r.answered, answer: r.answer });
      yield { type: "session_done", sessionId: ref.sessionId, answered: r.answered };
    }
  }
  if (signal.aborted) { yield { type: "cancelled" }; return; }

  let synthesis = "";
  for await (const delta of deps.synthesize(answers, input.prompt, input.mode, signal)) {
    if (signal.aborted) { yield { type: "cancelled" }; return; }
    synthesis += delta; yield { type: "synthesis_delta", text: delta };
  }
  yield { type: "done", answers, synthesis };
}
```

- [ ] **Step 4: Export from the barrel**

Append to `packages/recall/src/index.ts`:
```ts
export * from "./recallFunnel.js";
```

- [ ] **Step 5: Run test to verify it passes**

Run: `pnpm --filter @agentgem/recall test`
Expected: PASS (all funnel tests + prior tasks).

- [ ] **Step 6: Full package build + typecheck**

Run: `pnpm --filter @agentgem/recall build && pnpm --filter @agentgem/recall test`
Expected: build emits clean `dist/`; all tests green.

- [ ] **Step 7: Commit**

```bash
git add packages/recall/src
git commit -m "feat(recall): recallFunnel — bounded ask_session fan-out engine"
```

---

## Self-Review

**Spec coverage:**
- Vendored BM25-only / FTS5 → Task 3 (`RecallIndex`; ports the source's BM25 MATCH-expr + roll-up; `snippet()` for highlights; no vector/embedding/remote deps). ✅
- Per-chunk index, results span sessions → Task 2 (per-turn chunks) + Task 3 (cross-session roll-up ranks moments corpus-wide). ✅
- On-disk, versioned, incremental → Task 3 (`SCHEMA_VERSION` self-invalidation) + Task 4 (incremental `endMs:msgs` stamp, prune vanished). ✅
- Capped fan-out (K=12, 3 concurrent) + synthesize + cancel + degrade → Task 5. ✅
- Boundary (scrubbed-only, no raw content) → chunk text sourced only from `TranscriptView`; funnel sees only per-session answers. ✅
- Deferred to Plan 2/3 (correctly out of scope here): `Warmable` registration, `search_session_content` MCP tool, `recallRoutes.ts`, streaming LLM synthesis, the console panel. Injection seams (`SyncDeps.loadTranscript`, `FunnelDeps.synthesize`) are in place for them.

**Placeholder scan:** none — every step ships complete code and exact commands.

**Type consistency:** `MomentHit`/`SessionMeta`/`RecallFilters` (Task 3) consumed unchanged in Task 4; `Chunk` (Task 2) consumed in Tasks 3–4; `FunnelDeps`/`FunnelEvent`/`SessionRef` (Task 5) self-consistent. `stampOf` format `"<endMs>:<msgs>"` matches the Task 4 test. `askSession`'s real signature (`sessionId, agent, question, opts`) matches `defaultFunnelDeps`.

**One caveat to flag at execution:** package tests use the package-local `vitest.config.ts` (src). Whether the root CI job (`test (24)`/`test (26)`) picks these up is a Plan 2 integration question (the root config globs root `dist/**/__tests__`); if CI must run them, add a workspace test step there. Not a blocker for this plan's deliverable.
