# Rubric Verdict Capture Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a person record `accepted` / `wrong` / `wontfix` on a factor that fired against a session, persist it locally, and feed it back as per-criterion calibration on the rubric report.

**Architecture:** A pure math module (types + rollup, no fs) and a `node:sqlite` store live in `packages/insight`. `rubricCore.computeRubric` decorates the report **after** its cache returns, so verdicts are always fresh and never cached. One strict POST route writes. The console renders controls on the existing `FactorRow`, gated to session scope.

**Tech Stack:** TypeScript (ESM, NodeNext), `node:sqlite` (`DatabaseSync`), Zod + `@agentback/openapi` decorators, Preact/React-style console components, vitest.

**Spec:** `docs/superpowers/specs/2026-08-08-rubric-verdict-capture-design.md`

## Global Constraints

- **Tests run from compiled JS, never from `src/`.** `vitest.config.ts` includes only `dist/**/__tests__/**/*.test.js` and `packages/*/dist/**/__tests__/**/*.test.js`. You must run `pnpm exec tsc -b` before `vitest`, and target the **`dist/` path**. `vitest run src/__tests__/foo.test.ts` finds zero tests and exits green — a false pass.
- **Root-package tests go in `src/__tests__/`**, not `packages/insight/src/__tests__/`. Both directories exist; the precedents for this work (`artifactOutcomesStore.test.ts`, `rubricReport.test.ts`, `rubricCore.test.ts`, `rubric.controller.test.ts`) are all in the root one.
- **Console tests are separate:** `pnpm --filter @agentgem/console test` (jsdom, `src/**/*.test.{ts,tsx}`, runs from source). Use `--filter`, not `--root`.
- **Write the NUL key separator as the escape `"\u0000"`**, never a literal NUL byte, so the source stays greppable (commit `40089570`).
- **Every new `rub-*` className needs a matching rule in `packages/console/src/shell/theme.css` in the same commit.** A class with no rule renders as raw browser defaults.
- **`.rub-verdict` is already taken** by the report summary line (`panels/Rubrics/index.tsx:72`). New classes use the `rub-call-*` / `rub-calib` prefixes.
- **Never render a zero calibration.** A factor with no verdicts, or an unreadable store, renders no calibration line. `0 wrong of 0 reviewed` reads as "undisputed" and is the failure this feature exists to prevent.
- Copyright header on every new file:
  ```ts
  // Copyright (c) 2026 NineMind, Inc.
  // SPDX-License-Identifier: MIT
  ```
- Commit trailer on every commit: `Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>`

---

### Task 1: Verdict types and rollup math

Pure module: no fs, no sqlite, no imports beyond types. This is where every counting rule lives so it can be tested without a database.

**Files:**
- Create: `packages/insight/src/rubricVerdicts.ts`
- Test: `src/__tests__/rubricVerdicts.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `VerdictValue`, `VERDICT_VALUES`, `NOTE_MAX`, `RubricVerdict`, `FactorCalibration`, `pairKey(sessionId, factorId): string`, `latestPerPair(rows: RubricVerdict[]): Map<string, RubricVerdict>`, `foldCalibration(rows: RubricVerdict[]): Map<string, FactorCalibration>`, `verdictsBySession(rows: RubricVerdict[]): Map<string, Record<string, RubricVerdict>>`.

- [ ] **Step 1: Write the failing test**

Create `src/__tests__/rubricVerdicts.test.ts`:

```ts
// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
import { describe, it, expect } from "vitest";
import { foldCalibration, latestPerPair, verdictsBySession, pairKey, type RubricVerdict } from "@agentgem/insight";

const v = (o: Partial<RubricVerdict> & { sessionId: string; factorId: string; verdict: RubricVerdict["verdict"]; atMs: number }): RubricVerdict =>
  ({ rubricId: "ship-discipline", ...o });

describe("rubricVerdicts", () => {
  it("keeps only the latest verdict per (session, factor) pair", () => {
    const rows = [
      v({ sessionId: "s1", factorId: "f1", verdict: "wrong", atMs: 100 }),
      v({ sessionId: "s1", factorId: "f1", verdict: "accepted", atMs: 200 }),
    ];
    const latest = latestPerPair(rows);
    expect(latest.size).toBe(1);
    expect(latest.get(pairKey("s1", "f1"))?.verdict).toBe("accepted");
  });

  it("resolves a same-millisecond rewrite in favour of the later row", () => {
    // The store returns rows ordered by (at_ms, id) ascending, so the last row wins.
    const rows = [
      v({ sessionId: "s1", factorId: "f1", verdict: "wrong", atMs: 100 }),
      v({ sessionId: "s1", factorId: "f1", verdict: "wontfix", atMs: 100 }),
    ];
    expect(latestPerPair(rows).get(pairKey("s1", "f1"))?.verdict).toBe("wontfix");
  });

  it("counts wrong and wontfix separately — they are different diagnoses", () => {
    const rows = [
      v({ sessionId: "s1", factorId: "f1", verdict: "wrong", atMs: 1 }),
      v({ sessionId: "s2", factorId: "f1", verdict: "wrong", atMs: 2 }),
      v({ sessionId: "s3", factorId: "f1", verdict: "wontfix", atMs: 3 }),
      v({ sessionId: "s4", factorId: "f1", verdict: "accepted", atMs: 4 }),
    ];
    expect(foldCalibration(rows).get("f1")).toEqual({ reviewed: 4, accepted: 1, wrong: 2, wontfix: 1 });
  });

  it("omits a factor with no verdicts rather than reporting zeroes", () => {
    // A zeroed row would render as "never disputed"; absence renders as no line at all.
    expect(foldCalibration([]).has("f1")).toBe(false);
  });

  it("counts a superseded verdict once, under its final value", () => {
    const rows = [
      v({ sessionId: "s1", factorId: "f1", verdict: "wrong", atMs: 1 }),
      v({ sessionId: "s1", factorId: "f1", verdict: "accepted", atMs: 2 }),
    ];
    expect(foldCalibration(rows).get("f1")).toEqual({ reviewed: 1, accepted: 1, wrong: 0, wontfix: 0 });
  });

  it("groups the latest verdicts by session for per-session decoration", () => {
    const rows = [
      v({ sessionId: "s1", factorId: "f1", verdict: "wrong", atMs: 1 }),
      v({ sessionId: "s1", factorId: "f2", verdict: "accepted", atMs: 2 }),
      v({ sessionId: "s2", factorId: "f1", verdict: "wontfix", atMs: 3 }),
    ];
    const bySession = verdictsBySession(rows);
    expect(Object.keys(bySession.get("s1")!).sort()).toEqual(["f1", "f2"]);
    expect(bySession.get("s2")!.f1.verdict).toBe("wontfix");
  });
});
```

- [ ] **Step 2: Run the test and verify it fails**

```bash
pnpm exec tsc -b && pnpm exec vitest run dist/__tests__/rubricVerdicts.test.js
```

Expected: the `tsc -b` step fails first, with `Module '"@agentgem/insight"' has no exported member 'foldCalibration'`. That is the correct failure — the module does not exist yet.

- [ ] **Step 3: Write the implementation**

Create `packages/insight/src/rubricVerdicts.ts`:

```ts
// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
// packages/insight/src/rubricVerdicts.ts
//
// The verdict record and its rollup math — types and pure functions only, no fs
// and no sqlite, so every counting rule is testable without a database. The store
// (rubricVerdictStore.ts) does IO and nothing else.
//
// A verdict is a person's call on one factor that fired against one session:
// `accepted` (real, acting on it), `wrong` (the factor mis-fired), or `wontfix`
// (it fired correctly, not acting). `wrong` and `wontfix` are deliberately NOT one
// value — `wrong` says the criterion is bad, `wontfix` says the criterion is right
// and its `advice` is not compelling. Those are different fixes, and one merged
// "dismissed" count answers neither question.
//
// Rows are append-only, so a pair can carry several rows and the latest wins.

