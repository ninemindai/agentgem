# Live Gem-Catalog (browse-only, cached, static fallback) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Serve the registry index as a cached, CORS-open `GET /api/registry/gems`, and swap the marketplace `/gems` browse to it — falling back to the curated static catalog when the registry is empty/unconfigured/errors.

**Architecture:** Backend adds a pure, unit-tested cache/mapping module (`src/gem/publicCatalog.ts`) wired into one thin gem-controller endpoint + an `originGuard` CORS allow. Frontend adds an async `loadGems`/`findGem` seam in `gems/catalog.ts` (keeping the static gems as `STATIC_GEMS` fallback) and makes the two gem pages fetch. Browse-only: live gems carry no ingredients.

**Tech Stack:** Server — TypeScript ESM (`.js`-extension imports), `@agentback` controllers, Zod schemas, Vitest on **compiled dist**. Marketplace — Vite + React 19, Vitest + jsdom, **extensionless** imports.

## Global Constraints

- **Two packages, two test conventions:**
  - Server (root `@ninemind/agentgem`): ESM imports use **`.js`** extensions. Tests run from **compiled dist** (`vitest` include = `dist/**/__tests__/**/*.test.js`); the test command is `pnpm test` = `tsc -b && vitest run`. For a focused run: `pnpm exec tsc -b && pnpm exec vitest run dist/__tests__/<name>.test.js`. Clean dist (`rm -rf dist`) if a rename leaves stale compiled tests.
  - Marketplace (`@agentgem/marketplace`): **extensionless** imports; tests run on `src` directly via `pnpm --filter @agentgem/marketplace test [file]`; assert with `.toBeTruthy()`/`.toBeNull()` (NOT jest-dom); `vi.stubGlobal`.
- The endpoint is **browse-only**: `RegistryGem` has NO `ingredients`. Live gems map to `Gem` with `ingredients: []`.
- **Graceful:** the public endpoint never throws/500s — unconfigured registry or a fetch error → `{ gems: [] }`. The frontend falls back to `STATIC_GEMS` on empty or error.
- The existing loopback `/api/registry/search` and the desktop console are **untouched**.
- Keep each task green: Task 3 is **additive** to `catalog.ts` (keeps `listGems`/`getGem`); Task 4 swaps the pages and removes the now-unused `listGems`/`getGem`.

## File structure

```
src/
  gem/publicCatalog.ts            CREATE  RegistryGem, mapIndexToGems, createGemCache
  __tests__/publicCatalog.test.ts CREATE
  schemas.ts                      MODIFY  RegistryGemSchema, RegistryGemsResponseSchema
  gem.controller.ts               MODIFY  module-level cache + GET /registry/gems
  __tests__/gem.controller.test.ts MODIFY add the unconfigured→[] case
  originGuard.ts                  MODIFY  add /api/registry/gems to PUBLIC_READ_PATHS
  __tests__/originGuard.test.ts   MODIFY  CORS case for the new path
packages/marketplace/src/
  types.ts                        MODIFY  RegistryGem
  api.ts                          MODIFY  getGems()
  gems/catalog.ts                 MODIFY  STATIC_GEMS + loadGems + findGem (Task 3 additive; Task 4 removes listGems/getGem)
  gems/catalog.test.ts            MODIFY
  pages/Gems.tsx                  MODIFY  async + api prop (Task 4)
  pages/Gems.test.tsx             MODIFY  (Task 4)
  pages/Gem.tsx                   MODIFY  async + api prop + conditional Contains (Task 4)
  pages/Gem.test.tsx              MODIFY  (Task 4)
  Router.tsx                      MODIFY  pass api to Gems/Gem (Task 4)
  Router.test.tsx                 MODIFY  (Task 4)
```

---

### Task 1: Backend — pure catalog mapping + TTL cache

**Files:**
- Create: `src/gem/publicCatalog.ts`, `src/__tests__/publicCatalog.test.ts`

