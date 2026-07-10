# Identity Re-key Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make AgentGem's identity provider-agnostic — the `accounts.id` uuid authorizes every ownership and access decision, and a nullable, unique `handle` on `"user"` is the only human-readable name.

**Architecture:** Additive DDL plus an idempotent backfill inside `ensureSchema`, then a mechanical re-key of six ownership call sites from string comparison to uuid comparison, then one new `claimHandle` primitive that carries the reserved-name security guard. Nothing is deleted except the dead `web_sessions` table.

**Tech Stack:** TypeScript (ESM, Node >= 24), Drizzle ORM over Postgres, PGlite for tests, better-auth 1.6.23, vitest.

## Branch base — READ THIS FIRST

**This plan does NOT build on `main`.** It requires better-auth to be authoritative:
`resolveSession(auth, headers)` must return a uuid `accountId`, and
`packages/aggregator/src/auth/betterAuth.ts` must exist. Both arrive with PRs #255 and #256.

- If **#255 and #256 have merged**: branch off freshly-fetched `origin/main`.
- If they have **not** merged: branch off `docs/better-auth-1b-cutover`, and rebase onto
  `origin/main` once they land.

Verify before Task 1: `test -f packages/aggregator/src/auth/betterAuth.ts` must succeed.

## Global Constraints

- Node >= 24. ESM everywhere: **relative imports must carry a `.js` extension**, even from `.ts` sources.
- **Tests run against compiled `dist/`.** `pnpm test` is `tsc -b && vitest run`, matching `dist/**/__tests__/**/*.test.js`. A vitest path pointing at `src/*.ts` matches **nothing** and silently passes. Run `pnpm clean` before testing after any file rename.
- **There is no drizzle-kit.** `packages/aggregator/src/schema.ts` → `ensureSchema` is the sole idempotent DDL authority. PGlite's `makeTestDb` runs it, so every test gets the real schema.
- Aggregator store code lives in `packages/aggregator/src/`. **Its tests live at repo-root `src/aggregator/__tests__/`** and import from `@agentgem/aggregator`.
- The package barrel is `packages/aggregator/src/index.ts`, using `export * from "./module.js"`. A new module must be exported there or the repo-root tests cannot import it.
- `packages/console` tests and typecheck are **not** in CI.
- A `consoleMount` failure under `pnpm test` is a **pre-existing** console-build harness quirk on `main`, not a regression. Ignore that one failure only.
- **The ownership predicate, everywhere:** `owner_account_id !== null && owner_account_id === who.accountId`. Unresolved rows are owned by **nobody**. **Never** add a string-compare fallback for `NULL` rows — that is precisely the hole this plan closes.
- `claimHandle` returns **409 for both "taken" and "reserved"**, deliberately indistinguishable, so a prober cannot enumerate which GitHub orgs the App has seen.
- Handle charset, verbatim: `^[A-Za-z0-9-]{1,39}$`.
- **Ten tables carry a foreign key to `accounts.id`:** `web_sessions` (dropped in Task 1), `handoff_codes`, `stars`, `reviews`, `account_scopes`, `usage_days`, `usage_day_models`, `groups.created_by`, `group_members`, `group_invites.created_by`.

## Two surfaces named `publishedBy` — do not confuse them

| | writes | authorizes? |
|---|---|---|
| `catalog_gems.published_by` (DB) | **only** `recordCatalogShare` (`catalog.ts:126`) | **yes** — `deleteCatalogGem` checks it |
| `publishGem({ publishedBy })` (git) | `buildDiscovery` → registry index JSON (`packages/distribute/src/registry.ts:217,270`) | **no** — public attribution string |

`src/registry/uploadPublish.ts` already authorizes with `accountOwnsScope(db, who.accountId, scope)` — uuid-keyed today. **It needs no ownership re-key.** Its `publishedBy: who.login` is a display string headed for a git file.

## File Structure

| File | Responsibility | Task |
|---|---|---|
| `packages/aggregator/src/schema.ts` | DDL: `user.handle`, `catalog_gems.owner_account_id`, relax `accounts.login`, drop `web_sessions`; the backfill | 1, 2 |
| `src/aggregator/__tests__/schema.test.ts` | hardcoded alphabetized table list — must lose `web_sessions` | 1 |
| `packages/aggregator/src/auth/betterAuth.ts` | `anchorAndScopes` generalized past GitHub | 3 |
| `packages/aggregator/src/catalog.ts` | `deleteCatalogGem` + `recordCatalogShare` re-keyed to uuid | 4 |
| `src/catalog/install.ts` | unpublish route passes `accountId` | 4 |
| `packages/aggregator/src/handles.ts` | **new** — `claimHandle`, `accountIdForHandle`, `handleForAccountId` | 5 |
| `src/handles/install.ts` | **new** — `POST /api/handle` route | 6 |
| `packages/aggregator/src/profile.ts` | gem list by `owner_account_id`; resolve handle | 7 |
| `packages/aggregator/src/orgCatalog.ts` | trust filter by `owner_account_id` | 7 |
| `packages/aggregator/src/githubApp.ts` | `resolveOrgAccess` self-branch → uuid self-scope lookup | 8 |
| `src/usage/install.ts` | personal-vs-org branch → uuid self-scope lookup | 8 |
| `packages/aggregator/src/registryPublishedBy.ts` consumers | `resolvePublishedBy` returns the handle | 9 |
| display sites (`usageDays.ts`, `groups.ts`, `reviews.ts`, `projectAdoption.ts`) | `coalesce(login, handle, name)` | 10 |

---

### Task 1: DDL — handle, owner column, relaxed login, dropped web_sessions

**Files:**
- Modify: `packages/aggregator/src/schema.ts` (the `ensureSchema` function, and the `user` / `catalogGems` drizzle tables)
- Test: `src/aggregator/__tests__/schema.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: column `"user".handle text` (nullable, unique, `CHECK`); column `catalog_gems.owner_account_id uuid references accounts(id)`; `accounts.login` nullable; `web_sessions` gone. Drizzle fields `user.handle` and `catalogGems.ownerAccountId`.

- [ ] **Step 1: Write the failing test**

Add to `src/aggregator/__tests__/schema.test.ts`:

```ts
it("handle: nullable, unique, charset-constrained at the DDL level", async () => {
  const db = await makeTestDb();
  const u = (h: string | null) =>
    sql`insert into "user" (id, email, email_verified, handle) values (gen_random_uuid()::text, ${`${Math.random()}@e.com`}, false, ${h})`;

  await db.execute(u(null));                 // NULL is legal
  await db.execute(u(null));                 // ...and repeatable: UNIQUE permits many NULLs
  await db.execute(u("raymond"));
  await expect(db.execute(u("raymond"))).rejects.toThrow();   // taken
  await expect(db.execute(u(""))).rejects.toThrow();          // empty string is NOT a handle
  await expect(db.execute(u("has space"))).rejects.toThrow(); // charset
  await expect(db.execute(u("a".repeat(40)))).rejects.toThrow(); // length
});

it("accounts.login is nullable; catalog_gems has a nullable owner FK", async () => {
  const db = await makeTestDb();
  await db.execute(sql`insert into accounts (id, provider, provider_account_id, login)
                       values (gen_random_uuid(), 'google', 'g1', null)`);
  const r = await db.execute(sql`select login from accounts where provider_account_id = 'g1'`);
  expect((r.rows as { login: string | null }[])[0].login).toBeNull();

  await expect(db.execute(
    sql`insert into catalog_gems (gem_key, version, published_by, created_at_ms, owner_account_id)
        values ('@a/b', '1.0.0', 'x', 1, gen_random_uuid())`,
  )).rejects.toThrow();  // owner_account_id must reference a real account
});
```

Then edit the existing table-list assertion at `src/aggregator/__tests__/schema.test.ts:13` to **remove** `"web_sessions"` (it is the last element; the array stays alphabetized).

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm clean && pnpm exec tsc -b && pnpm exec vitest run dist/aggregator/__tests__/schema.test.js`
Expected: FAIL — the table list still contains `web_sessions`, and the handle inserts do not throw because no column exists.

- [ ] **Step 3: Write the DDL**

In `packages/aggregator/src/schema.ts`, inside `ensureSchema`, **after** the `create table if not exists "user"` statement and after the `accounts` / `web_sessions` statements:

```ts
// Identity re-key. `handle` is the ONLY human-readable name; it authorizes nothing, so it may
// be NULL until claimed. Postgres UNIQUE permits many NULLs. NULL is not '', which makes the
// empty-string identity collision unrepresentable rather than merely guarded.
await db.execute(sql`alter table "user" add column if not exists handle text`);
await db.execute(sql`create unique index if not exists user_handle_uniq on "user" (handle)`);
await db.execute(sql`do $$ begin
  alter table "user" add constraint user_handle_shape
    check (handle is null or handle ~ '^[A-Za-z0-9-]{1,39}$');