/** A person's call on one fired factor. */
export type VerdictValue = "accepted" | "wrong" | "wontfix";

export const VERDICT_VALUES: readonly VerdictValue[] = ["accepted", "wrong", "wontfix"];

/** Max stored note length. Notes are human-authored and never leave the machine. */
export const NOTE_MAX = 500;

export interface RubricVerdict {
  sessionId: string;
  factorId: string;
  verdict: VerdictValue;
  note?: string;
  atMs: number;
  /** Provenance only — never part of the key. The same factor firing on the same
   *  session means the same thing in every rubric that includes it, so a verdict
   *  recorded under one rubric is visible from all of them. */
  rubricId: string;
}

/** All-time calibration for one factor. `reviewed` counts only pairs that carry a
 *  verdict — an untriaged fire is an unanswered question, never an implicit pass. */
export interface FactorCalibration {
  reviewed: number;
  accepted: number;
  wrong: number;
  wontfix: number;
}

// Written as an escape, not a literal NUL byte, so the source stays greppable —
// a stray control byte makes grep classify the file as binary and skip it (40089570).
const SEP = "\u0000";

/** The (session, factor) composite — the same key criterionJudge.ts uses to collapse
 *  duplicate fires. */
export function pairKey(sessionId: string, factorId: string): string {
  return `${sessionId}${SEP}${factorId}`;
}

/**
 * Collapse append-only rows to the current verdict per pair. `rows` MUST arrive in
 * ascending (atMs, id) order — the store's readers guarantee it — so a later row at
 * the same millisecond still wins.
 */
export function latestPerPair(rows: RubricVerdict[]): Map<string, RubricVerdict> {
  const out = new Map<string, RubricVerdict>();
  for (const r of rows) out.set(pairKey(r.sessionId, r.factorId), r);
  return out;
}

/**
 * Per-factor calibration over the current verdict of each pair. A factor with no
 * verdicts is ABSENT from the map rather than present with zeroes: the caller
 * renders nothing for an absent factor, and "0 wrong of 0 reviewed" would read as
 * a criterion nobody has ever disputed.
 */
export function foldCalibration(rows: RubricVerdict[]): Map<string, FactorCalibration> {
  const out = new Map<string, FactorCalibration>();
  for (const v of latestPerPair(rows).values()) {
    const c = out.get(v.factorId) ?? { reviewed: 0, accepted: 0, wrong: 0, wontfix: 0 };
    c.reviewed++;
    c[v.verdict]++;
    out.set(v.factorId, c);
  }
  return out;
}

/** The current verdict per factor, grouped by session — the shape the report's
 *  perSession rows carry so the console can render button state. */
export function verdictsBySession(rows: RubricVerdict[]): Map<string, Record<string, RubricVerdict>> {
  const out = new Map<string, Record<string, RubricVerdict>>();
  for (const v of latestPerPair(rows).values()) {
    const rec = out.get(v.sessionId) ?? {};
    rec[v.factorId] = v;
    out.set(v.sessionId, rec);
  }
  return out;
}
```

- [ ] **Step 4: Export it from the package barrel**

In `packages/insight/src/index.ts`, add alongside the other rubric exports:

```ts
export * from "./rubricVerdicts.js";
```

- [ ] **Step 5: Run the test and verify it passes**

```bash
pnpm exec tsc -b && pnpm exec vitest run dist/__tests__/rubricVerdicts.test.js
```

Expected: 6 passed.

- [ ] **Step 6: Commit**

```bash
git add packages/insight/src/rubricVerdicts.ts packages/insight/src/index.ts src/__tests__/rubricVerdicts.test.ts
git commit -m "feat(insight): add the verdict record and its rollup math

Pure types and folds, no fs, so every counting rule is testable without a
database. wrong and wontfix stay separate values: one says the criterion
is bad, the other says its advice is not compelling, and a merged
dismissed count answers neither.

A factor with no verdicts is absent from the calibration map rather than
zeroed — 0 wrong of 0 reviewed reads as undisputed.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: The verdict store

**Files:**
- Create: `packages/insight/src/rubricVerdictStore.ts`
- Modify: `packages/insight/src/index.ts` (one export line)
- Test: `src/__tests__/rubricVerdictStore.test.ts`

**Interfaces:**
- Consumes: `RubricVerdict`, `VerdictValue` from Task 1.
- Produces: `defaultRubricVerdictsDbPath(): string`, `openRubricVerdictStore(dataDir?: string): RubricVerdictStore` where `RubricVerdictStore = { recordVerdict(v: RubricVerdict): void; verdictRowsForFactors(factorIds: string[]): RubricVerdict[]; verdictRowsForSessions(sessionIds: string[]): RubricVerdict[]; close(): void }`. Both readers return rows ordered by `(at_ms, id)` ascending. `"memory://"` as `dataDir` opens an in-memory database.

- [ ] **Step 1: Write the failing test**

Create `src/__tests__/rubricVerdictStore.test.ts`:

