# Desktop ⇄ Web Session Bridge — Design

**Status:** design approved (eng-reviewed), implementing
**Date:** 2026-07-04

## Review outcome (supersedes conflicting detail below)

- **No separate `/exchange`.** Fold session-mint into the existing `/bind`
  (`recordBinding`): after saving the binding it captures the account id
  `upsertAccount` already returns, calls `createSession`, and returns
  `{ ...bindResult, sessionToken, expiresAt }`. One GitHub verify per connect.
- **Bearer ≡ web session.** `Authorization: Bearer <sessionToken>` is honored
  *exactly where the session cookie is* (via a shared `resolveSessionFrom(cookie
  ∥ bearer)`), adding no new authorization surface. Pubkey-signature endpoints
  (publish/catalog) are untouched.
- **Marketplace needs zero changes** — the handoff redeem is an API route that
  Set-Cookies + 302s; `app.agentgem.ai` already reads the cookie via `/api/auth/me`.
- **"Connected" indicator** is driven by the session (live credential); expiry →
  clear + prompt reconnect. `binding.json` stays as verified-publishing provenance.
- **Guards:** redeem validates `return` against `webOrigins` (open-redirect); `/bind`
  + `/handoff/start` inherit the anon per-IP limiter; `handoff_codes` pruned on read + swept.
- Unchanged from approval: one-time-code handoff; 30-day session TTL, reconnect-on-expiry.

## Problem

After a user connects GitHub in the local desktop app (device flow → `~/.agentgem`
binding), that identity is trapped locally. To use `app.agentgem.ai` they must log in
again through the web OAuth flow, and the local app cannot make authenticated calls to
`api.agentgem.ai`. We want the local GitHub connection to yield a **single first-party
credential** that both `api.agentgem.ai` and `app.agentgem.ai` honor.

## Non-goals

