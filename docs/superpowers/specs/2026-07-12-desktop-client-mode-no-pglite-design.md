# Desktop client mode — no local PGlite, DB access via the hosted API

**Date:** 2026-07-12
**Status:** Design — pending review
**Author:** Raymond Feng (with Claude)

## Problem

The desktop console's **Benchmark** tab returns `ClientError: Internal Server Error`. Root
cause (traced end-to-end):

1. Every DB-backed `/api/aggregator/*` endpoint 500s in the packaged desktop app;
   non-DB endpoints (`/api/recall`, `/api/optimize`, `/api/inventory` — all `node:sqlite`) are fine.
2. The local aggregator runs on **embedded PGlite** (`resolveAggregatorDb()` → `new PGlite()`
   when `DATABASE_URL` is unset). The packaged app **does not ship PGlite's runtime assets**
   (`pglite.wasm` / `pglite.data` are absent from `Resources/core/`), so `new PGlite()` rejects
   at boot. `lazyPgliteClient` memoises the rejected promise (`ready ??= …`), wedging the
   aggregator DB for the whole process.

The deeper issue is architectural: **the desktop is a client, but it embeds a database.** Even
if the WASM assets were shipped, the local aggregator is empty — the benchmark is a *network*
feature (cross-producer, k-anonymised) with no local producers, so it would only ever render its
empty state. Meanwhile a database inside a distributed client is the wrong shape: it either sits
empty (PGlite) or, if pointed at shared Neon via `DATABASE_URL`, ships production DB credentials
to every installed copy and bypasses the API's k-anon / auth / rate-limit layer.

## Principle

**The desktop is a pure API client. It never embeds a database. All aggregator/DB access goes
through the hosted API.** Two deployment modes:

- **Client mode** (the shipped consumer desktop): no `DATABASE_URL`, a hosted aggregator
  configured (`AGENTGEM_AGGREGATOR_URL`, default `https://api.agentgem.ai`). Does **not** mount the
  local aggregator and does **not** load PGlite. Aggregator-backed features reach hosted through
  signed/anon HTTP clients that run in the core.
- **Server mode** (the public `api.agentgem.ai`, **and private enterprise deployments of
  `api.agentgem.ai`**): operator sets their own `DATABASE_URL` → mounts the full aggregator on their
  Postgres, exactly as today. A **private enterprise deployment** is a first-class target: an
  enterprise runs its *own* instance of the `api.agentgem.ai` server against its *own* database, so
  its attestations/outcomes/catalog stay entirely within its tenant and never mix with the public
  network. Same binary, same code, different `DATABASE_URL` and origin.

Because a private enterprise deployment exists, **client base URLs must be configurable** — the
desktop is not hard-wired to the public host. `AGENTGEM_AGGREGATOR_URL` (and the auth/web-origin
config) point a given install at *its* deployment: the public `https://api.agentgem.ai` by default,
or `https://api.<enterprise>.internal` for an enterprise fleet.

## Current state (what the desktop already does)

The console is already ~90% a pure client — only the Benchmark panel still reads the local DB:

- **Share** → `ShareProxyController` (`/api/share`) → `shareClient.postShare` → hosted.
- **Reviews** → `ReviewController` (`/api/review/*`) → `reviewClient` (`postReviewRequest`,
  `fetchReviewArchive`, …) → hosted, signed with the local identity; degrades to empty when the
  hosted aggregator is unreachable.
- **Publish / outcomes** → `sign_and_publish` → `ingestClient.postAttestation` → hosted.
- **Benchmark** → `benchmarksRoute` + `effectivenessRoute` → **local** `/api/aggregator/*` ← the
  only remaining local-DB dependency in the entire console (verified: those are the *only* two
  `/api/aggregator/*` paths the console calls).

So finishing the pattern means: add the one missing hosted client (benchmark), then stop mounting
the now-unused local aggregator in client mode.

## Design

### 1. `benchmarkClient` (new) — `src/gem/benchmarkClient.ts`

Mirror `shareClient.ts`: a `resolveBase()` (explicit endpoint → `AGENTGEM_AGGREGATOR_URL` →
`DEFAULT_AGGREGATOR_URL`) plus two anonymous GETs to the hosted aggregator:

- `GET {base}/api/aggregator/benchmarks`
- `GET {base}/api/aggregator/effectiveness?sort=score&minConfidence=0.3`

