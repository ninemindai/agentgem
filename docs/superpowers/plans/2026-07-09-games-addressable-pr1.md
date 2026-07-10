# Games Addressable (PR 1) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give every published mini-game a copyable URL — `app.agentgem.ai/games/@scope/name` — that opens the game already running.

**Architecture:** The marketplace SPA gains a `/games/:key` path route and a `Play` page that mounts the existing sealed-iframe `GamePlayer` fullscreen. The `/minigames` grid stops opening a URL-less React portal and instead `navigate()`s to that route. A new public `GET /api/aggregator/game-meta?key=` resolves a bare gem key to its latest version plus title/genre, so the Play page can render a heading before the (potentially 1.5 MB) HTML arrives.

**Tech Stack:** TypeScript, React 19, Vite + Vitest (marketplace); AgentBack + Zod controllers, Drizzle/Postgres, Vitest (server).

## Global Constraints

- **Spec:** `docs/superpowers/specs/2026-07-09-entity-address-scheme-design.md`. Read it first.
- **Worktree:** `../agentgem-entity-addr`, branch `docs/entity-address-scheme`, branched off freshly-fetched `origin/main`. Do not commit to `main`.
- **Canonical path form:** `<plural-collection>/<entity-id>`. Games are `games/<key>`.
- **`@`-prefix rule:** a published gem key matches `/^@[a-z0-9-]+\/[a-z0-9-]+$/`. Scope-less keys are unlisted shares (PR 2) and must already parse correctly here.
- **`packages/model/src/entityPath.ts` already exists** on `origin/main` (the `?body=defer` inventory work conformed to this scheme first). It implements `workspace/*` only, and percent-encodes segments. **Do not add game builders to it** — it has no marketplace caller and its own header says builders ship only with a caller.
- **The game builders live in `packages/marketplace/src/entityPath.ts`.** The marketplace has zero workspace deps and cannot import `@agentgem/model` (see `packages/marketplace/src/gems/cuts.ts:1-2`). The two files share the scheme, not a function — nothing to drift, no mirror to guard.
- **Game paths are raw, not percent-encoded** — `/games/@acme/tetris`, not `/games/%40acme%2Ftetris`. A gem key's `/` is structure, not data, and a copy-friendly link is the whole goal. This deliberately diverges from `workspaceArtifactPath`'s encoding; the parser still decodes so legacy/encoded links resolve.
- **Out of scope for PR 1:** the Cloudflare Worker, OG tags, `share-archive` upload/revoke, console changes, plural renames of `/ingredient` and `/skill`. Do not touch them.
- **No schema change.** Do not add columns or tables.
- **Deferred from the spec, deliberately:** the *router conformance test* (Enforcement section). It
  requires refactoring `Router.tsx` from its regex cascade into a declarative route table so routes
  can be enumerated and checked. That is real scope, it touches every existing route, and with only
  one entity route to guard it would earn little today. It belongs with PR 3's plural renames, which
  already rewrites the route list. Do not attempt it here.
- **Server tests run compiled `dist/`.** `vitest.config.ts` includes `dist/**/__tests__/**/*.test.js`. You must `pnpm build` before running a server test, and focused test paths name the **`dist/` `.js`** file, not the `src/` `.ts` file.
- **Marketplace tests run source.** `packages/marketplace/vitest.config.ts` includes `src/**/*.test.{ts,tsx}` under jsdom. Run them with `pnpm -C packages/marketplace exec vitest`.

---

### Task 1: `entityPath` — canonical game paths

The pure, dependency-free module that turns a gem key into a URL and back. Nothing renders yet.

