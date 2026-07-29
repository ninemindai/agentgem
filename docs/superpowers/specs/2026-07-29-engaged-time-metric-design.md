# Engaged-time metric for the Overview "active" stat

**Date:** 2026-07-29
**Status:** Approved design, pending implementation plan

## Problem

The Observe → Overview tab shows an "active" duration (e.g. `67.1h`) that can
exceed 24 hours in a single day. Two compounding causes, both by construction:

1. **Idle time is counted.** Each session contributes its full first-event →
   last-event wall-clock span (`observeScan.ts`: `startMs`/`endMs` are the
   `min`/`max` of record timestamps). A session left open for hours with a few
   minutes of real work contributes its entire elapsed span.
2. **Concurrent sessions are summed, not merged.** `observeAggregate.ts` does
   `pActive += Math.max(0, s.endMs - s.startMs)` across every session, so
   overlapping wall-clock is added multiple times.

The same span-sum feeds the Home/Reveal "active hours" ledger
(`home.controller.ts` → `Reveal.tsx`, rounded to whole hours).

## Decisions (locked with the requester)

- **Metric meaning:** per-session **sum** of engaged time (NOT a cross-session
  wall-clock union). Parallel agents can legitimately total >24h/day, read as
  **compute-hours / effort** (like CPU-hours). This keeps the existing
  aggregation shape — the only change is *what each session contributes*.
- **Engaged-time rule:** **cap each consecutive-record gap** at a threshold
  `T = 5 min`. `engaged = Σ min(gap_i, T)`. A long idle gap contributes at most
  `T`; a genuine long operation is counted up to `T`. Never zeroes real work,
  one tunable, harness-agnostic. (Chosen over "exclude gaps > T", which drops
  long tool/build operations entirely, and over a type-aware rule, which is
  fragile because Claude tool-results are recorded as `user`-typed records.)
- **UI label:** rename the Overview stat label `active` → **`engaged`**, and the
  Reveal ledger's "active hours" label to match, so the number reads honestly.
- **Scope:** fix **both** surfaces — the Overview pulse and the Home/Reveal
  ledger — so the two figures never disagree.

## Design

### A. New per-session field `engagedMs`

A pure helper, computed once per session at parse time:

```ts
export const ENGAGED_GAP_CAP_MS = 5 * 60_000; // 5 minutes

/** Sum of consecutive-record gaps, each capped at `capMs`, so idle stretches
 *  contribute at most one cap. Input need not be sorted. */
export function engagedMsFromTimestamps(timestamps: number[], capMs = ENGAGED_GAP_CAP_MS): number {
  if (timestamps.length < 2) return 0;
  const t = timestamps.slice().sort((a, b) => a - b);
  let sum = 0;
  for (let i = 1; i < t.length; i++) sum += Math.min(t[i] - t[i - 1], capMs);
  return sum;
}
```

- Lives alongside the other pure aggregation code (`observeAggregate.ts`) so it
  is browser-shareable and unit-testable in isolation.
- `SessionStat` gains `engagedMs: number` (required field).
- `parseClaudeTranscript` and `parseCodexTranscript` (`observeScan.ts`) already
  iterate every record; each collects valid `ts` values into an array and calls
  the helper. Sorting inside the helper guards against out-of-order
  subagent/sidechain records. `startMs`/`endMs` are retained unchanged.
- Any additional source parsers (`sources/*.ts`, `blastScan.ts`) that emit a
  `SessionStat` must also populate `engagedMs` (from their own timestamps, or
  `Math.max(0, endMs - startMs)` as a conservative fallback when a source only
  exposes a span). Enumerate them during implementation so none emits a
  `SessionStat` missing the required field.

### B. Aggregation + UI read the new field

- `observeAggregate.ts`: `pActive += s.engagedMs` (was `endMs - startMs`).
  The pulse field name stays `activeMs` on the wire (renaming ripples through
  `routes.ts`, the aggregator schema, and the app controller for no user
  benefit); only its computation changes.
- `Dashboard.tsx`: `<Stat label="engaged" ...>` (was `label="active"`).
- `sessions[].durationMs` (per-session table) **stays** the wall-clock span —
  "how long this session was open" is a legitimate per-session fact and never
  sums into the >24h absurdity.

### C. Home/Reveal ledger

- `home.controller.ts`: `activeMs += s.engagedMs` (was `endMs - startMs`).
- `Reveal.tsx`: label the ledger figure "engaged" to match.

### D. Cache invalidation (mandatory — three caches hold `SessionStat`)

Adding a field to a cached shape is a stale-serve trap: a cache written before
this change would be served without `engagedMs`. Covered by two version bumps:

- `analysisCache.ts` `TOKEN_VERSION` `"v3" → "v4"` (with the running comment:
  `v4 = SessionStat now carries engagedMs`). Invalidates the in-memory and
  `session-scan.json` whole-scan caches and the token-gated analysis payload
  cache.
- `sources.ts` `ParseCacheFile` `v: 1 → 2` (bump the literal in the type, the
  written value, and the load-time acceptance check). Invalidates the per-file
  parse cache, which is keyed by mtime/size and would otherwise return old
  fieldless stats even after the code changes.

### E. Tests

- **TDD first:** unit tests for `engagedMsFromTimestamps` —
  - two close records → full gap counted;
  - a gap larger than the cap → contributes exactly `T`;
  - a mix (idle gap + genuine long op both capped) → sum matches;
  - empty / single-element input → `0`;
  - unsorted input → same result as sorted.
- Update existing observe/home tests that assert on `activeMs` to the new
  engaged-time expectation. Add a parser-level assertion that a synthesized
  transcript with a large idle gap yields `engagedMs` far below its span.

## Non-goals

- No cross-session wall-clock union (explicitly rejected; >24h/day is accepted
  as compute-hours).
- No wire/DB rename of `activeMs`.
- No change to per-session `durationMs` semantics.
- Threshold `T` is hardcoded at 5 min (YAGNI — no config surface until asked).
