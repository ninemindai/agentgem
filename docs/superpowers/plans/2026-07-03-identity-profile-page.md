# SP2 Public Profile Page (`/@login`) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give a GitHub-authenticated AgentGem user a public profile at `app.agentgem.ai/@<login>` showing their avatar, verified badge, total stars, and published gems (each with star + install counts).

**Architecture:** One aggregated public read endpoint `GET /api/aggregator/profile?login=<login>` on the existing `AggregatorController`, backed by a `buildProfile(db, login)` data-assembly function in `@agentgem/aggregator` that joins `accounts` (avatar), `account_bindings` (verified), `catalog_gems` (published gems), and reuses `starCounts` + `gemAdoption` for engagement. The marketplace SPA adds a `/@login` route and a read-only `Profile.tsx` page that renders the endpoint.

**Tech Stack:** TypeScript, `@agentback/openapi` decorator controllers, Drizzle ORM (PGlite for tests), Zod, React + Vite (marketplace), Vitest + `@testing-library/react` (jsdom).

## Global Constraints

- **Endpoint form is a query param**, not a path param: `GET /api/aggregator/profile?login=<login>`. Every route on `AggregatorController` uses `query:`; none uses path params. The pretty `/@login` is a **frontend route only**.
- **Client/server response types must be byte-identical.** The marketplace `types.ts` `Profile`/`ProfileGem` interfaces mirror the server Zod `ProfileResultSchema` field-for-field (this repo's recurring client/server-contract gotcha).
- **Reuse existing helpers — do not reimplement:** `starCounts(db, "gem", keys)` (stars), `gemAdoption(db, { keys })` (k-anon installs, `DEFAULT_K = 5`), `StoneRating` component (renders grade+stars+installs). DRY.
- **Install counts are k-anonymized** (via `gemAdoption`), consistent with the rest of the site: a gem with fewer than 5 distinct installers reports `installs: 0`. Do **not** switch to a raw count.
- **Login matching is case-insensitive** everywhere (`accounts.login`, `account_bindings.account_login`, `catalog_gems.published_by`); canonical display casing comes from the `accounts` row when present. Validate `login` against `^[A-Za-z0-9-]+$` before any query or URL build. All SQL parameterized.
- **Decoupled from PR #87:** the profile renders from `catalog_gems.published_by` even when no `accounts` row exists (avatar just `null`). Do not add a hard dependency on `accounts` being populated.
- **Aggregator package tests live at root `src/aggregator/__tests__/`** and import from `@agentgem/aggregator` (the compiled package), matching `catalog.test.ts` / `catalogController.test.ts`. Marketplace tests live beside their source in `packages/marketplace/src/`.
- **Marketplace tests are NOT in root CI** — run them locally (`cd packages/marketplace && pnpm test`).
- **Commits** authored as `Raymond Feng <raymond@ninemind.ai>`; every commit message ends with a `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>` trailer. Use `git -c user.name="Raymond Feng" -c user.email="raymond@ninemind.ai" commit …`.
- **Non-goal (deferred to SP3):** linking the gem-detail page's author to `/@login`. The registry feed the marketplace consumes (`RegistryGem`) exposes only a free-text `author`, not the GitHub `publishedBy` login; wiring `publishedBy` through the registry feed is SP3's "author links everywhere". SP2 profiles are reachable by URL.

---

### Task 1: `buildProfile` data-assembly function

**Files:**
- Create: `packages/aggregator/src/profile.ts`
- Modify: `packages/aggregator/src/index.ts` (add barrel export)
- Test: `src/aggregator/__tests__/profile.test.ts`

**Interfaces:**
- Consumes: `starCounts(db, kind, ids): Promise<Record<string, number>>` from `./stars.js`; `gemAdoption(db, { keys, k? }): Promise<{ gemKey: string; installs: number; verifiedInstalls: number }[]>` from `./aggregates.js`; tables `accounts`, `accountBindings`, `catalogGems` from `./schema.js`; `makeTestDb()` from `./testDb.js`.
- Produces:
  - `interface ProfileGem { key: string; version: string; description: string | null; grade: number | null; stars: number; installs: number; verifiedInstalls: number }`
  - `interface Profile { login: string; avatarUrl: string | null; verified: boolean; githubUrl: string; totalStars: number; gems: ProfileGem[] }`
  - `async function buildProfile(db: AppDb, rawLogin: string): Promise<Profile | null>` — returns `null` for an invalid-charset login and for a login with no account, no gems, and no binding.

- [ ] **Step 1: Write the failing tests**

Create `src/aggregator/__tests__/profile.test.ts`:

```ts
// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
import { describe, it, expect } from "vitest";
import { randomUUID } from "node:crypto";
import { makeTestDb, buildProfile, accounts, accountBindings, catalogGems, producers, gemAdoptions, stars } from "@agentgem/aggregator";

async function star(db: never, gemKey: string, n: number) {
  for (let i = 0; i < n; i++) {
    const accountId = randomUUID();
    await (db as any).insert(accounts).values({ id: accountId, provider: "github", providerAccountId: "s" + randomUUID(), login: "starrer" });
    await (db as any).insert(stars).values({ id: randomUUID(), accountId, targetKind: "gem", targetId: gemKey });
  }
}
async function install(db: never, gemKey: string, n: number) {
  for (let i = 0; i < n; i++) {
    const pubkey = "ed25519:" + randomUUID();
    await (db as any).insert(producers).values({ pubkey });
    await (db as any).insert(gemAdoptions).values({ gemKey, gemDigest: "d", producerPubkey: pubkey, event: "install" });
  }
}

describe("buildProfile", () => {
  it("assembles account + gems + stars, sorted by stars desc, totalStars summed", async () => {
    const db = await makeTestDb();
    await db.insert(accounts).values({ id: randomUUID(), provider: "github", providerAccountId: "1", login: "octocat", avatarUrl: "https://avatars/octocat" });
    await db.insert(catalogGems).values({ gemKey: "@octocat/a", version: "1.0.0", publishedBy: "octocat", description: "aa", grade: 2, createdAtMs: 10 });
    await db.insert(catalogGems).values({ gemKey: "@octocat/b", version: "1.0.0", publishedBy: "octocat", description: "bb", grade: 3, createdAtMs: 20 });
    await star(db as never, "@octocat/a", 2);
    await star(db as never, "@octocat/b", 5);

    const p = await buildProfile(db, "octocat");
    expect(p).not.toBeNull();
    expect(p!.login).toBe("octocat");
    expect(p!.avatarUrl).toBe("https://avatars/octocat");
    expect(p!.githubUrl).toBe("https://github.com/octocat");
    expect(p!.totalStars).toBe(7);
    expect(p!.gems.map((g) => g.key)).toEqual(["@octocat/b", "@octocat/a"]); // stars desc
    expect(p!.gems[0]).toMatchObject({ key: "@octocat/b", stars: 5, grade: 3, description: "bb" });
  });

  it("reports k-anonymized install counts (DEFAULT_K = 5)", async () => {
    const db = await makeTestDb();
    await db.insert(catalogGems).values({ gemKey: "@o/low", version: "1.0.0", publishedBy: "octocat", createdAtMs: 1 });
    await db.insert(catalogGems).values({ gemKey: "@o/hi", version: "1.0.0", publishedBy: "octocat", createdAtMs: 2 });
    await install(db as never, "@o/low", 4);  // below k → 0
    await install(db as never, "@o/hi", 5);   // at k → 5
    const p = await buildProfile(db, "octocat");
    const byKey = Object.fromEntries(p!.gems.map((g) => [g.key, g.installs]));
    expect(byKey["@o/low"]).toBe(0);
    expect(byKey["@o/hi"]).toBe(5);
  });

  it("renders a bind-only user with no accounts row (avatar null, verified true)", async () => {
    const db = await makeTestDb();
    const pubkey = "ed25519:" + randomUUID();
    await db.insert(producers).values({ pubkey });
    await db.insert(accountBindings).values({ pubkey, provider: "github", accountId: "9", accountLogin: "binder" });
    await db.insert(catalogGems).values({ gemKey: "@binder/g", version: "1.0.0", publishedBy: "binder", createdAtMs: 1 });
    const p = await buildProfile(db, "binder");
    expect(p).not.toBeNull();
    expect(p!.avatarUrl).toBeNull();
    expect(p!.verified).toBe(true);
    expect(p!.gems).toHaveLength(1);
  });

  it("keeps only the latest version per gemKey", async () => {
    const db = await makeTestDb();
    await db.insert(catalogGems).values({ gemKey: "@o/g", version: "1.0.0", publishedBy: "octocat", description: "old", createdAtMs: 1 });
    await db.insert(catalogGems).values({ gemKey: "@o/g", version: "2.0.0", publishedBy: "octocat", description: "new", createdAtMs: 2 });
    const p = await buildProfile(db, "octocat");
    expect(p!.gems).toHaveLength(1);
    expect(p!.gems[0]).toMatchObject({ version: "2.0.0", description: "new" });
  });

  it("is case-insensitive on login", async () => {
    const db = await makeTestDb();
    await db.insert(accounts).values({ id: randomUUID(), provider: "github", providerAccountId: "1", login: "OctoCat", avatarUrl: null });
    await db.insert(catalogGems).values({ gemKey: "@o/g", version: "1.0.0", publishedBy: "OctoCat", createdAtMs: 1 });
    const p = await buildProfile(db, "octocat");
    expect(p).not.toBeNull();
    expect(p!.login).toBe("OctoCat"); // canonical casing from the accounts row
  });

  it("verified is false with no binding", async () => {
    const db = await makeTestDb();
    await db.insert(accounts).values({ id: randomUUID(), provider: "github", providerAccountId: "1", login: "octocat", avatarUrl: null });
    const p = await buildProfile(db, "octocat");
    expect(p!.verified).toBe(false);
  });

  it("returns null for an unknown login", async () => {
    const db = await makeTestDb();
    expect(await buildProfile(db, "nobody")).toBeNull();
  });

  it("returns null (no query) for a bad-charset login", async () => {
    const db = await makeTestDb();
    expect(await buildProfile(db, "foo/bar")).toBeNull();
    expect(await buildProfile(db, "a b")).toBeNull();
    expect(await buildProfile(db, "")).toBeNull();
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm -w exec tsc -b && pnpm -w exec vitest run src/aggregator/__tests__/profile.test.ts`
Expected: FAIL — `buildProfile` is not exported from `@agentgem/aggregator` (import error / not a function).

- [ ] **Step 3: Implement `buildProfile`**

Create `packages/aggregator/src/profile.ts`:

```ts
// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
// Public profile assembly: one GitHub identity → avatar + verified flag + published gems with engagement.
// Reads catalog_gems.published_by (a plain login string, not a FK), so a profile renders even for a
// bind-only user with no accounts row — accounts only enriches it with an avatar. Decoupled from SP1.
import { sql, desc } from "drizzle-orm";
import type { AppDb } from "./schema.js";
import { accounts, accountBindings, catalogGems } from "./schema.js";
import { starCounts } from "./stars.js";
import { gemAdoption } from "./aggregates.js";

const LOGIN_RE = /^[A-Za-z0-9-]+$/; // GitHub login charset

export interface ProfileGem {
  key: string;
  version: string;
  description: string | null;
  grade: number | null;
  stars: number;
  installs: number;
  verifiedInstalls: number;
}
export interface Profile {
  login: string;
  avatarUrl: string | null;
  verified: boolean;
  githubUrl: string;
  totalStars: number;
  gems: ProfileGem[];
}

export async function buildProfile(db: AppDb, rawLogin: string): Promise<Profile | null> {
  const login = rawLogin.trim();
  if (!LOGIN_RE.test(login)) return null; // reject junk before any query or URL build

  const acct = (await db
    .select({ login: accounts.login, avatarUrl: accounts.avatarUrl })
    .from(accounts)
    .where(sql`lower(${accounts.login}) = lower(${login})`)
    .limit(1))[0];

  const bind = (await db
    .select({ pubkey: accountBindings.pubkey })
    .from(accountBindings)
    .where(sql`lower(${accountBindings.accountLogin}) = lower(${login})`)
    .limit(1))[0];
  const verified = !!bind;

  // All published rows for this author, newest first → dedupe to the latest version per gemKey.
  const rows = await db
    .select({ gemKey: catalogGems.gemKey, version: catalogGems.version, description: catalogGems.description, grade: catalogGems.grade })
    .from(catalogGems)
    .where(sql`lower(${catalogGems.publishedBy}) = lower(${login})`)
    .orderBy(desc(catalogGems.createdAtMs));
  const latest = new Map<string, { gemKey: string; version: string; description: string | null; grade: number | null }>();
  for (const r of rows) if (!latest.has(r.gemKey)) latest.set(r.gemKey, r);
  const base = [...latest.values()];

  if (!acct && base.length === 0 && !verified) return null;

  const keys = base.map((g) => g.gemKey);
  const starMap = await starCounts(db, "gem", keys); // guards keys.length === 0 internally
  const adoptRows = keys.length ? await gemAdoption(db, { keys }) : []; // guard: empty keys → gemAdoption(true) would scan all gems
  const adopt = new Map(adoptRows.map((a) => [a.gemKey, a]));

  const gems: ProfileGem[] = base
    .map((g) => ({
      key: g.gemKey,
      version: g.version,
      description: g.description,
      grade: g.grade,
      stars: starMap[g.gemKey] ?? 0,
      installs: adopt.get(g.gemKey)?.installs ?? 0,
      verifiedInstalls: adopt.get(g.gemKey)?.verifiedInstalls ?? 0,
    }))
    .sort((a, b) => b.stars - a.stars || a.key.localeCompare(b.key));

  const totalStars = gems.reduce((s, g) => s + g.stars, 0);
  const canonical = acct?.login ?? login;
  return { login: canonical, avatarUrl: acct?.avatarUrl ?? null, verified, githubUrl: `https://github.com/${canonical}`, totalStars, gems };
}
```

Add the barrel export to `packages/aggregator/src/index.ts` (after the `./catalog.js` line):

```ts
export * from "./profile.js";
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm -w exec tsc -b && pnpm -w exec vitest run src/aggregator/__tests__/profile.test.ts`
Expected: PASS (8 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/aggregator/src/profile.ts packages/aggregator/src/index.ts src/aggregator/__tests__/profile.test.ts
git -c user.name="Raymond Feng" -c user.email="raymond@ninemind.ai" commit -m "feat(profile): buildProfile assembles avatar + gems + engagement

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 2: `GET /api/aggregator/profile` endpoint + public-read allowlist

**Files:**
- Modify: `src/aggregator.controller.ts` (add schemas + `profile` method; import `get` already present, add `AgentError`)
- Modify: `src/originGuard.ts:34` (add `/api/aggregator/profile` to `PUBLIC_READ_PATHS`)
- Test: `src/aggregator/__tests__/profileController.test.ts`
- Test: `src/__tests__/originGuard.test.ts` (add one public-read assertion)

**Interfaces:**
- Consumes: `buildProfile(db, login): Promise<Profile | null>` from `@agentgem/aggregator` (Task 1); `AgentError` from `@agentback/openapi`.
- Produces: `GET /api/aggregator/profile?login=<login>` → 200 with `ProfileResultSchema` (the `Profile` shape) or `404` (`AgentError`, code `profile_not_found`) when `buildProfile` returns `null`.

- [ ] **Step 1: Write the failing controller test**

Create `src/aggregator/__tests__/profileController.test.ts`:

```ts
// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
import { describe, it, expect } from "vitest";
import { randomUUID } from "node:crypto";
import { makeTestDb, accounts, catalogGems } from "@agentgem/aggregator";
import { AggregatorController } from "../../aggregator.controller.js";