```ts
// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { openRubricVerdictStore, foldCalibration, type RubricVerdict } from "@agentgem/insight";

const row = (o: Partial<RubricVerdict> & { sessionId: string; factorId: string; verdict: RubricVerdict["verdict"] }): RubricVerdict =>
  ({ atMs: 1000, rubricId: "ship-discipline", ...o });

function tmpDb(name = "verdicts.db"): string {
  return join(mkdtempSync(join(tmpdir(), "agentgem-verdicts-")), name);
}

describe("rubricVerdictStore", () => {
  it("round-trips a verdict", () => {
    const s = openRubricVerdictStore(tmpDb());
    s.recordVerdict(row({ sessionId: "s1", factorId: "f1", verdict: "wrong", note: "monorepo runs tests in CI" }));
    const rows = s.verdictRowsForFactors(["f1"]);
    expect(rows).toHaveLength(1);
    expect(rows[0].verdict).toBe("wrong");
    expect(rows[0].note).toBe("monorepo runs tests in CI");
    s.close();
  });

  it("returns rows in (at_ms, id) order so a same-millisecond rewrite wins", () => {
    const s = openRubricVerdictStore(tmpDb());
    s.recordVerdict(row({ sessionId: "s1", factorId: "f1", verdict: "wrong", atMs: 500 }));
    s.recordVerdict(row({ sessionId: "s1", factorId: "f1", verdict: "accepted", atMs: 500 }));
    expect(s.verdictRowsForFactors(["f1"]).map((r) => r.verdict)).toEqual(["wrong", "accepted"]);
    s.close();
  });

  it("returns a verdict recorded under one rubric when read for another", () => {
    // The key is (session, factor); rubricId is provenance only.
    const s = openRubricVerdictStore(tmpDb());
    s.recordVerdict(row({ sessionId: "s1", factorId: "no-verify-finish", verdict: "wrong", rubricId: "hygiene" }));
    const rows = s.verdictRowsForFactors(["no-verify-finish"]);
    expect(rows).toHaveLength(1);
    expect(rows[0].rubricId).toBe("hygiene");
    s.close();
  });

  it("filters by the requested factors and sessions", () => {
    const s = openRubricVerdictStore(tmpDb());
    s.recordVerdict(row({ sessionId: "s1", factorId: "f1", verdict: "wrong" }));
    s.recordVerdict(row({ sessionId: "s2", factorId: "f2", verdict: "accepted" }));
    expect(s.verdictRowsForFactors(["f1"]).map((r) => r.factorId)).toEqual(["f1"]);
    expect(s.verdictRowsForSessions(["s2"]).map((r) => r.sessionId)).toEqual(["s2"]);
    expect(s.verdictRowsForFactors([])).toEqual([]);
    s.close();
  });

  it("reopens an existing file without duplicating rows or columns", () => {
    const path = tmpDb();
    const a = openRubricVerdictStore(path);
    a.recordVerdict(row({ sessionId: "s1", factorId: "f1", verdict: "wrong" }));
    a.close();
    const b = openRubricVerdictStore(path);
    expect(b.verdictRowsForFactors(["f1"])).toHaveLength(1);
    b.recordVerdict(row({ sessionId: "s1", factorId: "f1", verdict: "accepted", atMs: 2000 }));
    expect(foldCalibration(b.verdictRowsForFactors(["f1"])).get("f1")).toEqual({ reviewed: 1, accepted: 1, wrong: 0, wontfix: 0 });
    b.close();
  });

  it("refuses to open an unknown schema version rather than misreading it", () => {
    const path = tmpDb("future.db");
    const db = new DatabaseSync(path);
    db.exec("CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT);");
    db.prepare("INSERT INTO meta(key,value) VALUES('schema_version','99')").run();
    db.close();
    expect(() => openRubricVerdictStore(path)).toThrow(/schema version '99'/);
  });

  it("refuses a path that cannot be opened", () => {
    const dir = mkdtempSync(join(tmpdir(), "agentgem-verdicts-"));
    writeFileSync(join(dir, "blocker"), "not a directory");
    // A file standing where a directory must be — mkdirSync fails, so the open fails.
    expect(() => openRubricVerdictStore(join(dir, "blocker", "verdicts.db"))).toThrow();
  });
});
```

- [ ] **Step 2: Run the test and verify it fails**

```bash
pnpm exec tsc -b && pnpm exec vitest run dist/__tests__/rubricVerdictStore.test.js
```

Expected: `tsc -b` fails with `has no exported member 'openRubricVerdictStore'`.

- [ ] **Step 3: Write the implementation**

Create `packages/insight/src/rubricVerdictStore.ts`:

```ts
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
// (at_ms, id) order and rubricVerdicts.latestPerPair collapses them. Nothing here
// counts or folds — that math is pure and lives next door.
import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { agentgemHome } from "@agentgem/model";
import type { RubricVerdict, VerdictValue } from "./rubricVerdicts.js";

const SCHEMA_VERSION = "1";

// Every schema version this build can read. A bump means appending the new version here AND
// migrating in place — this store must NEVER drop its table.
const KNOWN_SCHEMA_VERSIONS: ReadonlySet<string> = new Set([SCHEMA_VERSION]);

export function defaultRubricVerdictsDbPath(): string {
  return join(agentgemHome(), ".agentgem", "rubric-verdicts.db");
}

export interface RubricVerdictStore {
  /** Append one verdict. Throws on failure — a dropped verdict is user input lost. */
  recordVerdict(v: RubricVerdict): void;
  /** Every row for these factors, ascending by (at_ms, id). */
  verdictRowsForFactors(factorIds: string[]): RubricVerdict[];
  /** Every row for these sessions, ascending by (at_ms, id). */
  verdictRowsForSessions(sessionIds: string[]): RubricVerdict[];
  close(): void;
}

function placeholders(xs: unknown[]): string {
  return xs.map((_, i) => `?${i + 1}`).join(",");
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

export function openRubricVerdictStore(dataDir?: string): RubricVerdictStore {
  const target = dataDir ?? defaultRubricVerdictsDbPath();
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
    CREATE INDEX IF NOT EXISTS rubric_verdicts_pair   ON rubric_verdicts (session_id, factor_id);
    CREATE INDEX IF NOT EXISTS rubric_verdicts_factor ON rubric_verdicts (factor_id);
  `);

  const select = (column: "factor_id" | "session_id", keys: string[]): RubricVerdict[] => {
    if (!keys.length) return [];
    const rows = db.prepare(
      `SELECT session_id, factor_id, verdict, note, rubric_id, at_ms
       FROM rubric_verdicts
       WHERE ${column} IN (${placeholders(keys)})
       ORDER BY at_ms ASC, id ASC`,
    ).all(...keys) as unknown as Row[];
    return rows.map(toVerdict);
  };

  return {
    recordVerdict(v) {
      db.prepare(
        `INSERT INTO rubric_verdicts (session_id, factor_id, verdict, note, rubric_id, at_ms)
         VALUES (?1,?2,?3,?4,?5,?6)`,
      ).run(v.sessionId, v.factorId, v.verdict, v.note ?? null, v.rubricId, v.atMs);
    },
    verdictRowsForFactors(factorIds) { return select("factor_id", factorIds); },
    verdictRowsForSessions(sessionIds) { return select("session_id", sessionIds); },
    close() { db.close(); },
  };
}
```

- [ ] **Step 4: Export it from the package barrel**

In `packages/insight/src/index.ts`, add:

```ts
export * from "./rubricVerdictStore.js";
```

- [ ] **Step 5: Run the test and verify it passes**

```bash
pnpm exec tsc -b && pnpm exec vitest run dist/__tests__/rubricVerdictStore.test.js
```

Expected: 7 passed.

- [ ] **Step 6: Commit**

```bash
git add packages/insight/src/rubricVerdictStore.ts packages/insight/src/index.ts src/__tests__/rubricVerdictStore.test.ts
git commit -m "feat(insight): store rubric verdicts in their own sqlite file

Extends the argument artifactOutcomesStore makes against sharing
transcript-index.db. That store keeps LLM judgments out of a file whose
derived tables get dropped on a schema bump. A human verdict is the
least reproducible row here — it cost someone attention and no compute
regenerates it — so it gets its own file rather than riding along in a
store whose schema moves for unrelated reasons.

