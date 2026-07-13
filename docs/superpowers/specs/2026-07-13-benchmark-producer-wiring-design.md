# Benchmark Producer Wiring (Spec 1 of 2)

**Date:** 2026-07-13
**Branch:** `feat/benchmark-producer-wiring`
**Status:** Design — approved, pending spec review

## Problem

The Benchmark tab renders but is empty in production: `producers = 0`. There are
two independent causes, and fixing either alone leaves it empty:

1. **The ingest base has no default.** Every hosted client resolves its base URL as
   `explicit → AGENTGEM_AGGREGATOR_URL → https://api.agentgem.ai` (share, gem-publish,
   review, and the benchmark *read* client all do this). `ingestClient.postAttestation`
   is the lone exception: it reads a *different* env var (`AGENTGEM_INGEST_URL`) with
   **no fallback**, so in the shipped app it returns `{ skipped: true }`.
2. **The human flow never produces an attestation.** The console's publish surfaces
   (`/api/publish-setup`, `/api/playbook/publish` → `publishGem`) never call
   `buildAttestation`, the outcome judge, or `postAttestation`. The *only* code path
   that builds/signs/ingests an attestation is the distill MCP server's
   `sign_and_publish` tool (`src/distill/mcpServer.ts`), which is agent-invoked, not
   what the Publish button triggers.

The hard, expensive parts already exist and are tested: the outcome judge
(`judgeSessions` → per-model `mostly/partially/not` histogram), signature +
anti-inflation verification (`verifyAttestation`), and the k-anon rollups
(`packages/aggregator/src/aggregates.ts`). **This spec is wiring + a trigger, plus
one contained aggregator change — not building those from scratch.**

## Goal

Make the hosted benchmark receive real, k-anonymised outcome data through a
**consent-gated producer contribution** that runs in the local core, scoped to the
user's published gems, ingesting anonymous ed25519-signed attestations. Fix the
ingest base default, and make ingest keep a producer's outcomes fresh on resubmit.

## Non-goals

- Tying contribution to the Publish action (explicitly decoupled).
- Attaching an account to the attestation payload (attribution stays via the
  separate `account_bindings` flow).
- Longitudinal / per-epoch outcome history (rejected: changes the dedupe key and
  k-anon "distinct producers" math).
- Contributing from **desktop client-mode** (no local core / transcripts / producer
  key). Known limitation, out of scope.
- The org-scoped admin view — that is **Spec 2**, a separate design → plan cycle.

## Decisions (from brainstorming Q&A)

| Question | Decision |
|---|---|
| What triggers a contribution? | A **separate** Contribute action, decoupled from Publish. |
| How does it run? | Consent **toggle (off by default)** + **manual button** + **warmable** that runs when the toggle is on. |
| Which gems does it attest? | The user's **published-to-Explore** gems only. |
| Attribution | Attestations stay **anonymous** (`account: null`; ed25519 pubkey is the only id). Org attribution derives from the existing `account_bindings` table, not the payload. |
| Freshness on resubmit | Ingest **updates** a producer's outcomes/usage in place for the same `(gem_digest, producer_pubkey)`. |
| Toggle + button placement | The **Benchmark tab** (where the empty state lives). |

## Architecture

### Producer (local core)

1. **Ingest base fix** — `packages/insight/src/ingestClient.ts`.
   Resolve base like every sibling client:
   `explicit → AGENTGEM_INGEST_URL → AGENTGEM_AGGREGATOR_URL → DEFAULT_AGGREGATOR_URL`,
   appending path `/api/aggregator/ingest` when the base is an aggregator origin
   (not a full ingest URL). Preserve `""`-means-disabled for an explicit opt-out
   (mirrors `shareClient` semantics). `AGENTGEM_INGEST_URL` remains a full-URL
   override for anyone who sets it.

2. **Consent gate** — a local boolean setting `benchmarkContribute` (default
   `false`), persisted in the core's existing config store. Guards **both** the
   manual route and the warmable. Never contribute when unset/false.

3. **Contribution core** — new `src/benchmark/contributeCore.ts`.
   - Enumerate this workspace's published gems that it can still rebuild
     (see *Implementation risk* below).
   - Per gem: `scanWorkflow` → `judgeSessions` → `buildAttestation({ account: null,
     facets })` → `signAttestation` (local identity via `loadOrCreateIdentity`) →
     `postAttestation`.
   - Reuse the distill `maybeJudge` rule: a **degraded** judge yields *no* outcome
     histogram (never publish neutral heuristic facets), but the gem's ingredient
     usage is still contributed.
   - Returns a per-gem result list: `{ gem, status: "ingested" | "updated" |
     "skipped" | "failed", reason? }`.

4. **Manual route** — `POST /api/benchmark/contribute` on
   `src/benchmark.proxy.controller.ts`. Returns 409 when the toggle is off;
   otherwise runs `contributeCore` and returns the per-gem result list. Same-origin
   proxy pattern, consistent with the existing benchmark read routes.

