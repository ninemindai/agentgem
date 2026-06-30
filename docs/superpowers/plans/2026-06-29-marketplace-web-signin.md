# Marketplace Web Sign-In (M2-A) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add GitHub-OAuth web sign-in to the marketplace: the static SPA gets a session (via a parent-domain cookie set by the API) and knows who the visitor is.

**Architecture:** New `accounts`/`web_sessions` tables + pure store fns in `@agentgem/aggregator`; pure auth helpers (HMAC `state`, cookie parse/serialize) in `src/auth/`; an `installAuth(expressApp, deps)` that registers four **raw express** routes (login/callback/me/logout) — raw because they 302 + Set-Cookie + read cookies, which the decorator framework can't do, and which (like `/healthz`) puts them **outside originGuard**, so they set their own credentialed CORS. The marketplace gains an `auth` client + a sign-in header.

**Tech Stack:** Server — TypeScript ESM (`.js` imports), drizzle/Postgres, `node:crypto`, raw Express, Vitest on **compiled dist**. Marketplace — Vite + React 19, Vitest + jsdom.

## Global Constraints

- **Two test conventions:** Server packages (`@agentgem/aggregator`, root `src/`) — `.js`-extension ESM imports; tests run from **compiled dist** (`pnpm test` = `tsc -b && vitest run`; focused: `pnpm exec tsc -b && pnpm exec vitest run dist/<path>.test.js`); MIT 3-line header on new files. Marketplace (`@agentgem/marketplace`) — **extensionless** imports; `pnpm --filter @agentgem/marketplace test [file]`; assert `.toBeTruthy()`/`.toBeNull()` (NO jest-dom); `vi.stubGlobal`.
- **Session cookie:** name `ag_session`; value = opaque random token; attributes `HttpOnly; Secure; SameSite=Lax; Path=/` and `Domain=<AGENTGEM_SESSION_COOKIE_DOMAIN>` when set. The DB stores `sha256(token)`, never the token.
- **CORS for auth:** only origins in `AGENTGEM_WEB_ORIGINS` (comma-list) get `Access-Control-Allow-Origin: <that origin>` + `Access-Control-Allow-Credentials: true` (wildcard is illegal with credentials). Public reads keep `*` unchanged.
- **Scope** `read:user`. Secrets (`AGENTGEM_GITHUB_CLIENT_SECRET`, `AGENTGEM_SESSION_SECRET`) come only from env — never the repo.
- Reuse the existing `AccountVerifier`/`GitHubVerifier` from `@agentgem/aggregator` (do not reimplement the GitHub `/user` call).
- **TEST-DB PATTERN (authoritative — overrides the `withTestDb` shorthand in the task test code):** the real helper is `makeTestDb(): Promise<AppDb>` from `@agentgem/aggregator` (it already runs `ensureSchema`; **no cleanup needed**). Translate every `await withTestDb(async (db) => { BODY })` in the plan's tests to `{ const db = await makeTestDb(); BODY }`, importing `makeTestDb` from `@agentgem/aggregator`. The store functions (`upsertAccount` etc.) are also imported from `@agentgem/aggregator` (the package barrel), not relative paths.
- **TEST LOCATIONS (post-decomposition):** aggregator-package tests live in `src/aggregator/__tests__/` (NOT `packages/aggregator/src/__tests__/`) and compile to `dist/aggregator/__tests__/`. Root-`src` tests live in `src/__tests__/` → `dist/__tests__/`. The aggregator **source** stays in `packages/aggregator/src/`. So Task 1's `webAuth.test.ts` goes in `src/aggregator/__tests__/webAuth.test.ts`; its run path is `dist/aggregator/__tests__/webAuth.test.js`.

## File structure

```
packages/aggregator/src/
  schema.ts                 MODIFY  accounts + web_sessions tables + ensureSchema DDL
  webAuth.ts                CREATE  Account type + store fns (generateSessionToken/upsertAccount/createSession/resolveSession/deleteSession)
  __tests__/webAuth.test.ts CREATE
  index.ts                  MODIFY  export ./webAuth.js
src/auth/
  state.ts                  CREATE  signState/verifyState (HMAC + TTL, carries returnTo)
  cookie.ts                 CREATE  parseCookies/serializeSessionCookie/clearSessionCookie + SESSION_COOKIE
  install.ts                CREATE  installAuth(expressApp, deps): the 4 raw routes + auth CORS + real githubExchangeCode
src/__tests__/
  authState.test.ts         CREATE
  authCookie.test.ts        CREATE
  authInstall.test.ts       CREATE  (mock req/res; fake exchangeCode + verifier)
src/index.ts                MODIFY  call installAuth(server.expressApp, {...}) with the aggregator db + env config
packages/marketplace/src/
  auth.ts                   CREATE  getMe/logout/loginUrl (credentials:'include')
  auth.test.ts              CREATE
  App.tsx                   MODIFY  load getMe on mount; sign-in / avatar+signout header
  App.test.tsx              MODIFY  header auth states
  styles.css                MODIFY  small auth-header styles (not asserted)
```

---

### Task 1: Account + session store (`@agentgem/aggregator`)

**Files:**
- Modify: `packages/aggregator/src/schema.ts`, `packages/aggregator/src/index.ts`
- Create: `packages/aggregator/src/webAuth.ts` (source), `src/aggregator/__tests__/webAuth.test.ts` (test — see TEST LOCATIONS)

**Interfaces:**
- Consumes: `AppDb` (existing), drizzle `pgTable` (existing import in schema.ts).
- Produces:
  - tables `accounts`, `webSessions`
  - `interface Account { id: string; provider: string; providerAccountId: string; login: string; avatarUrl: string | null }`
  - `generateSessionToken(): { token: string; hash: string }`
  - `upsertAccount(db: AppDb, a: { provider: string; accountId: string; login: string; avatarUrl?: string | null }): Promise<Account>`
  - `createSession(db: AppDb, accountId: string, token: string, ttlMs: number): Promise<void>`
  - `resolveSession(db: AppDb, token: string): Promise<{ login: string; avatarUrl: string | null; accountId: string } | null>`
  - `deleteSession(db: AppDb, token: string): Promise<void>`