exception when duplicate_object then null; end $$`);

// The authorization key for a published gem. NULL = owned by nobody (see the backfill).
await db.execute(sql`alter table catalog_gems add column if not exists owner_account_id uuid references accounts(id)`);
await db.execute(sql`create index if not exists catalog_gems_owner_idx on catalog_gems (owner_account_id)`);

// A login-less provider (Google, Slack, X) must still get an `accounts` anchor row, because ten
// tables carry a foreign key to accounts.id. See anchorAndScopes.
await db.execute(sql`alter table accounts alter column login drop not null`);

// Dead since the Plan 1b cutover: zero readers, sessions now live in better-auth's `session`.
await db.execute(sql`drop table if exists web_sessions`);
```

**Delete the `create table if not exists web_sessions (...)` statement from `ensureSchema` entirely**, keeping only the `drop table if exists web_sessions` above. A fresh database never creates it and the drop is a harmless no-op; an existing database drops it. `handoff_codes` references `accounts`, not `web_sessions`, so nothing depends on the create. Leaving a statement that builds a table only to destroy it eight lines later is dead code in the sole DDL authority.

Then update the drizzle table objects in the same file:

```ts
export const user = pgTable("user", {
  id: text("id").primaryKey(),
  name: text("name"),
  email: text("email").unique(),
  emailVerified: boolean("email_verified").default(false).notNull(),
  image: text("image"),
  login: text("login"),
  handle: text("handle").unique(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
});
```

and add one field to `catalogGems` (leave every other field exactly as it is):

```ts
  ownerAccountId: uuid("owner_account_id"),
```

Delete the `webSessions` drizzle table export and its import references. `grep -rn "webSessions" packages/aggregator/src src` must return nothing outside comments.

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm clean && pnpm exec tsc -b && pnpm exec vitest run dist/aggregator/__tests__/schema.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/aggregator/src/schema.ts src/aggregator/__tests__/schema.test.ts
git commit -m "feat(identity): handle + owner_account_id columns; relax accounts.login; drop web_sessions"
```

---

### Task 2: The backfill, and why a naive join is wrong

**Files:**
- Modify: `packages/aggregator/src/schema.ts` (a new exported function, called from `ensureSchema`)
- Test: `src/aggregator/__tests__/rekeyBackfill.test.ts` (create)

**Interfaces:**
- Consumes: Task 1's `catalog_gems.owner_account_id`.
- Produces: `export async function backfillGemOwners(db: AppDb): Promise<{ resolved: number; unresolved: number }>`, called at the end of `ensureSchema`.

`accounts.login` has **no unique constraint** (GitHub enforced it upstream; the schema never did). A naive `where lower(a.login) = lower(cg.published_by)` can match two accounts and silently assign the gem to whichever row the planner happens to return. Assign only where **exactly one** account matches.

- [ ] **Step 1: Write the failing test**

Create `src/aggregator/__tests__/rekeyBackfill.test.ts`:

```ts
// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
import { describe, it, expect } from "vitest";
import { sql } from "drizzle-orm";
import { backfillGemOwners } from "@agentgem/aggregator";
import { makeTestDb } from "./testDb.js";

const acct = (login: string | null, pid: string) =>
  sql`insert into accounts (id, provider, provider_account_id, login)
      values (gen_random_uuid(), 'github', ${pid}, ${login}) returning id`;
const gem = (key: string, by: string) =>
  sql`insert into catalog_gems (gem_key, version, published_by, created_at_ms)
      values (${key}, '1.0.0', ${by}, 1)`;
const ownerOf = async (db: Awaited<ReturnType<typeof makeTestDb>>, key: string) =>
  ((await db.execute(sql`select owner_account_id from catalog_gems where gem_key = ${key}`))
    .rows as { owner_account_id: string | null }[])[0].owner_account_id;