Server-side fetch (runs in the core), so:
- Passes hosted `originGuard` as a non-browser client (no `Origin`/`Sec-Fetch-*`) — works even
  though `/benchmarks` is not in `PUBLIC_READ_PATHS`; **no hosted/CORS change required.**
- Needs **no auth** — these are anonymous public reads (`apiKeyIdentity` admits the anonymous
  tier). No API key, no cookies.
- On unreachable hosted / disabled base (`AGENTGEM_AGGREGATOR_URL=""`): return empty arrays so the
  panel renders its existing empty state rather than an error (mirrors `reviewClient`'s
  "degrade to empty picker"). A 10s timeout, like `ingestClient`.

### 2. `BenchmarkProxyController` (new) — `src/benchmark.proxy.controller.ts`

Same shape as `ShareProxyController` (`@api({ basePath: "/api/benchmark" })`), so the browser
stays same-origin and the credential/base resolution lives server-side:

- `GET /` → `benchmarkClient.benchmarks()`
- `GET /effectiveness` → `benchmarkClient.effectiveness()`

Guarded by the existing `originGuard` (loopback CSRF), like every other console endpoint — **no
per-user auth** (the data is anonymous public data; there is nothing to authorize).

### 3. Console Benchmark panel — repoint

`benchmarksRoute` / `effectivenessRoute` change target from `/api/aggregator/*` to
`/api/benchmark` and `/api/benchmark/effectiveness`. No UI/logic change; the panel's existing
`error` and empty states already cover offline and no-data.

### 4. Two entrypoints — the aggregator is not just *unmounted* in the client, it is *absent*

The goal isn't a runtime `if`, it's that the shipped desktop bundle **contains no aggregator/auth/DB
code at all**. esbuild tree-shakes by entry reachability, so the mechanism is two thin entrypoints
over shared setup:

- **`src/appCommon.ts`** (extract, shared) — builds the `RestApplication` and mounts the
  **client-side surface** only: the console static assets, the `Gem`/`Rubric`/`Dream`/`Play`/
  `Sources` controllers, the already-client proxies (`ShareProxyController`, `ReviewController`),
  `GemTools`, MCP, chat routes, recall/optimize/inventory, `originGuard`, and the client cache hooks.
  Its transitive deps are light (no `@agentgem/aggregator`, no better-auth, no `pg`, no PGlite).
- **`src/serverAggregator.ts`** (extract, server-only) — one `mountAggregator(app, env)` that does
  everything the current unconditional block does: `resolveAggregatorDb` + `AggregatorController` +
  `ShareController` + `mountGating` + `installOg` + `makeAuth` (better-auth) + handoff/connect/
  handles/account/stars/reviews/catalog/gemShares/groups/usage/registryUploadPublish/
  githubWebhook/setup/orgsApi + `migrateAccounts`/`backfillUserHandles`. This module is the sole
  importer of `@agentgem/aggregator` and the heavy server deps.
- **`src/index.ts`** (server entry — public `api.agentgem.ai`, private enterprise deployments,
  Fly, dev-with-`DATABASE_URL`) = `appCommon` + `await mountAggregator(app, env)` + start. Behaviour
  is byte-for-byte what runs today; nothing about the server changes.
- **`src/client.ts`** (NEW desktop entry) = `appCommon` + `BenchmarkProxyController` + start. It
  never imports `serverAggregator`, so `@agentgem/aggregator` / better-auth / `pg` / PGlite are
  **unreachable from this entry and never enter the bundle.**

Type-only imports (`import type { AppDb } from "@agentgem/aggregator"`) in client files are erased by
esbuild, so they don't pull the package in. Aggregator **unit tests** are unaffected — they import
the aggregate functions / construct a PGlite `AppDb` directly, not via either boot entry.

### 5. Desktop build points at the client entry — `desktop/scripts/bundle-core.mjs`

Change the esbuild `entryPoints` from `dist/index.js` to **`dist/client.js`**. Because the aggregator
path is now unreachable from that entry, the bundle drops `@agentgem/aggregator`, better-auth, `pg`,
**and `@electric-sql/pglite`** with no `external` hack and no WASM assets to ship — the reported 500's
root cause is removed by construction, and the app shrinks. The Fly `Dockerfile` continues to run
`dist/index.js` (server entry). `desktop/src/core.ts` continues to spawn the same bundle output
(`core/index.mjs`), now built from `client.ts`.

