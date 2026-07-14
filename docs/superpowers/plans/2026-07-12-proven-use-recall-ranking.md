# Proven-use Recall Ranking Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Persist the `{artifact, session, outcome}` triple that `scanWorkflow` + `judgeSessions` already compute and discard, then read it back as an α-capped boost on `recall`'s BM25 ranking.

**Architecture:** A pure Wilson-score module and a session×outcome join (both in `@agentgem/insight`), a dedicated local SQLite store `~/.agentgem/artifact-outcomes.db` written on the insights judge pass, and an optional injected proven-use lookup that re-ranks `RecallIndex.search()` results. Byte-derived data (transcript-index) and judgment-derived data (outcomes) stay in separate stores with opposite lifecycles.

**Tech Stack:** TypeScript (ESM, `.js` import specifiers), `node:sqlite` (`DatabaseSync`), vitest, pnpm workspace.

## Global Constraints

- **Design source:** `docs/superpowers/specs/2026-07-12-proven-use-recall-ranking-design.md`. Every task implements part of it.
- **Branch:** `feat/proven-use-recall-ranking` (already checked out).
- **License header** on every new file, verbatim:
  ```
  // Copyright (c) 2026 NineMind, Inc.
  // SPDX-License-Identifier: MIT
  ```
- **Imports use `.js` specifiers** even for `.ts` files (ESM/NodeNext), matching the codebase.
- **Test runner:** `pnpm --filter @agentgem/<pkg> test` (vitest). SQLite tests use the `"memory://"` sentinel, never a real home dir.
- **Coverage v1:** skills + subagents only (the two `SkillAgentEvent.kind` values). No mcp_server/hook, no gem-verification, no cross-user, no lift, no recency decay.
- **Named constants, not magic numbers:** `PARTIAL_CREDIT = 0.5`, `ALPHA = 0.3`, Wilson `z = 1.96`.
- **Never drop the outcomes store on a schema bump** — it holds irreplaceable LLM judgments.

---

## Review Amendments (plan-eng-review, 2026-07-13)

These **override the task bodies where they conflict** — apply them as you implement. From a 4-section review + outside-voice challenge. Decision IDs in brackets.

**[D7] Recall boosts by the session's OWN outcome, not artifact-global Wilson — rewrites Task 5's signal.**
Outside voice showed max-over-artifacts of cross-session Wilson is near-uniform (ubiquitous skills — brainstorming, TDD, commit — pin every session to one floor) and relatively demotes novel work. For recall, the session's own judged outcome is the direct, stronger signal.
- Recall's `ProvenUseLookup` returns a per-session boost from that session's own `facet.outcome` via the shared `outcomeCredit()` (below): mostly=1.0, partial=0.5, not=0.0. An **unjudged** session (no row) → no boost (pure BM25).
- Store gains `outcomeForSessions(sessionIds: string[]): Map<string, Outcome>` = `SELECT DISTINCT session_id, outcome FROM artifact_outcomes WHERE session_id IN (...)`. Recall uses THIS, not `scoreForSessions`.
- `scoreForSessions` (artifact-global Wilson) + `outcomeScore`/Wilson (Task 1) stay as **foundation for the future recommender consumer** — unit-tested, but NOT on recall's path in v1.
- Task 5 boost (CORRECTED during impl): `final = bm25 * (1 + ALPHA * boost)`, where `boost = outcomeCredit(sessionOutcome)`. FTS5 `bm25()` is **negative** (more negative = better, sorted ascending), so we **multiply** to amplify magnitude — dividing (as an earlier draft said) would demote good matches. The boost-direction test caught this. At α=0.3 a `mostly` session (boost 1.0) sorts above a `not` session (boost 0.0) at equal BM25 — a real, visible reorder (this is why the A/B instrument can now actually fire).

**[shared] Extract `outcomeCredit()` (Task 1) — DRY across both consumers.**
```ts
export function outcomeCredit(o: Outcome): number {
  return o === "mostly_achieved" ? 1 : o === "partially_achieved" ? PARTIAL_CREDIT : 0;
}
```
`outcomeScore` sums it over an artifact's trials; recall maps a single session's outcome through it. One definition.

**[D3] Filter `origin === "llm"` before persisting (Task 2).**
`deterministicFacets` emits `origin:"heuristic"` with a placeholder `partially_achieved` when the judge degrades (`facets.ts:44-49`); persisting those writes 0.5-credit non-judgments that pull every score toward the mean. Add `if (facet.origin !== "llm") continue;` in `buildArtifactOutcomeRows`. **Test G1:** a heuristic-origin facet produces zero rows.

**[D4, widened] SQLite concurrency (Task 3 + Task 6).**
- In `openArtifactOutcomesStore`, right after open: `db.exec("PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;")`.
- Outside-voice #6: Task 6 otherwise adds a SECOND long-lived `RecallIndex` connection to `recall-index.db` (baseline `readIndex` + `boostedIndex`). **Prefer sharing ONE `RecallIndex` handle** and passing the lookup only on the `ab=1` branch, rather than opening a second connection. If a second connection is unavoidable, open recall-index WAL too.
- **Test G2:** a write on one outcomes handle during a read on another does not throw.

**[D5] Pin the store handle lifecycle (Task 6).**
Open one artifact-outcomes store handle at app init next to `readIndex`; wrap it in the `ProvenUseLookup` adapter; register `close()` in the same `app.onStop` that closes `recallIndex` (`src/index.ts:484`). No per-request opens.

