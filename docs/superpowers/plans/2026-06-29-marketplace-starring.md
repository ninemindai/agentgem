# Marketplace Starring (M2-B) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Signed-in users star/unstar gems and ingredients; everyone sees public star counts; a star button on all four marketplace surfaces.

**Architecture:** A generic `stars` store in `@agentgem/aggregator`; raw-express `/api/stars/*` endpoints (the M2-A `install.ts` pattern: credentialed CORS + originGuard exemption, reusing `resolveSession`); a `makeStars` client + `<StarButton>` in the marketplace, threaded `App → Router → pages`.

**Tech Stack:** Server — TypeScript ESM (`.js` imports), drizzle/Postgres, raw Express, Vitest on compiled dist. Marketplace — Vite + React 19, Vitest + jsdom.

## Global Constraints

- **Test conventions:** Server — `.js`-extension imports; tests from **compiled dist** (`pnpm test` = `tsc -b && vitest run`; focused: `pnpm exec tsc -b && pnpm exec vitest run dist/<path>.test.js`); MIT 3-line header on new files. Aggregator tests live in `src/aggregator/__tests__/` → `dist/aggregator/__tests__/`; root tests in `src/__tests__/` → `dist/__tests__/`; aggregator **source** in `packages/aggregator/src/`. Test DB: `const db = await makeTestDb()` from `@agentgem/aggregator` (no wrapper). Marketplace — **extensionless** imports; `pnpm --filter @agentgem/marketplace test [file]`; `.toBeTruthy()`/`.toBeNull()` (no jest-dom); `vi.stubGlobal`.
- **CORS for stars:** only origins in `AGENTGEM_WEB_ORIGINS` get `Access-Control-Allow-Origin: <origin>` + `Allow-Credentials: true` (never `*`). Mirror `authCors`.
- **originGuard:** `/api/stars` (the bare GET) AND `/api/stars/toggle` must both be exempt → use `startsWith("/api/stars")`.
- **Star target:** `kind ∈ {"gem","ingredient"}`, `id` = gem key or ingredient id (plain text, no FK). Counts public; `mine` only with a session cookie; signed-out toggle → 401.
- Reuse `resolveSession`, `SESSION_COOKIE`, `parseCookies` from the M2-A surface; don't reimplement.

## File structure

```
packages/aggregator/src/
  schema.ts              MODIFY  stars table + ensureSchema DDL
  stars.ts               CREATE  toggleStar/starCounts/starredIds
  index.ts               MODIFY  export ./stars.js
src/aggregator/__tests__/stars.test.ts   CREATE
src/originGuard.ts       MODIFY  exempt /api/stars
src/__tests__/originGuard.test.ts         MODIFY  cross-site star paths pass
src/stars/install.ts     CREATE  installStars + toggle/get handlers + corsForStars
src/__tests__/starsInstall.test.ts        CREATE
src/index.ts             MODIFY  installStars wiring
packages/marketplace/src/
  stars.ts               CREATE  makeStars (get/toggle, credentialed) + NotSignedIn
  stars.test.ts          CREATE
  StarButton.tsx         CREATE  + StarButton.test.tsx
  App.tsx                MODIFY  build the stars context, pass to Router
  Router.tsx             MODIFY  thread stars → pages
  pages/{Leaderboard,Ingredient,Gems,Gem}.tsx   MODIFY  batch-fetch + render StarButton
  (+ matching *.test.tsx updates)
  styles.css             MODIFY  star button styles
```

---

### Task 1: Stars store (`@agentgem/aggregator`)

**Files:**
- Modify: `packages/aggregator/src/schema.ts`, `packages/aggregator/src/index.ts`
- Create: `packages/aggregator/src/stars.ts`, `src/aggregator/__tests__/stars.test.ts`

**Interfaces:**
- Produces: table `stars`; `toggleStar(db, accountId, kind, id) → Promise<{starred:boolean; count:number}>`; `starCounts(db, kind, ids) → Promise<Record<string,number>>`; `starredIds(db, accountId, kind, ids) → Promise<string[]>`.

- [ ] **Step 1: Add the table to `schema.ts`** (after `webSessions`):
```ts
export const stars = pgTable("stars", {
  id: uuid("id").primaryKey(),
  accountId: uuid("account_id").notNull().references(() => accounts.id),
  targetKind: text("target_kind").notNull(),
  targetId: text("target_id").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});
```
Add `stars` to the `schema` object. DDL in `ensureSchema` (after web_sessions):
```ts
  await db.execute(sql`create table if not exists stars (id uuid primary key, account_id uuid not null references accounts(id), target_kind text not null, target_id text not null, created_at timestamptz not null default now(), unique (account_id, target_kind, target_id))`);
  await db.execute(sql`create index if not exists stars_target_idx on stars (target_kind, target_id)`);
```

