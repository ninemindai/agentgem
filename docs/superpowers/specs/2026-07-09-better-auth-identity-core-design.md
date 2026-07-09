# better-auth as AgentGem's identity core — Phase 1

**Date:** 2026-07-09
**Status:** Design approved, implementation plan pending
**Evaluation:** the prior better-auth-vs-hand-rolled assessment that motivated this (kept in the session scratchpad, not committed).

## Problem

AgentGem's auth is entirely hand-rolled: OAuth, sessions, cookies, and account
storage on `node:crypto` + `fetch` + Drizzle, with no framework. There is only one
login provider (GitHub), and adding a second is expensive because there is no `user`
concept — the `accounts` row *is* the identity, and account **linking** (many
providers → one person) would have to be hand-built.

We want non-GitHub users to be able to sign up and, eventually, own a handle and
publish — real reach, not just "connect a second account to an existing GitHub user."
That requires an identity core that owns `user` / `account` / `session` and makes
linking a solved feature. [better-auth](https://github.com/better-auth/better-auth)
is that core: TypeScript-native, self-hostable, Drizzle-adapter, social + passkey +
bearer plugins, and first-class account linking. Critically, its `user` + `account`
split **is** the `accounts → accounts + account_identities` split we had already
scoped by hand.

## The three-phase decomposition

This is multi-subsystem. It splits into three specs; **this document is Phase 1 only.**

1. **Phase 1 (this spec) — better-auth becomes the identity core, GitHub folds in,
   zero user-visible feature change.** Existing GitHub users still sign in with
   GitHub exactly as before; underneath, identity, sessions, and accounts are now
   better-auth's.
2. **Phase 2 (sequel) — providers + linking.** Google / Slack / X social plugins,
   passkey, and `linkSocial`. A GitHub user can link Google; a non-GitHub user can
   sign up.
3. **Phase 3 (sequel) — the ownership re-key.** Move publishing / profiles /
   org-gating off the GitHub `login` string onto `user.id` / handle, so a
   non-GitHub user is a first-class owner. This is the large data migration and the
   actual reach payoff.

Everything downstream depends on Phase 1's identity core, which is why it is first.

## Design decisions (settled during brainstorming)

- **Intent = reach.** better-auth owns the identity core; GitHub is one provider
  under it, not a parallel system.
- **Integration depth = full replace.** GitHub *web* login becomes better-auth's
  `github` social provider; the hand-rolled web OAuth is deleted. (The CLI device
  grant is not a better-auth flow — see below — so it stays custom.)
- **Session cutover = force re-auth.** No compatibility shim. `web_sessions` is
  retired at cutover; better-auth sessions are authoritative from day one.
- **Identity preservation = `accounts.id` becomes `user.id`.** The one-time backfill
  writes each `accounts` row as a `user` row with the *same uuid*, so every existing
  FK stays valid and a re-logging-in user reconnects to all their data.
- **Schema authority = `ensureSchema`.** better-auth's tables are transcribed into
  the existing hand-rolled idempotent DDL; the Drizzle adapter runs in existing-tables
  mode. No second migration tool. The PGlite test harness is unchanged.
- **Mount = the hono shim on the real Express app.** Resolved, not a spike (below).

## Architecture

```
                         ┌──────────────────────────────────────────┐
   browser  ──GitHub──►  │  better-auth  /api/auth/*                 │
   (web login)           │    github social provider                │
                         │    after-sign-in hook → account_scopes   │
   CLI  ──device grant─► │  ── mounts on RestServer.expressApp ──    │
   (agentgem bind)       │     via getRequestListener(auth.handler)  │
        │                └──────────────────────────────────────────┘
        │  ed25519 signed proof                    │ owns tables:
        ▼                                          ▼
   /api/aggregator/bind  ──mints──►  better-auth  user · account · session
   (custom, kept)                    (Drizzle adapter, existing-tables mode)
                                          │
                                          │  user.id == old accounts.id
                                          ▼
        stars · reviews · usage_days · account_scopes · groups · group_members
        (every FK unchanged — no re-key in Phase 1)
```

better-auth owns `user` / `account` / `session` (+ `verification`) over the existing
Postgres via the Drizzle adapter. GitHub web login is its `github` social provider.
The CLI device-flow and the SSO handoff stay custom but mint better-auth sessions.
`web_sessions` is retired.

## What changes, what's deleted, what's kept

**Deleted (the hand-rolled web OAuth + session mint):**
- `src/auth/install.ts` — `loginHandler`, `callbackHandler`, `githubExchangeCode`,
  and route registration for `/api/auth/github/login` + `/callback`.
- `src/auth/state.ts` — the HMAC OAuth-state signer (better-auth owns CSRF state).
- `web_sessions` table and `webAuth.ts`'s session *mint* — `generateSessionToken` /
  `createSession` (replaced by better-auth session creation) and `deleteSession`
  (replaced by better-auth sign-out).

**Re-implemented, NOT deleted — the session-resolution seam:** `resolveSession(token)
→ { login, avatarUrl, accountId }` is called across the whole app (catalog, usage,
orgs, publish, and the merged groups routes). It stays as the seam; only its internals
change — from a `web_sessions` sha256 lookup to a better-auth session lookup
(`auth.api.getSession` given the token as a bearer header), mapping better-auth's
`user` back to `{ login, avatarUrl, accountId }`. Every downstream consumer is
untouched, which is what makes "full replace underneath, zero behavior change on top"
real. `accountId` maps to `user.id`; `avatarUrl` to `user.image`; **`login` to a
`login` field on the user model** — see below.

**Kept, re-pointed to mint a better-auth session (GitHub's device grant is not a
better-auth flow, so this code has no library replacement):**
- `src/bind/*` and `packages/aggregator/src/binding.ts` — the ed25519 device-flow
  bind. `recordBinding` still verifies key possession + freshness + the live GitHub
  token and upserts identity; its final step changes from `createSession`
  (`web_sessions`) to **better-auth server-side session creation**, returned as the
  token written to `~/.agentgem/session.json`.
- The 60s single-use SSO handoff (`handoff_codes`, `/api/auth/handoff/start` +
  redeem). Mechanism unchanged; redeem mints a better-auth session cookie.

**Kept as a better-auth hook:**
- The `read:user read:org` scope and `fetchOrgMemberships` → `setAccountScopes`
  capture. Today the callback does this; it moves into a better-auth after-sign-in /
  account-create hook so org gating and the groups feature keep working unchanged.
  `accountVerifier.ts`'s `fetchOrgMemberships` is reused verbatim. The hook needs the
  GitHub **access token** to make the `/user/memberships/orgs` call; better-auth
  stores the provider access token on the `account` row, so the hook reads it from
  there. (That the access token is available in the hook context is worth confirming
  in the same pass as the spikes — if not, the capture runs as a follow-up read on
  the stored token rather than inline in the hook.)

**Enabled:**
- The **bearer plugin** — the CLI presents the session token as
  `Authorization: Bearer`, preserving the Bearer≡cookie duality.
- The **github social provider** with `scope: ["read:user", "read:org"]` and the
  existing `AGENTGEM_GITHUB_CLIENT_ID` / `AGENTGEM_GITHUB_CLIENT_SECRET`.
- A **`login` additional field on the user model** (`user: { additionalFields:
  { login: { type: "string" } } }`). AgentGem's ownership, profiles, and org-gating
  key on the GitHub login string; the `resolveSession` shim returns it from here, and
  it is the field Phase 3 later re-keys away from. The migration populates it from
  `accounts.login`; the after-sign-in hook keeps it fresh from the GitHub profile.

## Mounting better-auth in `@agentback` (resolved)

`server` is `@agentback/rest`'s `RestServer` (`agentgem/src/index.ts:157`).
`server.expressApp` is a real `express.Application` (`rest.server.ts:1392`). better-auth
exposes one web-standard handler, `auth.handler(Request): Promise<Response>`. Mount:

```ts
import { getRequestListener } from "@hono/node-server"; // already a dep via rest/host/node.ts
server.expressApp.all("/api/auth/*", getRequestListener((req) => auth.handler(req)));
```

`getRequestListener` is the in-repo Fetch→Node adapter already used at
`packages/rest/src/host/node.ts:14`. The precedent for an external handler owning a
prefix across methods is `mountMcpHttp` (`packages/mcp-http/src/index.ts:270`).

**The one documented gotcha:** AgentGem configures a global `express.json()` body
parser (`src/index.ts:116`) mounted ahead of every route, which drains the request
body — so better-auth's `request.json()` would see an empty body. Fix (either):
1. Rebuild the Web `Request` body from the already-parsed `req.body` before handing
   it to `auth.handler` — the repo already has this exact re-serialization in
   `webRequestForWebDispatch()` (`rest.server.ts:1599-1616`); or
2. Configure `bodyParser` to skip `/api/auth/*` (note: other `install*` routes read
   `req.body`, so a blanket `bodyParser: false` would require each to add its own
   `express.json()`).

Approach 1 is preferred — it is local to the auth mount and touches nothing else.

The `@agentback/authentication*` packages are opt-in per-controller strategies; they
impose nothing on raw routes mounted on `expressApp`, so better-auth owning
`/api/auth/*` does not conflict.

## Data flow

**Web login:** browser → `/api/auth/sign-in/social` (github) → GitHub → better-auth
callback → user+account upserted, keyed on the GitHub numeric id (reconnecting a
migrated user) → after-sign-in hook captures org memberships into `account_scopes` →
better-auth session cookie set. Observable behavior: the same one-click GitHub login,
a new callback URL.

**CLI bind:** `agentgem bind` → GitHub device grant → ed25519-signed proof to
`/api/aggregator/bind` → `recordBinding` verifies key + freshness + GitHub token,
upserts user+account, captures scopes, and mints a better-auth session returned as
the token in `~/.agentgem/session.json`.

**SSO handoff:** desktop mints a `handoff_codes` row (bearer-authed), opens the
redeem URL; redeem swaps the single-use code for a fresh better-auth session cookie.

## The migration (one-time backfill)

Runs once, in `ensureSchema`-adjacent migration code, idempotent:

1. For each `accounts` row: insert a `user` row with **`id = accounts.id`** (same
   uuid), `name`/handle and image from `login`/`avatar_url`, email null (GitHub email
   is not currently captured; Phase 2 addresses email for linking).
2. Insert an `account` row: `userId = accounts.id`, `providerId = 'github'`,
   `accountId = accounts.provider_account_id` (the GitHub numeric id).
3. Leave every existing FK (`stars`, `reviews`, `usage_days`, `account_scopes`,
   `handoff_codes`, and — once merged — `groups`/`group_members`/`group_invites`)
   pointing at the unchanged id.
4. At cutover, drop/ignore `web_sessions`. The next request re-authenticates.

Because the user id is preserved, re-authentication is a login, not a data reset:
GitHub re-login upserts onto the pre-migrated `account` row by `providerAccountId`.

## Spikes to verify before writing the implementation plan

Two remain (mounting is resolved above). Each is a throwaway verification; a failure
reshapes the design, so they gate the plan.

1. **Programmatic session creation.** The device-flow and SSO handoff must mint a
   session for a *known* user without a browser OAuth redirect. Verify better-auth's
   server API creates a session for a given `user.id` and yields a token the bearer
   plugin accepts on a subsequent request.
2. **Externally-supplied `user.id` + upsert-on-relogin.** Insert a `user` row with a
   chosen uuid (simulating the migration), then run a GitHub sign-in for that GitHub
   id and confirm better-auth **links to the existing user** (matches on
   `providerId`+`accountId`) rather than creating a duplicate user.

## Error handling

- **Body-parser empty-body** (the gotcha above) — mitigated by the request-rebuild;
  a test asserts a `POST /api/auth/*` with a JSON body reaches better-auth intact.
- **Org-capture failure** — `fetchOrgMemberships` is already failure-tolerant
  (returns `[]`); the after-sign-in hook must not fail the login if the GitHub org
  call errors, matching today's behavior.
- **Migration re-run** — the backfill is idempotent (insert-if-not-exists on
  `user.id` and on `(providerId, accountId)`), safe to run repeatedly.
- **Bind against a not-yet-migrated account** — `recordBinding` already upserts, so a
  first-ever bind and a post-migration bind take the same path.

## Testing

PGlite builds better-auth's tables via `ensureSchema` (harness unchanged). Coverage:
- the backfill: `accounts` → `user`+`account`, id preserved, a representative FK
  (e.g. a `stars` row) still resolves through the new `user`;
- web login mounts and returns a session, and the after-sign-in hook writes
  `account_scopes`;
- the device-flow `recordBinding` mints a session token that the bearer plugin
  accepts on a following request (this exercises spike 1 as a real test);
- GitHub re-login onto a pre-inserted `user` links rather than duplicates (spike 2);
- the body-parser rebuild delivers a non-empty JSON body to `auth.handler`.

Rollout: a staging cutover (drop `web_sessions`, force re-auth, re-bind a CLI) before
production, since the forced re-auth is a one-time user-visible event.

## Security note: session token storage

better-auth's `session` table stores the **raw** session token (verified by probe against 1.6.23),
whereas the retired `web_sessions` table stored only `sha256(token)` — a DB leak of `web_sessions`
alone could not mint a session, but a leak of better-auth's `session` table can.

This is an **accepted, deliberate trade at Plan 1b cutover**, not a silent regression:

- Session TTL is unchanged (30 days, same as `web_sessions` before it).
- The aggregator's Postgres instance is a single trust boundary that already holds every other
  credential this system has (GitHub OAuth client secret, API keys' hashes, org-scope grants) — a
  DB compromise serious enough to exfiltrate the `session` table is already game-over for the
  aggregator, hashed-or-not.
- better-auth does not offer a first-class "hash sessions at rest" option the way it does for the
  one-time-token plugin (`storeToken: "hashed"`, applied in `betterAuth.ts` for the SSO handoff
  exchange token — see below); hand-rolling one would mean re-deriving the library's own session
  lookup, which reintroduces the maintenance burden this migration exists to remove.

Where better-auth *does* expose a hash-at-rest knob, it is used: the SSO handoff's one-time-token
plugin is configured with `storeToken: "hashed"` so its short-lived (1-minute) exchange token is not
persisted in plaintext either.

## Explicitly out of scope (Phase 1)

- Google / Slack / X providers, passkey, and `linkSocial` — **Phase 2**. Slack/X PKCE
  specifics belong there.
- The `login`-string ownership re-key across publishing / profiles / org-gating —
  **Phase 3**. Phase 1 preserves login-string keying by preserving the user id.
- Email capture / verification — begins in Phase 2, where linking needs a verified
  email as the join key.
- The groups work (PR #247) — independent; Phase 1 does not touch it beyond the FK
  preservation that keeps `group_members.account_id` valid.
