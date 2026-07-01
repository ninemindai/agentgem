# Marketplace Web Sign-In (M2-A) — Design

**Date:** 2026-06-29
**Status:** Approved (brainstorming) — ready for implementation plan

## Goal

Let a visitor "Sign in with GitHub" on the marketplace (`app.agentgem.ai`), obtain a session, and have the SPA know who they are. This is the **identity foundation** the later M2 slices (starring, reviews) build on. It reuses the existing GitHub OAuth app, `accountVerifier`, and the aggregator's Postgres. No starring yet.

## Context

M2 ("accounts + starring + reviews") is three stacked sub-projects with a hard dependency chain (starring needs web identity; reviews need both). This spec is **slice A — web sign-in only**.

What already exists (and is reused):
- `@agentgem/aggregator/src/accountVerifier.ts` — `GitHubVerifier.verify(token) → { provider, accountId, login }` (hits `api.github.com/user`; a fake is injectable for tests).
- The GitHub OAuth app (`AGENTGEM_GITHUB_CLIENT_ID`), currently used by the **device flow** (`agentgem bind`, CLI). The web flow is the **authorization-code flow** on the *same* OAuth app — it just needs a callback URL registered + the client **secret**.
- The aggregator's Postgres (`@agentgem/aggregator/src/schema.ts`, drizzle `pgTable` + an `ensureSchema`), and `localDb`/`testDb` for embedded/test runs.
- Controllers live in `src/*.controller.ts` (root); `originGuard.ts` (root) owns the cross-site guard + CORS.

What's new ground: there is **no cookie/session handling anywhere** today (all auth is signature/token based). This slice introduces the first browser session.

## Architecture decisions (settled in brainstorming)

- **Web app shape unchanged:** the marketplace stays a static React SPA on the CDN; the existing `api.agentgem.ai` API gains the OAuth routes + session. No SSR / server-backed migration.
- **Session transport = parent-domain cookie.** `app.agentgem.ai` and `api.agentgem.ai` share the registrable domain `agentgem.ai`, so a cookie scoped to `Domain=.agentgem.ai` is **first-party** (same-site, cross-origin). `HttpOnly; Secure; SameSite=Lax` — XSS-safe, sent on the SPA's credentialed fetch.
- **Accepted dev caveat:** the parent-domain cookie only round-trips on the real `*.agentgem.ai` domains — **not** on the raw `*.onrender.com` URLs or `localhost`. Sign-in is verified on the live domains; local-dev/onrender auth is a deferred nicety (not built here). Non-auth marketplace features remain fully usable signed-out everywhere.
- **Scope = `read:user`** (login identity only; never repo access).

## Backend (API, `api.agentgem.ai`)

### Session + account store — `@agentgem/aggregator`

Two new drizzle tables in `schema.ts` (+ `ensureSchema` DDL), with pure store functions (testable against `testDb`):
- `accounts`: `id uuid pk`, `provider text`, `provider_account_id text`, `login text`, `avatar_url text null`, `created_at timestamptz`. **Unique (provider, provider_account_id).**
- `web_sessions`: `id uuid pk`, `token_hash text unique`, `account_id uuid fk→accounts`, `created_at`, `expires_at timestamptz`.
- Store functions: `upsertAccount(db, VerifiedAccount & {avatarUrl?})` → account row; `createSession(db, accountId, token, ttl)` (stores `sha256(token)`, not the token); `resolveSession(db, token)` → account or null (checks `expires_at`); `deleteSession(db, token)`.
- The cookie value is a random opaque token (e.g. 32 random bytes, base64url); only its hash is persisted, so a DB leak cannot mint sessions.

### OAuth + session endpoints — a new `src/auth.controller.ts`

Pure helpers (state sign/verify, the GitHub token exchange) are injected so the controller tests run with no live GitHub.

- `GET /api/auth/github/login?return=<spa-url>` — validate `return` against the `AGENTGEM_WEB_ORIGINS` allowlist (reject otherwise); mint a signed, short-lived `state` carrying the return URL; 302 to GitHub's `authorize` URL (`client_id`, `redirect_uri = <api>/api/auth/github/callback`, `scope=read:user`, `state`).
- `GET /api/auth/github/callback?code&state` — verify `state` (signature + freshness); exchange `code`→token (`POST github.com/login/oauth/access_token` with `client_id` + **`AGENTGEM_GITHUB_CLIENT_SECRET`**) via an injected `exchangeCode` fn; `accountVerifier.verify(token)`; `upsertAccount`; `createSession`; `Set-Cookie` (the parent-domain session cookie); 302 back to the validated `return` URL. Any failure → 302 to the SPA with an `?auth_error=...` (never a raw 500 to the browser).
- `GET /api/auth/me` — read the session cookie → `resolveSession` → `{ login, avatarUrl }` or `{ authenticated: false }`. (Cookie absent/expired → the latter, 200.)
- `POST /api/auth/logout` — `deleteSession` + clear the cookie; `{ ok: true }`.

### CORS-with-credentials — `originGuard.ts`

