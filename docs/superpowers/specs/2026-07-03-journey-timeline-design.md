# `/journey` — unified learning timeline — design

- **Date:** 2026-07-03
- **Status:** Spec (awaiting user review)
- **Slice:** Part III of [hermes-borrows](../../proposals/hermes-borrows.md)
- **Surface decision (made while user AFK, override welcome):** the timeline's home is
  the **Dreaming panel, grown into "Journey"** — its separate queue and diary views merge
  into one chronological timeline. Rationale: the observe sidebar group already holds 7
  panels, and Dreaming's two views are exactly what Journey unifies; a new top-level
  panel would duplicate them. The panel keeps its id (`dreaming` — navigation stability)
  and 🌙 icon; the title becomes "Journey" and the dream status strip stays.
- **Not borrowed (per the proposal):** Hermes's radial memory graph — the list timeline
  ships first; a graph can be a later view over the same endpoint.

## Goal

One chronological answer to "what has AgentGem learned from this machine's sessions,
and what did I do about it?" — merging the dream review queue (pending, accepted,
dismissed; DEEP/REM harvests and LEARN finds alike), dreaming pass history, and the
phase-1 verification-evidence ledger into a single read-side timeline. A lens, not a
store: the only mutations are the existing accept/dismiss queue endpoints.

Success criteria:

1. `GET /api/journey` returns a newest-first merged timeline of three sources: queue
   items (one event per item, timestamped by its latest activity), dream passes, and
   verification-ledger records — each event typed by `kind`.
2. The Journey panel (formerly Dreaming) renders the timeline with kind filters; queue
   events still expose accept/dismiss (existing endpoints; timeline refreshes after).
   The dream status strip (enabled toggle, phases lit, promoted count) is unchanged.
3. `?kind=` filters server-side; `?limit=` bounds the response (default 100,
   newest-first before truncation) and truncation is visible (`truncated: true`).
4. The verification ledger gains its first reader: a tolerant JSONL parser that skips
   corrupt lines and never throws (the ledger is best-effort on write; the reader
   matches).
5. Accepted/dismissed queue items appear on the timeline with their review status and
   time — the history the queue view previously hid (it filtered to `queued`).

## Decisions and alternatives considered

**One event per queue item, not two.** An item reviewed on Tuesday after queueing on
Monday appears once, at its review time, with `status: "accepted"`. Emitting separate
queued/reviewed events doubles rows for no decision value at this scale; the event
carries `firstSeenMs` so the panel can show "queued 2d before" if it wants.

**Colocated on the dream controller.** `GET /api/journey` reads the same stores the
dream endpoints own (queue, diary) plus the ledger; a separate controller would split
one data neighborhood across files. The aggregation itself is a pure, separately
testable core (`src/journeyCore.ts`).

**Ledger reading lives in `@agentgem/run`** (`readVerifications` beside
`appendVerification`) — the writer's module owns the format; the journey core stays a
consumer.

**Rejected:** a new journey store or event log (a lens must not become a second source
of truth); a new top-level panel (IA weight + duplication, see header); folding into
Curate (Curate is a build surface; the timeline is an observe surface).

## Components

### 1. Ledger reader — `packages/run/src/evidenceLedger.ts`

```ts
// Tolerant read: corrupt/partial lines are skipped (the writer is best-effort append;
// a torn line must not break every future read). Returns newest-last file order.
export function readVerifications(home?: string, limit = 500): VerificationRecord[]
```

Reads `ledgerPath(home)`; missing file → `[]`; per-line `JSON.parse` in try/catch,
skipping failures; keeps the last `limit` parseable records.

### 2. Aggregation core — `src/journeyCore.ts`