### 6. Private enterprise deployment of `api.agentgem.ai` (server mode)

A **private enterprise deployment is a first-class server-mode target**, not just "self-host": an
enterprise runs its own instance of the `src/index.ts` server (the same image Fly runs) against its
own `DATABASE_URL`, so its attestations/outcomes/catalog live entirely in its tenant and never touch
the public network. Enterprise desktops are configured — via `AGENTGEM_AGGREGATOR_URL` (+ the
auth/web-origin config) — to point at that private API instead of `https://api.agentgem.ai`. The
consumer desktop is always the **client** entry and never receives a `DATABASE_URL`. Document the
deployment shape (env, `DATABASE_URL`, client `AGENTGEM_AGGREGATOR_URL`) in `docs/deploy/`.

## Testing

- `benchmarkClient`: unit tests with an injected `http` (like `ingestClient`/`postShare`): success
  passthrough; `AGENTGEM_AGGREGATOR_URL=""` → empty arrays (skipped); hosted 5xx → empty arrays;
  network error/timeout → empty arrays.
- `BenchmarkProxyController`: same-origin GET returns hosted payload; is `originGuard`-blocked
  cross-site.
- Entrypoints: **`client.ts`** boots, serves the console + `/api/benchmark`, and mounts no
  aggregator controller; **`index.ts`** (server) is behaviourally unchanged (full aggregator on
  `DATABASE_URL`). A regression check that the server entry still registers every aggregator route.
- Bundle: assert the built desktop `core/index.mjs` contains **no** `@agentgem/aggregator` /
  better-auth / PGlite symbols (grep the bundle in a build test) — the "absent, not just unmounted"
  guarantee.
- Manual: packaged desktop → Benchmark tab renders empty state (not 500) against the currently
  empty prod; and shows rows once prod has k-anon-eligible data.

## Implementation sequencing (de-risk the refactor)

1. Add `benchmarkClient` + `BenchmarkProxyController`; repoint the console panel. (Fixes the 500 on
   its own once mounted in the client surface.)
2. Extract `serverAggregator.ts` (`mountAggregator`) and `appCommon.ts` out of `index.ts` with **no
   behaviour change**; `index.ts` = common + `mountAggregator`. Verify the server entry is
   unchanged (full test suite + route registration check) before touching the desktop.
3. Add `client.ts`; point `bundle-core.mjs` at it; assert the bundle no longer contains aggregator/
   PGlite. Verify the packaged desktop boots and the Benchmark tab works.

## Out of scope (tracked separately)

- **Org-scoped benchmark (admin-detail).** A distinct feature on the **web** org dashboard
  (`app.agentgem.ai`, Team Pulse family): `GET /api/orgs/benchmark?scope=<org>`, session-authed +
  `requireMember`, k-anon relaxed (org owns its data), with a `byMember` breakdown gated on
  `role='admin'`. It reuses `resolveOrgAccess` / `account_scopes` and is consumed **directly** by
  the web dashboard (already session-authed + CORS-allowlisted) — no proxy. Its own spec.
- **Producer wiring.** The benchmark shows nothing until installs actually ingest outcomes:
  `AGENTGEM_INGEST_URL` is unset in the shipped app (publishing skips ingest), outcomes need a
  non-degraded judge, and a model/gem row needs ≥ k distinct producers. Prod verified empty
  (`producers = 0`) on 2026-07-12. This is the real gap to "benchmark shows data" and is separate
  from the client-mode read path. Its own spec.

## Non-goals / rejected alternatives

- **Ship the PGlite WASM assets.** Fixes the 500 but keeps a database inside a client that is empty
  by design; contradicts the pure-client principle.
- **Direct browser → hosted from the renderer.** Works for anonymous reads but couples desktop
  releases to prod CORS changes and, for any future authenticated read, would require allowlisting
  the Electron origin for credentialed access. The core-side client keeps the credential/base
  server-side and the browser same-origin.
- **`DATABASE_URL=<shared Neon>` in the desktop.** Ships prod DB credentials in a distributed
  client and bypasses k-anon/auth/rate-limiting. `DATABASE_URL` is for operators of a server
  (hosted or enterprise self-host), never the consumer client.
