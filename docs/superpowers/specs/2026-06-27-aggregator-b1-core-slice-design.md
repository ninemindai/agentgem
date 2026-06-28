# Aggregator B1 — Local Core Slice — Design

**Date:** 2026-06-27
**Status:** Approved design, pre-implementation
**Parent:** [Spec B1 — Hosted Aggregator](2026-06-27-aggregator-ingredient-data-moat-design.md). This is the **first buildable slice** of B1: the verify → public-ingredient-graph → aggregate **loop**, in-repo, runnable against real Spec A attestations. The hosted Next.js/Vercel wrapper, OAuth, UI, and gated API are later slices.

## Goal & success criterion

Prove the moat loop end to end on **real Spec A data**: a signed attestation is verified, its **public** ingredients projected into a Postgres graph, and `popularity` / `co-occurrence` aggregates answer correctly under a **k-anonymity floor** — with the SQL written here being the *production* SQL (no rewrite for the hosted slice).

Done = `ingestAttestation()` accepts the smoke harness's real attestation, public ingredients land as edges, and the aggregates + k-anon property tests pass on real in-process Postgres.

## Reconciliation with what Spec A actually ships (important)

The parent B1 spec predates Spec A's implementation + Codex remediation. Three corrections, all driven by Spec A reality:

1. **No `verified` tier / `evidence.signal` / salted tuples.** Spec A dropped all of it; `evidence` is now just `{ signalDigest }` (a hash over the aggregate ingredient rows). There is nothing to recompute against. Trust = **deterministic door checks + (later) statistical detection**. (The parent B1 spec's Decision 4 + verified-tier steps are superseded — flagged as a follow-up to amend.)
2. **Public-only aggregation.** Spec A emits PUBLIC ingredient ids that are stable across producers (`skill:superpowers@…/brainstorming`, `mcp:context7@…`) and PRIVATE ids that are **per-attestation salted → unlinkable → cannot aggregate**. So the usage graph is the **public-ingredient graph**; private ids are recorded as an opaque per-attestation count and **never become `ingredients` rows**.
3. **`gem.digest` is the reconcilable pre-attestation payload digest**, and identity is the **ed25519 `pubkey`** (OAuth/account binding is the hosted slice).

## Key decisions

1. **Local core, same repo, max reuse.** New `src/aggregator/`; all verify/trust primitives imported from `src/gem/` (`verify`, `verifyLock`, `readGemArchive`, `computeLock`, `canonicalJSON`, attestation types). No duplication.
2. **Storage = `pglite` (embedded Postgres, in-process).** Single new dep `@electric-sql/pglite`. The aggregate + k-anon SQL written here is the production SQL; the hosted slice swaps the pglite handle for a hosted Postgres connection with no rewrite. No docker, no server; tests run real SQL in-process.
3. **Aggregates = popularity + co-occurrence** for this slice; adoption-over-time deferred.
4. **k-anon enforced in SQL** (`HAVING count(distinct producer) >= K`), not post-filtered. `K` configurable (dev default 1).
5. **No HTTP/OAuth/UI/billing/statistical-detection** in this slice — `ingestAttestation()` is a plain function the hosted route will wrap. `trust_score`/`quarantined` columns exist (default trusting) for the later statistical layer.

## Architecture

```
src/aggregator/
  schema.sql      -- production Postgres DDL (validated on pglite now, hosted PG later)
  db.ts           -- pglite handle + migrate() + thin typed query helpers
  ingest.ts       -- ingestAttestation(att, archiveBytes?) -> IngestResult
  project.ts      -- upsert producer/attestation; public ingredients -> edges; private -> opaque count
  aggregates.ts   -- popularity() + coOccurrence(), k-anon in the SQL
  seed.ts         -- synthetic multi-producer seeding (flagged synthetic) to demo the moat
  __tests__/
```

Only new dependency: `@electric-sql/pglite`. Everything else reused from `src/gem/`.

## Schema (real Postgres DDL — public-only graph)

```sql
create table producers (
  pubkey       text primary key,
  first_seen   timestamptz not null default now(),
  attest_count int not null default 0
);
create table attestations (
  id              uuid primary key,
  gem_name        text not null,
  gem_digest      text not null unique,          -- reconcilable pre-attestation payload digest
  producer_pubkey text not null references producers(pubkey),
  harness_id      text not null,
  models          text[] not null default '{}',
  scan_sessions   int not null,
  scan_span_days  int not null,
  signal_digest   text not null,
  private_count   int not null default 0,         -- # of private (unlinkable) ingredients, opaque
  trust_score     real not null default 1,        -- statistical layer later
  quarantined     bool not null default false,    -- statistical layer later
  ingested_at     timestamptz not null default now()
);
create table ingredients (
  id           text primary key,                  -- canonical PUBLIC id (skill:.../... , mcp:.../... , model, harness)
  kind         text not null,                      -- harness | model | skill | mcp | tool
  id_kind      text not null,                      -- plugin | registry | package | url | known
  display_name text,
  first_seen   timestamptz not null default now(),
  last_seen    timestamptz not null default now()
);
create table usage_edges (
  attestation_id uuid not null references attestations(id),
  ingredient_id  text not null references ingredients(id),
  invocations    int  not null,
  sessions       int  not null,
  primary key (attestation_id, ingredient_id)
);
```

Quarantined attestations and their edges are excluded from every aggregate (future). Models/harness are themselves public ingredients (rows in `ingredients`) so popularity/co-occurrence cover them uniformly.

## Ingest / verify pipeline (`ingest.ts`)

`ingestAttestation(att: UsageAttestation, archiveBytes?: Uint8Array): Promise<IngestResult>`

1. **Signature** — `verify(att.producer.publicKey, canonicalJSON(att∖signature), att.signature)`. Fail → `{ rejected: "bad-signature" }` (the hosted route maps to 400).
2. **Digest reconcile** (only if `archiveBytes` provided) — `readGemArchive` + `verifyLock`; recompute `computeLock(archive∖attestation.json).gemDigest` and require it equals `att.gem.digest`. Mismatch → `{ rejected: "digest-mismatch" }`. (No archive bytes → accepted as lower-evidence telemetry; `gem_digest` taken from `att.gem.digest`.)
3. **Internal consistency** — for every ingredient row: `sessions <= scan.sessions` and `invocations >= sessions`. Violation → `{ rejected: "inconsistent" }`.
4. **Idempotency** — unique `gem_digest`; re-ingest returns the prior `{ accepted, id }` without duplicating.
5. **Project** (`project.ts`) — upsert `producers(pubkey)`; insert `attestations`; for each ingredient with `public:true` → upsert `ingredients` + insert `usage_edges`; count `public:false` ingredients into `attestations.private_count` (no rows). Return `{ accepted, id, publicIngredients, privateCount }`.

Identity is the ed25519 `pubkey` (no OAuth). No quarantine/statistical detection in this slice.

## Aggregates + k-anon (`aggregates.ts`, real SQL)

- `popularity({ kind?, limit, k }): Promise<{ id, kind, producers, invocations, sessions }[]>`
  ```sql
  select e.ingredient_id as id, i.kind,
         count(distinct a.producer_pubkey) as producers,
         sum(e.invocations) as invocations, sum(e.sessions) as sessions
  from usage_edges e
  join attestations a on a.id = e.attestation_id and not a.quarantined
  join ingredients  i on i.id = e.ingredient_id
  where ($1::text is null or i.kind = $1)
  group by e.ingredient_id, i.kind
  having count(distinct a.producer_pubkey) >= $2   -- k-anon, in the SQL
  order by producers desc, invocations desc
  limit $3;
  ```
- `coOccurrence({ id, limit, k })` — ingredients sharing a producer with `id`; `count(distinct producer)` per partner; `having ... >= k`.
- `K` from config (dev default 1; tests use 2). The floor lives in the SQL `having`, never a post-filter.
- `seed.ts` — `seedSynthetic(n)` inserts `n` synthetic producers (pubkeys prefixed `synthetic:`) with plausible public-ingredient usage, so popularity/co-occurrence/k-anon are demonstrable with one real producer. Synthetic producers are flagged and easy to purge.

## Testing (real SQL via pglite, in-process)

- **Ingest verify** — valid → accepted + projected; bad signature → rejected; `gem.digest` mismatch (with archive bytes) → rejected; internal inconsistency → rejected; re-ingest same `gem_digest` → idempotent (no dup).
- **Projection** — `public:true` ingredients become `ingredients` + `usage_edges`; `public:false` ingredients do NOT create `ingredients` rows and increment `private_count`.
- **Aggregate correctness** — popularity + co-occurrence match hand-computed values over a small fixture set.
- **k-anon property** — K=2, seed 3 producers; an ingredient used by only 1 producer is absent from every aggregate result (UI- and API-equivalent paths).
- **Real-data** — feed the smoke harness's actual signed attestation (`scratchpad/e2e-smoke.mjs` output); assert its public ingredients (e.g. `mcp:context7@claude-plugins-official/context7`, `skill:superpowers@…/brainstorming`) land as edges and surface in `popularity` once K is met (via seeding).

## Out of scope — captured todos (later slices)

- **B1-hosted:** Next.js App Router route wrapping `ingestAttestation`, Vercel deploy, hosted Postgres connection (swap pglite handle), Vercel Blob for stored bytes.
- **Identity/trust:** OAuth (Sign in with Vercel / GitHub) + account binding; reputation/trusted-producer weighting; **statistical detection + quarantine** (abuse triage); velocity caps.
- **Exposure:** public teaser UI; gated/billed data API + API keys + rate limits.
- **Aggregates:** adoption-over-time (time buckets); ingredient co-occurrence matrix export.
- **Parent-spec hygiene:** amend [Spec B1](2026-06-27-aggregator-ingredient-data-moat-design.md) to mark the `verified`-tier / `evidence.signal` / tuples sections **superseded** (Spec A dropped them).
- **Cross-spec product question:** whether private ingredients should ever aggregate (e.g. producer-stable salt for within-producer dedup) — currently they cannot, by design.
- **Wire Spec A:** point `sign_and_publish`'s ingest POST at the hosted endpoint once it exists (Spec A's ingest client already supports it; currently skips when unconfigured).