Append-only, readers ordered by (at_ms, id) so the fold next door can
resolve a same-millisecond rewrite. An unknown schema version is refused
loudly: CREATE TABLE IF NOT EXISTS is table-level, so column drift stays
invisible on fresh databases and only bites a long-lived file.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 3: Decorate the report, outside the cache

**Files:**
- Modify: `packages/insight/src/rubricReport.ts` (two optional fields on `RubricReport`)
- Modify: `packages/insight/src/detectors.ts` (one optional field on `DetectorSummary`)
- Modify: `packages/app/src/rubricCore.ts` (add `withVerdicts`, call it after `computeCached`, add `recordRubricVerdict`)
- Test: `src/__tests__/rubricVerdictDecorate.test.ts`

**Interfaces:**
- Consumes: `foldCalibration`, `verdictsBySession`, `openRubricVerdictStore`, `RubricVerdict` from Tasks 1-2.
- Produces: `DetectorSummary.calibration?: FactorCalibration`; `RubricReport["perSession"][number].verdicts?: Record<string, RubricVerdict>`; `withVerdicts(payload: RubricReport, dataDir?: string): RubricReport` (exported from `rubricCore.ts` for tests); `recordRubricVerdict(input: { sessionId: string; factorId: string; rubricId: string; verdict: VerdictValue; note?: string }, dataDir?: string): { ok: true; atMs: number }`.

- [ ] **Step 1: Write the failing test**

Create `src/__tests__/rubricVerdictDecorate.test.ts`:

```ts
// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
import { describe, it, expect } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { RubricReport } from "@agentgem/insight";
import { withVerdicts, recordRubricVerdict } from "../rubricCore.js";

function tmpDb(name = "verdicts.db"): string {
  return join(mkdtempSync(join(tmpdir(), "agentgem-decorate-")), name);
}

const baseReport = (): RubricReport => ({
  rubricId: "ship-discipline",
  target: "overview",
  scope: "session",
  factors: [
    { id: "committed-without-tests", title: "Committed without running the tests", advice: "Run the tests first.", severity: "warn", count: 1, sessions: 1 },
    { id: "no-verify-finish", title: "Finished without verifying", advice: "Verify before finishing.", severity: "info", count: 0, sessions: 0 },
  ],
  sessionsScanned: 1,
  clean: false,
  degraded: false,
  skippedFactors: [],
  perSession: [{ sessionId: "s1", transcript: "/tmp/s1.jsonl", factors: [] }],
});

describe("withVerdicts", () => {
  it("decorates a factor with its all-time calibration", () => {
    const db = tmpDb();
    recordRubricVerdict({ sessionId: "s1", factorId: "committed-without-tests", rubricId: "ship-discipline", verdict: "wrong" }, db);
    recordRubricVerdict({ sessionId: "s2", factorId: "committed-without-tests", rubricId: "ship-discipline", verdict: "accepted" }, db);
    const out = withVerdicts(baseReport(), db);
    expect(out.factors[0].calibration).toEqual({ reviewed: 2, accepted: 1, wrong: 1, wontfix: 0 });
  });

  it("leaves a factor with no verdicts undecorated rather than zeroed", () => {
    const out = withVerdicts(baseReport(), tmpDb());
    expect(out.factors[0].calibration).toBeUndefined();
    expect(out.factors[1].calibration).toBeUndefined();
  });

  it("attaches the current verdict to the matching per-session row", () => {
    const db = tmpDb();
    recordRubricVerdict({ sessionId: "s1", factorId: "committed-without-tests", rubricId: "ship-discipline", verdict: "wontfix", note: "spike branch" }, db);
    const out = withVerdicts(baseReport(), db);
    expect(out.perSession![0].verdicts!["committed-without-tests"].verdict).toBe("wontfix");
    expect(out.perSession![0].verdicts!["committed-without-tests"].note).toBe("spike branch");
  });

  it("degrades to no calibration when the store cannot be read, never to zero", () => {
    const path = tmpDb("future.db");
    const db = new DatabaseSync(path);
    db.exec("CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT);");
    db.prepare("INSERT INTO meta(key,value) VALUES('schema_version','99')").run();
    db.close();
    const out = withVerdicts(baseReport(), path);
    expect(out.factors[0].calibration).toBeUndefined();
    expect(out.factors).toHaveLength(2);           // findings intact
    expect(out.perSession![0].verdicts).toBeUndefined();
  });

  it("never alters the report's own honesty fields", () => {
    const db = tmpDb();
    recordRubricVerdict({ sessionId: "s1", factorId: "committed-without-tests", rubricId: "ship-discipline", verdict: "wrong" }, db);
    const before = baseReport();
    const after = withVerdicts(before, db);
    expect(after.clean).toBe(before.clean);
    expect(after.degraded).toBe(before.degraded);
    expect(after.sessionsScanned).toBe(before.sessionsScanned);
    expect(after.factors.map((f) => f.count)).toEqual(before.factors.map((f) => f.count));
  });
});
```

- [ ] **Step 2: Run the test and verify it fails**

```bash
pnpm exec tsc -b && pnpm exec vitest run dist/__tests__/rubricVerdictDecorate.test.js
```

Expected: `tsc -b` fails with `Module '"../rubricCore.js"' has no exported member 'withVerdicts'`.

- [ ] **Step 3: Add the two optional report fields**

In `packages/insight/src/detectors.ts`, inside `interface DetectorSummary` (after `judgedSessions?: number;` at line 278):

```ts
  // All-time human calibration for this factor, decorated by the caller AFTER
  // evaluation (rubricCore.withVerdicts) — evaluateRubric has no fs access. ABSENT
  // when the factor has no verdicts or the store could not be read: a zeroed
  // calibration would read as "nobody has ever disputed this".
  calibration?: FactorCalibration;
```

Add the import at the top of `detectors.ts`:

```ts
import type { FactorCalibration } from "./rubricVerdicts.js";
```

In `packages/insight/src/rubricReport.ts`, extend the `perSession` element type on `interface RubricReport` (line 48):

```ts
  perSession?: {
    sessionId: string; transcript: string; factors: DetectorSummary[]; hygiene?: HygieneVerdict;
    // The current verdict per factor for this session, decorated by rubricCore.
    verdicts?: Record<string, RubricVerdict>;
  }[];
```

and add to its imports:

```ts
import type { RubricVerdict } from "./rubricVerdicts.js";
```

- [ ] **Step 4: Add `withVerdicts` and `recordRubricVerdict` to `rubricCore.ts`**

Add to the imports in `packages/app/src/rubricCore.ts`:

```ts
import {
  openRubricVerdictStore, foldCalibration, verdictsBySession,
  type RubricVerdict, type VerdictValue,
} from "@agentgem/insight";
```

Then, next to `computeRubric`:

