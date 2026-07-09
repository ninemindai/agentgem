# better-auth Identity Core (Phase 1) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Make better-auth AgentGem's identity core — it owns `user`/`account`/`session`, GitHub web login becomes its `github` social provider — with **zero user-visible feature change** and a working compatibility layer for existing clients.

**Split into two plans** (locked in `/plan-eng-review`, blast-radius reduction):
- **Plan 1a — additive foundation.** better-auth stood up ALONGSIDE the existing auth; the hand-rolled OAuth + `web_sessions` stay authoritative. Ships to prod, zero risk to live login, proves better-auth works before anything is deleted.
- **Plan 1b — cutover.** The `resolveSession` shim across all consumers, the compatibility layer, device-flow/handoff re-point, DELETE the old OAuth, force re-auth. The only PR where live auth can regress.

**Spec:** `docs/superpowers/specs/2026-07-09-better-auth-identity-core-design.md`
**Sequels:** Phase 2 (Google/Slack/X + passkey + linking); Phase 3 (the `login`-string ownership re-key + retiring `accounts`).

## Verified facts (spikes + review probes, better-auth 1.6.23)

- ✅ `internalAdapter.createSession(userId, undefined)` returns a token the `bearer()` plugin accepts via `auth.api.getSession`.
- ✅ `createUser({ id, login, ... })` accepts a supplied uuid `id` and the `login` additionalField; `findAccountByProviderId(accountId, providerId)` links a pre-inserted github account with no duplicate.
- ⚠️ **better-auth's DEFAULT `user.id` is a 32-char nanoid, NOT a uuid** (probe: `HngDZiEyGuWUfO8YROmjOf6eC1ja1klq`). Must force uuid generation — see Plan 1a Task 3.
- ⚠️ **better-auth stores the RAW session token** in its `session` table (probe confirmed), where `web_sessions` stored only `sha256`. Security-posture change — see 1b Task 6.
- ⚠️ `resolveSession` has **9 non-test consumers**, not 4: `catalog`, `groups`, `usage`, `githubApp/orgsApi`, `stars`, `reviews`, `registry/uploadPublish`, `registry/publishedBy`, `play.controller` (plus `auth/install.ts`, which is deleted).
- ⚠️ The marketplace SPA (`packages/marketplace/src/auth.ts`) calls the OLD paths `/api/auth/github/login` and `/api/auth/me` — better-auth does not serve them.

## Global Constraints

- **Node `>= 24`. ESM `.js` specifiers.** Tests run against compiled `dist/` (`pnpm test` = `tsc -b && vitest run`; include `dist/**/__tests__/**/*.test.js`; `pnpm clean` after a rename).
- **No drizzle-kit.** `ensureSchema` (`packages/aggregator/src/schema.ts`) is the sole idempotent DDL authority; PGlite `makeTestDb()` runs it. A new table needs the DDL, a `schema` const entry, and an alphabetized entry in `src/aggregator/__tests__/schema.test.ts`'s table array.
- **Aggregator store in `packages/aggregator/src/`; tests at repo-root `src/aggregator/__tests__/`** importing `@agentgem/aggregator`. Barrel is `export * from "./<module>.js"`.
- **`resolveSession` return shape `{ login, avatarUrl, accountId } | null` is a hard contract** across all 9 consumers.
- **Reserved SQL words** — quote `"user"`, `"account"`, `"session"` in DDL and queries.
- **`packages/console` tests + typecheck are not in CI.**

---

# PLAN 1a — Additive Foundation (better-auth alongside the old auth)

Everything here is additive. The hand-rolled OAuth, `web_sessions`, and `resolveSession` are UNTOUCHED and authoritative. At the end of 1a, better-auth is live at `/api/auth/*`, a new github sign-in through it produces a correct same-id `accounts` anchor, and every existing route still authenticates exactly as today. No user sees a change.

## 1a-Task 1: better-auth tables in `ensureSchema`

**Files:** `packages/aggregator/src/schema.ts`, `src/aggregator/__tests__/schema.test.ts`.

- [ ] Run `npx @better-auth/cli@latest generate` against the 1a-Task 2 config to emit the canonical schema; transcribe as `create table if not exists` DDL. The stable 1.6 core (verify against the generator, quote reserved names):

