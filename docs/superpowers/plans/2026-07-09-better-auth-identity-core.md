# better-auth Identity Core (Phase 1) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make better-auth AgentGem's identity core — it owns `user`/`account`/`session`, GitHub web login becomes its `github` social provider — with zero user-visible feature change.

**Architecture:** better-auth runs over the existing Postgres via the Drizzle adapter in existing-tables mode; its tables live in the hand-rolled `ensureSchema`. The legacy `accounts` table is **retained as the FK anchor** and better-auth's `user` shares its id, so no existing foreign key changes in Phase 1. `resolveSession` is re-implemented as a thin shim over better-auth so every downstream route is untouched. The ed25519 device-flow and the SSO handoff stay custom but mint better-auth sessions. The hand-rolled web OAuth and `web_sessions` are deleted; cutover forces one re-auth.

**Tech Stack:** TypeScript (ESM, `.js` specifiers), better-auth + `@better-auth/*`, Drizzle over Postgres, PGlite for tests, vitest, `@hono/node-server` (already a dep), the in-house `@agentback/rest` server.

**Spec:** `docs/superpowers/specs/2026-07-09-better-auth-identity-core-design.md`
**Sequels:** Phase 2 (Google/Slack/X + passkey + linking); Phase 3 (the `login`-string ownership re-key + retiring `accounts`).

## Global Constraints

- **Node `>= 24`. ESM with explicit `.js` import specifiers**, even from `.ts` sources.
- **Tests run against compiled `dist/`.** `pnpm test` = `tsc -b && vitest run`; vitest includes only `dist/**/__tests__/**/*.test.js`. Run one file with `tsc -b && pnpm exec vitest run dist/<path>.test.js`. A `src/**/*.test.ts` path matches nothing. After a rename, `pnpm clean` first.
- **No drizzle-kit.** `ensureSchema` in `packages/aggregator/src/schema.ts` is the sole idempotent DDL authority; PGlite `makeTestDb()` runs it. A new table needs: the `pgTable` object (or a raw-DDL block), an entry in the `schema` const, `create table if not exists` in `ensureSchema`, and an alphabetized entry in `src/aggregator/__tests__/schema.test.ts`'s table-list array.
- **Aggregator store lives in `packages/aggregator/src/`; its tests live at repo-root `src/aggregator/__tests__/`**, importing `@agentgem/aggregator`. The barrel is `export * from "./<module>.js"`.
- **`packages/console` tests + typecheck are not in CI.** This plan does not touch console.
- **Adding a dependency is justified here:** better-auth is the identity core the spec adopts; hand-rolling multi-provider + linking is the thing it replaces. This is the one place in the repo a framework dependency is clearly warranted.
- **`resolveSession(db, token) → { login, avatarUrl, accountId } | null`** is imported by `src/catalog/install.ts`, `src/groups/install.ts`, `src/usage/install.ts`, and `src/githubApp/orgsApi.ts`. Its return shape is a hard contract — the shim MUST preserve it exactly.

## Design refinement locked here (refines the spec's "migration" section)

better-auth uses **text** ids; AgentGem's `accounts.id` is **uuid** with 7+ FKs. Phase 1 does **not** re-type those FKs. Instead:

- `accounts` (uuid pk) is **retained** as the FK anchor for `stars`/`reviews`/`usage_days`/`account_scopes`/`handoff_codes`/`groups`/`group_members`/`group_invites` — unchanged.
- better-auth's `user.id` is **text**, and the migration sets it to the `accounts.id` uuid **as a string**. `user` and `accounts` share ids.
- `resolveSession` returns `accountId = session.userId` (the shared id string). Downstream queries compare it against uuid columns; Postgres coerces text→uuid in a value comparison, so no caller changes.
- Retiring `accounts` and re-typing FKs onto `user.id` is **Phase 3**, not now.

```
  accounts (uuid pk)  ◄── stars/reviews/usage/scopes/groups...  (FK anchor, unchanged)
     │  same id (as text)
     ▼
  better-auth: user (text pk = uuid string) ── account ── session
                    ▲                                        │
                    └──────── resolveSession shim ───────────┘
                    returns { login, avatarUrl, accountId=user.id }
```

---

## File structure

