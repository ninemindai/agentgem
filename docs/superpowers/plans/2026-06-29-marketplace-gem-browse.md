# Marketplace Gem-Browse (M1.5) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add public **gem browse** (`/gems`) and **gem detail** (`/gems/:key`) pages to the marketplace, backed by a curated static catalog, with each gem's ingredients cross-linking to the live M1 ingredient pages.

**Architecture:** Pure frontend addition to `packages/marketplace`. A bundled static catalog (`gems/catalog.ts`) sits behind a `listGems`/`getGem`/`filterGems` accessor seam (mirroring M1's `makeApi`), so a live registry API drops in later without touching the pages. Two new pages reuse M1's brand shell, the global `<a>` SPA-nav interception, `prettifyId`/`kindLabel`, and `styles.css`. The router and header nav gain the two new routes + an Ingredients↔Gems toggle.

**Tech Stack:** Vite + React 19 + TypeScript (ESM, bundler resolution → **extensionless imports**), Vitest + jsdom (`@agentgem/marketplace`). Tests run on `src` directly.

## Global Constraints

- Package `@agentgem/marketplace`; run scripts via `pnpm --filter @agentgem/marketplace <script>` (`test`, `typecheck`, `build`).
- **Extensionless imports** (e.g. `from "../gems/catalog"`, `from "./pages/Gems"`) — match the existing marketplace files; never add `.js`.
- Tests: Vitest + jsdom; assert with `.toBeTruthy()` / `.toBeNull()` (NOT jest-dom); stub globals with `vi.stubGlobal`. Match M1's existing test style.
- No backend, no `fetch`, no API base for gem data — the catalog is static and synchronous. (Ingredient cross-links navigate into M1's `Ingredient` page, which fetches on its own.)
- Honest get-it affordance: show the gem **key** + the real console path; do NOT render an `agentgem add` command (it doesn't exist).
- Reuse M1 helpers; do not duplicate `prettifyId`/`kindLabel`.

## File structure

```
packages/marketplace/src/
  gems/
    catalog.ts        CREATE  Gem/GemIngredient types, GEMS seed, listGems/getGem/filterGems
    catalog.test.ts   CREATE
  pages/
    Gems.tsx          CREATE  browse: searchable list of gem cards
    Gems.test.tsx     CREATE
    Gem.tsx           CREATE  detail: fields + copy-key + Contains ingredient links + not-found
    Gem.test.tsx      CREATE
  Router.tsx          MODIFY  add /gems/:key and /gems routes
  Router.test.tsx     MODIFY  add gem-route cases
  App.tsx             MODIFY  Ingredients↔Gems nav toggle + active state
  App.test.tsx        MODIFY  assert the nav links
  styles.css          MODIFY  append nav + gem-card + detail styles (not asserted by tests)
```

---

### Task 1: Static catalog + accessors

**Files:**
- Create: `packages/marketplace/src/gems/catalog.ts`, `packages/marketplace/src/gems/catalog.test.ts`

**Interfaces:**
- Produces:
  - `interface GemIngredient { id: string; kind: string }`
  - `interface Gem { key: string; version: string; author?: string; description: string; tags: string[]; artifactKinds: string[]; ingredients: GemIngredient[] }`
  - `GEMS: Gem[]` (the seed)
  - `listGems(): Gem[]` — returns all gems
  - `getGem(key: string): Gem | undefined`
  - `filterGems(gems: Gem[], query: string): Gem[]` — case-insensitive over key + description + tags; returns all on blank/whitespace.

- [ ] **Step 1: Write the failing test**

`packages/marketplace/src/gems/catalog.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { GEMS, listGems, getGem, filterGems } from "./catalog";

describe("catalog", () => {
  it("listGems returns the seed (non-empty, unique keys)", () => {
    const gems = listGems();
    expect(gems.length).toBeGreaterThan(0);
    expect(new Set(gems.map((g) => g.key)).size).toBe(gems.length);
    expect(gems).toEqual(GEMS);
  });

  it("every gem has real-shaped ingredient ids (kind-prefixed)", () => {
    for (const g of GEMS) {
      expect(g.ingredients.length).toBeGreaterThan(0);
      for (const ing of g.ingredients) expect(ing.id.includes(":")).toBe(true);
    }
  });

  it("getGem hits and misses", () => {
    expect(getGem("brainstorming-kit")?.key).toBe("brainstorming-kit");
    expect(getGem("nope")).toBeUndefined();
  });

  it("filterGems matches key/description/tags case-insensitively, all on blank", () => {
    expect(filterGems(GEMS, "   ")).toEqual(GEMS);
    expect(filterGems(GEMS, "BRAINSTORM").some((g) => g.key === "brainstorming-kit")).toBe(true);
    expect(filterGems(GEMS, "github").some((g) => g.tags.includes("github") || g.key.includes("github"))).toBe(true);
    expect(filterGems(GEMS, "zzzznomatch")).toEqual([]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @agentgem/marketplace test src/gems/catalog.test.ts`
Expected: FAIL — `./catalog` not found.

- [ ] **Step 3: Create `packages/marketplace/src/gems/catalog.ts`**

```ts
/** Curated static gem catalog. Shaped to mirror the eventual registry API, behind a small accessor
 *  seam (listGems/getGem) so a live source can drop in here without touching the pages. */

export interface GemIngredient {
  id: string;   // an aggregator ingredient id, e.g. "skill:superpowers/brainstorming" or "npx:@scope/pkg"
  kind: string; // "skill" | "mcp" | …
}

export interface Gem {
  key: string;            // unique, url-safe (e.g. "brainstorming-kit")
  version: string;        // e.g. "1.2.0"
  author?: string;
  description: string;
  tags: string[];
  artifactKinds: string[];      // e.g. ["skill","mcp"] — chip row
  ingredients: GemIngredient[]; // bundled ingredients; ids match aggregator ids for cross-linking
}

export const GEMS: Gem[] = [
  {
    key: "brainstorming-kit", version: "1.2.0", author: "superpowers",
    description: "Turn rough ideas into approved specs through guided dialogue, then into bite-sized implementation plans.",
    tags: ["planning", "specs", "workflow"],
    artifactKinds: ["skill"],
    ingredients: [
      { id: "skill:superpowers/brainstorming", kind: "skill" },
      { id: "skill:superpowers/writing-plans", kind: "skill" },
    ],
  },
  {
    key: "tdd-starter", version: "0.9.1", author: "superpowers",
    description: "Red-green-refactor discipline: write the failing test first, make it pass, keep the suite honest.",
    tags: ["testing", "tdd", "quality"],
    artifactKinds: ["skill"],
    ingredients: [
      { id: "skill:superpowers/test-driven-development", kind: "skill" },
      { id: "skill:superpowers/writing-plans", kind: "skill" },
    ],
  },
  {
    key: "debugging-pro", version: "1.0.0", author: "superpowers",
    description: "Systematic debugging — reproduce, isolate, root-cause, and verify the fix instead of guessing.",
    tags: ["debugging", "workflow"],
    artifactKinds: ["skill"],
    ingredients: [
      { id: "skill:superpowers/systematic-debugging", kind: "skill" },
    ],
  },
  {
    key: "github-flow", version: "2.1.0", author: "ninemind",
    description: "Drive GitHub from your agent: issues, PRs, reviews, and releases via the official MCP server.",
    tags: ["github", "mcp", "git"],
    artifactKinds: ["mcp"],
    ingredients: [
      { id: "npx:@modelcontextprotocol/server-github", kind: "mcp" },
    ],
  },
  {
    key: "ship-it", version: "1.4.0", author: "ninemind",
    description: "From feature branch to merged: plan, implement with subagents, review, and finish the branch cleanly.",
    tags: ["workflow", "review", "git"],
    artifactKinds: ["skill"],
    ingredients: [
      { id: "skill:superpowers/subagent-driven-development", kind: "skill" },
      { id: "skill:superpowers/requesting-code-review", kind: "skill" },
      { id: "skill:superpowers/finishing-a-development-branch", kind: "skill" },
    ],
  },
  {
    key: "browser-pilot", version: "0.6.2", author: "community",
    description: "Drive a real browser over CDP — screenshots, clicks, and DOM reads — for end-to-end web tasks.",
    tags: ["browser", "automation", "mcp"],
    artifactKinds: ["mcp"],
    ingredients: [
      { id: "npx:@playwright/mcp", kind: "mcp" },
    ],
  },
  {
    key: "fullstack-starter", version: "1.1.0", author: "ninemind",
    description: "A batteries-included bundle: planning, TDD, debugging, and GitHub — everything to ship a feature.",
    tags: ["bundle", "workflow", "starter"],
    artifactKinds: ["skill", "mcp"],
    ingredients: [
      { id: "skill:superpowers/brainstorming", kind: "skill" },
      { id: "skill:superpowers/test-driven-development", kind: "skill" },
      { id: "skill:superpowers/systematic-debugging", kind: "skill" },
      { id: "npx:@modelcontextprotocol/server-github", kind: "mcp" },
    ],
  },
];

export function listGems(): Gem[] { return GEMS; }

export function getGem(key: string): Gem | undefined { return GEMS.find((g) => g.key === key); }

/** Case-insensitive substring match over key + description + tags; all gems on blank. */
export function filterGems(gems: Gem[], query: string): Gem[] {
  const q = query.trim().toLowerCase();
  if (q === "") return gems;
  return gems.filter(
    (g) =>
      g.key.toLowerCase().includes(q) ||
      g.description.toLowerCase().includes(q) ||
      g.tags.some((t) => t.toLowerCase().includes(q)),
  );
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @agentgem/marketplace test src/gems/catalog.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/marketplace/src/gems/catalog.ts packages/marketplace/src/gems/catalog.test.ts
git commit -m "feat(marketplace): static gem catalog + listGems/getGem/filterGems"
```

---

### Task 2: Browse page (`/gems`)

**Files:**
- Create: `packages/marketplace/src/pages/Gems.tsx`, `packages/marketplace/src/pages/Gems.test.tsx`
- Modify: `packages/marketplace/src/styles.css`

**Interfaces:**
- Consumes: `listGems`, `filterGems`, `Gem` (Task 1); `kindLabel` (existing `data.ts`).
- Produces: `Gems()` — a React component (no props; reads the static catalog). Cards link to `/gems/<encodeURIComponent(key)>`.

- [ ] **Step 1: Write the failing test**

`packages/marketplace/src/pages/Gems.test.tsx`:
```tsx
import { describe, it, expect, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import { Gems } from "./Gems";

afterEach(() => cleanup());

describe("Gems (browse)", () => {
  it("renders gem cards from the catalog", () => {
    render(<Gems />);
    expect(screen.getByText("brainstorming-kit")).toBeTruthy();
    expect(screen.getByText("github-flow")).toBeTruthy();
  });

  it("a card links to the gem detail page (encoded key)", () => {
    render(<Gems />);
    const link = screen.getByText("brainstorming-kit").closest("a");
    expect(link?.getAttribute("href")).toBe("/gems/" + encodeURIComponent("brainstorming-kit"));
  });

  it("search narrows the list", () => {
    render(<Gems />);
    fireEvent.change(screen.getByLabelText("search gems"), { target: { value: "github" } });
    expect(screen.getByText("github-flow")).toBeTruthy();
    expect(screen.queryByText("brainstorming-kit")).toBeNull();
  });

  it("shows a no-match state", () => {
    render(<Gems />);
    fireEvent.change(screen.getByLabelText("search gems"), { target: { value: "zzzznomatch" } });
    expect(screen.getByText(/no gems match/i)).toBeTruthy();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @agentgem/marketplace test src/pages/Gems.test.tsx`
Expected: FAIL — `./Gems` not found.

- [ ] **Step 3: Create `packages/marketplace/src/pages/Gems.tsx`**

```tsx
import { useState } from "react";
import { listGems, filterGems } from "../gems/catalog";
import { kindLabel } from "../data";

export function Gems() {
  const [search, setSearch] = useState("");
  const gems = listGems();
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

- [ ] **Step 4: Append browse styles to `packages/marketplace/src/styles.css`** (not asserted by tests; keep minimal)

```css
.ex-gem-list { list-style: none; padding: 0; margin: 0; display: grid; gap: 10px; }
.ex-gem-card { display: grid; gap: 4px; padding: 12px; border: 1px solid #e5e0d8; border-radius: 8px; text-decoration: none; color: inherit; }
.ex-gem-card:hover { border-color: #b4543a; }
.ex-gem-head { display: flex; justify-content: space-between; align-items: baseline; gap: 8px; }
.ex-gem-key { font-weight: 600; }
.ex-gem-desc { color: #444; font-size: .92em; }
.ex-gem-tags, .ex-gem-kinds { display: flex; gap: 6px; flex-wrap: wrap; }
.ex-tag { color: #888; font-size: .8em; }
.ex-chip { background: #efe9df; border-radius: 4px; padding: 1px 6px; font-size: .75em; }
```

- [ ] **Step 5: Run test to verify it passes**

Run: `pnpm --filter @agentgem/marketplace test src/pages/Gems.test.tsx`
Expected: PASS (4 tests).

- [ ] **Step 6: Commit**

```bash
git add packages/marketplace/src/pages/Gems.tsx packages/marketplace/src/pages/Gems.test.tsx packages/marketplace/src/styles.css
git commit -m "feat(marketplace): gem browse page (searchable card list)"
```

---

### Task 3: Detail page (`/gems/:key`)

**Files:**
- Create: `packages/marketplace/src/pages/Gem.tsx`, `packages/marketplace/src/pages/Gem.test.tsx`
- Modify: `packages/marketplace/src/styles.css`

**Interfaces:**
- Consumes: `getGem`, `Gem` (Task 1); `prettifyId`, `kindLabel` (existing `data.ts`).
- Produces: `Gem({ keyName }: { keyName: string })` — looks up `getGem(keyName)`; renders the detail, or a not-found state. Ingredient rows link to `/ingredient/<encodeURIComponent(id)>`. A copy button calls `navigator.clipboard?.writeText(g.key)`.

- [ ] **Step 1: Write the failing test**

`packages/marketplace/src/pages/Gem.test.tsx`:
```tsx
import { describe, it, expect, afterEach, vi } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import { Gem } from "./Gem";

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe("Gem (detail)", () => {
  it("renders a known gem's fields + kind chips", () => {
    render(<Gem keyName="brainstorming-kit" />);
    expect(screen.getByText("brainstorming-kit")).toBeTruthy();
    expect(screen.getByText(/1\.2\.0/)).toBeTruthy();
    expect(screen.getByText(/superpowers/)).toBeTruthy();
  });

  it("lists bundled ingredients, each linking to its ingredient page (encoded id)", () => {
    render(<Gem keyName="brainstorming-kit" />);
    const link = screen.getByText("brainstorming").closest("a");
    expect(link?.getAttribute("href")).toBe("/ingredient/" + encodeURIComponent("skill:superpowers/brainstorming"));
  });

  it("copy-key writes the key to the clipboard", () => {
    const writeText = vi.fn(() => Promise.resolve());
    vi.stubGlobal("navigator", { clipboard: { writeText } });
    render(<Gem keyName="brainstorming-kit" />);
    fireEvent.click(screen.getByRole("button", { name: /copy/i }));
    expect(writeText).toHaveBeenCalledWith("brainstorming-kit");
  });

  it("shows a not-found state for an unknown key", () => {
    render(<Gem keyName="does-not-exist" />);
    expect(screen.getByText(/gem not found/i)).toBeTruthy();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @agentgem/marketplace test src/pages/Gem.test.tsx`
Expected: FAIL — `./Gem` not found.

- [ ] **Step 3: Create `packages/marketplace/src/pages/Gem.tsx`**

```tsx
import { getGem } from "../gems/catalog";
import { prettifyId, kindLabel } from "../data";

export function Gem({ keyName }: { keyName: string }) {
  const gem = getGem(keyName);
  if (!gem) {
    return <div className="ex-gem-detail"><p className="ex-empty">Gem not found: “{keyName}”.</p></div>;
  }

  const copyKey = () => { void navigator.clipboard?.writeText(gem.key); };

  return (
    <div className="ex-gem-detail">
      <h2 className="ex-gem-title">
        {gem.key} <span className="ex-gem-version">v{gem.version}</span>
      </h2>
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
          <button type="button" className="ex-copy" onClick={copyKey} aria-label="copy gem key">Copy</button>
        </p>
        <p className="ex-getit-steps">Open the AgentGem desktop console → <strong>Get Gems</strong> → search “{gem.key}” → <strong>Install</strong>.</p>
      </section>

      <section className="ex-card">
        <h3>Contains</h3>
        <ul className="ex-ingredients">
          {gem.ingredients.map((ing) => {
            const p = prettifyId(ing.id, ing.kind);
            return (
              <li key={ing.id}>
                <a href={"/ingredient/" + encodeURIComponent(ing.id)}>
                  {p.name}{p.scope && <span className="ex-scope">{p.scope}</span>}
                </a>
                <span className="ex-chip">{kindLabel(ing.kind)}</span>
              </li>
            );
          })}
        </ul>
      </section>
    </div>
  );
}
```

- [ ] **Step 4: Append detail styles to `packages/marketplace/src/styles.css`** (minimal)

```css
.ex-gem-title { margin-bottom: 2px; }
.ex-gem-version { color: #888; font-size: .7em; font-weight: 400; }
.ex-gem-meta { display: flex; gap: 8px; align-items: center; color: #666; font-size: .9em; }
.ex-getit { display: flex; gap: 8px; align-items: center; }
.ex-key { background: #f3efe8; padding: 2px 6px; border-radius: 4px; }
.ex-copy { cursor: pointer; border: 1px solid #ddd; border-radius: 4px; background: #fff; padding: 2px 8px; }
.ex-getit-steps { color: #555; font-size: .9em; }
.ex-ingredients { list-style: none; padding: 0; margin: 0; }
.ex-ingredients li { display: flex; gap: 8px; align-items: center; padding: 4px 0; }
```

- [ ] **Step 5: Run test to verify it passes**

Run: `pnpm --filter @agentgem/marketplace test src/pages/Gem.test.tsx`
Expected: PASS (4 tests). No `act()` warnings.

- [ ] **Step 6: Commit**

```bash
git add packages/marketplace/src/pages/Gem.tsx packages/marketplace/src/pages/Gem.test.tsx packages/marketplace/src/styles.css
git commit -m "feat(marketplace): gem detail page (copy key + ingredient cross-links)"
```

---

### Task 4: Router routes + header nav

**Files:**
- Modify: `packages/marketplace/src/Router.tsx`, `packages/marketplace/src/Router.test.tsx`
- Modify: `packages/marketplace/src/App.tsx`, `packages/marketplace/src/App.test.tsx`
- Modify: `packages/marketplace/src/styles.css`

**Interfaces:**
- Consumes: `Gems` (Task 2), `Gem` (Task 3); existing `Leaderboard`, `Ingredient`, `makeApi`.
- Produces: routing for `/gems` → `Gems` and `/gems/:key` → `Gem` (decoded key); an Ingredients↔Gems nav toggle in the header that marks the active surface.

- [ ] **Step 1: Add the failing router cases**

Append these two tests inside the existing `describe("Router", …)` block in `packages/marketplace/src/Router.test.tsx` (keep all existing cases):
```tsx
  it("renders the gem browse page at /gems", () => {
    window.history.pushState({}, "", "/gems");
    render(<Router api={makeApi("")} />);
    expect(screen.getByText("brainstorming-kit")).toBeTruthy();
  });

  it("renders the gem detail page at /gems/:key with the decoded key", () => {
    window.history.pushState({}, "", "/gems/" + encodeURIComponent("github-flow"));
    render(<Router api={makeApi("")} />);
    expect(screen.getByText("github-flow")).toBeTruthy();
    expect(screen.getByText(/2\.1\.0/)).toBeTruthy();
  });
```
(The existing `afterEach` resets the URL to `/`. The gem pages don't fetch, so no stub is needed — but the existing leaderboard/ingredient cases keep their `vi.stubGlobal("fetch", …)`.)

- [ ] **Step 2: Run to verify the new cases fail**

Run: `pnpm --filter @agentgem/marketplace test src/Router.test.tsx`
Expected: FAIL on the two new cases (Router doesn't know `/gems` yet → falls through to Leaderboard, which has no stubbed fetch here).

- [ ] **Step 3: Add the routes to `packages/marketplace/src/Router.tsx`**

Add the two imports and the two route matches (the gem-detail match must come before the bare `/gems` check, and both before the ingredient/leaderboard fallthrough):
```tsx
import { useEffect, useState } from "react";
import type { makeApi } from "./api";
import { Leaderboard } from "./pages/Leaderboard";
import { Ingredient } from "./pages/Ingredient";
import { Gems } from "./pages/Gems";
import { Gem } from "./pages/Gem";

// Navigation is intercepted globally in App (same-origin <a> clicks → pushState + popstate),
// so pages just use plain <a href> and this Router reacts to popstate.
export function Router({ api }: { api: ReturnType<typeof makeApi> }) {
  const [path, setPath] = useState(() => window.location.pathname);
  useEffect(() => {
    const onPop = () => setPath(window.location.pathname);
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);

  const gemDetail = path.match(/^\/gems\/(.+)$/);
  if (gemDetail) return <Gem keyName={decodeURIComponent(gemDetail[1])} />;
  if (path === "/gems") return <Gems />;

  const ing = path.match(/^\/ingredient\/(.+)$/);
  if (ing) return <Ingredient api={api} id={decodeURIComponent(ing[1])} />;
  return <Leaderboard api={api} />;
}
```

- [ ] **Step 4: Run router tests to verify they pass**

Run: `pnpm --filter @agentgem/marketplace test src/Router.test.tsx`
Expected: PASS — all cases (existing + 2 new).

- [ ] **Step 5: Add the failing App nav test**

Append this case inside the existing `describe("App link interceptor", …)` block in `packages/marketplace/src/App.test.tsx` (keep the existing cases). The file already defines a `res` helper and an `afterEach` that resets the URL to `/` — reuse them as-is:
```tsx
  it("renders Ingredients + Gems nav links, marking the active surface on /gems", () => {
    vi.stubGlobal("fetch", vi.fn(async () => res([])));
    window.history.pushState({}, "", "/gems");
    render(<App />);
    const gemsLink = screen.getByRole("link", { name: "Gems" });
    const ingLink = screen.getByRole("link", { name: "Ingredients" });
    expect(gemsLink.getAttribute("href")).toBe("/gems");
    expect(ingLink.getAttribute("href")).toBe("/");
    expect(gemsLink.className).toMatch(/is-active/);
    expect(ingLink.className).not.toMatch(/is-active/);
  });
```
(`res` and the URL-resetting `afterEach` already exist at the top of the file — do not redefine them.)

- [ ] **Step 6: Run to verify it fails**

Run: `pnpm --filter @agentgem/marketplace test src/App.test.tsx`
Expected: FAIL — there are no "Gems"/"Ingredients" nav links yet.

- [ ] **Step 7: Add the nav to `packages/marketplace/src/App.tsx`**

Track the pathname for active styling (a small popstate listener, mirroring Router) and render the nav toggle:
```tsx
import { useEffect, useState } from "react";
import { makeApi, defaultApiBase } from "./api";
import { Router } from "./Router";

const api = makeApi(defaultApiBase());

export function App() {
  const [path, setPath] = useState(() => window.location.pathname);
  useEffect(() => {
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
    return () => { document.removeEventListener("click", onClick); window.removeEventListener("popstate", onPop); };
  }, []);

  const onGems = path.startsWith("/gems");
  return (
    <div className="ex-app">
      <header className="ex-header">
        <a href="/" className="ex-brand">AgentGem Explore</a>
        <nav className="ex-nav">
          <a href="/" className={"ex-navlink" + (onGems ? "" : " is-active")}>Ingredients</a>
          <a href="/gems" className={"ex-navlink" + (onGems ? " is-active" : "")}>Gems</a>
        </nav>
      </header>
      <main className="ex-main"><Router api={api} /></main>
      <footer className="ex-footer">Trusted-adoption data, k-anonymized. <a href="https://agentgem.ai">agentgem.ai</a></footer>
    </div>
  );
}
```

- [ ] **Step 8: Append nav styles to `packages/marketplace/src/styles.css`**

```css
.ex-header { display: flex; align-items: baseline; gap: 16px; }
.ex-nav { display: flex; gap: 12px; }
.ex-navlink { text-decoration: none; color: #777; }
.ex-navlink.is-active { color: #b4543a; font-weight: 600; }
```

- [ ] **Step 9: Full gate**

Run: `pnpm --filter @agentgem/marketplace test && pnpm --filter @agentgem/marketplace typecheck && pnpm --filter @agentgem/marketplace build`
Expected: all tests pass (catalog + Gems + Gem + Router + App), typecheck clean, build writes `dist/`.

- [ ] **Step 10: Commit**

```bash
git add packages/marketplace/src/Router.tsx packages/marketplace/src/Router.test.tsx packages/marketplace/src/App.tsx packages/marketplace/src/App.test.tsx packages/marketplace/src/styles.css
git commit -m "feat(marketplace): wire /gems routes + Ingredients↔Gems nav"
```

---

## Final verification

- [ ] **Run the whole package once more**

Run: `pnpm --filter @agentgem/marketplace test && pnpm --filter @agentgem/marketplace typecheck && pnpm --filter @agentgem/marketplace build`
Expected: green, clean, `dist/` produced.

- [ ] **Manual smoke (optional):** `pnpm --filter @agentgem/marketplace dev`, open the printed URL → click **Gems** in the nav → the browse list renders; search narrows; click a gem → detail shows version/author/description, the Copy button copies the key, and each ingredient links into the live `/ingredient/:id` page (which loads real adoption data). The Ingredients↔Gems nav marks the active surface.

- [ ] **Deploy:** none needed beyond the existing Render static-site build — the `agentgem-app` service rebuilds `packages/marketplace` on merge to `main`, so `/gems` ships automatically.