describe("backfillGemOwners", () => {
  it("resolves a gem to its sole matching account, case-insensitively", async () => {
    const db = await makeTestDb();
    const id = ((await db.execute(acct("Raymond", "1"))).rows as { id: string }[])[0].id;
    await db.execute(gem("@r/a", "raymond"));
    const r = await backfillGemOwners(db);
    expect(r).toEqual({ resolved: 1, unresolved: 0 });
    expect(await ownerOf(db, "@r/a")).toBe(id);
  });

  it("leaves BOTH gems unresolved when two accounts share a login", async () => {
    const db = await makeTestDb();
    await db.execute(acct("dup", "1"));
    await db.execute(acct("DUP", "2"));       // no unique constraint on accounts.login
    await db.execute(gem("@d/a", "dup"));
    await db.execute(gem("@d/b", "DUP"));
    const r = await backfillGemOwners(db);
    expect(r).toEqual({ resolved: 0, unresolved: 2 });
    expect(await ownerOf(db, "@d/a")).toBeNull();
    expect(await ownerOf(db, "@d/b")).toBeNull();
  });

  it("leaves a gem unresolved when no account matches, and is idempotent", async () => {
    const db = await makeTestDb();
    await db.execute(gem("@ghost/a", "deleted-user"));
    expect(await backfillGemOwners(db)).toEqual({ resolved: 0, unresolved: 1 });
    expect(await backfillGemOwners(db)).toEqual({ resolved: 0, unresolved: 1 });
    expect(await ownerOf(db, "@ghost/a")).toBeNull();
  });

  it("never re-assigns a row that already has an owner", async () => {
    const db = await makeTestDb();
    const a = ((await db.execute(acct("keep", "1"))).rows as { id: string }[])[0].id;
    await db.execute(acct("other", "2"));
    await db.execute(gem("@k/a", "other"));
    await db.execute(sql`update catalog_gems set owner_account_id = ${a} where gem_key = '@k/a'`);
    await backfillGemOwners(db);
    expect(await ownerOf(db, "@k/a")).toBe(a);   // not reassigned to 'other'
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm clean && pnpm exec tsc -b && pnpm exec vitest run dist/aggregator/__tests__/rekeyBackfill.test.js`
Expected: FAIL — `backfillGemOwners` is not exported from `@agentgem/aggregator`.

- [ ] **Step 3: Write the implementation**

In `packages/aggregator/src/schema.ts`, add:

```ts
/** One-time, idempotent: map catalog_gems.published_by (a login string) onto owner_account_id.
 *  accounts.login has NO unique constraint, so assign ONLY where exactly one account matches —
 *  a naive join would silently hand the gem to whichever duplicate the planner returned first.
 *  Rows that do not resolve keep owner_account_id = NULL and are owned by NOBODY (fail closed). */
export async function backfillGemOwners(db: AppDb): Promise<{ resolved: number; unresolved: number }> {
  await db.execute(sql`
    update catalog_gems cg set owner_account_id = m.id
    from (select lower(login) lg, min(id) id from accounts
          where login is not null
          group by lower(login) having count(*) = 1) m
    where m.lg = lower(cg.published_by) and cg.owner_account_id is null`);
  const r = await db.execute(sql`select count(*)::int as n from catalog_gems where owner_account_id is null`);
  const unresolved = (r.rows as { n: number }[])[0].n;
  const t = await db.execute(sql`select count(*)::int as n from catalog_gems`);
  return { resolved: (t.rows as { n: number }[])[0].n - unresolved, unresolved };
}
```

Call it at the very end of `ensureSchema`, after all DDL:

```ts
const owners = await backfillGemOwners(db);
if (owners.unresolved > 0) {
  console.warn(`[schema] ${owners.unresolved} catalog_gems row(s) have no resolvable owner; they cannot be unpublished by anyone until reassigned`);
}
```

Export it from the barrel `packages/aggregator/src/index.ts` if `schema.js` is not already re-exported wholesale.

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm clean && pnpm exec tsc -b && pnpm exec vitest run dist/aggregator/__tests__/rekeyBackfill.test.js`
Expected: PASS, 4 tests.

- [ ] **Step 5: Commit**

```bash
git add packages/aggregator/src/schema.ts packages/aggregator/src/index.ts src/aggregator/__tests__/rekeyBackfill.test.ts
git commit -m "feat(identity): backfill catalog_gems.owner_account_id, only on an unambiguous login match"
```

---

### Task 3: Generalize the anchor past GitHub

**Files:**
- Modify: `packages/aggregator/src/auth/betterAuth.ts` (`anchorAndScopes`, ~lines 92-124)
- Modify: `packages/aggregator/src/webAuth.ts` (`upsertAccount` must accept a null login)
- Test: `src/aggregator/__tests__/anchorGeneralized.test.ts` (create)

**Interfaces:**
- Consumes: Task 1's nullable `accounts.login`.
- Produces: `anchorAndScopes` writes an `accounts` row for **any** `providerId`. `upsertAccount(db, { provider, accountId, login: string | null, avatarUrl?, id? })`.

Today `anchorAndScopes` opens with `if (account.providerId !== "github") return;`. That is the reason a Google user would get a better-auth `user` row with **no `accounts` anchor**, and then 500 on their first star, review, or group-create — ten tables carry a foreign key to `accounts.id`.

This is testable **now**, with a fake provider, before any real provider exists.

- [ ] **Step 1: Write the failing test**

Create `src/aggregator/__tests__/anchorGeneralized.test.ts`:

```ts
// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
import { describe, it, expect } from "vitest";
import { sql } from "drizzle-orm";
import { upsertAccount } from "@agentgem/aggregator";
import { makeTestDb } from "./testDb.js";

describe("accounts anchor, generalized past GitHub", () => {
  it("writes an anchor row with a NULL login for a login-less provider", async () => {
    const db = await makeTestDb();
    const id = crypto.randomUUID();
    const a = await upsertAccount(db, { provider: "fakeprov", accountId: "ext-1", login: null, id });
    expect(a.id).toBe(id);
    expect(a.login).toBeNull();
  });

  it("the ten accounts.id foreign keys are satisfiable for a login-less account", async () => {
    const db = await makeTestDb();
    const id = crypto.randomUUID();
    await upsertAccount(db, { provider: "fakeprov", accountId: "ext-2", login: null, id });
    // stars is one of the ten FK tables; if the anchor exists, this insert must not throw.
    await db.execute(sql`insert into stars (account_id, kind, target_key) values (${id}, 'gem', '@a/b')`);
    const r = await db.execute(sql`select count(*)::int as n from stars where account_id = ${id}`);
    expect((r.rows as { n: number }[])[0].n).toBe(1);
  });

  it("a re-login upsert on the same (provider, provider_account_id) keeps the id stable", async () => {
    const db = await makeTestDb();
    const id = crypto.randomUUID();
    await upsertAccount(db, { provider: "fakeprov", accountId: "ext-3", login: null, id });
    const again = await upsertAccount(db, { provider: "fakeprov", accountId: "ext-3", login: null, id: crypto.randomUUID() });
    expect(again.id).toBe(id);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm clean && pnpm exec tsc -b && pnpm exec vitest run dist/aggregator/__tests__/anchorGeneralized.test.js`
Expected: FAIL — `upsertAccount`'s `login` parameter is typed `string` and the column was `not null` until Task 1; the type error surfaces at `tsc -b`.

- [ ] **Step 3: Write the implementation**

In `packages/aggregator/src/webAuth.ts`, widen `Account.login` and `upsertAccount`:

```ts
export interface Account { id: string; provider: string; providerAccountId: string; login: string | null; avatarUrl: string | null }

export async function upsertAccount(
  db: AppDb,
  a: { provider: string; accountId: string; login: string | null; avatarUrl?: string | null; id?: string },
): Promise<Account> {
  const id = a.id ?? randomUUID();
  const rows = await db
    .insert(accounts)
    .values({ id, provider: a.provider, providerAccountId: a.accountId, login: a.login, avatarUrl: a.avatarUrl ?? null })
    .onConflictDoUpdate({
      target: [accounts.provider, accounts.providerAccountId],
      set: { login: a.login, avatarUrl: a.avatarUrl ?? null },
    })
    .returning({ id: accounts.id, provider: accounts.provider, providerAccountId: accounts.providerAccountId, login: accounts.login, avatarUrl: accounts.avatarUrl });
  return rows[0];
}
```

In `packages/aggregator/src/auth/betterAuth.ts`, replace the body of `anchorAndScopes`:

```ts
async function anchorAndScopes(
  db: AppDb,
  account: { userId: string; providerId: string; accountId: string; accessToken?: string | null },
  isCreate: boolean,
) {
  const row = (await db.execute(sql`select login, image from "user" where id = ${account.userId}`)).rows?.[0] as
    { login?: string; image?: string } | undefined;
  // GitHub supplies a login; every other provider does not. The anchor row is written either way,
  // because ten tables carry a foreign key to accounts.id and the user's first star/review/group
  // insert would otherwise violate it. A login-less anchor is legal since Task 1 (login is nullable).
  const login = account.providerId === "github" ? (row?.login ?? null) : null;

  // On CREATE the anchor is LOAD-BEARING: a user with no anchor is broken and must not get a
  // session, so let a failure THROW and abort the sign-in. On UPDATE (re-login) the anchor already
  // exists and we are only refreshing login/avatar — best-effort, never block a legitimate sign-in.
  const write = () => upsertAccount(db, {
    provider: account.providerId, accountId: account.accountId,
    login, avatarUrl: row?.image ?? null, id: account.userId,
  });
  if (isCreate) await write();
  else try { await write(); } catch { /* re-login refresh is best-effort */ }

  // Org scopes are a GitHub concept: they are captured from the GitHub App / API and keyed on a
  // login. A login-less provider simply has none, matches no org, and is denied — correct, not a gap.
  if (account.providerId !== "github" || !login) return;
  try {
    if (account.accessToken) {
      const memberships = await fetchOrgMemberships(account.accessToken);
      await setAccountScopes(db, account.userId, [
        { scope: login, role: "self" as const },
        ...memberships.map((m) => ({ scope: m.login, role: m.role })),
      ]);
    }
  } catch { /* scopes are additive; never fail sign-in over them */ }
}
```

The old `throw new Error("anchor: user has no login; ...")` branch is **deleted**: a missing login is now a legitimate state, and the anchor no longer depends on one.

Fix the resulting type errors at `upsertAccount` call sites — `binding.ts:62` passes `acct.login` (a `string`, still fine) and `betterAuth.ts` now passes `string | null`.

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm clean && pnpm exec tsc -b && pnpm exec vitest run dist/aggregator/__tests__/anchorGeneralized.test.js dist/aggregator/__tests__/betterAuth.test.js dist/aggregator/__tests__/binding.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/aggregator/src/auth/betterAuth.ts packages/aggregator/src/webAuth.ts src/aggregator/__tests__/anchorGeneralized.test.ts
git commit -m "feat(identity): write the accounts anchor for any provider, with a NULL login"
```

---

### Task 4: Re-key gem ownership to the uuid

**Files:**
- Modify: `packages/aggregator/src/catalog.ts` (`deleteCatalogGem` ~73-81, `recordCatalogShare` ~112-135, `upsertCatalogGem` ~20-35, `CatalogRow`)
- Modify: `src/catalog/install.ts` (~29-46)
- Test: `src/aggregator/__tests__/catalogOwnership.test.ts` (create)

**Interfaces:**
- Consumes: Task 1's `catalogGems.ownerAccountId`; Task 3's nullable-login accounts.
- Produces: `deleteCatalogGem(db, gemKey, version, ownerAccountId: string): Promise<DeleteGemResult>` — **the fourth parameter is now a uuid, not a login**. `CatalogRow` gains `ownerAccountId?: string | null`.

`catalog_gems` has exactly one writer in the repo (`recordCatalogShare`) and one ownership check (`deleteCatalogGem`). `src/registry/uploadPublish.ts` writes into the **git registry index**, not this table, and already authorizes on `accountOwnsScope(db, who.accountId, scope)` — leave it alone.

- [ ] **Step 1: Write the failing test**

Create `src/aggregator/__tests__/catalogOwnership.test.ts`:

```ts
// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
import { describe, it, expect } from "vitest";
import { sql } from "drizzle-orm";
import { deleteCatalogGem, upsertCatalogGem } from "@agentgem/aggregator";
import { makeTestDb } from "./testDb.js";

const mkAccount = async (db: Awaited<ReturnType<typeof makeTestDb>>, login: string | null, pid: string) => {
  const id = crypto.randomUUID();
  await db.execute(sql`insert into accounts (id, provider, provider_account_id, login)
                       values (${id}, 'github', ${pid}, ${login})`);
  return id;
};

describe("gem ownership is the uuid, never the login string", () => {
  it("the owner may unpublish; a different account may not", async () => {
    const db = await makeTestDb();
    const owner = await mkAccount(db, "raymond", "1");
    const other = await mkAccount(db, "mallory", "2");
    await upsertCatalogGem(db, { gemKey: "@r/a", version: "1.0.0", publishedBy: "raymond", ownerAccountId: owner, createdAtMs: 1 });

    expect(await deleteCatalogGem(db, "@r/a", "1.0.0", other)).toBe("forbidden");
    expect(await deleteCatalogGem(db, "@r/a", "1.0.0", owner)).toBe("deleted");
  });

  // THE test. An unresolved row is owned by NOBODY. If a string-compare fallback ever creeps
  // back in for NULL owners, this fails — which is exactly what it is here to do.
  it("an unresolved gem is unpublishable by ANYONE, including a login-string match", async () => {
    const db = await makeTestDb();
    const raymond = await mkAccount(db, "raymond", "1");
    await upsertCatalogGem(db, { gemKey: "@r/orphan", version: "1.0.0", publishedBy: "raymond", ownerAccountId: null, createdAtMs: 1 });

    expect(await deleteCatalogGem(db, "@r/orphan", "1.0.0", raymond)).toBe("forbidden");
    const still = await db.execute(sql`select count(*)::int as n from catalog_gems where gem_key = '@r/orphan'`);
    expect((still.rows as { n: number }[])[0].n).toBe(1);
  });

  it("two login-less accounts cannot delete each other's gems (the '' === '' hole)", async () => {
    const db = await makeTestDb();
    const a = await mkAccount(db, null, "g1");
    const b = await mkAccount(db, null, "g2");
    await upsertCatalogGem(db, { gemKey: "@x/a", version: "1.0.0", publishedBy: "", ownerAccountId: a, createdAtMs: 1 });
    expect(await deleteCatalogGem(db, "@x/a", "1.0.0", b)).toBe("forbidden");
    expect(await deleteCatalogGem(db, "@x/a", "1.0.0", a)).toBe("deleted");
  });

  it("a missing gem is not-found, regardless of owner", async () => {
    const db = await makeTestDb();
    const a = await mkAccount(db, "x", "1");
    expect(await deleteCatalogGem(db, "@no/pe", "1.0.0", a)).toBe("not-found");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm clean && pnpm exec tsc -b && pnpm exec vitest run dist/aggregator/__tests__/catalogOwnership.test.js`
Expected: FAIL at `tsc -b` — `CatalogRow` has no `ownerAccountId`, and `deleteCatalogGem`'s 4th arg is still `ownerLogin`.

- [ ] **Step 3: Write the implementation**

In `packages/aggregator/src/catalog.ts`, add `ownerAccountId` to `CatalogRow` and to both halves of the `upsertCatalogGem` insert:

```ts
// in CatalogRow:
  ownerAccountId?: string | null;
```

```ts
// inside upsertCatalogGem's .values({ ... }):
    ownerAccountId: row.ownerAccountId ?? null,
// inside .onConflictDoUpdate({ set: { ... } }):
    ownerAccountId: row.ownerAccountId ?? null,
```

Replace `deleteCatalogGem` entirely:

```ts
// Owner-only unpublish. Ownership is the accounts.id uuid — NEVER the `published_by` string,
// which is a denormalized display value with no uniqueness constraint anywhere in the schema.
// A row with owner_account_id = NULL (an unresolvable backfill; see backfillGemOwners) is owned
// by NOBODY and cannot be unpublished by anyone. Do not add a string-compare fallback for it:
// that is the "" === "" hole this re-key exists to close.
export async function deleteCatalogGem(db: AppDb, gemKey: string, version: string, ownerAccountId: string): Promise<DeleteGemResult> {
  const row = (await db.select({ ownerAccountId: catalogGems.ownerAccountId }).from(catalogGems)
    .where(and(eq(catalogGems.gemKey, gemKey), eq(catalogGems.version, version))).limit(1))[0];
  if (!row) return "not-found";
  if (row.ownerAccountId === null || row.ownerAccountId !== ownerAccountId) return "forbidden";
  await db.delete(gemArchives).where(and(eq(gemArchives.gemKey, gemKey), eq(gemArchives.version, version)));
  await db.delete(catalogGems).where(and(eq(catalogGems.gemKey, gemKey), eq(catalogGems.version, version)));
  return "deleted";
}
```

In `recordCatalogShare`, resolve the binding to an `accounts.id`. `account_bindings.account_id` is `text` holding the **provider's** id, so it pairs with `provider` to match `accounts(provider, provider_account_id)`:

```ts
  const bind = (await db.select().from(accountBindings).where(sql`pubkey = ${req.pubkey}`))[0];
  if (!bind) return { shared: false, rejected: "not-connected" };
  // account_bindings.account_id is the PROVIDER's id (text), not accounts.id — pair it with
  // `provider` to reach the anchor row whose uuid owns the gem.
  const acct = (await db.select({ id: accounts.id, login: accounts.login }).from(accounts)
    .where(and(eq(accounts.provider, bind.provider), eq(accounts.providerAccountId, bind.accountId))).limit(1))[0];
  // No anchor row → the server cannot identify the publisher, so it must not record ownership.
  // recordBinding writes the anchor best-effort, so this is reachable; failing closed is correct.
  if (!acct) return { shared: false, rejected: "not-connected" };
  const login = bind.accountLogin;
  const m = req.manifest;
  await upsertCatalogGem(db, {
    gemKey: m.gemKey, version: m.version, publishedBy: login, ownerAccountId: acct.id,
    author: m.author, description: m.description, tags: m.tags, artifactKinds: m.artifactKinds,
    type: m.type, grade: clampGrade(m.grade), artifacts: m.artifacts, createdAtMs: now,
  });
  return { shared: true, publishedBy: login, gemKey: m.gemKey, version: m.version };
```

Add `accounts` to the imports at the top of `catalog.ts` if absent.

In `src/catalog/install.ts`, replace `sessionLogin` and its use:

```ts
// Ownership is the accounts.id uuid, never the login string (see deleteCatalogGem).
async function sessionAccountId(deps: CatalogDeps, req: Req): Promise<string | null> {
  const who = await resolveSession(deps.auth, req.headers);
  return who?.accountId ?? null;
}
```

```ts
    const accountId = await sessionAccountId(deps, req);
    if (!accountId) { res.status(401).json({ error: "sign in required" }); return; }
    const key = String((req.query.key as string | undefined) ?? "");
    const version = String((req.query.version as string | undefined) ?? "");
    if (!key || !version) { res.status(400).json({ error: "key and version required" }); return; }
    const result = await deleteCatalogGem(deps.db, key, version, accountId);
```

Update the stale comment at the top of `src/catalog/install.ts:6` — it says ownership is a login match.

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm clean && pnpm exec tsc -b && pnpm exec vitest run dist/aggregator/__tests__/catalogOwnership.test.js dist/aggregator/__tests__/catalog.test.js dist/catalog/__tests__/install.test.js`
Expected: PASS. Existing `catalog.test.js` / `install.test.js` cases that pass a login into `deleteCatalogGem` must be updated to pass a uuid — that is a required part of this task, not incidental.

- [ ] **Step 5: Commit**

```bash
git add packages/aggregator/src/catalog.ts src/catalog/install.ts src/aggregator/__tests__/catalogOwnership.test.ts src/aggregator/__tests__/catalog.test.ts src/catalog/__tests__/install.test.ts
git commit -m "feat(identity): gem ownership is accounts.id; unresolved rows are owned by nobody"
```

---

### Task 5: `claimHandle` and the reserved-name guard

**Files:**
- Create: `packages/aggregator/src/handles.ts`
- Modify: `packages/aggregator/src/index.ts` (barrel)
- Test: `src/aggregator/__tests__/handles.test.ts` (create)

**Interfaces:**
- Consumes: Task 1's `user.handle`; `account_scopes` and `setAccountScopes` from `webAuth.js`.
- Produces:
  - `export type ClaimResult = { ok: true; handle: string } | { ok: false; reason: "charset" | "unavailable" }`
  - `export async function claimHandle(db: AppDb, accountId: string, raw: string): Promise<ClaimResult>`
  - `export async function accountIdForHandle(db: AppDb, handle: string): Promise<string | null>`
  - `export async function handleForAccountId(db: AppDb, accountId: string): Promise<string | null>`

**The security property.** User handles and GitHub org scopes share **one namespace**. `setAccountScopes` writes the user's own name as a `role='self'` scope row, and `uploadPublish` authorizes publishing via `accountOwnsScope(accountId, scope)`, which does **not** inspect the role. So a user who could claim the handle `ninemindai` would obtain the right to publish under that GitHub org's scope. `claimHandle` carries the reserved-name check, and is the only place that does.

`"taken"` and `"unavailable-because-reserved"` collapse into one `unavailable` result on purpose: distinguishing them tells a prober which orgs the App has seen.

The **unique index is the race arbiter**, never a prior `SELECT`. Two concurrent claims of the same handle must not both succeed because both read "free" before either wrote — the same TOCTOU discipline as `removeMemberGuarded` in the groups work.

- [ ] **Step 1: Write the failing test**

Create `src/aggregator/__tests__/handles.test.ts`:

```ts
// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
import { describe, it, expect } from "vitest";
import { sql } from "drizzle-orm";
import { claimHandle, accountIdForHandle, handleForAccountId, accountOwnsScope } from "@agentgem/aggregator";
import { makeTestDb } from "./testDb.js";

type Db = Awaited<ReturnType<typeof makeTestDb>>;
const mkUser = async (db: Db, pid: string) => {
  const id = crypto.randomUUID();
  await db.execute(sql`insert into accounts (id, provider, provider_account_id, login) values (${id}, 'fakeprov', ${pid}, null)`);
  await db.execute(sql`insert into "user" (id, email, email_verified) values (${id}, ${`${pid}@e.com`}, false)`);
  return id;
};

describe("claimHandle", () => {
  it("claims a free handle, sets the self-scope, and is resolvable both ways", async () => {
    const db = await makeTestDb();
    const a = await mkUser(db, "1");
    expect(await claimHandle(db, a, "raymond")).toEqual({ ok: true, handle: "raymond" });
    expect(await accountIdForHandle(db, "RAYMOND")).toBe(a);   // case-insensitive lookup
    expect(await handleForAccountId(db, a)).toBe("raymond");
    expect(await accountOwnsScope(db, a, "raymond")).toBe(true);
  });

  it("rejects an out-of-charset or empty handle with `charset`", async () => {
    const db = await makeTestDb();
    const a = await mkUser(db, "1");
    for (const bad of ["", "has space", "under_score", "a".repeat(40), "emoji🙂"]) {
      expect(await claimHandle(db, a, bad)).toEqual({ ok: false, reason: "charset" });
    }
  });

  it("rejects a handle already taken by another account", async () => {
    const db = await makeTestDb();
    const a = await mkUser(db, "1");
    const b = await mkUser(db, "2");
    await claimHandle(db, a, "taken");
    expect(await claimHandle(db, b, "taken")).toEqual({ ok: false, reason: "unavailable" });
  });

  // THE privilege-escalation guard. Claiming an org's name would grant a role='self' scope row,
  // and accountOwnsScope ignores role — so it would authorize publishing under that org.
  it("rejects a handle that names a known GitHub org, indistinguishably from `taken`", async () => {
    const db = await makeTestDb();
    const a = await mkUser(db, "1");
    await db.execute(sql`insert into org_members (scope, gh_login, role) values ('ninemindai', 'someone', 'member')`);
    await db.execute(sql`insert into org_settings (scope, updated_by) values ('acme', 'admin')`);

    expect(await claimHandle(db, a, "ninemindai")).toEqual({ ok: false, reason: "unavailable" });
    expect(await claimHandle(db, a, "NINEMINDAI")).toEqual({ ok: false, reason: "unavailable" });
    expect(await claimHandle(db, a, "acme")).toEqual({ ok: false, reason: "unavailable" });
    expect(await accountOwnsScope(db, a, "ninemindai")).toBe(false);   // no scope row was written
  });

  it("renaming preserves the account and frees the old handle, which grants the next claimant nothing", async () => {
    const db = await makeTestDb();
    const a = await mkUser(db, "1");
    const b = await mkUser(db, "2");
    await claimHandle(db, a, "old");
    await claimHandle(db, a, "new");
    expect(await handleForAccountId(db, a)).toBe("new");
    expect(await accountOwnsScope(db, a, "old")).toBe(false);   // stale self-scope is gone
    expect(await accountOwnsScope(db, a, "new")).toBe(true);

    expect(await claimHandle(db, b, "old")).toEqual({ ok: true, handle: "old" });
    expect(await accountIdForHandle(db, "old")).toBe(b);
    expect(await accountOwnsScope(db, b, "old")).toBe(true);
  });

  it("a concurrent claim of the same handle is arbitrated by the unique index, not a prior SELECT", async () => {
    const db = await makeTestDb();
    const a = await mkUser(db, "1");
    const b = await mkUser(db, "2");
    const [ra, rb] = await Promise.all([claimHandle(db, a, "race"), claimHandle(db, b, "race")]);
    expect([ra.ok, rb.ok].filter(Boolean)).toHaveLength(1);   // exactly one winner
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm clean && pnpm exec tsc -b && pnpm exec vitest run dist/aggregator/__tests__/handles.test.js`
Expected: FAIL — `claimHandle` is not exported from `@agentgem/aggregator`.

- [ ] **Step 3: Write the implementation**

Create `packages/aggregator/src/handles.ts`:

```ts
// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
// The handle is the ONLY human-readable name for an account. It authorizes nothing — every
// ownership and access check keys on accounts.id (a uuid) — so it may be NULL until claimed.
import { sql } from "drizzle-orm";
import type { AppDb } from "./schema.js";
import { setAccountScopes, getAccountScopes } from "./webAuth.js";

const HANDLE_RE = /^[A-Za-z0-9-]{1,39}$/;

export type ClaimResult = { ok: true; handle: string } | { ok: false; reason: "charset" | "unavailable" };

/** Handles and GitHub org scopes share ONE namespace, and accountOwnsScope ignores the scope's
 *  role — so claiming an org's name would grant a role='self' row and with it the right to publish
 *  under that org. This is the only place that guard lives. */
async function isReserved(db: AppDb, handleLc: string): Promise<boolean> {
  const r = await db.execute(sql`
    select 1 from org_members  where lower(scope) = ${handleLc}
    union all
    select 1 from org_settings where lower(scope) = ${handleLc}
    limit 1`);
  return (r.rows?.length ?? 0) > 0;
}

export async function accountIdForHandle(db: AppDb, handle: string): Promise<string | null> {
  if (!HANDLE_RE.test(handle)) return null;
  const r = await db.execute(sql`select id from "user" where lower(handle) = lower(${handle}) limit 1`);
  return (r.rows as { id: string }[])[0]?.id ?? null;
}

export async function handleForAccountId(db: AppDb, accountId: string): Promise<string | null> {
  const r = await db.execute(sql`select handle from "user" where id = ${accountId} limit 1`);
  return (r.rows as { handle: string | null }[])[0]?.handle ?? null;
}

/** Claim or rename. "taken" and "reserved" collapse into one `unavailable` result on purpose:
 *  distinguishing them would let a prober enumerate the GitHub orgs the App has seen.
 *  The UNIQUE index — not a prior SELECT — arbitrates a race between two concurrent claims. */
export async function claimHandle(db: AppDb, accountId: string, raw: string): Promise<ClaimResult> {
  const handle = raw.trim();
  if (!HANDLE_RE.test(handle)) return { ok: false, reason: "charset" };
  if (await isReserved(db, handle.toLowerCase())) return { ok: false, reason: "unavailable" };

  const prior = await handleForAccountId(db, accountId);
  try {
    const r = await db.execute(sql`
      update "user" set handle = ${handle}
      where id = ${accountId}
        and not exists (select 1 from "user" u2 where lower(u2.handle) = lower(${handle}) and u2.id <> ${accountId})
      returning id`);
    if ((r.rows?.length ?? 0) === 0) return { ok: false, reason: "unavailable" };
  } catch {
    return { ok: false, reason: "unavailable" };   // unique index lost the race
  }

  // Replace the role='self' scope with the new handle, dropping the stale one. Org memberships
  // (role 'admin'/'member') are preserved: a rename must not revoke them.
  const kept = (await getAccountScopes(db, accountId))
    .filter((s) => s.role !== "self" && s.scope.toLowerCase() !== (prior ?? "").toLowerCase())
    .map((s) => ({ scope: s.scope, role: s.role as "admin" | "member" }));
  await setAccountScopes(db, accountId, [{ scope: handle, role: "self" as const }, ...kept]);
  return { ok: true, handle };
}
```

Add to `packages/aggregator/src/index.ts`:

```ts
export * from "./handles.js";
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm clean && pnpm exec tsc -b && pnpm exec vitest run dist/aggregator/__tests__/handles.test.js`
Expected: PASS, 6 tests.

- [ ] **Step 5: Commit**

```bash
git add packages/aggregator/src/handles.ts packages/aggregator/src/index.ts src/aggregator/__tests__/handles.test.ts
git commit -m "feat(identity): claimHandle + the reserved-org-name privilege-escalation guard"
```

---

### Task 6: The `POST /api/handle` route

**Files:**
- Create: `src/handles/install.ts`
- Modify: `src/index.ts` (register the route)
- Test: `src/handles/__tests__/install.test.ts` (create)

**Interfaces:**
- Consumes: Task 5's `claimHandle` / `ClaimResult`; `resolveSession(auth, headers)`.
- Produces: `export function installHandles(expressApp: ExpressApp, deps: HandleDeps): void` where `HandleDeps = { db: AppDb; auth: ReturnType<typeof makeAuth>; webOrigins: string[] }`.

Status mapping, exactly: no session → **401**; `reason: "charset"` → **400**; `reason: "unavailable"` → **409**; success → **200** `{ handle }`.

- [ ] **Step 1: Write the failing test**

Create `src/handles/__tests__/install.test.ts`. Follow the pattern in `src/catalog/__tests__/install.test.ts` for building the Express app and minting a session cookie via `mintBetterAuthCookieForTest`.

```ts
// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
import { describe, it, expect } from "vitest";
import { sql } from "drizzle-orm";
import request from "supertest";
import { makeHandleApp } from "./helpers.js";   // see Step 3

describe("POST /api/handle", () => {
  it("401 without a session", async () => {
    const { app } = await makeHandleApp();
    await request(app).post("/api/handle").send({ handle: "raymond" }).expect(401);
  });

  it("200 and persists on a free handle", async () => {
    const { app, cookie, db, accountId } = await makeHandleApp();
    const r = await request(app).post("/api/handle").set("cookie", cookie).send({ handle: "raymond" }).expect(200);
    expect(r.body).toEqual({ handle: "raymond" });
    const q = await db.execute(sql`select handle from "user" where id = ${accountId}`);
    expect((q.rows as { handle: string }[])[0].handle).toBe("raymond");
  });

  it("400 on charset, 409 on taken, 409 on a reserved org name", async () => {
    const { app, cookie, db } = await makeHandleApp();
    await request(app).post("/api/handle").set("cookie", cookie).send({ handle: "has space" }).expect(400);

    await db.execute(sql`insert into "user" (id, email, email_verified, handle) values (gen_random_uuid()::text, 'o@e.com', false, 'taken')`);
    await request(app).post("/api/handle").set("cookie", cookie).send({ handle: "taken" }).expect(409);

    await db.execute(sql`insert into org_members (scope, gh_login, role) values ('ninemindai', 's', 'member')`);
    await request(app).post("/api/handle").set("cookie", cookie).send({ handle: "ninemindai" }).expect(409);
  });

  it("400 when the body carries no handle string", async () => {
    const { app, cookie } = await makeHandleApp();
    await request(app).post("/api/handle").set("cookie", cookie).send({}).expect(400);
  });
});
```

Also create `src/handles/__tests__/helpers.ts` exporting `makeHandleApp()`, which builds a PGlite db via `makeTestDb()`, an `express()` app with `express.json()`, calls `installHandles(app, { db, auth, webOrigins: ["http://localhost"] })`, mints a better-auth session for a fresh account with `mintBetterAuthCookieForTest`, and returns `{ app, db, cookie, accountId }`.

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm clean && pnpm exec tsc -b && pnpm exec vitest run dist/handles/__tests__/install.test.js`
Expected: FAIL — `src/handles/install.ts` does not exist.

- [ ] **Step 3: Write the implementation**

Create `src/handles/install.ts`:

```ts
// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
// POST /api/handle — claim or rename the caller's public handle. The handle names; it never
// authorizes (ownership is the accounts.id uuid), so this route grants no access by itself.
// "taken" and "reserved" both return 409, deliberately indistinguishable: separating them would
// let a prober enumerate the GitHub orgs the App has seen.
import type { Request as Req, Response as Res } from "express";
import { claimHandle, resolveSession, type makeAuth } from "@agentgem/aggregator";
import type { AppDb } from "@agentgem/aggregator";
import { cors } from "../http/cors.js";

export interface HandleDeps { db: AppDb; auth: ReturnType<typeof makeAuth>; webOrigins: string[] }

export function claimHandler(deps: HandleDeps) {
  return async (req: Req, res: Res): Promise<void> => {
    cors(req, res, deps.webOrigins);
    if (req.method === "OPTIONS") {
      res.set("Access-Control-Allow-Methods", "POST, OPTIONS").set("Access-Control-Allow-Headers", "content-type").status(204).send("");
      return;
    }
    const who = await resolveSession(deps.auth, req.headers);
    if (!who) { res.status(401).json({ error: "sign in required" }); return; }

    const raw = (req.body ?? {}) as { handle?: unknown };
    if (typeof raw.handle !== "string") { res.status(400).json({ error: "handle is required" }); return; }

    const result = await claimHandle(deps.db, who.accountId, raw.handle);
    if (result.ok) { res.json({ handle: result.handle }); return; }
    if (result.reason === "charset") {
      res.status(400).json({ error: "a handle is 1-39 characters of A-Z, a-z, 0-9 or -" }); return;
    }
    res.status(409).json({ error: "that handle is not available" });
  };
}

export function installHandles(expressApp: { post: Function; options: Function }, deps: HandleDeps): void {
  expressApp.post("/api/handle", claimHandler(deps));
  expressApp.options("/api/handle", claimHandler(deps));
}
```

Match the exact `ExpressApp` type and the `cors` import path used by `src/catalog/install.ts`; do not invent a new shape.

In `src/index.ts`, register it beside `installCatalog`:

```ts
installHandles(expressApp, { db, auth, webOrigins });
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm clean && pnpm exec tsc -b && pnpm exec vitest run dist/handles/__tests__/install.test.js`
Expected: PASS, 4 tests.

- [ ] **Step 5: Commit**

```bash
git add src/handles src/index.ts
git commit -m "feat(identity): POST /api/handle — claim or rename a handle"
```

---

### Task 7: Ownership reads — profile and org catalog

**Files:**
- Modify: `packages/aggregator/src/profile.ts` (~14, ~64-90)
- Modify: `packages/aggregator/src/orgCatalog.ts` (~55-70)
- Test: `src/aggregator/__tests__/profile.test.ts`, `src/aggregator/__tests__/orgCatalog.test.ts` (extend both)

**Interfaces:**
- Consumes: Task 1's `catalogGems.ownerAccountId`; Task 5's `accountIdForHandle`.
- Produces: no signature change. `buildProfile(db, rawHandle)` keeps returning `Profile | null`.

These are **ownership reads**, not display reads. If they kept matching `lower(published_by)`, a profile page would list gems by string match — the behavior this plan removes — and an unresolved gem would still appear to belong to someone.

- [ ] **Step 1: Write the failing test**

Append to `src/aggregator/__tests__/profile.test.ts`:

```ts
it("lists gems by owner_account_id, not by the published_by string", async () => {
  const db = await makeTestDb();
  const id = crypto.randomUUID();
  await db.execute(sql`insert into accounts (id, provider, provider_account_id, login) values (${id}, 'github', '1', 'raymond')`);
  await db.execute(sql`insert into "user" (id, email, email_verified, handle) values (${id}, 'r@e.com', false, 'raymond')`);
  // owned: resolves to the account
  await db.execute(sql`insert into catalog_gems (gem_key, version, published_by, created_at_ms, owner_account_id)
                       values ('@r/owned', '1.0.0', 'raymond', 1, ${id})`);
  // an impostor row: the STRING matches, the owner does not. It must not appear.
  await db.execute(sql`insert into catalog_gems (gem_key, version, published_by, created_at_ms, owner_account_id)
                       values ('@r/impostor', '1.0.0', 'raymond', 1, null)`);

  const p = await buildProfile(db, "raymond");
  expect(p!.gems.map((g) => g.key)).toEqual(["@r/owned"]);
});

it("returns null for a handle nobody holds", async () => {
  const db = await makeTestDb();
  expect(await buildProfile(db, "nobody")).toBeNull();
});
```

Append to `src/aggregator/__tests__/orgCatalog.test.ts`:

```ts
it("the trust filter matches owner_account_id, so a string-only impostor is excluded", async () => {
  const db = await makeTestDb();
  const member = crypto.randomUUID();
  await db.execute(sql`insert into accounts (id, provider, provider_account_id, login) values (${member}, 'github', '1', 'raymond')`);
  await db.execute(sql`insert into account_scopes (account_id, scope, role) values (${member}, 'ninemindai', 'member')`);
  await db.execute(sql`insert into catalog_gems (gem_key, version, published_by, created_at_ms, owner_account_id)
                       values ('@ninemindai/real', '1.0.0', 'raymond', 1, ${member})`);
  await db.execute(sql`insert into catalog_gems (gem_key, version, published_by, created_at_ms, owner_account_id)
                       values ('@ninemindai/fake', '1.0.0', 'raymond', 1, null)`);

  const c = await buildOrgCatalog(db, "ninemindai");
  expect(c!.gems.map((g) => g.key)).toEqual(["@ninemindai/real"]);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm clean && pnpm exec tsc -b && pnpm exec vitest run dist/aggregator/__tests__/profile.test.js dist/aggregator/__tests__/orgCatalog.test.js`
Expected: FAIL — the impostor rows appear, because both still match on `published_by`.

- [ ] **Step 3: Write the implementation**

In `packages/aggregator/src/profile.ts`, rename the guard regex and resolve the handle first:

```ts
const HANDLE_RE = /^[A-Za-z0-9-]{1,39}$/;
```

Replace the account/gem lookups inside `buildProfile`:

```ts
export async function buildProfile(db: AppDb, rawHandle: string): Promise<Profile | null> {
  const handle = rawHandle.trim();
  if (!HANDLE_RE.test(handle)) return null;   // reject junk before any query or URL build

  const accountId = await accountIdForHandle(db, handle);
  if (!accountId) return null;                // no handle, no profile — there is no other name

  const acct = (await db
    .select({ id: accounts.id, login: accounts.login, avatarUrl: accounts.avatarUrl })
    .from(accounts).where(eq(accounts.id, accountId)).limit(1))[0];

  // `verified` follows the ACCOUNT, not the name. account_bindings.account_id is the PROVIDER's id
  // (text), so pair it with `provider` to reach the anchor. Matching account_login against the handle
  // would silently un-verify anyone who renamed, since the binding still holds their old login.
  const bind = (await db.execute(sql`
    select 1 from account_bindings ab
    join accounts a on a.provider = ab.provider and a.provider_account_id = ab.account_id
    where a.id = ${accountId} limit 1`));
  const verified = (bind.rows?.length ?? 0) > 0;

  // Ownership read: gems this ACCOUNT owns. Matching published_by would list impostor rows whose
  // string happens to equal the handle but whose owner_account_id is NULL or someone else's.
  const rows = await db
    .select({ gemKey: catalogGems.gemKey, version: catalogGems.version, description: catalogGems.description, grade: catalogGems.grade })
    .from(catalogGems)
    .where(eq(catalogGems.ownerAccountId, accountId))
    .orderBy(desc(catalogGems.createdAtMs), desc(catalogGems.version));
```

Keep the rest of `buildProfile` byte-for-byte, except the `Profile.login` field, which now reads `login: handle`. Import `accountIdForHandle` from `./handles.js` and `eq` from `drizzle-orm`.

The `if (!acct && base.length === 0 && !verified) return null;` line is now unreachable for a resolved handle — delete it; the `if (!accountId) return null` above supersedes it.

In `packages/aggregator/src/orgCatalog.ts`, select the owner column and match on uuids:

```ts
    .select({ gemKey: catalogGems.gemKey, version: catalogGems.version, publishedBy: catalogGems.publishedBy,
              ownerAccountId: catalogGems.ownerAccountId, description: catalogGems.description,
              tags: catalogGems.tags, artifactKinds: catalogGems.artifactKinds, type: catalogGems.type, grade: catalogGems.grade })
```

```ts
  // Trust filter: a @scope/* gem renders on this org's page only if its OWNER actually owns `scope`
  // — either the owner is the account whose handle IS the scope (self), or account_scopes records
  // the ownership (their GitHub org membership, the same gate the publish path uses). Matching the
  // published_by STRING here would let anyone share a @scope/* gem through recordCatalogShare
  // (which does not verify scope ownership) and have it render under an official-looking org page.
  const scopeLc = scope.toLowerCase();
  const owners = await db
    .select({ accountId: accountScopes.accountId })
    .from(accountScopes)
    .where(sql`lower(${accountScopes.scope}) = ${scopeLc}`);
  const ownerSet = new Set(owners.map((o) => o.accountId));
  const selfId = await accountIdForHandle(db, scope);
  if (selfId) ownerSet.add(selfId);
  const owned = base.filter((g) => g.ownerAccountId !== null && ownerSet.has(g.ownerAccountId));
```

Drop the now-unused `accounts` join and its import if nothing else in the file uses it. Import `accountIdForHandle` from `./handles.js`.

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm clean && pnpm exec tsc -b && pnpm exec vitest run dist/aggregator/__tests__/profile.test.js dist/aggregator/__tests__/orgCatalog.test.js`
Expected: PASS. Existing cases in both files that seed gems without an `owner_account_id` must be updated to seed one — required, not incidental.

- [ ] **Step 5: Commit**

```bash
git add packages/aggregator/src/profile.ts packages/aggregator/src/orgCatalog.ts src/aggregator/__tests__/profile.test.ts src/aggregator/__tests__/orgCatalog.test.ts
git commit -m "feat(identity): profile + org-catalog list gems by owner_account_id"
```

---

### Task 8: Self-scope checks stop comparing strings

**Files:**
- Modify: `packages/aggregator/src/githubApp.ts` (`resolveOrgAccess`, ~104-118)
- Modify: `src/usage/install.ts` (~131-165)
- Test: `src/aggregator/__tests__/githubApp.test.ts` (extend), `src/usage/__tests__/install.test.ts` (extend)

**Interfaces:**
- Consumes: `accountScopeRole(db, accountId, scope)` from `webAuth.js` (exists today).
- Produces: `resolveOrgAccess(db, who: { accountId: string; login: string }, scope, scopeTtlMs, now?)` — signature unchanged, `who.login` no longer read for the self decision.

`resolveOrgAccess` currently grants `role: "self"` on `who.login.toLowerCase() === scope.toLowerCase()`. Claiming a name must not *be* the grant; **holding the `role='self'` scope row** is the grant. `claimHandle` (Task 5) is what writes that row, and it runs the reserved-name guard.

- [ ] **Step 1: Write the failing test**

Append to `src/aggregator/__tests__/githubApp.test.ts`:

```ts
it("grants self from the role='self' scope row, not from a login string match", async () => {
  const db = await makeTestDb();
  const id = crypto.randomUUID();
  await db.execute(sql`insert into accounts (id, provider, provider_account_id, login) values (${id}, 'github', '1', 'raymond')`);
  await db.execute(sql`insert into account_scopes (account_id, scope, role) values (${id}, 'raymond', 'self')`);

  // holds the row → self
  expect(await resolveOrgAccess(db, { accountId: id, login: "raymond" }, "raymond", 86_400_000))
    .toMatchObject({ status: "ok", role: "self" });

  // login string matches but NO row → must not be self
  const bare = crypto.randomUUID();
  await db.execute(sql`insert into accounts (id, provider, provider_account_id, login) values (${bare}, 'github', '2', 'raymond')`);
  expect(await resolveOrgAccess(db, { accountId: bare, login: "raymond" }, "raymond", 86_400_000))
    .toMatchObject({ status: "none" });
});

it("two login-less accounts do not collide on the empty scope", async () => {
  const db = await makeTestDb();
  const a = crypto.randomUUID(); const b = crypto.randomUUID();
  await db.execute(sql`insert into accounts (id, provider, provider_account_id, login) values (${a}, 'g', '1', null)`);
  await db.execute(sql`insert into accounts (id, provider, provider_account_id, login) values (${b}, 'g', '2', null)`);
  expect(await resolveOrgAccess(db, { accountId: a, login: "" }, "", 86_400_000)).toMatchObject({ status: "none" });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm clean && pnpm exec tsc -b && pnpm exec vitest run dist/aggregator/__tests__/githubApp.test.js`
Expected: FAIL — the second assertion returns `role: "self"` because `"raymond" === "raymond"`, and the third returns `self` on `"" === ""`.

- [ ] **Step 3: Write the implementation**

In `packages/aggregator/src/githubApp.ts`, replace the first line of `resolveOrgAccess`'s body:

```ts
  // Self is HOLDING the role='self' scope row (written by claimHandle, which runs the reserved-org
  // guard), never a login-string match. A string compare would grant `self` on "" === "" for two
  // login-less accounts, and would let a freely-claimed name become a grant.
  if ((await accountScopeRole(db, who.accountId, scope)) === "self") {
    return { status: "ok", role: "self", via: "self" };
  }
  const scopeLower = scope.toLowerCase();
```

Import `accountScopeRole` from `./webAuth.js` if it is not already imported. Leave paths 2 and 3 (App-authoritative `memberRole`, captured `accountScopeStatus`) exactly as they are: orgs stay GitHub-shaped, and a login-less user correctly matches none.

In `src/usage/install.ts`, replace both `scope === who.login` comparisons (~lines 136 and 160). Add near the top of the module:

```ts
// The caller's own dashboard = they hold the role='self' scope row for `scope`. Never a login
// string compare: a login-less user's "" would equal no valid scope, silently routing every
// personal request through the org gate.
const isSelfScope = async (deps: UsageDeps, accountId: string, scope: string): Promise<boolean> =>
  (await accountScopeRole(deps.db, accountId, scope)) === "self";
```

then, at the two call sites:

```ts
    if (!(await isSelfScope(deps, who.accountId, scope))) { /* ...existing org-gate branch... */ }
```

```ts
    const includeUnattributed = await isSelfScope(deps, who.accountId, scope);
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm clean && pnpm exec tsc -b && pnpm exec vitest run dist/aggregator/__tests__/githubApp.test.js dist/usage/__tests__/install.test.js`
Expected: PASS. Existing usage tests that rely on a bare login match must seed a `role='self'` `account_scopes` row — required, not incidental.

- [ ] **Step 5: Commit**

```bash
git add packages/aggregator/src/githubApp.ts src/usage/install.ts src/aggregator/__tests__/githubApp.test.ts src/usage/__tests__/install.test.ts
git commit -m "feat(identity): self-scope is the role='self' row, not a login-string match"
```

---

### Task 9: `resolvePublishedBy` returns the handle

**Files:**
- Modify: `src/registry/publishedBy.ts`
- Test: `src/registry/__tests__/publishedBy.test.ts` (extend, or create if absent)

**Interfaces:**
- Consumes: Task 5's `handleForAccountId`.
- Produces: `resolvePublishedBy(req: HasHeaders | undefined, auth: ReturnType<typeof makeAuth> | undefined, db: AppDb | undefined): Promise<string | undefined>` — **gains a third `db` parameter**, because the handle lives in the database and the session no longer carries it. Returns the caller's **handle**, or `undefined` when there is no session, no `db`, or no claimed handle. Both call sites must be updated to pass `db`.

This value lands in the **git registry index's JSON** via `buildDiscovery` (`packages/distribute/src/registry.ts:217`). It is a public attribution string and authorizes nothing — a uuid there would name nobody. It must therefore stay human-readable.

- [ ] **Step 1: Write the failing test**

```ts
it("returns the caller's handle, and undefined when they have not claimed one", async () => {
  const { db, auth, headers, accountId } = await makeAuthedFixture();   // mints a better-auth session
  expect(await resolvePublishedBy({ headers }, auth)).toBeUndefined();  // no handle yet
  await claimHandle(db, accountId, "raymond");
  expect(await resolvePublishedBy({ headers }, auth)).toBe("raymond");
});

it("returns undefined with no session and never throws on a db error", async () => {
  const { auth } = await makeAuthedFixture();
  expect(await resolvePublishedBy(undefined, auth)).toBeUndefined();
  expect(await resolvePublishedBy({ headers: {} }, auth)).toBeUndefined();
});
```

Build `makeAuthedFixture` the same way `src/registry/__tests__/` fixtures already mint sessions (`mintBetterAuthCookieForTest`), returning `{ db, auth, headers, accountId }`.

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm clean && pnpm exec tsc -b && pnpm exec vitest run dist/registry/__tests__/publishedBy.test.js`
Expected: FAIL — it returns the GitHub login, not the handle.

- [ ] **Step 3: Write the implementation**

Replace `src/registry/publishedBy.ts`:

```ts
// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
// src/registry/publishedBy.ts
//
// Resolve the VERIFIED publisher name for an account-bound publish: the caller's claimed HANDLE,
// or undefined for the local/trusted path (no session) and for a caller who has not claimed one.
// This lands in the git registry index's public discovery JSON (buildDiscovery), so it must be
// human-readable — it is attribution, NOT authorization. Publishing is gated separately, by
// accountOwnsScope(accountId, scope), which is uuid-keyed.
import { resolveSession, handleForAccountId, type makeAuth } from "@agentgem/aggregator";
import type { AppDb } from "@agentgem/aggregator";

type HasHeaders = { headers: Record<string, string | undefined> };

export async function resolvePublishedBy(
  req: HasHeaders | undefined,
  auth: ReturnType<typeof makeAuth> | undefined,
  db?: AppDb,
): Promise<string | undefined> {
  if (!req || !auth || !db) return undefined;   // local/trusted path — no session
  // Fail-closed: a transient error degrades to an un-attributed publish (undefined), never a 500.
  // Attribution is best-effort; it is not a gate on publishing.
  try {
    const who = await resolveSession(auth, req.headers);
    if (!who) return undefined;
    return (await handleForAccountId(db, who.accountId)) ?? undefined;
  } catch {
    return undefined;
  }
}
```

Update the two call sites to pass `db`: `src/gem.controller.ts:1244` (`await resolvePublishedBy(this.req, this.auth, this.db)` — use whatever field already holds the `AppDb` on the controller) and `src/registry/uploadPublish.ts:76`, which should now read `publishedBy: await handleForAccountId(deps.db, who.accountId) ?? undefined`.

Leave `uploadPublish`'s authorization untouched: `accountOwnsScope(deps.db, who.accountId, scope)` is already uuid-keyed.

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm clean && pnpm exec tsc -b && pnpm exec vitest run dist/registry/__tests__/publishedBy.test.js dist/registry/__tests__/uploadPublish.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/registry/publishedBy.ts src/registry/uploadPublish.ts src/gem.controller.ts src/registry/__tests__/publishedBy.test.ts
git commit -m "feat(identity): registry attribution is the handle, not the GitHub login"
```

---

### Task 10: Display sites tolerate a NULL login

**Files:**
- Modify: `packages/aggregator/src/usageDays.ts` (~217, 265, 280, 296, 309, 320, 333, 341)
- Modify: `packages/aggregator/src/groups.ts` (~78, 86)
- Modify: `packages/aggregator/src/reviews.ts` (~62)
- Modify: `packages/aggregator/src/projectAdoption.ts` (~23, 30)
- Test: `src/aggregator/__tests__/displayNullLogin.test.ts` (create)

**Interfaces:**
- Consumes: Task 1's nullable `accounts.login`, `user.handle`.
- Produces: no signature change. Every display query that reads `accounts.login` yields a non-null string.

These sites render an author or member name. Since Task 3, `accounts.login` can be `NULL`. Each must fall back: **`coalesce(a.login, u.handle, u.name, '')`**, joining `"user" u on u.id = a.id` (the ids are equal by construction — `accounts.id === user.id`).

- [ ] **Step 1: Write the failing test**

Create `src/aggregator/__tests__/displayNullLogin.test.ts`:

```ts
// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
import { describe, it, expect } from "vitest";
import { sql } from "drizzle-orm";
import { listReviews } from "@agentgem/aggregator";
import { makeTestDb } from "./testDb.js";

describe("display sites tolerate a NULL accounts.login", () => {
  it("a review by a login-less author renders their handle, not null", async () => {
    const db = await makeTestDb();
    const id = crypto.randomUUID();
    await db.execute(sql`insert into accounts (id, provider, provider_account_id, login) values (${id}, 'fakeprov', '1', null)`);
    await db.execute(sql`insert into "user" (id, email, email_verified, handle, name) values (${id}, 'g@e.com', false, 'gwen', 'Gwen')`);
    await db.execute(sql`insert into reviews (account_id, target_kind, target_id, rating, body)
                         values (${id}, 'skill', 'src/a.md', 5, 'good')`);

    const rows = await listReviews(db, "skill", "src/a.md");
    expect(rows[0].login).toBe("gwen");
  });

  it("falls back to name when neither login nor handle exists", async () => {
    const db = await makeTestDb();
    const id = crypto.randomUUID();
    await db.execute(sql`insert into accounts (id, provider, provider_account_id, login) values (${id}, 'fakeprov', '2', null)`);
    await db.execute(sql`insert into "user" (id, email, email_verified, name) values (${id}, 'h@e.com', false, 'Hank')`);
    await db.execute(sql`insert into reviews (account_id, target_kind, target_id, rating, body)
                         values (${id}, 'skill', 'src/b.md', 4, 'ok')`);

    const rows = await listReviews(db, "skill", "src/b.md");
    expect(rows[0].login).toBe("Hank");
  });
});
```

Use the real exported reader name for reviews (`reviews.ts:62`'s function) rather than inventing `listReviews`; check the barrel first.

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm clean && pnpm exec tsc -b && pnpm exec vitest run dist/aggregator/__tests__/displayNullLogin.test.js`
Expected: FAIL — `login` comes back `null`.

- [ ] **Step 3: Write the implementation**

For each of the four files, change every display selection of `accounts.login` to the coalesced form. In `reviews.ts:62`, for example:

```ts
    .select({ /* ...existing fields... */, login: sql<string>`coalesce(${accounts.login}, u.handle, u.name, '')` })
    .from(reviews)
    .innerJoin(accounts, eq(reviews.accountId, accounts.id))
    .innerJoin(sql`"user" u`, sql`u.id = ${accounts.id}`)
```

Apply the identical treatment in `usageDays.ts` (the org member roster and leaderboard selects), `groups.ts` (the member list), and `projectAdoption.ts`. Do **not** change any filter or join predicate — only the projected display column. `usageDays.ts` also filters by login in places; those are display filters over an org roster keyed on `gh_login`, and they stay as they are.

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm clean && pnpm exec tsc -b && pnpm exec vitest run dist/aggregator/__tests__/displayNullLogin.test.js dist/aggregator/__tests__/reviews.test.js dist/aggregator/__tests__/usageDays.test.js dist/aggregator/__tests__/groups.test.js`
Expected: PASS.

- [ ] **Step 5: Run the full suite and commit**

Run: `pnpm clean && pnpm test`
Expected: PASS, except the known pre-existing `consoleMount` console-build harness failure.

```bash
git add packages/aggregator/src/usageDays.ts packages/aggregator/src/groups.ts packages/aggregator/src/reviews.ts packages/aggregator/src/projectAdoption.ts src/aggregator/__tests__/displayNullLogin.test.ts
git commit -m "feat(identity): display sites coalesce login -> handle -> name"
```

---

## Deferred to the marketplace follow-up

The SPA still keys several surfaces on `me.login`. None of them authorize anything — the server
decides — so they are cosmetic until a provider without a login exists, which is the **next**
spec. They are listed here so the next planner does not rediscover them:

- `packages/marketplace/src/pages/Gem.tsx:90` — `isOwner = me.login === publishedBy` (client-side display gate only; the server re-checks by uuid)
- `packages/marketplace/src/pages/Profile.tsx:38`, `App.tsx:73-75`, `Publish.tsx:9`
- `packages/marketplace/src/Router.tsx:47-48` — `/@:login` becomes `/@:handle`

Console/desktop surfaces (`IdentityChip.tsx`, `Settings/index.tsx`, `PublishToExplore.tsx`,
`Play/Studio.tsx`) key off the **GitHub device-flow bind**, which stays GitHub-only regardless.
They are out of scope.