- [ ] **Step 2: Write the failing test** — `src/aggregator/__tests__/stars.test.ts`:
```ts
// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
import { describe, it, expect } from "vitest";
import { makeTestDb, upsertAccount, toggleStar, starCounts, starredIds } from "@agentgem/aggregator";

async function acct(db: Awaited<ReturnType<typeof makeTestDb>>, id: string) {
  return upsertAccount(db, { provider: "github", accountId: id, login: "u" + id });
}

describe("stars store", () => {
  it("toggleStar inserts then deletes (idempotent round-trip), with live count", async () => {
    const db = await makeTestDb();
    const a = await acct(db, "1");
    const on = await toggleStar(db, a.id, "gem", "brainstorming-kit");
    expect(on).toEqual({ starred: true, count: 1 });
    const off = await toggleStar(db, a.id, "gem", "brainstorming-kit");
    expect(off).toEqual({ starred: false, count: 0 });
  });

  it("counts reflect multiple accounts; starCounts batches by id", async () => {
    const db = await makeTestDb();
    const a = await acct(db, "1"); const b = await acct(db, "2");
    await toggleStar(db, a.id, "gem", "x"); await toggleStar(db, b.id, "gem", "x");
    await toggleStar(db, a.id, "gem", "y");
    const c = await starCounts(db, "gem", ["x", "y", "z"]);
    expect(c.x).toBe(2); expect(c.y).toBe(1); expect(c.z ?? 0).toBe(0);
  });

  it("starredIds returns only this account's stars for the given kind", async () => {
    const db = await makeTestDb();
    const a = await acct(db, "1"); const b = await acct(db, "2");
    await toggleStar(db, a.id, "ingredient", "skill:s/a");
    await toggleStar(db, b.id, "ingredient", "skill:s/b");
    expect(await starredIds(db, a.id, "ingredient", ["skill:s/a", "skill:s/b"])).toEqual(["skill:s/a"]);
  });

  it("kinds are independent (same id under gem vs ingredient)", async () => {
    const db = await makeTestDb();
    const a = await acct(db, "1");
    await toggleStar(db, a.id, "gem", "dup");
    expect((await starCounts(db, "ingredient", ["dup"])).dup ?? 0).toBe(0);
  });
});
```

- [ ] **Step 3: Run RED** — `pnpm exec tsc -b && pnpm exec vitest run dist/aggregator/__tests__/stars.test.js` → FAIL (module/exports missing).

- [ ] **Step 4: Create `packages/aggregator/src/stars.ts`**:
```ts
// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
// Stars: per-account engagement on gems + ingredients. Generic (kind + text id), no FK to the
// target (gems live in the registry/static catalog, not this DB).
import { randomUUID } from "node:crypto";
import { and, eq, inArray, sql } from "drizzle-orm";
import type { AppDb } from "./schema.js";
import { stars } from "./schema.js";

async function countFor(db: AppDb, kind: string, id: string): Promise<number> {
  const r = await db.execute<{ n: number }>(
    sql`select count(*)::int as n from stars where target_kind = ${kind} and target_id = ${id}`,
  );
  return r.rows[0]?.n ?? 0;
}

export async function toggleStar(db: AppDb, accountId: string, kind: string, id: string): Promise<{ starred: boolean; count: number }> {
  const existing = await db
    .select({ id: stars.id })
    .from(stars)
    .where(and(eq(stars.accountId, accountId), eq(stars.targetKind, kind), eq(stars.targetId, id)))
    .limit(1);
  if (existing[0]) {
    await db.delete(stars).where(eq(stars.id, existing[0].id));
    return { starred: false, count: await countFor(db, kind, id) };
  }
  await db.insert(stars).values({ id: randomUUID(), accountId, targetKind: kind, targetId: id });
  return { starred: true, count: await countFor(db, kind, id) };
}

export async function starCounts(db: AppDb, kind: string, ids: string[]): Promise<Record<string, number>> {
  if (ids.length === 0) return {};
  const r = await db.execute<{ target_id: string; n: number }>(
    sql`select target_id, count(*)::int as n from stars where target_kind = ${kind} and target_id in ${ids} group by target_id`,
  );
  const out: Record<string, number> = {};
  for (const row of r.rows) out[row.target_id] = row.n;
  return out;
}

export async function starredIds(db: AppDb, accountId: string, kind: string, ids: string[]): Promise<string[]> {
  if (ids.length === 0) return [];
  const r = await db
    .select({ targetId: stars.targetId })
    .from(stars)
    .where(and(eq(stars.accountId, accountId), eq(stars.targetKind, kind), inArray(stars.targetId, ids)));
  return r.rows.map((x) => x.targetId);
}
```
> NOTE: if `db.execute` with `in ${ids}` doesn't bind an array cleanly in this drizzle version, use the `inArray(stars.targetId, ids)` builder form for `starCounts` too (group via `.select({...}).groupBy(...)`). Confirm against the existing `aggregates.ts` query style and adapt; keep the function signatures + behavior identical.

