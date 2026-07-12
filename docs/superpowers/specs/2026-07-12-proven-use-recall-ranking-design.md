# Proven-use recall ranking — design

**Date:** 2026-07-12
**Status:** approved design, ready for planning
**Branch:** `feat/proven-use-recall-ranking`

## Problem

Every run tells us something about which of your artifacts *worked*, and we throw
it away at the moment of retrieval.

`judgeSession` already labels each session `mostly_achieved | partially_achieved |
not_achieved` (`packages/insight/src/facets.ts:13`). `scanWorkflow(retainSequences:
true)` already knows which skills and subagents fired in that session
(`SessionSequence.eventSeries`, `packages/insight/src/workflowScan.ts:48`). Both are
keyed on the same `sessionId`. So "skill Y ran in session X, which achieved its
goal" is computable in a single pass, today.

Then `buildAttestation` collapses that join into per-model histograms and
per-ingredient **counts** (`packages/insight/src/attestation.ts:48-99`), and
`scanWorkflow` reduces the session set to `.size` (`workflowScan.ts:522`). No store
anywhere holds a `{artifact, session, outcome}` triple.

Meanwhile `recall` — the one component whose entire job is choosing what surfaces —
ranks results by **BM25 lexical score only** (`packages/recall/src/recallIndex.ts:115-151`).
It has no idea whether a surfaced session's artifacts ever worked. The causal signal
that no memory competitor can compute (they never observe an outcome) is computed
here, stored in attestations, published — and ignored by retrieval.

## The observation

The join already happens. It is discarded before any write. Persisting the
un-aggregated triple, and reading it back as a bounded re-rank boost, is the whole
feature — one table, one pure scoring function, one call site.

This is the shared foundation for four future consumers (recall, the ACP
recommender, agent-runtime context selection, marketplace discovery). This spec
ships **one** of them — `recall` — as the reference consumer, because it already has
a ranking function to boost, it is dogfoodable on the author's own transcripts
today, and a wrong ranking in personal search is low-stakes. The other three are
out of scope (§ Out of scope) and become thin adapters over the same store + score.

## The boundary this must respect

Recall keeps **raw transcript content on the user's machine**, scrubbed, searched
lexically (`2026-07-07-recall-transcript-search-design.md`, `2026-07-05-goldmine-aggregates-only-design.md`).
This design **only reorders results and attaches a numeric score**. It reads no new
content, moves no content, and changes no scrub path. The outcome triple stores
artifact names and an enum label — never transcript text.

## Design

Three components, each one job. The write path and read path are decoupled: recall
never blocks on a scan, and a cold/empty store degrades to exactly today's BM25
ordering (α·0).

### 1. `artifact_outcomes` store (new)

A new table in the existing local `~/.agentgem/transcript-index.db`
(`packages/capture/src/transcriptIndex.ts`) — the incremental, path-keyed usage
index. Not in `recall-index.db`: the outcome triple is a *usage* fact, and keeping
the score out of the recall index means re-scoring never forces a recall reindex.

```sql
CREATE TABLE artifact_outcomes (
  session_id    TEXT NOT NULL,   -- join key; the transcript UUID
  artifact_type TEXT NOT NULL,   -- 'skill' | 'mcp_server' | 'hook'
  artifact_name TEXT NOT NULL,   -- resolved inventory name (binds to a GemSelection)
  outcome       TEXT NOT NULL,   -- 'mostly_achieved' | 'partially_achieved' | 'not_achieved'
  project       TEXT,            -- confounder guard + recall's existing filter
  agent         TEXT,            -- confounder guard (which harness)
  model         TEXT,            -- confounder guard (facet.model)
  mission_hint  TEXT,            -- the task; makes lift computable later
  at_ms         INTEGER,         -- facet.atMs; recency + freshness eviction
  PRIMARY KEY (session_id, artifact_type, artifact_name)
);
CREATE INDEX artifact_outcomes_lookup ON artifact_outcomes (artifact_type, artifact_name);
```

Grain: **one row per artifact-firing-in-a-session** — the un-aggregated level
`buildAttestation` collapses. Keeping it un-collapsed is the point: the score is
computed at read time, so the scoring formula can change later without re-scanning.
The four guard columns cost four columns now and are the difference between "lift
over baseline is a later query" and "lift needs a full re-scan forever";
`mission_hint` is already on `SessionSequence`, so it is free at write time.

Idempotency: the writer upserts on the PK, so re-scanning a session replaces its
rows rather than double-counting — matching `transcriptIndex.ts`'s existing
`(path, type, name)` keying.

### 2. `outcome-score` (new pure module)

No I/O. Input: the `artifact_outcomes` rows for one artifact (optionally filtered by
`project`/`agent`). Output: a score in `[0, 1]`.

1. **Collapse to successes/trials.** `mostly_achieved` = 1.0, `partially_achieved`
   = 0.5, `not_achieved` = 0.0. Each row is one trial. The 0.5 is a named constant
   (`PARTIAL_CREDIT`), not a magic number — tunable once the validation instrument
   (§ Validation) reports.
2. **Wilson lower bound** at z = 1.96 (95%): `score = wilsonLowerBound(successes, n)`.
   Property that matters: 2/2 (naive 1.0) scores ~0.34; 40/45 (naive 0.89) scores
   ~0.77. Low-n artifacts shrink toward zero, so a novelty cannot leapfrog a
   workhorse on a lucky pair of runs. This kills small-sample bias outright; it does
   not fix "easy task" bias (that needs lift, deferred).