**[D6] `scoreForSessions` single GROUP BY (Task 3).**
Replace the per-artifact SELECT loop with one grouped query. NOTE (outside-voice #7): this fixes the N+1 **shape**, not the full-history **scan** — a hot artifact still scans all its rows. Since recall no longer calls `scoreForSessions` (D7), it's off the hot path; a materialized per-artifact aggregate is deferred (NOT-in-scope) until the recommender consumer needs it.

**[D8] Document sparse coverage (Global + NOT-in-scope).**
Recall boost covers only **judged** sessions (those with a facet). Judging is expensive + capped (`DEFAULT_MAX_JUDGE`). A full-corpus dogfood needs a judge backfill with real LLM cost — **flagged, NOT auto-run in v1.** Expect the A/B to move only already-judged sessions; a flat result on an unjudged corpus is a coverage artifact, not a signal verdict.

**Test gaps to add:** G1 (heuristic→zero rows), G2 (concurrent write+read no throw), **G4** (cold/empty store → recall order == pure BM25 — the graceful-degradation guarantee), **G5** (a throwing store doesn't break `persistOutcomes`).

**Folded, no separate task:**
- Outside-voice #8: `project` guard = `signal.sequences.root`; before relying on the project filter for future lift, verify it shares a namespace with recall's `SessionMeta.project`. `agent` stays `null` in v1 (documented half-limit of the guard columns — future harness-controlled lift still needs a re-scan).
- Outside-voice #9: no centrality/repetition weighting — a 10× firing (often a struggle signal) and a 1× firing count equally. NOT-in-scope; note in code.
- Minor: give `ProvenUseLookup` a single **shared exported type** so recall and the store adapter can't drift on structural typing alone.

**NOT in scope (v1):** artifact-global proven-use as a *recall* signal (foundation only) · lift-over-baseline / selection-bias correction (the only causal fix — deferred) · materialized per-artifact aggregate · judge backfill of historical sessions · centrality/repetition weighting · mcp_server/hook coverage · gem-verification objective signal · cross-user outcomes · recency decay.

**What already exists (reused, not rebuilt):** `eventSeries`, `SessionFacet`, the `insightsCore` compute pass, `RecallIndex`, the LLM judge. Genuinely new: the store, the join, `outcomeCredit`/Wilson, the per-session boost.

---

### Task 1: `outcomeScore` + `wilsonLowerBound` (pure module)

**Files:**
- Create: `packages/insight/src/outcomeScore.ts`
- Test: `packages/insight/src/__tests__/outcomeScore.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `export type Outcome = "mostly_achieved" | "partially_achieved" | "not_achieved"`
  - `export const PARTIAL_CREDIT = 0.5`
  - `export function wilsonLowerBound(successes: number, n: number, z?: number): number`
  - `export function outcomeScore(outcomes: Outcome[]): number` → `[0,1]`

- [ ] **Step 1: Write the failing test**

```ts
// packages/insight/src/__tests__/outcomeScore.test.ts
import { describe, it, expect } from "vitest";
import { wilsonLowerBound, outcomeScore, PARTIAL_CREDIT } from "../outcomeScore.js";

describe("wilsonLowerBound", () => {
  it("returns 0 for n = 0 (never NaN)", () => {
    expect(wilsonLowerBound(0, 0)).toBe(0);
  });
  it("shrinks small samples: 2/2 scores below 40/45", () => {
    const small = wilsonLowerBound(2, 2);   // naive 1.0
    const big = wilsonLowerBound(40, 45);   // naive 0.89
    expect(small).toBeGreaterThan(0.3);
    expect(small).toBeLessThan(0.4);        // ~0.34
    expect(big).toBeGreaterThan(0.7);       // ~0.77
    expect(small).toBeLessThan(big);        // the inversion that matters
  });
});

describe("outcomeScore", () => {
  it("returns 0 for an empty history", () => {
    expect(outcomeScore([])).toBe(0);
  });
  it("counts partial as half a success", () => {
    expect(PARTIAL_CREDIT).toBe(0.5);
    // one mostly + one partial = 1.5 successes over n=2
    const mixed = outcomeScore(["mostly_achieved", "partially_achieved"]);
    const oneOfTwo = outcomeScore(["mostly_achieved", "not_achieved"]);
    expect(mixed).toBeGreaterThan(oneOfTwo);
  });
  it("is monotonic: more successes at fixed n never lowers the score", () => {
    const a = outcomeScore(["mostly_achieved", "not_achieved", "not_achieved"]);
    const b = outcomeScore(["mostly_achieved", "mostly_achieved", "not_achieved"]);
    expect(b).toBeGreaterThanOrEqual(a);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @agentgem/insight test outcomeScore`
Expected: FAIL — `Cannot find module '../outcomeScore.js'`.

- [ ] **Step 3: Write minimal implementation**

```ts
// packages/insight/src/outcomeScore.ts
// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
//
// Proven-use scoring: turn a list of session outcomes for one artifact into a
// single ranking score. Wilson lower bound so a lucky 2/2 cannot outrank a
// proven 40/45 — small samples shrink toward zero. Pure; no I/O.

export type Outcome = "mostly_achieved" | "partially_achieved" | "not_achieved";

// A partial success counts as half. Named so it is tunable once the validation
// instrument reports; not a magic number.
export const PARTIAL_CREDIT = 0.5;

/** Wilson score interval lower bound at confidence z (default 95%). n=0 → 0. */
export function wilsonLowerBound(successes: number, n: number, z = 1.96): number {
  if (n <= 0) return 0;
  const phat = successes / n;
  const z2 = z * z;
  const denom = 1 + z2 / n;
  const centre = phat + z2 / (2 * n);
  const margin = z * Math.sqrt((phat * (1 - phat) + z2 / (4 * n)) / n);
  return (centre - margin) / denom;
}

/** Collapse outcomes to successes/trials, then Wilson-shrink. Range [0,1]. */
export function outcomeScore(outcomes: Outcome[]): number {
  const n = outcomes.length;
  if (n === 0) return 0;
  const successes = outcomes.reduce(
    (s, o) => s + (o === "mostly_achieved" ? 1 : o === "partially_achieved" ? PARTIAL_CREDIT : 0),
    0,
  );
  return wilsonLowerBound(successes, n);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @agentgem/insight test outcomeScore`
Expected: PASS (all cases).

- [ ] **Step 5: Commit**

```bash
git add packages/insight/src/outcomeScore.ts packages/insight/src/__tests__/outcomeScore.test.ts
git commit -m "feat(insight): Wilson-shrunk outcomeScore pure module"
```

---

### Task 2: `buildArtifactOutcomeRows` — the session × outcome join

**Files:**
- Create: `packages/insight/src/artifactOutcomes.ts` (types + join only; the store is added in Task 3)
- Test: `packages/insight/src/__tests__/artifactOutcomes.join.test.ts`

**Interfaces:**
- Consumes: `Outcome` (Task 1); `WorkflowSignal`, `SessionFacet` from `./workflowScan.js`, `./facets.js`.
- Produces:
  - `export interface ArtifactOutcomeRow { sessionId: string; artifactType: "skill" | "agent"; artifactName: string; outcome: Outcome; project: string | null; agent: string | null; model: string | null; missionHint: string | null; atMs: number }`
  - `export function buildArtifactOutcomeRows(signal: WorkflowSignal, facets: SessionFacet[], ctx: { project: string | null; agent: string | null }): ArtifactOutcomeRow[]`

- [ ] **Step 1: Write the failing test**

```ts
// packages/insight/src/__tests__/artifactOutcomes.join.test.ts
import { describe, it, expect } from "vitest";
import { buildArtifactOutcomeRows } from "../artifactOutcomes.js";
import type { WorkflowSignal } from "../workflowScan.js";
import type { SessionFacet } from "../facets.js";

function signalWith(sessions: any[]): WorkflowSignal {
  return { sequences: { root: "/repo", sessions } } as unknown as WorkflowSignal;
}
function facet(sessionId: string, outcome: SessionFacet["outcome"]): SessionFacet {
  return { sessionId, transcript: `${sessionId}.jsonl`, atMs: 100, underlying_goal: "g",
    brief_summary: "s", outcome, friction_detail: "", model: "claude-opus", origin: "llm" };
}

describe("buildArtifactOutcomeRows", () => {
  it("joins eventSeries to the session's outcome by sessionId", () => {
    const signal = signalWith([{
      sessionId: "S1", transcript: "S1.jsonl", atMs: 100, model: "claude-opus",
      missionHint: { task: "fix the bug", outcome: "" }, steps: [],
      eventSeries: [
        { msgIndex: 1, kind: "skill", name: "superpowers:brainstorming" },
        { msgIndex: 2, kind: "agent", name: "Explore" },
      ],
    }]);
    const rows = buildArtifactOutcomeRows(signal, [facet("S1", "mostly_achieved")],
      { project: "/repo", agent: "claude" });
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({
      sessionId: "S1", artifactType: "skill", artifactName: "superpowers:brainstorming",
      outcome: "mostly_achieved", project: "/repo", agent: "claude",
      model: "claude-opus", missionHint: "fix the bug", atMs: 100,
    });
    expect(rows[1]).toMatchObject({ artifactType: "agent", artifactName: "Explore" });
  });

  it("skips a session with no facet (never writes a null outcome)", () => {
    const signal = signalWith([{
      sessionId: "S2", transcript: "S2.jsonl", atMs: 100, missionHint: { task: "t", outcome: "" },
      steps: [], eventSeries: [{ msgIndex: 1, kind: "skill", name: "a" }],
    }]);
    expect(buildArtifactOutcomeRows(signal, [], { project: "/repo", agent: null })).toEqual([]);
  });

  it("emits one row per artifact per session (dedupes repeated firings)", () => {
    const signal = signalWith([{
      sessionId: "S3", transcript: "S3.jsonl", atMs: 100, missionHint: { task: "t", outcome: "" },
      steps: [], eventSeries: [
        { msgIndex: 1, kind: "skill", name: "a" },
        { msgIndex: 5, kind: "skill", name: "a" },
      ],
    }]);
    const rows = buildArtifactOutcomeRows(signal, [facet("S3", "partially_achieved")],
      { project: "/repo", agent: null });
    expect(rows).toHaveLength(1);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @agentgem/insight test artifactOutcomes.join`
Expected: FAIL — `Cannot find module '../artifactOutcomes.js'`.

- [ ] **Step 3: Write minimal implementation**

```ts
// packages/insight/src/artifactOutcomes.ts
// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
//
// The {artifact, session, outcome} triple: joins each session's fired
// skills/subagents (SessionSequence.eventSeries) to that session's judged
// outcome (SessionFacet) by sessionId — the join both sides already compute in
// one insights pass and which nothing currently persists. Coverage: skill +
// agent kinds only (what SkillAgentEvent carries). The store lives below.
import type { WorkflowSignal } from "./workflowScan.js";
import type { SessionFacet } from "./facets.js";
import type { Outcome } from "./outcomeScore.js";

export interface ArtifactOutcomeRow {
  sessionId: string;
  artifactType: "skill" | "agent";
  artifactName: string;          // raw token from eventSeries (skill token / subagent_type)
  outcome: Outcome;
  project: string | null;        // guard columns: stored for later lift, not read by v1 score
  agent: string | null;
  model: string | null;
  missionHint: string | null;
  atMs: number;
}

/** Join fired artifacts to their session's outcome. Sessions without a facet are
 *  skipped (never written with a null outcome). One row per (session, artifact). */
export function buildArtifactOutcomeRows(
  signal: WorkflowSignal,
  facets: SessionFacet[],
  ctx: { project: string | null; agent: string | null },
): ArtifactOutcomeRow[] {
  const facetById = new Map(facets.map((f) => [f.sessionId, f]));
  const rows: ArtifactOutcomeRow[] = [];
  for (const s of signal.sequences?.sessions ?? []) {
    const facet = facetById.get(s.sessionId);
    if (!facet) continue;
    const seen = new Set<string>();
    for (const ev of s.eventSeries ?? []) {
      const key = `${ev.kind}:${ev.name}`;
      if (seen.has(key)) continue;
      seen.add(key);
      rows.push({
        sessionId: s.sessionId,
        artifactType: ev.kind,
        artifactName: ev.name,
        outcome: facet.outcome,
        project: ctx.project,
        agent: ctx.agent,
        model: facet.model ?? null,
        missionHint: s.missionHint?.task ?? null,
        atMs: facet.atMs,
      });
    }
  }
  return rows;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @agentgem/insight test artifactOutcomes.join`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/insight/src/artifactOutcomes.ts packages/insight/src/__tests__/artifactOutcomes.join.test.ts
git commit -m "feat(insight): eventSeries x facet join into ArtifactOutcomeRow"
```

---

### Task 3: `ArtifactOutcomesStore` — the dedicated SQLite store

**Files:**
- Create: `packages/insight/src/artifactOutcomesStore.ts`
- Test: `packages/insight/src/__tests__/artifactOutcomesStore.test.ts`
- Modify: `packages/insight/src/index.ts` (add exports)

**Interfaces:**
- Consumes: `ArtifactOutcomeRow` (Task 2), `outcomeScore` + `Outcome` (Task 1).
- Produces:
  - `export interface ArtifactOutcomesStore { upsertSession(sessionId: string, rows: ArtifactOutcomeRow[]): void; scoreForSessions(sessionIds: string[]): Map<string, number>; close(): void }`
  - `export function openArtifactOutcomesStore(dataDir?: string): ArtifactOutcomesStore`
  - `export function defaultArtifactOutcomesDbPath(): string`

- [ ] **Step 1: Write the failing test**

```ts
// packages/insight/src/__tests__/artifactOutcomesStore.test.ts
import { describe, it, expect } from "vitest";
import { openArtifactOutcomesStore } from "../artifactOutcomesStore.js";
import type { ArtifactOutcomeRow } from "../artifactOutcomes.js";

function row(sessionId: string, name: string, outcome: ArtifactOutcomeRow["outcome"]): ArtifactOutcomeRow {
  return { sessionId, artifactType: "skill", artifactName: name, outcome,
    project: "/r", agent: null, model: "m", missionHint: "t", atMs: 1 };
}

describe("ArtifactOutcomesStore", () => {
  it("upserts a session idempotently (re-write replaces, no double count)", () => {
    const s = openArtifactOutcomesStore("memory://");
    s.upsertSession("S1", [row("S1", "skill-a", "mostly_achieved")]);
    s.upsertSession("S1", [row("S1", "skill-a", "mostly_achieved")]); // same again
    // one artifact, one session, seen once → score is Wilson(1,1), not Wilson(2,2)
    const score = s.scoreForSessions(["S1"]).get("S1")!;
    expect(score).toBeGreaterThan(0);
    expect(score).toBeLessThan(0.6); // Wilson(1,1) ~= 0.21, not the higher Wilson(2,2)
    s.close();
  });

  it("scores a session by the MAX of its artifacts' cross-session outcome-scores", () => {
    const s = openArtifactOutcomesStore("memory://");
    // skill-good succeeds across many sessions; skill-bad fails
    for (let i = 0; i < 20; i++) s.upsertSession(`G${i}`, [row(`G${i}`, "skill-good", "mostly_achieved")]);
    for (let i = 0; i < 20; i++) s.upsertSession(`B${i}`, [row(`B${i}`, "skill-bad", "not_achieved")]);
    // candidate session used BOTH → max picks skill-good's high score
    s.upsertSession("CAND", [row("CAND", "skill-good", "mostly_achieved"), row("CAND", "skill-bad", "not_achieved")]);
    const score = s.scoreForSessions(["CAND"]).get("CAND")!;
    expect(score).toBeGreaterThan(0.6); // dominated by skill-good, not diluted by skill-bad
    s.close();
  });

  it("returns no entry for an unknown session (caller treats as 0)", () => {
    const s = openArtifactOutcomesStore("memory://");
    expect(s.scoreForSessions(["nope"]).has("nope")).toBe(false);
    s.close();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @agentgem/insight test artifactOutcomesStore`
Expected: FAIL — `Cannot find module '../artifactOutcomesStore.js'`.

- [ ] **Step 3: Write minimal implementation**

```ts
// packages/insight/src/artifactOutcomesStore.ts
// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
//
// The proven-use store: its OWN local sqlite (~/.agentgem/artifact-outcomes.db),
// deliberately SEPARATE from transcript-index.db. That store holds byte-derived
// data and DROPS every derived table on a schema bump; these rows are expensive,
// non-deterministic LLM judgments that must never be dropped that way. Opposite
// lifecycles → separate stores. Append/upsert-only; own schema version.
import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { agentgemHome } from "@agentgem/model";
import { outcomeScore, type Outcome } from "./outcomeScore.js";
import type { ArtifactOutcomeRow } from "./artifactOutcomes.js";

const SCHEMA_VERSION = "1";

export function defaultArtifactOutcomesDbPath(): string {
  return join(agentgemHome(), ".agentgem", "artifact-outcomes.db");
}

export interface ArtifactOutcomesStore {
  /** Replace all rows for one session with `rows` (idempotent re-scan). */
  upsertSession(sessionId: string, rows: ArtifactOutcomeRow[]): void;
  /** For each candidate sessionId, the max over its artifacts of that artifact's
   *  Wilson score across ALL sessions. Sessions with no rows are omitted. */
  scoreForSessions(sessionIds: string[]): Map<string, number>;
  close(): void;
}

export function openArtifactOutcomesStore(dataDir?: string): ArtifactOutcomesStore {
  const dir = dataDir ?? defaultArtifactOutcomesDbPath();
  const file = dir === "memory://" ? ":memory:" : dir;
  if (file !== ":memory:") mkdirSync(dirname(file), { recursive: true });
  const db = new DatabaseSync(file);

  db.exec(`CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT);`);
  const ver = (db.prepare("SELECT value FROM meta WHERE key='schema_version'").get() as { value: string } | undefined)?.value;
  if (ver !== SCHEMA_VERSION) {
    // A future bump migrates in place — it must NOT drop artifact_outcomes.
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
      PRIMARY KEY (session_id, artifact_type, artifact_name)
    );
    CREATE INDEX IF NOT EXISTS artifact_outcomes_lookup
      ON artifact_outcomes (artifact_type, artifact_name);
  `);

  return {
    upsertSession(sessionId, rows) {
      db.exec("BEGIN");
      try {
        db.prepare("DELETE FROM artifact_outcomes WHERE session_id = ?1").run(sessionId);
        const ins = db.prepare(
          `INSERT INTO artifact_outcomes
             (session_id, artifact_type, artifact_name, outcome, project, agent, model, mission_hint, at_ms)
           VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9)
           ON CONFLICT(session_id, artifact_type, artifact_name) DO UPDATE SET outcome=?4`,
        );
        for (const r of rows) {
          ins.run(r.sessionId, r.artifactType, r.artifactName, r.outcome,
            r.project, r.agent, r.model, r.missionHint, r.atMs);
        }
        db.exec("COMMIT");
      } catch (e) {
        try { db.exec("ROLLBACK"); } catch { /* keep original error */ }
        throw e;
      }
    },

    scoreForSessions(sessionIds) {
      const out = new Map<string, number>();
      if (!sessionIds.length) return out;
      const placeholders = sessionIds.map((_, i) => `?${i + 1}`).join(",");
      // 1. which artifacts each candidate session used
      const used = db.prepare(
        `SELECT session_id, artifact_type, artifact_name FROM artifact_outcomes
         WHERE session_id IN (${placeholders})`,
      ).all(...sessionIds) as { session_id: string; artifact_type: string; artifact_name: string }[];
      if (!used.length) return out;
      // 2. cross-session Wilson score per distinct artifact (memoized)
      const scoreOf = new Map<string, number>();
      const artifactScore = (type: string, name: string): number => {
        const key = `${type}:${name}`;
        const cached = scoreOf.get(key);
        if (cached !== undefined) return cached;
        const outcomes = (db.prepare(
          `SELECT outcome FROM artifact_outcomes WHERE artifact_type=?1 AND artifact_name=?2`,
        ).all(type, name) as { outcome: string }[]).map((r) => r.outcome as Outcome);
        const s = outcomeScore(outcomes);
        scoreOf.set(key, s);
        return s;
      };
      // 3. per candidate session: max over its artifacts
      for (const u of used) {
        const s = artifactScore(u.artifact_type, u.artifact_name);
        const prev = out.get(u.session_id);
        if (prev === undefined || s > prev) out.set(u.session_id, s);
      }
      return out;
    },

    close() { db.close(); },
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @agentgem/insight test artifactOutcomesStore`
Expected: PASS.

- [ ] **Step 5: Add package exports**

In `packages/insight/src/index.ts`, add these lines alongside the existing `export * from` lines:

```ts
export * from "./outcomeScore.js";
export * from "./artifactOutcomes.js";
export * from "./artifactOutcomesStore.js";
```

- [ ] **Step 6: Build the package to verify exports resolve**

Run: `pnpm --filter @agentgem/insight build`
Expected: PASS (tsc clean).

- [ ] **Step 7: Commit**

```bash
git add packages/insight/src/artifactOutcomesStore.ts packages/insight/src/__tests__/artifactOutcomesStore.test.ts packages/insight/src/index.ts
git commit -m "feat(insight): artifact-outcomes.db store with proven-use scoring"
```

---

### Task 4: Wire the writer into the insights compute pass

**Files:**
- Modify: `src/insightsCore.ts` (inside `compute`, after `judgeSessions`)
- Test: `src/gem/__tests__/insightsCore.outcomes.test.ts`

**Interfaces:**
- Consumes: `openArtifactOutcomesStore`, `buildArtifactOutcomeRows` (Tasks 2–3).
- Produces: outcome rows persisted as a side effect of a cache-miss compute. An optional injectable `openOutcomesStore` param on the insights options for testing (default = real store).

- [ ] **Step 1: Read the surrounding code**

Read `src/insightsCore.ts` lines 30–92. Confirm `compute` builds `signal = scanWorkflow(paths, scanInv, { retainSequences: true })` and `const { facets } = await (opts.judge ?? judgeSessions)(signal, ...)`. The writer goes immediately after `facets` is available, before `return`.

- [ ] **Step 2: Write the failing test**

```ts
// src/gem/__tests__/insightsCore.outcomes.test.ts
import { describe, it, expect } from "vitest";
import { openArtifactOutcomesStore } from "@agentgem/insight";
import { persistOutcomes } from "../../insightsCore.js";
import type { WorkflowSignal } from "@agentgem/insight";

describe("persistOutcomes", () => {
  it("writes triples for judged sessions into the store", () => {
    const store = openArtifactOutcomesStore("memory://");
    const signal = { sequences: { root: "/repo", sessions: [{
      sessionId: "S1", transcript: "S1.jsonl", atMs: 1, model: "m",
      missionHint: { task: "t", outcome: "" }, steps: [],
      eventSeries: [{ msgIndex: 1, kind: "skill", name: "skill-a" }],
    }] } } as unknown as WorkflowSignal;
    const facets = [{ sessionId: "S1", transcript: "S1.jsonl", atMs: 1, underlying_goal: "t",
      brief_summary: "t", outcome: "mostly_achieved", friction_detail: "", model: "m", origin: "llm" }] as any;

    persistOutcomes(store, signal, facets, "/repo");

    expect(store.scoreForSessions(["S1"]).get("S1")).toBeGreaterThan(0);
    store.close();
  });

  it("is a no-op when there are no facets", () => {
    const store = openArtifactOutcomesStore("memory://");
    const signal = { sequences: { root: "/r", sessions: [] } } as unknown as WorkflowSignal;
    expect(() => persistOutcomes(store, signal, [], "/r")).not.toThrow();
    store.close();
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `pnpm --filter <root-app-package> test insightsCore.outcomes`
(Use the root package's test script; it resolves `src/**`.)
Expected: FAIL — `persistOutcomes` is not exported.

- [ ] **Step 4: Add `persistOutcomes` and call it in `compute`**

In `src/insightsCore.ts`, add the import and a small exported helper (near the top, after existing imports):

```ts
import {
  openArtifactOutcomesStore, buildArtifactOutcomeRows,
  type ArtifactOutcomesStore,
} from "@agentgem/insight";

/** Persist the {artifact, session, outcome} triples for a judged pass. Isolated
 *  and exported so it is unit-testable without running the whole insights loop.
 *  Best-effort: a store failure must never break insights. */
export function persistOutcomes(
  store: ArtifactOutcomesStore,
  signal: Parameters<typeof buildArtifactOutcomeRows>[0],
  facets: Parameters<typeof buildArtifactOutcomeRows>[1],
  project: string | null,
): void {
  const rows = buildArtifactOutcomeRows(signal, facets, { project, agent: null });
  const bySession = new Map<string, typeof rows>();
  for (const r of rows) {
    const list = bySession.get(r.sessionId) ?? [];
    list.push(r);
    bySession.set(r.sessionId, list);
  }
  for (const [sessionId, sessionRows] of bySession) store.upsertSession(sessionId, sessionRows);
}
```

Then inside `compute`, immediately after the `judging` block (after `const { facets, degraded: judgeDegraded } = ...`), add:

```ts
      // Persist proven-use triples (best-effort — never break insights on a store error).
      try {
        const outcomesStore = (opts.openOutcomesStore ?? openArtifactOutcomesStore)();
        try { persistOutcomes(outcomesStore, signal, facets, signal.sequences?.root ?? null); }
        finally { outcomesStore.close(); }
      } catch (e) {
        // swallow: outcomes are an enhancement, not a correctness dependency
      }
```

Add `openOutcomesStore?: () => ArtifactOutcomesStore;` to the `opts` type for this function (alongside `judge?` / `narrate?`).

- [ ] **Step 5: Run test to verify it passes**

Run: `pnpm --filter <root-app-package> test insightsCore.outcomes`
Expected: PASS.

- [ ] **Step 6: Run the insight + root test suites for regressions**

Run: `pnpm --filter @agentgem/insight test && pnpm --filter <root-app-package> test insightsCore`
Expected: PASS (no regression in existing insightsCore/insightsReport/insightsCache tests).

- [ ] **Step 7: Commit**

```bash
git add src/insightsCore.ts src/gem/__tests__/insightsCore.outcomes.test.ts
git commit -m "feat: persist proven-use outcomes on the insights judge pass"
```

---

### Task 5: Recall proven-use boost (injected lookup + α re-rank)

**Files:**
- Modify: `packages/recall/src/recallIndex.ts` (constructor + `search`)
- Test: `packages/recall/src/__tests__/recallIndex.provenUse.test.ts`

**Interfaces:**
- Consumes: `outcomeScore` semantics via an injected lookup (keeps recall's SQLite untouched).
- Produces:
  - `export interface ProvenUseLookup { scoreForSessions(sessionIds: string[]): Map<string, number> }`
  - `export const ALPHA = 0.3`
  - `RecallIndex` constructor gains an optional 2nd arg `provenUse?: ProvenUseLookup`. When absent, ranking is exactly today's BM25 (the kill switch).

- [ ] **Step 1: Write the failing test**

```ts
// packages/recall/src/__tests__/recallIndex.provenUse.test.ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RecallIndex, type ProvenUseLookup } from "../recallIndex.js";
import type { SessionMeta } from "../recallIndex.js";

const meta = (id: string): SessionMeta =>
  ({ sessionId: id, agent: "claude", project: "r", branch: "main", startMs: 1 });

// Two sessions with identical text ⇒ identical BM25; proven-use must break the tie.
function seed(index: RecallIndex) {
  index.upsertSession(meta("HI"), [{ turn: 0, text: "fix the aggregator schema bug" }], "a");
  index.upsertSession(meta("LO"), [{ turn: 0, text: "fix the aggregator schema bug" }], "b");
}

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "recall-pu-")); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

describe("RecallIndex proven-use boost", () => {
  it("with no lookup, ordering is pure BM25 (kill switch = today's behavior)", () => {
    const index = new RecallIndex(join(dir, "i.db"));
    seed(index);
    const hits = index.search("aggregator schema", {}, 10);
    expect(hits.map((h) => h.sessionId).sort()).toEqual(["HI", "LO"]);
    index.close();
  });

  it("boosts the session whose artifacts have proven use", () => {
    const lookup: ProvenUseLookup = {
      scoreForSessions: (ids) => new Map(ids.map((id) => [id, id === "HI" ? 0.9 : 0.0])),
    };
    const index = new RecallIndex(join(dir, "i2.db"), lookup);
    seed(index);
    const hits = index.search("aggregator schema", {}, 10);
    expect(hits[0].sessionId).toBe("HI"); // proven-use wins the tie
    index.close();
  });
});
```

The `RecallIndex` write API (verified in `recallIndex.ts:77`) is a single
`upsertSession(meta: SessionMeta, chunks: Chunk[], stamp: string)`; `Chunk` is
`{ turn: number; text: string }`. The constructor takes a required `dbPath: string`
(no `memory://` sentinel — use a tmpdir file, as the existing `recallIndex.test.ts`
does).

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @agentgem/recall test recallIndex.provenUse`
Expected: FAIL — `ProvenUseLookup` not exported / constructor takes one arg.

- [ ] **Step 3: Implement the boost**

In `packages/recall/src/recallIndex.ts`:

Add near the top-level exports:
```ts
// Proven-use ranking. ALPHA caps the boost so relevance (BM25) stays primary; a
// perfect proven-use score improves effective rank by at most ALPHA. Injected, so
// recall keeps its own sqlite and no insight dependency at query time; absent = the
// kill switch (exactly today's BM25 ordering).
export const ALPHA = 0.3;
export interface ProvenUseLookup { scoreForSessions(sessionIds: string[]): Map<string, number> }
```

Extend the existing constructor (`constructor(dbPath: string)` at `recallIndex.ts:32`) with an optional second parameter, keeping `dbPath` required and the body unchanged:
```ts
  constructor(dbPath: string, private readonly provenUse?: ProvenUseLookup) {
    // ...existing body unchanged...
  }
```

In `search`, replace the final rollup return:
```ts
    return [...bySession.values()].sort((a, b) => a.score - b.score).slice(0, limit);
```
with a proven-use re-rank (BM25 is a distance — lower is better — so we DIVIDE):
```ts
    const hits = [...bySession.values()];
    if (this.provenUse && hits.length) {
      const scores = this.provenUse.scoreForSessions(hits.map((h) => h.sessionId));
      for (const h of hits) {
        const pu = scores.get(h.sessionId) ?? 0;      // unknown session → no boost
        h.score = h.score / (1 + ALPHA * pu);          // lower is better ⇒ divide
      }
    }
    return hits.sort((a, b) => a.score - b.score).slice(0, limit);
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @agentgem/recall test recallIndex.provenUse`
Expected: PASS (both cases — kill switch and boost).

- [ ] **Step 5: Run recall suite for regressions**

Run: `pnpm --filter @agentgem/recall test`
Expected: PASS (existing recallIndex/search tests unaffected — default constructor path is unchanged).

- [ ] **Step 6: Wire the real lookup at the app call sites (kill switch ON by default)**

For v1, ship with the boost available but constructed only where we want to validate. In `src/index.ts:483` and `src/goldmine/mcpServer.ts:66`, leave `new RecallIndex(defaultRecallDbPath())` UNCHANGED (no lookup → pure BM25). The lookup is wired only behind the A/B flag in Task 6. Confirm no call site passes a lookup yet.

- [ ] **Step 7: Commit**

```bash
git add packages/recall/src/recallIndex.ts packages/recall/src/__tests__/recallIndex.provenUse.test.ts
git commit -m "feat(recall): injectable proven-use boost on BM25 ranking"
```

---

### Task 6: Validation instruments — A/B flag + offline judge-agreement probe

**Files:**
- Modify: `src/goldmine/recallRoutes.ts` (A/B: run search twice when a flag is set)
- Create: `scripts/proven-use-judge-agreement.ts` (offline probe, not shipped in a package)
- Test: `src/gem/__tests__/recallRoutes.ab.test.ts`

**Interfaces:**
- Consumes: `RecallIndex` + `ProvenUseLookup` (Task 5), `openArtifactOutcomesStore` (Task 3).
- Produces: an A/B response shape `{ moments, momentsBoosted? }` when `?ab=1`; a standalone CLI probe.

- [ ] **Step 1: Write the failing test for the A/B route**

```ts
// src/gem/__tests__/recallRoutes.ab.test.ts
import { describe, it, expect } from "vitest";
import { abSearch } from "../../goldmine/recallRoutes.js";

describe("abSearch", () => {
  it("returns only baseline moments when ab is off", () => {
    const fakeIndex = { search: (_q: string, _f: any, _l: number) => [{ sessionId: "A", score: 1 }] } as any;
    const out = abSearch(fakeIndex, undefined, "q", {}, 10, false);
    expect(out.moments).toHaveLength(1);
    expect(out.momentsBoosted).toBeUndefined();
  });
  it("returns both orderings when ab is on and a lookup exists", () => {
    const base = { search: () => [{ sessionId: "A", score: 1 }, { sessionId: "B", score: 1 }] } as any;
    const boosted = { search: () => [{ sessionId: "B", score: 0.5 }, { sessionId: "A", score: 1 }] } as any;
    const out = abSearch(base, boosted, "q", {}, 10, true);
    expect(out.moments[0].sessionId).toBe("A");
    expect(out.momentsBoosted?.[0].sessionId).toBe("B");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter <root-app-package> test recallRoutes.ab`
Expected: FAIL — `abSearch` not exported.

- [ ] **Step 3: Implement `abSearch` and use it in the route**

In `src/goldmine/recallRoutes.ts`, add:
```ts
import type { RecallIndex, RecallFilters, MomentHit } from "@agentgem/recall";

/** A/B recall: baseline (BM25) always; boosted (proven-use) only when `ab` is set
 *  AND a boosted index is available. Lets the operator eyeball both orderings on
 *  their own transcripts — validation instrument #1. */
export function abSearch(
  base: Pick<RecallIndex, "search">,
  boosted: Pick<RecallIndex, "search"> | undefined,
  q: string, filters: RecallFilters, limit: number, ab: boolean,
): { moments: MomentHit[]; momentsBoosted?: MomentHit[] } {
  const moments = base.search(q, filters, limit);
  if (!ab || !boosted) return { moments };
  return { moments, momentsBoosted: boosted.search(q, filters, limit) };
}
```

In the route handler (around line 92, `res.json({ moments: deps.readIndex.search(...) })`), replace with:
```ts
    const ab = req.query.ab === "1";
    res.json(abSearch(deps.readIndex, deps.boostedIndex, q, { project, agent, since }, limit, ab));
```
Add an optional `boostedIndex?: Pick<RecallIndex, "search">` to the route `deps` type. Wire it in `src/index.ts` where the recall routes are constructed: build a second `RecallIndex(defaultRecallDbPath(), lookup)` where `lookup` is an object delegating to `openArtifactOutcomesStore().scoreForSessions` (open once at startup, close on `app.onStop`). Keep the baseline `readIndex` lookup-free.

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter <root-app-package> test recallRoutes.ab`
Expected: PASS.

- [ ] **Step 5: Write the offline judge-agreement probe (instrument #2)**

Create `scripts/proven-use-judge-agreement.ts`:
```ts
// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
//
// Validation instrument #2 (offline, run by hand): does the judge's
// `mostly_achieved` label track an INDEPENDENT signal it never saw? Ground truth
// here = "no rework" — a session's mission_hint did NOT recur in a strictly later
// session. If achieved sessions are re-attempted just as often as not-achieved
// ones, the label is a weak signal → drop ALPHA to 0 in recallIndex.ts until the
// judge improves. A MEASUREMENT, not a benchmark. Reads only artifact-outcomes.db.
//   pnpm tsx scripts/proven-use-judge-agreement.ts
import { DatabaseSync } from "node:sqlite";
import { defaultArtifactOutcomesDbPath } from "@agentgem/insight";

const db = new DatabaseSync(defaultArtifactOutcomesDbPath());
// outcome/mission_hint/at_ms are per-session (duplicated across a session's artifact
// rows); DISTINCT collapses to one row per judged session, oldest first.
const rows = db.prepare(
  `SELECT DISTINCT session_id, outcome, mission_hint, at_ms
     FROM artifact_outcomes
    WHERE mission_hint IS NOT NULL
    ORDER BY at_ms ASC`,
).all() as { session_id: string; outcome: string; mission_hint: string; at_ms: number }[];

const norm = (s: string) => s.toLowerCase().replace(/\s+/g, " ").trim();
// 2x2: a=achieved&no-rework, b=achieved&rework, c=not&no-rework, d=not&rework
let a = 0, b = 0, c = 0, d = 0;
for (let i = 0; i < rows.length; i++) {
  const reworked = rows.some((o, j) => j > i && norm(o.mission_hint) === norm(rows[i].mission_hint));
  const achieved = rows[i].outcome === "mostly_achieved";
  if (achieved && !reworked) a++;
  else if (achieved && reworked) b++;
  else if (!achieved && !reworked) c++;
  else d++;
}
const phi = (a * d - b * c) / Math.sqrt(((a + b) * (c + d) * (a + c) * (b + d)) || 1);
console.log(`n=${rows.length} judged sessions`);
console.log(`               no-rework   rework`);
console.log(`achieved          ${a}         ${b}`);
console.log(`not-achieved      ${c}         ${d}`);
console.log(`phi(achieved ~ no-rework) = ${phi.toFixed(3)}   ( >0 supports the judge; ~0 = weak )`);
db.close();
```

> The rework-recurrence heuristic is deliberately independent of the judge (it uses
> only mission recurrence over time, never the outcome label) and runs off the store
> alone — no git, no new data. It is a script, never a package dependency. If a repo
> has a stronger ground truth available (e.g. commit-survival), swap the `reworked`
> computation; the contingency/phi harness is unchanged.

- [ ] **Step 6: Run the full affected suites**

Run: `pnpm --filter @agentgem/insight test && pnpm --filter @agentgem/recall test && pnpm --filter <root-app-package> test recall`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/goldmine/recallRoutes.ts src/index.ts src/gem/__tests__/recallRoutes.ab.test.ts scripts/proven-use-judge-agreement.ts
git commit -m "feat: A/B recall flag + offline judge-agreement probe (validation)"
```

---

## Notes for the implementer

- **Replace `<root-app-package>`** with the actual name in the root `package.json` (`"name"` field) before running its test filter.
- **`RecallIndex` write API is confirmed** (`recallIndex.ts:77`): `upsertSession(meta, chunks, stamp)`, `Chunk = { turn, text }`, constructor `(dbPath: string)`. Task 5's test uses these directly.
- **`agent` guard column is `null` in v1** (harness attribution per session is not on `SessionSequence`); the column exists for later lift analysis. Do not invent a value.
- **Do not touch** `transcript-index.db`, `evidenceLedger.ts`, the aggregator, or any scrub path. Outcomes live only in `artifact-outcomes.db`.

## GSTACK REVIEW REPORT

| Review | Trigger | Why | Runs | Status | Findings |
|--------|---------|-----|------|--------|----------|
| Eng Review | `/plan-eng-review` | Architecture & tests (required) | 1 | issues_open → resolved | 6 findings + 4 test gaps, all folded; 1 signal reframe (D7) |
| Outside Voice | Claude subagent | Independent 2nd opinion | 1 | issues_found | Caught the D7 grain error the 4-section review missed |

**Completion summary**
- Step 0 (scope): 9 files tripped the 8-file smell → reviewed, proceeded as-is (D2). Not overbuilt; files small + single-purpose.
- Architecture: 2 findings — D3 (heuristic facets pollute score, P1) · D4 (SQLite concurrency, P2). Both folded.
- Code Quality: 1 finding — D5 (store handle lifecycle under-specified). Folded. DRY overlap (schema-version boilerplate) considered, declined (lifecycle divergence justifies it).
- Test: coverage diagram, 4 gaps added — G1 (heuristic→0 rows, critical) · G2 (concurrent write+read) · G4 (cold store → pure BM25) · G5 (store error swallowed).
- Performance: 1 finding — D6 (N+1 → GROUP BY). Folded; noted it's a shape fix not a scale fix.
- Outside voice: ran (Claude subagent). Surfaced the load-bearing reframe.
- Cross-model tensions resolved: **D7** — recall boosts by session's OWN outcome, not artifact-global max (artifact-global is near-uniform + demotes novel work). **D8** — accept sparse judged-session coverage; flag judge-backfill cost, don't auto-run.
- Failure modes: judge-degraded placeholder writes → caught (D3 filter + G1 test); cold store → visible BM25 fallback (G4). No remaining critical gaps.
- NOT-in-scope: written (see Review Amendments).
- Parallelization: **Lane A** Tasks 1→2→3 (sequential, shared `packages/insight`). **Lane B** none until Task 3 lands (Tasks 4,5,6 all depend on the store). Effectively sequential — the store is the spine. No worktree parallelism worth the setup.

**VERDICT:** ENG CLEARED (findings folded) — ready to implement. The store is a sound foundation bet; per D7 the reference consumer (recall) now uses per-session outcome, which is what v1 actually validates. Artifact-global Wilson ships as tested foundation for the later recommender consumer, not as a v1 claim.

**UNRESOLVED DECISIONS:**
- D4 sub-choice (share one `RecallIndex` handle vs. open a second WAL connection) is left to implementation — flagged, not blocking.