- [ ] **Step 1: Add the tables to `schema.ts`**

Add after the `apiKeys` table (before the `schema` object literal):
```ts
export const accounts = pgTable("accounts", {
  id: uuid("id").primaryKey(),
  provider: text("provider").notNull(),
  providerAccountId: text("provider_account_id").notNull(),
  login: text("login").notNull(),
  avatarUrl: text("avatar_url"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const webSessions = pgTable("web_sessions", {
  id: uuid("id").primaryKey(),
  tokenHash: text("token_hash").notNull().unique(),
  accountId: uuid("account_id").notNull().references(() => accounts.id),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
});
```
Add both to the `schema` object: `export const schema = { producers, attestations, ingredients, usageEdges, accountBindings, shareCards, apiKeys, accounts, webSessions };`

Add the DDL to `ensureSchema` (after the `api_keys` line):
```ts
  await db.execute(sql`create table if not exists accounts (id uuid primary key, provider text not null, provider_account_id text not null, login text not null, avatar_url text, created_at timestamptz not null default now(), unique (provider, provider_account_id))`);
  await db.execute(sql`create table if not exists web_sessions (id uuid primary key, token_hash text not null unique, account_id uuid not null references accounts(id), created_at timestamptz not null default now(), expires_at timestamptz not null)`);
```

- [ ] **Step 2: Write the failing test** — `packages/aggregator/src/__tests__/webAuth.test.ts`

```ts
// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
import { describe, it, expect, beforeEach } from "vitest";
import { withTestDb } from "../testDb.js";
import { generateSessionToken, upsertAccount, createSession, resolveSession, deleteSession } from "../webAuth.js";

describe("webAuth store", () => {
  it("generateSessionToken returns a token + its sha256 hash (hash != token)", () => {
    const { token, hash } = generateSessionToken();
    expect(token.length).toBeGreaterThan(20);
    expect(hash).not.toBe(token);
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("upsertAccount inserts then is idempotent on (provider, accountId)", async () => {
    await withTestDb(async (db) => {
      const a = await upsertAccount(db, { provider: "github", accountId: "42", login: "octocat", avatarUrl: "http://x/a.png" });
      expect(a.login).toBe("octocat");
      const b = await upsertAccount(db, { provider: "github", accountId: "42", login: "octocat-renamed" });
      expect(b.id).toBe(a.id);             // same row
      expect(b.login).toBe("octocat-renamed"); // login refreshed
    });
  });

  it("createSession + resolveSession round-trips and stores only the hash", async () => {
    await withTestDb(async (db) => {
      const acct = await upsertAccount(db, { provider: "github", accountId: "7", login: "neo" });
      const { token } = generateSessionToken();
      await createSession(db, acct.id, token, 60_000);
      const r = await resolveSession(db, token);
      expect(r).toEqual({ login: "neo", avatarUrl: null, accountId: acct.id });
    });
  });

  it("resolveSession returns null for an unknown token and for an expired session", async () => {
    await withTestDb(async (db) => {
      expect(await resolveSession(db, "nope")).toBeNull();
      const acct = await upsertAccount(db, { provider: "github", accountId: "9", login: "trin" });
      const { token } = generateSessionToken();
      await createSession(db, acct.id, token, -1000); // already expired
      expect(await resolveSession(db, token)).toBeNull();
    });
  });

  it("deleteSession removes it", async () => {
    await withTestDb(async (db) => {
      const acct = await upsertAccount(db, { provider: "github", accountId: "5", login: "morph" });
      const { token } = generateSessionToken();
      await createSession(db, acct.id, token, 60_000);
      await deleteSession(db, token);
      expect(await resolveSession(db, token)).toBeNull();
    });
  });
});
```

- [ ] **Step 3: Run to verify it fails**

Run: `pnpm exec tsc -b && pnpm exec vitest run dist/aggregator/__tests__/webAuth.test.js` (path is the compiled location; adjust if the package compiles elsewhere — the dist mirror of `packages/aggregator/src/__tests__/webAuth.test.ts`).
Expected: FAIL — `../webAuth.js` missing.

- [ ] **Step 4: Create `packages/aggregator/src/webAuth.ts`**

```ts
// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
// Web account + session store. The session cookie carries an opaque random token; only its
// sha256 hash is persisted, so a DB leak cannot mint sessions.
import { randomUUID, randomBytes, createHash } from "node:crypto";
import { and, eq, gt } from "drizzle-orm";
import type { AppDb } from "./schema.js";
import { accounts, webSessions } from "./schema.js";

const sha256hex = (s: string): string => createHash("sha256").update(s).digest("hex");

export interface Account { id: string; provider: string; providerAccountId: string; login: string; avatarUrl: string | null }

export function generateSessionToken(): { token: string; hash: string } {
  const token = randomBytes(32).toString("base64url");
  return { token, hash: sha256hex(token) };
}

export async function upsertAccount(
  db: AppDb,
  a: { provider: string; accountId: string; login: string; avatarUrl?: string | null },
): Promise<Account> {
  const id = randomUUID();
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

export async function createSession(db: AppDb, accountId: string, token: string, ttlMs: number): Promise<void> {
  await db.insert(webSessions).values({
    id: randomUUID(),
    tokenHash: sha256hex(token),
    accountId,
    expiresAt: new Date(Date.now() + ttlMs),
  });
}

export async function resolveSession(db: AppDb, token: string): Promise<{ login: string; avatarUrl: string | null; accountId: string } | null> {
  const rows = await db
    .select({ login: accounts.login, avatarUrl: accounts.avatarUrl, accountId: accounts.id })
    .from(webSessions)
    .innerJoin(accounts, eq(webSessions.accountId, accounts.id))
    .where(and(eq(webSessions.tokenHash, sha256hex(token)), gt(webSessions.expiresAt, new Date())))
    .limit(1);
  return rows[0] ?? null;
}

export async function deleteSession(db: AppDb, token: string): Promise<void> {
  await db.delete(webSessions).where(eq(webSessions.tokenHash, sha256hex(token)));
}
```