**Files:**
- Create: `packages/marketplace/src/entityPath.ts`
- Test: `packages/marketplace/src/entityPath.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `gamePath(key: string): string`
  - `parseGamePath(pathname: string): string | null`
  - `isPublishedKey(key: string): boolean`

Read `packages/model/src/entityPath.ts` first — it is the sibling implementation of this same
scheme (for `workspace/*`), and its header explains why it percent-encodes. You are **not** editing
it, and you are **not** importing it (the marketplace has no workspace deps). You are writing the
`games/*` half in the app that consumes it.

Note on encoding: gem keys are `@scope/name` where scope and name are `[a-z0-9-]` (validated in `packages/distribute/src/registry.ts:31-41`), and share ids are alphanumeric. Neither needs percent-encoding, and a raw `/games/@acme/tetris` is far nicer to copy than `/games/%40acme%2Ftetris`. The parser still tolerates the encoded form, because `pages/Gems.tsx` and friends currently emit `encodeURIComponent`'d gem links and a user may hand-edit one.

- [ ] **Step 1: Write the failing test**

Create `packages/marketplace/src/entityPath.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { gamePath, parseGamePath, isPublishedKey } from "./entityPath";

describe("gamePath", () => {
  it("renders a published key raw, so the URL is copy-friendly", () => {
    expect(gamePath("@acme/tetris")).toBe("/games/@acme/tetris");
  });

  it("renders a scope-less share id", () => {
    expect(gamePath("xK3f9a2Bq1")).toBe("/games/xK3f9a2Bq1");
  });
});

describe("parseGamePath", () => {
  it("round-trips a published key", () => {
    expect(parseGamePath(gamePath("@acme/tetris"))).toBe("@acme/tetris");
  });

  it("round-trips a share id", () => {
    expect(parseGamePath("/games/xK3f9a2Bq1")).toBe("xK3f9a2Bq1");
  });

  it("tolerates a percent-encoded key", () => {
    expect(parseGamePath("/games/%40acme%2Ftetris")).toBe("@acme/tetris");
  });

  it("returns null for the collection route and near-misses", () => {
    expect(parseGamePath("/games")).toBeNull();
    expect(parseGamePath("/games/")).toBeNull();
    expect(parseGamePath("/gamesx/a")).toBeNull();
    expect(parseGamePath("/gems/@acme/tetris")).toBeNull();
  });

  it("returns the raw segment when the encoding is malformed rather than throwing", () => {
    expect(parseGamePath("/games/%E0%A4%A")).toBe("%E0%A4%A");
  });
});

describe("isPublishedKey", () => {
  it("accepts @scope/name", () => {
    expect(isPublishedKey("@acme/tetris")).toBe(true);
  });

  it("rejects a scope-less share id, which is what makes unlisted shares unlistable", () => {
    expect(isPublishedKey("xK3f9a2Bq1")).toBe(false);
  });

  it("rejects malformed keys", () => {
    expect(isPublishedKey("@Acme/tetris")).toBe(false);
    expect(isPublishedKey("acme/tetris")).toBe(false);
    expect(isPublishedKey("@acme")).toBe(false);
    expect(isPublishedKey("@acme/tetris/extra")).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
pnpm -C packages/marketplace exec vitest run src/entityPath.test.ts
```

Expected: FAIL — `Failed to resolve import "./entityPath"`.

- [ ] **Step 3: Write minimal implementation**

Create `packages/marketplace/src/entityPath.ts`:

```ts
// packages/marketplace/src/entityPath.ts
// The canonical entity-address scheme: <plural-collection>/<entity-id>, rendered into this app's
// pathname space. See docs/superpowers/specs/2026-07-09-entity-address-scheme-design.md.
//
// Sibling: packages/model/src/entityPath.ts implements the workspace/* half. This file cannot import
// it — the marketplace takes no workspace deps (see gems/cuts.ts). The two share the scheme, not a
// function, so there is nothing to keep in sync.
//
// Deviation from the sibling: game paths are NOT percent-encoded. Artifact names carry '/' as data,
// so workspaceArtifactPath must encode. A gem key carries '/' as structure (@scope/name, both
// [a-z0-9-]), and a copy-friendly link is this feature's whole point. We still DECODE on parse.

/** A published gem key: @scope/name, both segments [a-z0-9-] (see distribute/src/registry.ts). */
const PUBLISHED_KEY = /^@[a-z0-9-]+\/[a-z0-9-]+$/;

/** True for a published registry key. Scope-less keys are unlisted shares — unlistable by construction. */
export function isPublishedKey(key: string): boolean {
  return PUBLISHED_KEY.test(key);
}

/** Keys are [a-z0-9-@/] only, so no percent-encoding is needed and the URL stays copy-friendly. */
export function gamePath(key: string): string {
  return `/games/${key}`;
}

function safeDecode(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment; // malformed %-escape: hand it back rather than throw inside the Router
  }
}