**Create:**
- `packages/aggregator/src/auth/betterAuth.ts` — the `betterAuth(...)` instance factory (adapter, github provider, bearer plugin, `login` additionalField, org-capture hook). One responsibility: configure the auth core.
- `packages/aggregator/src/auth/mintSession.ts` — the verified server-side session-creation helper (from Spike 1), used by the device-flow and handoff.
- `packages/aggregator/src/auth/migrateAccounts.ts` — the one-time idempotent `accounts → user + account` backfill.
- `src/auth/mount.ts` — mounts `auth.handler` at `/api/auth/*` with the body rebuild.
- Spike scratch: `src/aggregator/__tests__/spike-session.test.ts`, `spike-link.test.ts`.

**Modify:**
- `packages/aggregator/src/schema.ts` — better-auth tables in DDL + `schema` const.
- `packages/aggregator/src/webAuth.ts` — `resolveSession` re-implemented; mint helpers removed.
- `packages/aggregator/src/binding.ts` — `recordBinding` mints via `mintSession`.
- `packages/aggregator/src/index.ts` (barrel), `src/aggregator/__tests__/schema.test.ts` (table list).
- `src/index.ts` — wire `betterAuth` + `mount`; delete the `installAuth` block; body-parser note.
- **Delete:** `src/auth/install.ts` (web OAuth), `src/auth/state.ts`.

---

## SPIKE RESULTS (2026-07-09) — both gates PASS, design holds

Verified against better-auth **1.6.23** using the **memory adapter** (isolates the core
API from drizzle/DDL wiring — those remain to verify in Tasks 3–4, but they are standard
adapter usage, low risk). All three uncertainties resolved green:

- **Session creation:** `ctx.internalAdapter.createSession(userId, undefined)` returns
  `{ token, expiresAt, ... }`; the `bearer()` plugin accepts that token via
  `auth.api.getSession({ headers: { authorization: 'Bearer <token>' } })`. → `mintSession` is viable.
- **Supplied id + login field:** `ctx.internalAdapter.createUser({ id, login, image, ... })`
  accepts an externally-supplied uuid `id` and persists the `login` additionalField;
  `getSession` returns `user.login` and `user.image`. → migration id-preservation and the
  `resolveSession` shim both work.
- **Link-on-relogin:** a pre-inserted `createAccount({ userId, providerId: 'github', accountId })`
  is resolved by **`findAccountByProviderId(accountId, providerId)`** (arg order: accountId
  first) to the correct user, no duplicate. → the migration's pre-made account links on re-login.
- **Access token for org-capture:** the account row carries `accessToken`, readable off the
  `createAccount` result and `findAccountByProviderId` — the Task 4 hook can use it.

**API corrections for the tasks below:** `findAccountByProviderId` takes `(accountId,
providerId)`, not `(providerId, accountId)`. `createUser` takes the `login` field inline in
its object. `createSession(userId, undefined)` is the working call.

---

## Task 1 (SPIKE): programmatic session creation — GATES the plan
*(VERIFIED — see SPIKE RESULTS above. When executing, reproduce this as the dist-based
test in the task body, then extract `mintSession`.)*

**Files:** Create `src/aggregator/__tests__/spike-session.test.ts`; Create `packages/aggregator/src/auth/mintSession.ts`.

**Interfaces:**
- Produces: `mintSession(auth, userId: string): Promise<{ token: string; expiresAt: string }>` — the device-flow and handoff (Tasks 8, 9) depend on this exact signature.

**Why this is a spike:** better-auth's documented server API creates *users* (`admin.createUser`) but not obviously a *session for an existing user with no browser redirect*. Session CRUD lives on the internal adapter. This task finds the working call or STOPS.

- [ ] **Step 1: Stand up a minimal better-auth over PGlite in a test**

```ts
// src/aggregator/__tests__/spike-session.test.ts
import { describe, it, expect } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { bearer } from "better-auth/plugins";
import { ensureSchema, schema } from "@agentgem/aggregator";

async function makeAuth() {
  const pg = new PGlite();
  const db = drizzle(pg, { schema }) as any;
  await ensureSchema(db);                       // must already create better-auth tables (Task 3)
  const auth = betterAuth({
    database: drizzleAdapter(db, { provider: "pg" }),
    secret: "test-secret-at-least-32-chars-long-xxxxx",
    baseURL: "http://localhost",
    emailAndPassword: { enabled: false },
    plugins: [bearer()],
    user: { additionalFields: { login: { type: "string", required: false } } },
  });
  return { auth, db };
}
```

