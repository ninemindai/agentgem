# Account-Scope Enforcement (#4b) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A signed-in user may publish a gem only to a scope they own — their GitHub login (`@you/*`) or a public org they belong to (`@ninemind/*`) — enforced on the marketplace upload path without persisting the GitHub access_token.

**Architecture:** At OAuth login the access_token is briefly in hand; we make one `GET /user/orgs` call, derive the owned scope set `[login, ...orgs]`, and persist only that list in a new `account_scopes` table. The marketplace upload-publish handler replaces its temporary `scope === login` rail with a single `account_scopes` membership query. The token itself is never stored. The local/trusted console `/registry/publish` path is untouched.

**Tech Stack:** ESM TypeScript, pnpm workspaces, drizzle-orm (pg-core) on pglite for tests, vitest (runs COMPILED tests from `dist/` — always `tsc -b` first). Injectable `fetch` for network seams, mirroring `GitHubVerifier`.

## Global Constraints

- **Never persist the GitHub access_token.** Store only the derived scope list (login + public org logins — public info). The token is used once at the callback and discarded, exactly as today.
- **Server-derived identity only.** `accountId`, `scope`, and `publishedBy` come from the verified session / request logic, never from request-body fields.
- **Enforcement targets ONLY `src/registry/uploadPublish.ts`** (the public, session-authed marketplace path). The console `/registry/publish` path (`gem.controller.ts`, trusted machine-owner) stays account-agnostic — do not touch it.
- **Public org memberships only (v1).** Do NOT add the `read:org` OAuth scope. Without it GitHub returns only public org memberships — acceptable for v1.
- **`fetchOrgs` is failure-tolerant:** any non-2xx / malformed / thrown error yields `[]`. An org-fetch failure must never fail login (the user still gets a session and owns at least their login-scope).
- **Ownership is uniform:** store `[login, ...orgs]` together; `accountOwnsScope` is a single membership check with NO special-casing of login.
- **Tests run compiled:** every "run the test" step is `pnpm exec tsc -b && pnpm exec vitest run <dist path>`. Backend tests live under `src/**/__tests__/*.test.ts` and compile to `dist/**/__tests__/*.test.js`.
- **Git:** author Raymond Feng <raymond@ninemind.ai>; every commit ends with the trailer `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`. Feature branch `feat/scope-enforcement`; never commit to `main`.

## File Structure

- `packages/aggregator/src/accountVerifier.ts` — add `fetchOrgs()` beside `GitHubVerifier` (the existing network seam). (Task 1)
- `packages/aggregator/src/schema.ts` — add `accountScopes` pgTable + `schema` export entry + `ensureSchema` DDL. (Task 2)
- `packages/aggregator/src/webAuth.ts` — add `setAccountScopes()` / `accountOwnsScope()` accessors. (Task 2)
- `src/aggregator/__tests__/schema.test.ts` — extend the table-enumeration assertion. (Task 2)
- `src/auth/install.ts` — add `fetchOrgs` to `AuthDeps`; capture scopes in the callback; wire the real `fetchOrgs`. (Task 3)
- `src/index.ts` — pass `fetchOrgs` into `installAuth`. (Task 3)
- `src/registry/uploadPublish.ts` — swap the `scope === login` rail for `accountOwnsScope`. (Task 4)

Tests: `src/aggregator/__tests__/fetchOrgs.test.ts` (new, Task 1), `src/aggregator/__tests__/accountScopes.test.ts` (new, Task 2), `src/__tests__/authInstall.test.ts` (extend, Task 3), `src/registry/__tests__/uploadPublish.test.ts` (extend, Task 4).

---

### Task 1: `fetchOrgs(token)` — GitHub org memberships

**Files:**
- Modify: `packages/aggregator/src/accountVerifier.ts` (append after `GitHubVerifier`)
- Test: `src/aggregator/__tests__/fetchOrgs.test.ts` (create)

