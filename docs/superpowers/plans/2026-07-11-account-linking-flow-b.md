# Account Linking Flow B Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a logged-in user fold a *fresh* second account (whose provider they OAuth) into the account they're keeping — the collision half of "Connect a provider" that Flow A deferred.

**Architecture:** A bespoke connect flow reuses better-auth's own provider objects to do the OAuth round-trip (no hand-rolled crypto) and stays on the caller's session. It reuses better-auth's single registered callback URL, routed by a `state` shim registered before `mountAuth`. The resolved *other* identity is stashed against the caller's session (`stashPendingLink`, already built) and consumed by a new `POST /api/account/absorb` that calls the already-built, already-tested `absorbAccount`.

**Tech Stack:** better-auth 1.6.23 (`auth.$context.socialProviders`), Drizzle + Postgres, raw Express installers under `src/**`, Vitest (root `src/**/__tests__` → `dist/**`, CI-gated; marketplace vitest now CI-gated too), React marketplace SPA.

## Global Constraints

- **Node floor `>=24`.** CI runs `test (24)`.
- **Backend tests live under ROOT `src/**/__tests__`** and import the built `@agentgem/aggregator`. After editing `packages/aggregator/src/**`, run `pnpm -w build`, then run vitest against the **compiled** path: `pnpm -w vitest run dist/<area>/__tests__/<name>.test.js` (NOT `src/...ts` — the vitest `include` glob is `dist/**`).
- **Marketplace tests** run via `pnpm -C packages/marketplace exec vitest run <file>` and are now CI-gated — keep them + `pnpm -C packages/marketplace exec tsc --noEmit` green.
- **The *other* account's identity is ALWAYS server-verified** (from the OAuth exchange) and bound to the caller's session via `connect_states` → `pending_account_links`. **Never** accept a client-supplied account/provider id for the other side.
- **The session cookie is never read for identity and never swapped** during connect — the caller stays on `current` until `absorbAccount` deliberately re-mints onto the survivor.
- **`absorbAccount` is the sole freshness authority.** No route re-judges freshness; the connect callback never inspects it.
- **Reuse better-auth's provider object** (`ctx.socialProviders`) for the exchange; `redirectURI = \`${ctx.baseURL}/callback/${providerId}\`` (== the registered `/api/auth/callback/:provider`). Confirmed provider call shapes: `provider.validateAuthorizationCode({ code, codeVerifier, redirectURI })` → tokens; `provider.getUserInfo({ ...tokens }).then(r => r?.user)` → `{ id }`; `providerAccountId = String(user.id)`.
- **`connect_states` store** (new): `state_hash text PK` (sha256, like `handoff_codes`), `code_verifier text`, `current_user_id text`, `provider text`, `expires_at timestamptz`; one-time (delete on read); TTL ~10 min.

## Reused, already-merged (do NOT reimplement)

- `stashPendingLink(db, sessionUserId, { providerId, providerAccountId }, ttlMs?)`, `pendingLink(db, sessionUserId) → PendingLink | null`, `PendingLink = { providerId, providerAccountId }`.
- `accountIdForProvider(db, providerId, providerAccountId) → string | null`.
- `absorbAccount(db, { current, other }) → { ok: true, keep } | { ok: false, reason: "merge-not-supported" | "same-account" }`.
- `connectedProviders(db, accountId) → string[]`, `accountFreshness` (inside absorb).
- `mintSessionCookie(auth, userId) → Promise<string>` (the `Set-Cookie` value).
- `resolveSession(auth, headers) → { accountId } | null`.
- Raw-route pattern: `src/auth/handoff.ts` (`installHandoff`, duck-typed `Req`/`Res` with `.redirect(302, url)`, registered before `mountAuth`). Wiring points in `src/index.ts`: `installHandoff` at line ~245, `mountAuth(...)` at ~246, `installAccount` at ~278.

---

## File Structure

