# Aggregator gating — API keys + per-tier rate limits — Design

**Date:** 2026-06-28
**Status:** Approved (brainstorm). Spec 2 of the data-sharing **exposure** track (after Insights UI polish, PR #21).

**Goal:** Turn the free public aggregator reads into a *governed* surface: every caller is
rate-limited, and presenting a valid API key raises the quota. Validated against a **local
server instance** (no external Postgres). Billing is out of scope.

## Context

The aggregator (`AggregatorController`, `@api({ basePath: "/api/aggregator" })`) exposes
public-read endpoints (`popularity`, `co-occurrence`, `co-occurrence-matrix`, `adoption`,
`overview`) that are CORS-open and `originGuard`-exempt, plus guarded writes (`/ingest`,
`/bind`, `/sweep`). It registers only when `DATABASE_URL` (Postgres) is set (`src/index.ts`).
There is currently **no** auth, API-key, or rate-limit code.

This builds on `@agentback`'s native security stack (confirmed via the `agentback` skill):
`@agentback/authentication` ships an `api-key` strategy + `ApiKeyVerifier`; rate limiting is
`@agentback/extension-rate-limit` (`rate-limiter-flexible`, in-memory or Redis).

## Decisions (locked in brainstorming)

1. **Same endpoints, two tiers.** Keep the existing reads public (the teaser the Insights
   panel depends on). Rate-limit ALL callers; a valid key raises the limit. No new endpoints.
2. **Rate limiting via `@agentback/extension-rate-limit`** (framework-native), not hand-rolled.
3. **Admin-issued keys.** No user accounts (self-serve needs the deferred OAuth binding). An
   admin-token-guarded endpoint mints keys, exactly like the existing `/sweep`.
4. **Embedded pglite for local runs.** When `DATABASE_URL` is unset, back the aggregator +
   `api_keys` with `@electric-sql/pglite` so the whole gated flow runs locally.
5. **Defaults (env-overridable later, hardcoded now):** bad key → **401** (not silent
   anonymous fallback); **three separate rate-limit buckets**: anonymous reads (per-IP,
   **60 req/min** `AGG_ANON_POINTS`), keyed reads (per-key, **600 req/min**
   `AGG_KEYED_POINTS`), and a dedicated **ingest bucket** (per-IP, **120 req/min**
   `AGG_INGEST_POINTS`) — `/ingest` is excluded from both read buckets so a producer
   publish burst never consumes reader quota (or vice-versa). Admin endpoints (`/keys*`,
   `/sweep`) are excluded from all three buckets. Per-pubkey ingest keying (for
   velocity/reputation caps) is a deferred follow-up; this slice keys ingest per-IP.
   `TRUST_PROXY` env (Express "trust proxy") configures correct per-IP limiting behind a
   proxy/LB; off by default.
6. **One keyed tier.** Per-key tiers/plans deferred — every valid key gets the same elevated
   limit. The `api_keys.label` field carries attribution for later.

## Architecture

```
request → originGuard (existing) → apiKeyIdentity (new) → rate limiters (new, 3x) → controller
                                         │                        │
                              x-api-key → sha256 → api_keys   skip/keyGenerator read req.tier
                                                         anon reads (per-IP, 60/min)
                                                         keyed reads (per-key, 600/min)
                                                         ingest (per-IP, 120/min) ← /ingest only
```

The sync/async split is the crux: `rate-limiter-flexible`'s `keyGenerator`/`skip` are
synchronous, but key verification is an async DB hit. `apiKeyIdentity` does the async lookup
once and stashes the result on the request, so the limiter path stays synchronous.

## Components

### 1. `api_keys` table (`src/aggregator/schema.ts`)

```
api_keys(
  id          uuid primary key default gen_random_uuid(),
  key_hash    text not null unique,     -- sha256(plaintext), hex
  label       text not null,            -- human attribution, e.g. "acme prod"
  created_at  timestamptz not null default now(),
  revoked_at  timestamptz                -- null = active
)
```

pglite-compatible DDL (same `create table if not exists` style as the existing schema).

### 2. Key module (`src/aggregator/apiKeys.ts`)

Pure + DB helpers, unit-testable against drizzle-pglite:

- `generateKey(): { plaintext: string; hash: string }` — `plaintext = "ag_" + base64url(32 random bytes)`; `hash = sha256hex(plaintext)`. (Randomness from `node:crypto.randomBytes` — never `Math.random`.)
- `issueKey(db, label): Promise<{ id, plaintext, label }>` — generate, insert `{key_hash, label}`, return plaintext ONCE.
- `verifyKey(db, plaintext): Promise<{ id, label } | null>` — `sha256hex(plaintext)` → lookup where `revoked_at is null`; null if no hit.
- `revokeKey(db, id): Promise<boolean>` — set `revoked_at = now()`.
- `listKeys(db): Promise<{ id, label, created_at, revoked_at }[]>` — never returns hashes.

### 3. Admin issuance endpoints (`AggregatorController`)

Mirror the `/sweep` admin pattern (constant-time token compare; never log the body):

- `@post("/keys")` body `{ token, label }` → `AGGREGATOR_ADMIN_TOKEN` gate → `issueKey` →
  `{ ok: true, id, key, label }` (`key` = plaintext, shown once) | `{ ok: false, rejected }`.
- `@post("/keys/revoke")` body `{ token, id }` → revoke → `{ ok, revoked }`.
- `@get("/keys")` is NOT public; gate via the same admin token in the query or reuse a small
  admin guard. **Decision:** `@post("/keys/list")` body `{ token }` → `{ ok, keys }` (POST so the
  token isn't a URL/query param that leaks into logs). Returns metadata only, never hashes.

### 4. Identity middleware (`src/apiKeyIdentity.ts`)

Express middleware (duck-typed req/res like `originGuard`), mounted ahead of the limiters and
scoped to `/api/aggregator`:

- Read `x-api-key` (also accept `?apiKey` to match the framework strategy). Absent →
  `req.gemTier = "anonymous"`; `next()`.
- Present → `verifyKey(db, key)`: hit → `req.gemTier = "keyed"`, `req.gemKeyId = id`; miss →
  **401** `{ error: "invalid api key" }` (do not fall through to anonymous).
- Carries the `db` handle via closure (factory `makeApiKeyIdentity(db)`), since middleware
  runs outside controller DI.

### 5. Rate limiting (`@agentback/extension-rate-limit`, wired in `src/index.ts`)

Three `installRateLimit` mounts, all `path: "/api/aggregator"`, `durationSecs: 60`, headers on:

- **anonymous reads:** `points: ANON_POINTS` (60), `keyGenerator: req => req.ip ?? "anon"`,
  `skip: req => isAdminPath(req) || isIngestPath(req) || req.gemTier === "keyed"`.
- **keyed reads:** `points: KEYED_POINTS` (600), `keyGenerator: req => req.gemKeyId ?? "anon"`,
  `skip: req => isAdminPath(req) || isIngestPath(req) || req.gemTier !== "keyed"`.
- **ingest:** `points: INGEST_POINTS` (120), `keyGenerator: req => req.ip ?? "anon"`,
  `skip: req => !isIngestPath(req)` — applies ONLY to `/api/aggregator/ingest`, keeping
  publish and read budgets fully independent.

`ANON_POINTS`/`KEYED_POINTS`/`INGEST_POINTS` are module constants (env override is a later
nicety). In-memory store now; the Redis `store` option is the multi-instance deploy path
(deferred). Mount order in `createApp`: existing `originGuard` → `apiKeyIdentity` → the three
limiters → controllers.

### 6. Local pglite mode (`src/index.ts`)

Refactor the aggregator-registration block so the DB handle comes from a helper:

- `DATABASE_URL` set → Postgres `Pool` + drizzle (existing path).
- unset → `@electric-sql/pglite` + the pglite drizzle adapter (the same wiring the aggregator
  tests use), `ensureSchema`, register. Log `aggregator: local pglite (set DATABASE_URL for Postgres)`.

Either way: `ensureSchema` (now also creating `api_keys`), register drizzle, mount
`apiKeyIdentity` + the two limiters, `restController(AggregatorController)`. So gating is
always present when the aggregator is.

## Error handling

- Bad key → 401 (identity middleware). Over limit → 429 + `Retry-After` (extension).
- Rate-limit store failure → **fail open** (extension default) — a limiter outage never 500s a read.
- Admin endpoints: missing/!match token → `{ ok: false, rejected: "unauthorized" }` (or
  `"keys-disabled"` when `AGGREGATOR_ADMIN_TOKEN` is unset). Never log the request body.
- pglite local mode is for dev/validation; production sets `DATABASE_URL`.

## Testing

Drizzle-pglite, in-process (reuse the existing `makeTestDb`):

- **apiKeys:** `generateKey` shape (`ag_` prefix, distinct each call, hash = sha256 of
  plaintext); `issueKey` returns plaintext once and stores only the hash; `verifyKey` hit /
  miss / revoked-is-miss; `revokeKey` flips `revoked_at`; `listKeys` never exposes hashes.
- **issuance endpoints:** admin-token gate (unset → disabled, wrong → unauthorized, right →
  issues); revoke + list round-trip; body never logged (assert via a spy if feasible).
- **identity middleware:** absent key → anonymous + next; valid → keyed + keyId; invalid →
  401 and no next.
- **three-bucket limiter (integration):** anonymous caller exceeds `ANON_POINTS` → 429 with
  `RateLimit-*` headers; a valid key raises the ceiling to `KEYED_POINTS`; the `/ingest`
  endpoint uses its own `INGEST_POINTS` budget so publish bursts and reads never share a
  bucket. (Small `points` in the test config to keep it fast.)

Live local validation (manual, after the suite): run the server with no `DATABASE_URL`
(pglite), `POST /api/aggregator/keys` with the admin token to mint a key, curl `popularity`
past 60/min to see a 429, then repeat with `x-api-key` and confirm 200s + `RateLimit-*`.

## Out of scope (later)

- Billing / metering / plans; per-key tiers (one keyed limit now).
- Self-serve key issuance via OAuth account-binding (the deferred identity slice).
- Redis-backed shared rate-limit store (the multi-instance deploy path) and the cloud deploy itself.
- Env-configurable limits; a `agentgem keys` CLI wrapper.
- New richer/bulk keyed-only endpoints (this slice elevates limits on the existing reads only).