> NOTE: `onConflictDoUpdate` requires a unique constraint on `(provider, provider_account_id)` — the `ensureSchema` DDL above declares it. Confirm `AppDb` is exported from `./schema.js` (it's referenced as `type { AppDb }` elsewhere in the package); if it lives in another module, import it from there.

- [ ] **Step 5: Export from the package** — in `packages/aggregator/src/index.ts` add: `export * from "./webAuth.js";`

- [ ] **Step 6: Run to verify it passes**

Run: `pnpm exec tsc -b && pnpm exec vitest run dist/aggregator/__tests__/webAuth.test.js`
Expected: PASS (5 tests).

- [ ] **Step 7: Commit**

```bash
git add packages/aggregator/src/schema.ts packages/aggregator/src/webAuth.ts src/aggregator/__tests__/webAuth.test.ts packages/aggregator/src/index.ts
git commit -m "feat(aggregator): accounts + web_sessions store for web sign-in"
```

---

### Task 2: Pure auth helpers — OAuth state + cookies

**Files:**
- Create: `src/auth/state.ts`, `src/auth/cookie.ts`, `src/__tests__/authState.test.ts`, `src/__tests__/authCookie.test.ts`

**Interfaces:**
- Produces:
  - `state.ts`: `signState(payload: { returnTo: string }, secret: string, nowMs: number): string`; `verifyState(state: string, secret: string, nowMs: number, maxAgeMs: number): { returnTo: string } | null`
  - `cookie.ts`: `SESSION_COOKIE = "ag_session"`; `parseCookies(header: string | undefined): Record<string, string>`; `serializeSessionCookie(token: string, opts: { domain?: string; maxAgeSec: number }): string`; `clearSessionCookie(opts: { domain?: string }): string`

- [ ] **Step 1: Write the failing tests**

`src/__tests__/authState.test.ts`:
```ts
// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
import { describe, it, expect } from "vitest";
import { signState, verifyState } from "../auth/state.js";

const SECRET = "test-secret";
describe("auth state (HMAC + TTL)", () => {
  it("round-trips returnTo and verifies within the TTL", () => {
    const s = signState({ returnTo: "https://explore.agentgem.ai/gems" }, SECRET, 1000);
    expect(verifyState(s, SECRET, 1500, 60_000)).toEqual({ returnTo: "https://explore.agentgem.ai/gems" });
  });
  it("rejects a tampered state", () => {
    const s = signState({ returnTo: "https://explore.agentgem.ai" }, SECRET, 1000);
    expect(verifyState(s + "x", SECRET, 1500, 60_000)).toBeNull();
  });
  it("rejects a wrong secret", () => {
    const s = signState({ returnTo: "https://explore.agentgem.ai" }, SECRET, 1000);
    expect(verifyState(s, "other", 1500, 60_000)).toBeNull();
  });
  it("rejects an expired state", () => {
    const s = signState({ returnTo: "https://explore.agentgem.ai" }, SECRET, 1000);
    expect(verifyState(s, SECRET, 1000 + 70_000, 60_000)).toBeNull();
  });
});
```

`src/__tests__/authCookie.test.ts`:
```ts
// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
import { describe, it, expect } from "vitest";
import { SESSION_COOKIE, parseCookies, serializeSessionCookie, clearSessionCookie } from "../auth/cookie.js";

describe("auth cookie", () => {
  it("parses a Cookie header into a map", () => {
    expect(parseCookies("a=1; ag_session=tok123; b=2")[SESSION_COOKIE]).toBe("tok123");
    expect(parseCookies(undefined)).toEqual({});
  });
  it("serializes the session cookie with the security attributes + domain", () => {
    const c = serializeSessionCookie("tok123", { domain: ".agentgem.ai", maxAgeSec: 3600 });
    expect(c).toContain("ag_session=tok123");
    expect(c).toContain("HttpOnly");
    expect(c).toContain("Secure");
    expect(c).toContain("SameSite=Lax");
    expect(c).toContain("Path=/");
    expect(c).toContain("Domain=.agentgem.ai");
    expect(c).toContain("Max-Age=3600");
  });
  it("omits Domain when not provided (dev)", () => {
    expect(serializeSessionCookie("t", { maxAgeSec: 60 })).not.toContain("Domain=");
  });
  it("clearSessionCookie expires it (Max-Age=0)", () => {
    expect(clearSessionCookie({ domain: ".agentgem.ai" })).toContain("Max-Age=0");
  });
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `pnpm exec tsc -b && pnpm exec vitest run dist/__tests__/authState.test.js dist/__tests__/authCookie.test.js`
Expected: FAIL — modules missing.

- [ ] **Step 3: Create `src/auth/state.ts`**

```ts
// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
// OAuth `state`: a signed, time-boxed token carrying the post-login return URL. HMAC prevents
// tampering; the timestamp bounds replay. This is the CSRF defense for the redirect leg.
import { createHmac, timingSafeEqual } from "node:crypto";

interface StatePayload { returnTo: string; iat: number }

function hmac(data: string, secret: string): string {
  return createHmac("sha256", secret).update(data).digest("base64url");
}

export function signState(payload: { returnTo: string }, secret: string, nowMs: number): string {
  const body = Buffer.from(JSON.stringify({ returnTo: payload.returnTo, iat: nowMs } satisfies StatePayload)).toString("base64url");
  return `${body}.${hmac(body, secret)}`;
}

export function verifyState(state: string, secret: string, nowMs: number, maxAgeMs: number): { returnTo: string } | null {
  const dot = state.lastIndexOf(".");
  if (dot <= 0) return null;
  const body = state.slice(0, dot);
  const sig = state.slice(dot + 1);
  const expected = hmac(body, secret);
  const a = Buffer.from(sig), b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  try {
    const p = JSON.parse(Buffer.from(body, "base64url").toString()) as StatePayload;
    if (typeof p.returnTo !== "string" || typeof p.iat !== "number") return null;
    if (nowMs - p.iat > maxAgeMs || nowMs < p.iat) return null;
    return { returnTo: p.returnTo };
  } catch { return null; }
}
```

- [ ] **Step 4: Create `src/auth/cookie.ts`**

```ts
// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
// Session cookie (de)serialization. The value is an opaque token; attributes make it a first-party,
// XSS-safe, same-site cookie shared across *.agentgem.ai subdomains.
export const SESSION_COOKIE = "ag_session";

export function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq < 0) continue;
    const k = part.slice(0, eq).trim();
    if (k) out[k] = part.slice(eq + 1).trim();
  }
  return out;
}