The public reads keep `Access-Control-Allow-Origin: *` (no credentials). The **auth** routes need the credentialed variant (wildcard is illegal with credentials):
- For requests whose `Origin` is in `AGENTGEM_WEB_ORIGINS` hitting an `/api/auth/*` path: echo `Access-Control-Allow-Origin: <that origin>`, `Access-Control-Allow-Credentials: true`, and handle the `OPTIONS` preflight (`Allow-Methods: GET, POST, OPTIONS`, `Allow-Headers: content-type`). A non-allowlisted origin gets no CORS headers (browser blocks it).
- The cross-site CSRF block must not reject these (they're allowlisted, credentialed auth calls). The `state` param is the OAuth CSRF defense for the redirect leg; the cookie is `SameSite=Lax`.

### New env (hosted `agentgem` service)
- `AGENTGEM_GITHUB_CLIENT_SECRET` — the OAuth app's secret (web flow). `AGENTGEM_GITHUB_CLIENT_ID` already exists.
- `AGENTGEM_WEB_ORIGINS` — comma-list, e.g. `https://app.agentgem.ai` (redirect-allowlist + credentialed-CORS allowlist).
- `AGENTGEM_SESSION_COOKIE_DOMAIN` — `.agentgem.ai` (the cookie `Domain`). `AGENTGEM_PUBLIC_BASE` (or reuse existing) for the callback `redirect_uri`. A session-signing/`state` secret (`AGENTGEM_SESSION_SECRET`).
- GitHub OAuth app: register the callback URL `https://api.agentgem.ai/api/auth/github/callback`.

## Frontend (marketplace SPA — unchanged shape)

- **`auth` API client** (`src/auth.ts`): `getMe(): Promise<{login,avatarUrl}|null>` (GET `/api/auth/me`, `credentials:'include'`), `logout()` (POST, `credentials:'include'`), `loginUrl(returnTo)` (just the API URL string `<base>/api/auth/github/login?return=<encoded>` — a plain link, no fetch).
- **Auth state:** `App.tsx` loads `getMe()` once on mount (a small `useAuth`-style hook or local state); the brand header renders **"Sign in with GitHub"** (an `<a href={loginUrl(currentUrl)}>` — a real navigation, NOT intercepted by the SPA link-handler, since it's an external `/api/...` on a different origin) when signed out, and **avatar + login + "Sign out"** (button → `logout()` then reset) when signed in.
- On return from OAuth the SPA lands back on its URL with the cookie already set; it just re-runs `getMe()`. (Strip a `?auth_error` param into a small inline notice if present.)
- `credentials:'include'` is used only for the auth calls here (starring will reuse the pattern).

## Data flow

Sign in: SPA link → `api.agentgem.ai/api/auth/github/login` → GitHub → `…/callback` (exchange + verify + upsert + session + Set-Cookie) → 302 back to `app.agentgem.ai`. SPA `getMe()` (cookie sent) → identity. Sign out: `POST /api/auth/logout` clears it.

## Out of scope (later slices / deferred)

- **Starring / reviews** (M2-B / M2-C) — this slice only establishes identity + session; no per-user writes yet.
- **Local-dev / onrender sign-in** — parent-domain cookie limitation accepted; a dev fallback (bearer token) is deferred.
- Refresh tokens / sliding expiry (a fixed TTL is fine); multi-provider (GitHub only); linking a web account to the CLI producer binding (the two identity systems stay separate for now).

## Testing

- **Backend** (`@agentgem/aggregator` store, compiled-dist vitest against `testDb`): `upsertAccount` insert + idempotent on the unique key; `createSession`/`resolveSession` round-trip (stores hash not token; resolves to account; **expired → null**); `deleteSession`.
- **Auth controller** (inject fake `exchangeCode` + fake `accountVerifier`, no live GitHub): `login` rejects an off-allowlist `return`, else 302s to GitHub with a `state`; `callback` with a valid state exchanges→verifies→upserts→sets the cookie→302s to the return URL; bad/expired state → `?auth_error` redirect, no session; `me` resolves a cookie→identity and returns unauthenticated without one; `logout` clears.
- **originGuard:** an allowlisted Origin on `/api/auth/me` gets `Allow-Origin: <origin>` + `Allow-Credentials: true`; a non-allowlisted origin gets none; the public-read paths still get `*` (unchanged); preflight OPTIONS answered.
- **Frontend** (marketplace vitest+jsdom): header shows "Sign in with GitHub" with the correct `loginUrl` href when `getMe`→null; shows avatar+login+"Sign out" when authenticated; "Sign out" calls `logout` (stubbed) and resets to signed-out; `getMe` uses `credentials:'include'`.
- Gates: `@agentgem/aggregator` + auth-controller suites (compiled dist); `pnpm --filter @agentgem/marketplace test|typecheck|build`.

## Risks

- **Cross-site cookie correctness** is the highest-risk area and is only fully verifiable on the live `*.agentgem.ai` domains — the unit tests assert the `Set-Cookie` attributes (Domain/HttpOnly/Secure/SameSite) and the CORS headers, but the real round-trip is a post-deploy manual smoke. Flag explicitly.
- **Secret handling:** `AGENTGEM_GITHUB_CLIENT_SECRET` + `AGENTGEM_SESSION_SECRET` are real secrets — set only in the Render dashboard (never in render.yaml/repo). The session token is hashed at rest.
- **Open-redirect:** the `return`/`redirect_uri` must be validated against the allowlist (done) so the OAuth flow can't be used to bounce to an attacker origin.