- [ ] **Step 5: Export** — in `packages/aggregator/src/index.ts` add `export * from "./stars.js";`

- [ ] **Step 6: Run GREEN** — `pnpm exec tsc -b && pnpm exec vitest run dist/aggregator/__tests__/stars.test.js` → PASS (4 tests).

- [ ] **Step 7: Commit**
```bash
git add packages/aggregator/src/schema.ts packages/aggregator/src/stars.ts src/aggregator/__tests__/stars.test.ts packages/aggregator/src/index.ts
git commit -m "feat(aggregator): stars store (toggle/counts/starredIds)"
```

---

### Task 2: originGuard exemption for `/api/stars`

**Files:**
- Modify: `src/originGuard.ts`, `src/__tests__/originGuard.test.ts`

**Interfaces:** Consumes nothing new. Produces: cross-site requests to `/api/stars` and `/api/stars/toggle` pass the guard.

- [ ] **Step 1: Add the failing test** — in `src/__tests__/originGuard.test.ts`, after the `/api/auth/*` test:
```ts
  it("allows cross-site star requests (/api/stars + /api/stars/toggle) — public counts + the SPA's credentialed toggle", () => {
    expect(run({ "sec-fetch-site": "cross-site" }, "app.agentgem.ai", "GET", "/api/stars").nexted).toBe(true);
    expect(run({ "sec-fetch-site": "cross-site" }, "app.agentgem.ai", "POST", "/api/stars/toggle").nexted).toBe(true);
  });
```

- [ ] **Step 2: Run RED** — `pnpm exec tsc -b && pnpm exec vitest run dist/__tests__/originGuard.test.js` → the new case FAILs (cross-site POST blocked).

- [ ] **Step 3: Exempt `/api/stars`** — in `src/originGuard.ts`, change the auth exemption line to also cover stars:
```ts
  if (req.path.startsWith("/api/auth/")) { next(); return; }
```
becomes:
```ts
  // Web sign-in (/api/auth/*) and stars (/api/stars, /api/stars/toggle) are reachable cross-site by
  // design (SPA on explore.agentgem.ai → API on app.agentgem.ai). CSRF defense: the OAuth `state`,
  // SameSite=Lax cookie, and (stars) a 401 on the authed toggle. The handlers set their own
  // credentialed CORS for the AGENTGEM_WEB_ORIGINS allowlist.
  if (req.path.startsWith("/api/auth/") || req.path.startsWith("/api/stars")) { next(); return; }
```

- [ ] **Step 4: Run GREEN** — both new + existing originGuard tests pass.

- [ ] **Step 5: Commit**
```bash
git add src/originGuard.ts src/__tests__/originGuard.test.ts
git commit -m "fix(originGuard): exempt /api/stars from the cross-site block"
```

---

### Task 3: Stars endpoints (`src/stars/install.ts`) + index wiring

**Files:**
- Create: `src/stars/install.ts`, `src/__tests__/starsInstall.test.ts`
- Modify: `src/index.ts`

**Interfaces:**
- Consumes: `toggleStar`/`starCounts`/`starredIds`/`resolveSession` from `@agentgem/aggregator`; `SESSION_COOKIE`/`parseCookies` from `../auth/cookie.js`.
- Produces: `installStars(expressApp, deps: { db: AppDb; webOrigins: string[] })`; `toggleHandler(deps)`, `listHandler(deps)` exported for tests.

