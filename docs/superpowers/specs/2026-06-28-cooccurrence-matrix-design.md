# Co-occurrence matrix export (#46 / #30 second half) — Design

**Date:** 2026-06-28
**Status:** Approved (brainstorm). Generalizes the shipped pivot-based `coOccurrence(id)` to an all-pairs JSON edge list. Builds on the B1 aggregator + the `verifiedProducers` overlay (both on `origin/main`).

## Goal

Expose the full co-occurrence graph as a sparse **all-pairs edge list**: every co-used (skill/mcp)
ingredient pair with the count of distinct producers that used both — k-anonymized, with the verified
overlay — so a heatmap/matrix view or third-party analysis can read the whole graph in one call instead of
N pivot queries.

The existing `coOccurrence(db, { id })` answers "what co-occurs with THIS ingredient". `#46` is the
no-pivot generalization: "every co-occurring pair".

## Decision (confirmed)

JSON edge list (not CSV download, not a dense N×N matrix). Consistent with every other aggregator read,
directly consumable by the site/console, and sparse — only pairs that clear the k-anon floor are emitted.
CSV is a deferred trivial follow-up on the same query.

## The aggregate — `coOccurrenceMatrix(db, { limit?, k? })`

Self-join `usage_edges` over the same attestation with no fixed pivot, constrained to **unordered pairs**:

```sql
select e1.ingredient_id as a, e2.ingredient_id as b,
       count(distinct at.producer_pubkey)::int as producers,
       count(distinct bnd.provider || ':' || bnd.account_id)::int as "verifiedProducers"
from usage_edges e1
join usage_edges e2 on e2.attestation_id = e1.attestation_id and e1.ingredient_id < e2.ingredient_id
join ingredients i1 on i1.id = e1.ingredient_id and i1.kind in ('skill','mcp')
join ingredients i2 on i2.id = e2.ingredient_id and i2.kind in ('skill','mcp')
join attestations at on at.id = e1.attestation_id and not at.quarantined
left join account_bindings bnd on bnd.pubkey = at.producer_pubkey
group by e1.ingredient_id, e2.ingredient_id
having count(distinct at.producer_pubkey) >= ${k}
order by producers desc, a, b
limit ${limit}
```

- **`e1.ingredient_id < e2.ingredient_id`** — emits each unordered pair exactly once (lexicographic
  dedupe), eliminates the self-join identity row (`a = a`), and halves the join work. Strictly better than
  `<>` + post-dedup.
- **Tools-only both sides** (`i1.kind`/`i2.kind in ('skill','mcp')`) — matches the shipped
  `overview`/`popularity`/`coOccurrence`, which deliberately exclude harness/model (they'd dominate via
  shared-attestation co-occurrence).
- **`not at.quarantined`** — detection/quarantine flows through here like every other read.
- **k-anon gate** `having count(distinct at.producer_pubkey) >= ${k}`, `k = DEFAULT_K` server policy. Output
  is sparse: a pair below the floor is suppressed, not zero-filled.
- **`verifiedProducers`** per edge via the `account_bindings` LEFT JOIN (PK join, no fan-out) — the same
  trust overlay the other reads carry.
- Deterministic order: `producers desc, a, b` (the `a, b` tiebreak keeps output stable for tests/diffs).
- Returns `{ a: string; b: string; producers: number; verifiedProducers: number }[]`.

`limit` bounds the payload (the matrix is O(pairs)); default 500, applied as the SQL `limit`. `k` is never
caller-supplied (server policy), matching the other reads.

## The endpoint — `GET /api/aggregator/co-occurrence-matrix`

- On `AggregatorController` (`@get`), query `{ limit?: coerce number }` (omits `k`), response
  `z.array(z.object({ a: z.string(), b: z.string(), producers: z.number(), verifiedProducers: z.number() }))`.
- Delegates to `coOccurrenceMatrix(this.db, { limit: input.query.limit })`.
- Add `/api/aggregator/co-occurrence-matrix` to `originGuard`'s `PUBLIC_READ_PATHS` — a public,
  side-effect-free, k-anon read (CORS-open + cross-site-exempt), exactly like popularity/co-occurrence/
  adoption/summary. Writes stay guarded.

## Reuse / invariants

k-anon-in-SQL (bound `${}` params, no concat), `not quarantined`, tools-only kind filter, the
`account_bindings` verified overlay, the public-read CORS pattern, the controller shape — all reused. No new
dependency, no schema change.

## Error handling

- Empty DB or no pair clearing the floor → `[]` (not an error).
- `limit` absent → default 500; the route's `z.coerce.number()` parses the query param.

## Testing (drizzle-pglite, `src/aggregator/__tests__/cooccurrenceMatrix.test.ts`)

- Two producers each using `{skill:a, skill:x}` → one edge `(skill:a, skill:x)` with `producers = 2`; the
  pair appears **once** (no `(skill:x, skill:a)` duplicate) and no self-pair `(a,a)`.
- A pair used by only 1 producer is suppressed at a higher `k`; visible at `k = 1`.
- Quarantined attestations excluded from the counts.
- A bound producer raises only `verifiedProducers`, not `producers`.
- A harness/model ingredient never appears on either side of any pair (tools-only).
- `limit` caps the row count, keeping the highest-`producers` pairs.

originGuard (`src/__tests__/originGuard.test.ts`): a cross-site GET to `/api/aggregator/co-occurrence-matrix`
is allowed and sets `Access-Control-Allow-Origin: *`.

## Scope

**In:** `coOccurrenceMatrix` aggregate, the `GET /co-occurrence-matrix` route + zod schemas, the originGuard
public-read exemption, and the tests above.

**Deferred:** a CSV download variant of the same query; any UI/heatmap consumer; pagination beyond a flat
`limit` (cursor/offset); weighting edges by `trust_score`.