function base(token: string, domain?: string): string {
  const attrs = [`${SESSION_COOKIE}=${token}`, "HttpOnly", "Secure", "SameSite=Lax", "Path=/"];
  if (domain) attrs.push(`Domain=${domain}`);
  return attrs.join("; ");
}

export function serializeSessionCookie(token: string, opts: { domain?: string; maxAgeSec: number }): string {
  return `${base(token, opts.domain)}; Max-Age=${opts.maxAgeSec}`;
}

export function clearSessionCookie(opts: { domain?: string }): string {
  return `${base("", opts.domain)}; Max-Age=0`;
}
```

- [ ] **Step 5: Run to verify they pass**

Run: `pnpm exec tsc -b && pnpm exec vitest run dist/__tests__/authState.test.js dist/__tests__/authCookie.test.js`
Expected: PASS (8 tests).

- [ ] **Step 6: Commit**

```bash
git add src/auth/state.ts src/auth/cookie.ts src/__tests__/authState.test.ts src/__tests__/authCookie.test.ts
git commit -m "feat(auth): pure OAuth state + session-cookie helpers"
```

---

### Task 3: `installAuth` — raw express routes + index wiring

**Files:**
- Create: `src/auth/install.ts`, `src/__tests__/authInstall.test.ts`
- Modify: `src/index.ts`

**Interfaces:**
- Consumes: `upsertAccount`/`createSession`/`resolveSession`/`deleteSession`/`generateSessionToken` + `AccountVerifier` (Task 1 / `@agentgem/aggregator`); `signState`/`verifyState` (Task 2 state.ts); `SESSION_COOKIE`/`parseCookies`/`serializeSessionCookie`/`clearSessionCookie` (Task 2 cookie.ts).
- Produces:
  - `interface AuthConfig { clientId: string; clientSecret: string; webOrigins: string[]; cookieDomain?: string; callbackUrl: string; stateSecret: string; sessionTtlMs: number }`
  - `interface AuthDeps { db: AppDb; verifier: AccountVerifier; exchangeCode: (code: string) => Promise<string>; config: AuthConfig }`
  - `githubExchangeCode(clientId, clientSecret): (code: string) => Promise<string>` (the real GitHub token exchange)
  - `installAuth(expressApp: ExpressApp, deps: AuthDeps): void` — registers GET `/api/auth/github/login`, GET `/api/auth/github/callback`, GET `/api/auth/me`, POST `/api/auth/logout`.
  - The four route handlers are also exported individually (`loginHandler(deps)`, `callbackHandler(deps)`, `meHandler(deps)`, `logoutHandler(deps)`) returning `(req, res) => Promise<void>|void`, so tests drive them with mock req/res (the originGuard-style duck-typed shape).

- [ ] **Step 1: Write the failing test** — `src/__tests__/authInstall.test.ts`

```ts
// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
import { describe, it, expect } from "vitest";
import { withTestDb } from "@agentgem/aggregator";
import { resolveSession } from "@agentgem/aggregator";
import { loginHandler, callbackHandler, meHandler, logoutHandler } from "../auth/install.js";
import { SESSION_COOKIE } from "../auth/cookie.js";

const cfg = {
  clientId: "cid", clientSecret: "sec", webOrigins: ["https://explore.agentgem.ai"],
  cookieDomain: ".agentgem.ai", callbackUrl: "https://app.agentgem.ai/api/auth/github/callback",
  stateSecret: "ssecret", sessionTtlMs: 3_600_000,
};
// Minimal mock req/res capturing what the handlers do.
function mockRes() {
  const r: any = { _status: 200, _headers: {} as Record<string, string>, _body: undefined as unknown, _redirect: undefined as string | undefined };
  r.status = (c: number) => { r._status = c; return r; };
  r.set = (k: string, v: string) => { r._headers[k.toLowerCase()] = v; return r; };
  r.setHeader = (k: string, v: string) => { r._headers[k.toLowerCase()] = v; return r; };
  r.json = (b: unknown) => { r._body = b; return r; };
  r.send = (b: unknown) => { r._body = b; return r; };
  r.redirect = (c: number, u?: string) => { if (typeof c === "number") { r._status = c; r._redirect = u; } else { r._redirect = c as unknown as string; } return r; };
  return r;
}
const mockReq = (over: any = {}) => ({ method: "GET", path: "/", query: {}, headers: {}, get(n: string) { return (this.headers as any)[n.toLowerCase()]; }, ...over });

const deps = (db: any) => ({ db, verifier: { verify: async () => ({ provider: "github", accountId: "42", login: "octocat" }) }, exchangeCode: async () => "gh-token", config: cfg });

