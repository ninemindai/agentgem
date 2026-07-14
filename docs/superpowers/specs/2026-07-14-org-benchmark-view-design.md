# Org-Scoped Benchmark Admin View

**Date:** 2026-07-14
**Branch:** `feat/org-benchmark-view`
**Status:** Design — approved, pending spec review

## Problem

The public benchmark (per-model outcomes, gem effectiveness) is k-anonymised and
network-wide. An org **admin** has no way to see how *their own org* is doing —
which of their models/gems perform, and who's contributing. The benchmark data is
already org-attributable (every attestation's producer links to a bound account),
but nothing surfaces it per-org.

## Goal

An org-internal, read-only analytics view for org **admins**: the org-scoped
counterpart to the public benchmark, de-anonymized within the org. A new
**Benchmark** tab on the marketplace `/orgs/:scope` hub.

## Non-goals

- **Compare-to-global** (org vs network) — deferred.
- **Admin controls / governance** (enable-contribution org-wide, retention knobs) —
  that was the rejected "control surface" purpose; this spec is analytics only.
- **Console surface** — web-only (org membership + admin authz are web concerns).
- **k-anonymity floor** internally — the admin owns this data.

## Decisions (from brainstorming)

| Question | Decision |
|---|---|
| Purpose | Org-internal **analytics** (read-only). |
| Placement | New **Benchmark** tab on the marketplace `/orgs/:scope` hub (web). |
| Panels | (1) org model benchmark, (2) org gem effectiveness, (3) per-member breakdown. |
| Access | **Org admins only** (`role === 'admin'`); non-admins 403. |
| k-anon | None internally; per-member visible to admins. |

## Architecture

### Org-membership filter (the core seam)

Every benchmark aggregate already `LEFT JOIN account_bindings b ON b.pubkey =
a.producer_pubkey`. To org-scope it, filter to attestations whose producer's bound
`account_login` belongs to the org's members, mirroring **`resolveOrgAccess`**'s
authority order:

- If the org has an active App installation → membership is `orgMembers` (`orgScope`,
  `ghLogin`), App-synced from GitHub.
- Else → the sign-in-captured `account_scopes` (bridged to `account_bindings` via the
  provider account).

Consequence: only **bound** producers who are org members appear. Unbound/anonymous
attestations can't be attributed to a member and are excluded (correct).

*Implementation note:* the plan pins the exact join. The clean path is
`account_bindings.account_login = orgMembers.ghLogin` (both GitHub logins) for
App-installed orgs; a helper already resolves membership authority for the usage
dashboard (`resolveOrgAccess`) — reuse its decision, and expose a companion query
helper (`orgMemberLogins(db, scope)` or an inline join) so the three aggregates share
one membership predicate.

### Aggregator (`packages/aggregator`)

Three org-scoped query functions (new; e.g. `packages/aggregator/src/orgBenchmark.ts`),
each the org-filtered, **no-k-floor** analogue of an existing aggregate:

- `orgModelBenchmark(db, scope)` → `{ model, mostly, partially, notAchieved, successRate }[]`
  — per-model outcome counts over the org's members' attestations.
- `orgEffectiveness(db, scope)` → `{ gemName, mostly, partially, notAchieved, judged,
  organic, confidence, score }[]` — per-gem confidence-weighted score, org members only.
- `orgMemberBreakdown(db, scope)` → `{ login, attestations, gems, mostly, partially,
  notAchieved }[]` — grouped by producer→member, de-anonymized.

Reuse the existing `modelBenchmark`/`effectiveness` SQL shapes; the only diffs are the
membership `WHERE` and dropping the `HAVING count(distinct producer) >= k` floor.

### Route (raw-express, `/api/orgs/*` family)

`GET /api/orgs/:scope/benchmark` (new handler, `src/orgs/benchmark.ts` or alongside the
usage handler). Mirrors `orgUsageHandler`'s gate but requires **admin**:

1. `resolveSession(auth, headers)` → `{ accountId, login }` (401 if unauthenticated).
2. `resolveOrgAccess(...)` → membership + role. 403 `{ error, reason }` when
   `status !== "ok"` (not a member / `reason: "stale"` → re-auth), same shapes as
   `memberGate`.
3. Require `role === "admin"` → else 403 `{ error: "admins only", reason: "not-admin" }`.
4. Run the three aggregates for `scope`; return `{ scope, modelBenchmark, effectiveness,
   members }`.

Cookie auth + credentialed CORS + originGuard-exempt — `/api/orgs/` is already in the
exempt prefix (`originGuard.ts`) and the publicCors family.

### Marketplace UI (`packages/marketplace`)

A new **Benchmark** tab on the `/orgs/:scope` hub (beside Usage + Catalog). Fetches
`/api/orgs/:scope/benchmark` and renders the three panels, reusing the usage
dashboard's table/section components and the marketplace design tokens (every new
`ex-*` class gets a matching `styles.css` rule). Admin-gated: on a `not-admin` 403 the
tab shows a friendly "admins only" state (and the tab is hidden for non-admins where the
hub already knows the viewer's role).

## Data flow

```
admin → /orgs/:scope (Benchmark tab)
  → GET /api/orgs/:scope/benchmark
  → resolveSession → resolveOrgAccess → require role=admin (else 403)
  → orgModelBenchmark(scope) + orgEffectiveness(scope) + orgMemberBreakdown(scope)
       (membership filter, NO k-floor)
  → { scope, modelBenchmark, effectiveness, members }
  → render: model benchmark · gem effectiveness · per-member table
```

## Authorization & privacy

- **Admin-only.** Per-member benchmark performance is sensitive (ranks individuals'
  work); non-admin members get 403 and never receive the per-member data.
- Only **bound** producers who are members appear; anonymous/unbound data is excluded.
- Server-side scope filter — no cross-org leakage; the response only ever contains one
  scope's data.

## Error handling

| Condition | Response |
|---|---|
| Unauthenticated | 401 |
| Not a member | 403 `{ reason: "not-member" }` |
| Stale membership | 403 `{ reason: "stale" }` → UI prompts re-auth (same as usage) |
| Member but not admin | 403 `{ reason: "not-admin" }` → UI "admins only" |
| Admin, empty org (no bound contributing members) | 200 with empty panels + "no contributing members yet" state |

## Testing

- **Aggregator:** the org filter includes only the scope's members' attestations,
  excludes other orgs and unbound producers, and applies **no** k-floor. Per-member
  breakdown groups correctly. (pglite + `makeTestDb`, seed producers/bindings/scopes.)
- **Route:** 401 unauthenticated; 403 for not-member / stale / not-admin (each with its
  `reason`); 200 admin returns the three cuts for the scope only.
- **UI:** renders the three panels; admin-gate forbidden + empty states (jsdom); a
  real-browser check on the org hub.

## Files (anticipated)

- `packages/aggregator/src/orgBenchmark.ts` — the three org-scoped aggregates + shared
  membership predicate; exported from the package barrel.
- `src/orgs/benchmark.ts` (or extend `src/usage/install.ts`) — the admin-gated route.
- Route registration in the raw-express `/api/orgs/*` mount.
- `packages/marketplace/src/...` — the Benchmark tab component + `styles.css` rules;
  hub tab registration.
- Tests alongside each.

## Scope boundaries (YAGNI)

Analytics only; three panels; admin-only; web-only; single plan. Compare-to-global,
governance controls, and any console surface are explicitly out.