describe("AggregatorController.profile", () => {
  it("returns the profile for a known login", async () => {
    const db = await makeTestDb();
    await db.insert(accounts).values({ id: randomUUID(), provider: "github", providerAccountId: "1", login: "octocat", avatarUrl: "https://a/x" });
    await db.insert(catalogGems).values({ gemKey: "@octocat/g", version: "1.0.0", publishedBy: "octocat", description: "d", grade: 2, createdAtMs: 1 });
    const c = new AggregatorController(db);
    const res = await c.profile({ query: { login: "octocat" } });
    expect(res).toMatchObject({ login: "octocat", avatarUrl: "https://a/x", verified: false, githubUrl: "https://github.com/octocat" });
    expect(res.gems[0]).toMatchObject({ key: "@octocat/g", grade: 2 });
  });

  it("throws a 404 AgentError for an unknown login", async () => {
    const db = await makeTestDb();
    const c = new AggregatorController(db);
    await expect(c.profile({ query: { login: "nobody" } })).rejects.toMatchObject({ status: 404 });
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm -w exec tsc -b && pnpm -w exec vitest run src/aggregator/__tests__/profileController.test.ts`
Expected: FAIL — `c.profile` is not a function.

- [ ] **Step 3: Implement the endpoint**

In `src/aggregator.controller.ts`:

Add `AgentError` to the `@agentback/openapi` import and `buildProfile` to the `@agentgem/aggregator` import:

```ts
import { api, get, post, AgentError } from "@agentback/openapi";
// … and add buildProfile to an existing @agentgem/aggregator import line:
import { buildProfile } from "@agentgem/aggregator";
```

Add the schemas near the other schema consts (e.g. after `GemAdoptionResult`):

```ts
const ProfileQuery = z.object({ login: z.string() });
const ProfileGemSchema = z.object({
  key: z.string(), version: z.string(), description: z.string().nullable(), grade: z.number().nullable(),
  stars: z.number(), installs: z.number(), verifiedInstalls: z.number(),
});
const ProfileResult = z.object({
  login: z.string(), avatarUrl: z.string().nullable(), verified: z.boolean(),
  githubUrl: z.string(), totalStars: z.number(), gems: z.array(ProfileGemSchema),
});
```

Add the method to the `AggregatorController` class (e.g. after `gemAdoption`):

```ts
  // Public profile: avatar + verified flag + published gems with k-anon engagement. login is a query
  // param (every route here is query-based; the pretty /@login is a frontend route). 404 when absent.
  @get("/profile", { query: ProfileQuery, response: ProfileResult })
  async profile(input: { query: z.infer<typeof ProfileQuery> }): Promise<z.infer<typeof ProfileResult>> {
    const p = await buildProfile(this.db, input.query.login);
    if (!p) throw new AgentError("profile not found", { status: 404, code: "profile_not_found", retryable: false });
    return p;
  }
```

In `src/originGuard.ts:34`, add the profile path to `PUBLIC_READ_PATHS`:

```ts
const PUBLIC_READ_PATHS = new Set(["/api/aggregator/popularity", "/api/aggregator/co-occurrence", "/api/aggregator/adoption", "/api/aggregator/co-occurrence-matrix", "/api/registry/gems", "/api/aggregator/profile"]);
```

(`req.path` excludes the query string, so the exact-match `Set` gate matches `GET /api/aggregator/profile?login=…`.)

- [ ] **Step 4: Add the public-read guard assertion**

Open `src/__tests__/originGuard.test.ts`, find the test that asserts a `PUBLIC_READ_PATHS` entry is allowed cross-origin without a session (e.g. the one exercising `/api/aggregator/popularity`), and add an analogous case for `/api/aggregator/profile` — mirror the existing test's exact call shape (do not invent a new harness). If the existing test iterates a list of public paths, add `"/api/aggregator/profile"` to that list.

- [ ] **Step 5: Run to verify pass**

Run: `pnpm -w exec tsc -b && pnpm -w exec vitest run src/aggregator/__tests__/profileController.test.ts src/__tests__/originGuard.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/aggregator.controller.ts src/originGuard.ts src/aggregator/__tests__/profileController.test.ts src/__tests__/originGuard.test.ts
git -c user.name="Raymond Feng" -c user.email="raymond@ninemind.ai" commit -m "feat(profile): GET /api/aggregator/profile endpoint (public read, 404 on miss)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 3: Marketplace profile page + route

**Files:**
- Modify: `packages/marketplace/src/types.ts` (add `Profile`, `ProfileGem`)
- Modify: `packages/marketplace/src/api.ts` (add `getProfile`)
- Modify: `packages/marketplace/src/Router.tsx` (match `/@login`)
- Create: `packages/marketplace/src/pages/Profile.tsx`
- Test: `packages/marketplace/src/api.test.ts` (add getProfile cases)
- Test: `packages/marketplace/src/Router.test.tsx` (add /@login case)
- Test: `packages/marketplace/src/pages/Profile.test.tsx` (new)

**Interfaces:**
- Consumes: server `ProfileResult` shape (Task 2) — mirrored as the client `Profile`/`ProfileGem` types; `StoneRating` from `../StoneRating` (props: `{ cut?: string; grade?: number; stars: number; installs: number; verifiedInstalls: number }`).
- Produces: `makeApi(base).getProfile(login: string): Promise<Profile | null>` (null on 404); `<Profile api={…} login={…} />`; Router match `^/@([^/]+)$`.

- [ ] **Step 1: Write the failing api test**

Add to `packages/marketplace/src/api.test.ts` (inside the `describe("makeApi", …)` block):

```ts
  it("getProfile hits the right URL and returns the parsed profile", async () => {
    const calls: string[] = [];
    const profile = { login: "octocat", avatarUrl: null, verified: true, githubUrl: "https://github.com/octocat", totalStars: 3, gems: [] };
    vi.stubGlobal("fetch", vi.fn(async (url: string) => { calls.push(String(url)); return res(profile); }));
    const out = await makeApi("https://x").getProfile("octocat");
    expect(out).toMatchObject({ login: "octocat", verified: true });
    expect(calls[0]).toBe("https://x/api/aggregator/profile?login=octocat");
  });

  it("getProfile returns null on 404", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: false, status: 404, text: async () => "" }) as unknown as Response));
    expect(await makeApi("https://x").getProfile("nobody")).toBeNull();
  });
```

- [ ] **Step 2: Write the failing Router test**

Add to `packages/marketplace/src/Router.test.tsx` (inside `describe("Router", …)`):

```ts
  it("renders the profile page at /@login", async () => {
    const profile = { login: "octocat", avatarUrl: null, verified: false, githubUrl: "https://github.com/octocat", totalStars: 0, gems: [] };
    vi.stubGlobal("fetch", vi.fn(async () => res(profile)));
    window.history.pushState({}, "", "/@octocat");
    render(<Router api={makeApi("")} stars={stars} me={null} />);
    expect(await screen.findByRole("heading", { name: /octocat/ })).toBeTruthy();
  });
```

- [ ] **Step 3: Write the failing Profile page test**

Create `packages/marketplace/src/pages/Profile.test.tsx`:

```tsx
import { describe, it, expect, afterEach, vi } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import { Profile } from "./Profile";

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
const full = {
  login: "octocat", avatarUrl: "https://a/octocat", verified: true,
  githubUrl: "https://github.com/octocat", totalStars: 7,
  gems: [{ key: "@octocat/g", version: "1.0.0", description: "d", grade: 2, stars: 5, installs: 9, verifiedInstalls: 4 }],
};
const apiWith = (p: unknown) => ({ getProfile: () => Promise.resolve(p) }) as never;

describe("Profile page", () => {
  it("renders login, verified badge, avatar, total stars, and a gem card linking to the gem", async () => {
    render(<Profile api={apiWith(full)} login="octocat" />);
    expect(await screen.findByRole("heading", { name: /octocat/ })).toBeTruthy();
    expect(screen.getByText(/verified/i)).toBeTruthy();
    expect(document.querySelector("img")?.getAttribute("src")).toBe("https://a/octocat");
    const card = screen.getByText("@octocat/g").closest("a");
    expect(card?.getAttribute("href")).toBe("/gems/" + encodeURIComponent("@octocat/g"));
  });

  it("omits the verified badge and avatar when absent", async () => {
    render(<Profile api={apiWith({ ...full, verified: false, avatarUrl: null })} login="octocat" />);
    await screen.findByRole("heading", { name: /octocat/ });
    expect(screen.queryByText(/verified/i)).toBeNull();
    expect(document.querySelector("img")).toBeNull();
  });

  it("shows an empty-gems note for a profile with no published gems", async () => {
    render(<Profile api={apiWith({ ...full, gems: [] })} login="octocat" />);
    expect(await screen.findByText(/hasn't published/i)).toBeTruthy();
  });

  it("shows a not-found state when the profile is null", async () => {
    render(<Profile api={apiWith(null)} login="ghost" />);
    expect(await screen.findByText(/no profile for @ghost/i)).toBeTruthy();
  });
});
```

- [ ] **Step 4: Run the three tests to verify they fail**

Run: `cd packages/marketplace && pnpm exec vitest run src/api.test.ts src/Router.test.tsx src/pages/Profile.test.tsx`
Expected: FAIL — `getProfile` missing; `Profile` module not found; Router has no `/@` match.

- [ ] **Step 5: Implement types, api, Router, and the page**

Add to `packages/marketplace/src/types.ts` (mirror the server `ProfileResult` byte-for-byte):

```ts
export interface ProfileGem {
  key: string;
  version: string;
  description: string | null;
  grade: number | null;
  stars: number;
  installs: number;
  verifiedInstalls: number;
}
export interface Profile {
  login: string;
  avatarUrl: string | null;
  verified: boolean;
  githubUrl: string;
  totalStars: number;
  gems: ProfileGem[];
}
```

Add to `packages/marketplace/src/api.ts` — extend the import and add the method inside the object returned by `makeApi`:

```ts
import type { AggIngredient, AggCoOccurrence, AdoptionPoint, RegistryGem, Profile } from "./types";
// … inside makeApi's returned object, alongside the other methods:
    getProfile: async (login: string): Promise<Profile | null> => {
      const res = await fetch(base + "/api/aggregator/profile?login=" + encodeURIComponent(login));
      if (res.status === 404) return null;
      if (!res.ok) throw new Error(`/api/aggregator/profile -> ${res.status}`);
      return JSON.parse(await res.text()) as Profile;
    },
```

Add to `packages/marketplace/src/Router.tsx` — import `Profile` and add the match before the leaderboard fallback (`return <Leaderboard … />`):

```tsx
import { Profile } from "./pages/Profile";
// … inside Router(), before the final `return <Leaderboard … />`:
  const prof = path.match(/^\/@([^/]+)$/);
  if (prof) return <Profile api={api} login={decodeURIComponent(prof[1])} />;
```

Create `packages/marketplace/src/pages/Profile.tsx`:

```tsx
import { useEffect, useState } from "react";
import type { makeApi } from "../api";
import type { Profile as ProfileT } from "../types";
import { StoneRating } from "../StoneRating";

type View = { status: "loading" } | { status: "notfound" } | { status: "ok"; profile: ProfileT };

export function Profile({ api, login }: { api: ReturnType<typeof makeApi>; login: string }) {
  const [view, setView] = useState<View>({ status: "loading" });

  useEffect(() => {
    let alive = true;
    api.getProfile(login)
      .then((p) => { if (alive) setView(p ? { status: "ok", profile: p } : { status: "notfound" }); })
      .catch(() => { if (alive) setView({ status: "notfound" }); });
    return () => { alive = false; };
  }, [api, login]);

  if (view.status === "loading") return <div className="ex-profile"><p className="ex-empty">Loading…</p></div>;
  if (view.status === "notfound") return <div className="ex-profile"><p className="ex-empty">No profile for @{login}.</p></div>;

  const p = view.profile;
  return (
    <div className="ex-profile">
      <header className="ex-profile-head">
        {p.avatarUrl && <img className="ex-avatar-lg" src={p.avatarUrl} alt="" width={64} height={64} />}
        <h2 className="ex-profile-login">
          <a href={p.githubUrl} target="_blank" rel="noreferrer">@{p.login}</a>
          {p.verified && <span className="ex-verified" title="Verified GitHub identity"> ✓ Verified</span>}
        </h2>
        <span className="ex-profile-stars">★ {p.totalStars}</span>
      </header>
      {p.gems.length === 0 ? (
        <p className="ex-empty">@{p.login} hasn't published any gems yet.</p>
      ) : (
        <ul className="ex-gem-list">
          {p.gems.map((g) => (
            <li key={g.key} className="ex-gem-item">
              <a className="ex-gem-card" href={"/gems/" + encodeURIComponent(g.key)}>
                <span className="ex-gem-head">
                  <span className="ex-gem-key">{g.key}</span>
                  <StoneRating grade={g.grade ?? undefined} stars={g.stars} installs={g.installs} verifiedInstalls={g.verifiedInstalls} />
                </span>
                {g.description && <span className="ex-gem-desc">{g.description}</span>}
              </a>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
```

Note: `StoneRating` is called without `cut` (the profile has no cut concept); its `cut` prop is optional and tolerates `undefined` (it is passed `undefined` cuts elsewhere). The GitHub `<a target="_blank">` and the absolute `https://` href are both ignored by App's same-origin click interceptor, so it opens normally; the `/gems/:key` card link is same-origin and navigates via `pushState`.

- [ ] **Step 6: Run the tests to verify they pass**

Run: `cd packages/marketplace && pnpm exec vitest run src/api.test.ts src/Router.test.tsx src/pages/Profile.test.tsx`
Expected: PASS.

- [ ] **Step 7: Run the marketplace typecheck + full package test**

Run: `cd packages/marketplace && pnpm test`
Expected: PASS (no regressions; marketplace is not in root CI, so this local run is the gate).

- [ ] **Step 8: Commit**

```bash
git add packages/marketplace/src/types.ts packages/marketplace/src/api.ts packages/marketplace/src/Router.tsx packages/marketplace/src/pages/Profile.tsx packages/marketplace/src/api.test.ts packages/marketplace/src/Router.test.tsx packages/marketplace/src/pages/Profile.test.tsx
git -c user.name="Raymond Feng" -c user.email="raymond@ninemind.ai" commit -m "feat(profile): marketplace /@login profile page

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Self-Review

**1. Spec coverage:**
- Endpoint `GET /api/aggregator/profile` + `buildProfile` → Tasks 1–2. Response shape (login, avatarUrl, verified, githubUrl, totalStars, gems[key,version,description,grade,stars,installs]) → Task 1 `Profile`/`ProfileGem` (+ `verifiedInstalls`, added because `StoneRating` consumes it and `gemAdoption` already returns it). ✅
- Avatar from `accounts`, verified from `account_bindings`, gems from `catalog_gems.published_by`, stars via `starCounts`, installs via `gemAdoption` → Task 1. ✅
- Latest-version dedupe (in-JS Map, PGlite-portable — resolves the spec's `distinct on` portability flag) → Task 1 step 3 + test. ✅
- Case-insensitive match, charset validation, parameterized SQL → Task 1. ✅
- 404 for unknown; graceful bind-only (avatar null) → Tasks 1–2 + tests. ✅
- Frontend `/@login` route, `Profile.tsx`, `api.profile`, StoneRating reuse, not-found + empty states → Task 3. ✅
- Public-read CORS allowlist → Task 2. ✅
- **Deviations from spec, intentional:** (a) endpoint is `?login=` not `/:login` (matches the controller's query-only idiom + the exact-match origin-guard Set); (b) the gem-detail→profile author link is **deferred to SP3** (the registry feed lacks `publishedBy`; documented in Global Constraints). Both surfaced to the user before planning.

**2. Placeholder scan:** No TBD/"handle errors"/"similar to". Every code step shows complete code; the one prose step (Task 2 Step 4, originGuard test) points at a specific existing test to mirror because its exact harness shape isn't reproduced here — the implementer reads that file, which is the honest instruction rather than inventing a harness. ✅

**3. Type consistency:** `Profile`/`ProfileGem` identical across `packages/aggregator/src/profile.ts`, the server `ProfileResult` Zod schema, and the client `types.ts` (fields: login, avatarUrl, verified, githubUrl, totalStars, gems{key,version,description,grade,stars,installs,verifiedInstalls}). `buildProfile(db, rawLogin)` signature consistent between definition, barrel export, and both test call sites. `getProfile(login): Promise<Profile | null>` consistent between api.ts, its test, and Profile.tsx. `StoneRating` props match its usage in `Gems.tsx`/`Gem.tsx`. ✅