> This test cannot pass until Task 3's `ensureSchema` creates better-auth's tables. Order of work: sketch Task 3's DDL first (via `npx @better-auth/cli generate`), land it, then this spike. If you run the spike before Task 3, expect a "relation \"user\" does not exist" failure — that is the signal to do Task 3's DDL, not a spike failure.

- [ ] **Step 2: Try, in order, to mint a session for a known user with no redirect**

Create a user via the adapter, then attempt each candidate until one yields a token that `getSession` accepts as a bearer. Document which worked in `mintSession.ts`.

```ts
it("SPIKE: mints a session for a known userId, bearer-acceptable", async () => {
  const { auth, db } = await makeAuth();
  const ctx = await auth.$context;                          // internal context
  // create a user directly through better-auth's internal adapter
  const user = await ctx.internalAdapter.createUser({ id: crypto.randomUUID(), name: "neo", email: "neo@example.invalid", emailVerified: true });

  // Candidate A: internalAdapter.createSession
  const session = await ctx.internalAdapter.createSession(user.id, undefined);
  expect(session?.token).toBeTruthy();

  // Verify the bearer plugin accepts it
  const got = await auth.api.getSession({ headers: new Headers({ authorization: `Bearer ${session.token}` }) });
  expect(got?.user?.id).toBe(user.id);
});
```

If Candidate A's signature differs or the token isn't bearer-acceptable, try **Candidate B** (`auth.api.createSession` if exported), then **Candidate C** (a custom endpoint via a tiny plugin that calls `ctx.internalAdapter.createSession`). Record the exact working call.

- [ ] **Step 3: GATE**

Run: `tsc -b && pnpm exec vitest run dist/aggregator/__tests__/spike-session.test.js`
- **PASS** → extract the working call into `mintSession(auth, userId)` returning `{ token, expiresAt }` (expiresAt from the session row). Proceed.
- **FAIL (no candidate works)** → **STOP. Escalate.** The device-flow + handoff cannot mint sessions server-side; the design (delete web_sessions, keep device-flow) is not viable as written and must be reconsidered (e.g. a custom session table better-auth reads). Do not continue.

- [ ] **Step 4: Write `mintSession.ts` and commit**

```ts
// packages/aggregator/src/auth/mintSession.ts — body = the verified candidate from Step 2
import type { betterAuth } from "better-auth";
export async function mintSession(auth: ReturnType<typeof betterAuth>, userId: string): Promise<{ token: string; expiresAt: string }> {
  const ctx = await auth.$context;
  const session = await ctx.internalAdapter.createSession(userId, undefined);
  if (!session?.token) throw new Error("better-auth returned no session token");
  return { token: session.token, expiresAt: new Date(session.expiresAt).toISOString() };
}
```

```bash
git add packages/aggregator/src/auth/mintSession.ts src/aggregator/__tests__/spike-session.test.ts
git commit -m "spike(auth): verify server-side better-auth session creation for a known user"
```

---

## Task 2 (SPIKE): externally-supplied user.id + upsert-on-relogin — GATES the plan

**Files:** Create `src/aggregator/__tests__/spike-link.test.ts`.

**Why this is a spike:** the migration inserts `user` rows with our chosen uuid and a pre-made `account` row (providerId `github`, accountId = GitHub numeric id). A subsequent GitHub sign-in must **link to that existing user**, not create a duplicate. Verify better-auth's sign-in resolves an existing account by `(providerId, accountId)`.

- [ ] **Step 1: Pre-insert a user + github account, then resolve by account**

Driving a full GitHub OAuth round-trip in a unit test needs a mocked provider. Verify the linking invariant at the layer better-auth's social sign-in uses: the account lookup.

```ts
// src/aggregator/__tests__/spike-link.test.ts
it("SPIKE: a pre-existing github account row links to its user, no duplicate", async () => {
  const { auth, db } = await makeAuth();                    // same helper as Task 1
  const ctx = await auth.$context;
  const uuid = crypto.randomUUID();
  await ctx.internalAdapter.createUser({ id: uuid, name: "neo", email: "neo@example.invalid", emailVerified: true, login: "neo" } as any);
  await ctx.internalAdapter.createAccount({ userId: uuid, providerId: "github", accountId: "12345", accessToken: "x" } as any);

  // The lookup better-auth's social callback performs to decide link-vs-create:
  const found = await ctx.internalAdapter.findAccount?.("github", "12345")
              ?? await ctx.internalAdapter.findAccountByProviderId?.("12345", "github");
  expect(found?.userId).toBe(uuid);

  // And no second user was created for the same github id (count stays 1)
  const users = await db.execute(sql`select count(*)::int n from "user"`);
  expect((users.rows as any[])[0].n).toBe(1);
});
```