```ts
await db.execute(sql`create table if not exists "user" (
  id text primary key, name text, email text unique, email_verified boolean not null default false,
  image text, login text, created_at timestamptz not null default now(), updated_at timestamptz not null default now())`);
await db.execute(sql`create table if not exists "session" (
  id text primary key, user_id text not null references "user"(id) on delete cascade,
  token text not null unique, expires_at timestamptz not null, ip_address text, user_agent text,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now())`);
await db.execute(sql`create index if not exists session_user_idx on "session"(user_id)`);
await db.execute(sql`create table if not exists "account" (
  id text primary key, user_id text not null references "user"(id) on delete cascade,
  account_id text not null, provider_id text not null, access_token text, refresh_token text, id_token text,
  access_token_expires_at timestamptz, refresh_token_expires_at timestamptz, scope text, password text,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now())`);
await db.execute(sql`create unique index if not exists account_provider_idx on "account"(provider_id, account_id)`);
await db.execute(sql`create table if not exists "verification" (
  id text primary key, identifier text not null, value text not null, expires_at timestamptz not null,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now())`);
```
- [ ] Add `account`, `session`, `user`, `verification` (alphabetized) to `schema.test.ts`'s table array; run `tsc -b && pnpm exec vitest run dist/aggregator/__tests__/schema.test.js`; take the DB's actual `order by 1` if position differs.
- [ ] Commit: `feat(auth): better-auth core tables in ensureSchema`.

## 1a-Task 2: the `betterAuth` factory — uuid ids, 30d TTL, github, org-capture + accounts anchor

**Files:** Create `packages/aggregator/src/auth/betterAuth.ts`; barrel.

**The two review-critical pieces live here:** forcing uuid `user.id` (else new users break uuid FKs), and a create+update hook that captures org scopes AND writes the same-id legacy `accounts` anchor (else new users have no FK target and org offboarding breaks).

- [ ] Write the factory:

```ts
import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { bearer } from "better-auth/plugins";
import { randomUUID, createHash } from "node:crypto";
import { sql } from "drizzle-orm";
import type { AppDb } from "../schema.js";
import { fetchOrgMemberships } from "../accountVerifier.js";
import { setAccountScopes, upsertAccount } from "../webAuth.js";

const SESSION_TTL_S = 30 * 24 * 60 * 60; // 30 days — matches web_sessions/binding today (review fix 2A)

export function makeAuth(opts: {
  db: AppDb; secret: string; baseURL: string; githubClientId: string; githubClientSecret: string;
  webOrigins: string[]; cookieDomain?: string;
}) {
  return betterAuth({
    database: drizzleAdapter(opts.db as never, { provider: "pg" }),
    secret: opts.secret,
    baseURL: opts.baseURL,
    trustedOrigins: opts.webOrigins,                    // review fix #6 — redirect/CSRF boundary
    emailAndPassword: { enabled: false },
    plugins: [bearer()],
    // review fix #1/#14 — force uuid ids so downstream uuid FKs (accounts.id, stars.account_id, ...) work
    advanced: {
      database: { generateId: () => randomUUID() },
      // review fix #4 — cross-subdomain cookie so app.agentgem.ai sends it to api.agentgem.ai
      ...(opts.cookieDomain ? { crossSubDomainCookies: { enabled: true, domain: opts.cookieDomain } } : {}),
    },
    session: { expiresIn: SESSION_TTL_S, updateAge: 60 * 60 * 24 },   // review fix 2A
    user: { additionalFields: { login: { type: "string", required: false } } },
    socialProviders: {
      github: {
        clientId: opts.githubClientId, clientSecret: opts.githubClientSecret,
        scope: ["read:user", "read:org"],
        mapProfileToUser: (p: any) => ({ login: p.login, name: p.name ?? p.login, image: p.avatar_url }),
      },
    },
    databaseHooks: {
      account: {
        // review fix 1A — capture org scopes on FIRST login (create) AND every re-login (update),
        // so account_scopes stays fresh and org offboarding works. Also writes the legacy accounts
        // anchor so EVERY better-auth user has a same-id accounts row (review fix #1 new-user anchor).
        create: { after: async (a) => anchorAndScopes(opts.db, a) },
        update: { after: async (a) => anchorAndScopes(opts.db, a) },
      },
    },
  });
}

async function anchorAndScopes(db: AppDb, account: { userId: string; providerId: string; accountId: string; accessToken?: string | null }) {
  if (account.providerId !== "github") return;
  try {
    // read login/image off the user row we just created/updated
    const row = (await db.execute(sql`select login, image from "user" where id = ${account.userId}`)).rows?.[0] as { login?: string; image?: string } | undefined;
    const login = row?.login;
    // 1) legacy accounts anchor: accounts.id = user.id (uuid), so every FK target exists.
    if (login) await upsertAccount(db, { provider: "github", accountId: account.accountId, login, avatarUrl: row?.image ?? null, id: account.userId } as never);
    // 2) org scopes, best-effort, never throw (mirrors today's tolerance)
    if (account.accessToken && login) {
      const memberships = await fetchOrgMemberships(account.accessToken).catch(() => []);
      await setAccountScopes(db, account.userId, [{ scope: login, role: "self" as const }, ...memberships.map((m) => ({ scope: m.login, role: m.role }))]);
    }
  } catch { /* anchor+scopes are best-effort; never fail sign-in */ }
}
```