**Interfaces:**
- Consumes: `RegistryIndex` from `./registry.js` (`{ formatVersion: number; items: Record<string, { latest: string; versions: …; discovery?: { description?: string; tags?: string[]; author?: string; artifactKinds?: string[]; updatedAt?: string } }> }`).
- Produces:
  - `interface RegistryGem { key: string; version: string; author?: string; description?: string; tags?: string[]; artifactKinds?: string[] }`
  - `mapIndexToGems(index: RegistryIndex): RegistryGem[]`
  - `interface GemCache { get(getIndex: (() => Promise<RegistryIndex>) | null, now: number): Promise<RegistryGem[]> }`
  - `createGemCache(ttlMs: number): GemCache`

- [ ] **Step 1: Write the failing test** — `src/__tests__/publicCatalog.test.ts`

```ts
import { describe, it, expect, vi } from "vitest";
import { mapIndexToGems, createGemCache } from "../gem/publicCatalog.js";

const index = {
  formatVersion: 1,
  items: {
    "@superpowers/brainstorming-kit": {
      latest: "1.2.0", versions: {},
      discovery: { author: "superpowers", description: "plan stuff", tags: ["planning"], artifactKinds: ["skill"] },
    },
    "@x/bare": { latest: "0.1.0", versions: {} },
  },
} as never;

describe("mapIndexToGems", () => {
  it("flattens index items to RegistryGem (version = latest, discovery spread, no ingredients field)", () => {
    const gems = mapIndexToGems(index);
    expect(gems).toContainEqual({ key: "@superpowers/brainstorming-kit", version: "1.2.0", author: "superpowers", description: "plan stuff", tags: ["planning"], artifactKinds: ["skill"] });
    expect(gems.find((g) => g.key === "@x/bare")).toEqual({ key: "@x/bare", version: "0.1.0", author: undefined, description: undefined, tags: undefined, artifactKinds: undefined });
    expect(gems.some((g) => "ingredients" in g)).toBe(false);
  });
});

describe("createGemCache", () => {
  it("returns [] when the source is null (unconfigured), ignoring any cached value", async () => {
    const c = createGemCache(1000);
    expect(await c.get(null, 0)).toEqual([]);
  });
  it("returns [] (not throw) when the source throws", async () => {
    const c = createGemCache(1000);
    expect(await c.get(() => Promise.reject(new Error("github down")), 0)).toEqual([]);
  });
  it("fetches once within the TTL window, refetches after it expires", async () => {
    const getIndex = vi.fn(() => Promise.resolve(index));
    const c = createGemCache(1000);
    await c.get(getIndex, 0);
    await c.get(getIndex, 500);
    expect(getIndex).toHaveBeenCalledTimes(1);
    await c.get(getIndex, 1500);
    expect(getIndex).toHaveBeenCalledTimes(2);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm exec tsc -b && pnpm exec vitest run dist/__tests__/publicCatalog.test.js`
Expected: FAIL — module `../gem/publicCatalog.js` not found (compile error / missing).

- [ ] **Step 3: Create `src/gem/publicCatalog.ts`**

```ts
// Copyright NineMind, Inc. 2026. All Rights Reserved.
// Browse-only public gem catalog: flatten the registry index's discovery metadata and cache it.
import type { RegistryIndex } from "./registry.js";

export interface RegistryGem {
  key: string;
  version: string;
  author?: string;
  description?: string;
  tags?: string[];
  artifactKinds?: string[];
}

/** Flatten the index's per-item discovery block into a browse list. No ingredients (browse-only). */
export function mapIndexToGems(index: RegistryIndex): RegistryGem[] {
  return Object.entries(index.items).map(([key, item]) => ({
    key,
    version: item.latest,
    author: item.discovery?.author,
    description: item.discovery?.description,
    tags: item.discovery?.tags,
    artifactKinds: item.discovery?.artifactKinds,
  }));
}

export interface GemCache {
  get(getIndex: (() => Promise<RegistryIndex>) | null, now: number): Promise<RegistryGem[]>;
}

/** TTL cache over the (network) index fetch. Graceful: a null source or a thrown fetch yields [].
 *  One fetch per TTL window across all callers — the GitHub-rate-limit protection. */
export function createGemCache(ttlMs: number): GemCache {
  let entry: { at: number; gems: RegistryGem[] } | null = null;
  return {
    async get(getIndex, now) {
      if (!getIndex) return []; // unconfigured → empty, regardless of any stale cache
      if (entry && now - entry.at < ttlMs) return entry.gems;
      try {
        const gems = mapIndexToGems(await getIndex());
        entry = { at: now, gems };
        return gems;
      } catch {
        return []; // never poison the cache or 500 the public path
      }
    },
  };
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `pnpm exec tsc -b && pnpm exec vitest run dist/__tests__/publicCatalog.test.js`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add src/gem/publicCatalog.ts src/__tests__/publicCatalog.test.ts
git commit -m "feat(registry): pure public-gem mapping + TTL cache"
```