- `packages/aggregator/src/schema.ts` — add the `connectStates` table + `ensureSchema` DDL (modify).
- `packages/aggregator/src/auth/connectStates.ts` — **new**: `stashConnectState` / `consumeConnectState` (pure DB), exported via `index.ts`.
- `src/account/connect.ts` — **new**: the connect **start** route (`GET /api/account/connect/:provider`) + the **callback shim** (`GET /api/auth/callback/:provider`) + a testable `resolveConnectIdentity(provider, args)` wrapper. Registered before `mountAuth`.
- `src/account/install.ts` — add the `absorbHandler` + register `POST /api/account/absorb` (modify).
- `src/index.ts` — register the connect routes before `mountAuth` (modify).
- SPA: `packages/marketplace/src/pages/Account.tsx`, `HandleClaim.tsx`, `auth.ts`, `api.ts` (modify).
- Tests: `src/aggregator/__tests__/connectStates.test.ts`, `src/account/__tests__/connect.route.test.ts`, `src/account/__tests__/absorb.route.test.ts`, `packages/marketplace/src/pages/Account.test.tsx` (+ `HandleClaim.test.tsx`).

---

## Task 1: `connect_states` store

**Files:**
- Modify: `packages/aggregator/src/schema.ts`
- Create: `packages/aggregator/src/auth/connectStates.ts`
- Modify: `packages/aggregator/src/index.ts` (`export * from "./auth/connectStates.js";`)
- Test: `src/aggregator/__tests__/connectStates.test.ts`

**Interfaces:**
- Produces: `stashConnectState(db, { stateHash, codeVerifier, currentUserId, provider }, ttlMs?): Promise<void>` and `consumeConnectState(db, stateHash): Promise<{ codeVerifier: string; currentUserId: string; provider: string } | null>` — returns the row and **deletes it** (one-time); `null` if absent or expired.

- [ ] **Step 1: Write the failing test**