> **`upsertAccount` gains an optional `id`** (Plan 1a Task 4) so the anchor uses `user.id`. Confirm in the same spike harness that `account.update.after` fires on re-login with a refreshed `accessToken`; if not, capture scopes from a `session.create.after` hook that reads the token off the account row (review fix 1A fallback).

- [ ] Test (review-mandated): construction rejects an unknown bearer; a `createUser` with NO supplied id yields a **uuid** (`advanced.database.generateId`); a minted session's `expiresAt ≈ now + 30d`.
- [ ] Commit: `feat(auth): betterAuth factory — uuid ids, 30d TTL, github, org-capture+anchor hook`.

## 1a-Task 3: `mintSession` + `upsertAccount` id option

**Files:** `packages/aggregator/src/auth/mintSession.ts`; `packages/aggregator/src/webAuth.ts`.

- [ ] `mintSession(auth, userId) → { token, expiresAt }` (verified spike): `const s = (await auth.$context).internalAdapter.createSession(userId, undefined)`.
- [ ] Extend `upsertAccount` to accept an optional `id` (used only by the anchor hook); when absent it keeps `randomUUID()`. On conflict `(provider, provider_account_id)` it already updates in place, so re-anchoring is idempotent.
- [ ] Tests: `mintSession` returns a bearer-acceptable token (reproduce the spike as a dist test); `upsertAccount({..., id})` preserves the supplied id.
- [ ] Commit: `feat(auth): mintSession + upsertAccount id option for the anchor`.

## 1a-Task 4: mount `auth.handler` at `/api/auth/*` with direct Web Request + credentialed CORS

**Files:** Create `src/auth/mount.ts`; `src/index.ts`.

