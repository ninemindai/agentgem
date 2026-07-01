# Account-Scope Enforcement (#4b)

**Date:** 2026-06-30
**Status:** Design — ready for implementation plan
**Parent:** the gem-contributions program (`2026-06-30-gem-contributions-vision-design.md`), subsystem #4b — the deferred enforcement half of account-bound publishing. #4a shipped verified attribution (`publishedBy`); this adds ownership enforcement.

## Goal

A signed-in user may publish a gem only to a scope they own: their own GitHub
login (`@you/*`) **or** an org they belong to (`@ninemind/*`). Replace the crude
temporary rail (`scope === login`) on the marketplace upload path with a real
ownership check — without persisting the GitHub access_token.

## Context (what exists)

- **Marketplace upload-publish** (`src/registry/uploadPublish.ts`) is the public,
  session-authed path. It currently enforces `scope === who.login` → 403 (blocks org
  scopes). This is the ONLY thing #4b changes on the enforcement side.
- **Console `/registry/publish`** (`gem.controller.ts`) is local/trusted (runs on the
  user's machine, uses the SERVER's registry token). It is account-agnostic and is the
  path the live `@ninemind/*` gem publishes through. **Out of scope — left untouched.**
- **Session/account model** (`packages/aggregator`): `accounts(id, provider,
  providerAccountId, login, avatarUrl)`, `webSessions(tokenHash, accountId, expiresAt)`.
  `resolveSession(db, token) → { login, avatarUrl, accountId }` (accountId = internal
  uuid). The GitHub **access_token is NOT persisted** — but it IS available transiently
  in the OAuth callback (`src/auth/install.ts:62`, `deps.exchangeCode` → token →
  `verifier.verify(token)`).
- **Registry** (`packages/distribute`): `scope` is a free string; no ownership model.

## The unblock

The access_token is in hand at login. Capture ownership THEN (one `GET /user/orgs`
call), persist the derived scope list, and enforce at publish. No token storage.

## Components (each independently testable)

### 1. `fetchOrgs(token)` — GitHub org memberships
- New function alongside `GitHubVerifier` (`packages/aggregator/src/accountVerifier.ts`
  or a sibling): `GET https://api.github.com/user/orgs` (Bearer token) → `string[]` of
  org `login`s. Injectable `fetch` for tests (mirror `GitHubVerifier`'s constructor).
- **Public-only (v1 default):** without `read:org`, GitHub returns only PUBLIC org
  memberships. That is acceptable — a user makes their org membership public to publish
  under it. (`read:org` on the OAuth request is the documented switch for private orgs;
  NOT added in v1 — it broadens the permission every user grants.)
- Failure-tolerant: a non-2xx or malformed response yields `[]` (a user with no
  resolvable orgs still owns their own login-scope).

### 2. `account_scopes` table + accessors (`packages/aggregator`)
- Schema: `account_scopes(account_id uuid references accounts(id), scope text,
  primary key (account_id, scope))`. Add to `schema.ts` (pgTable + the `schema` export)
  and `ensureSchema` idempotent DDL. Update the schema-enumeration test.
- `setAccountScopes(db, accountId, scopes: string[])` — REPLACE (delete the account's
  rows, insert the given set; dedup). Called at login.
- `accountOwnsScope(db, accountId, scope): Promise<boolean>` — one existence query.

### 3. Capture at login (`src/auth/install.ts` callback)
- After `upsertAccount(...)` (we have `token` + `acct.login`), fetch orgs and store the
  owned set = `[acct.login, ...orgs]` (login always included) via `setAccountScopes`.
- Best-effort: an org-fetch failure must NOT fail login — the user still gets a session
  and owns at least their login-scope. (Wrap the fetch+store; on error, store just
  `[acct.login]`.)
- Inject the org-fetch (like `deps.verifier`/`deps.exchangeCode`) so the callback stays
  testable without live GitHub.

### 4. Enforce at upload-publish (`src/registry/uploadPublish.ts`)
- Replace `if (scope !== who.login) → 403` with
  `if (!(await accountOwnsScope(db, who.accountId, scope))) → 403`
  (message: "you don't own the scope @<scope>"). `resolveSession` already returns
  `accountId`. Everything else in the handler (auth-first ordering, CORS, publishedBy,
  error handling) is unchanged.

## Data flow

```
OAuth callback: exchangeCode → verify(token) → upsertAccount →
                fetchOrgs(token) → setAccountScopes(account, [login, ...orgs])
upload-publish: resolveSession → accountOwnsScope(accountId, scope) ? publish : 403
```

## Security / correctness

- **No token persisted** — only the derived scope list (org logins), which are public
  info. The token is used once at the callback and discarded as today.
- **Ownership is proven via GitHub**, not self-asserted. A user can't publish to
  `@ninemind` unless GitHub reports them a (public) member at their last login.
- **Enforcement unbypassable on the public path:** `scope`/`accountId` are server-side
  (accountId from the verified session, not the body). The console/trusted path is a
  separate, machine-owner path and stays as-is.
- **Staleness:** memberships are as fresh as the last login; a user removed from an org
  keeps access until session expiry / next login. Bounded and acceptable for v1.

## Testing

- `fetchOrgs`: parses org logins from a fake `/user/orgs` response; non-2xx/malformed → `[]`.
- `setAccountScopes` / `accountOwnsScope`: pglite round-trip — replace semantics (re-login
  with a different org set overwrites), owns login + org, does-not-own a foreign scope.
- upload-publish: owns (login OR org) → publishes; not-owned → 403; login always owned.
- OAuth callback (injected org-fetch): after login, `account_scopes` = `[login, ...orgs]`;
  an org-fetch failure still yields a session + `[login]`.

## Deferred / non-goals

- `read:org` OAuth scope for PRIVATE org memberships (documented switch; not v1).
- Enforcing the local console `/registry/publish` path (trusted machine-owner path).
- Live per-publish GitHub membership checks / token persistence (Option C — rejected).
- A claimed-scopes settings UI (Option B — rejected in favor of GitHub-proven orgs).
- Retroactive ownership for already-published scopes.
