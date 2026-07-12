# Offline-friendly marketplace miniapps — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make miniapps on `app.agentgem.ai` playable offline — the installed PWA opens offline, any game you've opened replays offline automatically, and games can be explicitly pinned ("Download for offline") with a managed library.

**Architecture:** Add a service worker via `vite-plugin-pwa` in `injectManifest` mode. Workbox precaches the hashed app shell (correct cache-busting on deploy). A hand-written fetch handler caches the one cross-origin `game-html` request in two caches: `games-pinned` (checked first, never evicted) and `games-recent` (StaleWhileRevalidate + a small LRU). Games are already self-contained (CSP `default-src 'none'`) and immutable per version, so caching that single JSON response makes the whole game work offline with no per-asset logic.

**Tech Stack:** React 19, Vite 8, Vitest 4, `vite-plugin-pwa@^1.3.0` + `workbox-build`/`workbox-window`/`workbox-precaching` (^7.4.1). All work is in `packages/marketplace`.

**Spec:** `docs/superpowers/specs/2026-07-11-offline-miniapps-design.md`

## Global Constraints

- **`packages/marketplace` has ZERO `@agentgem/*` dependencies** — keep it that way (external npm deps are fine).
- **Marketplace tests gate CI** (`test (24)`); every task ends green on `pnpm --filter @agentgem/marketplace test` and `pnpm --filter @agentgem/marketplace typecheck`.
- **`vite-plugin-pwa@1.3.0`** peer-supports `vite ^8.0.0` (verified). Required peers to install: `workbox-build`, `workbox-window` (both `^7.4.1`).
- **URL-identity invariant:** the URL `offline.pinGame` stores under MUST equal the URL `api.getGameHtml` fetches, so the SW serves a pin by request-URL match. Both go through `buildQs({ key, version })`. This is asserted by a test.
- **Games are immutable per (key, version)** — the version is in the URL, so a new version is a fresh cache entry; no manual game-cache invalidation.
- **The SW only ever runs in a production build** (`vite build`), never in dev or vitest; `useRegisterSW` is a no-op when no SW is registered.
- **Copy strings (verbatim):** update toast title `New version available`, button `Reload`; pin states `Download for offline` / `Downloading…` / `Available offline`, remove control `Remove`; offline banner `You're offline — only downloaded and recently-played games are available.`; unavailable-offline preview `Not available offline`.
- **fresh worktree:** run `pnpm install` at the repo root once (updates the lockfile for the new deps) before building. Under pnpm 11, if the install errors on an un-acknowledged build script (e.g. `esbuild` pulled by `workbox-build`), add it via the repo's `allowBuilds` mechanism; if it errors on the optional missing peer `@vite-pwa/assets-generator`, add it to `pnpm.peerDependencyRules.ignoreMissing`.

---

### Task 1: Install `vite-plugin-pwa`, precache the shell, add the update prompt

**Files:**
- Modify: `packages/marketplace/package.json` (devDependencies)
- Modify: `packages/marketplace/vite.config.ts`
- Create: `packages/marketplace/src/sw.ts`
- Create: `packages/marketplace/src/vite-env.d.ts`
- Create: `packages/marketplace/src/PwaUpdatePrompt.tsx`
- Modify: `packages/marketplace/src/App.tsx`
- Test: `packages/marketplace/src/PwaUpdatePrompt.test.tsx`

**Interfaces:**
- Consumes: nothing (first task).
- Produces: `sw.ts` (precache-only for now; Task 3 adds the game route), `<PwaUpdatePrompt />` React component (no props).

- [ ] **Step 1: Add the dev dependencies**

Edit `packages/marketplace/package.json` `devDependencies` (keep alphabetical grouping loose, matching the file):

```json
    "vite-plugin-pwa": "^1.3.0",
    "workbox-build": "^7.4.1",
    "workbox-precaching": "^7.4.1",
    "workbox-window": "^7.4.1",
```

Then from the repo root:

```bash
pnpm install
```

Expected: install succeeds and the lockfile updates. (If it errors, apply the pnpm-11 remedies in Global Constraints.)

- [ ] **Step 2: Configure the plugin in `vite.config.ts`**

Replace the file contents with:

```ts
import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import { VitePWA } from "vite-plugin-pwa";

export default defineConfig({
  plugins: [
    react(),
    VitePWA({
      // Keep the hand-authored public/manifest.webmanifest + its <link> in index.html.
      manifest: false,
      // We register via useRegisterSW in PwaUpdatePrompt, so don't auto-inject a registration script.
      injectRegister: false,
      // Hand-written SW (game routing needs pinned-first logic generateSW can't express).
      strategies: "injectManifest",
      srcDir: "src",
      filename: "sw.ts",
      registerType: "prompt",
      injectManifest: {
        globPatterns: ["**/*.{js,css,html,png,svg,webmanifest,woff2}"],
      },
    }),
  ],
  test: {
    environment: "jsdom",
    include: ["src/**/*.test.{ts,tsx}"],
    setupFiles: ["./src/test-setup.ts"],
    watch: false,
  },
});
```

- [ ] **Step 3: Create the service worker (precache only)**

Create `packages/marketplace/src/sw.ts`:

```ts
/// <reference lib="webworker" />
// The marketplace service worker. Built only by `vite build` (injectManifest); never runs in
// dev or vitest. For now it precaches the hashed app shell so the installed PWA opens offline.
// Task 3 adds the game-html fetch handler (pinned-first, then a recently-played LRU).
import { precacheAndRoute } from "workbox-precaching";

declare const self: ServiceWorkerGlobalScope & { __WB_MANIFEST: Array<{ url: string; revision: string | null }> };

// Workbox replaces self.__WB_MANIFEST at build time with the content-hashed asset list.
precacheAndRoute(self.__WB_MANIFEST);

// registerType:"prompt" — the new SW waits until the user accepts the reload toast, then we
// skipWaiting on their signal (PwaUpdatePrompt posts this message).
self.addEventListener("message", (event) => {
  if (event.data?.type === "SKIP_WAITING") self.skipWaiting();
});
```

