# Account Linking: Connect Providers to One Account

**Status:** approved, not yet planned
**Depends on:** identity re-key (#285), Google sign-in (#289) — both merged and deployed
**Blocks:** nothing. A follow-up to multi-provider auth.

## Goal

A logged-in user can connect additional sign-in providers to their account, so one person
has one account with several sign-in buttons. GitHub and Google (today's two providers)
become two ways into the *same* identity instead of two separate accounts.

There is **one** capability, initiated from a logged-in state: **Connect [provider]**. It
covers both realistic cases with a single flow. It does **not** merge two accounts that both
carry real data — that is a separate, deferred slice.

## Why linking is currently impossible (the load-bearing fact)

`anchorAndScopes` (`packages/aggregator/src/auth/betterAuth.ts`) writes the legacy `accounts`
anchor row with `id = account.userId`, and `accounts.id` is the PRIMARY KEY. better-auth's
`account` table already models multiple provider-accounts per `user`, so `linkSocial` adds a
second `account` row for the same `user.id` and fires the `account.create` hook again — which
calls `anchorAndScopes` with the *same* `user.id`. `upsertAccount` conflicts on
`(provider, provider_account_id)`, not on `id`, so it attempts to INSERT a second `accounts`
row with a duplicate PK → **primary-key violation → throw**. On CREATE the anchor throw aborts
the sign-in, so **any attempt to link a second provider fails today.**

The fix reframes the anchor correctly: the legacy `accounts` row is **per-user** (the
authorization anchor whose uuid owns gems), not per-provider. A second provider linked to an
existing user needs **no new anchor row** — the existing one already is the anchor. better-auth's
`account` table holds the per-provider records natively. This is the core enabling change; every
flow below rests on it.

## Decisions

### One entry point: "Connect [provider]" from a per-user account surface

Every logged-in user has an **account-settings surface** (new `/account` route; the marketplace
has no settings page today). It lists connected providers and offers **Connect** for the ones
you don't yet have. A single action, always the same first two steps: you're signed into one account, you complete
an OAuth round-trip on the provider you're connecting. What happens next depends only on whether
that provider's identity already belongs to another AgentGem account:

- **The OAuth'd provider has no separate account** → native better-auth `linkSocial` attaches its
  `account` row to your current `user`. No merge.
- **The OAuth'd provider is already a separate account, and exactly one of the two accounts is
  *fresh*** → **absorb**: re-point the fresh account's provider row onto the account being kept,
  delete the fresh (now-empty) account. The surviving account is the one that carries data; if
  both are fresh, either survives. No data reconciliation (see "fresh" below).

Because the OAuth round-trip proves control of the connected provider and you were already signed
into the current account, **both accounts are authenticated by the same action** — the direction
you initiate from does not matter. Connect Google from your GitHub account, or Connect GitHub
from a fresh Google account: either way the fresh side is discarded and the data side survives.

The handle-claim conflict is **not** a separate flow — it is a nudge. When a handle-less user
tries to claim a handle owned by another account, show: *"@name belongs to another account —
connect it from your account settings,"* linking to `/account`. One capability, one code path.

### The security gate: dual authentication, not email

Linking requires **authenticating both accounts in one flow** — signed into one, an OAuth
round-trip on the other. Controlling both proves you own both. Configuration:
`trustedProviders: ["github", "google"]`, `allowDifferentEmails: true`. Email is deliberately
**not** a gate: a person's GitHub and Google emails commonly differ, and a matching email proves
nothing an attacker who already controls a provider couldn't arrange. Hostile linking is
prevented by construction — you cannot attach a provider to an account you can't sign into, and
you cannot discard an account you can't sign into.

### "Fresh" is defined strictly; anything else is the deferred merge

The **attach-and-discard** path (absorbing a second account into the one you keep) is allowed
ONLY when the account being discarded is genuinely just-signed-in: it has **no handle, no owned
gems (`catalog_gems.owner_account_id`), no stars, no reviews, and no group memberships.** If it
has *any* of those, the two accounts both carry identity/data and merging them is out of scope —
the Connect action **blocks with a clear message**: *"Both accounts have activity on AgentGem.
Merging accounts with existing gems or a claimed handle isn't supported yet."* This keeps the
shipped path a pure attach-provider + delete-empty-user, with **zero data reconciliation** and no
destructive merge logic to get wrong.

## Components

### Backend (aggregator)

- **`anchorAndScopes` fix** (`betterAuth.ts`): make the anchor per-user and idempotent. On the
  `account.create`/`update` hook, if an `accounts` row already exists for `account.userId`, do
  NOT write a second one — the existing anchor stands, its `provider`/`login`/`avatar` stamp
  unchanged (the primary provider's). Only write the anchor when none exists for that user.
  Org-scope capture still runs per the existing github/accessToken guards.
- **better-auth config**: add `account: { accountLinking: { enabled: true, trustedProviders:
  ["github", "google"], allowDifferentEmails: true } }` to `makeAuth`. `linkSocial` is exposed
  by the better-auth handler at `/api/auth/link-social` (already mounted under the `/api/auth`
  catch-all — no new route to register for flow A).
- **Absorb, triggered by a link collision** (flow B). `linkSocial` already refuses to attach a
  provider whose `account` row belongs to a different `user` (better-auth returns an
  account-already-linked error). We intercept that one case with a new credentialed route,
  `POST /api/account/absorb`, called by the SPA when Connect's OAuth resolves to an existing
  other account. Both accounts are already authenticated (the caller's session = one; the just-
  completed OAuth = the other), so no separate token is needed. Steps, in one transaction:
  1. Identify the two accounts: `current` (the caller's session) and `other` (the user owning the
     just-OAuth'd provider account). Determine which is **fresh** (the five-part gate below).
  2. If **neither** is fresh → 409 with the merge-not-supported message. If **both** are fresh,
     treat `current` as the survivor.
  3. Let `keep` = the data-bearing (or chosen) account, `drop` = the fresh one. Re-point `drop`'s
     better-auth `account` row(s) `userId` → `keep`'s `user.id`.
  4. Delete the `drop` better-auth `user` row and its legacy `accounts` anchor (orphaned; it had
     no gems/handle/stars/reviews/groups, so nothing cascades away).
  5. Return `keep`'s session (the caller lands on the surviving account with both providers).
  Add to `originGuard`'s exempt prefixes (credentialed cross-origin, like `/api/handle`).

  **The load-bearing mechanic to nail first (plan's first task):** how does `absorb` learn the
  identity of `other` from an OAuth that better-auth *rejected*? Link-social's OAuth resolves a
  provider identity, then refuses because a row already exists. The plan must establish the seam
  that captures that resolved (providerId, accountId) — most likely a better-auth account/link
  hook or the OAuth-callback error path — and hand it to `absorb`, which maps it to the owning
  `user` via the `account` table. `absorb` must NEVER trust a client-supplied account id for
  `other` (that would let a caller name any victim account); the identity must come from the
  server-verified OAuth. Prove this seam exists before building the SPA flow.
- **`connectedProviders(accountId)`** read helper: lists a user's better-auth `account` rows
  (provider ids) so the settings surface can render "connected / connect."

### Marketplace SPA

- **`/account` settings page** (new route in `Router.tsx`, new `pages/Account.tsx`): shown to a
  signed-in user; lists connected providers and renders **Connect GitHub / Connect Google** for
  the missing ones. Connect triggers the flow (link-social for the simple case; the
  absorb flow when the chosen provider resolves to a fresh separate account).
- **Nav**: a link to `/account` in the authed chip area (near "Sign out").
- **Handle-claim nudge**: `HandleClaim` (or the Publish gate) shows the "belongs to another
  account — connect it" pointer to `/account` when a claim 409s specifically because the handle
  is owned by another *account* (vs a reserved org name). *(If the API cannot distinguish those
  two 409 causes without a change, keep the generic 409 message and add the nudge as a static
  line — decided at plan time.)*

## Data flow

```
FLOW A — connect a provider you've never separately used
  /account (signed into acct X) ── "Connect Google" ──▶ /api/auth/link-social {provider:google}
     └▶ Google OAuth ──▶ better-auth adds an `account` row (userId = X) ──▶ account.create hook
        └▶ anchorAndScopes: anchor for X already exists ⇒ NO second row (the fix). Linked. Done.

FLOW B — Connect's OAuth resolves to an existing OTHER account (one side is fresh)
  /account (signed into acct `current`) ── "Connect <provider>" ──▶ /api/auth/link-social
     └▶ provider OAuth ──▶ that identity already belongs to acct `other` ──▶ link-social refuses
        └▶ SPA calls POST /api/account/absorb
           ├▶ fresh?  neither → 409 merge-not-supported (deferred C)
           │          else keep = data-bearing (or `current` if both fresh), drop = the fresh one
           ├▶ re-point `drop`'s better-auth `account` row(s) userId → `keep`
           ├▶ delete user `drop` + its accounts anchor
           └▶ return `keep`'s session ── caller lands on `keep`, both providers connected
  (Works whichever side you start from: Connect Google from GitHub, or Connect GitHub from a
   fresh Google account — the fresh side is always the one dropped.)

DEFERRED (C) — both accounts carry data ⇒ absorb returns 409, the merge-not-supported message
```

## Testing

- **Anchor fix (prove first):** linking a second provider to an existing user no longer throws;
  exactly one `accounts` anchor row per `user.id` after linking; the anchor's `provider`/`login`
  stamp is unchanged (stays the primary provider's). Discriminating: without the fix, the second
  `account.create` throws a duplicate-PK.
- **Flow A:** `linkSocial` for a second provider attaches an `account` row to the same `user.id`;
  `connectedProviders` then lists both; authorization (owns gems via `accounts.id`) is unchanged.
- **Flow B happy path:** absorbing a fresh account re-points its provider to the target, deletes
  the empty user + anchor, and the target now has both providers; the caller ends on the target
  session.
- **Flow B freshness gate (the C-guard, proven discriminating):** absorb is REFUSED (409,
  merge-not-supported) when the account-to-discard has a handle; likewise when it owns a gem;
  likewise a star / review / group membership. Each of the five is its own case.
- **Security:** absorb requires an authenticated caller session (one account) plus a just-
  completed OAuth for the other provider (better-auth's linkSocial/OAuth state) — a call with no
  session, or referencing a provider account the caller did not just authenticate, is rejected.
  Neither side can be asserted by client-supplied ids alone.
- **`allowDifferentEmails`:** a GitHub account (email A) and a Google account (email B) link
  successfully.
- **SPA:** `/account` lists connected vs connectable providers; Connect triggers the right flow;
  the handle-claim nudge appears on an ownership 409.

## Non-goals

- **Merging two data-bearing accounts (C).** The hard case — which handle wins, gem reassignment
  across `owner_account_id`, deleting a non-empty account and reconciling ten FK tables. Its own
  slice, behind an adversarial review of the destructive logic.
- **Unlinking / removing a connected provider.** A later addition; needs its own "you can't
  remove your last provider" guard.
- **Slack, X, passkey.** Separate provider/method slices.
