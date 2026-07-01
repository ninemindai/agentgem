# Adoption Telemetry (Gem Contributions #D — opt-in install signal → rating) — Design

**Date:** 2026-06-30
**Status:** Approved-pending-review — subsystem **D**, the keystone the Stone rating (#C) and the vision defer to. Reuses the aggregator's signing/identity/verify infrastructure but adds its own event, table, and gem-level aggregate.

## Goal

Emit an **opt-in, k-anonymized "someone installed this registry gem" signal** and use it to raise the Stone rating above the star curve — the first *real adoption* term in `stones = max(floor, starCurve(stars), adoptionCurve(installs))`. This is the honest-adoption backbone #C deferred. It is deliberately **infra ahead of scale**: at k-anon ≥5 distinct installers per gem, nothing shows until real adoption arrives — the `max(…)` shape means it simply contributes nothing until then.

## Decisions (settled with the user)

1. **Opt-in, default OFF.** Adoption emits only when the user explicitly enables "share anonymous adoption" (a console toggle persisted locally) AND the aggregator URL is configured. This is the product's FIRST automatic phone-home; the trust-first posture is deliberate for a distribution product. Mirrors the existing implicit opt-in (`postAttestation` no-ops without `AGENTGEM_INGEST_URL`).
2. **Emit site = `registryInstall` only.** Installing a gem FROM the registry — the cleanest signal (always a real `@scope/name` catalog key + full identity). `applyGem`/`runGemWithAgent` deferred.
3. **New event + table, NOT extending `UsageAttestation`.** Cardinality: `UsageAttestation` is a producer's own record keyed `attestations.gem_digest UNIQUE` (one per gem). Adoption is **many installers → one gem** (a distinct-installer count); two installers of the same gem would collide on that UNIQUE constraint. Adoption needs its own table + gem-level aggregate; it reuses only the ed25519 identity, canonical-JSON signing, and the verify pattern.
4. **k-anon ≥5** (the existing `DEFAULT_K`), coordinates-only, count distinct installer pubkeys — same posture as ingredient `popularity`.
5. **💎 Diamond apex = deferred** (now *reachable* — floor 3 + broad adoption — but spec'd as an optional last task, not core).

## Context (ground-truth verified)

- **Identity + signing** (`packages/model/src/identity.ts`): `loadOrCreateIdentity(dir=~/.agentgem)` → `Identity { publicKey: "ed25519:…"; sign(data): string }` (ed25519, persisted `~/.agentgem/identity.json`, 0600). `verify(publicKey, data, signatureB64): boolean`.
- **The attestation build/sign pattern to mirror** (`packages/insight/src/attestation.ts:62-110`): `buildAttestation(args) → UsageAttestation` (producer.publicKey="" placeholder), then `signAttestation(att, identity, signedAt)` fills `producer.publicKey` + signs `identity.sign(canonicalJSON(rest))` (rest = everything except `signature`). `postAttestation` (`ingestClient.ts`) POSTs to `AGENTGEM_INGEST_URL` with a Bearer token, returns `{ ingestId }` or `{ skipped: true }` when unconfigured.
- **The verify pattern** (`packages/aggregator/src/ingest.ts:12`): `const { signature, ...rest } = att; if (!verify(att.producer.publicKey, canonicalJSON(rest), signature)) return bad-signature;` + domain consistency checks.
- **Aggregator schema** (`packages/aggregator/src/schema.ts`): `producers { pubkey PK, firstSeen, attestCount }`; `attestations { …, gemDigest UNIQUE, producerPubkey → producers.pubkey, … }`; `account_bindings { pubkey → producers.pubkey, provider, accountId, … }` (the verified-account join). `AppDb` is the drizzle db type; tests use PGlite via `makeTestDb()` which creates schema from the drizzle definitions.
- **k-anon aggregate pattern** (`packages/aggregator/src/aggregates.ts`): `DEFAULT_K = 5`; `popularity()` groups, `count(distinct a.producer_pubkey)`, `left join account_bindings b … count(distinct b.provider||':'||b.account_id) as verifiedProducers`, `having count(distinct a.producer_pubkey) >= ${k}`, `not a.quarantined`.
- **Controller** (`src/aggregator.controller.ts`): `@post("/ingest")` → `ingestAttestation(this.db, body)`; `@get("/popularity"|"/adoption"|…)` → the aggregate fns. `this.db` injected via `DrizzleBindings`. Write endpoints (`/ingest`) are rate-limited via `mountGating` (`AGG_INGEST_POINTS`).
- **Emit site** (`src/gem.controller.ts:851`): `registryInstall` → `const { plan, gem } = await resolveInstall({ refs: input.body.refs, mode, … })`; branches materialize (writes files) / workspace (createWorkspace). `input.body.refs` = the requested `@scope/name@range` list; the resolved `plan` carries exact resolved versions + digests; `gem` is the resolved gem. On success, both branches have the installed gem identity.
- **Marketplace** (`packages/marketplace/src/`): `makeApi` already calls aggregator endpoints; `pages/Gems.tsx`/`Gem.tsx` already batch `stars.api.get("gem", ids)` and render `<StoneRating cut grade stars />` (from #C, `gems/rating.ts` `stoneRating(floor, stars)`). Marketplace is standalone (mirrors, no server imports).

## The bugs in the obvious sketch (must avoid)

1. **Reusing the `attestations` table.** Its `gem_digest UNIQUE` breaks the moment two installers install the same gem. A NEW `gem_adoptions` table keyed `(gem_key, producer_pubkey)` is required — idempotent per installer, count distinct installers.
2. **Blocking/breaking the install on emit failure.** The emit is fire-and-forget: never awaited into the response path, wrapped so any network/verify error (or opt-out) silently skips — a telemetry failure must never fail a `registryInstall`. Mirror `postAttestation`'s no-op-when-unconfigured.
3. **Emitting when opted out.** The gate is BOTH an explicit local `shareAdoption` opt-in AND a configured aggregator URL. Default false → zero phone-home out of the box.
4. **Counting re-installs.** Idempotency `(gem_key, producer_pubkey)` — re-installing (any version) never inflates a gem's installer count.
5. **Un-anonymized exposure.** The gem-adoption aggregate applies `having count(distinct producer_pubkey) >= k` (k=5) exactly like `popularity`; a gem with <5 distinct installers returns NO row (→ marketplace sees 0 → adoption contributes nothing).

## Components (files)

### Event (packages/insight)
- **`packages/insight/src/adoption.ts`** (new): `interface GemAdoption { formatVersion: 1; gemKey: string; version: string; gemDigest: string; event: "install"; producer: { publicKey: string; account: { provider: string; login: string } | null }; signedAt: number; signature: string }`. `buildGemAdoption(args: { gemKey; version; gemDigest; account? }): GemAdoption` (publicKey="" placeholder, signature=""). `signGemAdoption(a, identity, signedAt): GemAdoption` (fill publicKey + `identity.sign(canonicalJSON(rest))`, mirror `signAttestation`). Export from the insight barrel.
- **`packages/insight/src/ingestClient.ts`** — add `postGemAdoption(a: GemAdoption, opts?): Promise<{ ingestId } | { skipped: true }>` mirroring `postAttestation` (POST to `<base>/api/aggregator/adopt`; skip when the base is unconfigured).

### Aggregator (packages/aggregator)
- **`schema.ts`** — new `gemAdoptions = pgTable("gem_adoptions", { gemKey text, gemDigest text, producerPubkey text → producers.pubkey, accountLogin text (nullable), event text, adoptedAt timestamptz default now() }, primaryKey(gemKey, producerPubkey))`. (event kept as a column for future apply/run; v1 always "install".)
- **`verifyAdoption.ts`** (new, or fold into ingest): `verifyGemAdoption(a): { ok: true } | { ok: false; reason: "bad-signature" }` — ed25519 over `canonicalJSON(rest)` (no session-consistency checks needed).
- **`ingestAdoption.ts`** (new): `ingestGemAdoption(db, a): Promise<{ accepted: true; idempotent: boolean } | { accepted: false; rejected: "bad-signature" }>` → verify → `projectGemAdoption`.
- **`projectGemAdoption(db, a)`**: upsert `producers` (like `projectAttestation`); `insert gem_adoptions … on conflict (gem_key, producer_pubkey) do update set gem_digest=…, version-less, adopted_at=now(), account_login=…` (keeps latest, idempotent).
- **`aggregates.ts`** — new `gemAdoption(db, { keys?: string[]; k?: number }): Promise<{ gemKey: string; installs: number; verifiedInstalls: number }[]>`: `select gem_key, count(distinct producer_pubkey) as installs, count(distinct b.provider||':'||b.account_id) as "verifiedInstalls" from gem_adoptions g left join account_bindings b on b.pubkey = g.producer_pubkey where (keys is null or gem_key = any(keys)) group by gem_key having count(distinct producer_pubkey) >= ${k}`. k=DEFAULT_K.
- Export all new symbols from the aggregator barrel.

### Server (src)
- **`src/aggregator.controller.ts`** — `@post("/adopt", { body: AdoptBody, response: AdoptResult })` → `ingestGemAdoption(this.db, body)`; `@get("/gem-adoption", { query: GemAdoptionQuery, response: GemAdoptionResult })` → `gemAdoption(this.db, { keys })`. Add `/adopt` to the ingest rate-limit bucket in `mountGating` (same as `/ingest`).
- **`~/.agentgem/config.json` opt-in** — a tiny local config read/write helper (`readAgentgemConfig()/writeAgentgemConfig(patch)` in `@agentgem/model` or `src/`), `{ shareAdoption?: boolean }` (default false). Server endpoints `@get("/settings/adoption")` / `@post("/settings/adoption", { body: { enabled } })` on the gem controller (local console API) to read/toggle it.
- **`src/gem.controller.ts` `registryInstall`** — after a successful install (both branches), fire-and-forget:
  ```ts
  void emitAdoption(plan, this.aggregatorBase);   // reads shareAdoption + URL; builds/signs/posts per installed ref; swallows all errors
  ```
  `emitAdoption` lives in a new `src/registry/emitAdoption.ts`: if `!shareAdoption` or no aggregator URL → return; else for each resolved installed ref, `postGemAdoption(signGemAdoption(buildGemAdoption({ gemKey, version, gemDigest, account? }), loadOrCreateIdentity()))`, all wrapped in try/catch. Never awaited into the response.

### Marketplace (packages/marketplace)
- **`src/gems/rating.ts`** — add `adoptionCurve(installs: number): number` (k-anon so installs are 0 or ≥5: `<5→1` (no contribution), `5–9→3, 10–49→4, 50+→5`), and extend `stoneRating(floor, stars, installs) = min(5, max(floor ?? 1, starCurve(stars), adoptionCurve(installs)))`. Keep the 2-arg call sites working (installs defaults 0).
- **`src/api.ts`** — add `gemAdoption(keys: string[]): Promise<Record<string, number>>` hitting `GET /api/aggregator/gem-adoption?keys=…` (→ `{ gemKey: installs }`; empty/failed → `{}`).
- **`pages/Gems.tsx`/`Gem.tsx`** — fetch adoption counts for the visible gems in ONE batched call (like stars); pass `installs={adoptions[g.key] ?? 0}` into `<StoneRating … />`. `StoneRating.tsx` gains an `installs` prop threaded into `stoneRating`.

## Testing

- **Event** (insight, root suite): `buildGemAdoption` shape; `signGemAdoption` → `verifyGemAdoption` round-trips; a tampered field → bad-signature.
- **projectGemAdoption** (aggregator, PGlite): two DISTINCT installers of the same gem → 2 rows, `installs=2`; the SAME installer twice (idempotent) → 1 row; producer upserted.
- **gemAdoption aggregate**: k-anon — 4 installers → NO row; 5 → a row with `installs=5`; `keys` filter; `verifiedInstalls` via account_bindings.
- **`/adopt` + `/gem-adoption` endpoints**: 200 accept a signed event → idempotent on repeat; a bad-signature → rejected; `/gem-adoption?keys=` returns the k-anon map.
- **emitAdoption**: opted-OUT → posts nothing; opted-in + URL → builds/signs/posts per ref; a post error is swallowed (install still returns success). (Stub `postGemAdoption`.)
- **Marketplace**: `adoptionCurve` boundaries + `stoneRating` 3-arg `max` (installs 50 + floor 1 + 0 stars → 5); `Gems.tsx` fetches adoption in ONE batched call; a gem with installs renders the blended rating.
- Gates: server `pnpm exec tsc -b` + full `pnpm test` (build console first); `pnpm --filter @agentgem/marketplace test|typecheck|build`.

## Migration / deploy note

`gem_adoptions` is a new table. Tests create schema from the drizzle definitions (PGlite `makeTestDb`). For the hosted Neon slice, the table must be created the same way the existing aggregator tables are provisioned (drizzle push / the existing migration mechanism) — the plan's first aggregator task includes wiring the table into that path. No data migration (new table, empty).

## Out of scope (deferred)

- **💎 Diamond apex seal** — reachable now (floor 3 + broad adoption + max stars); spec'd as an OPTIONAL final task (`isDiamond(floor, stars, installs)` + a distinct render), not core.
- **apply/run emit sites** — `applyGem` (may be an unpublished gem → conditional key resolution) and `runGemWithAgent` (needs gem-identity plumbing).
- **Time-series gem adoption** (weekly buckets like ingredient `adoption()`) — the lifetime distinct-installer count is enough for the rating.
- **Un-gating the emit by default** — stays opt-in; revisiting the posture is a separate product decision.

## Risks

- **First auto phone-home:** mitigated by opt-in-default-off + k-anon + coordinates-only + fire-and-forget-never-blocks. The console toggle makes the choice explicit and visible.
- **Sybil inflation** (one actor, many keys → many fake installs): the existing `quarantined`/trust machinery applies to attestations, not yet to adoptions; v1 accepts this (k-anon limits exposure, not inflation). A trust/quarantine pass on adoptions is a fast-follow — noted, not built. Do NOT claim adoption counts are sybil-resistant.
- **Nothing shows for a long time** at current scale (k-anon ≥5 per gem): intended; the pipeline is laid ahead of the volume, same as #C.
- **Hot files:** `aggregator.controller.ts`, `gem.controller.ts`, `schema.ts`, `aggregates.ts`, marketplace `Gems.tsx`/`rating.ts` are concurrently active — additive diffs, branch off latest `origin/main` (776efb7), integrate promptly.