- [ ] **Step 4: Add ambient types for the virtual modules**

Create `packages/marketplace/src/vite-env.d.ts`:

```ts
/// <reference types="vite/client" />
/// <reference types="vite-plugin-pwa/react" />
/// <reference types="vite-plugin-pwa/info" />
```

- [ ] **Step 5: Write the failing test for the update prompt**

Create `packages/marketplace/src/PwaUpdatePrompt.test.tsx`:

```tsx
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";

const updateServiceWorker = vi.fn();
let needRefresh = true;

// The virtual module is provided by vite-plugin-pwa at build time; mock it so the component
// is testable under plain vitest.
vi.mock("virtual:pwa-register/react", () => ({
  useRegisterSW: () => ({
    needRefresh: [needRefresh, vi.fn()],
    updateServiceWorker,
  }),
}));

import { PwaUpdatePrompt } from "./PwaUpdatePrompt";

describe("PwaUpdatePrompt", () => {
  beforeEach(() => { updateServiceWorker.mockClear(); needRefresh = true; });

  it("shows a Reload prompt when a new version is waiting", () => {
    render(<PwaUpdatePrompt />);
    expect(screen.getByText("New version available")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Reload" }));
    expect(updateServiceWorker).toHaveBeenCalledWith(true);
  });

  it("renders nothing when there is no update", () => {
    needRefresh = false;
    const { container } = render(<PwaUpdatePrompt />);
    expect(container.firstChild).toBeNull();
  });
});
```

- [ ] **Step 6: Run the test — verify it fails**

```bash
pnpm --filter @agentgem/marketplace test src/PwaUpdatePrompt.test.tsx
```

Expected: FAIL — cannot find `./PwaUpdatePrompt`.

- [ ] **Step 7: Implement the update prompt**

Create `packages/marketplace/src/PwaUpdatePrompt.tsx`:

```tsx
import { useRegisterSW } from "virtual:pwa-register/react";

// A small non-intrusive banner shown after a new deploy. registerType:"prompt" means the new
// service worker waits; clicking Reload calls updateServiceWorker(true), which activates it and
// reloads the page. We never auto-reload — that could interrupt a game mid-play.
export function PwaUpdatePrompt() {
  const { needRefresh: [needRefresh], updateServiceWorker } = useRegisterSW();
  if (!needRefresh) return null;
  return (
    <div className="ex-pwa-update" role="status">
      <span>New version available</span>
      <button type="button" onClick={() => updateServiceWorker(true)}>Reload</button>
    </div>
  );
}
```

- [ ] **Step 8: Run the test — verify it passes**

```bash
pnpm --filter @agentgem/marketplace test src/PwaUpdatePrompt.test.tsx
```

Expected: PASS (both cases).

- [ ] **Step 9: Mount the prompt in `App.tsx`**

In `packages/marketplace/src/App.tsx`, add the import near the other local imports:

```tsx
import { PwaUpdatePrompt } from "./PwaUpdatePrompt";
```

Then render it just inside the top-level wrapper, immediately after the opening `<div className="ex-app">`:

```tsx
    <div className="ex-app">
      <PwaUpdatePrompt />
      <header className="ex-header">
```

- [ ] **Step 10: Add banner styling**

Append to `packages/marketplace/src/styles.css`:

```css
.ex-pwa-update {
  position: fixed; inset-block-end: 16px; inset-inline-end: 16px; z-index: 2000;
  display: flex; align-items: center; gap: 12px;
  padding: 10px 14px; border-radius: 10px;
  background: var(--paper-raised, #20190f); color: #f1eadb;
  box-shadow: 0 6px 24px rgba(0,0,0,.28);
}
.ex-pwa-update button {
  border: 1px solid rgba(255,255,255,.3); background: transparent; color: inherit;
  padding: 4px 12px; border-radius: 8px; cursor: pointer; font: inherit;
}
```

- [ ] **Step 11: Typecheck, full test run, and verify the SW builds**

```bash
pnpm --filter @agentgem/marketplace typecheck
pnpm --filter @agentgem/marketplace test
pnpm --filter @agentgem/marketplace build
```

Expected: typecheck clean; all tests pass; build emits `dist/sw.js` and `dist/manifest.webmanifest`. Confirm:

```bash
ls packages/marketplace/dist/sw.js packages/marketplace/dist/manifest.webmanifest
```

- [ ] **Step 12: Commit**

```bash
git add packages/marketplace/package.json packages/marketplace/pnpm-lock.yaml pnpm-lock.yaml \
  packages/marketplace/vite.config.ts packages/marketplace/src/sw.ts \
  packages/marketplace/src/vite-env.d.ts packages/marketplace/src/PwaUpdatePrompt.tsx \
  packages/marketplace/src/PwaUpdatePrompt.test.tsx packages/marketplace/src/App.tsx \
  packages/marketplace/src/styles.css
git commit -m "feat(marketplace): service worker precaches the shell + update prompt"
```

(Only the lockfile that actually changed exists — drop whichever `pnpm-lock.yaml` path `git add` reports as missing.)

---

### Task 2: `gameHtmlUrl` helper + `offline.ts` pin store

**Files:**
- Modify: `packages/marketplace/src/api.ts`
- Create: `packages/marketplace/src/offline.ts`
- Test: `packages/marketplace/src/api.test.ts` (add one case)
- Test: `packages/marketplace/src/offline.test.ts`

**Interfaces:**
- Consumes: `buildQs` (private, in api.ts).
- Produces:
  - `gameHtmlUrl(base: string, key: string, version: string): string`
  - `interface PinnedGame { key: string; version: string; title: string; size: number; pinnedAt: number }`
  - `PINNED_CACHE = "games-pinned"` (exported const)
  - `pinGame(base: string, key: string, version: string, title: string): Promise<void>`
  - `unpinGame(base: string, key: string, version: string): Promise<void>`
  - `listPinned(): PinnedGame[]`
  - `isPinned(key: string, version: string): boolean`
  - `storageEstimate(): Promise<{ usage: number; quota: number } | null>`

