# Adoption Sybil / Quarantine Hardening — Design

**Date:** 2026-06-30
**Status:** Approved-pending-review — hardens the #D adoption telemetry against sybil inflation, so the Stone rating (and especially 💎 Diamond) rests on a signal that's costly to fake. Extends the EXISTING attestation trust/quarantine machinery to `gem_adoptions` (consistent, not parallel).

## Goal

Make fake installers not count, via **defense-in-depth** (user-chosen):
1. **Quarantine machinery for adoptions** — add `quarantined`/`trustScore` columns, an adoption-specific detection sweep (bursts of *fresh, unbound* producers on one gem, bound/aged producers exempt), and make the `gemAdoption` aggregate exclude quarantined rows. The headline install count is k-anon + quarantine-swept.
2. **A real verified-install count** — replace the spoofable `selfReportedAccounts` with a true `account_bindings` join (the #D review flagged this).
3. **💎 Diamond requires VERIFIED (bound) installers** — the apex can't be faked without N real OAuth-verified GitHub accounts. The rating's *count* stays on raw (swept) installs; only Diamond gates on verified.

## Decisions (settled with the user)

- **Defense-in-depth** (all three above), NOT quarantine-only and NOT verified-only. Rationale: quarantine catches obvious sybil bursts cheaply and keeps the headline count inclusive; verified-gating makes the *apex* un-gameable without real identities; together they cover both the common case and the determined attacker.
- **Account binding is the sybil-resistant anchor** — OAuth-verified, one per pubkey, already the exemption in the attestation sweep. Diamond leans entirely on it.
- **Soft exclusion, not hard rejection** — adoptions are still ingested from unbound producers (backward-compatible, k-anon still applies); they're just excluded when quarantined and don't count toward Diamond. Consistent with the attestation design (quarantine is soft).

## Context (ground-truth verified)

- **Trust columns to mirror** (`packages/aggregator/src/schema.ts`): `attestations` has `trustScore real notNull default 1` + `quarantined boolean notNull default false`. `gem_adoptions` (schema.ts:~103, PK `(gem_key, producer_pubkey)`) has NEITHER. `producers.attestCount` is the freshness signal (low = throwaway). `account_bindings` (`pubkey → producers.pubkey`, provider, account_id, account_login) is the verified-identity table; `recordBinding` (binding.ts) creates it via OAuth. **Adding columns doesn't change the table enumeration** (`schema.test.ts` checks table *names*, not columns) — no enumeration break.
- **The attestation sweep** (`packages/aggregator/src/detection.ts:44` `sweepQuarantine`): a shape-fingerprint cluster heuristic — flags a shape shared by `>= minProducers(10)` distinct producers, `>= minShape(4)` ingredients, `>= freshFraction(0.8)` fresh (`attest_count <= freshMax(2)`); quarantines the attestations in bad clusters whose producer is `not exists` in `account_bindings` (**bound producers exempt**); idempotent (excludes already-quarantined); dry-run counts, real mode `update ... set quarantined=true, trust_score=0`. Env-overridable thresholds via `num(process.env.DETECT_*, default)`.
- **The sweep endpoint** (`src/aggregator.controller.ts:143` `POST /api/aggregator/sweep`): admin-token (`AGGREGATOR_ADMIN_TOKEN`, constant-time), body `{ token, apply? }`, dry-run by default, returns `{ ok, report: SweepReport }`. `SweepReport = { clustersFound, attestationsQuarantined, producersFlagged, dryRun }`.
- **Aggregates exclude quarantined + real verified join** (aggregates.ts): every attestation aggregate has `join attestations a on ... and not a.quarantined` + `left join account_bindings b on b.pubkey = a.producer_pubkey` → `count(distinct b.provider||':'||b.account_id) as verifiedProducers`. **`gemAdoption` (aggregates.ts:128) has NEITHER** — queries `gem_adoptions` raw, `count(distinct account_login) as selfReportedAccounts` (spoofable).
- **The marketplace consumers** (post-Diamond): `api.gemAdoption(keys) → Record<gemKey, installs>` (api.ts); `stoneRating(floor, stars, installs)` + `isDiamond(grade, stars, installs)` (gems/rating.ts); `StoneRating({cut, grade, stars, installs})` threads both. `Gems.tsx`/`Gem.tsx` fetch adoption once and pass `installs`.

## The sybil vector (what we're defeating)

N cheap ed25519 keypairs (`loadOrCreateIdentity`) → N distinct `producer_pubkey`, each posts one adoption for the same gem → `count(distinct producer_pubkey) = N` fake installs → inflates the rating and (today) could fake Diamond. Account binding is the only costly identity; everything else is free.

## Components (files)

### 1. Schema + aggregate (Task 1)
- **`packages/aggregator/src/schema.ts`** — add to `gemAdoptions`: `trustScore: real("trust_score").notNull().default(1)`, `quarantined: boolean("quarantined").notNull().default(false)`. Add the matching columns to the `create table if not exists gem_adoptions (...)` DDL line in `ensureSchema` (append `, trust_score real not null default 1, quarantined boolean not null default false` before the `primary key`). (`real`/`boolean` are already imported.)
- **`packages/aggregator/src/aggregates.ts` `gemAdoption`** — (a) add `where not quarantined` (AND-ed with the existing keys filter); (b) replace `count(distinct account_login) as selfReportedAccounts` with a REAL verified join: `left join account_bindings b on b.pubkey = g.producer_pubkey` → `count(distinct b.provider || ':' || b.account_id)::int as "verifiedInstalls"`; the k-anon `having count(distinct producer_pubkey) >= ${k}` now counts only non-quarantined. Return `{ gemKey, installs, verifiedInstalls }`.
- **`src/aggregator.controller.ts`** — `GemAdoptionResult` items become `{ gemKey, installs, verifiedInstalls }` (rename the field in the Zod schema).

### 2. Adoption sybil detection + sweep (Task 2)
- **`packages/aggregator/src/detection.ts`** — add `sweepAdoptionQuarantine(db, opts): Promise<{ gemsFlagged: number; adoptionsQuarantined: number; producersFlagged: number; dryRun: boolean }>`. The cluster is **per gem_key** (adoptions have no ingredients):
  - `clusters`: per `gem_key` over non-quarantined adoptions, `count(distinct producer_pubkey) as producers` and `fresh_frac` = fraction of adopting producers that are BOTH fresh (`attest_count <= freshMax`) AND unbound (`not exists account_bindings`).
  - `bad`: `gem_key` where `producers >= minAdoptProducers(default 10, env DETECT_ADOPT_MIN_PRODUCERS)` AND `fresh_frac >= freshFraction(0.8)`.
  - `targets`: adoptions on a bad gem_key whose producer is fresh-AND-unbound and not already quarantined (**bound and aged producers exempt**).
  - real mode: `update gem_adoptions set quarantined=true, trust_score=0 where (gem_key,producer_pubkey) in (select ... from targets)`; dry-run counts. Idempotent (excludes already-quarantined from the cluster computation). Reuse the `num(process.env.DETECT_*, default)` + `freshMax`/`freshFraction` constants (share the attestation defaults).
- **`src/aggregator.controller.ts` `POST /sweep`** — after `sweepQuarantine`, also run `sweepAdoptionQuarantine(this.db, { dryRun })` and merge into the report. Extend `SweepReport` with `adoptionsQuarantined: number` (and optionally `gemsFlagged`). Same admin gate, same dry-run default.

### 3. Marketplace — verified-gated Diamond (Task 3)
- **`packages/marketplace/src/api.ts`** — `gemAdoption(keys)` returns `Record<string, { installs: number; verifiedInstalls: number }>` (parse both from `items`); best-effort `.catch(() => ({}))`.
- **`packages/marketplace/src/gems/rating.ts`** — `isDiamond(grade, stars, verifiedInstalls = 0)` now keys the adoption axis on VERIFIED installs: `grade === 3 && starCurve(stars) === 5 && adoptionCurve(verifiedInstalls) === 5`. `stoneRating` is UNCHANGED (still `adoptionCurve(installs)` on raw swept installs — the count stays inclusive).
- **`packages/marketplace/src/StoneRating.tsx`** — add a `verifiedInstalls?: number` prop; `stoneRating(grade, stars, installs ?? 0)` (raw) for the count, `isDiamond(grade, stars, verifiedInstalls ?? 0)` for the apex.
- **`packages/marketplace/src/pages/Gems.tsx` / `Gem.tsx`** — the adoption map now yields `{installs, verifiedInstalls}` per gem; pass both `installs={a?.installs ?? 0}` and `verifiedInstalls={a?.verifiedInstalls ?? 0}` into `<StoneRating>`.

## Testing

- **Aggregate** (`gemAdoption.test.ts`, extend): a quarantined adoption is EXCLUDED from `installs` and from the k-anon count; `verifiedInstalls` counts distinct BOUND accounts (seed `recordBinding`/`account_bindings` for some producers) and is 0 for all-unbound; the field is renamed (`verifiedInstalls`, not `selfReportedAccounts`).
- **Detection** (`adoptionSweep.test.ts`, new, mirror the attestation `detection` test): seed a gem adopted by ≥10 fresh-unbound producers → `sweepAdoptionQuarantine` (apply) sets `quarantined=true` on them and the aggregate's `installs` drops to exclude them; a BOUND producer in the same cluster is NOT quarantined; an AGED producer (attest_count > freshMax) is NOT quarantined; a small/organic gem (<10 adopters) is untouched; dry-run counts without writing; second run is idempotent (0 new).
- **Sweep endpoint** (extend the controller/sweep test): `POST /sweep` (apply) returns a report including `adoptionsQuarantined`; admin-token still required.
- **Marketplace** (`rating.test.ts` + `StoneRating.test.tsx`, extend): `isDiamond` now requires ≥50 VERIFIED installs (`isDiamond(3, 21, /*verified*/ 50)` true; raw installs no longer suffice — a gem with 50 raw but 0 verified is NOT diamond); `stoneRating` still uses raw installs (unchanged); `StoneRating` renders Diamond only when `verifiedInstalls` qualifies.
- Gates: server `pnpm exec tsc -b` + full `pnpm test` (build console first); `pnpm --filter @agentgem/marketplace test|typecheck|build`.

## Out of scope (deferred / noted)

- **Automatic/cron sweep** — stays manual admin `POST /sweep` (same as attestations); a scheduled trigger is a separate ops task.
- **trustScore-weighted counts** — we use `quarantined` as a hard 0/1 exclusion (like the attestation aggregates); graded trust weighting is future.
- **Requiring binding at ingest (hard gate)** — kept soft (ingest all, exclude when quarantined / gate Diamond on verified) for backward-compat and k-anon consistency.
- **Rating (non-Diamond) on verified installs** — deliberately NOT done; the headline count stays inclusive (raw, swept) per the user's choice.

## Risks

- **Detection false positives** — a genuinely viral gem adopted by many *new* users (legitimately fresh + unbound) could look like a sybil cluster. Mitigations: the sweep is DRY-RUN by default + admin-gated (a human reviews before applying); bound users are always exempt (real adopters who signed in aren't swept); thresholds are env-tunable. Document that apply-mode needs judgment.
- **Verified adoption is near-zero today** — almost no installer is account-bound (adoption doesn't bind), so Diamond becomes effectively unreachable until a bind-on-install flow exists. Accepted: Diamond SHOULD be that hard; the honest ceiling. (A bind-on-install UX is the natural follow-up that makes verified adoption accrue.)
- **k-anon interaction** — excluding quarantined rows can drop a gem below k=5 → it simply disappears from results (correct, fail-closed).
- **Hot files** — `schema.ts`, `aggregates.ts`, `detection.ts`, `aggregator.controller.ts`, marketplace `rating.ts`/`StoneRating.tsx` are concurrently active; additive diffs, branch off latest `origin/main` (ca491f1), integrate promptly.
