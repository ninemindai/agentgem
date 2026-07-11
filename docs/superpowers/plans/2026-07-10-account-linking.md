# Account Linking Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a logged-in user connect a second sign-in provider (GitHub ⇄ Google) to one account — natively when the provider is unused, by absorbing a *fresh* second account when it isn't.

**Architecture:** Reframe the legacy `accounts` row as a per-user authorization anchor (one per `user.id`, not one per provider); better-auth's `account` table already holds the per-provider records. Flow A is native `linkSocial`. Flow B is a credentialed `POST /api/account/absorb` that re-points a *fresh* account's provider rows onto the account being kept and deletes the empty one. A new `/account` SPA page drives both.

**Tech Stack:** better-auth (`packages/aggregator/src/auth/betterAuth.ts`), Drizzle + Postgres (`packages/aggregator/src/schema.ts`), raw Express installers under `src/**/install.ts`, Vitest (root `src/**/__tests__`, compiled to `dist/` and gated by CI), React marketplace SPA (`packages/marketplace`).

## Global Constraints

- **Node floor `>=24`.** CI runs `test (24)` + `test (26)`.
- **Tests must live under the ROOT `src/**/__tests__`** and import from the built `@agentgem/aggregator` package. CI only gates the root `dist/__tests__` suite; `packages/*/src/__tests__` never runs in CI. (Per repo memory: put backend tests at root importing the built package.)
- **`accounts.id` is the authorization uuid** that owns gems/stars/reviews/scopes/usage. `accounts.id === user.id === account.userId` for a user's anchor (the anchor is always written with `id = account.userId`). Never introduce a second id scheme.
- **`absorb` MUST NEVER trust a client-supplied account id for the account being absorbed.** The identity of the "other" account is derived only from a server-verified OAuth (Task 0's seam).
- **No FK to `accounts.id` has `ON DELETE CASCADE`** (verified in `schema.ts`). A child row on a deleted anchor is a hard error, not a silent cascade. Deleting an anchor is legal only when it is provably FK-empty.
- **Better-auth config values, verbatim:** `account: { accountLinking: { enabled: true, trustedProviders: ["github", "google"], allowDifferentEmails: true } }`.
- **Credentialed cross-origin routes** mirror `src/handles/install.ts`: per-origin `Access-Control-Allow-Credentials: true` CORS, `resolveSession` gate, and an entry in `src/originGuard.ts`'s exempt prefix list.

---

## File Structure

- `packages/aggregator/src/auth/betterAuth.ts` — anchor idempotency fix + `accountLinking` config (modify).
- `packages/aggregator/src/auth/accountLinking.ts` — **new**: `accountIdForProvider`, `connectedProviders`, `accountFreshness`, `absorbAccount`. Pure DB functions; the Express route is a thin adapter over these.
- `packages/aggregator/src/catalog.ts` / `packages/aggregator/src/profile.ts` — swap the legacy `accounts.provider` join for a provider→account lookup that sees linked providers (modify).
- `packages/aggregator/src/index.ts` — re-export the new module (modify, one line).
- `src/account/install.ts` — **new**: `installAccount` (the `/api/account/absorb` + `/api/account/providers` routes), mirroring `src/handles/install.ts`.
- `src/index.ts` — wire `installAccount` after `mountAuth` (modify).
- `src/originGuard.ts` — add `/api/account/` to the exempt prefix list (modify one line).
- `packages/marketplace/src/pages/Account.tsx` + `Router.tsx` + nav — the SPA surface (new + modify).
- Tests: `src/aggregator/__tests__/accountLinking.test.ts`, `src/aggregator/__tests__/betterAuth.test.ts` (extend), `src/account/__tests__/absorb.route.test.ts`, `packages/marketplace/src/pages/Account.test.tsx`.

---

## Task 0: Spike — prove the "other-account identity" seam (GATES Flow B)

**Why first:** Flow B's entire security model depends on `absorb` learning the identity of the *other* account from an OAuth that better-auth **rejected** with "account already linked". If better-auth aborts that OAuth without persisting the resolved provider identity anywhere server-side, there is nothing to hand `absorb` — and the client must not supply it. This spike decides whether Flow B piggybacks on `linkSocial`'s rejection or needs a bespoke connect-OAuth route. **Do not build Tasks 5–6 until this is answered.**

**Files:**
- Spike scratch: `src/aggregator/__tests__/absorbSeam.spike.test.ts` (may be deleted after the seam is chosen).

**Interfaces:**
- Produces: a documented decision + a stable function signature the later tasks consume:
  `pendingLink(db, sessionUserId): Promise<{ providerId: string; providerAccountId: string } | null>` —
  returns the server-verified identity of the provider the caller just OAuth'd but could not link
  (because it belongs to another user), scoped to the caller's session. `null` if there is no
  pending, server-verified link for this session.

- [ ] **Step 1: Reproduce the rejection and inspect what better-auth persists**

Write a spike test that drives `linkSocial` for a provider identity already owned by a *different* user, and asserts what (if anything) is left in the DB (`account`, `verification`, any better-auth state) that ties the resolved provider identity to the caller's session.

```ts
// src/aggregator/__tests__/absorbSeam.spike.test.ts
import { describe, it, expect } from "vitest";
import { sql } from "drizzle-orm";
import { makeTestDb, makeAuth } from "@agentgem/aggregator";

describe("absorb seam spike", () => {
  it("shows what better-auth leaves behind when linkSocial hits an already-linked provider", async () => {
    const db = await makeTestDb();
    const auth = makeAuth({ db, secret: "s", baseURL: "http://localhost:4000/api/auth",
      githubClientId: "gid", githubClientSecret: "gsec",
      googleClientId: "ggid", googleClientSecret: "ggsec",
      webOrigins: ["http://localhost:3000"] });
    const ctx = await auth.$context;
    // user A (caller) with github; user B owning the google identity we will try to link to A.
    const a = await ctx.internalAdapter.createUser({ email: "a@x.com", name: "A", emailVerified: false } as never);
    const b = await ctx.internalAdapter.createUser({ email: "b@y.com", name: "B", emailVerified: false } as never);
    await db.execute(sql`insert into account (id, user_id, account_id, provider_id, created_at, updated_at)
      values (gen_random_uuid()::text, ${b.id}, 'google-123', 'google', now(), now())`);
    // Drive linkSocial for A → google-123 (owned by B) and observe the failure + residue.
    // Document: does any row/state now tie google-123 to A's session? Print it.
    const rows = await db.execute(sql`select provider_id, account_id, user_id from account`);
    console.log("account rows after attempted link:", rows.rows);
    expect(rows.rows.length).toBeGreaterThan(0); // placeholder — real assertions decided by findings
  });
});
```

- [ ] **Step 2: Run the spike and record findings**

Run: `pnpm -w build && pnpm -w vitest run src/aggregator/__tests__/absorbSeam.spike.test.ts`
Expected: the test prints better-auth's residual state. Record in the plan's follow-up notes which of these is true:
  - **(a)** better-auth exposes a link hook / callback that fires with the resolved `(providerId, accountId)` *before* the conflict check — capture it there.
  - **(b)** nothing usable is persisted — Flow B needs a **bespoke connect-OAuth route** (`/api/account/connect/:provider/callback`) that resolves the provider identity itself, then branches link-vs-absorb. `linkSocial` is not reused for the collision case.

- [ ] **Step 3: Implement `pendingLink` per the chosen seam**

Implement `pendingLink(db, sessionUserId)` in `packages/aggregator/src/auth/accountLinking.ts` (created here, extended in Task 3). It must:
  - Return the identity **only** from server-verified OAuth state tied to `sessionUserId` (never a request body).
  - Return `null` when no such pending link exists.

If seam (b) won: also stub the bespoke callback route's contract here (a short-lived server record keyed to the session storing the OAuth-resolved identity), so Task 6 has a stable `pendingLink` to read.

- [ ] **Step 4: Write a discriminating test for `pendingLink`**

```ts
// in accountLinking.test.ts (Task 4 file); add now:
it("pendingLink returns the OAuth-verified other-provider identity for this session, else null", async () => {
  const db = await makeTestDb();
  // Arrange: drive the chosen seam so session U has a pending link to (provider, providerAccountId).
  // Assert the identity is returned for U and null for an unrelated session V.
  // Discriminating: a client cannot fabricate a pending link by naming a victim id — pendingLink
  // ignores any request-supplied id and reads only server-verified state.
});
```

- [ ] **Step 5: Commit**

```bash
git add packages/aggregator/src/auth/accountLinking.ts src/aggregator/__tests__/
git commit -m "spike(auth): establish the absorb other-identity seam (pendingLink)"
```

---

## Task 1: Make the legacy anchor per-user and idempotent

**Files:**
- Modify: `packages/aggregator/src/auth/betterAuth.ts` (`anchorAndScopes`)
- Test: `src/aggregator/__tests__/betterAuth.test.ts`

**Interfaces:**
- Consumes: `upsertAccount` (`webAuth.ts`), unchanged.
- Produces: after linking an N-th provider to an existing `user`, there is still **exactly one** `accounts` row for that `user.id`, stamped with the *primary* (first) provider's `provider`/`login`/`avatar`.

- [ ] **Step 1: Write the failing test — a second provider must not throw and must not add an anchor row**

```ts
// src/aggregator/__tests__/betterAuth.test.ts
it("linking a second provider adds no second accounts anchor and does not throw", async () => {
  const db = await makeTestDb();
  const auth = makeAuth({ db, ...opts });
  const ctx = await auth.$context;
  const user = await ctx.internalAdapter.createUser({ email: "neo@x.com", name: "Neo", emailVerified: false, login: "neo" } as never);
  // Primary provider anchor (as anchorAndScopes writes it on first github sign-in):
  await upsertAccount(db, { provider: "github", accountId: "gh-neo", login: "neo", avatarUrl: null, id: user.id });
  // Simulate the account.create hook firing for a SECOND provider on the same user:
  await expect(
    (async () => {
      const { anchorAndScopesForTest } = await import("@agentgem/aggregator");
      await anchorAndScopesForTest(db, { userId: user.id, providerId: "google", accountId: "goog-neo", accessToken: null }, true);
    })()
  ).resolves.not.toThrow();
  const rows = await db.execute(sql`select provider, login from accounts where id = ${user.id}`);
  expect(rows.rows).toHaveLength(1);
  expect((rows.rows[0] as { provider: string }).provider).toBe("github"); // primary stamp unchanged
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `pnpm -w build && pnpm -w vitest run src/aggregator/__tests__/betterAuth.test.ts -t "second provider"`
Expected: FAIL — either a duplicate-PK throw (today's behavior) or `anchorAndScopesForTest` is not exported.

- [ ] **Step 3: Implement the idempotency guard**

In `packages/aggregator/src/auth/betterAuth.ts`, change `anchorAndScopes` so it writes the anchor **only when none exists for `account.userId`**. Export a thin test seam.

```ts
export async function anchorAndScopesForTest(
  db: AppDb,
  account: { userId: string; providerId: string; accountId: string; accessToken?: string | null },
  isCreate: boolean,
) { return anchorAndScopes(db, account, isCreate); }

async function anchorAndScopes(db: AppDb, account: {...}, isCreate: boolean) {
  const row = (await db.execute(sql`select login, image from "user" where id = ${account.userId}`)).rows?.[0] as
    { login?: string; image?: string } | undefined;
  const login = account.providerId === "github" ? (row?.login ?? null) : null;

  // The anchor is PER-USER: one row per user.id, stamped by the FIRST provider that created it.
  // A second linked provider needs NO new anchor — the existing one already authorizes the user,
  // and accounts.id is a PK, so writing a second row for the same user.id is a duplicate-PK throw.
  // better-auth's `account` table holds the per-provider records natively; the anchor never does.
  const existing = (await db.execute(sql`select 1 from accounts where id = ${account.userId} limit 1`)).rows?.length ?? 0;
  if (existing === 0) {
    // Only CREATE-with-no-anchor is load-bearing (no anchor ⇒ broken user ⇒ must abort sign-in).
    if (isCreate) {
      await upsertAccount(db, { provider: account.providerId, accountId: account.accountId, login, avatarUrl: row?.image ?? null, id: account.userId });
    } else {
      try { await upsertAccount(db, { provider: account.providerId, accountId: account.accountId, login, avatarUrl: row?.image ?? null, id: account.userId }); } catch { /* best-effort */ }
    }
  }
  // Org-scope capture is unchanged and still runs per the github/accessToken guards below.
  if (account.providerId !== "github" || !login) return;
  try { await claimHandleIfUnset(db, account.userId, login); } catch { /* best-effort */ }
  try {
    if (account.accessToken) {
      const memberships = await fetchOrgMemberships(account.accessToken);
      await setAccountScopes(db, account.userId, memberships.map((m) => ({ scope: m.login, role: m.role })));
    }
  } catch { /* additive */ }
}
```

- [ ] **Step 4: Run the test to verify it passes + full betterAuth suite still green**

Run: `pnpm -w build && pnpm -w vitest run src/aggregator/__tests__/betterAuth.test.ts`
Expected: PASS (all cases, including the pre-existing orgs/TTL tests).

- [ ] **Step 5: Commit**

```bash
git add packages/aggregator/src/auth/betterAuth.ts src/aggregator/__tests__/betterAuth.test.ts
git commit -m "fix(auth): make the legacy accounts anchor per-user and idempotent (enables linking)"
```

---

## Task 2: Resolve a *linked* provider back to its account (close the publish/verified regression)

**Why:** After Task 1 the anchor stores only the **primary** provider's `(provider, providerAccountId)`. Three sites resolve identity by that legacy key — `catalog.ts:149` (gem-publish ownership) and `profile.ts:89` (verified badge) via the desktop `account_bindings` **GitHub** identity. A Google-primary user who links GitHub and then uses the desktop app would have a `github` binding that the anchor (stamped `google`) can't match → publish rejected `not-connected`, verified `false`. Resolve via better-auth's `account` table, which is authoritative for *every* provider.

**Files:**
- Create: `packages/aggregator/src/auth/accountLinking.ts` (add `accountIdForProvider`)
- Modify: `packages/aggregator/src/catalog.ts` (the `accounts.provider` lookup ~line 149)
- Modify: `packages/aggregator/src/profile.ts` (the `join accounts a on a.provider ...` ~line 89)
- Modify: `packages/aggregator/src/index.ts` (`export * from "./auth/accountLinking.js";`)
- Test: `src/aggregator/__tests__/accountLinking.test.ts`

**Interfaces:**
- Produces: `accountIdForProvider(db, providerId, providerAccountId): Promise<string | null>` — the owning
  `accounts.id` uuid (= `account.userId`) for any provider identity, primary or linked; `null` if unknown.

- [ ] **Step 1: Write the failing test — a linked (non-primary) provider still resolves to the owner**

```ts
// src/aggregator/__tests__/accountLinking.test.ts
import { describe, it, expect } from "vitest";
import { sql } from "drizzle-orm";
import { makeTestDb, makeAuth, upsertAccount, accountIdForProvider } from "@agentgem/aggregator";

it("accountIdForProvider resolves a linked provider whose identity is NOT the anchor stamp", async () => {
  const db = await makeTestDb();
  const auth = makeAuth({ db, secret: "s", baseURL: "http://localhost:4000/api/auth",
    githubClientId: "g", githubClientSecret: "g", googleClientId: "g", googleClientSecret: "g",
    webOrigins: ["http://localhost:3000"] });
  const ctx = await auth.$context;
  const u = await ctx.internalAdapter.createUser({ email: "u@x.com", name: "U", emailVerified: false } as never);
  // Anchor stamped with the PRIMARY provider (google), per Task 1.
  await upsertAccount(db, { provider: "google", accountId: "goog-u", login: null, avatarUrl: null, id: u.id });
  // A LINKED github provider lives only in better-auth's `account` table.
  await db.execute(sql`insert into account (id, user_id, account_id, provider_id, created_at, updated_at)
    values (gen_random_uuid()::text, ${u.id}, 'gh-u', 'github', now(), now())`);
  expect(await accountIdForProvider(db, "github", "gh-u")).toBe(u.id); // was null via the anchor join
  expect(await accountIdForProvider(db, "google", "goog-u")).toBe(u.id);
  expect(await accountIdForProvider(db, "github", "nope")).toBeNull();
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `pnpm -w build && pnpm -w vitest run src/aggregator/__tests__/accountLinking.test.ts -t "accountIdForProvider"`
Expected: FAIL — `accountIdForProvider` not exported.

- [ ] **Step 3: Implement `accountIdForProvider` and swap the two legacy lookups**

```ts
// packages/aggregator/src/auth/accountLinking.ts
import { sql } from "drizzle-orm";
import type { AppDb } from "../schema.js";

/** The owning account uuid for a provider identity, primary OR linked. better-auth's `account`
 *  table is authoritative for every provider; `account.user_id` equals the legacy `accounts.id`
 *  anchor uuid (the anchor is always written with id = user.id). The legacy `accounts.provider`
 *  columns hold only the PRIMARY provider, so they must NOT be used to resolve a linked provider. */
export async function accountIdForProvider(db: AppDb, providerId: string, providerAccountId: string): Promise<string | null> {
  const rows = (await db.execute(sql`
    select user_id from account where provider_id = ${providerId} and account_id = ${providerAccountId} limit 1`)).rows;
  return (rows?.[0] as { user_id?: string } | undefined)?.user_id ?? null;
}
```

In `catalog.ts`, replace the `db.select({ id: accounts.id }).from(accounts).where(and(eq(accounts.provider, bind.provider), eq(accounts.providerAccountId, bind.accountId)))` block with:

```ts
const acctId = await accountIdForProvider(db, bind.provider, bind.accountId);
if (!acctId) return { shared: false, rejected: "not-connected" };
// ...use acctId where `acct.id` was used
```

In `profile.ts`, replace the `join accounts a on a.provider = ab.provider and a.provider_account_id = ab.account_id` verified check with a join through better-auth's per-provider `account` table (so a *linked* provider's desktop binding still verifies the owner):

```ts
// `verified` follows the ACCOUNT, not the name. A desktop binding carries a PROVIDER identity;
// join it to better-auth's `account` table (authoritative for every linked provider) to reach the
// owning account. The legacy `accounts.provider` columns hold only the primary provider, so a
// Google-primary user who linked GitHub would fail to verify against the anchor.
const bind = await db.execute(sql`
  select 1 from account_bindings ab
  join account a on a.provider_id = ab.provider and a.account_id = ab.account_id
  where a.user_id = ${accountId} limit 1`);
const verified = (bind.rows?.length ?? 0) > 0;
```

- [ ] **Step 4: Add regression tests for both sites and run them**

Add to `accountLinking.test.ts`: (1) `recordCatalogShare` from a desktop binding whose GitHub identity is a *linked* (non-primary) provider records ownership to the right account; (2) `buildProfile` returns `verified: true` for such an account. Run:

Run: `pnpm -w build && pnpm -w vitest run src/aggregator/__tests__/accountLinking.test.ts src/aggregator/__tests__/catalogController.test.ts src/aggregator/__tests__/profileController.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/aggregator/src/auth/accountLinking.ts packages/aggregator/src/catalog.ts packages/aggregator/src/profile.ts packages/aggregator/src/index.ts src/aggregator/__tests__/accountLinking.test.ts
git commit -m "fix(auth): resolve linked providers via better-auth account table, not the primary-only anchor"
```

---

## Task 3: Enable native account linking (Flow A) + `connectedProviders`

**Files:**
- Modify: `packages/aggregator/src/auth/betterAuth.ts` (`makeAuth` config)
- Modify: `packages/aggregator/src/auth/accountLinking.ts` (add `connectedProviders`)
- Test: `src/aggregator/__tests__/betterAuth.test.ts`, `src/aggregator/__tests__/accountLinking.test.ts`

**Interfaces:**
- Produces: `connectedProviders(db, accountId): Promise<string[]>` — the provider ids linked to an account (e.g. `["github","google"]`), sorted.

- [ ] **Step 1: Write the failing test for `connectedProviders`**

```ts
it("connectedProviders lists every provider linked to the account, sorted", async () => {
  const db = await makeTestDb();
  const auth = makeAuth({ db, ...opts, googleClientId: "g", googleClientSecret: "g" });
  const ctx = await auth.$context;
  const u = await ctx.internalAdapter.createUser({ email: "u@x.com", name: "U", emailVerified: false } as never);
  await db.execute(sql`insert into account (id, user_id, account_id, provider_id, created_at, updated_at) values
    (gen_random_uuid()::text, ${u.id}, 'gh', 'github', now(), now()),
    (gen_random_uuid()::text, ${u.id}, 'go', 'google', now(), now())`);
  const { connectedProviders } = await import("@agentgem/aggregator");
  expect(await connectedProviders(db, u.id)).toEqual(["github", "google"]);
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `pnpm -w build && pnpm -w vitest run src/aggregator/__tests__/accountLinking.test.ts -t "connectedProviders"`
Expected: FAIL — not exported.

- [ ] **Step 3: Implement `connectedProviders` and add the `accountLinking` config**

```ts
// accountLinking.ts
export async function connectedProviders(db: AppDb, accountId: string): Promise<string[]> {
  const rows = (await db.execute(sql`select distinct provider_id from account where user_id = ${accountId} order by provider_id`)).rows ?? [];
  return rows.map((r) => (r as { provider_id: string }).provider_id);
}
```

In `makeAuth`'s `config`, add the top-level `account` block:

```ts
account: {
  accountLinking: { enabled: true, trustedProviders: ["github", "google"], allowDifferentEmails: true },
},
```

- [ ] **Step 4: Add the Flow-A integration assertion and run**

Add to `betterAuth.test.ts`: after Task 1's anchor fix, linking a second provider to a user leaves one anchor and `connectedProviders` lists both. Also assert `allowDifferentEmails` linking is permitted at config level (a github user, email A, and a google account, email B).

Run: `pnpm -w build && pnpm -w vitest run src/aggregator/__tests__/betterAuth.test.ts src/aggregator/__tests__/accountLinking.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/aggregator/src/auth/betterAuth.ts packages/aggregator/src/auth/accountLinking.ts src/aggregator/__tests__/
git commit -m "feat(auth): enable native account linking (trusted providers, different emails) + connectedProviders"
```

---

## Task 4: `accountFreshness` — the C-guard over EVERY FK to `accounts.id`

**Why:** The spec's five-part gate (handle, gems, stars, reviews, groups) is not FK-complete. Ten tables FK `accounts.id` with **no cascade**; a "fresh" account that reported console usage (`usage_days`) or is a GitHub org member (`account_scopes`) would pass the five-part gate but make `DELETE accounts` throw. Freshness here means **provably FK-empty AND no handle**.

**Files:**
- Modify: `packages/aggregator/src/auth/accountLinking.ts` (add `accountFreshness`)
- Test: `src/aggregator/__tests__/accountLinking.test.ts`

**Interfaces:**
- Produces: `accountFreshness(db, accountId): Promise<{ fresh: boolean; blocker: string | null }>` —
  `fresh: true, blocker: null` only when the account has no handle and no row in ANY table FK-ing
  `accounts.id`. Otherwise `fresh: false` and `blocker` names the first non-empty source (for the
  message and discriminating tests).

- [ ] **Step 1: Write failing tests — one per blocker source**

```ts
// accountLinking.test.ts
import { makeTestDb, upsertAccount, accountFreshness } from "@agentgem/aggregator";

async function freshAccount(db) {
  const id = crypto.randomUUID();
  await upsertAccount(db, { provider: "google", accountId: "g-" + id, login: null, avatarUrl: null, id });
  return id;
}

it("a just-anchored account with nothing attached is fresh", async () => {
  const db = await makeTestDb();
  const id = await freshAccount(db);
  expect(await accountFreshness(db, id)).toEqual({ fresh: true, blocker: null });
});

it.each([
  ["handle",        (db, id) => db.execute(sql`update "user" set handle = 'x' where id = ${id}`)],
  ["gem",           (db, id) => db.execute(sql`insert into catalog_gems (gem_key, version, published_by, created_at_ms, owner_account_id) values ('k','1','x',0,${id})`)],
  ["gem_archive",   (db, id) => db.execute(sql`insert into gem_archives (gem_key, version, bytes, size, digest, created_at_ms, owner_account_id) values ('k','1','\\x00'::bytea,1,'d',0,${id})`)],
  ["star",          (db, id) => db.execute(sql`insert into stars (id, account_id, target_kind, target_id) values (gen_random_uuid(), ${id}, 'skill', 't')`)],
  ["review",        (db, id) => db.execute(sql`insert into reviews (id, account_id, target_kind, target_id, rating) values (gen_random_uuid(), ${id}, 'skill', 't', 5)`)],
  ["group_member",  (db, id) => db.execute(sql`insert into group_members (group_id, account_id) values (gen_random_uuid(), ${id})`)],
  ["account_scope", (db, id) => db.execute(sql`insert into account_scopes (account_id, scope, role) values (${id}, 'org', 'member')`)],
  ["usage",         (db, id) => db.execute(sql`insert into usage_days (account_id, machine, scope, date) values (${id}, 'm', '', '2026-07-10')`)],
  ["handoff",       (db, id) => db.execute(sql`insert into handoff_codes (code_hash, account_id, expires_at) values ('h', ${id}, now())`)],
])("is NOT fresh when it has a %s", async (blocker, seed) => {
  const db = await makeTestDb();
  const id = await freshAccount(db);
  // seed a matching user row for the handle case
  await db.execute(sql`insert into "user" (id, name, email, email_verified, created_at, updated_at) values (${id}, 'U', ${'u'+id+'@x.com'}, false, now(), now()) on conflict do nothing`);
  await seed(db, id);
  const r = await accountFreshness(db, id);
  expect(r.fresh).toBe(false);
  expect(r.blocker).toBe(blocker);
});
```

- [ ] **Step 2: Run and watch them fail**

Run: `pnpm -w build && pnpm -w vitest run src/aggregator/__tests__/accountLinking.test.ts -t "fresh"`
Expected: FAIL — `accountFreshness` not exported.

- [ ] **Step 3: Implement `accountFreshness` covering every FK source**

```ts
// accountLinking.ts — checks are ordered so `blocker` is stable/testable.
const FRESHNESS_CHECKS: Array<{ blocker: string; q: (id: string) => ReturnType<typeof sql> }> = [
  { blocker: "handle",        q: (id) => sql`select 1 from "user" where id = ${id} and handle is not null limit 1` },
  { blocker: "gem",           q: (id) => sql`select 1 from catalog_gems where owner_account_id = ${id} limit 1` },
  { blocker: "gem_archive",   q: (id) => sql`select 1 from gem_archives where owner_account_id = ${id} limit 1` },
  { blocker: "star",          q: (id) => sql`select 1 from stars where account_id = ${id} limit 1` },
  { blocker: "review",        q: (id) => sql`select 1 from reviews where account_id = ${id} limit 1` },
  { blocker: "group_member",  q: (id) => sql`select 1 from group_members where account_id = ${id} limit 1` },
  { blocker: "group_owner",   q: (id) => sql`select 1 from groups where created_by = ${id} limit 1` },
  { blocker: "group_invite",  q: (id) => sql`select 1 from group_invites where created_by = ${id} limit 1` },
  { blocker: "account_scope", q: (id) => sql`select 1 from account_scopes where account_id = ${id} limit 1` },
  { blocker: "usage",         q: (id) => sql`select 1 from usage_days where account_id = ${id} limit 1` },
  { blocker: "usage_model",   q: (id) => sql`select 1 from usage_day_models where account_id = ${id} limit 1` },
  { blocker: "handoff",       q: (id) => sql`select 1 from handoff_codes where account_id = ${id} limit 1` },
];

export async function accountFreshness(db: AppDb, accountId: string): Promise<{ fresh: boolean; blocker: string | null }> {
  for (const c of FRESHNESS_CHECKS) {
    const hit = (await db.execute(c.q(accountId))).rows?.length ?? 0;
    if (hit > 0) return { fresh: false, blocker: c.blocker };
  }
  return { fresh: true, blocker: null };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm -w build && pnpm -w vitest run src/aggregator/__tests__/accountLinking.test.ts -t "fresh"`
Expected: PASS (all `it.each` cases).

- [ ] **Step 5: Commit**

```bash
git add packages/aggregator/src/auth/accountLinking.ts src/aggregator/__tests__/accountLinking.test.ts
git commit -m "feat(auth): accountFreshness gate covering every accounts.id FK (no silent orphan on absorb)"
```

---

## Task 5: `absorbAccount` — the one-transaction attach-and-discard

**Files:**
- Modify: `packages/aggregator/src/auth/accountLinking.ts` (add `absorbAccount`)
- Test: `src/aggregator/__tests__/accountLinking.test.ts`

**Interfaces:**
- Consumes: `accountFreshness` (Task 4), `connectedProviders` (Task 3).
- Produces: `absorbAccount(db, { current, other }): Promise<{ ok: true; keep: string } | { ok: false; reason: "merge-not-supported" | "same-account" }>` —
  `current` = caller-session account uuid, `other` = the OAuth-verified other account uuid. Re-points
  `other`↔`current` (whichever is fresh gets dropped) in ONE transaction and returns the survivor id.

- [ ] **Step 1: Write failing tests — happy path, both-fresh, and the C-guard refusal**

```ts
it("absorb re-points the fresh account's providers to the data-bearing survivor and deletes the empty user", async () => {
  const db = await makeTestDb();
  const auth = makeAuth({ db, ...opts, googleClientId: "g", googleClientSecret: "g" });
  const ctx = await auth.$context;
  const keep = await ctx.internalAdapter.createUser({ email: "keep@x.com", name: "K", emailVerified: false } as never); // data-bearing
  const drop = await ctx.internalAdapter.createUser({ email: "drop@x.com", name: "D", emailVerified: false } as never); // fresh
  await upsertAccount(db, { provider: "github", accountId: "gh-keep", login: "keep", avatarUrl: null, id: keep.id });
  await upsertAccount(db, { provider: "google", accountId: "go-drop", login: null, avatarUrl: null, id: drop.id });
  await db.execute(sql`insert into account (id, user_id, account_id, provider_id, created_at, updated_at) values
    (gen_random_uuid()::text, ${keep.id}, 'gh-keep', 'github', now(), now()),
    (gen_random_uuid()::text, ${drop.id}, 'go-drop', 'google', now(), now())`);
  await db.execute(sql`update "user" set handle = 'keep' where id = ${keep.id}`); // keep is data-bearing
  const { absorbAccount, connectedProviders } = await import("@agentgem/aggregator");

  const r = await absorbAccount(db, { current: keep.id, other: drop.id });
  expect(r).toEqual({ ok: true, keep: keep.id });
  expect(await connectedProviders(db, keep.id)).toEqual(["github", "google"]); // absorbed
  expect((await db.execute(sql`select 1 from "user" where id = ${drop.id}`)).rows).toHaveLength(0); // gone
  expect((await db.execute(sql`select 1 from accounts where id = ${drop.id}`)).rows).toHaveLength(0); // anchor gone
});

it("absorb refuses (merge-not-supported) when NEITHER account is fresh", async () => {
  // both have handles/gems → r = { ok: false, reason: "merge-not-supported" }
});

it("when BOTH are fresh, current survives", async () => {
  // r.keep === current.id; other is dropped
});
```

- [ ] **Step 2: Run and watch them fail**

Run: `pnpm -w build && pnpm -w vitest run src/aggregator/__tests__/accountLinking.test.ts -t "absorb"`
Expected: FAIL — `absorbAccount` not exported.

- [ ] **Step 3: Implement `absorbAccount` in one transaction, minting no orphan**

```ts
// accountLinking.ts
export async function absorbAccount(
  db: AppDb,
  { current, other }: { current: string; other: string },
): Promise<{ ok: true; keep: string } | { ok: false; reason: "merge-not-supported" | "same-account" }> {
  if (current === other) return { ok: false, reason: "same-account" };
  const [fc, fo] = [await accountFreshness(db, current), await accountFreshness(db, other)];
  if (!fc.fresh && !fo.fresh) return { ok: false, reason: "merge-not-supported" };
  // keep = data-bearing side; if both fresh, current survives (spec).
  const keep = fc.fresh && !fo.fresh ? other : current;
  const drop = keep === current ? other : current;

  await db.transaction(async (tx) => {
    // 1. Move the fresh account's per-provider rows onto the survivor. (drop is FK-empty per the
    //    freshness gate, so ONLY its better-auth `account` rows carry the providers we keep.)
    await tx.execute(sql`update account set user_id = ${keep} where user_id = ${drop}`);
    // 2. Delete the fresh account's legacy anchor. Safe: freshness proved no child rows FK it.
    await tx.execute(sql`delete from accounts where id = ${drop}`);
    // 3. Delete the fresh better-auth user. session (and any residual account rows) cascade on user.
    await tx.execute(sql`delete from "user" where id = ${drop}`);
  });
  return { ok: true, keep };
}
```

- [ ] **Step 4: Run absorb tests + confirm no FK violation path**

Run: `pnpm -w build && pnpm -w vitest run src/aggregator/__tests__/accountLinking.test.ts`
Expected: PASS. Add one more case: an account that is fresh-by-the-old-5-but has a `usage_days` row is refused as `merge-not-supported` (proves Task 4 wired into absorb).

- [ ] **Step 5: Commit**

```bash
git add packages/aggregator/src/auth/accountLinking.ts src/aggregator/__tests__/accountLinking.test.ts
git commit -m "feat(auth): absorbAccount — one-transaction attach fresh account + delete empty user"
```

---

## Task 6: `POST /api/account/absorb` + `/api/account/providers` route

**Files:**
- Create: `src/account/install.ts`
- Create: `src/account/__tests__/absorb.route.test.ts`
- Modify: `src/index.ts` (wire `installAccount` after `mountAuth`)
- Modify: `src/originGuard.ts` (add `/api/account/` to the exempt prefix list, line ~92)

**Interfaces:**
- Consumes: `resolveSession`, `absorbAccount`, `connectedProviders`, `accountIdForProvider`, `pendingLink` (Task 0).
- Produces: `installAccount(expressApp, { db, auth, webOrigins })`.

- [ ] **Step 1: Write the failing route test — server derives `other`, never the client**

```ts
// src/account/__tests__/absorb.route.test.ts — mirror handles/__tests__ harness (fake req/res).
it("401 without a session; derives `other` from pendingLink, ignores any client-supplied id", async () => {
  // Arrange a caller session for `current`, a server-verified pendingLink resolving to `other`.
  // Assert: a body naming a DIFFERENT victim id is ignored; absorb runs against pendingLink's `other`.
  // Assert: no session → 401; no pendingLink → 409 (nothing to absorb).
});
```

- [ ] **Step 2: Run and watch it fail**

Run: `pnpm -w build && pnpm -w vitest run src/account/__tests__/absorb.route.test.ts`
Expected: FAIL — `installAccount` not defined.

- [ ] **Step 3: Implement the installer (mirror `src/handles/install.ts`)**

```ts
// src/account/install.ts
import type { AppDb, makeAuth } from "@agentgem/aggregator";
import { resolveSession, absorbAccount, connectedProviders, accountIdForProvider, pendingLink } from "@agentgem/aggregator";

export interface AccountDeps { db: AppDb; auth: ReturnType<typeof makeAuth>; webOrigins: string[] }
// (Req/Res/ExpressApp/cors/preflight identical to handles/install.ts — copy them.)

export function providersHandler(deps: AccountDeps) {
  return async (req, res) => {
    cors(req, res, deps.webOrigins);
    if (req.method === "OPTIONS") { preflight(res); return; }
    const who = await resolveSession(deps.auth, req.headers);
    if (!who) { res.status(401).json({ error: "sign in required" }); return; }
    res.json({ connected: await connectedProviders(deps.db, who.accountId) });
  };
}

export function absorbHandler(deps: AccountDeps) {
  return async (req, res) => {
    cors(req, res, deps.webOrigins);
    if (req.method === "OPTIONS") { preflight(res); return; }
    const who = await resolveSession(deps.auth, req.headers);
    if (!who) { res.status(401).json({ error: "sign in required" }); return; }
    // `other` comes ONLY from server-verified OAuth state for THIS session — never req.body.
    const pending = await pendingLink(deps.db, who.accountId);
    if (!pending) { res.status(409).json({ error: "no provider awaiting connection" }); return; }
    const other = await accountIdForProvider(deps.db, pending.providerId, pending.providerAccountId);
    if (!other) { res.status(409).json({ error: "no provider awaiting connection" }); return; }
    const r = await absorbAccount(deps.db, { current: who.accountId, other });
    if (!r.ok) {
      res.status(409).json({ error: "Both accounts have activity on AgentGem. Merging accounts with existing gems or a claimed handle isn't supported yet." });
      return;
    }
    // If the caller's own (current) account was the one dropped, re-session them onto the survivor.
    if (r.keep !== who.accountId) {
      const { mintSessionCookie } = await import("@agentgem/aggregator");
      const setCookie = await mintSessionCookie(deps.auth, r.keep); // Set-Cookie for keep's session
      res.set("Set-Cookie", setCookie);
    }
    res.json({ keep: r.keep, connected: await connectedProviders(deps.db, r.keep) });
  };
}

export function installAccount(expressApp, deps: AccountDeps): void {
  expressApp.post("/api/account/absorb", absorbHandler(deps));
  expressApp.options("/api/account/absorb", absorbHandler(deps));
  expressApp.get("/api/account/providers", providersHandler(deps));
  expressApp.options("/api/account/providers", providersHandler(deps));
}
```

(Confirm `mintSessionCookie`'s exact exported name/signature against `packages/aggregator/src/auth/mintCookie.ts` at implementation time; it drives the oneTimeToken plugin to produce a real Set-Cookie.)

- [ ] **Step 4: Wire the route and the origin exemption; run**

In `src/index.ts`, inside the `if (aggDb && webOrigins.length > 0 && auth)` block (next to `installStars`), add:

```ts
installAccount(server.expressApp as never, { db: aggDb, auth, webOrigins });
```

In `src/originGuard.ts` line ~92, add `req.path.startsWith("/api/account/")` to the exempt `if`:

```ts
if (req.path.startsWith("/api/auth/") || req.path.startsWith("/api/account/") || req.path.startsWith("/api/stars") || /* ...existing... */) { next(); return; }
```

Run: `pnpm -w build && pnpm -w vitest run src/account/__tests__/absorb.route.test.ts && pnpm -w vitest run src/__tests__`
Expected: PASS; no origin-guard regression.

- [ ] **Step 5: Commit**

```bash
git add src/account/ src/index.ts src/originGuard.ts
git commit -m "feat(account): POST /api/account/absorb + providers route (server-derived other, credentialed CORS)"
```

---

## Task 7: `/account` SPA page — connect providers + handle-claim nudge

**Files:**
- Create: `packages/marketplace/src/pages/Account.tsx`
- Create: `packages/marketplace/src/pages/Account.test.tsx`
- Modify: `packages/marketplace/src/Router.tsx` (add the `/account` route)
- Modify: the authed nav/chip (near "Sign out") to link `/account`
- Modify: `packages/marketplace/src/HandleClaim.tsx` — the ownership-409 nudge to `/account`

**Interfaces:**
- Consumes: `GET /api/account/providers` → `{ connected: string[] }`; `POST /api/account/absorb`;
  better-auth `linkSocial` at `/api/auth/link-social` (Flow A).

- [ ] **Step 1: Write the failing component test**

```tsx
// Account.test.tsx — mock fetch for /api/account/providers.
it("lists connected providers and offers Connect for the missing one", async () => {
  // providers: ["github"] → renders "GitHub connected" + a "Connect Google" button.
  // Clicking Connect Google triggers the link-social flow (assert the request/redirect).
});
```

- [ ] **Step 2: Run and watch it fail**

Run: `pnpm -C packages/marketplace exec vitest run src/pages/Account.test.tsx`
Expected: FAIL — `Account` not found.

- [ ] **Step 3: Implement `Account.tsx`, the route, the nav link, and the nudge**

- `Account.tsx`: fetch `/api/account/providers` (credentialed); render each of `["github","google"]` as *connected* or a **Connect** button. Connect for a never-used provider → better-auth `linkSocial`. When the OAuth resolves to an existing other account (link-social refuses), call `POST /api/account/absorb` and, on success, route to the survivor; on 409, show the merge-not-supported message.
- `Router.tsx`: add `<Route path="/account" element={<Account/>} />` behind the signed-in guard.
- Nav: a link to `/account` in the authed chip area.
- `HandleClaim.tsx`: on a claim 409 caused by another *account* owning the handle, show *"@name belongs to another account — connect it from your account settings,"* linking `/account`. (Per the spec's note: if the API can't distinguish an account-owned 409 from a reserved-org 409 without a change, keep the generic message and add the nudge as a static line — decide here, do not add a new API field just for copy.)

- [ ] **Step 4: Run the component test + marketplace suite**

Run: `pnpm -C packages/marketplace exec vitest run src/pages/Account.test.tsx src/App.test.tsx`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/marketplace/src/pages/Account.tsx packages/marketplace/src/pages/Account.test.tsx packages/marketplace/src/Router.tsx packages/marketplace/src/HandleClaim.tsx
git commit -m "feat(marketplace): /account page — connect providers (link + absorb) and handle-claim nudge"
```

---

## Final verification

- [ ] `pnpm -w build && pnpm -w vitest run` — full root suite green (this is what CI's `test (24)`/`test (26)` gate).
- [ ] `pnpm -C packages/marketplace exec vitest run` — marketplace green (NOT in CI; run locally).
- [ ] Manual smoke against a local aggregator: (a) Flow A — sign in with GitHub, Connect Google, both listed; (b) Flow B — from a fresh Google account, Connect GitHub belonging to a data-bearing account, land on the data account with both providers; (c) C-guard — two data-bearing accounts → the merge-not-supported message; (d) regression — a Google-primary account that linked GitHub can still publish a gem from the desktop app (Task 2).

---

## Notes on the spec this plan hardens

Three gaps in `2026-07-10-account-linking-design.md` are resolved here and should be reflected back into the spec:
1. **Freshness ≠ the five listed tables.** Task 4 gates on *every* FK to `accounts.id` (adds `account_scopes`, `usage_days`, `usage_day_models`, `handoff_codes`, `group_invites`, `groups.created_by`). The spec's "nothing cascades away" is wrong — there is no cascade; a stray child row is a hard FK error.
2. **The primary-only anchor breaks linked-provider lookups.** Task 2 routes `catalog.ts`/`profile.ts` identity resolution through better-auth's `account` table so a Google-primary user who links GitHub keeps publish ownership + the verified badge.
3. **The `other`-identity seam is unproven.** Task 0 is a gating spike; if better-auth persists nothing usable from the rejected `linkSocial`, Flow B switches to a bespoke connect-OAuth callback rather than piggybacking on the rejection. Tasks 5–6 consume a stable `pendingLink` interface either way.