- [ ] **Step 1: Write the failing URL-identity test in `api.test.ts`**

Add to `packages/marketplace/src/api.test.ts`:

```ts
import { gameHtmlUrl } from "./api";

it("gameHtmlUrl equals the URL getGameHtml fetches (cache-key identity)", async () => {
  const fetchMock = vi.fn(async () => new Response(JSON.stringify({ html: "<b>hi</b>" })));
  vi.stubGlobal("fetch", fetchMock);
  const api = makeApi("https://api.test");
  await api.getGameHtml("@acme/tetris", "1.2.0");
  const fetched = fetchMock.mock.calls[0][0] as string;
  expect(fetched).toBe(gameHtmlUrl("https://api.test", "@acme/tetris", "1.2.0"));
  vi.unstubAllGlobals();
});
```

(If `makeApi`/`vi` aren't already imported at the top of `api.test.ts`, add them — check the file header first.)

- [ ] **Step 2: Run it — verify it fails**

```bash
pnpm --filter @agentgem/marketplace test src/api.test.ts
```

Expected: FAIL — `gameHtmlUrl` is not exported.

- [ ] **Step 3: Add `gameHtmlUrl` to `api.ts`**

In `packages/marketplace/src/api.ts`, immediately after the `buildQs` function, add:

```ts
// The one game-html URL builder, shared by getGameHtml (below) and offline.pinGame, so the URL a
// pin is stored under is byte-identical to the URL the app fetches — the service worker serves a
// pinned game by request-URL match. Both sides route through buildQs({ key, version }).
export function gameHtmlUrl(base: string, key: string, version: string): string {
  return base + "/api/aggregator/game-html" + buildQs({ key, version });
}
```

- [ ] **Step 4: Run it — verify it passes**

```bash
pnpm --filter @agentgem/marketplace test src/api.test.ts
```

Expected: PASS. (`getGameHtml` still uses `get(...)` with the same `{ key, version }`, so the strings match.)

- [ ] **Step 5: Write the failing test for `offline.ts`**

Create `packages/marketplace/src/offline.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from "vitest";
import { pinGame, unpinGame, listPinned, isPinned, PINNED_CACHE } from "./offline";
import { gameHtmlUrl } from "./api";

// Minimal in-memory Cache Storage mock (only the methods offline.ts uses).
function installCachesMock() {
  const store = new Map<string, Map<string, Response>>();
  const cache = (name: string) => {
    if (!store.has(name)) store.set(name, new Map());
    const m = store.get(name)!;
    return {
      put: async (url: string, res: Response) => { m.set(url, res); },
      match: async (url: string) => m.get(url),
      delete: async (url: string) => m.delete(url),
      keys: async () => [...m.keys()].map((u) => new Request(u)),
    };
  };
  vi.stubGlobal("caches", { open: async (n: string) => cache(n) });
  return store;
}

const BASE = "https://api.test";

describe("offline pin store", () => {
  beforeEach(() => { localStorage.clear(); vi.unstubAllGlobals(); });

  it("pins a game: caches the html and records an index entry", async () => {
    const store = installCachesMock();
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ html: "<b>x</b>" }))));

    await pinGame(BASE, "@acme/tetris", "1.0.0", "Tetris");

    expect(isPinned("@acme/tetris", "1.0.0")).toBe(true);
    const list = listPinned();
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ key: "@acme/tetris", version: "1.0.0", title: "Tetris" });
    expect(list[0].size).toBeGreaterThan(0);
    // stored under the SAME url getGameHtml would fetch
    expect(store.get(PINNED_CACHE)!.has(gameHtmlUrl(BASE, "@acme/tetris", "1.0.0"))).toBe(true);
  });

  it("unpins: removes the cache entry and the index row", async () => {
    const store = installCachesMock();
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ html: "<b>x</b>" }))));
    await pinGame(BASE, "@acme/tetris", "1.0.0", "Tetris");

    await unpinGame(BASE, "@acme/tetris", "1.0.0");

    expect(isPinned("@acme/tetris", "1.0.0")).toBe(false);
    expect(listPinned()).toHaveLength(0);
    expect(store.get(PINNED_CACHE)!.size).toBe(0);
  });

  it("throws (and does not record) when the fetch fails", async () => {
    installCachesMock();
    vi.stubGlobal("fetch", vi.fn(async () => new Response("nope", { status: 404 })));
    await expect(pinGame(BASE, "@acme/x", "1.0.0", "X")).rejects.toThrow();
    expect(listPinned()).toHaveLength(0);
  });
});
```

- [ ] **Step 6: Run it — verify it fails**

```bash
pnpm --filter @agentgem/marketplace test src/offline.test.ts
```

Expected: FAIL — cannot find `./offline`.

- [ ] **Step 7: Implement `offline.ts`**

Create `packages/marketplace/src/offline.ts`:

```ts
// App-side offline pin store. "Download for offline" writes a game's html into a dedicated Cache
// Storage bucket the service worker checks first (and never evicts), plus a small localStorage index
// so the /offline library can list pins without walking Cache Storage. The URL a pin is stored under
// is gameHtmlUrl(...), identical to what api.getGameHtml fetches — that identity is what lets the SW
// serve a pinned game offline.
import { gameHtmlUrl } from "./api";

export const PINNED_CACHE = "games-pinned";
const INDEX_KEY = "games-pinned-index";

export interface PinnedGame {
  key: string;
  version: string;
  title: string;
  size: number;      // bytes of the html payload, for the storage readout
  pinnedAt: number;  // epoch ms
}

function readIndex(): PinnedGame[] {
  try {
    const raw = localStorage.getItem(INDEX_KEY);
    return raw ? (JSON.parse(raw) as PinnedGame[]) : [];
  } catch {
    return [];
  }
}

function writeIndex(list: PinnedGame[]): void {
  localStorage.setItem(INDEX_KEY, JSON.stringify(list));
}

export function listPinned(): PinnedGame[] {
  return readIndex();
}

export function isPinned(key: string, version: string): boolean {
  return readIndex().some((p) => p.key === key && p.version === version);
}

export async function pinGame(base: string, key: string, version: string, title: string): Promise<void> {
  const url = gameHtmlUrl(base, key, version);
  const res = await fetch(url);
  if (!res.ok) throw new Error(`pin ${key} -> ${res.status}`);
  const body = await res.clone().text();
  const cache = await caches.open(PINNED_CACHE);
  await cache.put(url, res);
  const size = new Blob([body]).size;
  const list = readIndex().filter((p) => !(p.key === key && p.version === version));
  list.push({ key, version, title, size, pinnedAt: Date.now() });
  writeIndex(list);
}

export async function unpinGame(base: string, key: string, version: string): Promise<void> {
  const cache = await caches.open(PINNED_CACHE);
  await cache.delete(gameHtmlUrl(base, key, version));
  writeIndex(readIndex().filter((p) => !(p.key === key && p.version === version)));
}

export async function storageEstimate(): Promise<{ usage: number; quota: number } | null> {
  if (!navigator.storage?.estimate) return null;
  const { usage = 0, quota = 0 } = await navigator.storage.estimate();
  return { usage, quota };
}
```

- [ ] **Step 8: Run both test files — verify they pass**

```bash
pnpm --filter @agentgem/marketplace test src/offline.test.ts src/api.test.ts
```

Expected: PASS.

- [ ] **Step 9: Typecheck + commit**

```bash
pnpm --filter @agentgem/marketplace typecheck
git add packages/marketplace/src/api.ts packages/marketplace/src/api.test.ts \
  packages/marketplace/src/offline.ts packages/marketplace/src/offline.test.ts
git commit -m "feat(marketplace): offline pin store + shared gameHtmlUrl builder"
```

---

### Task 3: Service-worker game-html routing (pinned-first → recent LRU)

**Files:**
- Create: `packages/marketplace/src/swCache.ts` (pure, testable logic)
- Modify: `packages/marketplace/src/sw.ts` (wire the fetch handler)
- Test: `packages/marketplace/src/swCache.test.ts`

**Interfaces:**
- Consumes: `PINNED_CACHE` const value `"games-pinned"` (re-declared here to avoid importing app code into the SW bundle; kept in sync by a test).
- Produces:
  - `RECENT_CACHE = "games-recent"`, `MAX_RECENT = 20`
  - `isGameHtmlRequest(url: URL): boolean`
  - `overLimit(keys: readonly Request[], limit: number): Request[]` (the entries to delete)

- [ ] **Step 1: Write the failing test for the pure helpers**

Create `packages/marketplace/src/swCache.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { isGameHtmlRequest, overLimit, MAX_RECENT } from "./swCache";
import { PINNED_CACHE } from "./offline";
import { PINNED_CACHE as SW_PINNED } from "./swCache";

describe("swCache", () => {
  it("matches only the game-html endpoint, any origin", () => {
    expect(isGameHtmlRequest(new URL("https://api.agentgem.ai/api/aggregator/game-html?key=x&version=1"))).toBe(true);
    expect(isGameHtmlRequest(new URL("https://api.agentgem.ai/api/aggregator/game-meta?key=x"))).toBe(false);
    expect(isGameHtmlRequest(new URL("https://app.agentgem.ai/gems/x"))).toBe(false);
  });

  it("overLimit returns the oldest entries beyond the cap (insertion order)", () => {
    const keys = Array.from({ length: MAX_RECENT + 3 }, (_, i) => new Request(`https://api.test/api/aggregator/game-html?key=${i}`));
    const evict = overLimit(keys, MAX_RECENT);
    expect(evict).toHaveLength(3);
    expect(evict[0].url).toContain("key=0");   // oldest first
    expect(overLimit(keys.slice(0, 5), MAX_RECENT)).toHaveLength(0);
  });

  it("pinned cache name stays in sync with the app-side store", () => {
    expect(SW_PINNED).toBe(PINNED_CACHE);
  });
});
```

- [ ] **Step 2: Run it — verify it fails**

```bash
pnpm --filter @agentgem/marketplace test src/swCache.test.ts
```

Expected: FAIL — cannot find `./swCache`.

- [ ] **Step 3: Implement `swCache.ts`**

Create `packages/marketplace/src/swCache.ts`:

```ts
// Pure, testable pieces of the service worker's game-html caching. Kept out of sw.ts (which imports
// workbox and touches `self`) so they can be unit-tested in jsdom. The cache names are the contract
// with offline.ts; swCache.test asserts PINNED_CACHE matches the app-side value.
export const PINNED_CACHE = "games-pinned";
export const RECENT_CACHE = "games-recent";
export const MAX_RECENT = 20;