```ts
/**
 * Decorate a report with human verdicts: all-time calibration per factor, and the
 * current verdict per factor on each per-session row.
 *
 * Called on the RESULT of computeCached, never inside its `compute` closure —
 * computeRubric writes its payload to the analysis cache, so decorating inside
 * would bake verdicts into a cached report and a new verdict would stay invisible
 * until the cache turned over. Out here, verdicts are always fresh and the cached
 * artifact stays a pure analysis result.
 *
 * A read failure degrades to NO calibration (never to zero) and never disturbs the
 * findings: "0 wrong of 0 reviewed" would read as a criterion nobody has disputed,
 * which is the opposite of "we could not check".
 */
export function withVerdicts(payload: RubricReport, dataDir?: string): RubricReport {
  let store: ReturnType<typeof openRubricVerdictStore> | null = null;
  try {
    store = openRubricVerdictStore(dataDir);
    const calibration = foldCalibration(store.verdictRowsForFactors(payload.factors.map((f) => f.id)));
    const factors = payload.factors.map((f) => {
      const c = calibration.get(f.id);
      return c ? { ...f, calibration: c } : f;
    });

    let perSession = payload.perSession;
    if (perSession?.length) {
      const bySession = verdictsBySession(store.verdictRowsForSessions(perSession.map((s) => s.sessionId)));
      perSession = perSession.map((s) => {
        const v = bySession.get(s.sessionId);
        return v ? { ...s, verdicts: v } : s;
      });
    }
    return { ...payload, factors, ...(perSession ? { perSession } : {}) };
  } catch (err) {
    log.warn("rubric verdicts: calibration unavailable, report unaffected: %s", (err as Error)?.message ?? err);
    return payload;
  } finally {
    try { store?.close(); } catch { /* ignore */ }
  }
}

/**
 * Append one verdict. Throws on failure so the route answers non-2xx: a verdict is
 * user input, and silently dropping it is the one unrecoverable bug here — the
 * person believes their call was recorded. This deliberately differs from
 * reflectionStore's best-effort write, which is right for a derived signal.
 *
 * `atMs` is assigned HERE, never taken from the client.
 */
export function recordRubricVerdict(
  input: { sessionId: string; factorId: string; rubricId: string; verdict: VerdictValue; note?: string },
  dataDir?: string,
  now: () => number = Date.now,
): { ok: true; atMs: number } {
  const atMs = now();
  const store = openRubricVerdictStore(dataDir);
  try {
    const v: RubricVerdict = { ...input, atMs };
    store.recordVerdict(v);
    return { ok: true, atMs };
  } finally {
    try { store.close(); } catch { /* ignore */ }
  }
}
```

Confirm `log` and `RubricReport` are already imported in `rubricCore.ts`; if `RubricReport` is not, add it to the existing `@agentgem/insight` type import.

- [ ] **Step 5: Wire the decoration into `computeRubric`**

In `packages/app/src/rubricCore.ts`, change the `return computeCached<RubricReport>({ ... })` at line 192 so the result is decorated on the way out:

```ts
  const result = await computeCached<RubricReport>({
    token, force: opts.force, now,
    read: (t) => readAnalysisCacheEntry(RUBRIC_CACHE_ROOT, t) as CacheHit<RubricReport> | null,
    write: (t, payload, ts) => writeAnalysisCache(RUBRIC_CACHE_ROOT, t, payload, ts),
    degraded: (p) => p.degraded,
    compute: async () => {
      /* ...body unchanged... */
    },
  });
  // Decorate AFTER the cache: verdicts must never be cached (see withVerdicts).
  return { ...result, payload: withVerdicts(result.payload) };
```

- [ ] **Step 6: Run the test and verify it passes**

```bash
pnpm exec tsc -b && pnpm exec vitest run dist/__tests__/rubricVerdictDecorate.test.js
```

Expected: 5 passed.

- [ ] **Step 7: Run the neighbouring suites for regressions**

```bash
pnpm exec vitest run dist/__tests__/rubricCore.test.js dist/__tests__/rubricReport.test.js dist/__tests__/rubrics.test.js
```

Expected: all pass, unchanged.

- [ ] **Step 8: Commit**

```bash
git add packages/insight/src/detectors.ts packages/insight/src/rubricReport.ts packages/app/src/rubricCore.ts src/__tests__/rubricVerdictDecorate.test.ts
git commit -m "feat(app): decorate rubric reports with verdicts outside the cache

computeRubric writes its payload to the analysis cache, so decorating
inside the compute closure would bake verdicts into a cached report and
a new verdict would stay invisible until the cache turned over.
Decorating the returned result keeps verdicts fresh and leaves the
cached artifact a pure analysis result.

A store read failure degrades to no calibration and never to zero: 0
wrong of 0 reviewed reads as a criterion nobody has disputed, which is
the opposite of we could not check. Writes throw instead — a dropped
verdict is user input lost, and the person believes it was recorded.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 4: The write route

**Files:**
- Modify: `packages/app/src/rubric.stream.schema.ts` (two schemas)
- Modify: `packages/app/src/rubric.controller.ts` (one route)
- Test: `src/__tests__/rubricVerdictRoute.test.ts`

**Interfaces:**
- Consumes: `recordRubricVerdict` from Task 3.
- Produces: `RubricVerdictBody`, `RubricVerdictResponse` (exported from `rubric.stream.schema.ts`); `POST /api/rubric/verdict`; `RubricController.verdict(input)`.

- [ ] **Step 1: Write the failing test**

Create `src/__tests__/rubricVerdictRoute.test.ts`:

```ts
// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
import { describe, it, expect } from "vitest";
import { RubricVerdictBody } from "../rubric.stream.schema.js";

describe("RubricVerdictBody", () => {
  it("accepts a well-formed verdict", () => {
    const r = RubricVerdictBody.safeParse({
      sessionId: "s1", factorId: "committed-without-tests",
      rubricId: "ship-discipline", verdict: "wrong", note: "CI runs them",
    });
    expect(r.success).toBe(true);
  });

  it("rejects an unknown verdict value", () => {
    const r = RubricVerdictBody.safeParse({
      sessionId: "s1", factorId: "f1", rubricId: "r1", verdict: "dismissed",
    });
    expect(r.success).toBe(false);
  });

  it("rejects a client-supplied atMs rather than silently ignoring it", () => {
    // Server-assigned only. .strict() turns a stale client into a 422, not a lie
    // about when the call was made.
    const r = RubricVerdictBody.safeParse({
      sessionId: "s1", factorId: "f1", rubricId: "r1", verdict: "accepted", atMs: 5,
    });
    expect(r.success).toBe(false);
  });

  it("rejects an over-long note", () => {
    const r = RubricVerdictBody.safeParse({
      sessionId: "s1", factorId: "f1", rubricId: "r1", verdict: "accepted", note: "x".repeat(501),
    });
    expect(r.success).toBe(false);
  });

  it("rejects blank identifiers", () => {
    expect(RubricVerdictBody.safeParse({ sessionId: "", factorId: "f1", rubricId: "r1", verdict: "accepted" }).success).toBe(false);
    expect(RubricVerdictBody.safeParse({ sessionId: "s1", factorId: "", rubricId: "r1", verdict: "accepted" }).success).toBe(false);
  });
});
```

- [ ] **Step 2: Run the test and verify it fails**

```bash
pnpm exec tsc -b && pnpm exec vitest run dist/__tests__/rubricVerdictRoute.test.js
```

Expected: `tsc -b` fails with `has no exported member 'RubricVerdictBody'`.

- [ ] **Step 3: Add the schemas**

Append to `packages/app/src/rubric.stream.schema.ts`:

```ts
/**
 * Body for POST /api/rubric/verdict. STRICT, unlike the deliberately permissive
 * /rubrics and /rubrics/validate bodies — those accept an arbitrary editor draft so
 * the endpoint can describe what is wrong. There is no draft here: a malformed
 * verdict is a client bug and 422 is the right answer. `atMs` is server-assigned,
 * so sending one is rejected rather than ignored.
 */