```ts
export interface JourneyEvent {
  ts: number;                                   // epoch ms, sort key (newest first)
  kind: "skill" | "lesson" | "opportunity" | "pass" | "verified";
  title: string;                                // entry name / pass summary / gem name
  detail?: string;                              // summary / verdict text
  status?: "queued" | "accepted" | "dismissed"; // queue-backed events only
  phase?: "DEEP" | "REM" | "LEARN";             // queue-backed events only
  key?: string;                                 // queue key — presence + status "queued" enables actions
  firstSeenMs?: number;                         // queue-backed: when it originally queued
  root?: string;                                // project root (queue + pass events)
  agent?: string;                               // verified events
  passed?: boolean;                             // verified events
}

export interface JourneyResult { events: JourneyEvent[]; truncated: boolean }

export function buildJourney(opts: {
  base?: string;                    // queue/diary + ledger home (default agentgemHome())
  kind?: JourneyEvent["kind"];      // server-side filter
  limit?: number;                   // default 100
  readLedger?: typeof readVerifications;  // test seam
}): JourneyResult
```

Mapping:
- Queue entries (`readQueue`, ALL statuses): `ts = reviewedMs ?? firstSeenMs`,
  `kind = entry.kind`, `title = entry.name`, `detail = entry.summary`, plus
  `status/phase/key/firstSeenMs/root`.
- Diary entries (`readDiary`): `kind: "pass"`, `ts = atMs`,
  `title = "dream pass #<passId>"`, `detail` summarizing phases lit + enqueued counts,
  `root` = first processed root when exactly one.
- Ledger records: `kind: "verified"`, `ts = Date.parse(rec.ts)` (unparseable → skip),
  `title = rec.gemName ?? rec.gemDigest ?? "gem"`, `agent`, `passed =
  rec.verification.passed`, `detail` = first failed check or "all checks passed".

Merge → sort desc by `ts` (tie: stable) → apply `kind` filter → truncate to `limit`
(`truncated` = whether truncation dropped events).

### 3. Endpoint — `GET /api/journey` (`src/dream.controller.ts`)

Query `{ kind?, limit? }` (zod-validated; bad kind → 400 via schema enum), response
`{ events: JourneyEvent[], truncated: boolean }` with a full zod schema. Thin
delegation to `buildJourney({ base: this.base, ... })`.

### 4. Console — Dreaming panel becomes Journey (`packages/console/src/panels/Dreaming/`)

- Title "Journey" (id stays `dreaming`, icon stays 🌙, order/group unchanged).
- The separate queue-list and diary-list sections are replaced by one timeline list fed
  by `GET /api/journey`: each event renders kind badge (incl. LEARN phase badge on
  queue events), title, detail, relative time, and status; events with `key` and
  `status === "queued"` render the existing Accept/Dismiss buttons (existing
  `/dream/queue/accept|dismiss` calls, then timeline refetch).
- Kind filter chips (All · Skills · Lessons · Opportunities · Passes · Verified) map to
  the `kind` query param.
- The status strip (enable toggle, phases lit, promoted count, run-now) is untouched.
- `api.ts` gains the `JourneyEvent`/`JourneyResult` types + fetcher; existing
  accept/dismiss helpers are reused.

## Error handling

- Missing/corrupt ledger or diary/queue files → empty contributions (all three readers
  are already/newly tolerant); `GET /api/journey` never 500s for store-shape reasons.
- Unknown `kind` query → 400 (schema enum).
- Accept/dismiss failures surface exactly as they do today (same endpoints).

## Testing

1. **Ledger reader:** happy path; missing file → `[]`; a corrupt line between two good
   ones → 2 records; `limit` keeps the newest lines.
2. **journeyCore:** merge ordering across all three sources (interleaved timestamps);
   reviewed item uses `reviewedMs` and carries status; kind filter; limit + `truncated`
   flag; empty stores → `{ events: [], truncated: false }`.
3. **Endpoint:** direct controller-instance tests (base seam): events from a seeded
   queue + diary + ledger; 400 on bad kind. (Seed the ledger via `appendVerification`.)
4. **Console:** Dreaming panel tests updated — timeline renders all kinds, filter chips
   work, Accept still fires on a queued event (existing test harness patterns);
   `pages.test.ts` title expectation updated to "Journey".
5. Full root suite + console tests (console IS changed this slice — run locally, not in
   CI).

## Out of scope (later)

Radial graph view; deploy/publish/build events on the timeline (add as new `kind`s when
their stores get read APIs); Curate deep-link on accept (still deferred — the timeline
reuses the existing accept semantics); pagination beyond `limit`; cross-machine
aggregation.