- Not caching the raw GitHub access token on disk (it's used once, then discarded).
- Not replacing the pubkey↔account bind (`recordBinding`) — that stays, and is orthogonal:
  it exists for *verified publishing* (attestations signed by the local ed25519 key). This
  feature is about *auth/session*.
- Not introducing JWT infrastructure. We reuse the existing opaque `webSessions` token.

## Key insight

`app.agentgem.ai` already mints an opaque, DB-backed **`webSessions`** token and honors it
as its login cookie (`src/auth/install.ts`, `packages/aggregator/src/webAuth.ts`). "One
credential both surfaces honor" is achieved by: (1) letting the local app **obtain** such a
token via an exchange endpoint, and (2) letting the **API** also accept it as a Bearer. No
new token type is needed.

## Architecture & data flow

```
device flow (local, existing) ──▶ GitHub access token
        │
        ▼
POST api.agentgem.ai/api/auth/exchange { token }
   verify(GitHubVerifier) → upsertAccount → setAccountScopes → createSession(webSessions)
        │  returns { sessionToken, expiresAt, login, avatarUrl }
        ▼
   local app stores ~/.agentgem/session.json (0600)
        │
        ├──▶ API:  Authorization: Bearer <sessionToken>  → resolveSession() → acts as @you
        └──▶ WEB:  open api.agentgem.ai/api/auth/github/handoff?code=<one-time>&return=<webOrigin>
                   → API Set-Cookie(session) → 302 to webOrigin → app.agentgem.ai is logged in
```

## Components

### 1. `POST /api/auth/exchange` (aggregator)

New raw route alongside the existing auth routes in `src/auth/install.ts` (registered in
`installAuth`). It is the `callbackHandler` minus the OAuth-code step:

- Body: `{ token: string }` — a GitHub access token the caller already holds.
- `acct = verifier.verify(token)` (live `GitHubVerifier`); on failure → `401 { error: "invalid_token" }`.
- `row = upsertAccount(db, { provider, accountId, login, avatarUrl })`.
- Best-effort `fetchOrgs` + `setAccountScopes(db, row.id, [login, ...orgs])` (never fails the exchange).
- `{ token: sessionToken } = generateSessionToken()`; `createSession(db, row.id, sessionToken, sessionTtlMs)`.
- Respond JSON `{ sessionToken, expiresAt, login, avatarUrl }`. **No Set-Cookie** (this is for a non-browser client).
- Reuses the existing `AuthDeps` (db, verifier, fetchOrgs, config). Enabled only when web auth is configured
  (same guard as `installAuth`).
- **Standalone**: called by the local connect flow right after the device-flow poll yields the GitHub
  token. It is independent of `recordBinding` (the pubkey bind) — the connect flow holds one GitHub token
  and uses it for both calls; neither depends on the other.

### 2. API Bearer auth (gating)

Extend the aggregator gating so an `Authorization: Bearer <sessionToken>` header is resolved
via `resolveSession(db, token)` to an authenticated identity `{ accountId, login }`. This sits
alongside the existing api-key identity path; a request may present either. Requests with a
valid session bearer are treated as that account for authenticated actions (e.g. publish,
stars). Absent/invalid bearer falls through to the current anonymous/api-key behavior — this
change only *adds* an accepted credential, it does not tighten any existing endpoint.

### 3. Web SSO handoff (one-time code)

The session token must never appear in a URL. Flow:

- **Mint:** the local app requests a one-time handoff code bound to its session:
  `POST /api/auth/handoff/start` with `Authorization: Bearer <sessionToken>` →
  `resolveSession` → store a single-use code → `{ code, expiresAt }` (TTL 60s).
  Storage: a new `handoff_codes` table `(code_hash pk, session_token_hash, expires_at)` — durable
  across aggregator restarts and consistent with the sha256-hash-only pattern in `webAuth.ts`. Only
  the code's hash is stored; the raw code lives only in the local app and the redeem URL.
- **Redeem:** local app opens the **API** route
  `api.agentgem.ai/api/auth/github/handoff?code=<code>&return=<webOrigin>` in the system browser.
  The handler looks up `sha256(code)` (single-use: delete on read), and on a valid, unexpired code
  it `Set-Cookie`s the bound session token (domain = `cookieDomain`, exactly like `callbackHandler`)
  then `302 → return` (return must be an allowlisted web origin). Invalid/expired/used →
  `302 → <firstWebOrigin>?auth_error=handoff`. Setting the cookie from the API host (whose cookie
  domain covers `app.agentgem.ai`) is the same mechanism the OAuth callback already uses.
- Because the redeemed cookie value *is* the same `webSessions` token, the rest of the web app
  works unchanged (`/api/auth/me`, logout, stars all already use `resolveSession`).

### 4. Local session module (desktop/console)

- `~/.agentgem/session.json` (mode 0600): `{ sessionToken, expiresAt, login, avatarUrl }`.
- Written by the connect flow: after the device-flow poll yields the GitHub token, the app calls
  `/api/auth/exchange` (in addition to, or folded next to, the existing bind) and persists the result.
- API client attaches `Authorization: Bearer <sessionToken>` when a live session exists.
- **"Open on the web ↗"** action: `POST /api/auth/handoff/start` (Bearer) → open
  `api.agentgem.ai/api/auth/github/handoff?code=…&return=<webOrigin>` in the system browser (via the
  `setWindowOpenHandler` added earlier); the API redeems the code, sets the cookie, and 302s to the app.
- Expiry: if `resolveSession` 401s or `expiresAt` has passed, clear `session.json` and prompt a
  reconnect (re-run device flow). No silent refresh — device flow is cheap and explicit.

## Error handling

- `exchange`: invalid GitHub token → 401; org fetch failure → logged, exchange still succeeds
  with login-only scope (mirrors `callbackHandler`).
- `handoff/start`: no/invalid bearer → 401.
- `handoff redeem`: unknown/expired/already-used code → 302 with `?auth_error=handoff`; never 500 on a bad code.
- Local: any 401 from the API clears the stored session and surfaces "reconnect GitHub".

## Testing

- `exchange`: valid token → returns a token that `resolveSession` accepts; invalid token → 401,
  no session row; scopes captured.
- Bearer gating: request with a valid session bearer is authenticated as the account; invalid/absent
  bearer is unauthenticated; existing api-key path unaffected.
- Handoff: `start` requires a valid bearer; redeem is single-use (second use fails) and TTL-bounded;
  redeem sets the session cookie and 302s to an allowlisted return only.
- Local session module: persists 0600; attaches Bearer only when a live session exists; clears on 401.

## Rollout / deploy

Server changes (exchange, gating bearer, handoff routes) ship on **`api.agentgem.ai`**; the web
redeem route + "Open on the web" wiring ship on the **marketplace/app**. Like the self-registering
bind, this is **deploy-gated** — it takes effect once both are redeployed. Local-aggregator override
(`AGENTGEM_AGGREGATOR_URL`) can validate the exchange + bearer end-to-end before deploy.

## Security notes

- Only the sha256 of session/handoff tokens is persisted (matches `webAuth.ts`), so a DB leak
  cannot mint sessions.
- One-time codes are single-use + 60s TTL, keeping the bearer out of URLs, history, and referrers.
- The exchange verifies the GitHub token live every time; a forged token yields no session.
- Session TTL matches the web's `sessionTtlMs` (30 days today); revocation = delete the row (logout
  already does this).