```ts
// src/aggregator/__tests__/connectStates.test.ts
import { describe, it, expect } from "vitest";
import { makeTestDb, stashConnectState, consumeConnectState, CONNECT_STATE_TTL_MS } from "@agentgem/aggregator";
import { createHash } from "node:crypto";

const h = (s: string) => createHash("sha256").update(s).digest("hex");

describe("connect_states", () => {
  it("stashes then consumes exactly once, binds to the current user, and honors expiry", async () => {
    const db = await makeTestDb();
    await stashConnectState(db, { stateHash: h("s1"), codeVerifier: "v1", currentUserId: "u1", provider: "github" });
    const got = await consumeConnectState(db, h("s1"));
    expect(got).toEqual({ codeVerifier: "v1", currentUserId: "u1", provider: "github" });
    // one-time: a second consume returns null
    expect(await consumeConnectState(db, h("s1"))).toBeNull();
    // unknown state -> null
    expect(await consumeConnectState(db, h("nope"))).toBeNull();
    // expired -> null (and cleaned)
    await stashConnectState(db, { stateHash: h("s2"), codeVerifier: "v2", currentUserId: "u2", provider: "google" }, -1);
    expect(await consumeConnectState(db, h("s2"))).toBeNull();
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `pnpm -w build && pnpm -w vitest run dist/aggregator/__tests__/connectStates.test.js`
Expected: FAIL — `stashConnectState`/`consumeConnectState` not exported.

- [ ] **Step 3: Add the table + DDL + helpers**

In `schema.ts`, next to `handoffCodes`:

```ts
export const connectStates = pgTable("connect_states", {
  stateHash: text("state_hash").primaryKey(),
  codeVerifier: text("code_verifier").notNull(),
  currentUserId: text("current_user_id").notNull().references(() => user.id, { onDelete: "cascade" }),
  provider: text("provider").notNull(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
});
```

Add `connectStates` to the exported `schema` object. In `ensureSchema`, next to the `pending_account_links` DDL:

```ts
await db.execute(sql`create table if not exists "connect_states" (
  state_hash text primary key,
  code_verifier text not null,
  current_user_id text not null references "user"(id) on delete cascade,
  provider text not null,
  expires_at timestamptz not null, created_at timestamptz not null default now())`);
```

Create `packages/aggregator/src/auth/connectStates.ts`:

```ts
// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
import { and, eq, gt } from "drizzle-orm";
import type { AppDb } from "../schema.js";
import { connectStates } from "../schema.js";

export const CONNECT_STATE_TTL_MS = 10 * 60 * 1000;

/** WRITE side of the bespoke connect start route: one in-flight OAuth per state, bound to the
 *  caller's session user. `stateHash` is sha256(state) — never store the raw state. */
export async function stashConnectState(
  db: AppDb,
  row: { stateHash: string; codeVerifier: string; currentUserId: string; provider: string },
  ttlMs: number = CONNECT_STATE_TTL_MS,
): Promise<void> {
  const expiresAt = new Date(Date.now() + ttlMs);
  await db.insert(connectStates).values({ ...row, expiresAt }).onConflictDoNothing();
}

/** One-time READ: return the row for `stateHash` and DELETE it. `null` if absent or expired.
 *  This is what makes the connect callback's identity binding (currentUserId) come only from the
 *  server-stored start, never from the callback request. */
export async function consumeConnectState(
  db: AppDb,
  stateHash: string,
): Promise<{ codeVerifier: string; currentUserId: string; provider: string } | null> {
  const rows = await db
    .delete(connectStates)
    .where(and(eq(connectStates.stateHash, stateHash), gt(connectStates.expiresAt, new Date())))
    .returning({ codeVerifier: connectStates.codeVerifier, currentUserId: connectStates.currentUserId, provider: connectStates.provider });
  return rows[0] ?? null;
}
```

(An expired row is left for the `where` to skip; a periodic cleanup is out of scope — the table is tiny and one-time.)

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm -w build && pnpm -w vitest run dist/aggregator/__tests__/connectStates.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/aggregator/src/schema.ts packages/aggregator/src/auth/connectStates.ts packages/aggregator/src/index.ts src/aggregator/__tests__/connectStates.test.ts
git commit -m "feat(auth): connect_states store for the Flow B bespoke connect flow"
```

---

## Task 2: connect start route + state-routed callback shim

**Files:**
- Create: `src/account/connect.ts`
- Create: `src/account/__tests__/connect.route.test.ts`
- Modify: `src/index.ts` (register `installConnect` BEFORE `mountAuth`)

**Interfaces:**
- Consumes: `consumeConnectState`, `stashConnectState`, `accountIdForProvider`, `stashPendingLink`, `resolveSession`.
- Produces: `installConnect(expressApp, { db, auth, webOrigins, publicBase })` registering `GET /api/account/connect/:provider` and `GET /api/auth/callback/:provider` (shim); and a testable `resolveConnectIdentity(provider, { code, codeVerifier, redirectURI })`.

- [ ] **Step 1: PROVE FIRST — verify the provider-object API + shim registration (the hot-path risk)**

Before writing route code, confirm against the installed `better-auth@1.6.23`:
1. How to obtain a provider object from `await auth.$context` (the callback uses `getAwaitableValue(ctx.socialProviders, { value: id })`) — determine the exact access (`ctx.socialProviders` shape: array vs map) and write a `getConnectProvider(ctx, id)` accessor.
2. The exact `createAuthorizationURL` signature in `dist/social-providers/index.*` / `dist/api/routes/sign-in.mjs` — args (expects `state`, `codeVerifier`, `redirectURI`, `scopes`?) and return (a URL, and whether it *generates* `state`/`codeVerifier` for us to persist, or expects us to pass them). Record the exact shape; the route code in Step 3 uses it verbatim.
3. That an Express handler registered at `/api/auth/callback/:provider` **before** `mountAuth` runs first and can `next()` to better-auth (the `installHandoff` precedent for `/api/auth/handoff/*` proves this; confirm the wildcard callback path doesn't behave differently).

Write findings as a comment block at the top of `src/account/connect.ts`. If `createAuthorizationURL`'s shape is awkward, the fallback is to assemble the authorize URL directly (GitHub: `https://github.com/login/oauth/authorize?...`; Google: authorize endpoint + PKCE `code_challenge`) — decide here and use one concrete approach.

- [ ] **Step 2: Write failing tests — start stores state+redirects; shim routes our state vs foreign**

```ts
// src/account/__tests__/connect.route.test.ts — duck-typed req/res like handles/__tests__.
// Uses a FAKE provider injected via a resolveConnectIdentity seam so no live OAuth is needed.
it("start: 401 without session; with session stores a connect_state and 302s to the provider", async () => {
  // resolveSession stub -> {accountId:'u1'}; call GET /api/account/connect/github;
  // assert a connect_states row exists (consumeConnectState finds it) and res.redirect(302, <provider url>).
});

it("callback shim: OUR state -> resolves identity, stashPendingLink, 302 /account?connect=ready", async () => {
  // seed connect_states for state 's'; stub resolveConnectIdentity -> {providerId:'google', providerAccountId:'g-other'};
  // seed an `account` row so accountIdForProvider('google','g-other') = some other user;
  // GET /api/auth/callback/google?code=c&state=s -> pendingLink('u1') === {google, g-other}; redirect ?connect=ready.
});

it("callback shim: a FOREIGN state calls next() and does not touch pending links", async () => {
  // no connect_states row for state 'x'; a downstream stub handler records that next() reached it;
  // GET /api/auth/callback/github?code=c&state=x -> next() called, no pendingLink written.
});
```

- [ ] **Step 3: Run and watch them fail**

Run: `pnpm -w build && pnpm -w vitest run dist/account/__tests__/connect.route.test.js`
Expected: FAIL — `installConnect`/`resolveConnectIdentity` not defined.

- [ ] **Step 4: Implement `src/account/connect.ts`**

Use the exact `createAuthorizationURL` shape confirmed in Step 1 where noted. The exchange half is fixed (confirmed shapes):

```ts
// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
// Bespoke Flow B connect flow. Start route redirects to the provider using better-auth's OWN
// registered callback (/api/auth/callback/:provider); the callback shim (registered BEFORE mountAuth)
// routes on `state`: our state -> we exchange + stashPendingLink; any other state -> next() to
// better-auth's own sign-in/link-social callback, untouched. The session is never read for identity
// and never swapped.
import { randomBytes, createHash } from "node:crypto";
import type { AppDb, makeAuth } from "@agentgem/aggregator";
import { resolveSession, stashConnectState, consumeConnectState, accountIdForProvider, stashPendingLink } from "@agentgem/aggregator";

type Auth = ReturnType<typeof makeAuth>;
export interface ConnectDeps { db: AppDb; auth: Auth; webOrigins: string[]; publicBase: string }

interface Req { method: string; params: Record<string, string>; query: Record<string, unknown>; headers: Record<string, string | undefined> }
interface Res { status(c: number): Res; json(b: unknown): Res; redirect(code: number, url: string): Res }
type Next = () => void;
type ExpressApp = { get(p: string, h: (req: Req, res: Res, next: Next) => unknown): unknown };

const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");
const KNOWN = new Set(["github", "google"]);

/** Thin, testable wrapper over better-auth's provider exchange. Returns the OTHER account's
 *  server-verified identity, or null. `provider` is `ctx.socialProviders`' entry for the id. */
export async function resolveConnectIdentity(
  provider: { validateAuthorizationCode: (a: { code: string; codeVerifier: string; redirectURI: string }) => Promise<unknown>; getUserInfo: (t: unknown) => Promise<{ user?: { id?: unknown } } | null> },
  args: { code: string; codeVerifier: string; redirectURI: string; providerId: string },
): Promise<{ providerId: string; providerAccountId: string } | null> {
  const tokens = await provider.validateAuthorizationCode({ code: args.code, codeVerifier: args.codeVerifier, redirectURI: args.redirectURI });
  const user = await provider.getUserInfo({ ...(tokens as object) }).then((r) => r?.user);
  const id = user?.id;
  if (id === undefined || id === null || id === "") return null;
  return { providerId: args.providerId, providerAccountId: String(id) };
}

async function getConnectProvider(auth: Auth, id: string): Promise<any | null> {
  const ctx = await auth.$context;
  // Shape confirmed in Step 1 (accessor for ctx.socialProviders by id):
  const list: any = (ctx as any).socialProviders;
  const found = Array.isArray(list) ? list.find((p: any) => p.id === id) : list?.[id];
  return found ?? null;
}

export function connectStartHandler(deps: ConnectDeps) {
  return async (req: Req, res: Res): Promise<void> => {
    const provider = req.params.provider;
    if (!KNOWN.has(provider)) { res.status(404).json({ error: "unknown provider" }); return; }
    const who = await resolveSession(deps.auth, req.headers);
    if (!who) { res.status(401).json({ error: "sign in required" }); return; }
    const p = await getConnectProvider(deps.auth, provider);
    if (!p) { res.status(404).json({ error: "provider not configured" }); return; }
    const ctx = await deps.auth.$context;
    const redirectURI = `${ctx.baseURL}/callback/${provider}`;
    // createAuthorizationURL — EXACT shape per Step 1. It yields the authorize url + the state +
    // codeVerifier we must persist so the callback shim can recognize + exchange.
    const { url, state, codeVerifier } = await p.createAuthorizationURL({ redirectURI, scopes: undefined });
    await stashConnectState(deps.db, { stateHash: sha256(state), codeVerifier, currentUserId: who.accountId, provider });
    res.redirect(302, typeof url === "string" ? url : url.toString());
  };
}

export function connectCallbackShim(deps: ConnectDeps) {
  return async (req: Req, res: Res, next: Next): Promise<void> => {
    const state = typeof req.query.state === "string" ? req.query.state : "";
    const provider = req.params.provider;
    const row = state ? await consumeConnectState(deps.db, sha256(state)) : null;
    if (!row || row.provider !== provider) { next(); return; }   // not ours -> better-auth handles it
    // Path-based router (Router.tsx matches `p === "/account"`); Account.tsx reads params from
    // window.location.search — so the query MUST sit on the search string, not a hash fragment.
    const dest = `${deps.publicBase}/account`;
    try {
      const code = typeof req.query.code === "string" ? req.query.code : "";
      if (!code || typeof req.query.error === "string") { res.redirect(302, `${dest}?connect=error`); return; }
      const p = await getConnectProvider(deps.auth, provider);
      const ctx = await deps.auth.$context;
      const identity = p && await resolveConnectIdentity(p, { code, codeVerifier: row.codeVerifier, redirectURI: `${ctx.baseURL}/callback/${provider}`, providerId: provider });
      if (!identity) { res.redirect(302, `${dest}?connect=error`); return; }
      const other = await accountIdForProvider(deps.db, identity.providerId, identity.providerAccountId);
      if (other && other !== row.currentUserId) {
        await stashPendingLink(deps.db, row.currentUserId, identity);
        res.redirect(302, `${dest}?connect=ready`);
      } else {
        res.redirect(302, `${dest}?connect=none`);   // unused / already yours (defensive)
      }
    } catch { res.redirect(302, `${dest}?connect=error`); }
  };
}

export function installConnect(expressApp: ExpressApp, deps: ConnectDeps): void {
  expressApp.get("/api/account/connect/:provider", connectStartHandler(deps));
  // MUST be registered before mountAuth's /api/auth catch-all (see src/index.ts).
  expressApp.get("/api/auth/callback/:provider", connectCallbackShim(deps));
}
```

(Adjust `createAuthorizationURL`'s destructuring to the exact Step-1 shape. Make the connect-route tests inject a fake provider by stubbing `getConnectProvider` or `resolveConnectIdentity` — export a small seam if needed so the route tests need no live OAuth.)

- [ ] **Step 5: Run tests to verify they pass**

Run: `pnpm -w build && pnpm -w vitest run dist/account/__tests__/connect.route.test.js`
Expected: PASS (start stores+redirects; our state stashes; foreign state next()).

- [ ] **Step 6: Register before `mountAuth` and confirm no auth regression**

In `src/index.ts`, in the `if (aggDb && webOrigins.length > 0 && auth)` block, add `installConnect` **before** the existing `installHandoff`/`mountAuth` lines (so the callback shim precedes the catch-all):

```ts
installConnect(server.expressApp as never, { db: aggDb, auth, webOrigins, publicBase: process.env.AGENTGEM_WEB_ORIGINS?.split(",")[0]?.trim() ?? "" });
```

Run: `pnpm -w build && pnpm -w vitest run dist/__tests__ dist/auth/__tests__`
Expected: PASS — better-auth mount + handoff tests still green (the shim passes foreign states through).

- [ ] **Step 7: Commit**

```bash
git add src/account/connect.ts src/account/__tests__/connect.route.test.ts src/index.ts
git commit -m "feat(account): bespoke connect flow (start + state-routed callback shim) for Flow B"
```

---

## Task 3: `POST /api/account/absorb`

**Files:**
- Modify: `src/account/install.ts` (add `absorbHandler`, register the route)
- Test: `src/account/__tests__/absorb.route.test.ts`

**Interfaces:**
- Consumes: `resolveSession`, `pendingLink`, `accountIdForProvider`, `absorbAccount`, `connectedProviders`, `mintSessionCookie`.

- [ ] **Step 1: Write failing tests**

```ts
// src/account/__tests__/absorb.route.test.ts
it("401 without session; 409 when no pending link", async () => { /* ... */ });

it("absorbs a fresh other account; survivor has both providers; pending row consumed", async () => {
  // session=current(data-bearing); stashPendingLink(current, {google, g-other}); seed a FRESH other
  // account owning google g-other. POST /api/account/absorb -> { keep: current, connected: [...] };
  // pendingLink(current) now null.
});

it("re-mints the session when the caller's own fresh account is dropped", async () => {
  // session=current(FRESH); other=data-bearing owns the OAuth'd provider; absorb keeps=other, drops=current;
  // response carries a Set-Cookie (keep's session). assert Set-Cookie present and { keep: other }.
});

it("409 merge-not-supported when neither account is fresh", async () => { /* both have data */ });
```

- [ ] **Step 2: Run and watch them fail**

Run: `pnpm -w build && pnpm -w vitest run dist/account/__tests__/absorb.route.test.js`
Expected: FAIL — `/api/account/absorb` not registered.

- [ ] **Step 3: Implement `absorbHandler` in `src/account/install.ts`**

Add to the imports: `pendingLink, accountIdForProvider, absorbAccount, mintSessionCookie`. Add:

```ts
export function absorbHandler(deps: AccountDeps) {
  return async (req: Req, res: Res): Promise<void> => {
    cors(req, res, deps.webOrigins);
    if (req.method === "OPTIONS") { preflight(res); return; }
    const who = await resolveSession(deps.auth, req.headers);
    if (!who) { res.status(401).json({ error: "sign in required" }); return; }
    // `other` comes ONLY from the server-verified pending link for THIS session — never req.body.
    const pending = await pendingLink(deps.db, who.accountId);
    if (!pending) { res.status(409).json({ error: "no provider awaiting connection" }); return; }
    const other = await accountIdForProvider(deps.db, pending.providerId, pending.providerAccountId);
    if (!other) { res.status(409).json({ error: "no provider awaiting connection" }); return; }
    const r = await absorbAccount(deps.db, { current: who.accountId, other });
    if (!r.ok) {
      res.status(409).json({ error: "Both accounts have activity on AgentGem. Merging accounts with existing gems or a claimed handle isn't supported yet." });
      return;
    }
    if (r.keep !== who.accountId) {
      res.set("Set-Cookie", await mintSessionCookie(deps.auth, r.keep));   // caller's fresh acct was dropped
    }
    res.json({ keep: r.keep, connected: await connectedProviders(deps.db, r.keep) });
  };
}
```

Extend the `Res` interface with `set`, add `post` to `ExpressApp`, and in `installAccount`:

```ts
expressApp.post("/api/account/absorb", absorbHandler(deps));
expressApp.options("/api/account/absorb", absorbHandler(deps));
```

(`/api/account/*` is already originGuard-exempt from the Flow A slice — no change there. `absorbAccount` deletes the pending link's owner only when fresh; the `pending_account_links` row for the dropped user cascades away when its `"user"` row is deleted, so no explicit pending cleanup is needed — but assert the row is gone in the test.)

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm -w build && pnpm -w vitest run dist/account/__tests__/absorb.route.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/account/install.ts src/account/__tests__/absorb.route.test.ts
git commit -m "feat(account): POST /api/account/absorb — consume pending link, absorb, re-mint on drop"
```

---

## Task 4: SPA — Merge button, confirm, absorb, handle-claim nudge

**Files:**
- Modify: `packages/marketplace/src/auth.ts` (add `connect(provider)`), `api.ts` (add `absorbAccount()`)
- Modify: `packages/marketplace/src/pages/Account.tsx`
- Modify: `packages/marketplace/src/HandleClaim.tsx`
- Test: `packages/marketplace/src/pages/Account.test.tsx` (+ `HandleClaim.test.tsx`)

**Interfaces:**
- Consumes: `GET /api/account/connect/:provider` (navigation), `POST /api/account/absorb` (`{ keep, connected }` | 409).

- [ ] **Step 1: Write the failing component test**

```tsx
// Account.test.tsx additions
it("on ?error=account_already_linked, shows a 'Merge' button that navigates to the connect start", () => {
  // render at /account?error=account_already_linked_to_different_user with a provider context;
  // expect a "Merge this account" button; clicking it sets location to /api/account/connect/<provider>.
});
it("on ?connect=ready, confirming calls POST /api/account/absorb and refreshes providers", async () => {
  // mock POST /absorb -> { keep, connected:["github","google"] }; click Confirm -> both providers shown.
});
it("on absorb 409, shows the merge-not-supported message", async () => { /* ... */ });
```

- [ ] **Step 2: Run and watch it fail**

Run: `pnpm -C packages/marketplace exec vitest run src/pages/Account.test.tsx`
Expected: FAIL.

- [ ] **Step 3: Implement**

- `auth.ts`: `connect(provider: "github" | "google")` → `window.location.assign(base + "/api/account/connect/" + provider)`.
- `api.ts`: `absorbAccount(): Promise<{ keep: string; connected: string[] }>` — credentialed `POST base + "/api/account/absorb"`; throw with the server message on non-2xx (so the 409 text surfaces).
- `Account.tsx`:
  - Replace the plain collision line with a **"Merge this account"** button (shown on `?error=account_already_linked_to_different_user`) → `connect(provider)`. Track which provider the last Connect targeted (persist across the redirect via the returnTo/query or component state re-derivation).
  - On `?connect=ready`, render a confirm ("This merges the just-verified account — it has no gems, handle, or data — into this one. [Connect]"). On confirm → `api.absorbAccount()` → on success refresh providers + call the identity refresh (session may have changed); on error show the message. On `?connect=none`/`?connect=error`, show a brief notice.
  - Strip `?connect=`/`?error=` after handling via `history.replaceState` (reuse the existing pattern in this file).
- `HandleClaim.tsx`: on a claim `409` caused by another account owning the handle, route to `/account` (path router; a banner param like `?merge=1` on the search string) with a banner ("To claim @name, connect the account that owns it.") — do NOT reveal which provider owns it.

- [ ] **Step 4: Run the component tests + marketplace suite + typecheck**

Run: `pnpm -C packages/marketplace exec vitest run src/pages/Account.test.tsx src/App.test.tsx && pnpm -C packages/marketplace exec tsc --noEmit`
Expected: PASS, types clean.

- [ ] **Step 5: Commit**

```bash
git add packages/marketplace/src/auth.ts packages/marketplace/src/api.ts packages/marketplace/src/pages/Account.tsx packages/marketplace/src/pages/Account.test.tsx packages/marketplace/src/HandleClaim.tsx
git commit -m "feat(marketplace): Flow B — Merge button, connect+absorb confirm, handle-claim nudge"
```

---

## Final verification

- [ ] `pnpm -w build && pnpm -w vitest run` — full root suite green (CI's `test (24)`).
- [ ] `pnpm -C packages/marketplace exec vitest run && pnpm -C packages/marketplace exec tsc --noEmit` — marketplace green (now CI-gated).
- [ ] Manual smoke against a local aggregator with both OAuth apps configured: (a) from a data-bearing GitHub account, Connect Google that belongs to a fresh separate account → both providers on the kept account, still signed in as the GitHub account; (b) from a fresh Google account, follow the handle-claim nudge to Connect the GitHub account that owns `@name` → lands on the GitHub account (session re-minted) with `@name` + both providers; (c) two data-bearing accounts → the merge-not-supported message; (d) a normal Flow-A sign-in and link-social still work (the shim passes their states through).

## Ops prerequisite

Confirm the GitHub app type before deploy. If a classic OAuth App (expected), the state-routed callback needs **no GitHub console change**. Confirm Google's authorized redirect URI list already contains `/api/auth/callback/google` (used by sign-in). Document in the deploy runbook.

## Notes

Non-goals unchanged: two-data-bearing merge (C), unlinking, providers beyond GitHub + Google. The `absorbAccount` / `accountFreshness` / `pendingLink` engines merged in PR #331 are reused unchanged — this slice only adds the connect flow (Tasks 1–2), the absorb route (Task 3), and the SPA (Task 4).