const GAME_HTML_PATH = "/api/aggregator/game-html";

/** True for a GET of the game-html endpoint, on whatever origin the API is served from. */
export function isGameHtmlRequest(url: URL): boolean {
  return url.pathname === GAME_HTML_PATH;
}

/** Given cache keys in insertion (oldest-first) order, the entries to delete to honour `limit`. */
export function overLimit(keys: readonly Request[], limit: number): Request[] {
  return keys.slice(0, Math.max(0, keys.length - limit));
}
```

- [ ] **Step 4: Run it — verify it passes**

```bash
pnpm --filter @agentgem/marketplace test src/swCache.test.ts
```

Expected: PASS.

- [ ] **Step 5: Wire the fetch handler into `sw.ts`**

In `packages/marketplace/src/sw.ts`, add the import and the fetch handler. After the existing `import { precacheAndRoute } ...` line add:

```ts
import { isGameHtmlRequest, overLimit, PINNED_CACHE, RECENT_CACHE, MAX_RECENT } from "./swCache";
```

Then, after the `precacheAndRoute(self.__WB_MANIFEST);` line, add:

```ts
// Game html (cross-origin, from the API): pinned copy first (never evicted), else stale-while-
// revalidate into a small LRU. Serving by request URL works because offline.pinGame stored the
// pin under the identical gameHtmlUrl(...). Immutable per (key,version), so revalidation is cheap.
self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);
  if (event.request.method === "GET" && isGameHtmlRequest(url)) {
    event.respondWith(serveGame(event.request));
  }
});