- [ ] Write `mountAuth(expressApp, auth, webOrigins)` — build the Web `Request` DIRECTLY (review fix 4A, no stream re-emit) and apply the same credentialed CORS the old handlers did (review fix #5):

```ts
import type { betterAuth } from "better-auth";
type ExpressApp = { all(p: string, h: (req: any, res: any) => unknown): unknown };

export function mountAuth(expressApp: ExpressApp, auth: ReturnType<typeof betterAuth>, webOrigins: string[]): void {
  expressApp.all("/api/auth/*", async (req, res) => {
    const origin = req.headers["origin"];
    if (origin && webOrigins.includes(origin)) {
      res.set("Access-Control-Allow-Origin", origin);
      res.set("Access-Control-Allow-Credentials", "true");
      res.set("Vary", "Origin");
    }
    if (req.method === "OPTIONS") { res.set("Access-Control-Allow-Methods", "GET, POST, OPTIONS").set("Access-Control-Allow-Headers", "content-type, authorization").status(204).send(""); return; }
    const proto = req.headers["x-forwarded-proto"] ?? req.protocol ?? "https";
    const host = req.headers["host"];
    const url = new URL(req.originalUrl, `${proto}://${host}`);
    const headers = new Headers();
    for (const [k, v] of Object.entries(req.headers)) if (typeof v === "string") headers.set(k, v);
    const hasBody = !["GET", "HEAD"].includes(req.method) && req.body != null && Object.keys(req.body).length > 0;
    const request = new Request(url, { method: req.method, headers, body: hasBody ? JSON.stringify(req.body) : undefined });
    const resp = await auth.handler(request);
    res.status(resp.status);
    resp.headers.forEach((val, key) => res.append(key, val));   // append: preserves multiple Set-Cookie
    res.send(Buffer.from(await resp.arrayBuffer()));
  });
}
```
- [ ] Wire into `src/index.ts` (additively — do NOT remove `installAuth` yet): build `makeAuth(...)`, `mountAuth(...)`, run `migrateAccountsToBetterAuth` (1a-Task 5). Both auth systems now serve; the old one is still authoritative for existing sessions.
- [ ] Test (review-mandated): a stub-auth `mount` whose handler echoes `await request.json()` receives a NON-EMPTY body on a real `POST` with a JSON body; OPTIONS from an allowlisted origin returns 204 with credentialed CORS; a foreign origin gets no ACAO.
- [ ] Commit: `feat(auth): mount better-auth at /api/auth/* (direct Web Request + credentialed CORS)`.

## 1a-Task 5: migration backfill with conflict detection

**Files:** Create `packages/aggregator/src/auth/migrateAccounts.ts`.

- [ ] `migrateAccountsToBetterAuth(db) → { migrated, conflicts }` — insert-if-absent `user` (id = accounts.id) and `account`, and **FAIL LOUD on a mismatched link** (review fix #11): if an `"account"` row for `(github, account_id)` already exists with a different `user_id`, collect it as a conflict rather than silently accepting the wrong link.

```ts
export async function migrateAccountsToBetterAuth(db: AppDb): Promise<{ migrated: number; conflicts: string[] }> {
  await db.execute(sql`insert into "user" (id, name, email_verified, image, login, created_at, updated_at)
    select a.id::text, a.login, false, a.avatar_url, a.login, now(), now() from accounts a on conflict (id) do nothing`);
  // conflict check BEFORE inserting accounts
  const bad = (await db.execute(sql`select ac.account_id from "account" ac join accounts a
    on ac.provider_id = a.provider and ac.account_id = a.provider_account_id where ac.user_id <> a.id::text`)).rows as { account_id: string }[];
  const res = await db.execute(sql`insert into "account" (id, user_id, provider_id, account_id, created_at, updated_at)
    select gen_random_uuid()::text, a.id::text, a.provider, a.provider_account_id, now(), now() from accounts a on conflict (provider_id, account_id) do nothing`);
  return { migrated: (res as any).rowCount ?? 0, conflicts: bad.map((b) => b.account_id) };
}
```
- [ ] Test (review-mandated): idempotent backfill, id preserved, a `stars` FK row still resolves; a pre-seeded mismatched `account` row is reported in `conflicts`, not silently kept.
- [ ] Commit: `feat(auth): accounts->user+account backfill with conflict detection`.

## 1a-Task 6: drizzle + social-callback integration test (closes the memory-adapter gap)

**Files:** `src/aggregator/__tests__/betterAuthIntegration.test.ts`.

The spikes used the memory adapter; this proves the **drizzle-over-PGlite** path and the social sign-in linking that production actually runs (review finding #10).

- [ ] Build `makeAuth` over a real `makeTestDb()` (drizzle+PGlite). Drive a github sign-in with a **mocked GitHub provider** — configure the github provider's token/userinfo endpoints at an in-process mock (better-auth's `socialProviders.github` accepts custom endpoints, or use the `genericOAuth` plugin pointed at the mock). Assert: a new sign-in creates a uuid-id user + a same-id `accounts` anchor + `account_scopes`; a second sign-in for the same github id LINKS (no duplicate) and RE-captures scopes (review fix 1A, drizzle path); the minted session resolves via `auth.api.getSession`.
- [ ] Commit: `test(auth): drizzle+PGlite social-callback integration (link, anchor, re-capture)`.

**End of 1a:** better-auth is live at `/api/auth/*`, produces correct uuid+anchored users, captures/refreshes org scopes, and is proven over the real adapter — with the old auth still authoritative. Ship it, verify in staging, THEN do 1b.

---

# PLAN 1b — Cutover (delete the old auth; better-auth becomes authoritative)

The only PR where live auth can regress. Depends on 1a shipped.

## 1b-Task 1: `resolveSession(auth, headers)` shim across all 9 consumers

**Files:** `packages/aggregator/src/webAuth.ts`; the 9 consumers.

- [ ] Re-implement (review fix 3A — takes headers, better-auth reads its OWN cookie/bearer):

```ts
export async function resolveSession(auth: ReturnType<typeof betterAuth>, headers: Record<string, string | undefined> | Headers): Promise<{ login: string; avatarUrl: string | null; accountId: string } | null> {
  const h = headers instanceof Headers ? headers : Object.entries(headers).reduce((acc, [k, v]) => { if (typeof v === "string") acc.set(k, v); return acc; }, new Headers());
  const res = await auth.api.getSession({ headers: h });
  const u = res?.user as { id: string; login?: string; image?: string | null } | undefined;
  return u ? { login: u.login ?? "", avatarUrl: u.image ?? null, accountId: u.id } : null;
}
```
- [ ] Thread `auth` + forward `req.headers` (drop all `parseCookies`/`SESSION_COOKIE` extraction) in ALL NINE: `src/catalog/install.ts`, `src/groups/install.ts`, `src/usage/install.ts`, `src/githubApp/orgsApi.ts`, `src/stars/install.ts`, `src/reviews/install.ts`, `src/registry/uploadPublish.ts`, `src/registry/publishedBy.ts`, `src/play.controller.ts`. Update each `install*`/controller signature and the `src/index.ts` call sites to pass `auth`.
- [ ] Tests (review-mandated, incl the **cookie-path regression guard**): `resolveSession` resolves a session presented as a better-auth **cookie** AND as a Bearer; a route module (pick `groups`) authenticates a request carrying the better-auth cookie (not Bearer) — the exact 3A regression. Update the 9 modules' existing session-minting test helpers from `createSession` to `mintSession`.
- [ ] Commit: `refactor(auth): resolveSession shim over better-auth across all 9 consumers`.

## 1b-Task 2: client + route compatibility

**Files:** `packages/marketplace/src/auth.ts` (+ test); optionally `src/auth/mount.ts` compat shims.

Existing clients call `/api/auth/github/login`, `/api/auth/me`. Choose ONE and sequence the deploy (review findings #2/#3):
- [ ] **Update the marketplace client** — `loginUrl` → better-auth's social sign-in (`${base}/api/auth/sign-in/social` POST `{ provider: "github", callbackURL }`, or the GET redirect form); `getMe` → `${base}/api/auth/get-session`. Update `auth.test.ts`. AND
- [ ] **Update the GitHub OAuth app callback URL** to better-auth's `/api/auth/callback/github` — a HARD, explicit cutover step (login hard-fails at callback otherwise). Document it in the cutover runbook (1b-Task 5).
- [ ] Optional belt-and-suspenders: add thin compat handlers in `mount.ts` that 302 `/api/auth/github/login?return=` → better-auth's social sign-in, and proxy `/api/auth/me` → `get-session`, so an un-updated client / bookmarked URL keeps working during the deploy window.
- [ ] Test: `auth.test.ts` asserts the new URLs; a compat-shim test asserts the old login path still redirects.
- [ ] Commit: `feat(auth): marketplace client + OAuth-app callback compatibility`.

## 1b-Task 3: device-flow → better-auth session

**Files:** `packages/aggregator/src/binding.ts`.

- [ ] `recordBinding` step 6: ensure a better-auth `user`(+github `account`) exists for this id (reuse the anchor insert), then `mintSession(auth, account.id)` instead of `generateSessionToken`+`createSession`. Thread `auth` into the signature; keep every proof + best-effort tolerance.
- [ ] Test: the returned token is accepted by `resolveSession(auth, { authorization: 'Bearer <token>' })`.
- [ ] Commit: `feat(auth): device-flow bind mints a better-auth session`.

## 1b-Task 4: SSO handoff + logout via better-auth Set-Cookie

**Files:** handoff redeem controller; logout.

Minting a token is not enough — the browser needs a Set-Cookie better-auth will read (review finding #13).
- [ ] Handoff redeem: after `mintSession(auth, accountId)`, set the response cookie via better-auth's cookie mechanics (call better-auth's session-cookie serializer / a small endpoint that emits the Set-Cookie), NOT a manual `ag_session`. Keep `handoff_codes` single-use/60s.
- [ ] Logout: route `/api/auth/logout` (or the marketplace client) to better-auth's `sign-out` so it clears better-auth's cookie, not `web_sessions`.
- [ ] Test (review-mandated): handoff redeem yields a cookie that `resolveSession` accepts; sign-out invalidates it.
- [ ] Commit: `feat(auth): handoff + logout via better-auth session cookie`.

## 1b-Task 5: delete the old OAuth; document token-storage; cutover runbook

**Files:** delete `src/auth/install.ts`, `src/auth/state.ts`; `src/index.ts`; `webAuth.ts`.

- [ ] Remove the `installAuth(...)` block and its imports; `git rm src/auth/install.ts src/auth/state.ts`. Remove `generateSessionToken`/`createSession`/`deleteSession` (now unused). `src/auth/cookie.ts` — remove `SESSION_COOKIE`/`parseCookies` if no remaining consumer (the 9 modules dropped it in 1b-Task 1); keep only what handoff still needs.
- [ ] **Document the token-storage decision** (review finding #12): better-auth stores the raw session token (vs the old hash-only). Either accept + document it in the spec's security section, OR configure/extend better-auth to hash at rest if that's a hard requirement. Default: accept + document (30d tokens, same as before, and a DB compromise is already game-over for the aggregator) — but make it an explicit, recorded decision, not a silent regression.
- [ ] `web_sessions` DDL stays (unused) — dropping a table is a separate migration; comment it dead.
- [ ] **Cutover runbook** (force re-auth): (1) deploy 1a, verify better-auth live; (2) update the GitHub OAuth app callback URL; (3) deploy 1b (client + server together); (4) old sessions are abandoned — web users re-login (1 click), CLI users re-`bind`. Staging-drive the whole sequence first.
- [ ] `pnpm clean && pnpm test` green; staging drive: web login → authed call (cookie path) → CLI bind → Bearer authed call → handoff.
- [ ] Commit: `feat(auth): cut over to better-auth — delete hand-rolled OAuth; force re-auth`.

---

## NOT in scope (sequels)

Google/Slack/X + passkey + `linkSocial`, email verification — **Phase 2**. The `login`-string ownership re-key + retiring `accounts`/`web_sessions` — **Phase 3**. Email policy beyond "null allowed" (verify better-auth's social-path requirement in 1a-Task 6; add `user:email` scope in Phase 2 where linking needs a verified email).

## What already exists (reused, not rebuilt)

`fetchOrgMemberships`/`accountVerifier` (reused verbatim by the hook + bind); `upsertAccount`/`setAccountScopes` (kept — still write the legacy `accounts`/`account_scopes` the anchor + org-gating depend on); `makeTestDb` PGlite harness; the credentialed-CORS pattern (`catalog/install.ts:19`) mirrored in `mount.ts`; `@hono/node-server` (already a dep, though 4A builds the Request directly instead).

## Failure modes

| Codepath | Failure | Test? | Handling |
|---|---|---|---|
| new github sign-in | non-uuid id → uuid FK write throws | ✅ 1a-Task 2/6 (uuid gen + anchor) | uuid `generateId` + anchor hook |
| org member re-login | scopes not refreshed → offboarding hole | ✅ 1a-Task 6 (re-capture) | create+update hook |
| web SPA authed call | wrong cookie name → 401 | ✅ 1b-Task 1 (cookie-path guard) | headers-based shim |
| cross-subdomain cookie | app.→api. doesn't send cookie | ⚠️ staging | crossSubDomainCookies domain |
| GitHub OAuth callback | old callback URL → login hard-fails | ⚠️ runbook step | update OAuth app URL |
| DB leak | raw token → session theft | n/a | documented decision (1b-Task 5) |
| migration | mismatched account link | ✅ 1a-Task 5 (conflict fail) | fail loud |

## Worktree parallelization

Plan 1a tasks are mostly sequential within `packages/aggregator` (Task 2 needs Task 1's tables; 4-6 need the factory). Plan 1b depends on 1a shipped. **Sequential; no parallel lanes** — this is one load-bearing seam being rebuilt, not independent workstreams.

## Implementation Tasks (synthesized from the review)

- [ ] **T1 (P1)** — force uuid `user.id` + create/update hook writing the same-id `accounts` anchor (1a-Task 2). *Source: Codex #1/#14 (verified: nanoid default).* New users break uuid FKs without it.
- [ ] **T2 (P1)** — org capture on create AND update, not create-only (1a-Task 2). *Source: Arch review 1A.* Offboarding freshness.
- [ ] **T3 (P1)** — `resolveSession(auth, headers)` across all **9** consumers (1b-Task 1). *Source: Code review 3A + Codex #7.* Web auth 401s otherwise.
- [ ] **T4 (P1)** — client + OAuth-app callback compatibility (1b-Task 2). *Source: Codex #2/#3.* Login button + callback break.
- [ ] **T5 (P2)** — pin 30d session TTL (1a-Task 2). *Source: Arch review 2A (verified 7d default).*
- [ ] **T6 (P2)** — mount builds the Web Request directly + credentialed CORS (1a-Task 4). *Source: Code review 4A + Codex #5.*
- [ ] **T7 (P2)** — cross-subdomain cookie domain + `trustedOrigins` (1a-Task 2). *Source: Codex #4/#6.*
- [ ] **T8 (P2)** — handoff/logout via better-auth Set-Cookie (1b-Task 4). *Source: Codex #13.*
- [ ] **T9 (P2)** — migration conflict detection (1a-Task 5). *Source: Codex #11.*
- [ ] **T10 (P2)** — drizzle+PGlite social-callback integration test (1a-Task 6). *Source: Codex #10.*
- [ ] **T11 (P2)** — document the raw-token-storage decision (1b-Task 5). *Source: Codex #12 (verified).*
- [ ] **T12 (P3)** — the 5 review-mandated tests incl the 2 regression guards. *Source: Test review 5A.*

## GSTACK REVIEW REPORT

| Review | Trigger | Why | Runs | Status | Findings |
|--------|---------|-----|------|--------|----------|
| CEO Review | `/plan-ceo-review` | Scope & strategy | 0 | — | — |
| Codex Review | outside voice | Independent 2nd opinion | 1 | issues_found | 14 raised, 11 verified real, folded into 1a/1b |
| Eng Review | `/plan-eng-review` | Architecture & tests (required) | 1 | issues_open→revised | 6 findings + Codex; plan rewritten as 1a/1b |
| Design Review | `/plan-design-review` | UI/UX | 0 | — | — |
| DX Review | `/plan-devex-review` | Developer experience | 0 | — | — |

**CODEX:** The outside voice found the category my review under-weighted — a missing compatibility layer (old routes, GitHub callback URL, marketplace client, cross-subdomain cookie, credentialed CORS) and a critical new-user-anchor bug. I verified the load-bearing ones by probe: better-auth's default id is a nanoid not a uuid (breaks uuid FKs for new users), it stores the raw session token (was hash-only), `resolveSession` has 9 consumers not 4, and the marketplace SPA uses the old `/api/auth/github/login` + `/api/auth/me`. All folded into the revised plan.

**CROSS-MODEL:** My review said "design holds, ready after 5 fixes"; Codex said "not a drop-in — the compatibility layer is the dangerous missing work." Codex was more right. The plan was NOT ready as written; it is now revised (1a/1b + compatibility layer + new-user anchor) and re-scoped.

**VERDICT:** ENG review found blockers; plan REVISED, not yet clear. The revised 1a/1b plan needs a fresh pass (or careful execution with the 12 synthesized tasks) — the design is sound and the spikes hold, but the compatibility layer roughly doubled 1b and must be built, not assumed. Split confirmed. Recommend: build 1a (additive, zero-risk), verify in staging, then execute 1b behind the runbook.

NO UNRESOLVED DECISIONS