> The exact internal-adapter method name (`findAccount` vs `findAccountByProviderId`) is what this spike pins down — try both, keep the one that exists.

- [ ] **Step 2: GATE**

Run: `tsc -b && pnpm exec vitest run dist/aggregator/__tests__/spike-link.test.js`
- **PASS** → the migration's pre-inserted rows will be linked on re-login. Record the confirmed lookup method for Task 6's migration test. Proceed.
- **FAIL (a duplicate user is created, or no account lookup resolves ours)** → **STOP. Escalate.** The `accounts.id = user.id` migration would orphan data on re-login. Reconsider (e.g. drive a mocked full sign-in, or a custom link step in the org-capture hook).

- [ ] **Step 3: Commit the spike**

```bash
git add src/aggregator/__tests__/spike-link.test.ts
git commit -m "spike(auth): verify pre-migrated github account links on re-login (no duplicate user)"
```

---

## Task 3: better-auth tables in `ensureSchema`

**Files:** Modify `packages/aggregator/src/schema.ts`; Modify `src/aggregator/__tests__/schema.test.ts`.

**Interfaces:**
- Produces: tables `user`, `account`, `session`, `verification` exist after `ensureSchema`, matching better-auth's expected schema, with `user.login text`.

- [ ] **Step 1: Generate better-auth's canonical schema once, to author from**

Run `npx @better-auth/cli@latest generate` against a scratch config (the `betterAuth({...})` from Task 4) to emit the exact current column set. Transcribe it into `ensureSchema` as `create table if not exists` DDL. Do NOT invent columns — use the generator's output. The stable core (verify against the generator):

```ts
// in ensureSchema, after the last existing create-table:
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

> `user`/`account`/`session` are reserved-ish words — quote them (`"user"`) everywhere, including the drizzle table definitions if you add them to the `schema` const. If the generator emits additional columns on a better-auth version bump, add them here; that is the documented upgrade cost.

- [ ] **Step 2: Add the four names to `schema.test.ts`'s table array (alphabetized)**

`account`, `session`, `user`, `verification` sort in among the existing names. Add them, then run the test and take the DB's actual `order by 1` output as authoritative if the position differs.

- [ ] **Step 3: Run the schema test**

```bash
tsc -b && pnpm exec vitest run dist/aggregator/__tests__/schema.test.js
```
Expected: PASS (the table set now includes the four).

- [ ] **Step 4: Commit**

```bash
git add packages/aggregator/src/schema.ts src/aggregator/__tests__/schema.test.ts
git commit -m "feat(auth): better-auth user/account/session/verification tables in ensureSchema"
```

---

## Task 4: the `betterAuth` factory

**Files:** Create `packages/aggregator/src/auth/betterAuth.ts`; Modify `packages/aggregator/src/index.ts` (barrel).

**Interfaces:**
- Consumes: `fetchOrgMemberships`, `setAccountScopes` (`accountVerifier.ts`, `webAuth.ts`); the tables (Task 3).
- Produces: `makeAuth(opts: { db: AppDb; secret: string; baseURL: string; githubClientId: string; githubClientSecret: string }): ReturnType<typeof betterAuth>`.

- [ ] **Step 1: Write the factory (github provider + bearer + login field + org-capture hook)**

```ts
// packages/aggregator/src/auth/betterAuth.ts
import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { bearer } from "better-auth/plugins";
import type { AppDb } from "../schema.js";
import { schema } from "../schema.js";
import { fetchOrgMemberships } from "../accountVerifier.js";
import { setAccountScopes } from "../webAuth.js";