---

### Task 2: Backend — `GET /api/registry/gems` + CORS

**Files:**
- Modify: `src/schemas.ts`, `src/gem.controller.ts`, `src/originGuard.ts`
- Modify (tests): `src/__tests__/gem.controller.test.ts`, `src/__tests__/originGuard.test.ts`

**Interfaces:**
- Consumes: `createGemCache` (Task 1); existing `registryConfigFromEnv`, `githubRegistrySource` (already imported in `gem.controller.ts`).
- Produces: `GET /api/registry/gems` → `{ gems: RegistryGem[] }` (CORS-open, cached, graceful-empty).

- [ ] **Step 1: Add the schemas** — in `src/schemas.ts`, next to `RegistrySearchResponseSchema` (~line 675):

```ts
export const RegistryGemSchema = z.object({
  key: z.string(),
  version: z.string(),
  author: z.string().optional(),
  description: z.string().optional(),
  tags: z.array(z.string()).optional(),
  artifactKinds: z.array(z.string()).optional(),
});
export const RegistryGemsResponseSchema = z.object({ gems: z.array(RegistryGemSchema) });
```

- [ ] **Step 2: Write the failing controller test** — append to `src/__tests__/gem.controller.test.ts` (near the existing `registryReady`/`registrySearch` unset-env cases ~line 690):

```ts
  it("registryGems returns an empty list when the registry is unconfigured (graceful, no throw)", async () => {
    const prev = process.env.AGENTGEM_REGISTRY_REPO;
    delete process.env.AGENTGEM_REGISTRY_REPO;
    try {
      const res = await new GemController().registryGems({ query: {} });
      expect(res).toEqual({ gems: [] });
    } finally {
      if (prev !== undefined) process.env.AGENTGEM_REGISTRY_REPO = prev;
    }
  });
```

- [ ] **Step 3: Run to verify it fails**