/** The gem key addressed by a /games/... pathname, or null if this isn't one. */
export function parseGamePath(pathname: string): string | null {
  const m = pathname.match(/^\/games\/(.+)$/);
  return m ? safeDecode(m[1]) : null;
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
pnpm -C packages/marketplace exec vitest run src/entityPath.test.ts
```

Expected: PASS, 10 tests.

- [ ] **Step 5: Commit**

```bash
git add packages/marketplace/src/entityPath.ts packages/marketplace/src/entityPath.test.ts
git commit -m "feat(marketplace): canonical entity paths for games"
```

---

### Task 2: `GET /api/aggregator/game-meta` — resolve a bare key

The Play page has only a key; `game-html` demands `(key, version)`. This task adds latest-version resolution and the public read route.

The `PUBLIC_READ_PATHS` entry ships in this same task **on purpose**: without it, the route works in tests, works from `curl`, works from the console — and fails only from a cross-origin browser, which is the exact masked-failure mode this repo has hit before.

**Files:**
- Modify: `packages/aggregator/src/catalog.ts` (append after `getGemArchive`, ~line 65)
- Modify: `src/aggregator.controller.ts` (schemas near line 141; route after `gameHtml`, ~line 306)
- Modify: `src/originGuard.ts:36`
- Test: `src/__tests__/gameMeta.controller.test.ts` (create)
- Test: `src/__tests__/originGuard.test.ts` (extend)

**Interfaces:**
- Consumes: `getGemArchive(db, gemKey, version)`, `upsertCatalogGem(db, row)`, `upsertGemArchive(db, a)`, `makeTestDb()` — all from `@agentgem/aggregator`; `exportGem(gem, {version})` / `importGem(bytes)` from `@agentgem/distribute`.
- Produces:
  - `latestGemVersion(db: AppDb, gemKey: string): Promise<string | null>`
  - `AggregatorController.gameMeta(input: { query: { key: string; version?: string } }): Promise<{ title: string; genre: "replay" | "skill-run" | "project-fun"; version: string }>`

- [ ] **Step 1: Write the failing test**

Create `src/__tests__/gameMeta.controller.test.ts`:

```ts
// src/__tests__/gameMeta.controller.test.ts
//
// AggregatorController.gameMeta — GET /api/aggregator/game-meta. The Play page addresses a game by
// bare key (/games/@acme/tetris), so this route owns latest-version resolution. It must also serve a
// scope-less (unlisted) key, which PR 2's share-archive path mints.
import { describe, it, expect } from "vitest";
import { makeTestDb, upsertCatalogGem, upsertGemArchive } from "@agentgem/aggregator";
import { exportGem } from "@agentgem/distribute";
import type { Gem } from "@agentgem/model";
import { AggregatorController } from "../aggregator.controller.js";

function gameGem(name: string, title: string): Gem {
  return {
    name,
    createdFrom: { kind: "blank", title },
    artifacts: [{
      type: "game", name, title, genre: "project-fun",
      html: "<!doctype html><title>t</title><canvas></canvas>",
      createdFrom: { kind: "blank", title }, engineVersion: "1",
    }],
    checks: [], requiredSecrets: [],
  } as unknown as Gem;
}

async function seedGame(db: Awaited<ReturnType<typeof makeTestDb>>, opts: {
  gemKey: string; version: string; name: string; title: string; createdAtMs: number; catalog?: boolean;
}) {
  const { bytes } = exportGem(gameGem(opts.name, opts.title), { version: opts.version });
  await upsertGemArchive(db, {
    gemKey: opts.gemKey, version: opts.version, bytes, digest: `d-${opts.version}`, createdAtMs: opts.createdAtMs,
  });
  if (opts.catalog !== false) {
    // CatalogRow's optional fields are `?: T`, not `T | null` — omit them rather than passing null.
    await upsertCatalogGem(db, {
      gemKey: opts.gemKey, version: opts.version, publishedBy: "acme", author: "acme",
      tags: [], artifactKinds: ["game"], type: "game",
      artifacts: [{ name: opts.name, type: "game" }], createdAtMs: opts.createdAtMs,
    });
  }
}

describe("AggregatorController.gameMeta", () => {
  it("resolves a bare key to its most recently published version", async () => {
    const db = await makeTestDb();
    await seedGame(db, { gemKey: "@acme/tetris", version: "1.0.0", name: "tetris", title: "Old Tetris", createdAtMs: 1000 });
    await seedGame(db, { gemKey: "@acme/tetris", version: "2.0.0", name: "tetris", title: "New Tetris", createdAtMs: 2000 });

    const res = await new AggregatorController(db).gameMeta({ query: { key: "@acme/tetris" } });

    expect(res).toEqual({ title: "New Tetris", genre: "project-fun", version: "2.0.0" });
  });

  it("honors an explicit version", async () => {
    const db = await makeTestDb();
    await seedGame(db, { gemKey: "@acme/tetris", version: "1.0.0", name: "tetris", title: "Old Tetris", createdAtMs: 1000 });
    await seedGame(db, { gemKey: "@acme/tetris", version: "2.0.0", name: "tetris", title: "New Tetris", createdAtMs: 2000 });

    const res = await new AggregatorController(db).gameMeta({ query: { key: "@acme/tetris", version: "1.0.0" } });

    expect(res.title).toBe("Old Tetris");
    expect(res.version).toBe("1.0.0");
  });

  it("serves a scope-less unlisted key by falling back to the archive's own version", async () => {
    const db = await makeTestDb();
    await seedGame(db, { gemKey: "xK3f9a2Bq1", version: "1", name: "tetris", title: "Unlisted", createdAtMs: 1000, catalog: false });

    const res = await new AggregatorController(db).gameMeta({ query: { key: "xK3f9a2Bq1", version: "1" } });

    expect(res).toEqual({ title: "Unlisted", genre: "project-fun", version: "1" });
  });

  it("404s an unknown key", async () => {
    const db = await makeTestDb();
    await expect(new AggregatorController(db).gameMeta({ query: { key: "@acme/nope" } }))
      .rejects.toMatchObject({ status: 404, code: "gem_archive_not_found" });
  });

  it("404s a gem that has no game artifact", async () => {
    const db = await makeTestDb();
    const plain = { name: "search", createdFrom: { kind: "blank", title: "s" },
      artifacts: [{ type: "skill", name: "search", source: "standalone", content: "# Search\n" }],
      checks: [], requiredSecrets: [] } as unknown as Gem;
    const { bytes } = exportGem(plain, { version: "1.0.0" });
    await upsertGemArchive(db, { gemKey: "@acme/search", version: "1.0.0", bytes, digest: "d", createdAtMs: 1 });
    await upsertCatalogGem(db, { gemKey: "@acme/search", version: "1.0.0", publishedBy: "acme", author: "acme",
      tags: [], artifactKinds: ["skill"], type: "skill",
      artifacts: [{ name: "search", type: "skill" }], createdAtMs: 1 });

    await expect(new AggregatorController(db).gameMeta({ query: { key: "@acme/search" } }))
      .rejects.toMatchObject({ status: 404, code: "not_a_game" });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
pnpm build && pnpm exec vitest run dist/__tests__/gameMeta.controller.test.js
```

Expected: FAIL at build — `Property 'gameMeta' does not exist on type 'AggregatorController'` and `'latestGemVersion' is not exported`.

- [ ] **Step 3a: Add the version-resolution helper**

Append to `packages/aggregator/src/catalog.ts`, immediately after `getGemArchive`:

```ts
// The most recently PUBLISHED version of a gem. Ordering is by publish time, not semver: "latest"
// here means "what the publisher last shipped", which is what a bare /games/<key> URL should serve.
// Unlisted (scope-less) keys have no catalog row and therefore no latest — callers pass an explicit
// version for those.
export async function latestGemVersion(db: AppDb, gemKey: string): Promise<string | null> {
  const rows = await db.select({ version: catalogGems.version })
    .from(catalogGems)
    .where(eq(catalogGems.gemKey, gemKey))
    .orderBy(desc(catalogGems.createdAtMs))
    .limit(1);
  return rows[0]?.version ?? null;
}
```

No import change needed: `catalog.ts:5` already has `import { sql, desc, and, eq } from "drizzle-orm"`.

- [ ] **Step 3b: Add the route**

In `src/aggregator.controller.ts`, beside the other schemas (after `GameHtmlResult`, ~line 141):

```ts
const GameMetaQuery = z.object({ key: z.string(), version: z.string().optional() });
const GameMetaResult = z.object({
  title: z.string(),
  genre: z.enum(["replay", "skill-run", "project-fun"]),
  version: z.string(),
});
```

Add `latestGemVersion` to the existing `@agentgem/aggregator` import. Then add the route immediately after `gameHtml`:

```ts
  // Public: title/genre for a game addressed by BARE key (/games/@scope/name), resolving "latest" to
  // the most recently published version. The Play page renders a heading from this before the (up to
  // 1.5 MB) sealed HTML arrives. originGuard PUBLIC_READ-exempt.
  @get("/game-meta", { query: GameMetaQuery, response: GameMetaResult })
  async gameMeta(input: { query: z.infer<typeof GameMetaQuery> }): Promise<z.infer<typeof GameMetaResult>> {
    const { key } = input.query;
    const version = input.query.version ?? (await latestGemVersion(this.db, key));
    if (!version) throw new AgentError("gem archive not found", { status: 404, code: "gem_archive_not_found", retryable: false });
    const a = await getGemArchive(this.db, key, version);
    if (!a) throw new AgentError("gem archive not found", { status: 404, code: "gem_archive_not_found", retryable: false });
    const { gem } = importGem(Buffer.from(a.bytes));
    const game = gem.artifacts.find((x) => x.type === "game") as { title?: unknown; genre?: unknown } | undefined;
    if (!game || typeof game.title !== "string") throw new AgentError("this gem has no game to play", { status: 404, code: "not_a_game", retryable: false });
    return { title: game.title, genre: game.genre as z.infer<typeof GameMetaResult>["genre"], version };
  }
```

- [ ] **Step 3c: Make it publicly readable**

In `src/originGuard.ts:36`, add `"/api/aggregator/game-meta"` to the `PUBLIC_READ_PATHS` set, next to `"/api/aggregator/game-html"`. Exact match — no prefix matching.

- [ ] **Step 4: Run tests to verify they pass**

```bash
pnpm build && pnpm exec vitest run dist/__tests__/gameMeta.controller.test.js
```

Expected: PASS, 5 tests.

- [ ] **Step 5: Guard the CORS entry with a test**

Add to `src/__tests__/originGuard.test.ts`, following the shape of the existing `game-html` case in that file:

```ts
it("serves game-meta cross-origin: the Play page fetches it from app.agentgem.ai", () => {
  const res = mkRes();
  originGuard(mkReq({ method: "GET", path: "/api/aggregator/game-meta", "sec-fetch-site": "cross-site" }), res, next);
  expect(res.headers["Access-Control-Allow-Origin"]).toBe("*");
  expect(nextCalled).toBe(true);
});

it("answers the game-meta preflight without dispatching the route", () => {
  const res = mkRes();
  originGuard(mkReq({ method: "OPTIONS", path: "/api/aggregator/game-meta" }), res, next);
  expect(res.statusCode).toBe(204);
});
```

Match the existing file's helper names (`mkReq`/`mkRes`/`next`) exactly — read it first; if they differ, use the file's own idiom rather than inventing one.

```bash
pnpm build && pnpm exec vitest run dist/__tests__/originGuard.test.js
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/aggregator/src/catalog.ts src/aggregator.controller.ts src/originGuard.ts \
        src/__tests__/gameMeta.controller.test.ts src/__tests__/originGuard.test.ts
git commit -m "feat(aggregator): public game-meta route resolving a bare gem key to latest version"
```

---

### Task 3: `api.getGameMeta` — the marketplace client

**Files:**
- Modify: `packages/marketplace/src/api.ts` (after `getGameHtml`, ~line 60)
- Test: `packages/marketplace/src/api.test.ts` (extend)

**Interfaces:**
- Consumes: `GET /api/aggregator/game-meta` from Task 2.
- Produces: `api.getGameMeta(key: string, version?: string): Promise<GameMeta>` where
  `interface GameMeta { title: string; genre: "replay" | "skill-run" | "project-fun"; version: string }`

- [ ] **Step 1: Write the failing test**

Append to `packages/marketplace/src/api.test.ts` (reuse the file's existing `fetch`-stub idiom — read it first):

```ts
describe("getGameMeta", () => {
  it("omits version when absent so the server resolves latest", async () => {
    const calls: string[] = [];
    vi.stubGlobal("fetch", async (url: string) => {
      calls.push(url);
      return { ok: true, text: async () => JSON.stringify({ title: "Tetris", genre: "project-fun", version: "2.0.0" }) };
    });
    const api = makeApi("https://api.test");

    const meta = await api.getGameMeta("@acme/tetris");

    expect(meta).toEqual({ title: "Tetris", genre: "project-fun", version: "2.0.0" });
    expect(calls[0]).toBe("https://api.test/api/aggregator/game-meta?key=%40acme%2Ftetris");
  });

  it("sends an explicit version when given", async () => {
    const calls: string[] = [];
    vi.stubGlobal("fetch", async (url: string) => {
      calls.push(url);
      return { ok: true, text: async () => JSON.stringify({ title: "Tetris", genre: "project-fun", version: "1.0.0" }) };
    });

    await makeApi("https://api.test").getGameMeta("@acme/tetris", "1.0.0");

    expect(calls[0]).toContain("version=1.0.0");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
pnpm -C packages/marketplace exec vitest run src/api.test.ts
```

Expected: FAIL — `api.getGameMeta is not a function`.

- [ ] **Step 3: Write minimal implementation**

In `packages/marketplace/src/api.ts`, add the type beside the other imports/types:

```ts
export interface GameMeta { title: string; genre: "replay" | "skill-run" | "project-fun"; version: string }
```

and the method immediately after `getGameHtml` inside `makeApi`:

```ts
    // Title/genre for a game addressed by bare key; omitting version asks the server for latest.
    // buildQs drops undefined, so this sends ?key=… alone.
    getGameMeta: (key: string, version?: string) =>
      get<GameMeta>(base, "/api/aggregator/game-meta", { key, version }),
```

- [ ] **Step 4: Run test to verify it passes**

```bash
pnpm -C packages/marketplace exec vitest run src/api.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/marketplace/src/api.ts packages/marketplace/src/api.test.ts
git commit -m "feat(marketplace): getGameMeta client"
```

---

### Task 4: The `Play` page and its route

`/games/:key` renders the game fullscreen immediately. `GamePlayer` already owns the sealed
null-origin iframe and the fullscreen overlay — this page only resolves the key and hands it HTML.

Read `packages/marketplace/src/GamePlayer.tsx` before writing this: it takes
`{ html, interactive, startFullscreen, onExitFullscreen }`. Exiting fullscreen on this page means
*leaving the page*, so `onExitFullscreen` navigates back to `/minigames`.

**Files:**
- Create: `packages/marketplace/src/pages/Play.tsx`
- Modify: `packages/marketplace/src/Router.tsx` (import + route, before the `/gems` matcher)
- Test: `packages/marketplace/src/pages/Play.test.tsx`

**Interfaces:**
- Consumes: `parseGamePath` (Task 1); `api.getGameMeta` (Task 3); `api.getGameHtml` (existing); `navigate` from `../nav`; `GamePlayer` from `../GamePlayer`.
- Produces: `Play({ api, gemKey }: { api: ReturnType<typeof makeApi>; gemKey: string })`.

- [ ] **Step 1: Write the failing test**

Create `packages/marketplace/src/pages/Play.test.tsx`:

```tsx
import { describe, it, expect, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { Play } from "./Play";

function apiStub(over: Partial<{ getGameMeta: unknown; getGameHtml: unknown }> = {}) {
  return {
    getGameMeta: vi.fn().mockResolvedValue({ title: "Tetris", genre: "project-fun", version: "2.0.0" }),
    getGameHtml: vi.fn().mockResolvedValue("<!doctype html><title>t</title>"),
    ...over,
  } as never;
}

describe("Play", () => {
  it("resolves the bare key to a version, then fetches that version's html", async () => {
    const api = apiStub();
    render(<Play api={api} gemKey="@acme/tetris" />);

    await waitFor(() => expect((api as never as { getGameHtml: ReturnType<typeof vi.fn> }).getGameHtml)
      .toHaveBeenCalledWith("@acme/tetris", "2.0.0"));
  });

  it("renders the sealed iframe once html arrives", async () => {
    render(<Play api={apiStub()} gemKey="@acme/tetris" />);
    await waitFor(() => expect(document.querySelector("iframe[sandbox]")).not.toBeNull());
  });

  it("shows a not-found state for an unknown key instead of a blank iframe", async () => {
    const api = apiStub({ getGameMeta: vi.fn().mockRejectedValue(new Error("game-meta -> 404")) });
    render(<Play api={api} gemKey="@acme/nope" />);

    await waitFor(() => expect(screen.getByText(/doesn't exist/i)).toBeTruthy());
    expect(document.querySelector("iframe")).toBeNull();
  });

  it("shows the not-found state when the gem resolves but has no game", async () => {
    const api = apiStub({ getGameHtml: vi.fn().mockRejectedValue(new Error("game-html -> 404")) });
    render(<Play api={api} gemKey="@acme/search" />);

    await waitFor(() => expect(screen.getByText(/doesn't exist/i)).toBeTruthy());
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
pnpm -C packages/marketplace exec vitest run src/pages/Play.test.tsx
```

Expected: FAIL — `Failed to resolve import "./Play"`.

- [ ] **Step 3: Write minimal implementation**

Create `packages/marketplace/src/pages/Play.tsx`:

```tsx
// packages/marketplace/src/pages/Play.tsx
// /games/<key> — the shareable game link. A stranger opens this and the game is already running:
// no account, no install. The URL is the whole point, so this page is reachable by address alone
// (the /minigames grid navigates here rather than portalling a URL-less overlay).
//
// The key may be a published @scope/name or a scope-less unlisted share id; both resolve through
// game-meta -> (title, version) -> game-html. Sealing is GamePlayer's job, not ours.
import { useEffect, useState } from "react";
import type { makeApi } from "../api";
import { GamePlayer } from "../GamePlayer";
import { navigate } from "../nav";

type Api = ReturnType<typeof makeApi>;

export function Play({ api, gemKey }: { api: Api; gemKey: string }) {
  const [html, setHtml] = useState<string | null>(null);
  const [title, setTitle] = useState<string | null>(null);
  const [missing, setMissing] = useState(false);

  useEffect(() => {
    let alive = true;
    setHtml(null); setTitle(null); setMissing(false);
    (async () => {
      // Two hops on purpose: the URL carries no version, and game-html demands one.
      const meta = await api.getGameMeta(gemKey);
      if (!alive) return;
      setTitle(meta.title);
      const h = await api.getGameHtml(gemKey, meta.version);
      if (alive) setHtml(h);
    })().catch(() => { if (alive) setMissing(true); });
    return () => { alive = false; };
  }, [api, gemKey]);

  if (missing) {
    return (
      <div className="mg">
        <h2 className="mg-h">This game link doesn't exist</h2>
        <p className="mg-intro">It may have been unpublished or revoked. <a href="/minigames">Browse mini-games →</a></p>
      </div>
    );
  }

  if (!html) return <p className="mg-intro">Loading {title ?? gemKey}…</p>;

  return <GamePlayer html={html} interactive startFullscreen onExitFullscreen={() => navigate("/minigames")} />;
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
pnpm -C packages/marketplace exec vitest run src/pages/Play.test.tsx
```

Expected: PASS, 4 tests. If the iframe assertion fails, read `GamePlayer.tsx` and match its real attribute (it renders `sandbox="allow-scripts"` via `srcDoc`).

- [ ] **Step 5: Wire the route**

In `packages/marketplace/src/Router.tsx`, add the imports:

```tsx
import { Play } from "./pages/Play";
import { parseGamePath } from "./entityPath";
```

and the route — place it beside the other entity matchers, **before** the `/gems` collection check:

```tsx
  const gameKey = parseGamePath(path);
  if (gameKey) return <Play api={api} gemKey={gameKey} />;
```

- [ ] **Step 6: Verify the route matches**

Add to `packages/marketplace/src/App.test.tsx`, reusing that file's existing `res()` helper and its
`afterEach` (which already calls `cleanup()`, `vi.unstubAllGlobals()`, and resets the path to `/`):

```tsx
describe("game route", () => {
  it("routes /games/@scope/name to the Play page", async () => {
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      if (url.includes("/game-meta")) return res({ title: "Tetris", genre: "project-fun", version: "2.0.0" });
      if (url.includes("/game-html")) return res({ html: "<!doctype html><title>t</title>" });
      return res([]);
    }));
    window.history.pushState({}, "", "/games/@acme/tetris");

    render(<App />);

    // Play renders "Loading <title>…" once game-meta lands, then swaps in the sealed iframe.
    expect(await screen.findByText(/Loading/i)).toBeTruthy();
    await waitFor(() => expect(document.querySelector("iframe[sandbox]")).not.toBeNull());
  });
});
```

`App.test.tsx` imports `describe, it, expect, vi, afterEach` and `render, screen, cleanup, fireEvent`
today — add `waitFor` to the `@testing-library/react` import.

```bash
pnpm -C packages/marketplace exec vitest run && pnpm -C packages/marketplace exec tsc -p tsconfig.json --noEmit
```

Expected: all PASS, typecheck clean.

- [ ] **Step 7: Commit**

```bash
git add packages/marketplace/src/pages/Play.tsx packages/marketplace/src/pages/Play.test.tsx \
        packages/marketplace/src/Router.tsx packages/marketplace/src/App.test.tsx
git commit -m "feat(marketplace): /games/:key plays a game by URL"
```

---

### Task 5: The grid navigates instead of portalling

This is the fix for the original complaint. Today `GamePreview` owns a `playing` boolean and
portals a fullscreen `GamePlayer` to `document.body` — the URL never changes, so there is nothing
to copy. The arcade card should navigate to `/games/<key>` instead.

`GamePreview` is shared with the gem-detail page (`pages/Gem.tsx:120-124`), which should keep its
in-place portal behavior. So `onPlay` is **optional**: provided → navigate; absent → portal.

**Files:**
- Modify: `packages/marketplace/src/GamePreview.tsx`
- Modify: `packages/marketplace/src/pages/Minigames.tsx` (`GameCard`, ~line 37)
- Test: `packages/marketplace/src/GamePreview.test.tsx` (create)

**Interfaces:**
- Consumes: `gamePath` (Task 1), `navigate` (`../nav`).
- Produces: `GamePreview` gains `onPlay?: () => void`.

- [ ] **Step 1: Write the failing test**

Create `packages/marketplace/src/GamePreview.test.tsx`:

```tsx
// `@testing-library/user-event` is NOT a devDependency here — use fireEvent, as App.test.tsx does.
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, waitFor, cleanup, fireEvent } from "@testing-library/react";
import { GamePreview } from "./GamePreview";

afterEach(cleanup);

const api = { getGameHtml: vi.fn().mockResolvedValue("<!doctype html><title>t</title>") } as never;

async function enabledPlayButton(): Promise<HTMLButtonElement> {
  const btn = await screen.findByRole("button", { name: /Play @acme\/tetris/i });
  await waitFor(() => expect((btn as HTMLButtonElement).disabled).toBe(false)); // enables once html lands
  return btn as HTMLButtonElement;
}

describe("GamePreview", () => {
  it("calls onPlay instead of portalling when onPlay is given", async () => {
    const onPlay = vi.fn();
    render(<GamePreview api={api} gemKey="@acme/tetris" version="1.0.0" onPlay={onPlay} />);

    fireEvent.click(await enabledPlayButton());

    expect(onPlay).toHaveBeenCalledOnce();
    expect(document.querySelectorAll("iframe").length).toBe(1); // thumbnail only — no overlay
  });

  it("still portals fullscreen when onPlay is absent (gem-detail page)", async () => {
    render(<GamePreview api={api} gemKey="@acme/tetris" version="1.0.0" />);

    fireEvent.click(await enabledPlayButton());

    await waitFor(() => expect(document.querySelectorAll("iframe").length).toBe(2)); // thumb + overlay
  });
});
```

Note: the second test asserts on iframes because the overlay's class name is `GamePlayer`'s
business. Read `GamePlayer.tsx` and, if it exposes a stable fullscreen class, assert on that
instead — prefer the real class name over the iframe count.

- [ ] **Step 2: Run test to verify it fails**

```bash
pnpm -C packages/marketplace exec vitest run src/GamePreview.test.tsx
```

Expected: FAIL — `onPlay` is not a prop; `expect(onPlay).toHaveBeenCalledOnce()` receives 0 calls.

- [ ] **Step 3: Write minimal implementation**

In `packages/marketplace/src/GamePreview.tsx`, change the signature and the click handler:

```tsx
export function GamePreview({ api, gemKey, version, onPlay }: { api: Api; gemKey: string; version: string; onPlay?: () => void }) {
```

```tsx
      <button type="button" className="gp-thumb" disabled={!html} onClick={() => (onPlay ? onPlay() : setPlaying(true))}
        title={html ? "Play" : undefined} aria-label={`Play ${gemKey}`}>
```

Leave the portal block untouched — `playing` simply never becomes true when `onPlay` is supplied.

- [ ] **Step 4: Run test to verify it passes**

```bash
pnpm -C packages/marketplace exec vitest run src/GamePreview.test.tsx
```

Expected: PASS, 2 tests.

- [ ] **Step 5: Point the arcade card at the URL**

In `packages/marketplace/src/pages/Minigames.tsx`, import `gamePath`:

```tsx
import { gamePath } from "../entityPath";
```

and in `GameCard`, hand `GamePreview` a navigating `onPlay`:

```tsx
        <GamePreview api={api} gemKey={gem.key} version={gem.version} onPlay={() => navigate(gamePath(gem.key))} />
```

`navigate` is already imported in this file.

- [ ] **Step 6: Run the full marketplace suite and typecheck**

```bash
pnpm -C packages/marketplace exec vitest run && pnpm -C packages/marketplace exec tsc -p tsconfig.json --noEmit
```

Expected: all PASS, typecheck clean. `Minigames.test.tsx`, if it asserts on the portal, will need
updating to assert on `navigate` — that is the intended behavior change, not a regression.

- [ ] **Step 7: Commit**

```bash
git add packages/marketplace/src/GamePreview.tsx packages/marketplace/src/GamePreview.test.tsx \
        packages/marketplace/src/pages/Minigames.tsx
git commit -m "feat(marketplace): arcade cards navigate to /games/:key so the URL is copyable"
```

---

### Task 6: Verify end-to-end, then open the PR

- [ ] **Step 1: Full server suite**

```bash
pnpm test
```

Expected: PASS. If `observeScan`/`scorecard` real-FS tests time out, re-run them in isolation —
they are known to flake under full-suite concurrency and are unrelated to this change.

- [ ] **Step 2: Full marketplace suite + typecheck + build**

```bash
pnpm -C packages/marketplace exec vitest run
pnpm -C packages/marketplace exec tsc -p tsconfig.json --noEmit
pnpm -C packages/marketplace build
```

Expected: all PASS.

- [ ] **Step 3: Drive the real thing**

Do not ship on green tests alone. Run the marketplace against the live API, open
`/minigames`, click a game, and confirm the address bar shows `/games/@scope/name`. Copy that URL,
open it in a fresh tab, and confirm the game loads already running. Then visit
`/games/@acme/does-not-exist` and confirm the not-found state renders rather than a blank iframe.

```bash
pnpm -C packages/marketplace dev
```

- [ ] **Step 4: Confirm the branch is ahead of origin/main only**

```bash
git fetch origin && git rev-list --left-right --count origin/main...HEAD
```

Expected: `0	<n>` — behind must be 0.

- [ ] **Step 5: Push and open the PR**

```bash
git push -u origin docs/entity-address-scheme
gh pr create --title "feat: games are addressable at /games/:key" --body "$(cat <<'EOF'
Implements PR 1 of `docs/superpowers/specs/2026-07-09-entity-address-scheme-design.md`.

Mini-games had no copyable URL: the `/minigames` grid opened a fullscreen React portal, so the
address bar never changed. Now every published game has a shareable link.

- `entityPath.ts` — the canonical `<plural-collection>/<entity-id>` scheme, marketplace-local
  (the marketplace takes no workspace deps; see `gems/cuts.ts`)
- `GET /api/aggregator/game-meta` — resolves a bare key to its latest version + title/genre,
  and is `PUBLIC_READ_PATHS`-exempt so the SPA can fetch it cross-origin
- `/games/:key` + `pages/Play.tsx` — opens the game already running, no account, no install
- the arcade card navigates instead of portalling

No Worker, no upload path, no schema change — those are PRs 2 and 3.

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

- [ ] **Step 6: Watch CI, merge, verify every commit landed**

`main` requires `test (24)` + `test (26)`; auto-merge is disabled.

```bash
gh run watch <run-id> --exit-status
gh pr merge --rebase --delete-branch
```

`--delete-branch` will error on the local delete because `main` is checked out in another
worktree — **the remote merge still succeeds**. Then verify each commit's content actually
reached the trunk, not just the first:

```bash
git fetch origin
git show origin/main:packages/marketplace/src/entityPath.ts | head -3
git show origin/main:packages/marketplace/src/pages/Play.tsx | head -3
git show origin/main:src/aggregator.controller.ts | grep -c "game-meta"
git show origin/main:src/originGuard.ts | grep -c "game-meta"
git show origin/main:packages/marketplace/src/pages/Minigames.tsx | grep -c "onPlay"
```

Every one must hit. If commits were dropped, they are safe on the local branch:
`git rebase origin/main` (merged commits auto-skip) → fresh branch → new PR.
