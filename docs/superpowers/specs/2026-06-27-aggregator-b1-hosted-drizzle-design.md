# Aggregator B1 — Hosted HTTP Slice (on @agentback/drizzle) — Design

**Date:** 2026-06-27
**Status:** Approved design, pre-implementation
**Parent:** [Spec B1 — Hosted Aggregator](2026-06-27-aggregator-ingredient-data-moat-design.md) · builds on [B1 core slice](2026-06-27-aggregator-b1-core-slice-design.md) (PR #9).

## Goal

Expose the B1 aggregator over HTTP using the repo's own `@agentback/rest` server, backed by a **real hosted Postgres**, by adopting the repo's blessed DB recipe — **`@agentback/drizzle`**. The producer POSTs a signed attestation to an ingest route; two read routes serve k-anon'd `popularity` / `co-occurrence`. No Next.js.

**Scope consequence (accepted):** this **reworks the B1 core onto Drizzle** — it re-opens PR #9's code. The merged B1 lands as the Drizzle version; the raw-SQL/pglite-`DB`-interface core is superseded. The core's *correctness properties are preserved and re-tested* (public-only projection, k-anon-in-SQL, ed25519 verify), just expressed through Drizzle.

## Why @agentback/drizzle

It is the framework-native DB integration (`docs/db-story.md`, the "blessed recipe"): `registerDrizzle(app, client, {onStop})` binds the Drizzle client for DI + drains the pool on `app.stop()`; controllers `@inject(DrizzleBindings.CLIENT)`. It is **dialect-generic** (you pass the client), so the same code runs on `drizzle-orm/pglite` (tests, in-process) and `drizzle-orm/node-postgres` (prod) — native tests↔prod portability. `drizzle-zod` (`@agentback/drizzle/zod`) derives Zod schemas from the table defs: one artifact drives the row type, the validator, the OpenAPI doc, and the MCP tool schema.

Verified: `RestApplication` (from `@agentback/rest`) is an `@agentback/core` Application with `@agentback/context` DI, so `registerDrizzle`/`@inject` work. New deps: `@agentback/drizzle`, `@agentback/context`, `drizzle-orm`, `drizzle-zod`, `pg`, `@types/pg`.

## Key decisions

1. **Drizzle schema is the single source of truth.** `src/aggregator/schema.ts` defines the 4 tables as Drizzle `pgTable`s (`producers`, `attestations`, `ingredients`, `usage_edges`); `drizzle-zod` derives row/response schemas. The raw `SCHEMA` DDL string and the hand-rolled `DB` interface / `pgDriver` idea are **dropped**.
2. **Core reworked onto the injected Drizzle client.** `ingest`/`project`/`aggregates`/`seed` take a Drizzle db; upserts/inserts use the query builder (`db.insert(...).values(...).onConflictDoUpdate(...)`), and the k-anon aggregates use Drizzle's `sql\`\`` raw fragment (`having sql\`count(distinct ...) >= ${k}\``). **k-anon stays in the SQL**, never a JS post-filter.
3. **Dual driver.** Prod: `drizzle(new Pool({ connectionString: DATABASE_URL }), { schema })`. Tests: `drizzle(new PGlite(), { schema })` (`drizzle-orm/pglite`), in-process, fresh per test. Same core code, both.
4. **k-anon is server policy, not a query param.** Read routes do **not** accept `k` from the caller; they always apply `DEFAULT_K` (the safe floor). A public consumer must never be able to lower the floor to de-anonymize.
5. **Identity = the ed25519 signature** (verified in the core). **No OAuth** this slice (account-binding is trust-layer follow-up #28).
6. **No Blob byte-storage, no UI, no billing, no cloud deploy** this slice (deferred). If `DATABASE_URL` is unset, the aggregator routes return `503` so the rest of the server still runs.

## Architecture

```
src/aggregator/
  schema.ts        -- Drizzle pgTable defs (source of truth) + drizzle-zod schemas
  ingest.ts        -- verifyAttestation (unchanged) + ingestAttestation(db, att) [db = Drizzle client]
  project.ts       -- projectAttestation(db, att): public ingredients -> rows; private -> private_count
  aggregates.ts    -- popularity(db, ...) + coOccurrence(db, ...), k-anon via sql`having ...`
  seed.ts          -- seedSynthetic(db, n, ids) (idempotent)
  testDb.ts        -- NEW: makeTestDb() -> drizzle(new PGlite(), {schema}) for tests
  __tests__/       -- reworked onto the Drizzle client; same assertions as the core slice
src/aggregator.controller.ts   -- NEW: @inject(DrizzleBindings.CLIENT); POST /aggregator/ingest, GET .../popularity, GET .../co-occurrence
src/index.ts                   -- construct prod Drizzle client + registerDrizzle(app,{onStop}); app.restController(AggregatorController) (guarded on DATABASE_URL)
```

`verifyAttestation` (pure, signature + consistency) is unchanged — it has no DB. Only the DB-touching functions are reworked.

## Schema (`schema.ts`, Drizzle)

`pgTable` definitions mirror the core slice exactly:
- `producers(pubkey pk, first_seen, attest_count)`
- `attestations(id uuid pk, gem_name, gem_digest unique, producer_pubkey fk, harness_id, models text[], scan_sessions, scan_span_days, signal_digest, private_count, trust_score, quarantined, ingested_at)`
- `ingredients(id pk, kind, id_kind, display_name, first_seen, last_seen)`
- `usage_edges(attestation_id fk, ingredient_id fk, invocations, sessions, pk(attestation_id, ingredient_id))`

Schema is applied via **drizzle migrations** (drizzle-kit generate → `migrate()` at startup); tests apply the same schema to the pglite client (drizzle `migrate`, or `db.execute` of the generated SQL). The plan picks the exact mechanism; the property required is "tables exist before first query, identically in tests and prod."

## Core rework (preserve the invariants)

- **`projectAttestation`** — same logic: `publicNodes()` is the only mapper; `public:false` ingredients only bump `private_count`, never become rows. Inserts via `db.insert(...).onConflict...`. Harness/model edges use `scan.sessions` for invocations+sessions; skills/mcps use their own.
- **`ingestAttestation`** — `verifyAttestation` → reject writes nothing → `gem_digest` idempotency lookup → `projectAttestation`.
- **`aggregates`** — `popularity`/`coOccurrence` keep `count(distinct producer_pubkey)` and the `having … >= k` floor as Drizzle `sql` fragments; `not quarantined` in the join; `DEFAULT_K` exported and the default.
- **`seed`** — idempotent synthetic producers.

## Endpoints (`aggregator.controller.ts`)

- `POST /aggregator/ingest` — body: the signed `UsageAttestation` (validated loosely; the core's `verifyAttestation` is the real gate). Returns `200 { accepted:true, id, publicIngredients, privateCount, idempotent }` or `400 { accepted:false, rejected }`.
- `GET /aggregator/popularity?kind=&limit=` — returns the k-anon'd popularity list (drizzle-zod response schema). **No `k` param.**
- `GET /aggregator/co-occurrence?id=&limit=` — k-anon'd partners. **No `k` param.**
- All call the injected Drizzle client; `DEFAULT_K` applied server-side.

## Wiring (`index.ts`)

```ts
// only when DATABASE_URL is set:
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const db = drizzle(pool, { schema });
await migrate(db, { migrationsFolder: "drizzle" });
registerDrizzle(app, db, { onStop: () => pool.end() });
app.restController(AggregatorController);
```
If `DATABASE_URL` is unset, skip registration; the aggregator routes (if hit) return `503 not-configured`.

## Testing (drizzle-pglite, in-process)

Reuse the core slice's assertions, reworked onto the Drizzle client (`makeTestDb()`):
- **verify** — valid accepted; bad signature `400`-equivalent; inconsistent rejected (verifyAttestation unchanged).
- **projection** — public ingredients (harness + models + public skills/mcps) become rows/edges with correct counts; private never a row; `private_count` correct; harness/model edges = `scan.sessions`.
- **ingest** — accept+project; idempotent on `gem_digest` (no dup); reject writes nothing.
- **aggregates + k-anon** — popularity/co-occurrence correct; a 1-producer ingredient suppressed at the floor; **the read routes ignore a caller-supplied `k`** (a `?k=1` query must not lower the floor — controller-level property test).
- **real-data** — a real signed Spec A attestation’s public skill (`skill:superpowers@…/brainstorming`) surfaces once seeding clears the floor.
- **controller** — `app.stop()` drains the pool (lifecycle); routes return the documented shapes; `503` when unconfigured.

## Out of scope — captured todos (later slices)

- OAuth account-binding + reputation + statistical detection/quarantine (#28); velocity caps.
- Blob byte-storage of the raw signed attestation/archive.
- Public teaser UI + gated/billed data API + rate limits (#29).
- adoption-over-time aggregate (#30).
- The actual cloud deploy (Vercel Node function / Fly / container) + provisioning the hosted Postgres (Vercel Marketplace Neon/Supabase) + the `DATABASE_URL` secret.
- Wire Spec A `sign_and_publish` → this ingest endpoint (#32) once deployed.
- Amend the parent B1 spec's stale verified-tier (#31).
