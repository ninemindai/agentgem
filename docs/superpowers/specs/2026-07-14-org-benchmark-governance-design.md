# Org Benchmark Governance — Settings + Enforcement (Spec A)

**Date:** 2026-07-14
**Branch:** `feat/org-benchmark-governance`
**Status:** Design — approved, pending spec review

## Problem

An org admin can *see* the org's benchmark (shipped: #411/#412) but has no control
over the org's **participation** in the network benchmark — no way to opt the org out
of contributing, or to hide the view. The producer contribution toggle is purely
**local** (`~/.agentgem`), so the org has no lever today.

## Goal

Admin-only governance over the org's benchmark participation: **forbid** contribution
(server-enforced — the org's members' attestations stop entering the benchmark) and
**show/hide** the org Benchmark view. Extends the existing admin-gated `org_settings`
surface.

## Non-goals

- **Retention** — dropped. Benchmark data is per-producer/shared (feeds the public
  benchmark + every org the producer belongs to), not org-scoped like usage, so a
  time-based org prune would delete shared data. Retention stays a usage-only concept.
- **Require contribution** — not server-enforceable (can't force a client to send
  data); out.
- **Purge / export** — a separate one-shot data-action surface = **Spec B**.

## Decisions (from brainstorming)

| Question | Decision |
|---|---|
| Controls | **forbid contribution** + **view on/off**. |
| Retention | Dropped (shared per-producer data). |
| Forbid semantics | **Most-restrictive-org-wins**: a producer in *any* forbidding org can't contribute at all (privacy-safe default). |
| View on/off | Kept (cheap "we opt out entirely" signal), though low-impact since the view is already admin-only. |
| Writes | **Admin-only** (mirrors `putOrgSettings`). |

## Architecture

### Storage — extend `org_settings`

`org_settings` already has `scope` (PK), `retentionDays`, `dashboardEnabled`,
`updatedBy`, `updatedAt`. Add two columns (via `ensureSchema`'s `alter table … add
column if not exists`, per the column-drift rule):

- `contribute_allowed boolean not null default true` — `false` ⇒ the org opts its
  members out of contributing.
- `benchmark_view_enabled boolean not null default true` — `false` ⇒ hide the org
  Benchmark tab.

`getOrgSettings`/`putOrgSettings` (`orgSettings.ts`) extend to read/write the two new
fields (defaults preserved when never configured).

### Route — admin settings in the benchmark family

- `POST /api/orgs/:scope/benchmark/settings` (admin-gated, mirrors the
  `/api/usage/settings` POST gate exactly) — body `{ contributeAllowed,
  benchmarkViewEnabled }` → persists via `putOrgSettings` → returns the new settings.
  Registered in `installOrgBenchmark` (`src/orgs/benchmark.ts`) beside the GET.
- `GET /api/orgs/:scope/benchmark` gains `settings: { contributeAllowed,
  benchmarkViewEnabled }` in its response. When `benchmarkViewEnabled === false`, the
  GET returns `{ scope, disabled: true, settings }` instead of the three panels (the
  admin still sees the governance toggles to re-enable).

### Enforcement

- **Forbid at ingest** — `ingestAttestation` (`packages/aggregator/src/ingest.ts`):
  before `projectAttestation`, resolve the producer's bound `account_login` and check
  whether it belongs to **any** `org_members` row whose org has `contribute_allowed =
  false`. If so → `{ accepted: false, rejected: "org-forbidden" }` (a new
  `VerifyResult`/`IngestResult` reason). Unbound producers have no org membership →
  unaffected. One extra scoped query per ingest (a single `EXISTS` join). A helper
  `producerForbidden(db, pubkey): Promise<boolean>` keeps the check testable and out of
  the projection.
- **View on/off** — the benchmark GET + the marketplace tab respect
  `benchmark_view_enabled` (mirrors `dashboardEnabled`): a "disabled by an admin" state.

### UI — admin Governance section on the org Benchmark tab

`packages/marketplace/src/pages/Benchmark.tsx` gains an admin-only **Governance**
section at the top: two toggles — "Contribute to the public benchmark"
(`contributeAllowed`) and "Show this benchmark view" (`benchmarkViewEnabled`) — that
POST to `/api/orgs/:scope/benchmark/settings` (add `setOrgBenchmarkSettings` to
`api.ts`). Reuses the usage-settings toggle pattern + tokens; when the view is
disabled, the panels are replaced by an admin notice with the re-enable toggle. Every
new `ex-*` class gets a `styles.css` rule.

## Data flow

```
admin toggles "Contribute" off
  → POST /api/orgs/:scope/benchmark/settings { contributeAllowed:false }  (admin gate)
  → putOrgSettings persists contribute_allowed=false
  → thereafter ingestAttestation: producer's account_login ∈ a forbidding org
       → { accepted:false, rejected:"org-forbidden" }
  → the org's members' NEW attestations no longer enter the benchmark
```

## Authorization & privacy

- Writes admin-only (403 non-admin), same gate as the benchmark GET.
- Forbid is enforced **server-side** at ingest — no client cooperation needed; a
  member can't override their org's opt-out.
- Most-restrictive-org-wins: documented so admins understand a member in another org
  is also blocked while any of their orgs forbids.

## Error handling

| Condition | Response |
|---|---|
| Non-admin write | 403 (`reason: "not-admin"`) |
| Forbidden ingest | `{ accepted:false, rejected:"org-forbidden" }` (producer's post surfaces/skips it) |
| View disabled | GET → `{ disabled:true, settings }`; tab shows the admin-disabled state + re-enable toggle |

## Testing

- **Aggregator:** `getOrgSettings`/`putOrgSettings` round-trip the two new fields
  (defaults preserved). `producerForbidden` true when the producer's login is in a
  `contribute_allowed=false` org, false when in none/only-allowing orgs, false when
  unbound. `ingestAttestation` returns `rejected:"org-forbidden"` for a forbidden
  producer and does NOT project; still accepts an allowed producer.
- **Route:** `POST /benchmark/settings` 403 non-admin, 200 admin persists;
  `GET /benchmark` includes `settings`, and returns `disabled` when view off.
- **UI:** governance toggles render admin-only, POST on change, and the disabled state
  renders; jsdom + a real-browser check (mirror the Spec-#412 stubbed-render approach).

## Files (anticipated)

- `packages/aggregator/src/schema.ts` — two `org_settings` columns + `ensureSchema` alters.
- `packages/aggregator/src/orgSettings.ts` — extend `OrgSettings`/`getOrgSettings`/`putOrgSettings`.
- `packages/aggregator/src/ingest.ts` — `producerForbidden` + the `org-forbidden` reject.
- `src/orgs/benchmark.ts` — `POST /benchmark/settings`; `GET` returns `settings`/`disabled`.
- `packages/marketplace/src/pages/Benchmark.tsx`, `api.ts`, `styles.css` — Governance section.
- Tests alongside each.

## Scope boundaries (YAGNI)

Two flags + ingest enforcement + one admin section. No retention, no require, no
purge/export (Spec B), no non-benchmark governance. Backend-then-UI slice like #411/#412.