3. `n = 0` → returns 0 (never NaN).

### 3. `recall` ranking (modified — one call site)

At `recallIndex.ts:150`, results are sorted on raw BM25. BM25 here is a **distance
(ascending, lower = better)**, so the boost divides:

```
final = bm25 / (1 + α * provenUseScore)      // α = ALPHA, default 0.3
```

A session's proven-use score is the **max** of its fired artifacts'
`outcome-score`s, looked up from `artifact_outcomes` at query time via a second
connection / `ATTACH` (both DBs local SQLite). Max, not mean: a boost should reward
that the session *contains* a proven artifact, and mean would let one mediocre
co-occurring artifact dilute a strong one. (Mean is the alternative if A/B shows max
over-boosts sessions that merely touched a good skill; the scoring module returns
per-artifact scores, so the aggregation is a one-line change.) With α = 0.3 a
perfect-proven-use result improves its effective rank by at most 30%: relevance
stays primary, proven-use breaks ties and nudges. A wrong score can reorder
near-neighbors, never drag an irrelevant result to the top.

`ALPHA` is the single trust knob for the unvalidated judge and is config-exposed:
raise it if validation shows the judge is strong, set it to 0 to get exactly
today's recall (the kill switch).

## Data flow

**Write (during a scan, when `retainSequences: true`):**
```
scanWorkflow → SessionSequence.eventSeries  ┐
                                            ├─ join on sessionId → upsert triples
judgeSessions → SessionFacet.outcome        ┘
```
A session with a `missionHint` but no facet is **skipped** (not written with a null
outcome). This join is added where the two are already both in scope; it does not
add a scan pass.

**Read (at recall query time, independent):**
```
BM25 candidates → per-session artifact lookup → outcome-score → re-rank
```

## Validation

The signal is an unvalidated LLM judge; validating it cheaply is a deliverable, not
a footnote. Two instruments:

1. **A/B recall (shipped behind a hidden flag).** Same query run twice — pure BM25
   vs boosted — shown side by side. The author runs real queries against their own
   years of transcripts and judges whether boosted is better / worse /
   indistinguishable. The reference consumer *is* the validation instrument.
2. **Judge-agreement probe (offline script, not shipped).** For sessions with an
   independent ground truth the judge never saw — did the work get committed?
   merged? reverted? — measure whether `mostly_achieved` correlates with "the code
   survived." If the judge says achieved on reverted work, α → 0. Closest thing to
   lift-validation at single-user scale, using git history already present.

Instrument 1 says whether the ranking *feels* right; instrument 2 says whether the
*signal is real*. Both are enough to decide α; neither is a benchmark.

## Testing

House pattern (pure function → deterministic test):

- **`outcome-score`:** the 2/2 vs 40/45 inversion as a literal assertion;
  `PARTIAL_CREDIT = 0.5`; `n = 0` → 0 not NaN; monotonicity (more successes at fixed
  n never lowers score).
- **`eventSeries × facet` join:** a fixture session with known artifacts + known
  outcome produces exactly the expected triples; a session with `missionHint` but no
  facet is skipped.
- **Writer idempotency:** scanning the same session twice yields one row per
  artifact, not two.
- **Recall boost direction:** two results tied on BM25; the higher-proven-use one
  sorts first. This is the test that catches the ascending-BM25 sign error.

Not tested here: the LLM judge itself (existing shipped code), the ACP distill agent.

## Compatibility

**Interaction with `2026-07-10-transcript-index-raw-rows-design.md` (in flight).**
That spec moves `global_usage` from resolved rows to raw tokens resolved at query
time, to avoid a 17.4 s full-corpus rebuild on inventory churn. `artifact_outcomes`
stores **resolved** `artifact_name` (from the `eventSeries × facet` join, which
resolves via inventory), so it inherits the same invalidation question: if the
inventory renames or remaps an artifact, historical resolved rows can go stale.
Two options, decided in planning: (a) accept staleness — a renamed artifact simply
starts a fresh score, acceptable for a bounded boost; (b) store the raw token
alongside the resolved name and resolve at read time, mirroring the raw-rows
approach. Lean (a) for v1 — the blast radius is a re-rank nudge, not a correctness
guarantee — and revisit if raw-rows lands first.

## Out of scope

1. **Gem-verification outcomes** (`evidenceLedger.ts`, `verifyMatrix.ts`) — the
   objective `passed` signal, but keyed on `gemDigest` + `agent` with **no
   sessionId**, so unjoinable without a ledger schema change. Additive to the same
   `outcome-score` module when it comes.
2. **The other three consumers** — ACP recommender, agent-runtime context
   selection, marketplace rank. Each a later spec over this store + score.
   Recommender is the natural second; context selection last (no component exists
   yet); marketplace waits for cross-user volume.
3. **Cross-user / networked outcomes** — everything here is single-machine, local
   SQLite. The `attestation`/`aggregator` publish path is untouched; no privacy
   surface changes.
4. **Lift over baseline** — stored for (the guard columns), not computed. Shipping
   the shrunk rate.
5. **Recency decay** in the score — `at_ms` stored, not weighted.
6. **Tuned constants** — `PARTIAL_CREDIT = 0.5`, `ALPHA = 0.3` are shipped defaults,
   not researched values; tuned after the validation instrument, not before.

The through-line: v1 builds the **machinery** (durable triple + shared scoring + one
proven consumer + the instrument to judge the signal). It does not ship the pitch
claim "proven-use-ranked context" — that needs instrument 2 positive first.