async function serveGame(request: Request): Promise<Response> {
  const pinned = await caches.open(PINNED_CACHE);
  const pin = await pinned.match(request);
  if (pin) return pin;

  const recent = await caches.open(RECENT_CACHE);
  const cached = await recent.match(request);

  const fromNetwork = fetch(request)
    .then(async (res) => {
      if (res.ok) {
        await recent.put(request, res.clone());
        for (const k of overLimit(await recent.keys(), MAX_RECENT)) await recent.delete(k);
      }
      return res;
    })
    .catch(() => undefined);

  // Stale-while-revalidate: hand back the cached copy immediately (network updates in the
  // background); with no cache, wait for the network; offline with neither, a network error.
  if (cached) { void fromNetwork; return cached; }
  return (await fromNetwork) ?? Response.error();
}
```

- [ ] **Step 6: Typecheck, build, full test run**

```bash
pnpm --filter @agentgem/marketplace typecheck
pnpm --filter @agentgem/marketplace build
pnpm --filter @agentgem/marketplace test
```

Expected: typecheck clean; build emits `dist/sw.js` (now containing the fetch handler); all tests pass.

- [ ] **Step 7: Commit**

```bash
git add packages/marketplace/src/swCache.ts packages/marketplace/src/swCache.test.ts packages/marketplace/src/sw.ts
git commit -m "feat(marketplace): SW caches game html — pinned-first then recently-played LRU"
```

---

### Task 4: `OfflineToggle` component wired into the gem-detail page

**Files:**
- Create: `packages/marketplace/src/OfflineToggle.tsx`
- Modify: `packages/marketplace/src/pages/Gem.tsx`
- Test: `packages/marketplace/src/OfflineToggle.test.tsx`

**Interfaces:**
- Consumes: `pinGame`, `unpinGame`, `isPinned` (Task 2); `defaultApiBase` (api.ts).
- Produces: `<OfflineToggle gemKey={string} version={string} title={string} />`.

- [ ] **Step 1: Write the failing test**

Create `packages/marketplace/src/OfflineToggle.test.tsx`:

```tsx
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";

const pinGame = vi.fn(async () => {});
const unpinGame = vi.fn(async () => {});
let pinned = false;
vi.mock("./offline", () => ({
  pinGame: (...a: unknown[]) => pinGame(...a),
  unpinGame: (...a: unknown[]) => unpinGame(...a),
  isPinned: () => pinned,
}));

import { OfflineToggle } from "./OfflineToggle";

describe("OfflineToggle", () => {
  beforeEach(() => { pinGame.mockClear(); unpinGame.mockClear(); pinned = false; });

  it("downloads for offline, then shows the pinned state", async () => {
    render(<OfflineToggle gemKey="@a/t" version="1.0.0" title="T" />);
    fireEvent.click(screen.getByRole("button", { name: /download for offline/i }));
    expect(pinGame).toHaveBeenCalledWith(expect.any(String), "@a/t", "1.0.0", "T");
    await waitFor(() => expect(screen.getByText(/available offline/i)).toBeTruthy());
  });

  it("starts in the pinned state and removes on click", async () => {
    pinned = true;
    render(<OfflineToggle gemKey="@a/t" version="1.0.0" title="T" />);
    fireEvent.click(screen.getByRole("button", { name: /remove/i }));
    expect(unpinGame).toHaveBeenCalledWith(expect.any(String), "@a/t", "1.0.0");
    await waitFor(() => expect(screen.getByRole("button", { name: /download for offline/i })).toBeTruthy());
  });
});
```

- [ ] **Step 2: Run it — verify it fails**

```bash
pnpm --filter @agentgem/marketplace test src/OfflineToggle.test.tsx
```

Expected: FAIL — cannot find `./OfflineToggle`.

- [ ] **Step 3: Implement `OfflineToggle.tsx`**

Create `packages/marketplace/src/OfflineToggle.tsx`:

```tsx
import { useState } from "react";
import { defaultApiBase } from "./api";
import { pinGame, unpinGame, isPinned } from "./offline";

// "Download for offline" control on the gem-detail page. Pins the game's html into the SW's
// never-evicted cache so it plays with no connection; toggles back to remove. Errors surface inline
// (a failed download must not look like success).
export function OfflineToggle({ gemKey, version, title }: { gemKey: string; version: string; title: string }) {
  const [pinned, setPinned] = useState(() => isPinned(gemKey, version));
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(false);

  const download = async () => {
    setBusy(true); setErr(false);
    try { await pinGame(defaultApiBase(), gemKey, version, title); setPinned(true); }
    catch { setErr(true); }
    finally { setBusy(false); }
  };
  const remove = async () => {
    setBusy(true);
    try { await unpinGame(defaultApiBase(), gemKey, version); setPinned(false); }
    finally { setBusy(false); }
  };

  return (
    <span className="ex-offline-toggle">
      {pinned ? (
        <>
          <span className="ex-offline-badge">✓ Available offline</span>
          <button type="button" className="ex-linkbtn" disabled={busy} onClick={remove}>Remove</button>
        </>
      ) : (
        <button type="button" className="ex-navlink" disabled={busy} onClick={download}>
          {busy ? "Downloading…" : "Download for offline"}
        </button>
      )}
      {err && <span className="ex-error" role="alert">Download failed</span>}
    </span>
  );
}
```

- [ ] **Step 4: Run it — verify it passes**

```bash
pnpm --filter @agentgem/marketplace test src/OfflineToggle.test.tsx
```

Expected: PASS.

- [ ] **Step 5: Wire into `Gem.tsx`**

In `packages/marketplace/src/pages/Gem.tsx`, add the import near the `GamePreview` import (line ~10):

```tsx
import { OfflineToggle } from "../OfflineToggle";
```

Then, in the game-play section (the `gem.artifactKinds.includes("game")` block around line 120), add the toggle under the hint line:

```tsx
      {gem.artifactKinds.includes("game") && (
        <section className="ex-card ex-game-play">
          <h3>Play</h3>
          <div className="ex-game-stage"><GamePreview api={api} gemKey={gem.key} version={gem.version} /></div>
          <p className="ex-game-hint">Sealed and runs entirely in your browser — click to play fullscreen.</p>
          <OfflineToggle gemKey={gem.key} version={gem.version} title={gem.key} />
        </section>
      )}