- [ ] **Step 1: Write the failing test** — `src/__tests__/starsInstall.test.ts` (mock req/res like `authInstall.test.ts`; build a session via `upsertAccount` + `createSession`; cookie = `ag_session=<token>`):
```ts
// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
import { describe, it, expect } from "vitest";
import { makeTestDb, upsertAccount, createSession, generateSessionToken, toggleStar } from "@agentgem/aggregator";
import { toggleHandler, listHandler } from "../stars/install.js";
import { SESSION_COOKIE } from "../auth/cookie.js";

const webOrigins = ["https://explore.agentgem.ai"];
function mockRes() {
  const r: any = { _status: 200, _headers: {} as Record<string,string>, _body: undefined };
  r.status = (c: number) => { r._status = c; return r; };
  r.set = (k: string, v: string) => { r._headers[k.toLowerCase()] = v; return r; };
  r.setHeader = (k: string, v: string) => { r._headers[k.toLowerCase()] = v; return r; };
  r.json = (b: unknown) => { r._body = b; return r; };
  r.send = (b: unknown) => { r._body = b; return r; };
  return r;
}
const req = (over: any = {}) => ({ method: "GET", path: "/", query: {}, body: {}, headers: {}, get(n: string){ return (this.headers as any)[n.toLowerCase()]; }, ...over });
const deps = (db: any) => ({ db, webOrigins });

async function withSession(db: any) {
  const a = await upsertAccount(db, { provider: "github", accountId: "1", login: "u" });
  const { token } = generateSessionToken();
  await createSession(db, a.id, token, 60_000);
  return { a, token };
}

describe("stars endpoints", () => {
  it("POST toggle 401s without a session", async () => {
    const db = await makeTestDb();
    const res = mockRes();
    await toggleHandler(deps(db))(req({ method: "POST", body: { kind: "gem", id: "x" } }) as any, res as any);
    expect(res._status).toBe(401);
  });

  it("POST toggle with a session stars + returns {starred,count}", async () => {
    const db = await makeTestDb();
    const { token } = await withSession(db);
    const res = mockRes();
    await toggleHandler(deps(db))(req({ method: "POST", headers: { cookie: `${SESSION_COOKIE}=${token}`, origin: webOrigins[0] }, body: { kind: "gem", id: "x" } }) as any, res as any);
    expect(res._body).toEqual({ starred: true, count: 1 });
    expect(res._headers["access-control-allow-origin"]).toBe(webOrigins[0]);
    expect(res._headers["access-control-allow-credentials"]).toBe("true");
  });

  it("POST toggle 400s on a bad kind", async () => {
    const db = await makeTestDb();
    const { token } = await withSession(db);
    const res = mockRes();
    await toggleHandler(deps(db))(req({ method: "POST", headers: { cookie: `${SESSION_COOKIE}=${token}` }, body: { kind: "nope", id: "x" } }) as any, res as any);
    expect(res._status).toBe(400);
  });

  it("GET returns public counts always, and mine only with a cookie", async () => {
    const db = await makeTestDb();
    const { a, token } = await withSession(db);
    await toggleStar(db, a.id, "gem", "x");
    // anonymous: counts but no mine
    const anon = mockRes();
    await listHandler(deps(db))(req({ method: "GET", query: { kind: "gem", ids: "x,y" } }) as any, anon as any);
    expect((anon._body as any).counts.x).toBe(1);
    expect((anon._body as any).mine).toEqual([]);
    // with cookie: mine populated
    const mineRes = mockRes();
    await listHandler(deps(db))(req({ method: "GET", headers: { cookie: `${SESSION_COOKIE}=${token}` }, query: { kind: "gem", ids: "x,y" } }) as any, mineRes as any);
    expect((mineRes._body as any).mine).toEqual(["x"]);
  });
});
```

- [ ] **Step 2: Run RED** — `pnpm exec tsc -b && pnpm exec vitest run dist/__tests__/starsInstall.test.js` → FAIL (module missing).