**Interfaces:**
- Consumes: nothing from earlier tasks; injectable `fetch` (mirrors `GitHubVerifier`'s `fetchImpl`).
- Produces: `export async function fetchOrgs(token: string, fetchImpl?: typeof fetch): Promise<string[]>` — returns public org `login`s; `[]` on any non-2xx / malformed / thrown error. Exported from `@agentgem/aggregator` via the existing `export * from "./accountVerifier.js"` in `index.ts` (no index edit needed).

- [ ] **Step 1: Write the failing test**

Create `src/aggregator/__tests__/fetchOrgs.test.ts`:

```typescript
// src/aggregator/__tests__/fetchOrgs.test.ts
import { describe, it, expect } from "vitest";
import { fetchOrgs } from "@agentgem/aggregator";

function fakeFetch(status: number, body: unknown): typeof fetch {
  return (async () => ({ ok: status >= 200 && status < 300, status, json: async () => body })) as unknown as typeof fetch;
}
const throwingFetch: typeof fetch = (async () => { throw new Error("network down"); }) as unknown as typeof fetch;

describe("fetchOrgs", () => {
  it("extracts org logins from GitHub /user/orgs", async () => {
    const f = fakeFetch(200, [{ login: "ninemind", id: 1 }, { login: "acme", id: 2 }]);
    expect(await fetchOrgs("tok", f)).toEqual(["ninemind", "acme"]);
  });
  it("returns [] on a non-2xx response", async () => {
    expect(await fetchOrgs("tok", fakeFetch(403, { message: "forbidden" }))).toEqual([]);
  });
  it("returns [] when the body is not an array", async () => {
    expect(await fetchOrgs("tok", fakeFetch(200, { message: "unexpected" }))).toEqual([]);
  });
  it("skips malformed entries (missing/non-string login)", async () => {
    const f = fakeFetch(200, [{ login: "ninemind" }, { id: 9 }, { login: 5 }]);
    expect(await fetchOrgs("tok", f)).toEqual(["ninemind"]);
  });
  it("returns [] when fetch throws", async () => {
    expect(await fetchOrgs("tok", throwingFetch)).toEqual([]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm exec tsc -b && pnpm exec vitest run dist/aggregator/__tests__/fetchOrgs.test.js`
Expected: FAIL — `fetchOrgs` is not exported from `@agentgem/aggregator` (compile/import error).

- [ ] **Step 3: Write minimal implementation**

Append to `packages/aggregator/src/accountVerifier.ts` (after the `GitHubVerifier` class):

```typescript
/**
 * Public GitHub org memberships for the token's user. Failure-tolerant by design:
 * any non-2xx, malformed, or thrown error yields [] so login never fails over it.
 * v1 is PUBLIC orgs only (no read:org scope requested).
 */
export async function fetchOrgs(token: string, fetchImpl: typeof fetch = fetch): Promise<string[]> {
  try {
    const res = await fetchImpl("https://api.github.com/user/orgs", {
      headers: { Authorization: `Bearer ${token}`, "User-Agent": "agentgem", Accept: "application/vnd.github+json" },
    });
    if (!res.ok) return [];
    const body = (await res.json()) as unknown;
    if (!Array.isArray(body)) return [];
    return body
      .map((o) => (o && typeof (o as { login?: unknown }).login === "string" ? (o as { login: string }).login : null))
      .filter((l): l is string => l !== null);
  } catch {
    return [];
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm exec tsc -b && pnpm exec vitest run dist/aggregator/__tests__/fetchOrgs.test.js`
Expected: PASS (5 passing).

- [ ] **Step 5: Commit**

```bash
git add packages/aggregator/src/accountVerifier.ts src/aggregator/__tests__/fetchOrgs.test.ts
git commit -m "feat(auth): fetchOrgs — public GitHub org memberships (failure-tolerant)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 2: `account_scopes` table + `setAccountScopes` / `accountOwnsScope`

**Files:**
- Modify: `packages/aggregator/src/schema.ts` (pgTable + `schema` export + `ensureSchema` DDL)
- Modify: `packages/aggregator/src/webAuth.ts` (accessors + import)
- Modify: `src/aggregator/__tests__/schema.test.ts` (table-enumeration assertion)
- Test: `src/aggregator/__tests__/accountScopes.test.ts` (create)

**Interfaces:**
- Consumes: `accounts` table + `upsertAccount(db, {...}) → { id, ... }` (existing, `webAuth.ts`); `makeTestDb()` (existing, `@agentgem/aggregator`).
- Produces (exported from `@agentgem/aggregator` via existing `export *`):
  - `export async function setAccountScopes(db: AppDb, accountId: string, scopes: string[]): Promise<void>` — REPLACE semantics (delete the account's rows, insert the deduped set).
  - `export async function accountOwnsScope(db: AppDb, accountId: string, scope: string): Promise<boolean>` — one existence query.
  - `export const accountScopes` pgTable.

- [ ] **Step 1: Write the failing test**

Create `src/aggregator/__tests__/accountScopes.test.ts`:

```typescript
// src/aggregator/__tests__/accountScopes.test.ts
import { describe, it, expect } from "vitest";
import { makeTestDb, upsertAccount, setAccountScopes, accountOwnsScope } from "@agentgem/aggregator";

async function acct(db: Awaited<ReturnType<typeof makeTestDb>>, login: string): Promise<string> {
  const a = await upsertAccount(db, { provider: "github", accountId: `id-${login}`, login });
  return a.id;
}

describe("account_scopes", () => {
  it("owns a scope after it is set, and not a foreign scope", async () => {
    const db = await makeTestDb();
    const id = await acct(db, "alice");
    await setAccountScopes(db, id, ["alice", "ninemind"]);
    expect(await accountOwnsScope(db, id, "alice")).toBe(true);
    expect(await accountOwnsScope(db, id, "ninemind")).toBe(true);
    expect(await accountOwnsScope(db, id, "bob")).toBe(false);
  });

  it("REPLACE semantics — re-setting overwrites the previous set", async () => {
    const db = await makeTestDb();
    const id = await acct(db, "alice");
    await setAccountScopes(db, id, ["alice", "oldorg"]);
    await setAccountScopes(db, id, ["alice", "neworg"]);
    expect(await accountOwnsScope(db, id, "alice")).toBe(true);
    expect(await accountOwnsScope(db, id, "neworg")).toBe(true);
    expect(await accountOwnsScope(db, id, "oldorg")).toBe(false);
  });

  it("dedupes and tolerates an empty set", async () => {
    const db = await makeTestDb();
    const id = await acct(db, "alice");
    await setAccountScopes(db, id, ["alice", "alice"]);   // no PK conflict
    expect(await accountOwnsScope(db, id, "alice")).toBe(true);
    await setAccountScopes(db, id, []);                    // clears
    expect(await accountOwnsScope(db, id, "alice")).toBe(false);
  });

  it("scopes are per-account", async () => {
    const db = await makeTestDb();
    const alice = await acct(db, "alice");
    const bob = await acct(db, "bob");
    await setAccountScopes(db, alice, ["ninemind"]);
    expect(await accountOwnsScope(db, bob, "ninemind")).toBe(false);
  });
});
```

Also update the enumeration assertion in `src/aggregator/__tests__/schema.test.ts` — replace the `toEqual([...])` array so `"account_scopes"` appears alphabetically between `"account_bindings"` and `"accounts"`:

```typescript
    expect((t.rows as { table_name: string }[]).map((x) => x.table_name)).toEqual(["account_bindings", "account_scopes", "accounts", "api_keys", "attestations", "ingredients", "model_outcomes", "producers", "share_cards", "stars", "usage_edges", "web_sessions"]);
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm exec tsc -b && pnpm exec vitest run dist/aggregator/__tests__/accountScopes.test.js dist/aggregator/__tests__/schema.test.js`
Expected: FAIL — `setAccountScopes` / `accountOwnsScope` not exported (import error); schema enumeration missing `account_scopes`.

- [ ] **Step 3: Write minimal implementation**

In `packages/aggregator/src/schema.ts`, add the pgTable after the `stars` table:

```typescript
export const accountScopes = pgTable("account_scopes", {
  accountId: uuid("account_id").notNull().references(() => accounts.id),
  scope: text("scope").notNull(),
}, (t) => ({ pk: primaryKey({ columns: [t.accountId, t.scope] }) }));
```

Add `accountScopes` to the `schema` export object:

```typescript
export const schema = { producers, attestations, ingredients, usageEdges, modelOutcomes, accountBindings, shareCards, apiKeys, accounts, webSessions, stars, accountScopes };
```

Add the idempotent DDL inside `ensureSchema`, after the `stars` index line:

```typescript
  await db.execute(sql`create table if not exists account_scopes (account_id uuid not null references accounts(id), scope text not null, primary key (account_id, scope))`);
```

In `packages/aggregator/src/webAuth.ts`, extend the schema import and add the accessors. Change the import:

```typescript
import { accounts, webSessions, accountScopes } from "./schema.js";
```

Append the accessors (end of file — `and`, `eq` are already imported):

```typescript
/** REPLACE the account's owned scope set (login + org logins). Deduped; empty clears it. */
export async function setAccountScopes(db: AppDb, accountId: string, scopes: string[]): Promise<void> {
  const unique = [...new Set(scopes)];
  await db.delete(accountScopes).where(eq(accountScopes.accountId, accountId));
  if (unique.length > 0) {
    await db.insert(accountScopes).values(unique.map((scope) => ({ accountId, scope })));
  }
}

/** True iff the account owns `scope` (its login or a captured org membership). */
export async function accountOwnsScope(db: AppDb, accountId: string, scope: string): Promise<boolean> {
  const rows = await db
    .select({ scope: accountScopes.scope })
    .from(accountScopes)
    .where(and(eq(accountScopes.accountId, accountId), eq(accountScopes.scope, scope)))
    .limit(1);
  return rows.length > 0;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm exec tsc -b && pnpm exec vitest run dist/aggregator/__tests__/accountScopes.test.js dist/aggregator/__tests__/schema.test.js`
Expected: PASS (accountScopes 4 passing; schema 1 passing).

- [ ] **Step 5: Commit**

```bash
git add packages/aggregator/src/schema.ts packages/aggregator/src/webAuth.ts src/aggregator/__tests__/accountScopes.test.ts src/aggregator/__tests__/schema.test.ts
git commit -m "feat(aggregator): account_scopes table + setAccountScopes/accountOwnsScope

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 3: Capture owned scopes at login

**Files:**
- Modify: `src/auth/install.ts` (`AuthDeps` interface + `callbackHandler` body + `installAuth`/import)
- Modify: `src/index.ts` (pass `fetchOrgs` into `installAuth`)
- Test: `src/__tests__/authInstall.test.ts` (extend)

**Interfaces:**
- Consumes: `fetchOrgs` (Task 1); `setAccountScopes` (Task 2); existing `upsertAccount(...) → { id, ... }`, `resolveSession`, `createSession`.
- Produces: `AuthDeps` gains `fetchOrgs: (token: string) => Promise<string[]>`. After a successful callback, `account_scopes` for the account = `[login, ...orgs]` (login always present; `[login]` if the org-fetch fails).

- [ ] **Step 1: Write the failing test**

In `src/__tests__/authInstall.test.ts`, add `setAccountScopes`-readback imports and inject `fetchOrgs` into the shared `deps`. Replace the import block and `deps` helper, then add two tests.

Change the imports at the top to add `accountOwnsScope`:

```typescript
import { makeTestDb } from "@agentgem/aggregator";
import { resolveSession, accountOwnsScope } from "@agentgem/aggregator";
```

Replace the `deps` helper so it injects a default `fetchOrgs` (existing tests keep passing; they don't assert scopes):

```typescript
const deps = (db: any, over: Partial<{ fetchOrgs: (t: string) => Promise<string[]> }> = {}) => ({
  db,
  verifier: { verify: async () => ({ provider: "github", accountId: "42", login: "octocat" }) },
  exchangeCode: async () => "gh-token",
  fetchOrgs: over.fetchOrgs ?? (async () => []),
  config: cfg,
});
```

Add two tests inside the `describe("auth handlers", ...)` block. Each needs the account id, which we read back via a scope check (the login is always owned):

```typescript
  it("callback captures login + org scopes into account_scopes", async () => {
    { const db = await makeTestDb();
      const d = deps(db, { fetchOrgs: async () => ["ninemind", "acme"] });
      const login = mockRes();
      await loginHandler(d)(mockReq({ query: { return: "https://app.agentgem.ai" } }) as any, login as any);
      const state = new URL(login._redirect!).searchParams.get("state")!;
      const cb = mockRes();
      await callbackHandler(d)(mockReq({ query: { code: "abc", state } }) as any, cb as any);
      const token = (cb._headers["set-cookie"] as string).split(";")[0].split("=")[1];
      const who = await resolveSession(db, token);
      expect(who).not.toBeNull();
      expect(await accountOwnsScope(db, who!.accountId, "octocat")).toBe(true);
      expect(await accountOwnsScope(db, who!.accountId, "ninemind")).toBe(true);
      expect(await accountOwnsScope(db, who!.accountId, "acme")).toBe(true);
      expect(await accountOwnsScope(db, who!.accountId, "stranger")).toBe(false);
    }
  });

  it("an org-fetch failure still yields a session owning at least the login scope", async () => {
    { const db = await makeTestDb();
      const d = deps(db, { fetchOrgs: async () => { throw new Error("orgs api down"); } });
      const login = mockRes();
      await loginHandler(d)(mockReq({ query: { return: "https://app.agentgem.ai" } }) as any, login as any);
      const state = new URL(login._redirect!).searchParams.get("state")!;
      const cb = mockRes();
      await callbackHandler(d)(mockReq({ query: { code: "abc", state } }) as any, cb as any);
      const setCookie = cb._headers["set-cookie"] as string;
      expect(setCookie).toContain(`${SESSION_COOKIE}=`);       // login did NOT fail
      const token = setCookie.split(";")[0].split("=")[1];
      const who = await resolveSession(db, token);
      expect(await accountOwnsScope(db, who!.accountId, "octocat")).toBe(true);
      expect(await accountOwnsScope(db, who!.accountId, "ninemind")).toBe(false);
    }
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm exec tsc -b && pnpm exec vitest run dist/__tests__/authInstall.test.js`
Expected: FAIL — `AuthDeps` has no `fetchOrgs` (type error on `deps`) and/or the callback never calls `setAccountScopes`, so `accountOwnsScope(...)` is `false`.

- [ ] **Step 3: Write minimal implementation**

In `src/auth/install.ts`:

Extend the `AuthDeps` interface (add `fetchOrgs`):

```typescript
export interface AuthDeps { db: AppDb; verifier: AccountVerifier; exchangeCode: (code: string) => Promise<string>; fetchOrgs: (token: string) => Promise<string[]>; config: AuthConfig }
```

Add `setAccountScopes` to the value import from `@agentgem/aggregator` (line 8):

```typescript
import { upsertAccount, createSession, deleteSession, resolveSession, generateSessionToken, setAccountScopes } from "@agentgem/aggregator";
```

In `callbackHandler`, after the `upsertAccount` line and before `generateSessionToken`, capture scopes best-effort:

```typescript
      const row = await upsertAccount(deps.db, { provider: acct.provider, accountId: acct.accountId, login: acct.login });
      // #4b: capture owned scopes (login + public org memberships) at login. Best-effort —
      // an org-fetch failure must never fail login; the user still owns at least their login.
      let orgs: string[] = [];
      try { orgs = await deps.fetchOrgs(token); } catch { orgs = []; }
      await setAccountScopes(deps.db, row.id, [acct.login, ...orgs]);
      const { token: sessionToken } = generateSessionToken();
```

In `src/index.ts`, add `fetchOrgs` to the `@agentgem/aggregator` import (line ~33, alongside `GitHubVerifier`) and pass it into `installAuth`:

```typescript
// import: add fetchOrgs
import { resolveAggregatorDb, type AppDb, GitHubVerifier, fetchOrgs } from "@agentgem/aggregator";
```

```typescript
    installAuth(server.expressApp as never, {
      db: aggDb,
      verifier: new GitHubVerifier(),
      exchangeCode: githubExchangeCode(ghClientId, ghSecret),
      fetchOrgs: (token) => fetchOrgs(token),
      config: {
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm exec tsc -b && pnpm exec vitest run dist/__tests__/authInstall.test.js`
Expected: PASS (all prior auth tests + the 2 new scope-capture tests).

- [ ] **Step 5: Commit**

```bash
git add src/auth/install.ts src/index.ts src/__tests__/authInstall.test.ts
git commit -m "feat(auth): capture owned scopes (login + orgs) at OAuth login

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 4: Enforce ownership at upload-publish

**Files:**
- Modify: `src/registry/uploadPublish.ts` (swap the `scope === login` rail + import)
- Test: `src/registry/__tests__/uploadPublish.test.ts` (seed `account_scopes` in `session()`; add org-scope tests)

**Interfaces:**
- Consumes: `accountOwnsScope` (Task 2); `setAccountScopes` (Task 2, in the test helper); `who.accountId` from `resolveSession` (existing); `deps.db`.
- Produces: no new exports — behavior change only. Publish allowed iff `accountOwnsScope(deps.db, who.accountId, scope)`; otherwise 403 `you don't own the scope @<scope>`.

- [ ] **Step 1: Write the failing test**

In `src/registry/__tests__/uploadPublish.test.ts`, add `setAccountScopes` to the aggregator import and make `session()` seed scopes the way real login does. Then add an org-ownership test.

Change the import:

```typescript
import { makeTestDb, upsertAccount, createSession, generateSessionToken, setAccountScopes } from "@agentgem/aggregator";
```

Replace the `session` helper (default scopes = `[login]`, matching real login; callers can pass org scopes):

```typescript
async function session(db: any, login: string, scopes: string[] = [login]) {
  const a = await upsertAccount(db, { provider:"github", accountId:"1", login });
  await setAccountScopes(db, a.id, scopes);
  const { token } = generateSessionToken(); await createSession(db, a.id, token, 60_000); return token;
}
```

Update the existing rail test's description (its assertion is unchanged — alice owns only `["alice"]`, so publishing `"bob"` is still 403):

```typescript
  it("403s when the account does not own the scope", async () => {
    const db = await makeTestDb(); const token = await session(db, "alice"); const { publisher } = capturing(); const res = mkRes();
    await uploadPublishHandler(deps(db, publisher))(mkReq({ headers:{ cookie:`${SESSION_COOKIE}=${token}`, origin:"https://app.agentgem.ai" }, body:{ scope:"bob", version:"1.0.0", bytesBase64: gemBase64() } }) as any, res as any);
    expect(res._s).toBe(403);
  });
```

Add a new test for org ownership (right after the "publishes ... when scope === login" test):

```typescript
  it("publishes to an owned org scope (captured at login)", async () => {
    const db = await makeTestDb(); const token = await session(db, "alice", ["alice", "ninemind"]); const { publisher, commits } = capturing(); const res = mkRes();
    await uploadPublishHandler(deps(db, publisher))(mkReq({ headers:{ cookie:`${SESSION_COOKIE}=${token}`, origin:"https://app.agentgem.ai" }, body:{ scope:"ninemind", version:"1.0.0", bytesBase64: gemBase64() } }) as any, res as any);
    expect(res._s).toBe(200);
    expect((res._b as any).ref).toBe("@ninemind/test-gem");
    const idx = JSON.parse((commits[0].files as any)["registry.json"]);
    expect(idx.items["@ninemind/test-gem"].discovery.publishedBy).toBe("alice"); // attribution stays the verified login
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm exec tsc -b && pnpm exec vitest run dist/registry/__tests__/uploadPublish.test.js`
Expected: FAIL — the new org test 403s (rail is still `scope === who.login`, so `"ninemind" !== "alice"`).

- [ ] **Step 3: Write minimal implementation**

In `src/registry/uploadPublish.ts`, add `accountOwnsScope` to the aggregator import:

```typescript
import { resolveSession, accountOwnsScope } from "@agentgem/aggregator";
```

Replace the safety-rail line (currently `if (scope !== who.login) { ... }`):

```typescript
    // #4b: enforce account-scope ownership (login + public GitHub org memberships captured at login).
    if (!(await accountOwnsScope(deps.db, who.accountId, scope))) {
      res.status(403).json({ error: `you don't own the scope @${scope}` }); return;
    }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm exec tsc -b && pnpm exec vitest run dist/registry/__tests__/uploadPublish.test.js`
Expected: PASS (401/403/publish/org/tamper/500/grade/OPTIONS all green).

- [ ] **Step 5: Run the full suite (regression check)**

Run: `pnpm test`
Expected: PASS — no regressions (real-FS scan tests may flake under full concurrency; if any fail, re-run them in isolation before blaming this change).

- [ ] **Step 6: Commit**

```bash
git add src/registry/uploadPublish.ts src/registry/__tests__/uploadPublish.test.ts
git commit -m "feat(registry): enforce account-scope ownership on upload-publish

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```
