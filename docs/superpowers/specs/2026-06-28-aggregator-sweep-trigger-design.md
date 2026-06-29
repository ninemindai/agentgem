# Aggregator Sweep Trigger (#45) — Design

**Goal:** Make the anti-sybil quarantine sweep actually run in production. `sweepQuarantine`
(#18) is fully built but is referenced ONLY by its own test — nothing calls it, so quarantine
never runs. Wire it behind a token-guarded endpoint that is **dry-run by default** and **never
quarantines GitHub-verified producers**, so it's safe to enable.

**Status:** Design approved via brainstorming (trigger = guarded endpoint + scheduler; scope =
trigger + dry-run + verified-exempt; auth = `AGGREGATOR_ADMIN_TOKEN`). Next: implementation plan.

## Context

`sweepQuarantine(db, opts)` (`src/aggregator/detection.ts`) finds coordinated sybil clusters
(a shape shared by ≥`minProducers` distinct producers, ≥`minShape` skill/mcp ingredients,
≥`freshFraction` of producers "fresh") and sets `quarantined=true` + `trust_score=0` on the
matching attestations (which every aggregate already filters out). It's idempotent and already
conservative — but **no production code path invokes it**. The aggregator HTTP surface is the
decorator controller `AggregatorController` (`@api({ basePath: "/api/aggregator" })`); writes
(`/ingest`, `/bind`) are guarded (not in `originGuard`'s `PUBLIC_READ_PATHS`).

## Changes

### 1. `sweepQuarantine` — dry-run + verified exemption (`src/aggregator/detection.ts`)

- **`SweepOpts.dryRun?: boolean`** (default false). When true, the query computes the offending
  clusters and counts what *would* be quarantined, but performs **no `UPDATE`** — the `upd` CTE
  becomes a `targets` SELECT and the counts read from it.
- **Verified-producer exemption** — the quarantine target set excludes any attestation whose
  producer has an `account_bindings` row:
  `and not exists (select 1 from account_bindings ab where ab.pubkey = a.producer_pubkey)`.
  A GitHub-anchored producer (the #28 anti-sybil anchor) is never quarantined, even inside a
  flagged shape. (Cluster *detection* is unchanged; only the target/update set is filtered.)
- **`SweepReport.dryRun: boolean`** added so the caller knows which mode ran. Existing fields
  (`clustersFound`, `attestationsQuarantined`, `producersFlagged`) keep their meaning — in
  dry-run, the latter two are the *would-be* counts.

The query keeps its single-CTE shape: `shapes → clusters → bad → (dryRun ? targets-select :
update) → counts`. Both branches apply the verified-exemption to the target set.

### 2. `POST /api/aggregator/sweep` — token-guarded trigger (`src/aggregator.controller.ts`)

- **Body:** `{ apply?: boolean; token: string }`. `apply` defaults false ⇒ dry-run.
- **Auth:** the token is validated against `process.env.AGGREGATOR_ADMIN_TOKEN` with a
  **timing-safe** compare (`crypto.timingSafeEqual`, length-guarded). The token rides in the body
  (controllers reliably receive the body; the framework's header access is unspecified) — same
  shape as `/ingest`/`/bind`.
  - `AGGREGATOR_ADMIN_TOKEN` unset ⇒ reject `{ ok: false, rejected: "sweep-disabled" }` (the
    destructive endpoint is never open when no secret is configured).
  - token missing/mismatch ⇒ reject `{ ok: false, rejected: "unauthorized" }`.
  - else ⇒ `sweepQuarantine(db, { dryRun: !apply })` ⇒ `{ ok: true, report }`.
- **Response:** `z.union([{ ok: true, report: SweepReportSchema }, { ok: false, rejected: string }])`,
  mirroring `IngestResult`/`BindResult`. `SweepReportSchema` = `{ clustersFound, attestationsQuarantined,
  producersFlagged, dryRun }` (all numbers + the bool).
- **Guard:** a `@post` route is automatically outside `PUBLIC_READ_PATHS` (only SAFE GETs are
  public), so `originGuard` blocks cross-site browsers; the token is the real authenticator. The
  controller must **not log the request body** (the token is a secret).

An external scheduler (cloud cron / Vercel Cron / k8s CronJob / manual curl) POSTs
`{ "token": "…", "apply": true }` on whatever cadence the operator chooses. Recommended operating
procedure: run dry-run first, inspect the report, then enable `apply`.

## Security / safety

- Destructive action (`apply=true`) requires the secret; never reachable when `AGGREGATOR_ADMIN_TOKEN`
  is unset. Timing-safe compare avoids token-guessing via response timing.
- Verified (GitHub-bound) producers are exempt — the sweep can't anchor a false positive on a
  legitimately-attested account.
- Dry-run default — the operator inspects what *would* be quarantined before committing.
- Verified-exemption uses the same `account_bindings` table the `verifiedProducers` overlay reads;
  no new columns, no migration.

## Testing

- **`detection.test.ts`** (extends the existing suite; uses `makeTestDb` + `projectAttestation`):
  - **dry-run**: a cluster that WOULD quarantine reports `attestationsQuarantined > 0` with
    `dryRun: true`, and a follow-up real (non-dry-run) run still quarantines the same count
    (proving dry-run changed nothing).
  - **verified-exemption**: seed a flagged cluster, add an `account_bindings` row for one of its
    producers, run apply — that producer's attestations are NOT quarantined while the unbound
    ones are.
- **Controller test** (`src/aggregator/__tests__/` or the controller suite): token unset ⇒
  `sweep-disabled`; wrong token ⇒ `unauthorized`; correct token + `apply:false` ⇒ `ok` with a
  dry-run report (DB unchanged); correct token + `apply:true` ⇒ quarantines.

## Out of scope (the rest of #45 — follow-up)

- Review/recovery state (un-quarantine a false positive) and an account-age allowlist — deferred.
- A built-in scheduler (the trigger is endpoint-only; scheduling is the deploy's concern).
- Surfacing quarantine stats in the Insights UI.