- [ ] **Step 3: Create `src/stars/install.ts`**:
```ts
// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
// Stars endpoints (raw express, like auth/install.ts): reachable cross-site, own credentialed CORS,
// originGuard-exempt. POST /api/stars/toggle is authed (session → 401); GET /api/stars is a public
// count read + the caller's `mine` when a session cookie is present.
import type { AppDb } from "@agentgem/aggregator";
import { resolveSession, toggleStar, starCounts, starredIds } from "@agentgem/aggregator";
import { SESSION_COOKIE, parseCookies } from "../auth/cookie.js";

export interface StarsDeps { db: AppDb; webOrigins: string[] }

interface Req { method: string; path: string; query: Record<string, unknown>; body: Record<string, unknown>; headers: Record<string, string | undefined>; get(n: string): string | undefined }
interface Res { status(c: number): Res; set(k: string, v: string): Res; setHeader(k: string, v: string): Res; json(b: unknown): Res; send(b: unknown): Res }
type ExpressApp = { get(p: string, h: (req: Req, res: Res) => unknown): unknown; post(p: string, h: (req: Req, res: Res) => unknown): unknown; options(p: string, h: (req: Req, res: Res) => unknown): unknown };

const KINDS = new Set(["gem", "ingredient"]);

function cors(req: Req, res: Res, origins: string[]): void {
  const origin = req.headers["origin"];
  if (origin && origins.includes(origin)) {
    res.set("Access-Control-Allow-Origin", origin);
    res.set("Access-Control-Allow-Credentials", "true");
    res.set("Vary", "Origin");
  }
}
function preflight(res: Res): void {
  res.set("Access-Control-Allow-Methods", "GET, POST, OPTIONS").set("Access-Control-Allow-Headers", "content-type").status(204).send("");
}
async function account(deps: StarsDeps, req: Req): Promise<string | null> {
  const token = parseCookies(req.headers["cookie"])[SESSION_COOKIE];
  const who = token ? await resolveSession(deps.db, token) : null;
  return who?.accountId ?? null;
}

export function toggleHandler(deps: StarsDeps) {
  return async (req: Req, res: Res): Promise<void> => {
    cors(req, res, deps.webOrigins);
    if (req.method === "OPTIONS") { preflight(res); return; }
    const accountId = await account(deps, req);
    if (!accountId) { res.status(401).json({ error: "sign in required" }); return; }
    const kind = String((req.body.kind as string | undefined) ?? "");
    const id = String((req.body.id as string | undefined) ?? "");
    if (!KINDS.has(kind) || id.length === 0 || id.length > 512) { res.status(400).json({ error: "invalid target" }); return; }
    res.json(await toggleStar(deps.db, accountId, kind, id));
  };
}

export function listHandler(deps: StarsDeps) {
  return async (req: Req, res: Res): Promise<void> => {
    cors(req, res, deps.webOrigins);
    if (req.method === "OPTIONS") { preflight(res); return; }
    const kind = String((req.query.kind as string | undefined) ?? "");
    if (!KINDS.has(kind)) { res.status(400).json({ error: "invalid kind" }); return; }
    const ids = String((req.query.ids as string | undefined) ?? "").split(",").map((s) => s.trim()).filter(Boolean).slice(0, 100);
    const counts = await starCounts(deps.db, kind, ids);
    const accountId = await account(deps, req);
    const mine = accountId ? await starredIds(deps.db, accountId, kind, ids) : [];
    res.json({ counts, mine });
  };
}

export function installStars(expressApp: ExpressApp, deps: StarsDeps): void {
  expressApp.post("/api/stars/toggle", toggleHandler(deps));
  expressApp.get("/api/stars", listHandler(deps));
  expressApp.options("/api/stars/toggle", toggleHandler(deps));
  expressApp.options("/api/stars", listHandler(deps));
}
```

- [ ] **Step 4: Run GREEN** — `pnpm exec tsc -b && pnpm exec vitest run dist/__tests__/starsInstall.test.js` → PASS (4 tests).

- [ ] **Step 5: Wire into `src/index.ts`** — add the import near `installAuth`:
```ts
import { installStars } from "./stars/install.js";
```
After the `installAuth(...)` block (where `aggDb` + `webOrigins` are in scope), add:
```ts
  // Stars need the DB + an allowlisted web origin; they don't need the GitHub OAuth secret.
  if (aggDb && webOrigins.length > 0) {
    installStars(server.expressApp as never, { db: aggDb, webOrigins });
  }
```

- [ ] **Step 6: Verify build + the auth/stars suites**
Run: `pnpm exec tsc -b && pnpm exec vitest run dist/__tests__/starsInstall.test.js dist/__tests__/originGuard.test.js dist/aggregator/__tests__/stars.test.js`
Expected: all green; `tsc -b` clean (index wiring typechecks).

- [ ] **Step 7: Commit**
```bash
git add src/stars/install.ts src/__tests__/starsInstall.test.ts src/index.ts
git commit -m "feat(stars): public counts + authed toggle endpoints + index wiring"
```

---

### Task 4: Frontend — `makeStars` client + `<StarButton>`

**Files:**
- Create: `packages/marketplace/src/stars.ts`, `stars.test.ts`, `StarButton.tsx`, `StarButton.test.tsx`
- Modify: `packages/marketplace/src/styles.css`

**Interfaces:**
- Produces:
  - `makeStars(base)` → `{ get(kind, ids: string[]): Promise<{counts: Record<string,number>; mine: string[]}>; toggle(kind, id): Promise<{starred: boolean; count: number}> }` (throws `NotSignedIn` on 401).
  - `class NotSignedIn extends Error`.
  - `StarButton({ kind, id, count, starred, signedIn, loginUrl, api }: { kind: string; id: string; count: number; starred: boolean; signedIn: boolean; loginUrl: () => string; api: ReturnType<typeof makeStars> })`.

