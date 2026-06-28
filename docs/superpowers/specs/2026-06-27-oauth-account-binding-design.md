# OAuth account-binding (anti-sybil anchor) — Design

**Date:** 2026-06-27
**Status:** Approved (brainstorm). Slice 1 of #28 (identity + trust layer). Builds on the B1 aggregator + producer (Spec A), both on `origin/main`.

## Goal

Make the aggregator's headline "distinct producers" metric **sybil-resistant** by binding each producer's
ed25519 key to a real GitHub account, and exposing a `verifiedProducers` overlay alongside the existing
raw producer count on every public aggregate.

Today the headline is `count(distinct producer_pubkey)`. A sybil inflates it by generating N keypairs —
free. Per-key velocity caps are weak because the metric *is* a distinct-key count. The durable anchor is
identity: collapse keys that belong to one real account into one verified producer, so faking N verified
producers costs N real GitHub accounts.

## What already exists (and what's missing)

- `UsageAttestation.producer.account: { provider, login } | null` already exists in the signed payload
  (`src/gem/attestation.ts`). It is **self-asserted and ignored**: the producer writes any login, nothing
  proves ownership, and the aggregator neither stores nor checks it.
- The `producers` / `attestations` tables have no account column; `verifyAttestation` skips `account`.

This slice makes that field's *claim* trustworthy by recording a **server-verified** binding keyed by the
cryptographically-checked pubkey — never by trusting the self-asserted field.

## Decisions (locked in brainstorming)

1. **Counting model: verified overlay (non-breaking).** Keep the raw distinct-pubkey count and its k-anon
   gate exactly as-is. Add a second integer, `verifiedProducers` = distinct bound accounts. Unbound keys
   contribute to the raw count only; they can never inflate the verified one.
2. **Provider: GitHub**, via the **OAuth device flow** — no callback URL, no client secret, idiomatic CLI
   auth (`gh auth login` shape). This decouples the slice from the still-pending deploy (#38).
3. **Binding lives in its own table, looked up by pubkey at aggregate time (LEFT JOIN).** Binding *after*
   sharing retroactively verifies all past attestations from that key — fits the real "share first, bind
   later" path. (Alternative: stamp verified-ness onto each attestation at ingest — rejected: can't verify
   prior attestations without a backfill.)

## Architecture & data flow

```
agentgem bind                          aggregator (hosted)              GitHub
  │ device-flow: POST /login/device/code ───────────────────────────────▶
  │ ◀── user_code + verification_uri ────────────────────────────────────
  │ user approves at github.com/login/device …
  │ poll POST /login/oauth/access_token ─────────────────────────────────▶
  │ ◀── access_token ────────────────────────────────────────────────────
  │ POST /api/aggregator/bind
  │   { pubkey, token, signedAt, signature } ──▶ verify ed25519 sig (key owns pubkey)
  │                                              AccountVerifier.verify(token) ─▶ GET /user
  │                                              ◀── { id, login } ───────────
  │                                              upsert account_bindings(pubkey ↔ account)
  │ ◀── { provider, login, accountId } ─────────
```

Two independent proofs combine in one request:

- the **ed25519 signature** proves possession of the private key for `pubkey`;
- the **access token** proves possession of the GitHub account.

The server binds the two. Neither replay is harmful: re-sending a captured `/bind` re-asserts the same
`pubkey ↔ account` (idempotent upsert), and an attacker cannot forge the signature without the key nor read
the account without the token. A `signedAt` freshness window (±300 s) blocks stale-token reuse. No
server-issued nonce is required.

## Components & file structure

- `src/aggregator/schema.ts` — add `account_bindings` table + DDL in `ensureSchema`.
- `src/aggregator/accountVerifier.ts` (new) — `AccountVerifier` interface + `GitHubVerifier`
  (`api.github.com/user`). This is the only network seam; tests inject a `FakeVerifier`.
- `src/aggregator/binding.ts` (new) — `recordBinding(db, req, verifier)`: verifies signature + freshness,
  calls the verifier, upserts the binding. Pure except for the injected verifier.
- `src/aggregator/aggregates.ts` — add the `verifiedProducers` column to `popularity`, `coOccurrence`,
  `adoption` via `LEFT JOIN account_bindings`.
- `src/aggregator.controller.ts` — add `POST /api/aggregator/bind` (constructs `GitHubVerifier`; stays
  origin-guarded — it is a write, NOT a public read, so it is **not** added to `PUBLIC_READ_PATHS`).
- `src/bind/deviceFlow.ts` (new) — GitHub device-flow client (request code, poll for token).
- `src/bind/cli.ts` (new) — `agentgem bind`: load identity, run device flow, sign + POST `/bind`, cache
  `{ provider, login, accountId }` to `~/.agentgem/binding.json` for display.
- `src/cli.ts` — dispatch `argv[0] === "bind"` → `import("./bind/cli.js")`; add a `bind` help entry.

### Schema

```ts
export const accountBindings = pgTable("account_bindings", {
  pubkey: text("pubkey").primaryKey().references(() => producers.pubkey),
  provider: text("provider").notNull(),       // "github"
  accountId: text("account_id").notNull(),    // GitHub numeric id as text (stable across renames)
  accountLogin: text("account_login").notNull(),
  boundAt: timestamp("bound_at", { withTimezone: true }).notNull().defaultNow(),
});
```