```

- [ ] **Step 6: Add styling**

Append to `packages/marketplace/src/styles.css`:

```css
.ex-offline-toggle { display: inline-flex; align-items: center; gap: 10px; margin-block-start: 8px; }
.ex-offline-badge { font-size: 13px; opacity: .8; }
.ex-linkbtn { border: 0; background: none; color: var(--link, #7a5); cursor: pointer; font: inherit; padding: 0; text-decoration: underline; }
.ex-linkbtn:disabled { opacity: .5; cursor: default; }
```

- [ ] **Step 7: Typecheck + full test run + commit**

```bash
pnpm --filter @agentgem/marketplace typecheck
pnpm --filter @agentgem/marketplace test
git add packages/marketplace/src/OfflineToggle.tsx packages/marketplace/src/OfflineToggle.test.tsx \
  packages/marketplace/src/pages/Gem.tsx packages/marketplace/src/styles.css
git commit -m "feat(marketplace): Download-for-offline toggle on the gem page"
```

---

### Task 5: `/offline` library page + route + nav

**Files:**
- Create: `packages/marketplace/src/pages/Offline.tsx`
- Modify: `packages/marketplace/src/Router.tsx` (route + PANELS)
- Modify: `packages/marketplace/src/icons.tsx` (IconOffline)
- Modify: `packages/marketplace/src/App.tsx` (nav link)
- Test: `packages/marketplace/src/pages/Offline.test.tsx`

**Interfaces:**
- Consumes: `listPinned`, `unpinGame`, `storageEstimate` (Task 2); `defaultApiBase`.
- Produces: `<Offline />` page; route id `"offline"`.

- [ ] **Step 1: Write the failing test**

Create `packages/marketplace/src/pages/Offline.test.tsx`:

```tsx
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";

const unpinGame = vi.fn(async () => {});
let pins = [{ key: "@a/t", version: "1.0.0", title: "Tetris", size: 2048, pinnedAt: 1 }];
vi.mock("../offline", () => ({
  listPinned: () => pins,
  unpinGame: (...a: unknown[]) => unpinGame(...a),
  storageEstimate: async () => ({ usage: 2048, quota: 1_000_000 }),
}));

import { Offline } from "./Offline";

describe("Offline library", () => {
  beforeEach(() => { unpinGame.mockClear(); pins = [{ key: "@a/t", version: "1.0.0", title: "Tetris", size: 2048, pinnedAt: 1 }]; });

  it("lists pinned games with a remove control", () => {
    render(<Offline />);
    expect(screen.getByText("Tetris")).toBeTruthy();
    expect(screen.getByRole("button", { name: /remove/i })).toBeTruthy();
  });

  it("removes a pin on click", async () => {
    render(<Offline />);
    fireEvent.click(screen.getByRole("button", { name: /remove/i }));
    expect(unpinGame).toHaveBeenCalledWith(expect.any(String), "@a/t", "1.0.0");
    await waitFor(() => expect(screen.queryByText("Tetris")).toBeNull());
  });

  it("shows an empty state with no pins", () => {
    pins = [];
    render(<Offline />);
    expect(screen.getByText(/no games downloaded/i)).toBeTruthy();
  });
});
```

- [ ] **Step 2: Run it — verify it fails**

```bash
pnpm --filter @agentgem/marketplace test src/pages/Offline.test.tsx
```

Expected: FAIL — cannot find `./Offline`.

- [ ] **Step 3: Implement `pages/Offline.tsx`**

Create `packages/marketplace/src/pages/Offline.tsx`:

```tsx
import { useEffect, useState } from "react";
import { defaultApiBase } from "../api";
import { listPinned, unpinGame, storageEstimate, type PinnedGame } from "../offline";

function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

// The "Offline library": every game the reader downloaded for offline play, with sizes and a remove
// control, plus total storage used. Pins live in Cache Storage (served by the SW); this page reads the
// localStorage index that mirrors them.
export function Offline() {
  const [pins, setPins] = useState<PinnedGame[]>(() => listPinned());
  const [est, setEst] = useState<{ usage: number; quota: number } | null>(null);

  useEffect(() => { void storageEstimate().then(setEst); }, [pins]);

  const remove = async (p: PinnedGame) => {
    await unpinGame(defaultApiBase(), p.key, p.version);
    setPins(listPinned());
  };

  return (
    <div className="ex-offline-page">
      <h2 className="ex-section-title">Offline library</h2>
      {est && <p className="ex-gem-meta">Using {fmtBytes(est.usage)} of your browser's storage.</p>}
      {pins.length === 0 ? (
        <p className="ex-empty">No games downloaded yet. Open any game and choose “Download for offline”.</p>
      ) : (
        <ul className="ex-offline-list">
          {pins.map((p) => (
            <li key={`${p.key}@${p.version}`} className="ex-offline-row">
              <a href={`/gems/${encodeURIComponent(p.key)}`}>{p.title}</a>
              <span className="ex-gem-version">v{p.version}</span>
              <span className="ex-offline-size">{fmtBytes(p.size)}</span>
              <button type="button" className="ex-linkbtn" onClick={() => remove(p)}>Remove</button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
```

- [ ] **Step 4: Run it — verify it passes**

```bash
pnpm --filter @agentgem/marketplace test src/pages/Offline.test.tsx
```

Expected: PASS.

- [ ] **Step 5: Register the route in `Router.tsx`**

In `packages/marketplace/src/Router.tsx`, add the import with the other page imports:

```tsx
import { Offline } from "./pages/Offline";
```

Add the route to the `ROUTES` array, next to the other panels (e.g. after the `account` route):

```tsx
  { id: "offline", kind: "panel", match: (p) => p === "/offline", render: () => <Offline /> },
```

Add `"offline"` to the `PANELS` array so the conformance test passes:

```tsx
export const PANELS = ["publish", "account", "sources", "my-apps", "offline"];
```

- [ ] **Step 6: Add the nav icon**

In `packages/marketplace/src/icons.tsx`, add (Octicons `download-16`):

```tsx
export const IconOffline = () => (
  <Icon d="M2.75 14A1.75 1.75 0 0 1 1 12.25v-2.5a.75.75 0 0 1 1.5 0v2.5c0 .138.112.25.25.25h10.5a.25.25 0 0 0 .25-.25v-2.5a.75.75 0 0 1 1.5 0v2.5A1.75 1.75 0 0 1 13.25 14Zm4.72-4.72V2.75a.75.75 0 0 1 1.5 0v6.53l1.97-1.97a.749.749 0 1 1 1.06 1.06L8.53 11.53a.749.749 0 0 1-1.06 0L4.22 8.09a.749.749 0 1 1 1.06-1.06Z" />
);
```

- [ ] **Step 7: Add the nav link in `App.tsx`**

In `packages/marketplace/src/App.tsx`, extend the icon import to include `IconOffline`:

```tsx
import { IconMiniapps, IconIngredients, IconGems, IconSources, IconPublish, IconMyApps, IconOffline } from "./icons";
```

Add an active-path flag next to the others (near `const onSources = ...`):

```tsx
  const onOffline = path.startsWith("/offline");
```

Add the nav link after the Sources link (visible to everyone, signed in or not):

```tsx
          <a href="/offline" className={"ex-navlink" + (onOffline ? " is-active" : "")}><IconOffline />Offline</a>
```

- [ ] **Step 8: Add styling**

Append to `packages/marketplace/src/styles.css`:

```css
.ex-offline-list { list-style: none; padding: 0; margin: 12px 0; }
.ex-offline-row { display: flex; align-items: center; gap: 12px; padding: 8px 0; border-block-end: 1px solid var(--rule, rgba(0,0,0,.08)); }
.ex-offline-size { margin-inline-start: auto; opacity: .7; font-size: 13px; }
```

- [ ] **Step 9: Typecheck + full test run (incl. conformance) + commit**

```bash
pnpm --filter @agentgem/marketplace typecheck
pnpm --filter @agentgem/marketplace test
```

Expected: all pass, including `Router.conformance.test.tsx` (the new panel is in `PANELS`).

```bash
git add packages/marketplace/src/pages/Offline.tsx packages/marketplace/src/pages/Offline.test.tsx \
  packages/marketplace/src/Router.tsx packages/marketplace/src/icons.tsx packages/marketplace/src/App.tsx \
  packages/marketplace/src/styles.css
git commit -m "feat(marketplace): /offline library page + nav entry"
```

---

### Task 6: Offline banner + "Not available offline" preview copy

**Files:**
- Create: `packages/marketplace/src/useOnline.ts`
- Modify: `packages/marketplace/src/App.tsx` (banner)
- Modify: `packages/marketplace/src/GamePreview.tsx` (offline error copy)
- Test: `packages/marketplace/src/useOnline.test.ts`
- Test: `packages/marketplace/src/GamePreview.test.tsx` (add one case)

**Interfaces:**
- Consumes: nothing new.
- Produces: `useOnline(): boolean`.

- [ ] **Step 1: Write the failing test for `useOnline`**

Create `packages/marketplace/src/useOnline.test.ts`:

```ts
import { describe, it, expect, act } from "vitest";
import { renderHook } from "@testing-library/react";
import { useOnline } from "./useOnline";

describe("useOnline", () => {
  it("tracks online/offline events", () => {
    const { result } = renderHook(() => useOnline());
    expect(result.current).toBe(true);
    act(() => { Object.defineProperty(navigator, "onLine", { value: false, configurable: true }); window.dispatchEvent(new Event("offline")); });
    expect(result.current).toBe(false);
    act(() => { Object.defineProperty(navigator, "onLine", { value: true, configurable: true }); window.dispatchEvent(new Event("online")); });
    expect(result.current).toBe(true);
  });
});
```

(If `act` isn't exported from `vitest` in this version, import it from `react` instead: `import { act } from "react";`.)

- [ ] **Step 2: Run it — verify it fails**

```bash
pnpm --filter @agentgem/marketplace test src/useOnline.test.ts
```

Expected: FAIL — cannot find `./useOnline`.

- [ ] **Step 3: Implement `useOnline.ts`**

Create `packages/marketplace/src/useOnline.ts`:

```ts
import { useSyncExternalStore } from "react";

// Reactive navigator.onLine. Mirrors nav.ts's useSyncExternalStore idiom. SSR-safe getServerSnapshot
// returns true (assume online) though this SPA never server-renders.
function subscribe(cb: () => void): () => void {
  window.addEventListener("online", cb);
  window.addEventListener("offline", cb);
  return () => { window.removeEventListener("online", cb); window.removeEventListener("offline", cb); };
}

export function useOnline(): boolean {
  return useSyncExternalStore(subscribe, () => navigator.onLine, () => true);
}
```

- [ ] **Step 4: Run it — verify it passes**

```bash
pnpm --filter @agentgem/marketplace test src/useOnline.test.ts
```

Expected: PASS.

- [ ] **Step 5: Show the banner in `App.tsx`**

In `packages/marketplace/src/App.tsx`, add the import:

```tsx
import { useOnline } from "./useOnline";
```

Inside `App`, add the hook near the other state:

```tsx
  const online = useOnline();
```

Render the banner directly under `<PwaUpdatePrompt />`:

```tsx
      <PwaUpdatePrompt />
      {!online && <p className="ex-offline-banner" role="status">You're offline — only downloaded and recently-played games are available.</p>}
```

- [ ] **Step 6: Add banner styling**

Append to `packages/marketplace/src/styles.css`:

```css
.ex-offline-banner { margin: 0; padding: 8px 24px; text-align: center; background: var(--paper-raised, #efe6d2); font-size: 14px; }
```

- [ ] **Step 7: Add the failing "offline" case to `GamePreview.test.tsx`**

Add to `packages/marketplace/src/GamePreview.test.tsx` (match the file's existing render/mock setup — inspect its top first):

```tsx
it("shows 'Not available offline' when the html fetch fails while offline", async () => {
  Object.defineProperty(navigator, "onLine", { value: false, configurable: true });
  const api = { getGameHtml: vi.fn(async () => { throw new Error("offline"); }), recordPlay: vi.fn() } as unknown as ReturnType<typeof makeApi>;
  render(<GamePreview api={api} gemKey="@a/t" version="1.0.0" />);
  expect(await screen.findByText("Not available offline")).toBeTruthy();
  Object.defineProperty(navigator, "onLine", { value: true, configurable: true });
});
```

- [ ] **Step 8: Run it — verify it fails**

```bash
pnpm --filter @agentgem/marketplace test src/GamePreview.test.tsx
```

Expected: FAIL — the placeholder currently reads `preview unavailable`, not `Not available offline`.

- [ ] **Step 9: Make the placeholder offline-aware in `GamePreview.tsx`**

In `packages/marketplace/src/GamePreview.tsx`, add the import:

```tsx
import { useOnline } from "./useOnline";
```

Inside the component, add:

```tsx
  const online = useOnline();
```

Change the placeholder span so the error copy reflects being offline:

```tsx
        {html
          ? <GamePlayer html={html} interactive={false} />
          : <span className="gp-ph">{err ? (online ? "preview unavailable" : "Not available offline") : "loading…"}</span>}
```

- [ ] **Step 10: Run it — verify it passes**

```bash
pnpm --filter @agentgem/marketplace test src/GamePreview.test.tsx
```

Expected: PASS.

- [ ] **Step 11: Typecheck + full test run + commit**

```bash
pnpm --filter @agentgem/marketplace typecheck
pnpm --filter @agentgem/marketplace test
git add packages/marketplace/src/useOnline.ts packages/marketplace/src/useOnline.test.ts \
  packages/marketplace/src/App.tsx packages/marketplace/src/GamePreview.tsx \
  packages/marketplace/src/GamePreview.test.tsx packages/marketplace/src/styles.css
git commit -m "feat(marketplace): offline banner + offline-aware game preview copy"
```

---

### Task 7: OG worker never intercepts `/sw.js`

**Files:**
- Modify: `packages/marketplace/src/worker.test.ts` (add one guard case)

**Interfaces:**
- Consumes: the existing `worker.test.ts` harness (`makeEnv`, `req`, `SHELL`, `worker`).
- Produces: nothing.

- [ ] **Step 1: Add the failing guard test**

In `packages/marketplace/src/worker.test.ts`, next to the `/manifest.webmanifest` case (~line 68), add — matching the exact local helper names used there (inspect them first; below assumes `req` and the per-test env builder used by the manifest case):

```ts
  it("passes /sw.js straight to ASSETS (no OG injection, no meta fetch)", async () => {
    const e = makeEnv();
    const res = await worker.fetch(req("/sw.js"), e);
    expect(e.ASSETS.fetch).toHaveBeenCalledOnce();
    expect(await res.text()).toBe(SHELL);
  });
```

(Use whatever the file names its env factory and request helper — mirror the `/manifest.webmanifest` test one line above exactly.)

- [ ] **Step 2: Run it — verify it passes immediately**

```bash
pnpm --filter @agentgem/marketplace test src/worker.test.ts
```

Expected: PASS on the first run — the worker already only rewrites `GET /games/<key>`, so `/sw.js` falls through. This is a **characterization/guard test** that locks the behavior in (a future worker change that broke SW delivery would fail here). It is deliberately green from the start, so there is no red phase.

- [ ] **Step 3: Commit**

```bash
git add packages/marketplace/src/worker.test.ts
git commit -m "test(marketplace): guard that the OG worker never intercepts /sw.js"
```

---

## Final verification (after all tasks)

- [ ] Full suite + typecheck + build:

```bash
pnpm --filter @agentgem/marketplace typecheck
pnpm --filter @agentgem/marketplace test
pnpm --filter @agentgem/marketplace build
ls packages/marketplace/dist/sw.js
```

- [ ] Manual offline smoke test (Chrome): `pnpm --filter @agentgem/marketplace preview`, open the app, play a game, then DevTools → Application → Service Workers (confirm registered) → Network → Offline → reload → the played game still plays; a never-opened game shows "Not available offline"; the offline banner shows; `/offline` lists any pinned game.

- [ ] Integrate via PR off this `offline-miniapps` branch; CI gate is `test (24)`.

## Self-review notes

- **Spec coverage:** shell precache (T1), automatic recently-played LRU (T3), explicit pin + store (T2, T4), offline library (T5), offline banner + unavailable copy (T6), worker coexistence (T7). All spec sections map to a task.
- **URL-identity invariant** is enforced by the api.test.ts identity case (T2 S1) and the SW/app cache-name sync check (T3 S1).
- **Non-goals** (private games, "newer version" prompts, offline catalog browsing, offline fonts) are intentionally untouched.
- **Type consistency:** `PINNED_CACHE` is defined in `offline.ts` and re-declared in `swCache.ts` with a test asserting equality; `PinnedGame` shape is shared via import; `gameHtmlUrl` signature is identical across `api.ts`, `offline.ts`, and tests.