export const RubricVerdictBody = z.object({
  sessionId: z.string().min(1),
  factorId: z.string().min(1),
  rubricId: z.string().min(1),
  verdict: z.enum(["accepted", "wrong", "wontfix"]),
  note: z.string().max(500).optional(),
}).strict();
export type RubricVerdictBody = z.infer<typeof RubricVerdictBody>;

export const RubricVerdictResponse = z.object({ ok: z.literal(true), atMs: z.number() });
export type RubricVerdictResponse = z.infer<typeof RubricVerdictResponse>;
```

- [ ] **Step 4: Add the route**

In `packages/app/src/rubric.controller.ts`, add `recordRubricVerdict` to the existing `./rubricCore.js` import and `RubricVerdictBody, RubricVerdictResponse` to the existing `./rubric.stream.schema.js` import. Then add as the last method of `RubricController`:

```ts
  // POST /api/rubric/verdict — record one human call on a fired factor. Write
  // failures propagate: a dropped verdict is user input lost, and the console must
  // be able to tell the person their call did not stick.
  @post("/rubric/verdict", { body: RubricVerdictBody, response: RubricVerdictResponse })
  async verdict(input: { body: z.infer<typeof RubricVerdictBody> }): Promise<z.infer<typeof RubricVerdictResponse>> {
    return recordRubricVerdict(input.body);
  }
```

- [ ] **Step 5: Run the test and verify it passes**

```bash
pnpm exec tsc -b && pnpm exec vitest run dist/__tests__/rubricVerdictRoute.test.js dist/__tests__/rubric.controller.test.js
```

Expected: 5 new tests pass; the existing controller suite is unchanged.

- [ ] **Step 6: Commit**

```bash
git add packages/app/src/rubric.stream.schema.ts packages/app/src/rubric.controller.ts src/__tests__/rubricVerdictRoute.test.ts
git commit -m "feat(app): add POST /api/rubric/verdict

Strict body, unlike the permissive /rubrics drafts next to it: those
accept an arbitrary editor draft so the endpoint can describe what is
wrong, but there is no draft here and a malformed verdict is a client
bug. atMs is server-assigned, so a client-supplied one is rejected
rather than ignored — a stale client should 422, not misdate the call.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 5: Console controls and the calibration line

Verdict buttons appear only on a **fired** factor row at **session scope** — that is the only place a row maps to exactly one session, so the only place a `(sessionId, factorId)` key is unambiguous. The calibration line appears on every row at every scope, since it is all-time.

**Files:**
- Modify: `packages/console/src/panels/Rubrics/rubricStream.ts` (view types + POST route)
- Modify: `packages/console/src/panels/Rubrics/index.tsx` (`FactorRow`, `RubricReportCard`)
- Modify: `packages/console/src/shell/theme.css` (five rules)
- Test: `packages/console/src/panels/Rubrics/__tests__/verdictControls.test.tsx`

**Interfaces:**
- Consumes: `POST /api/rubric/verdict` from Task 4; `calibration` / `verdicts` fields from Task 3.
- Produces: `VerdictValueView`, `FactorCalibrationView`, `postRubricVerdict(client, body): Promise<{ ok: true; atMs: number }>`, `calibrationLine(c: FactorCalibrationView): string`.

- [ ] **Step 1: Write the failing test**

Create `packages/console/src/panels/Rubrics/__tests__/verdictControls.test.tsx`:

```tsx
// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { RubricReportCard } from "../index.js";
import { calibrationLine } from "../rubricStream.js";
import type { RubricReportView } from "../rubricStream.js";

const report = (over: Partial<RubricReportView> = {}): RubricReportView => ({
  rubricId: "ship-discipline",
  target: "overview",
  scope: "session",
  factors: [
    { id: "committed-without-tests", title: "Committed without running the tests", advice: "Run the tests first.", severity: "warn", count: 1, sessions: 1 },
    { id: "no-verify-finish", title: "Finished without verifying", advice: "Verify before finishing.", severity: "info", count: 0, sessions: 0 },
  ],
  sessionsScanned: 1,
  clean: false,
  degraded: false,
  skippedFactors: [],
  perSession: [{ sessionId: "s1", transcript: "/tmp/s1.jsonl", factors: [] }],
  ...over,
});

describe("verdict controls", () => {
  it("offers the three calls on a fired factor at session scope", () => {
    render(<RubricReportCard report={report()} sessionId="s1" />);
    expect(screen.getByRole("button", { name: /accepted/i })).toBeTruthy();
    expect(screen.getByRole("button", { name: /wrong/i })).toBeTruthy();
    expect(screen.getByRole("button", { name: /won't fix/i })).toBeTruthy();
  });

  it("offers no call on a factor that did not fire — there is nothing to judge", () => {
    render(<RubricReportCard report={report()} sessionId="s1" />);
    // Exactly one fired row, so exactly one set of three buttons.
    expect(screen.getAllByRole("button", { name: /wrong/i })).toHaveLength(1);
  });

  it("offers no call at project scope, where a row spans many sessions", () => {
    render(<RubricReportCard report={report({ scope: "project" })} />);
    expect(screen.queryByRole("button", { name: /wrong/i })).toBeNull();
  });

  it("marks the current verdict as pressed", () => {
    const r = report();
    r.perSession![0].verdicts = { "committed-without-tests": { verdict: "wontfix", atMs: 1, sessionId: "s1", factorId: "committed-without-tests", rubricId: "ship-discipline" } };
    render(<RubricReportCard report={r} sessionId="s1" />);
    expect(screen.getByRole("button", { name: /won't fix/i }).getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByRole("button", { name: /^wrong/i }).getAttribute("aria-pressed")).toBe("false");
  });

  it("renders the calibration line only when there are verdicts", () => {
    const r = report();
    r.factors[0].calibration = { reviewed: 10, accepted: 1, wrong: 9, wontfix: 0 };
    render(<RubricReportCard report={r} sessionId="s1" />);
    expect(screen.getByText(/9 of 10 reviewed/i)).toBeTruthy();
    expect(screen.queryByText(/0 of 0/)).toBeNull();
  });

  it("states the rate against reviewed calls, never against all fires", () => {
    expect(calibrationLine({ reviewed: 10, accepted: 1, wrong: 9, wontfix: 0 }))
      .toBe("called wrong in 9 of 10 reviewed calls");
    expect(calibrationLine({ reviewed: 4, accepted: 1, wrong: 0, wontfix: 3 }))
      .toBe("accepted in 1 of 4 reviewed calls · 3 won't fix");
  });
});
```