- pubkey is the PK → a key binds to **exactly one** account.
- `(provider, account_id)` is the verified-producer identity; **many keys may share one account** (same
  dev, multiple machines) and collapse to 1 verified producer. `account_id` (numeric) is the identity, not
  `login` (which can be renamed).
- The binding FK requires the producer row to exist (it does after first ingest). `agentgem bind` therefore
  expects the key to have shared at least once; if absent, `/bind` returns a clear "share before binding"
  error. (Provisioning a bare producer row at bind time is a deferred nicety, not this slice.)

### Aggregate overlay (shape)

```sql
select e.ingredient_id as id, i.kind,
       count(distinct a.producer_pubkey)::int                         as producers,        -- unchanged
       count(distinct b.provider || ':' || b.account_id)::int         as verified_producers,-- new
       sum(e.invocations)::int as invocations, sum(e.sessions)::int as sessions
from usage_edges e
  join attestations a on a.id = e.attestation_id and not a.quarantined
  join ingredients  i on i.id = e.ingredient_id
  left join account_bindings b on b.pubkey = a.producer_pubkey
group by 1, 2
having count(distinct a.producer_pubkey) >= ${k}                       -- k-anon gate UNCHANGED (raw count)
order by producers desc limit ${limit};
```

`verifiedProducers ≤ producers ≥ k`, so adding it exposes no new entity below the k-anon floor and reveals
no identity (it is an aggregate integer; the account itself is never returned).

### Bind request shape

```ts
interface BindRequest {
  pubkey: string;     // "ed25519:…"
  token: string;      // GitHub access token (server-side, over TLS; never stored)
  signedAt: number;   // epoch ms, freshness-checked (±300_000)
  signature: string;  // ed25519 over canonicalJSON({ pubkey, tokenHash, signedAt }), tokenHash = sha256(token)
}
type BindResult =
  | { bound: true; provider: string; login: string; accountId: string }
  | { bound: false; rejected: "bad-signature" | "stale" | "unknown-producer" | "provider-error" };
```

Signing over `sha256(token)` (not the raw token) keeps the token out of the signed-and-loggable canonical
string while still binding the signature to this specific token.

## Provider seam

```ts
export interface VerifiedAccount { provider: string; accountId: string; login: string; }
export interface AccountVerifier { verify(token: string): Promise<VerifiedAccount>; }   // throws on invalid token
export class GitHubVerifier implements AccountVerifier { /* GET https://api.github.com/user */ }
```

All binding and aggregate logic is exercised against a `FakeVerifier` in pglite — zero network in the test
suite.

## Error handling

- `/bind`: bad signature → `bad-signature`; `signedAt` outside ±300 s → `stale`; pubkey has no producer row
  → `unknown-producer`; verifier throws (bad/expired token, GitHub down) → `provider-error`. All return
  `{ bound: false, rejected }` with an appropriate 4xx; never a 500 for an expected rejection.
- `agentgem bind`: device-flow timeout / user denial → clear message, non-zero exit, no partial local cache
  written. Network failure to the aggregator → message naming the endpoint.

## Testing (drizzle-pglite + fakes)

Aggregate overlay (`aggregates.test.ts` additions):
- `verifiedProducers` counts distinct bound accounts; two keys bound to one account collapse to 1.
- An unbound key contributes to `producers` but not `verifiedProducers`.
- Quarantined attestations excluded from both counts.
- The k-anon gate still keys on raw `producers` (a row with raw ≥ k but verified < k is still returned).

Binding (`binding.test.ts`, new):
- valid signature + fake-verified token + existing producer → binding recorded; result carries provider/login/accountId.
- bad signature → `bad-signature`; `signedAt` skewed > 300 s → `stale`; missing producer → `unknown-producer`;
  verifier throws → `provider-error`.
- idempotent re-bind (same pubkey↔account) succeeds and does not duplicate.
- rebinding a pubkey to a *different* account updates in place (PK upsert).

Device flow (`deviceFlow.test.ts`, new): against a fake HTTP layer — requests a code, polls, surfaces
`authorization_pending` then success; surfaces `access_denied` and `expired_token` as errors.

## Scope

**In this slice:** schema + DDL, `AccountVerifier` seam + `GitHubVerifier`, `recordBinding`, `POST /bind`,
the three aggregate overlays, `agentgem bind` CLI + device-flow client, full fake-driven tests.

**Deferred:**
- Registering the real GitHub OAuth app (`client_id`) + prod env wiring + a true end-to-end against live
  GitHub and a reachable aggregator — rides with the deploy (#38).
- Surfacing the verified badge / verified count in the Insights UI — rides with #42.
- Account-age / allowlist / review-state gating — already its own task (#45).
- Provisioning a bare `producers` row at bind time (bind-before-share) — nicety, not needed now.
- Exposing `verifiedProducers` through the controller response schemas is **in scope** (the SQL returns it,
  so the `PopResult` / `CoResult` / `AdoptResult` zod schemas gain the field); the UI consuming it is not.
```