- [ ] **Step 1: Write the failing client test** — `packages/marketplace/src/stars.test.ts`:
```ts
import { describe, it, expect, vi, afterEach } from "vitest";
import { makeStars, NotSignedIn } from "./stars";

afterEach(() => vi.unstubAllGlobals());
const res = (body: unknown, ok = true, status = 200) => ({ ok, status, json: async () => body }) as unknown as Response;

describe("makeStars", () => {
  it("get requests counts+mine with credentials and the encoded ids", async () => {
    let url = "", cred: RequestCredentials | undefined;
    vi.stubGlobal("fetch", vi.fn(async (u: string, o?: RequestInit) => { url = String(u); cred = o?.credentials; return res({ counts: { x: 2 }, mine: ["x"] }); }));
    const out = await makeStars("https://app.x").get("gem", ["x", "y"]);
    expect(out).toEqual({ counts: { x: 2 }, mine: ["x"] });
    expect(url).toBe("https://app.x/api/stars?kind=gem&ids=" + encodeURIComponent("x,y"));
    expect(cred).toBe("include");
  });
  it("toggle POSTs with credentials and returns {starred,count}", async () => {
    let method: string | undefined, cred: RequestCredentials | undefined;
    vi.stubGlobal("fetch", vi.fn(async (_u: string, o?: RequestInit) => { method = o?.method; cred = o?.credentials; return res({ starred: true, count: 1 }); }));
    expect(await makeStars("https://app.x").toggle("gem", "x")).toEqual({ starred: true, count: 1 });
    expect(method).toBe("POST"); expect(cred).toBe("include");
  });
  it("toggle throws NotSignedIn on 401", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => res({ error: "sign in required" }, false, 401)));
    await expect(makeStars("https://app.x").toggle("gem", "x")).rejects.toBeInstanceOf(NotSignedIn);
  });
});
```

- [ ] **Step 2: Run RED** — `pnpm --filter @agentgem/marketplace test src/stars.test.ts` → FAIL.

- [ ] **Step 3: Create `packages/marketplace/src/stars.ts`**:
```ts
/** Star client. Credentialed so the parent-domain session cookie travels (counts also work signed-out). */
export class NotSignedIn extends Error { constructor() { super("not signed in"); this.name = "NotSignedIn"; } }

export interface StarState { counts: Record<string, number>; mine: string[] }

export function makeStars(base: string) {
  return {
    async get(kind: string, ids: string[]): Promise<StarState> {
      const r = await fetch(base + "/api/stars?kind=" + encodeURIComponent(kind) + "&ids=" + encodeURIComponent(ids.join(",")), { credentials: "include" });
      if (!r.ok) return { counts: {}, mine: [] };
      const j = (await r.json()) as Partial<StarState>;
      return { counts: j.counts ?? {}, mine: j.mine ?? [] };
    },
    async toggle(kind: string, id: string): Promise<{ starred: boolean; count: number }> {
      const r = await fetch(base + "/api/stars/toggle", {
        method: "POST", credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ kind, id }),
      });
      if (r.status === 401) throw new NotSignedIn();
      if (!r.ok) throw new Error("stars toggle -> " + r.status);
      return (await r.json()) as { starred: boolean; count: number };
    },
  };
}
```

- [ ] **Step 4: Run GREEN** — `pnpm --filter @agentgem/marketplace test src/stars.test.ts` → PASS.

- [ ] **Step 5: Write the failing StarButton test** — `packages/marketplace/src/StarButton.test.tsx`:
```tsx
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent, waitFor } from "@testing-library/react";
import { StarButton } from "./StarButton";

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
const apiWith = (toggle: () => Promise<{ starred: boolean; count: number }>) => ({ get: async () => ({ counts: {}, mine: [] }), toggle }) as never;

describe("StarButton", () => {
  it("renders the count and reflects starred state", () => {
    render(<StarButton kind="gem" id="x" count={3} starred={true} signedIn={true} loginUrl={() => "/login"} api={apiWith(async () => ({ starred: false, count: 2 }))} />);
    expect(screen.getByRole("button", { name: /star/i }).textContent).toContain("3");
  });
  it("signed-in click optimistically toggles then reconciles with the server count", async () => {
    const toggle = vi.fn(async () => ({ starred: true, count: 4 }));
    render(<StarButton kind="gem" id="x" count={3} starred={false} signedIn={true} loginUrl={() => "/login"} api={apiWith(toggle)} />);
    fireEvent.click(screen.getByRole("button", { name: /star/i }));
    await waitFor(() => expect(toggle).toHaveBeenCalledWith("gem", "x"));
    await waitFor(() => expect(screen.getByRole("button").textContent).toContain("4"));
  });
  it("signed-out click navigates to loginUrl (no toggle)", () => {
    const toggle = vi.fn();
    const href = vi.fn();
    vi.stubGlobal("location", { href: "" } as any);
    Object.defineProperty(window, "location", { value: { set href(v: string) { href(v); } }, configurable: true });
    render(<StarButton kind="gem" id="x" count={3} starred={false} signedIn={false} loginUrl={() => "/login?return=here"} api={apiWith(toggle as never)} />);
    fireEvent.click(screen.getByRole("button", { name: /star/i }));
    expect(toggle).not.toHaveBeenCalled();
    expect(href).toHaveBeenCalledWith("/login?return=here");
  });
});
```
> NOTE: the signed-out test stubs `window.location` assignment. If that exact stub is brittle in jsdom, instead make `StarButton` accept the navigation via the `loginUrl` callback by having the component call `window.location.assign(loginUrl())` and stub `window.location.assign` with `vi.fn()` — adjust the test + component together to whichever is clean. Keep the assertion "signed-out click does not toggle and triggers navigation to the login URL".