- [ ] **Step 2: Run the test and verify it fails**

```bash
pnpm --filter @agentgem/console test -- verdictControls
```

Expected: FAIL — `calibrationLine` is not exported, and `RubricReportCard` takes no `sessionId` prop.

- [ ] **Step 3: Extend the view types and add the client route**

In `packages/console/src/panels/Rubrics/rubricStream.ts`, add to `RubricFactorView`:

```ts
  // All-time human calibration. Absent when the factor has no verdicts, or the
  // store could not be read — never present with zeroes.
  calibration?: FactorCalibrationView;
```

and above it:

```ts
export type VerdictValueView = "accepted" | "wrong" | "wontfix";
export interface FactorCalibrationView { reviewed: number; accepted: number; wrong: number; wontfix: number }
export interface VerdictView {
  sessionId: string; factorId: string; rubricId: string;
  verdict: VerdictValueView; note?: string; atMs: number;
}
```

Extend the `perSession` element in `RubricReportView`:

```ts
  perSession?: {
    sessionId: string; transcript: string; factors: RubricFactorView[]; hygiene?: HygieneVerdictView;
    verdicts?: Record<string, VerdictView>;
  }[];
```

Append the route and the copy helper:

```ts
const rubricVerdictRoute = defineRoute("POST", "/api/rubric/verdict", {
  body: z.object({
    sessionId: z.string(),
    factorId: z.string(),
    rubricId: z.string(),
    verdict: z.enum(["accepted", "wrong", "wontfix"]),
    note: z.string().optional(),
  }),
  response: z.object({ ok: z.literal(true), atMs: z.number() }),
});

/** Record one verdict. Rejects on a non-2xx so the caller can show the row unsaved. */
export function postRubricVerdict(
  client: Client,
  body: { sessionId: string; factorId: string; rubricId: string; verdict: VerdictValueView; note?: string },
): Promise<{ ok: true; atMs: number }> {
  return rubricVerdictRoute.call(client, { body });
}

/**
 * The calibration sentence. The denominator is REVIEWED calls, never total fires:
 * an untriaged fire is an unanswered question, and folding it in as an implicit
 * pass is the same unfalsifiable silence the judge's roster contract exists to
 * close. Callers must not render this for a factor with no calibration.
 */
export function calibrationLine(c: FactorCalibrationView): string {
  const head = c.wrong >= c.accepted
    ? `called wrong in ${c.wrong} of ${c.reviewed} reviewed calls`
    : `accepted in ${c.accepted} of ${c.reviewed} reviewed calls`;
  return c.wontfix > 0 ? `${head} · ${c.wontfix} won't fix` : head;
}
```

- [ ] **Step 4: Render the controls**

In `packages/console/src/panels/Rubrics/index.tsx`, replace `FactorRow` (lines 46-62) with:

```tsx
const VERDICT_LABELS: { value: VerdictValueView; label: string }[] = [
  { value: "accepted", label: "Accepted" },
  { value: "wrong", label: "Wrong" },
  { value: "wontfix", label: "Won't fix" },
];

