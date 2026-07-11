# Account Linking — Flow B: absorb a fresh second account

**Status:** approved, not yet planned
**Depends on:** account linking Flow A + backend (PR #331, merged) — `absorbAccount`, `accountFreshness`,
`accountIdForProvider`, `connectedProviders`, `pendingLink`/`stashPendingLink`, and the
`pending_account_links` table already exist and are tested.
**Blocks:** nothing. Completes the multi-provider linking story.

## Goal

A logged-in user can connect a sign-in provider that already belongs to a **separate, fresh** account,
folding that fresh account into the one they're keeping — so the two providers end up on one identity.
This is the collision half of "Connect a provider" that Flow A deferred.

Scope is exactly the **attach-and-discard** case the original account-linking spec defined: the account
being absorbed must be genuinely empty (no handle, gems, stars, reviews, group ties, org scopes, usage,
or archives — the full `accountFreshness` gate). If **both** accounts carry data, this still refuses with
the deferred-merge message. The hard two-data-bearing merge (**C**) remains out of scope.

## Why Flow B needs its own mechanism (the load-bearing fact)

The Flow A spike established that better-auth's `linkSocial`, on a collision, redirects back with
`?error=account_already_linked_to_different_user` and **discards which account it hit** — the conflict is
inline in better-auth's callback (`callback.mjs`), no DB write, no hook. So to absorb the other account we
must learn its identity ourselves, from a server-verified OAuth, bound to the caller's session, without a
client ever naming a victim account. `pending_account_links` + `pendingLink`/`stashPendingLink` were built
for exactly this handoff; Flow B fills in the missing producer (the OAuth) and consumer (the absorb route).

## Decisions

### Mechanism: a bespoke connect flow that reuses better-auth's provider objects; the session never swaps

The caller stays signed into their **current** account throughout. A new connect flow does its own OAuth
round-trip using better-auth's *own* configured provider objects (`auth.$context.socialProviders[id]`,
which expose `createAuthorizationURL` / `validateAuthorizationCode` / `getUserInfo` — the same methods
better-auth's callback uses). Nothing OAuth-cryptographic is hand-rolled. The resolved *other* identity is
stashed against the caller's session (`stashPendingLink`), and `absorbAccount` consumes it.

Rejected alternative: reusing better-auth `/sign-in/social` for the other provider. That swaps the browser
session to the other account mid-flow (confusing; abandoning strands the user on the wrong account) and
needs a separate one-time-token handoff. Staying on the current account is the better experience.

### Callback: reuse better-auth's single registered callback URL, routed by `state`

GitHub's sign-in is a **classic OAuth App** — a single, immutable "Authorization callback URL"
(`/api/auth/callback/:provider`), no support for a list. Rather than add or broaden a callback URL, the
connect flow reuses that exact callback and **routes on the `state` parameter**:

- A thin shim is registered at `GET /api/auth/callback/:provider` **before** `mountAuth`'s catch-all
  (the established `/api/auth/handoff/*` pattern proves raw `/api/auth/*` routes coexist with the catch-all).
- The shim looks the request's `state` up in our `connect_states` store. **Found** → it is ours; the shim
  handles the exchange. **Not found** → `next()`, and better-auth handles its own sign-in / link-social
  callback completely untouched.

This means: **no GitHub console change**, and no redirect-URI override to fight — we *want* better-auth's
default `redirect_uri`, so `createAuthorizationURL`'s hardcoded redirect is exactly right. `state` is
high-entropy and already the CSRF token, so it does double duty as the router. Google's callback is
unchanged too (its console may need its existing redirect URI confirmed, nothing new).

**Prove first (mini-spike, plan's first task):** that the `state`-routing shim at
`/api/auth/callback/:provider` intercepts *our* state and passes every foreign state through to better-auth
without disturbing normal sign-in / link-social. This sits in the auth hot path, so it is verified before
anything is built on it.

### Two entry points, one absorb

1. **`/account` "Connect"** (additive to Flow A): the normal Connect button still uses `linkSocial`. Only
   when `linkSocial` bounces back with `?error=account_already_linked_to_different_user` does `/account`
   show a **"Merge this account"** button, which starts the bespoke connect flow. The second OAuth reads
   naturally as "sign in to that other account once to prove it's yours." Flow A is untouched.
2. **Handle-claim nudge**: when a handle-less user's claim 409s because `@name` is owned by another account,
   `HandleClaim` routes them to `/account` with a banner "To claim @name, connect the account that owns it."
   They Connect whichever provider is theirs (we do not reveal which owns `@name` — preserves the
   anti-enumeration property the original spec required).

Both paths converge on the same connect → `stashPendingLink` → absorb machinery.

## Components

### Backend (aggregator + app)

- **`connect_states` store** (`schema.ts` + helpers in `auth/accountLinking.ts`): one row per in-flight
  connect — `state_hash` (PK, sha256 like `handoff_codes`), `code_verifier`, `current_user_id`, `provider`,
  `expires_at` (~10 min). One-time: consumed on callback. `stashConnectState(db, ...)` /
  `consumeConnectState(db, stateHash)`; `ensureSchema` gets its idempotent `create table if not exists` DDL.
- **`GET /api/account/connect/:provider` (start)** — `src/account/connect.ts`, a raw redirect route.
  `resolveSession` → `currentUserId` (401 / sign-in redirect if none). Build the provider authorize URL via
  the provider's `createAuthorizationURL` with `redirect_uri = <baseURL>/api/auth/callback/:provider`;
  persist the returned `state` + `code_verifier` (with `currentUserId`, `provider`) in `connect_states`;
  `302` to the provider. (Whether `createAuthorizationURL` also writes better-auth's own verification-table
  state is a side effect the shim is indifferent to — it routes on `connect_states` membership, and consumes
  its own row; the mini-spike confirms no interference.)
- **`GET /api/auth/callback/:provider` shim** — `src/account/connect.ts`, registered **before** `mountAuth`.
  Consume `state` from `connect_states`; if not ours, `next()`. If ours:
  `provider.validateAuthorizationCode({ code, codeVerifier, redirectURI })` → `provider.getUserInfo()` →
  the server-verified `(providerId, providerAccountId)`. `accountIdForProvider` decides:
  belongs to another account → `stashPendingLink(currentUserId, identity)` → `302 /account?connect=ready`;
  unused / already the caller's → `302 /account?connect=none`. The session cookie is never read for identity
  and never swapped.
- **`POST /api/account/absorb`** — extend `src/account/install.ts` (the handler deferred in the Flow A slice).
  Credentialed fetch (CORS + originGuard-exempt like `/api/account/providers`). `resolveSession` → `current`;
  `pendingLink(current)` → identity (else `409`); `accountIdForProvider` → `other` (else `409`);
  `absorbAccount(current, other)`:
  - ok → delete the `pending_account_links` row; if `keep !== current`, **re-mint keep's session cookie**
    (`mintSessionCookie`) so the browser lands on the surviving account; return `{ keep, connected }`.
  - `merge-not-supported` → `409` with the deferred-C message.
  Freshness is judged only inside `absorbAccount` — one authority.

### Marketplace SPA

- **`Account.tsx`**: replace Flow A's plain "already linked to another account" text with a **"Merge this
  account"** button → `GET /api/account/connect/:provider`. On `?connect=ready`, show a brief confirm
  ("This merges the just-verified account — it has no gems, handle, or data — into this one"), then
  `POST /api/account/absorb`; on success refresh providers + identity (the session may have changed); on
  `409` show the deferred-merge or no-pending message. Strip `?connect=` / `?error=` after handling (reuse
  the existing stale-param fix).
- **`HandleClaim.tsx`**: on a claim-409 owned by another account, route to `/account` with the connect
  banner (no provider revealed).
- **`auth.ts` / `api.ts`**: a `connect(provider)` helper (navigates to the start route) and the `absorb`
  fetch; mirror the existing `linkSocial` / `getAccountProviders` shapes.

## Data flow

```
CONNECT (collision) — session stays on `current`
  /account (signed in as CURRENT) ── "Merge this account" ──▶ GET /api/account/connect/:provider
     └▶ store connect_states{state, codeVerifier, currentUserId}; 302 to provider (redirect_uri = better-auth's)
        └▶ provider OAuth ──▶ GET /api/auth/callback/:provider  (shim, before mountAuth)
           ├▶ state ∈ connect_states?  no → next() → better-auth's own callback (untouched)
           └▶ yes → consume state; validateAuthorizationCode + getUserInfo (better-auth provider methods)
                    accountIdForProvider(other identity):
                      belongs to another account → stashPendingLink(currentUserId, id) → 302 /account?connect=ready
                      unused / already yours     → 302 /account?connect=none
  /account (?connect=ready) ── confirm ──▶ POST /api/account/absorb
     ├▶ pendingLink(current) → other  (server-verified; never a client id)
     ├▶ absorbAccount(current, other)
     │     neither fresh → 409 merge-not-supported (deferred C)
     │     else keep = data-bearing (or current if both fresh), drop = the fresh one
     ├▶ delete pending row; if keep ≠ current → Set-Cookie keep's session (mintSessionCookie)
     └▶ { keep, connected } ── caller lands on keep with both providers

HANDLE-CLAIM NUDGE
  Claim @name (owned by another account) → 409 → HandleClaim routes to /account + connect banner
     → same Connect → connect flow above (here current is usually the fresh side → keep = other, session re-minted)
```

## Testing

- **Mini-spike (prove first):** the `/api/auth/callback/:provider` shim intercepts a `connect_states` state
  and calls `next()` for a foreign state, leaving better-auth's normal sign-in / link-social callback intact.
- **Connect start:** stores a `connect_states` row (hashed) bound to the session's `currentUserId`; redirects
  with our `state` and `redirect_uri = /api/auth/callback/:provider`; 401 without a session.
- **Callback shim:** our state → mocked `validateAuthorizationCode`/`getUserInfo` → `stashPendingLink` with
  the resolved identity + `302 ?connect=ready`; a state not in `connect_states` → `next()` (a stub
  downstream handler runs, proving pass-through); expired/used state → not honored.
- **Absorb route:** fresh other absorbed (both providers on the survivor, pending row gone); `current` is the
  fresh side dropped → response re-mints keep's session; neither fresh → `409` merge-not-supported; no pending
  → `409`. `other` is always derived from `pendingLink`, never the request body (a body naming a different id
  is ignored).
- **Security:** connect_states one-time + TTL + hashed at rest + bound to the starting session; the resolved
  other identity is server-verified and tied to `currentUserId`; `absorbAccount` only ever deletes a
  provably fresh (FK-empty) account (its existing tests stand).
- **SPA:** collision → "Merge" button starts connect; `?connect=ready` → confirm → absorb → updated view
  (session refresh when it changed); handle-claim 409 → routes to `/account` with the banner; params stripped.
- Reuse the merged `absorbAccount` / `accountFreshness` / `pendingLink` engine tests unchanged.

## Ops / prerequisites

- **Confirm the GitHub app type** (plan prerequisite). If a **classic OAuth App** (expected), the state-routed
  callback needs **no GitHub console change**. If it turns out to be a **GitHub App**, a clean
  `/api/account/connect/:provider/callback` path with an added callback URL is an option, but the state-routed
  design works either way and is the default.
- **Google:** confirm its authorized redirect URI list includes `/api/auth/callback/google` (already used by
  sign-in, so almost certainly present) — no new URL.
- Marketplace vitest is **now CI-gated** (recent trunk change), so the SPA tests run in CI — no longer
  local-only.

## Non-goals

- **Merging two data-bearing accounts (C)** — handle/gem/FK reconciliation; its own slice behind an
  adversarial review.
- **Unlinking / removing a connected provider** — needs a "can't remove your last provider" guard.
- **Providers beyond GitHub + Google.**