- [ ] **Step 6: Run RED** — `pnpm --filter @agentgem/marketplace test src/StarButton.test.tsx` → FAIL.

- [ ] **Step 7: Create `packages/marketplace/src/StarButton.tsx`**:
```tsx
import { useState } from "react";
import type { makeStars } from "./stars";
import { NotSignedIn } from "./stars";

export function StarButton({ kind, id, count, starred, signedIn, loginUrl, api }: {
  kind: string; id: string; count: number; starred: boolean; signedIn: boolean;
  loginUrl: () => string; api: ReturnType<typeof makeStars>;
}) {
  const [on, setOn] = useState(starred);
  const [n, setN] = useState(count);
  const [busy, setBusy] = useState(false);

  const click = async (e: React.MouseEvent) => {
    e.preventDefault(); e.stopPropagation();
    if (!signedIn) { window.location.assign(loginUrl()); return; }
    if (busy) return;
    const prevOn = on, prevN = n;
    setOn(!on); setN(n + (on ? -1 : 1)); setBusy(true);   // optimistic
    try {
      const r = await api.toggle(kind, id);
      setOn(r.starred); setN(r.count);                    // reconcile
    } catch (err) {
      setOn(prevOn); setN(prevN);                          // revert
      if (err instanceof NotSignedIn) window.location.assign(loginUrl());
    } finally { setBusy(false); }
  };

  return (
    <button type="button" className={"ex-star" + (on ? " is-on" : "")} onClick={click}
      aria-pressed={on} aria-label={on ? "Unstar" : "Star"} disabled={busy}>
      <span className="ex-star-ico" aria-hidden="true">{on ? "★" : "☆"}</span>
      <span className="ex-star-n">{n}</span>
    </button>
  );
}
```

- [ ] **Step 8: Run GREEN** — `pnpm --filter @agentgem/marketplace test src/StarButton.test.tsx` → PASS (adjust the signed-out stub per the NOTE if needed). Then `pnpm --filter @agentgem/marketplace typecheck` clean.

- [ ] **Step 9: Append star styles to `styles.css`**:
```css
.ex-star { display: inline-flex; align-items: center; gap: 5px; font: inherit; font-size: 0.8rem; font-variant-numeric: tabular-nums; color: var(--ink-2); background: var(--surface); border: 1px solid var(--line-2); border-radius: var(--r-pill); padding: 2px 9px; cursor: pointer; transition: color var(--t), background var(--t), border-color var(--t); }
.ex-star:hover { color: var(--ink); border-color: var(--brand); }
.ex-star.is-on { color: var(--brand-strong); border-color: var(--brand); background: var(--brand-wash); }
.ex-star[disabled] { opacity: 0.6; cursor: default; }
.ex-star-ico { font-size: 0.95rem; line-height: 1; }
```

- [ ] **Step 10: Commit**
```bash
git add packages/marketplace/src/stars.ts packages/marketplace/src/stars.test.ts packages/marketplace/src/StarButton.tsx packages/marketplace/src/StarButton.test.tsx packages/marketplace/src/styles.css
git commit -m "feat(marketplace): stars client + StarButton (optimistic, sign-in prompt)"
```

---

### Task 5: Wire stars into the 4 surfaces (App → Router → pages)

**Files:**
- Modify: `packages/marketplace/src/App.tsx`, `Router.tsx`, `pages/{Gems,Gem,Leaderboard,Ingredient}.tsx` and their `*.test.tsx`

**Interfaces:**
- Consumes: `makeStars`, `StarButton` (Task 4); `makeAuth`/`me` (existing in App).
- Produces: a `stars` context object `{ signedIn: boolean; loginUrl: () => string; api: ReturnType<typeof makeStars> }` threaded `App → Router → each page`; a `StarButton` on each surface.

- [ ] **Step 1: Build the context in `App.tsx` + pass to Router**
Add the import + module-level client:
```ts
import { makeStars } from "./stars";
const stars = makeStars(defaultApiBase());
```
In `App`, build the context from the existing `me` state and pass it to `Router` (replace `<Router api={api} />`):
```tsx
      <main className="ex-main">
        <Router api={api} stars={{ signedIn: !!me, loginUrl: () => auth.loginUrl(window.location.href), api: stars }} />
      </main>
```