function FactorRow({ f, sessionId, rubricId, current, onRecord }: {
  f: RubricFactorView;
  // Present only at session scope, where this row maps to exactly one session and a
  // (sessionId, factorId) verdict key is unambiguous.
  sessionId?: string;
  rubricId: string;
  current?: VerdictValueView;
  onRecord?: (factorId: string, verdict: VerdictValueView) => void;
}) {
  const fired = f.count > 0;
  // A check that never applied is neither a pass nor a problem — don't give it the tick.
  const inapplicable = f.applicableSessions === 0;
  const icon = inapplicable ? "–" : !fired ? "✓" : f.severity === "warn" ? "⚠" : "ℹ";
  const cls = inapplicable ? "rub-na" : !fired ? "rub-ok" : f.severity === "warn" ? "rub-warn" : "rub-info";
  // No call to make on a row that did not fire.
  const canCall = fired && !!sessionId && !!onRecord;
  return (
    <li className={"rub-factor " + cls}>
      <div className="rub-factor-head">
        <span className="rub-icon" aria-hidden="true">{icon}</span>
        <span className="analyze-include-name">{f.title}</span>
        <span className="targets-label" style={{ marginLeft: "auto" }}>{factorTally(f)}</span>
      </div>
      {fired && <p className="rub-advice">→ {f.advice}</p>}
      {f.calibration && <p className="rub-calib">{calibrationLine(f.calibration)}</p>}
      {canCall && (
        <div className="rub-call-actions" role="group" aria-label={`Your call on ${f.title}`}>
          {VERDICT_LABELS.map(({ value, label }) => (
            <button
              key={value}
              type="button"
              className={"rub-call-btn" + (current === value ? " is-on" : "")}
              aria-pressed={current === value}
              onClick={() => onRecord!(f.id, value)}
            >{label}</button>
          ))}
        </div>
      )}
    </li>
  );
}
```

Add to the imports at the top of the file:

```tsx
import { calibrationLine, postRubricVerdict, type VerdictValueView } from "./rubricStream.js";
```

(extend the existing `./rubricStream.js` import rather than adding a second one), plus `useState` from the existing React/Preact import if it is not already there.

Then change `RubricReportCard` to take the selected session and own the write:

```tsx
export function RubricReportCard({ report, sessionId, client }: {
  report: RubricReportView;
  sessionId?: string;
  client?: Client;
}) {
  const total = report.factors.length;
  const actionable = report.factors.filter((f) => f.count > 0).length;
  const affected = report.perSession?.length ?? 0;
  const cov = report.judgeCoverage;
  // Verdicts are only unambiguous at session scope (see FactorRow).
  const callable = report.scope === "session" ? sessionId : undefined;
  const stored = report.perSession?.find((s) => s.sessionId === callable)?.verdicts;
  const [calls, setCalls] = useState<Record<string, VerdictValueView>>({});
  const [failed, setFailed] = useState<string | null>(null);

  const record = (factorId: string, verdict: VerdictValueView) => {
    if (!callable || !client) return;
    const prev = calls[factorId];
    setCalls((c) => ({ ...c, [factorId]: verdict }));   // optimistic
    setFailed(null);
    postRubricVerdict(client, { sessionId: callable, factorId, rubricId: report.rubricId, verdict })
      .catch(() => {
        // A dropped verdict is user input lost — roll back and say so rather than
        // leaving the button looking saved.
        setCalls((c) => { const n = { ...c }; if (prev) n[factorId] = prev; else delete n[factorId]; return n; });
        setFailed(factorId);
      });
  };
  /* ...verdict line / coverage hints / hygiene / degraded block unchanged... */
```

and the factor list:

```tsx
      <ul className="rub-factors">
        {report.factors.map((f) => (
          <FactorRow
            key={f.id}
            f={f}
            sessionId={callable}
            rubricId={report.rubricId}
            current={calls[f.id] ?? stored?.[f.id]?.verdict}
            onRecord={client ? record : undefined}
          />
        ))}
      </ul>
      {failed && <p className="insights-hint">That call was not saved — check the console log and try again.</p>}
```

Update the call site of `RubricReportCard` further down the panel to pass the panel's existing selected-session state and its `client`.

- [ ] **Step 5: Add the CSS**

In `packages/console/src/shell/theme.css`, next to the existing `.rub-*` rules. Note `.rub-verdict` is already taken by the report summary line — these use `rub-call-*` / `rub-calib`:

```css
.rub-calib {
  margin: 2px 0 0 26px;
  font-size: 12px;
  color: var(--ink-3);
}
.rub-call-actions {
  display: flex;
  gap: 6px;
  margin: 6px 0 0 26px;
}
.rub-call-btn {
  padding: 2px 10px;
  font: inherit;
  font-size: 12px;
  color: var(--ink-2);
  background: var(--surface-2);
  border: 1px solid var(--line);
  border-radius: 999px;
  cursor: pointer;
}
.rub-call-btn:hover { color: var(--ink-1); border-color: var(--line-2); }
.rub-call-btn.is-on {
  color: var(--ink-1);
  background: var(--surface-3);
  border-color: var(--brand);
}
```

Confirm each `var(--…)` token exists in `theme.css` before using it; substitute the nearest sibling token if one does not (match `.rub-advice` and `.ws-chip`, which style the same kind of secondary text and pill).

- [ ] **Step 6: Verify every new class has a rule**

```bash
for c in rub-calib rub-call-actions rub-call-btn; do
  printf '%s: ' "$c"; grep -c "\.$c" packages/console/src/shell/theme.css
done
```

Expected: each count is at least 1.

- [ ] **Step 7: Run the tests and verify they pass**

```bash
pnpm --filter @agentgem/console test -- verdictControls
pnpm --filter @agentgem/console typecheck
```

Expected: 6 passed, typecheck clean.

- [ ] **Step 8: Commit**

```bash
git add packages/console/src/panels/Rubrics/ packages/console/src/shell/theme.css
git commit -m "feat(console): record a verdict on a fired factor at session scope

Buttons appear only on a fired row at session scope — the only place a
factor row maps to exactly one session, so the only place a (session,
factor) key is unambiguous. A passing row gets none: there is no call to
make. The calibration line shows at every scope because it is all-time.

The rate reads against reviewed calls, never total fires. An untriaged
fire is an unanswered question, and counting it as an implicit pass is
the same unfalsifiable silence the judge's roster contract closes.

A failed write rolls the button back and says so rather than leaving it
looking saved.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 6: Full verification and PR

**Files:** none changed unless a failure turns one up.

- [ ] **Step 1: Run the whole root suite**

```bash
pnpm test
```

Expected: green. If anything fails, check whether it failed before your branch (`git stash && pnpm test`) and say so explicitly rather than absorbing a pre-existing failure into this work.

- [ ] **Step 2: Run the console suites**

```bash
pnpm --filter @agentgem/console test
pnpm --filter @agentgem/console typecheck
```

- [ ] **Step 3: Verify in a real browser**

jsdom asserts behavior and never appearance, and the CLAUDE.md UI rule exists because unstyled classes ship as "unstyled UI". Use the `verify` skill to launch the console, then:

1. Rubrics → pick `ship-discipline` → scope **session** → pick a session that fires a factor.
2. Confirm the three buttons render as styled pills, not raw gray browser buttons.
3. Click **Wrong**; confirm the pressed state.
4. Re-run the rubric (the **Re-run** control) and confirm the verdict survives — this is the cache check from Task 3: a verdict must be visible on a *cached* report.
5. Confirm the calibration line appears and reads `… of … reviewed calls`.
6. Switch scope to **project** and confirm no buttons render, but the calibration line still does.

- [ ] **Step 4: Confirm the branch is ahead of `origin/main` only**

```bash
git fetch origin && git log --oneline origin/main..HEAD && git log --oneline HEAD..origin/main
```

Expected: your commits listed; the second command empty or only unrelated trunk movement.

- [ ] **Step 5: Open the PR**

```bash
git push -u origin rubric-verdict-capture
gh pr create --title "feat: capture human verdicts on rubric findings and calibrate criteria" --body "$(cat <<'EOF'
Rubric findings have always flowed one way. A fire read and judged wrong produced the same noise next run, and nothing could tell a criterion that catches real problems from one that cries wolf.

This adds the missing half: a person records `accepted` / `wrong` / `wontfix` on a factor that fired against a session, and the rate comes back as per-criterion calibration.

- `wrong` and `wontfix` stay separate — one says the criterion is bad, the other says its advice is not compelling. Different fixes.
- Findings are never suppressed. Hiding one would let a person quietly shrink a denominator, the failure the judge's roster contract exists to prevent.
- The denominator counts reviewed calls only. A factor with no verdicts renders no rate; an unreadable store degrades to absent, never to zero.
- Verdicts decorate the report *after* the analysis cache, so a new call shows on a cached report.

Spec: `docs/superpowers/specs/2026-08-08-rubric-verdict-capture-design.md`
Plan: `docs/superpowers/plans/2026-08-08-rubric-verdict-capture.md`

v1 is session scope only — the console has no per-session factor row to attach a call to at project/all scope. That list is the named follow-up.

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

- [ ] **Step 6: Watch CI and merge**

```bash
gh run watch <run-id> --exit-status
gh run view <run-id> --json conclusion    # verify conclusion=success; watch can exit 0 on failure
gh pr merge --rebase --delete-branch
```

`--delete-branch` errors on the local delete because `main` is checked out in another worktree; the remote merge still succeeds. Verify with `git fetch && git log --oneline origin/main | head`, and confirm a marker from **every** commit is on `origin/main` — partial merges have bitten this repo twice.

---

## Self-Review

**Spec coverage:** §2 data model → Tasks 1, 3. §3 store → Task 2. §4 honest denominator → Task 1 (`foldCalibration` omits empty), Task 5 (`calibrationLine`). §5 read path → Task 3; write route → Task 4; console → Task 5. §6 "what it does not do" → enforced by Task 3 Step 6's honesty-fields test and Task 5's project-scope test. §7 error handling → Task 3 (read degrades, write throws), Task 5 (rollback on failure). §8 testing → Tasks 1-5 plus Task 6 Step 3. §9 out of scope → nothing implements it, correctly.

**Type consistency:** `FactorCalibration` (server) ↔ `FactorCalibrationView` (console mirror, same four fields, mirrored because the console cannot import root `src/` — the same reason `RubricFactorView` mirrors `DetectorSummary`). `RubricVerdict` ↔ `VerdictView`, same fields. `VerdictValue` ↔ `VerdictValueView`, same union. `withVerdicts` / `recordRubricVerdict` / `postRubricVerdict` / `calibrationLine` are each defined once and referenced with matching signatures.

**Known soft spot:** Task 5 Step 4 shows the changed regions of `index.tsx` rather than the whole 442-line file. The unchanged middle of `RubricReportCard` (verdict line, coverage hints, hygiene, degraded block, per-session tail, skipped factors) is marked with a comment and must be preserved verbatim. Read the file before editing.