Run: `pnpm exec tsc -b 2>&1 | head` — Expected: compile FAILS (`registryGems` doesn't exist on `GemController`).

- [ ] **Step 4: Add the endpoint** — in `src/gem.controller.ts`:

1. Add the import near the other `./gem/*` imports:
```ts
import { createGemCache } from "./gem/publicCatalog.js";
```
2. Add a module-level cache (outside the controller class, with the other module-level consts):
```ts
// Public browse catalog: one shared 5-minute TTL cache so visitor traffic never hits GitHub per-request.
const publicGemCache = createGemCache(5 * 60 * 1000);
```
3. Import the new schemas where the controller imports the other `Registry*ResponseSchema` (from `./schemas.js`): add `RegistryGemsResponseSchema`.
4. Add the endpoint method inside the controller class, next to `registrySearch`:
```ts
  // Public, CORS-open (see originGuard), browse-only gem list. Graceful: unconfigured or a fetch
  // error yields { gems: [] }. Uses the shared TTL cache to bound GitHub traffic.
  @get("/registry/gems", { query: PickQuerySchema, response: RegistryGemsResponseSchema })
  async registryGems(_input: { query: z.infer<typeof PickQuerySchema> }): Promise<z.infer<typeof RegistryGemsResponseSchema>> {
    const cfg = registryConfigFromEnv();
    const getIndex = cfg ? () => githubRegistrySource(cfg).getIndex() : null;
    return { gems: await publicGemCache.get(getIndex, Date.now()) };
  }
```

- [ ] **Step 5: Add the CORS allow** — in `src/originGuard.ts`, add `/api/registry/gems` to `PUBLIC_READ_PATHS`:

```ts
const PUBLIC_READ_PATHS = new Set(["/api/aggregator/popularity", "/api/aggregator/co-occurrence", "/api/aggregator/adoption", "/api/aggregator/co-occurrence-matrix", "/api/registry/gems"]);
```

- [ ] **Step 6: Add the originGuard CORS test** — in `src/__tests__/originGuard.test.ts`, inside the existing `describe("originGuard — public aggregator reads (CORS + cross-site exemption)", …)` block (which already uses a `run(headers, host, method, path)` helper that returns `{ nexted, set }`), append:

```ts
  it("allows a cross-site GET to the public gem catalog and sets permissive CORS", () => {
    const r = run({ "sec-fetch-site": "cross-site" }, "agg.example", "GET", "/api/registry/gems");
    expect(r.nexted).toBe(true);
    expect(r.set["access-control-allow-origin"]).toBe("*");
  });
```

- [ ] **Step 7: Run the backend tests**

Run: `pnpm exec tsc -b && pnpm exec vitest run dist/__tests__/gem.controller.test.js dist/__tests__/originGuard.test.js`
Expected: PASS — the new `registryGems` unconfigured→`{gems:[]}` case and the new originGuard CORS case pass; existing cases unaffected.

- [ ] **Step 8: Commit**

```bash
git add src/schemas.ts src/gem.controller.ts src/originGuard.ts src/__tests__/gem.controller.test.ts src/__tests__/originGuard.test.ts
git commit -m "feat(registry): public cached GET /api/registry/gems + CORS"
```

---

### Task 3: Frontend — RegistryGem type, getGems, async catalog seam (additive)

**Files:**
- Modify: `packages/marketplace/src/types.ts`, `src/api.ts`, `src/gems/catalog.ts`, `src/gems/catalog.test.ts`

**Interfaces:**
- Consumes: `Gem` (existing in `catalog.ts`); `makeApi` (existing).
- Produces:
  - `types.ts`: `interface RegistryGem { key: string; version: string; author?: string; description?: string; tags?: string[]; artifactKinds?: string[] }`
  - `api.ts`: `makeApi(base).getGems(): Promise<RegistryGem[]>`
  - `catalog.ts`: `STATIC_GEMS: Gem[]` (the renamed seed), `loadGems(api): Promise<Gem[]>`, `findGem(gems, key): Gem | undefined`. **`listGems`/`getGem`/`filterGems` stay** (this task is additive; Task 4 removes `listGems`/`getGem`).

- [ ] **Step 1: Add `RegistryGem` to `types.ts`**

```ts
export interface RegistryGem {
  key: string;
  version: string;
  author?: string;
  description?: string;
  tags?: string[];
  artifactKinds?: string[];
}
```

- [ ] **Step 2: Add `getGems` to `api.ts`**

Add `RegistryGem` to the import from `./types`, and add this method to the object returned by `makeApi`:
```ts
    getGems: () =>
      get<{ gems: RegistryGem[] }>(base, "/api/registry/gems").then((r) => r.gems),
```

- [ ] **Step 3: Write the failing catalog test** — add to `packages/marketplace/src/gems/catalog.test.ts` (keep existing tests):

```ts
import { STATIC_GEMS, loadGems, findGem } from "./catalog";
import type { RegistryGem } from "../types";

const liveOne: RegistryGem = { key: "live-gem", version: "3.0.0", author: "acme", description: "live", tags: ["x"], artifactKinds: ["mcp"] };
const apiWith = (impl: () => Promise<RegistryGem[]>) => ({ getGems: impl }) as never;

describe("loadGems", () => {
  it("maps live registry gems to Gem with empty ingredients", async () => {
    const gems = await loadGems(apiWith(() => Promise.resolve([liveOne])));
    expect(gems).toEqual([{ key: "live-gem", version: "3.0.0", author: "acme", description: "live", tags: ["x"], artifactKinds: ["mcp"], ingredients: [] }]);
  });
  it("falls back to STATIC_GEMS when the live list is empty", async () => {
    expect(await loadGems(apiWith(() => Promise.resolve([])))).toEqual(STATIC_GEMS);
  });
  it("falls back to STATIC_GEMS when getGems throws", async () => {
    expect(await loadGems(apiWith(() => Promise.reject(new Error("net"))))).toEqual(STATIC_GEMS);
  });
});

describe("findGem", () => {
  it("hits and misses", () => {
    expect(findGem(STATIC_GEMS, STATIC_GEMS[0].key)?.key).toBe(STATIC_GEMS[0].key);
    expect(findGem(STATIC_GEMS, "nope")).toBeUndefined();
  });
});
```

- [ ] **Step 4: Run to verify it fails**

Run: `pnpm --filter @agentgem/marketplace test src/gems/catalog.test.ts`
Expected: FAIL — `STATIC_GEMS`/`loadGems`/`findGem` not exported.

- [ ] **Step 5: Update `catalog.ts` (additively)**

1. Rename the seed `export const GEMS: Gem[] = [...]` to `export const STATIC_GEMS: Gem[] = [...]` (same contents).
2. Keep the existing helpers but point them at the new name:
```ts
export function listGems(): Gem[] { return STATIC_GEMS; }
export function getGem(key: string): Gem | undefined { return STATIC_GEMS.find((g) => g.key === key); }
```
3. Add the new async seam + mapping at the bottom:
```ts
import type { RegistryGem } from "../types";
import type { makeApi } from "../api";

function toGem(r: RegistryGem): Gem {
  return { key: r.key, version: r.version, author: r.author, description: r.description ?? "", tags: r.tags ?? [], artifactKinds: r.artifactKinds ?? [], ingredients: [] };
}

/** Live registry gems, or the curated STATIC_GEMS when the registry is empty/unconfigured/errors. */
export async function loadGems(api: ReturnType<typeof makeApi>): Promise<Gem[]> {
  try {
    const live = await api.getGems();
    return live.length > 0 ? live.map(toGem) : STATIC_GEMS;
  } catch {
    return STATIC_GEMS;
  }
}

export function findGem(gems: Gem[], key: string): Gem | undefined { return gems.find((g) => g.key === key); }
```
(`filterGems` stays unchanged.)

- [ ] **Step 6: Run to verify it passes + typecheck**

Run: `pnpm --filter @agentgem/marketplace test src/gems/catalog.test.ts`
Expected: PASS (existing + new). Then `pnpm --filter @agentgem/marketplace typecheck` → clean (the pages still import `listGems`/`getGem`, which still exist).

- [ ] **Step 7: Commit**

```bash
git add packages/marketplace/src/types.ts packages/marketplace/src/api.ts packages/marketplace/src/gems/catalog.ts packages/marketplace/src/gems/catalog.test.ts
git commit -m "feat(marketplace): RegistryGem + getGems + async loadGems/findGem seam"
```

---

### Task 4: Frontend — gem pages fetch live (async) + router; drop the static seam

**Files:**
- Modify: `packages/marketplace/src/pages/Gems.tsx`, `Gems.test.tsx`, `pages/Gem.tsx`, `Gem.test.tsx`, `Router.tsx`, `Router.test.tsx`, `gems/catalog.ts`, `gems/catalog.test.ts`

**Interfaces:**
- Consumes: `loadGems`, `findGem`, `filterGems` (Task 3); `makeApi` (existing).
- Produces: `Gems({ api })` and `Gem({ api, keyName })` — both fetch via `loadGems`. `listGems`/`getGem` removed from `catalog.ts`.

- [ ] **Step 1: Update the Gems test for async + api** — replace the body of `packages/marketplace/src/pages/Gems.test.tsx` with:

```tsx
import { describe, it, expect, afterEach, vi } from "vitest";
import { render, screen, cleanup, fireEvent, waitFor } from "@testing-library/react";
import { Gems } from "./Gems";
import { STATIC_GEMS } from "../gems/catalog";

afterEach(() => cleanup());
const apiWith = (impl: () => Promise<unknown>) => ({ getGems: impl }) as never;

describe("Gems (browse)", () => {
  it("renders live gems from the api", async () => {
    const api = apiWith(() => Promise.resolve([{ key: "live-gem", version: "3.0.0", description: "d", tags: [], artifactKinds: ["mcp"] }]));
    render(<Gems api={api} />);
    expect(await screen.findByText("live-gem")).toBeTruthy();
  });

  it("falls back to the static catalog when the api returns empty", async () => {
    const api = apiWith(() => Promise.resolve([]));
    render(<Gems api={api} />);
    expect(await screen.findByText(STATIC_GEMS[0].key)).toBeTruthy();
  });

  it("search narrows the loaded list", async () => {
    const api = apiWith(() => Promise.resolve([]));  // → static fallback (has github-flow + brainstorming-kit)
    render(<Gems api={api} />);
    await screen.findByText("brainstorming-kit");
    fireEvent.change(screen.getByLabelText("search gems"), { target: { value: "github" } });
    expect(screen.getByText("github-flow")).toBeTruthy();
    expect(screen.queryByText("brainstorming-kit")).toBeNull();
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm --filter @agentgem/marketplace test src/pages/Gems.test.tsx`
Expected: FAIL — `Gems` takes no `api` / isn't async yet.

- [ ] **Step 3: Rewrite `pages/Gems.tsx` (async)**

```tsx
import { useEffect, useState } from "react";
import type { makeApi } from "../api";
import type { Gem } from "../gems/catalog";
import { loadGems, filterGems } from "../gems/catalog";
import { kindLabel } from "../data";

export function Gems({ api }: { api: ReturnType<typeof makeApi> }) {
  const [gems, setGems] = useState<Gem[] | null>(null);
  const [search, setSearch] = useState("");

  useEffect(() => {
    let alive = true;
    loadGems(api).then((g) => { if (alive) setGems(g); });
    return () => { alive = false; };
  }, [api]);

  if (gems === null) return <p className="ex-empty">Loading gems…</p>;
  const visible = filterGems(gems, search);

  return (
    <div className="ex-gems">
      <input className="ex-search" type="search" aria-label="search gems"
        placeholder="filter gems by name, tag, description…" value={search}
        onChange={(e) => setSearch(e.target.value)} />
      {visible.length === 0 && <p className="ex-empty">No gems match “{search}”.</p>}
      <ul className="ex-gem-list">
        {visible.map((g) => (
          <li key={g.key}>
            <a className="ex-gem-card" href={"/gems/" + encodeURIComponent(g.key)}>
              <span className="ex-gem-head">
                <span className="ex-gem-key">{g.key}</span>
                <span className="ex-gem-kinds">{g.artifactKinds.map((k) => <span key={k} className="ex-chip">{kindLabel(k)}</span>)}</span>
              </span>
              <span className="ex-gem-desc">{g.description}</span>
              <span className="ex-gem-tags">{g.tags.map((t) => <span key={t} className="ex-tag">#{t}</span>)}</span>
            </a>
          </li>
        ))}
      </ul>
    </div>
  );
}
```

- [ ] **Step 4: Run Gems test → green**

Run: `pnpm --filter @agentgem/marketplace test src/pages/Gems.test.tsx`
Expected: PASS.

- [ ] **Step 5: Update the Gem detail test for async + api + conditional Contains** — replace the body of `packages/marketplace/src/pages/Gem.test.tsx` with:

```tsx
import { describe, it, expect, afterEach, vi } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import { Gem } from "./Gem";

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
// Static fallback path: empty live list → STATIC_GEMS (which include brainstorming-kit with ingredients).
const apiEmpty = { getGems: () => Promise.resolve([]) } as never;
// Live path: one ingredient-less gem.
const apiLive = { getGems: () => Promise.resolve([{ key: "live-gem", version: "3.0.0", author: "acme", description: "d", tags: [], artifactKinds: ["mcp"] }]) } as never;

describe("Gem (detail)", () => {
  it("renders a fallback (static) gem with its Contains cross-links", async () => {
    render(<Gem api={apiEmpty} keyName="brainstorming-kit" />);
    expect(await screen.findByRole("heading", { name: /brainstorming-kit/ })).toBeTruthy();
    const link = screen.getByText("brainstorming").closest("a");
    expect(link?.getAttribute("href")).toBe("/ingredient/" + encodeURIComponent("skill:superpowers/brainstorming"));
  });

  it("renders a live (ingredient-less) gem with NO Contains section", async () => {
    render(<Gem api={apiLive} keyName="live-gem" />);
    expect(await screen.findByRole("heading", { name: /live-gem/ })).toBeTruthy();
    expect(screen.queryByText(/Contains/i)).toBeNull();
  });

  it("copy-key writes the key to the clipboard", async () => {
    const writeText = vi.fn(() => Promise.resolve());
    vi.stubGlobal("navigator", { clipboard: { writeText } });
    render(<Gem api={apiLive} keyName="live-gem" />);
    await screen.findByRole("heading", { name: /live-gem/ });
    fireEvent.click(screen.getByRole("button", { name: /copy/i }));
    expect(writeText).toHaveBeenCalledWith("live-gem");
  });

  it("shows a not-found state for an unknown key", async () => {
    render(<Gem api={apiEmpty} keyName="does-not-exist" />);
    expect(await screen.findByText(/gem not found/i)).toBeTruthy();
  });
});
```

- [ ] **Step 6: Run to verify it fails**

Run: `pnpm --filter @agentgem/marketplace test src/pages/Gem.test.tsx`
Expected: FAIL — `Gem` takes no `api` / isn't async.

- [ ] **Step 7: Rewrite `pages/Gem.tsx` (async + conditional Contains)**

```tsx
import { useEffect, useState } from "react";
import type { makeApi } from "../api";
import type { Gem as GemT } from "../gems/catalog";
import { loadGems, findGem } from "../gems/catalog";
import { prettifyId, kindLabel } from "../data";

export function Gem({ api, keyName }: { api: ReturnType<typeof makeApi>; keyName: string }) {
  const [gems, setGems] = useState<GemT[] | null>(null);
  useEffect(() => {
    let alive = true;
    loadGems(api).then((g) => { if (alive) setGems(g); });
    return () => { alive = false; };
  }, [api]);

  if (gems === null) return <div className="ex-gem-detail"><p className="ex-empty">Loading…</p></div>;
  const gem = findGem(gems, keyName);
  if (!gem) return <div className="ex-gem-detail"><p className="ex-empty">Gem not found: “{keyName}”.</p></div>;

  const copyKey = () => { void navigator.clipboard?.writeText(gem.key); };

  return (
    <div className="ex-gem-detail">
      <h2 className="ex-gem-title">{gem.key} <span className="ex-gem-version">v{gem.version}</span></h2>
      <p className="ex-gem-meta">
        {gem.author && <span>by {gem.author}</span>}
        {gem.artifactKinds.map((k) => <span key={k} className="ex-chip">{kindLabel(k)}</span>)}
      </p>
      <p className="ex-gem-desc">{gem.description}</p>
      <p className="ex-gem-tags">{gem.tags.map((t) => <span key={t} className="ex-tag">#{t}</span>)}</p>

      <section className="ex-card">
        <h3>Get this gem</h3>
        <p className="ex-getit">
          Gem key: <code className="ex-key">{gem.key}</code>
          <button type="button" className="ex-copy" onClick={copyKey}>Copy key</button>
        </p>
        <p className="ex-getit-steps">Open the AgentGem desktop console → <strong>Get Gems</strong> → search “{gem.key}” → <strong>Install</strong>.</p>
      </section>

      {gem.ingredients.length > 0 && (
        <section className="ex-card">
          <h3>Contains</h3>
          <ul className="ex-ingredients">
            {gem.ingredients.map((ing) => {
              const p = prettifyId(ing.id, ing.kind);
              return (
                <li key={ing.id}>
                  <a href={"/ingredient/" + encodeURIComponent(ing.id)} title={ing.id}>{p.name}</a>
                  <span className="ex-chip">{kindLabel(ing.kind)}</span>
                </li>
              );
            })}
          </ul>
        </section>
      )}
    </div>
  );
}
```

- [ ] **Step 8: Run Gem test → green**

Run: `pnpm --filter @agentgem/marketplace test src/pages/Gem.test.tsx`
Expected: PASS.

- [ ] **Step 9: Pass `api` to the gem routes in `Router.tsx`**

Change the two gem-route lines:
```tsx
  if (gemDetail) return <Gem keyName={decodeURIComponent(gemDetail[1])} />;
  if (path === "/gems") return <Gems />;
```
to:
```tsx
  if (gemDetail) return <Gem api={api} keyName={decodeURIComponent(gemDetail[1])} />;
  if (path === "/gems") return <Gems api={api} />;
```

- [ ] **Step 10: Update the Router gem-route tests** — in `packages/marketplace/src/Router.test.tsx`: add the import `import { STATIC_GEMS } from "./gems/catalog";` at the top, then replace the two existing gem cases (currently synchronous, no fetch stub) with these async versions (the pages now call `api.getGems()` → `fetch`; an empty `{ gems: [] }` → static fallback, so `github-flow`/`brainstorming-kit` resolve from `STATIC_GEMS`). Keep the existing `/` and `/ingredient/:id` cases unchanged:

```tsx
  it("renders the gem browse page at /gems", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => res({ gems: [] }))); // empty live list → static fallback
    window.history.pushState({}, "", "/gems");
    render(<Router api={makeApi("")} />);
    expect(await screen.findByText("brainstorming-kit")).toBeTruthy();
  });

  it("renders the gem detail page at /gems/:key with the decoded key", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => res({ gems: [] }))); // empty live list → static fallback
    window.history.pushState({}, "", "/gems/" + encodeURIComponent("github-flow"));
    render(<Router api={makeApi("")} />);
    expect(await screen.findByRole("heading", { name: /github-flow/ })).toBeTruthy();
  });
```
(The `STATIC_GEMS` import keeps it available if you prefer `STATIC_GEMS[0].key` over the literal; `brainstorming-kit` and `github-flow` are both in `STATIC_GEMS`.)

- [ ] **Step 11: Remove the now-unused static accessors** — in `packages/marketplace/src/gems/catalog.ts`, delete `listGems()` and `getGem()` (nothing imports them anymore — the pages use `loadGems`/`findGem`). Keep `STATIC_GEMS`, `loadGems`, `findGem`, `filterGems`, and the types. In `gems/catalog.test.ts`, remove the `listGems`/`getGem` test cases (keep `filterGems`, `loadGems`, `findGem`, and the `STATIC_GEMS` shape tests). Update the old `describe("catalog")` block that referenced `GEMS`/`listGems` to use `STATIC_GEMS`.

- [ ] **Step 12: Full marketplace gate**

Run: `pnpm --filter @agentgem/marketplace test && pnpm --filter @agentgem/marketplace typecheck && pnpm --filter @agentgem/marketplace build`
Expected: all tests pass, typecheck clean (no dangling `listGems`/`getGem` references), build writes `dist/`.

- [ ] **Step 13: Commit**

```bash
git add packages/marketplace/src/pages/Gems.tsx packages/marketplace/src/pages/Gems.test.tsx packages/marketplace/src/pages/Gem.tsx packages/marketplace/src/pages/Gem.test.tsx packages/marketplace/src/Router.tsx packages/marketplace/src/Router.test.tsx packages/marketplace/src/gems/catalog.ts packages/marketplace/src/gems/catalog.test.ts
git commit -m "feat(marketplace): gem pages fetch live catalog (async) with static fallback"
```

---

## Final verification

- [ ] **Backend suite** (compiled-dist): `pnpm test` (= `tsc -b && vitest run`) → green, including `publicCatalog`, `gem.controller`, `originGuard`.
- [ ] **Marketplace gate:** `pnpm --filter @agentgem/marketplace test && … typecheck && … build` → green.
- [ ] **Manual smoke (optional):** `pnpm --filter @agentgem/marketplace dev` with `VITE_API_BASE` pointing at a server where `AGENTGEM_REGISTRY_REPO` is unset → `/gems` shows the curated static gems (fallback) and a gem detail shows its Contains cross-links. (With a configured+populated registry, `/gems` would show live gems with no Contains.)
- [ ] **Deploy:** the marketplace ships on the `agentgem-explore` static rebuild; the API endpoint ships with the next `agentgem` Docker deploy. Live gems appear only once `AGENTGEM_REGISTRY_REPO` (+ optional `GITHUB_TOKEN`) is set on the hosted server and a registry is populated — until then the endpoint returns `{ gems: [] }` and the UI falls back to the curated catalog.