5. **Warmable** — a `contribute` warmable registered in the warm system that runs
   `contributeCore` on the warm cadence **only when the toggle is on** (same shape
   as the distill warmable). Idempotent by design: the aggregator now updates in
   place, so repeated runs refresh rather than duplicate.

6. **Console UI** — `packages/console`. On the Benchmark tab: a consent toggle and a
   "Contribute now" button that shows per-gem progress/results. Every new `ex-*`
   className gets a matching rule in `styles.css` in the same change (per CLAUDE.md),
   reusing `--ink`/`--surface`/`--brand` tokens and mirroring a sibling component.

### Receiver (hosted aggregator)

7. **Update-on-resubmit** — `packages/aggregator/src/ingest.ts` +
   `project.ts`. When `ingestAttestation` finds a prior `(gem_digest,
   producer_pubkey)` row, re-project **in place** instead of early-returning:
   - Keep the **same** attestation `id` → `producers.attestCount` does **not**
     increment, and the k-anon `count(distinct producer_pubkey)` is unchanged.
   - Update the `attestations` scalar fields (`scanSessions`, `scanSpanDays`,
     `signalDigest`, `privateCount`, `models`, `ingestedAt`).
   - **Delete then reinsert** that attestation's `usage_edges` and `model_outcomes`
     (the ingredient set or per-model counts may have changed; `onConflictDoNothing`
     is insufficient for a true replace).
   - `IngestResult` gains an `updated: true` variant (or the existing idempotent
     result carries an `updated` boolean) so the producer can report accurately.

## Data flow

```
toggle on
  → (Contribute button | warm tick)
  → contributeCore: for each published, rebuildable gem
      → scanWorkflow → judgeSessions → buildAttestation(account:null) → signAttestation
      → postAttestation → POST /api/aggregator/ingest
  → verifyAttestation (ed25519 + anti-inflation)
  → ingestAttestation: INSERT (first time) OR in-place UPDATE (resubmit)
  → aggregates.ts rollups (unchanged)
  → benchmark read path (unchanged) now shows producers ≥ k
```

## Privacy

Off by default. The consent surface states exactly what is shared:

- **Anonymous, k-anonymised** aggregate ingredient usage + per-model outcome counts,
  for your **published** gems only.
- Signed by your **producer key** (pseudonymous); **no account attached**.
- **No** per-session content or transcripts. Private ingredients are **counted, not
  named** (`privateCount`), and the hashing salt is withheld.
- Org attribution, if any, comes only from a **separately-consented** `bind`.

## Error handling / degradation

- Ingest base is explicit `""` (opt-out) → skip, report `disabled`.
- Degraded judge → contribute ingredient usage with **no** outcome histogram
  (matches `buildAttestation` when `facets` is absent).
- Per-gem `postAttestation` / network failure → record `failed`, **continue** the
  batch; the warmable retries on the next tick.
- Ingest verification failure (`bad-signature` / `inconsistent`) → surfaced per gem;
  should not occur for locally-built attestations but is reported, not swallowed.

## Testing

**Aggregator (unit):**
- Resubmit for the same `(gem_digest, producer_pubkey)` with a changed histogram →
  outcomes/usage **replaced**; `count(distinct producer_pubkey)` and `attestCount`
  **unchanged**; result flagged `updated`.
- First-time ingest still inserts and increments as before (no regression).

**contributeCore (unit, injected deps):**
- No-ops (no ingest calls) when the toggle is off.
- Enumerates published gems; injected fake `judge`/`publish`/`http` assert one
  `postAttestation` per rebuildable gem and the result shape.
- Degraded judge → attestation built with empty histogram.
- Per-gem failure is isolated (batch continues).

**ingestClient (unit):**
- Base falls back to the aggregator default when `AGENTGEM_INGEST_URL` unset.
- `""` disables (returns `skipped`).

**Route:** `POST /api/benchmark/contribute` returns 409 when the toggle is off.

**Console:** toggle persists and the button renders per-gem results (jsdom asserts
behavior). A **real-browser** check confirms the new `ex-*` styles render (jsdom
never asserts appearance).

## Implementation risk (flagged)

Enumerating "my published gems **that this workspace can rebuild**." Working
assumption: contribution iterates gems *published from this workspace*, where the
local `GemSelection` + sessions still exist — you attest **your** usage. A gem
published from another machine is not attestable here, which is correct behavior,
not a bug. The implementation plan will pin the exact local source (a local publish
ledger vs. a signed remote "my gems" query, intersected with locally-resolvable
selections) before building the enumerator.

## Files (anticipated)

- `packages/insight/src/ingestClient.ts` — base resolution fix.
- `packages/aggregator/src/ingest.ts`, `project.ts` — update-on-resubmit.
- `src/benchmark/contributeCore.ts` — new contribution core.
- `src/benchmark.proxy.controller.ts` — `POST /contribute` route + consent gate.
- Warm registration for the `contribute` warmable.
- Core config plumbing for the `benchmarkContribute` setting.
- `packages/console` — Benchmark tab toggle + button + `styles.css` rules.
- Tests alongside each.