export function makeAuth(opts: { db: AppDb; secret: string; baseURL: string; githubClientId: string; githubClientSecret: string }) {
  return betterAuth({
    database: drizzleAdapter(opts.db as never, { provider: "pg" }),
    secret: opts.secret,
    baseURL: opts.baseURL,
    emailAndPassword: { enabled: false },
    plugins: [bearer()],
    user: { additionalFields: { login: { type: "string", required: false } } },
    socialProviders: {
      github: { clientId: opts.githubClientId, clientSecret: opts.githubClientSecret, scope: ["read:user", "read:org"] },
    },
    databaseHooks: {
      account: {
        create: {
          // After a github account row exists, capture org memberships into account_scopes — the
          // same capture the old callback did. Best-effort: NEVER throw (mirrors today's tolerance).
          after: async (account) => {
            if (account.providerId !== "github" || !account.accessToken) return;
            try {
              const login = (await opts.db.execute(
                // read the login we set on the user for the self scope
                // (schema-qualified select; user is quoted)
                (await import("drizzle-orm")).sql`select login from "user" where id = ${account.userId}`,
              )).rows?.[0] as { login?: string } | undefined;
              const memberships = await fetchOrgMemberships(account.accessToken).catch(() => []);
              const scopes = [
                ...(login?.login ? [{ scope: login.login, role: "self" as const }] : []),
                ...memberships.map((m) => ({ scope: m.login, role: m.role })),
              ];
              if (scopes.length) await setAccountScopes(opts.db, account.userId, scopes);
            } catch { /* org capture is additive; never fail sign-in */ }
          },
        },
      },
    },
  });
}
```

> The org-capture hook's access to `account.accessToken` is the item the spec flagged to confirm alongside the spikes. If the `account.create.after` hook does not receive `accessToken`, fall back to reading it from the stored `account` row inside the hook (`select access_token from "account" where id = ...`). Confirm during Task 1/2's spike session and adjust here; do not leave it assumed.

- [ ] **Step 2: Populate `user.login` on sign-in**

The github provider maps the profile to a user; ensure `login` is set from the GitHub profile. Add `mapProfileToUser` on the github provider: `mapProfileToUser: (p) => ({ login: p.login, name: p.name ?? p.login, image: p.avatar_url })`. Verify the field name against the generator's github profile shape.

- [ ] **Step 3: Export from the barrel; write a construction test**

`export * from "./auth/betterAuth.js";` in `packages/aggregator/src/index.ts`. Test that `makeAuth(...)` builds and `auth.api.getSession` returns null for a bogus bearer (proves the instance is wired without needing a real OAuth round-trip):

```ts
it("makeAuth builds and rejects an unknown bearer token", async () => {
  const db = await makeTestDb();
  const auth = makeAuth({ db, secret: "x".repeat(40), baseURL: "http://localhost", githubClientId: "id", githubClientSecret: "sec" });
  const got = await auth.api.getSession({ headers: new Headers({ authorization: "Bearer nope" }) });
  expect(got).toBeNull();
});
```

- [ ] **Step 4: Run + commit**

```bash
tsc -b && pnpm exec vitest run dist/aggregator/__tests__/betterAuth.test.js
git add packages/aggregator/src/auth/betterAuth.ts packages/aggregator/src/index.ts src/aggregator/__tests__/betterAuth.test.ts
git commit -m "feat(auth): betterAuth factory — github provider, bearer, login field, org-capture hook"
```

---

## Task 5: `resolveSession` shim over better-auth

**Files:** Modify `packages/aggregator/src/webAuth.ts`.

**Interfaces:**
- Consumes: an `auth` instance (Task 4).
- Produces: `resolveSession` with the UNCHANGED return type `{ login, avatarUrl, accountId } | null`, but now sourced from better-auth. Because callers pass `(db, token)` today, the shim is re-shaped to `resolveSession(auth, token)` and the four call sites (`catalog`, `groups`, `usage`, `orgsApi` installs) get the `auth` instance threaded through their deps.

- [ ] **Step 1: Write the failing test**

```ts
it("resolveSession returns {login, avatarUrl, accountId} from a better-auth session", async () => {
  const db = await makeTestDb();
  const auth = makeAuth({ db, secret: "x".repeat(40), baseURL: "http://localhost", githubClientId: "i", githubClientSecret: "s" });
  const ctx = await auth.$context;
  const id = crypto.randomUUID();
  await ctx.internalAdapter.createUser({ id, name: "neo", email: "n@x.invalid", emailVerified: true, login: "neo", image: "http://a/x.png" } as any);
  const { token } = await mintSession(auth, id);
  expect(await resolveSession(auth, token)).toEqual({ login: "neo", avatarUrl: "http://a/x.png", accountId: id });
  expect(await resolveSession(auth, "bogus")).toBeNull();
});
```

- [ ] **Step 2: Re-implement `resolveSession`; delete the mint helpers**

Replace `resolveSession` (and remove `generateSessionToken`/`createSession`/`deleteSession`, which the web OAuth and old bind used):

```ts
import type { betterAuth } from "better-auth";
export async function resolveSession(
  auth: ReturnType<typeof betterAuth>, token: string,
): Promise<{ login: string; avatarUrl: string | null; accountId: string } | null> {
  const res = await auth.api.getSession({ headers: new Headers({ authorization: `Bearer ${token}` }) });
  const u = res?.user as { id: string; login?: string; image?: string | null } | undefined;
  if (!u) return null;
  return { login: u.login ?? "", avatarUrl: u.image ?? null, accountId: u.id };
}
```

> `upsertAccount` and `setAccountScopes` STAY in `webAuth.ts` — they still write the legacy `accounts` table and `account_scopes`, which the FK anchor and org-gating depend on.

- [ ] **Step 3: Thread `auth` to the four call sites**

Each install module builds a `whoami`/`sessionLogin` that calls `resolveSession(deps.db, token)`. Change each `Deps` to carry `auth` and call `resolveSession(deps.auth, token)`:
`src/catalog/install.ts`, `src/groups/install.ts`, `src/usage/install.ts`, `src/githubApp/orgsApi.ts`. Update their `install*` signatures and the `src/index.ts` call sites to pass `auth`.

- [ ] **Step 4: Run the shim test + the four modules' tests + commit**

```bash
tsc -b && pnpm exec vitest run dist/aggregator/__tests__/webAuth.test.js dist/groups/__tests__/install.test.js dist/catalog/__tests__/install.test.js
git add packages/aggregator/src/webAuth.ts src/catalog/install.ts src/groups/install.ts src/usage/install.ts src/githubApp/orgsApi.ts
git commit -m "refactor(auth): resolveSession shim over better-auth; thread auth to route modules"
```

> The four modules' existing tests construct sessions via the old `createSession`. They must switch to `mintSession(auth, id)`. Update those test helpers as part of this task — the route behavior (401/403/404) is unchanged; only how a test mints a session changes.

---

## Task 6: the `accounts → user + account` migration

**Files:** Create `packages/aggregator/src/auth/migrateAccounts.ts`; Modify barrel.

**Interfaces:**
- Produces: `migrateAccountsToBetterAuth(db: AppDb): Promise<{ migrated: number }>` — idempotent.

- [ ] **Step 1: Write the failing test**

```ts
it("migrates accounts to user+account, preserving id, idempotently", async () => {
  const db = await makeTestDb();
  const a = await upsertAccount(db, { provider: "github", accountId: "12345", login: "neo", avatarUrl: "http://a/x.png" });
  // a related FK row that must stay valid
  await db.insert(stars).values({ id: crypto.randomUUID(), accountId: a.id, targetKind: "gem", targetId: "g" } as any);

  await migrateAccountsToBetterAuth(db);
  await migrateAccountsToBetterAuth(db); // idempotent

  const u = (await db.execute(sql`select id, login, image from "user" where id = ${a.id}`)).rows as any[];
  expect(u).toHaveLength(1);
  expect(u[0]).toMatchObject({ id: a.id, login: "neo", image: "http://a/x.png" });
  const acc = (await db.execute(sql`select user_id, provider_id, account_id from "account" where provider_id='github' and account_id='12345'`)).rows as any[];
  expect(acc[0].user_id).toBe(a.id);
  // the star still resolves through the shared id
  const s = (await db.execute(sql`select count(*)::int n from stars where account_id = ${a.id}`)).rows as any[];
  expect(s[0].n).toBe(1);
});
```

- [ ] **Step 2: Implement the idempotent backfill**

```ts
// packages/aggregator/src/auth/migrateAccounts.ts
import { sql } from "drizzle-orm";
import type { AppDb } from "../schema.js";
export async function migrateAccountsToBetterAuth(db: AppDb): Promise<{ migrated: number }> {
  // user: id = accounts.id (uuid as text); login/image carried over. Insert-if-absent.
  await db.execute(sql`
    insert into "user" (id, name, email_verified, image, login, created_at, updated_at)
    select a.id::text, a.login, false, a.avatar_url, a.login, now(), now()
    from accounts a
    on conflict (id) do nothing`);
  // account: one github row per account, keyed (provider_id, account_id). Insert-if-absent.
  const res = await db.execute(sql`
    insert into "account" (id, user_id, provider_id, account_id, created_at, updated_at)
    select gen_random_uuid()::text, a.id::text, a.provider, a.provider_account_id, now(), now()
    from accounts a
    on conflict (provider_id, account_id) do nothing`);
  return { migrated: (res as any).rowCount ?? 0 };
}
```

- [ ] **Step 3: Run + commit**

```bash
tsc -b && pnpm exec vitest run dist/aggregator/__tests__/migrateAccounts.test.js
git add packages/aggregator/src/auth/migrateAccounts.ts packages/aggregator/src/index.ts src/aggregator/__tests__/migrateAccounts.test.ts
git commit -m "feat(auth): idempotent accounts->user+account backfill, id preserved"
```

---

## Task 7: mount `auth.handler` at `/api/auth/*` with the body rebuild

**Files:** Create `src/auth/mount.ts`; Modify `src/index.ts`.

**Interfaces:**
- Consumes: an `auth` instance (Task 4).
- Produces: `mountAuth(expressApp, auth)` — all methods/subpaths under `/api/auth/`.

- [ ] **Step 1: Write `mount.ts` (hono shim + body rebuild)**

```ts
// src/auth/mount.ts
import { getRequestListener } from "@hono/node-server";
import type { betterAuth } from "better-auth";
type ExpressApp = { all(p: string, h: (req: any, res: any) => unknown): unknown };

export function mountAuth(expressApp: ExpressApp, auth: ReturnType<typeof betterAuth>): void {
  const listener = getRequestListener(async (request: Request) => auth.handler(request));
  expressApp.all("/api/auth/*", (req, res) => {
    // Global express.json() (src/index.ts) already drained the stream; rebuild the body so
    // better-auth's request.json() sees it. GET/HEAD carry no body.
    if (req.body !== undefined && req.body !== null && !["GET", "HEAD"].includes(req.method)) {
      const raw = Buffer.from(JSON.stringify(req.body));
      req.headers["content-length"] = String(raw.length);
      req.removeAllListeners?.("data"); req.removeAllListeners?.("end");
      // re-feed the parsed body as the stream getRequestListener reads
      process.nextTick(() => { req.emit("data", raw); req.emit("end"); });
    }
    return listener(req, res);
  });
}
```

> This is the spec's documented gotcha. If re-emitting the stream proves flaky under `@hono/node-server`, use the repo's `webRequestForWebDispatch()` pattern (`packages/rest/src/rest.server.ts:1599`) to build a `Request` directly from `req.body`+headers and call `auth.handler(request)` without the listener. Prefer whichever the mount test (Step 2) shows delivers a non-empty JSON body.

- [ ] **Step 2: Write a mount test that proves a JSON body survives**

Stand up a tiny express app with the same global `express.json()`, `mountAuth` a stub `auth` whose `handler` echoes `await request.json()`, POST a JSON body, assert the echo is non-empty. (This isolates the body-rebuild from better-auth.)

- [ ] **Step 3: Run + commit**

```bash
tsc -b && pnpm exec vitest run dist/auth/__tests__/mount.test.js
git add src/auth/mount.ts src/auth/__tests__/mount.test.ts
git commit -m "feat(auth): mount better-auth handler at /api/auth/* with body rebuild"
```

---

## Task 8: re-point the device-flow to mint a better-auth session

**Files:** Modify `packages/aggregator/src/binding.ts`.

**Interfaces:**
- Consumes: `mintSession` (Task 1), `migrateAccountsToBetterAuth`-shaped user rows; still uses `upsertAccount`/`setAccountScopes`.

- [ ] **Step 1: Update the failing binding test**

The existing `recordBinding` test asserts a `sessionToken` is returned. Change the test to pass an `auth` instance and assert the returned token is accepted by `resolveSession(auth, token)`.

- [ ] **Step 2: Re-point `recordBinding`**

`recordBinding` currently calls `generateSessionToken()` + `createSession(db, account.id, ...)`. Replace step 6 with: ensure a better-auth `user` (+ github `account`) exists for this account id (reuse the migration's insert-if-absent SQL for the single row), then `mintSession(auth, account.id)`. Thread `auth` into `recordBinding`'s signature (it already takes `verifier`/`orgs` as params — add `auth`). Keep every proof and the best-effort tolerance unchanged.

- [ ] **Step 3: Run + commit**

```bash
tsc -b && pnpm exec vitest run dist/aggregator/__tests__/binding.test.js
git add packages/aggregator/src/binding.ts src/aggregator/__tests__/binding.test.ts
git commit -m "feat(auth): device-flow bind mints a better-auth session"
```

---

## Task 9: SSO handoff mints a better-auth session; wire it all in `src/index.ts`; delete the old OAuth

**Files:** Modify `src/index.ts`; Delete `src/auth/install.ts`, `src/auth/state.ts`; adjust `packages/aggregator/src/webAuth.ts` (handoff redeem).

**Interfaces:**
- Consumes: `makeAuth`, `mountAuth`, `migrateAccountsToBetterAuth`, `mintSession`.

- [ ] **Step 1: Build the auth instance and mount it in `src/index.ts`**

Replace the `installAuth(...)` block (`src/index.ts:180-194`) with:

```ts
if (ghClientId && ghSecret && aggDb) {
  const auth = makeAuth({
    db: aggDb,
    secret: process.env.AGENTGEM_SESSION_SECRET ?? ghSecret,
    baseURL: process.env.AGENTGEM_PUBLIC_BASE ?? "https://api.agentgem.ai",
    githubClientId: ghClientId, githubClientSecret: ghSecret,
  });
  await migrateAccountsToBetterAuth(aggDb);          // one-time, idempotent, safe every boot
  mountAuth(server.expressApp as never, auth);
  // pass `auth` to the route installers (Task 5) and the bind controller (Task 8)
}
```

Thread the single `auth` into `installCatalog`/`installGroups`/`installUsage`/`installOrgsApi` (Task 5) and the `/api/aggregator/bind` controller (Task 8).

- [ ] **Step 2: Handoff redeem mints a better-auth session**

The handoff redeem path (in `webAuth.ts`/its controller) currently mints via `createSession`. Point it at `mintSession(auth, accountId)`. Keep `handoff_codes` and its single-use/60s semantics unchanged.

- [ ] **Step 3: Delete the hand-rolled web OAuth**

`git rm src/auth/install.ts src/auth/state.ts`. Remove their imports from `src/index.ts` (`installAuth`, `GitHubVerifier` if now unused there, `githubExchangeCode`). Keep `src/auth/cookie.ts` only if the handoff still reads a cookie; otherwise remove. `web_sessions` DDL stays in `ensureSchema` for now (dropping a table is a separate migration; it is simply unused) — note it as dead in a comment.

- [ ] **Step 4: Full suite + typecheck**

```bash
pnpm clean && pnpm test
```
Expected: PASS. Investigate any failure in the four route modules, binding, or handoff — those are the seams this plan moved.

- [ ] **Step 5: Drive it (staging-shaped)**

With `AGENTGEM_GITHUB_CLIENT_ID/SECRET` set and an aggregator DB, boot and confirm `GET /api/auth/ok` (or better-auth's session endpoint) responds, and that `GET /api/auth/sign-in/social` for github issues a redirect. A full GitHub round-trip needs real credentials — do it in staging, verifying: web login → session cookie → `/api/registry/gems` authed calls still work, and `agentgem bind` mints a working Bearer.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "feat(auth): cut over to better-auth — mount, migrate, handoff; delete hand-rolled OAuth"
```

---

## Self-Review

**Spec coverage.** Every spec element maps to a task: schema authority → Task 3; full-replace github provider + org-capture hook → Task 4; resolveSession shim → Task 5; migration (accounts.id=user.id) → Task 6; mount + body gotcha → Task 7; device-flow + handoff minting better-auth sessions → Tasks 8–9; delete hand-rolled OAuth + force-re-auth cutover → Task 9; both spikes → Tasks 1–2 (first, gating).

**Design refinement made explicit:** `accounts` is retained as the FK anchor and `user.id` shares its id as text — this refines the spec's "migration" wording (accounts is not superseded in Phase 1) and avoids a uuid→text FK re-type. Flagged at the top and in Task 6.

**Honest uncertainty, gated not hidden:** the two most uncertain facts — server-side session creation and pre-migrated-account linking — are Tasks 1–2 with explicit STOP/escalate gates, because a failure reshapes the design. The org-capture hook's access-token availability is flagged in Task 4 with a concrete fallback.

**Out of scope (sequels):** Google/Slack/X, passkey, `linkSocial`, email verification (Phase 2); the `login`-string ownership re-key and retiring `accounts`/`web_sessions` (Phase 3).

**Type consistency:** `mintSession(auth, userId) → { token, expiresAt }`, `resolveSession(auth, token) → { login, avatarUrl, accountId } | null`, `makeAuth(opts) → auth`, `migrateAccountsToBetterAuth(db) → { migrated }` are used consistently across Tasks 1, 4, 5, 6, 8, 9.