describe("auth handlers", () => {
  it("login rejects an off-allowlist return and 302s to github for an allowed one", async () => {
    await withTestDb(async (db) => {
      const bad = mockRes();
      await loginHandler(deps(db))(mockReq({ query: { return: "https://evil.example/x" } }) as any, bad as any);
      expect(bad._status).toBe(400);

      const ok = mockRes();
      await loginHandler(deps(db))(mockReq({ query: { return: "https://explore.agentgem.ai/gems" } }) as any, ok as any);
      expect(ok._redirect).toContain("https://github.com/login/oauth/authorize");
      expect(ok._redirect).toContain("state=");
      expect(ok._redirect).toContain("scope=read%3Auser");
    });
  });

  it("callback exchanges + verifies + sets the session cookie + 302s to returnTo", async () => {
    await withTestDb(async (db) => {
      // produce a valid state by running login first and pulling it out of the redirect URL
      const login = mockRes();
      await loginHandler(deps(db))(mockReq({ query: { return: "https://explore.agentgem.ai/gems" } }) as any, login as any);
      const state = new URL(login._redirect!).searchParams.get("state")!;

      const cb = mockRes();
      await callbackHandler(deps(db))(mockReq({ query: { code: "abc", state } }) as any, cb as any);
      expect(cb._redirect).toBe("https://explore.agentgem.ai/gems");
      const setCookie = cb._headers["set-cookie"] as string;
      expect(setCookie).toContain(`${SESSION_COOKIE}=`);
      expect(setCookie).toContain("HttpOnly");
      // the session is resolvable
      const token = setCookie.split(";")[0].split("=")[1];
      expect((await resolveSession(db, token))?.login).toBe("octocat");
    });
  });

  it("callback with a bad state redirects with auth_error and sets no cookie", async () => {
    await withTestDb(async (db) => {
      const cb = mockRes();
      await callbackHandler(deps(db))(mockReq({ query: { code: "abc", state: "garbage" } }) as any, cb as any);
      expect(cb._redirect).toContain("auth_error");
      expect(cb._headers["set-cookie"]).toBeUndefined();
    });
  });

  it("me returns the identity for a valid cookie + credentialed CORS for an allowed origin", async () => {
    await withTestDb(async (db) => {
      const login = mockRes();
      await loginHandler(deps(db))(mockReq({ query: { return: "https://explore.agentgem.ai" } }) as any, login as any);
      const state = new URL(login._redirect!).searchParams.get("state")!;
      const cb = mockRes();
      await callbackHandler(deps(db))(mockReq({ query: { code: "abc", state } }) as any, cb as any);
      const token = (cb._headers["set-cookie"] as string).split(";")[0].split("=")[1];

      const me = mockRes();
      await meHandler(deps(db))(mockReq({ headers: { cookie: `${SESSION_COOKIE}=${token}`, origin: "https://explore.agentgem.ai" } }) as any, me as any);
      expect(me._body).toEqual({ login: "octocat", avatarUrl: null });
      expect(me._headers["access-control-allow-origin"]).toBe("https://explore.agentgem.ai");
      expect(me._headers["access-control-allow-credentials"]).toBe("true");
    });
  });

  it("me returns unauthenticated without a cookie, and no CORS for a non-allowlisted origin", async () => {
    await withTestDb(async (db) => {
      const me = mockRes();
      await meHandler(deps(db))(mockReq({ headers: { origin: "https://evil.example" } }) as any, me as any);
      expect(me._body).toEqual({ authenticated: false });
      expect(me._headers["access-control-allow-origin"]).toBeUndefined();
    });
  });

  it("logout deletes the session and clears the cookie", async () => {
    await withTestDb(async (db) => {
      const login = mockRes();
      await loginHandler(deps(db))(mockReq({ query: { return: "https://explore.agentgem.ai" } }) as any, login as any);
      const state = new URL(login._redirect!).searchParams.get("state")!;
      const cb = mockRes();
      await callbackHandler(deps(db))(mockReq({ query: { code: "abc", state } }) as any, cb as any);
      const token = (cb._headers["set-cookie"] as string).split(";")[0].split("=")[1];

      const out = mockRes();
      await logoutHandler(deps(db))(mockReq({ method: "POST", headers: { cookie: `${SESSION_COOKIE}=${token}`, origin: "https://explore.agentgem.ai" } }) as any, out as any);
      expect(out._body).toEqual({ ok: true });
      expect(await resolveSession(db, token)).toBeNull();
      expect(out._headers["set-cookie"]).toContain("Max-Age=0");
    });
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm exec tsc -b && pnpm exec vitest run dist/__tests__/authInstall.test.js`
Expected: FAIL — `../auth/install.js` missing.

- [ ] **Step 3: Create `src/auth/install.ts`**

```ts
// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
// Web sign-in: four RAW express routes (302 + Set-Cookie + cookie reads, which the decorator
// framework can't do). Raw routes are OUTSIDE originGuard (like /healthz), so they set their own
// credentialed CORS for the AGENTGEM_WEB_ORIGINS allowlist. SameSite=Lax + the OAuth `state` are the
// CSRF defenses (a cross-site POST carries no session cookie under Lax).
import type { AppDb, AccountVerifier } from "@agentgem/aggregator";
import { upsertAccount, createSession, deleteSession, resolveSession, generateSessionToken } from "@agentgem/aggregator";
import { signState, verifyState } from "./state.js";
import { SESSION_COOKIE, parseCookies, serializeSessionCookie, clearSessionCookie } from "./cookie.js";

export interface AuthConfig {
  clientId: string; clientSecret: string; webOrigins: string[];
  cookieDomain?: string; callbackUrl: string; stateSecret: string; sessionTtlMs: number;
}
export interface AuthDeps { db: AppDb; verifier: AccountVerifier; exchangeCode: (code: string) => Promise<string>; config: AuthConfig }

// duck-typed Express req/res (no @types/express dependency, matching originGuard / the SSE handlers)
interface Req { method: string; path: string; query: Record<string, unknown>; headers: Record<string, string | undefined>; get(name: string): string | undefined }
interface Res { status(c: number): Res; set(k: string, v: string): Res; setHeader(k: string, v: string): Res; json(b: unknown): Res; send(b: unknown): Res; redirect(code: number, url?: string): Res }
type ExpressApp = { get(path: string, h: (req: Req, res: Res) => unknown): unknown; post(path: string, h: (req: Req, res: Res) => unknown): unknown };

const STATE_TTL_MS = 10 * 60 * 1000;

/** Echo credentialed CORS for an allowlisted Origin (wildcard is illegal with credentials). */
function authCors(req: Req, res: Res, origins: string[]): void {
  const origin = req.headers["origin"];
  if (origin && origins.includes(origin)) {
    res.set("Access-Control-Allow-Origin", origin);
    res.set("Access-Control-Allow-Credentials", "true");
    res.set("Vary", "Origin");
  }
}

const firstWebOrigin = (cfg: AuthConfig): string => cfg.webOrigins[0] ?? "/";

export function loginHandler(deps: AuthDeps) {
  return (req: Req, res: Res): void => {
    const ret = String((req.query.return as string | undefined) ?? "");
    if (!deps.config.webOrigins.some((o) => ret === o || ret.startsWith(o + "/"))) {
      res.status(400).json({ error: "invalid return url" });
      return;
    }
    const state = signState({ returnTo: ret }, deps.config.stateSecret, Date.now());
    const u = new URL("https://github.com/login/oauth/authorize");
    u.searchParams.set("client_id", deps.config.clientId);
    u.searchParams.set("redirect_uri", deps.config.callbackUrl);
    u.searchParams.set("scope", "read:user");
    u.searchParams.set("state", state);
    res.redirect(302, u.toString());
  };
}

export function callbackHandler(deps: AuthDeps) {
  return async (req: Req, res: Res): Promise<void> => {
    const code = String((req.query.code as string | undefined) ?? "");
    const state = String((req.query.state as string | undefined) ?? "");
    const v = verifyState(state, deps.config.stateSecret, Date.now(), STATE_TTL_MS);
    const fallback = firstWebOrigin(deps.config);
    if (!v || !code) { res.redirect(302, `${fallback}?auth_error=state`); return; }
    try {
      const token = await deps.exchangeCode(code);
      const acct = await deps.verifier.verify(token);
      const row = await upsertAccount(deps.db, { provider: acct.provider, accountId: acct.accountId, login: acct.login });
      const { token: sessionToken } = generateSessionToken();
      await createSession(deps.db, row.id, sessionToken, deps.config.sessionTtlMs);
      res.setHeader("Set-Cookie", serializeSessionCookie(sessionToken, { domain: deps.config.cookieDomain, maxAgeSec: Math.floor(deps.config.sessionTtlMs / 1000) }));
      res.redirect(302, v.returnTo);
    } catch {
      res.redirect(302, `${fallback}?auth_error=exchange`);
    }
  };
}

export function meHandler(deps: AuthDeps) {
  return async (req: Req, res: Res): Promise<void> => {
    authCors(req, res, deps.config.webOrigins);
    if (req.method === "OPTIONS") { res.set("Access-Control-Allow-Methods", "GET, POST, OPTIONS").set("Access-Control-Allow-Headers", "content-type").status(204).send(""); return; }
    const token = parseCookies(req.headers["cookie"])[SESSION_COOKIE];
    const who = token ? await resolveSession(deps.db, token) : null;
    if (!who) { res.json({ authenticated: false }); return; }
    res.json({ login: who.login, avatarUrl: who.avatarUrl });
  };
}

export function logoutHandler(deps: AuthDeps) {
  return async (req: Req, res: Res): Promise<void> => {
    authCors(req, res, deps.config.webOrigins);
    if (req.method === "OPTIONS") { res.set("Access-Control-Allow-Methods", "GET, POST, OPTIONS").set("Access-Control-Allow-Headers", "content-type").status(204).send(""); return; }
    const token = parseCookies(req.headers["cookie"])[SESSION_COOKIE];
    if (token) await deleteSession(deps.db, token);
    res.setHeader("Set-Cookie", clearSessionCookie({ domain: deps.config.cookieDomain }));
    res.json({ ok: true });
  };
}

/** The real GitHub authorization-code exchange. */
export function githubExchangeCode(clientId: string, clientSecret: string): (code: string) => Promise<string> {
  return async (code: string): Promise<string> => {
    const res = await fetch("https://github.com/login/oauth/access_token", {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({ client_id: clientId, client_secret: clientSecret, code }),
    });
    if (!res.ok) throw new Error(`github token exchange: ${res.status}`);
    const j = (await res.json()) as { access_token?: unknown };
    if (typeof j.access_token !== "string") throw new Error("github token exchange: no access_token");
    return j.access_token;
  };
}

export function installAuth(expressApp: ExpressApp, deps: AuthDeps): void {
  expressApp.get("/api/auth/github/login", loginHandler(deps));
  expressApp.get("/api/auth/github/callback", callbackHandler(deps));
  expressApp.get("/api/auth/me", meHandler(deps));
  expressApp.post("/api/auth/logout", logoutHandler(deps));
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `pnpm exec tsc -b && pnpm exec vitest run dist/__tests__/authInstall.test.js`
Expected: PASS (6 tests). If `withTestDb` isn't exported from `@agentgem/aggregator`, import it from its real module and re-run.

- [ ] **Step 5: Wire into `src/index.ts`**

Add the import near the other auth/aggregator imports:
```ts
import { installAuth, githubExchangeCode } from "./auth/install.js";
import { GitHubVerifier } from "@agentgem/aggregator";
```
Inside the block where the aggregator `db` is in scope (right after `mountGating(app, db)` / the aggregator registration, where `const { db } = await resolveAggregatorDb()` exists), and only when web sign-in is configured, register the routes on the raw express app **after** `const server = await app.restServer` (so `server.expressApp` exists — if the db is resolved earlier, capture it in an outer `let aggDb` and call `installAuth` in the raw-route section next to `/healthz`):
```ts
  // Web sign-in (marketplace). Raw express routes (302 + Set-Cookie), outside originGuard; they set
  // their own credentialed CORS for AGENTGEM_WEB_ORIGINS. Enabled only when the OAuth secret is set.
  const ghClientId = process.env.AGENTGEM_GITHUB_CLIENT_ID;
  const ghSecret = process.env.AGENTGEM_GITHUB_CLIENT_SECRET;
  const webOrigins = (process.env.AGENTGEM_WEB_ORIGINS ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  if (ghClientId && ghSecret && webOrigins.length > 0 && aggDb) {
    installAuth(server.expressApp, {
      db: aggDb,
      verifier: new GitHubVerifier(),
      exchangeCode: githubExchangeCode(ghClientId, ghSecret),
      config: {
        clientId: ghClientId, clientSecret: ghSecret, webOrigins,
        cookieDomain: process.env.AGENTGEM_SESSION_COOKIE_DOMAIN,
        callbackUrl: `${process.env.AGENTGEM_PUBLIC_BASE ?? "https://app.agentgem.ai"}/api/auth/github/callback`,
        stateSecret: process.env.AGENTGEM_SESSION_SECRET ?? ghSecret,
        sessionTtlMs: 30 * 24 * 60 * 60 * 1000, // 30 days
      },
    });
  }
```
> Implementation detail to resolve while wiring: the aggregator `db` is currently a `const` scoped inside the registration `if`-block. Hoist it to an outer `let aggDb: AppDb | undefined` assigned there, so it's reachable in the raw-route section. Don't change the aggregator registration logic otherwise.

- [ ] **Step 6: Verify the server still builds + the auth test passes together**

Run: `pnpm exec tsc -b && pnpm exec vitest run dist/__tests__/authInstall.test.js dist/__tests__/authState.test.js dist/__tests__/authCookie.test.js`
Expected: PASS. Also confirm `tsc -b` is clean (the index.ts wiring typechecks).

- [ ] **Step 7: Commit**

```bash
git add src/auth/install.ts src/__tests__/authInstall.test.ts src/index.ts
git commit -m "feat(auth): web sign-in routes (login/callback/me/logout) + index wiring"
```

---

### Task 4: Frontend — auth client + sign-in header

**Files:**
- Create: `packages/marketplace/src/auth.ts`, `packages/marketplace/src/auth.test.ts`
- Modify: `packages/marketplace/src/App.tsx`, `packages/marketplace/src/App.test.tsx`, `packages/marketplace/src/styles.css`

**Interfaces:**
- Consumes: `defaultApiBase` (existing `api.ts`).
- Produces: `makeAuth(base)` → `{ getMe(): Promise<{login,avatarUrl}|null>; logout(): Promise<void>; loginUrl(returnTo: string): string }`.

- [ ] **Step 1: Write the failing auth-client test** — `packages/marketplace/src/auth.test.ts`

```ts
import { describe, it, expect, vi, afterEach } from "vitest";
import { makeAuth } from "./auth";

afterEach(() => vi.unstubAllGlobals());
const res = (body: unknown, ok = true) => ({ ok, status: ok ? 200 : 401, json: async () => body }) as unknown as Response;

describe("makeAuth", () => {
  it("getMe returns the identity when authenticated (credentials included)", async () => {
    let opts: RequestInit | undefined;
    vi.stubGlobal("fetch", vi.fn(async (_u: string, o?: RequestInit) => { opts = o; return res({ login: "octocat", avatarUrl: "a.png" }); }));
    const auth = makeAuth("https://app.x");
    expect(await auth.getMe()).toEqual({ login: "octocat", avatarUrl: "a.png" });
    expect(opts?.credentials).toBe("include");
  });
  it("getMe returns null when unauthenticated", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => res({ authenticated: false })));
    expect(await makeAuth("https://app.x").getMe()).toBeNull();
  });
  it("getMe returns null on a network error (never throws to the UI)", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("net"); }));
    expect(await makeAuth("https://app.x").getMe()).toBeNull();
  });
  it("loginUrl points at the API login with an encoded return", () => {
    expect(makeAuth("https://app.x").loginUrl("https://explore.y/gems"))
      .toBe("https://app.x/api/auth/github/login?return=" + encodeURIComponent("https://explore.y/gems"));
  });
  it("logout POSTs with credentials", async () => {
    let method: string | undefined, cred: RequestCredentials | undefined;
    vi.stubGlobal("fetch", vi.fn(async (_u: string, o?: RequestInit) => { method = o?.method; cred = o?.credentials; return res({ ok: true }); }));
    await makeAuth("https://app.x").logout();
    expect(method).toBe("POST");
    expect(cred).toBe("include");
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm --filter @agentgem/marketplace test src/auth.test.ts`
Expected: FAIL — `./auth` missing.

- [ ] **Step 3: Create `packages/marketplace/src/auth.ts`**

```ts
/** Web sign-in client. All calls are credentialed so the parent-domain session cookie travels. */
export interface Me { login: string; avatarUrl: string | null }

export function makeAuth(base: string) {
  return {
    async getMe(): Promise<Me | null> {
      try {
        const r = await fetch(base + "/api/auth/me", { credentials: "include" });
        if (!r.ok) return null;
        const j = (await r.json()) as { login?: string; avatarUrl?: string | null; authenticated?: boolean };
        return j.login ? { login: j.login, avatarUrl: j.avatarUrl ?? null } : null;
      } catch { return null; }
    },
    async logout(): Promise<void> {
      try { await fetch(base + "/api/auth/logout", { method: "POST", credentials: "include" }); } catch { /* ignore */ }
    },
    loginUrl(returnTo: string): string {
      return base + "/api/auth/github/login?return=" + encodeURIComponent(returnTo);
    },
  };
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `pnpm --filter @agentgem/marketplace test src/auth.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Write the failing App header test** — append inside the existing `describe` in `packages/marketplace/src/App.test.tsx` (the file already has a `res` helper + URL-resetting `afterEach`; the leaderboard fetch is already stubbed in existing cases). These cases stub `fetch` to drive `/api/auth/me`:

```tsx
  it("shows a Sign in link when unauthenticated", async () => {
    vi.stubGlobal("fetch", vi.fn(async (u: string) => {
      if (u.includes("/api/auth/me")) return res({ authenticated: false });
      return res([]); // leaderboard / other reads
    }));
    render(<App />);
    const link = await screen.findByRole("link", { name: /sign in/i });
    expect(link.getAttribute("href")).toContain("/api/auth/github/login?return=");
  });

  it("shows the login + Sign out when authenticated", async () => {
    vi.stubGlobal("fetch", vi.fn(async (u: string) => {
      if (u.includes("/api/auth/me")) return res({ login: "octocat", avatarUrl: null });
      return res([]);
    }));
    render(<App />);
    expect(await screen.findByText("octocat")).toBeTruthy();
    expect(screen.getByRole("button", { name: /sign out/i })).toBeTruthy();
  });
```

- [ ] **Step 6: Run to verify it fails**

Run: `pnpm --filter @agentgem/marketplace test src/App.test.tsx`
Expected: FAIL — no sign-in link / no auth header yet.

- [ ] **Step 7: Add the auth header to `App.tsx`**

Add the auth client + state, load `getMe()` on mount, and render the header control. The full updated `App.tsx`:

```tsx
import { useEffect, useState } from "react";
import { makeApi, defaultApiBase } from "./api";
import { makeAuth, type Me } from "./auth";
import { Router } from "./Router";

const api = makeApi(defaultApiBase());
const auth = makeAuth(defaultApiBase());

export function App() {
  const [path, setPath] = useState(() => window.location.pathname);
  const [me, setMe] = useState<Me | null>(null);

  useEffect(() => {
    let alive = true;
    auth.getMe().then((m) => { if (alive) setMe(m); });
    const onPop = () => setPath(window.location.pathname);
    const onClick = (e: MouseEvent) => {
      const a = (e.target as HTMLElement).closest("a");
      if (!a) return;
      const href = a.getAttribute("href");
      if (!href || !href.startsWith("/") || href.startsWith("//") || a.target === "_blank" || e.metaKey || e.ctrlKey || e.shiftKey) return;
      e.preventDefault();
      window.history.pushState({}, "", href);
      window.dispatchEvent(new PopStateEvent("popstate"));
    };
    document.addEventListener("click", onClick);
    window.addEventListener("popstate", onPop);
    return () => { alive = false; document.removeEventListener("click", onClick); window.removeEventListener("popstate", onPop); };
  }, []);

  const onGems = path.startsWith("/gems");
  const signOut = async () => { await auth.logout(); setMe(null); };

  return (
    <div className="ex-app">
      <header className="ex-header">
        <a href="/" className="ex-brand">AgentGem Explore</a>
        <nav className="ex-nav">
          <a href="/" className={"ex-navlink" + (onGems ? "" : " is-active")}>Ingredients</a>
          <a href="/gems" className={"ex-navlink" + (onGems ? " is-active" : "")}>Gems</a>
        </nav>
        <span className="ex-auth">
          {me ? (
            <>
              {me.avatarUrl && <img className="ex-avatar" src={me.avatarUrl} alt="" width={20} height={20} />}
              <span className="ex-login">{me.login}</span>
              <button type="button" className="ex-signout" onClick={signOut}>Sign out</button>
            </>
          ) : (
            <a className="ex-signin" href={auth.loginUrl(window.location.href)}>Sign in with GitHub</a>
          )}
        </span>
      </header>
      <main className="ex-main"><Router api={api} /></main>
      <footer className="ex-footer">Trusted-adoption data, k-anonymized. <a href="https://agentgem.ai">agentgem.ai</a></footer>
    </div>
  );
}
```
> The `Sign in with GitHub` link is an `<a href="https://app.agentgem.ai/api/auth/...">` — an absolute, cross-origin URL. The App click-interceptor only intercepts `href.startsWith("/")`, so this external link navigates normally (correct — OAuth needs a full navigation).

- [ ] **Step 8: Append header styles to `styles.css`** (not asserted)

```css
.ex-auth { margin-left: auto; display: flex; align-items: center; gap: 8px; }
.ex-avatar { border-radius: 50%; }
.ex-login { font-size: .9em; }
.ex-signin, .ex-signout { font-size: .85em; cursor: pointer; }
.ex-signout { border: 1px solid #ddd; border-radius: 4px; background: #fff; padding: 2px 8px; }
```

- [ ] **Step 9: Full marketplace gate**

Run: `pnpm --filter @agentgem/marketplace test && pnpm --filter @agentgem/marketplace typecheck && pnpm --filter @agentgem/marketplace build`
Expected: all tests pass (auth + App + existing), typecheck clean, build writes `dist/`.

- [ ] **Step 10: Commit**

```bash
git add packages/marketplace/src/auth.ts packages/marketplace/src/auth.test.ts packages/marketplace/src/App.tsx packages/marketplace/src/App.test.tsx packages/marketplace/src/styles.css
git commit -m "feat(marketplace): web sign-in client + header (Sign in with GitHub / Sign out)"
```

---

## Final verification

- [ ] **Backend suite** (compiled dist): `pnpm test` (= `tsc -b && vitest run`) → green, including `webAuth`, `authState`, `authCookie`, `authInstall`; the aggregator + controller suites unaffected.
- [ ] **Marketplace gate:** `pnpm --filter @agentgem/marketplace test && … typecheck && … build` → green.
- [ ] **Deploy + manual smoke (you-run-it, on the LIVE domains — the cross-site cookie can only be verified there):**
  1. Register the OAuth callback `https://app.agentgem.ai/api/auth/github/callback` on the GitHub OAuth app.
  2. Set on the Render `agentgem` service: `AGENTGEM_GITHUB_CLIENT_SECRET`, `AGENTGEM_WEB_ORIGINS=https://explore.agentgem.ai`, `AGENTGEM_SESSION_COOKIE_DOMAIN=.agentgem.ai`, `AGENTGEM_SESSION_SECRET` (random), `AGENTGEM_PUBLIC_BASE=https://app.agentgem.ai`. (`AGENTGEM_GITHUB_CLIENT_ID` already set.)
  3. On `explore.agentgem.ai`: click **Sign in with GitHub** → authorize → land back signed in (avatar + login shown); reload keeps you signed in (cookie persists); **Sign out** clears it. Confirm `app.agentgem.ai/api/auth/me` returns `{authenticated:false}` cross-origin without the cookie and your identity with it.
- [ ] **Note:** sign-in will NOT round-trip on `localhost` / the raw `onrender.com` URLs (parent-domain cookie) — that's the accepted dev caveat; everything else in the marketplace still works signed-out there.