- [ ] **Step 2: Thread through `Router.tsx`**
Add a `Stars` type + prop and pass it to every page:
```tsx
import { StarButton } from "./StarButton"; // (not used here directly; pages import it) — omit if unused
import type { makeStars } from "./stars";

export interface StarsCtx { signedIn: boolean; loginUrl: () => string; api: ReturnType<typeof makeStars> }

export function Router({ api, stars }: { api: ReturnType<typeof makeApi>; stars: StarsCtx }) {
  // ...existing popstate effect...
  const gemDetail = path.match(/^\/gems\/(.+)$/);
  if (gemDetail) return <Gem api={api} keyName={decodeURIComponent(gemDetail[1])} stars={stars} />;
  if (path === "/gems") return <Gems api={api} stars={stars} />;
  const ing = path.match(/^\/ingredient\/(.+)$/);
  if (ing) return <Ingredient api={api} id={decodeURIComponent(ing[1])} stars={stars} />;
  return <Leaderboard api={api} stars={stars} />;
}
```
(Remove the `StarButton` import line above if it's unused in Router.)

- [ ] **Step 3: Each page accepts `stars: StarsCtx`, batch-fetches, and renders a StarButton.** For each page:
  - Add `stars` to the props type.
  - After the page's existing data loads (the list of ids it shows), in a `useEffect` keyed on the ids, call `stars.api.get(kind, ids)` → store `{counts, mine}` state (start `{counts:{}, mine:[]}`).
  - Render `<StarButton kind={K} id={id} count={counts[id] ?? 0} starred={mine.includes(id)} signedIn={stars.signedIn} loginUrl={stars.loginUrl} api={stars.api} />` per item.
  - Kinds + ids: **Gems** `kind="gem"`, ids = the loaded gem keys, button in each `.ex-gem-card` head. **Gem** `kind="gem"`, id = the key, button next to the title. **Leaderboard** `kind="ingredient"`, ids = the popularity row ids (`r.id`), button in each row. **Ingredient** `kind="ingredient"`, id = the page id, button by `.ex-detail-head`.

  Use the smallest markup change per page (add the StarButton element; pull `counts`/`mine` from a new state). Keep all existing behavior + tests.

  > For the **Gem card** and **leaderboard row** (which are `<a>` links), the StarButton's `onClick` already calls `preventDefault()`+`stopPropagation()`, so clicking the star won't navigate. Confirm the StarButton sits *inside* the `<a>` without breaking layout, or place it as a sibling — pick what keeps the row/card markup valid (a `<button>` inside an `<a>` is invalid HTML; prefer placing the StarButton as a **sibling** of the `<a>` inside the `<li>`, in a flex wrapper, so it's not nested in the anchor).

- [ ] **Step 4: Update the affected page tests** — each page test now renders with a `stars` prop. Add a shared stub:
```tsx
const stars = { signedIn: false, loginUrl: () => "/login", api: { get: async () => ({ counts: {}, mine: [] }), toggle: async () => ({ starred: false, count: 0 }) } as never };
```
Pass `stars={stars}` to each page render in the existing tests (and the Router tests). Add one assertion per surface that a StarButton renders (e.g. `screen.getAllByRole("button", { name: /star/i }).length` > 0 once data loads). Keep all existing assertions. The `stars.api.get` stub returns empty, so counts render as 0 and nothing breaks.

- [ ] **Step 5: Full marketplace gate**
Run: `pnpm --filter @agentgem/marketplace test && pnpm --filter @agentgem/marketplace typecheck && pnpm --filter @agentgem/marketplace build`
Expected: all green, typecheck clean, build writes `dist/`.

- [ ] **Step 6: Commit**
```bash
git add packages/marketplace/src/App.tsx packages/marketplace/src/Router.tsx packages/marketplace/src/Router.test.tsx packages/marketplace/src/pages packages/marketplace/src/App.test.tsx
git commit -m "feat(marketplace): wire StarButton into gems, gem detail, leaderboard, ingredient"
```

---

## Final verification

- [ ] **Backend** (compiled dist): `pnpm test` → green incl. `stars`, `starsInstall`, `originGuard`; the existing suites unaffected.
- [ ] **Marketplace:** `pnpm --filter @agentgem/marketplace test && … typecheck && … build` → green.
- [ ] **Manual smoke (optional, post-deploy on the live domains):** signed out → star counts show, clicking a star → GitHub sign-in; signed in → click stars/unstars optimistically and the count updates; reload keeps the starred state (`mine`).
- [ ] **Deploy:** ships with the next `agentgem` Docker deploy (the endpoints) + the `agentgem-explore` static rebuild (the UI). No new env vars (reuses `AGENTGEM_WEB_ORIGINS` + the DB).
