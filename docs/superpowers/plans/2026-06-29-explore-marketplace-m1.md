# Explore Marketplace (M1) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A standalone public web app (`packages/marketplace`) — leaderboard + ingredient-detail — served static on Cloudflare Pages at `app.agentgem.ai`, reading the deployed aggregator's public CORS-open endpoints.

**Architecture:** A new Vite + React 19 SPA in the monorepo. It talks *only* to the deployed aggregator's public HTTP API (`popularity`/`co-occurrence`/`adoption`) over `fetch` — no server-code import — and copies the console's small, pure Insights helpers/visuals rather than importing them (to dodge the local↔origin divergence). History routing + a Cloudflare `_redirects` SPA fallback give clean shareable URLs.

**Tech Stack:** Vite, `@vitejs/plugin-react`, React 19 + TypeScript 6 (ESM, bundler module resolution → extensionless imports), Vitest + jsdom + `@testing-library/react` (no jest-dom; assert with `.toBeTruthy()`), Cloudflare Pages.

## Global Constraints

- New package **`@agentgem/marketplace`** at `packages/marketplace`, `"type": "module"`, `"private": true`. The repo `pnpm-workspace.yaml` already globs `packages/*`, so it's picked up after `pnpm install`.
- **Bundler module resolution** — imports are extensionless (e.g. `import { makeApi } from "./api"`). This package does NOT use the `.js`-extension ESM style the server/console use.
- Tests: Vitest, `environment: jsdom`, `include: ["src/**/*.test.{ts,tsx}"]`, run on `src` directly (no compile step). Assert with `.toBeTruthy()` / `.toBeNull()` — match the console; do NOT add `@testing-library/jest-dom`. Stub network with `vi.stubGlobal("fetch", …)` + a `res(body)` helper returning `{ ok, status, text: async () => JSON.stringify(body) }`.
- Dep versions mirror the console: `react`/`react-dom` `^19.0.0`, `@types/react`(`-dom`) `^19.0.0`, `@testing-library/react` `^16.1.0`, `jsdom` `^25.0.0`, `vitest` `^3`, `typescript` `^6`. New: `vite` `^6`, `@vitejs/plugin-react` `^4`.
- **API base:** `makeApi(base: string)` is pure (tests pass a base). The default base reads `import.meta.env.VITE_API_BASE`, falling back to `"https://agentgem.onrender.com"`, and is resolved only at the app entry (`main.tsx`) — never inside `makeApi`.
- The aggregate types are **redeclared locally** as plain TS interfaces (no zod): `AggIngredient`, `AggCoOccurrence`, `AdoptionPoint`.
- Run package scripts via pnpm filter, e.g. `pnpm --filter @agentgem/marketplace test`, `… typecheck`, `… build`.
- k-anon is enforced server-side; this app sends no credentials and writes nothing.

## File structure

```
packages/marketplace/
  package.json          # @agentgem/marketplace; scripts: dev/build/test/typecheck
  tsconfig.json         # React + bundler resolution
  vite.config.ts        # react plugin + vitest (jsdom) config
  index.html            # Vite entry, #root
  public/_redirects     # /* /index.html 200  (CF Pages SPA fallback)
  src/
    test-setup.ts       # (minimal)
    types.ts            # AggIngredient, AggCoOccurrence, AdoptionPoint
    data.ts             # copied pure helpers (prettifyId, filterRows, sparkPoints, …)
    api.ts              # makeApi(base) → getPopularity/getCoOccurrence/getAdoption
    Sparkline.tsx       # SVG sparkline (producers + verified)
    Router.tsx          # history router: "/" and "/ingredient/:id"; <Link>
    App.tsx             # brand shell + <Router/>
    main.tsx            # createRoot + resolve default API base
    styles.css
    pages/
      Leaderboard.tsx   # home: ranked list + search + kind tabs
      Ingredient.tsx    # /ingredient/:id: co-occurrence + adoption sparkline
```

---

### Task 1: Scaffold the package + toolchain

**Files:**
- Create: `packages/marketplace/package.json`, `tsconfig.json`, `vite.config.ts`, `index.html`, `public/_redirects`, `src/test-setup.ts`, `src/smoke.test.ts`

**Interfaces:**
- Produces: a runnable Vite+Vitest package. Later tasks add `src/*`.

- [ ] **Step 1: Create `packages/marketplace/package.json`**

```json
{
  "name": "@agentgem/marketplace",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "vite",
    "build": "vite build",
    "typecheck": "tsc -p tsconfig.json --noEmit",
    "test": "vitest run"
  },
  "dependencies": {
    "react": "^19.0.0",
    "react-dom": "^19.0.0"
  },
  "devDependencies": {
    "@testing-library/react": "^16.1.0",
    "@types/react": "^19.0.0",
    "@types/react-dom": "^19.0.0",
    "@vitejs/plugin-react": "^4.3.4",
    "jsdom": "^25.0.0",
    "typescript": "^6",
    "vite": "^6",
    "vitest": "^3"
  }
}
```

- [ ] **Step 2: Create `tsconfig.json`**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "lib": ["ES2022", "DOM", "DOM.Iterable"],
    "module": "ESNext",
    "moduleResolution": "bundler",
    "jsx": "react-jsx",
    "strict": true,
    "noUnusedLocals": true,
    "noUnusedParameters": true,
    "skipLibCheck": true,
    "types": ["vite/client", "vitest/globals"],
    "noEmit": true
  },
  "include": ["src"]
}
```

- [ ] **Step 3: Create `vite.config.ts`**

```ts
import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  test: {
    environment: "jsdom",
    include: ["src/**/*.test.{ts,tsx}"],
    setupFiles: ["./src/test-setup.ts"],
    watch: false,
  },
});
```

- [ ] **Step 4: Create `index.html`, `public/_redirects`, `src/test-setup.ts`**

`index.html`:
```html
<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>AgentGem Explore</title>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/src/main.tsx"></script>
  </body>
</html>
```

`public/_redirects` (Cloudflare Pages SPA fallback so history routes deep-link):
```
/*    /index.html   200
```

`src/test-setup.ts` (empty hook file; present so the vitest `setupFiles` path resolves):
```ts
// Test setup for the marketplace SPA. No global stubs needed yet.
export {};
```

- [ ] **Step 5: Write the smoke test**

`src/smoke.test.ts`:
```ts
import { describe, it, expect } from "vitest";

describe("toolchain", () => {
  it("runs vitest", () => {
    expect(1 + 1).toBe(2);
  });
});
```

- [ ] **Step 6: Install + verify the toolchain**

Run: `pnpm install`
Then: `pnpm --filter @agentgem/marketplace test`
Expected: PASS (1 test). Then `pnpm --filter @agentgem/marketplace typecheck` → clean; `pnpm --filter @agentgem/marketplace build` → writes `dist/`.

- [ ] **Step 7: Commit**

```bash
git add packages/marketplace pnpm-lock.yaml
git commit -m "scaffold(marketplace): Vite + React + Vitest package"
```

---

### Task 2: Aggregate types + pure helpers

**Files:**
- Create: `packages/marketplace/src/types.ts`, `src/data.ts`, `src/data.test.ts`

**Interfaces:**
- Produces:
  - `types.ts`: `interface AggIngredient { id: string; kind: string; producers: number; verifiedProducers: number; invocations: number; sessions: number }`; `interface AggCoOccurrence { id: string; producers: number; verifiedProducers: number }`; `interface AdoptionPoint { bucket: string; producers: number; verifiedProducers: number; invocations: number }`.
  - `data.ts`: `prettifyId(id, kind): {name, scope?}`, `kindLabel(kind): string`, `verifiedShare(producers, verified): number`, `barWidths(values): number[]`, `sparkPoints(values, w, h, max?): string`, `filterRows(rows, query): { row: AggIngredient; rank: number }[]`, plus the `PrettyId`/`RankedRow` interfaces.

- [ ] **Step 1: Write the failing test**

`src/data.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { prettifyId, kindLabel, verifiedShare, barWidths, sparkPoints, filterRows } from "./data";

describe("prettifyId", () => {
  it("splits plugin skills/mcps into name + scope", () => {
    expect(prettifyId("skill:superpowers/brainstorming", "skill")).toEqual({ name: "brainstorming", scope: "superpowers" });
  });
  it("treats a package runner prefix as the scope", () => {
    expect(prettifyId("npx:@modelcontextprotocol/server-github", "mcp")).toEqual({ name: "@modelcontextprotocol/server-github", scope: "npx" });
  });
  it("passes through model/harness ids", () => {
    expect(prettifyId("claude-opus-4-8", "model")).toEqual({ name: "claude-opus-4-8" });
  });
});

describe("kindLabel", () => {
  it("maps known kinds and falls through", () => {
    expect(kindLabel("skill")).toBe("Skill");
    expect(kindLabel("widget")).toBe("widget");
  });
});

describe("verifiedShare", () => {
  it("is verified/producers clamped to [0,1], 0 when no producers", () => {
    expect(verifiedShare(10, 4)).toBeCloseTo(0.4);
    expect(verifiedShare(0, 0)).toBe(0);
  });
});

describe("barWidths", () => {
  it("normalizes against the max", () => {
    expect(barWidths([5, 10, 0])).toEqual([0.5, 1, 0]);
    expect(barWidths([])).toEqual([]);
  });
});

describe("sparkPoints", () => {
  it("maps values across width and inverts y", () => {
    expect(sparkPoints([0, 10], 100, 40)).toBe("0.0,40.0 100.0,0.0");
  });
});

describe("filterRows", () => {
  const rows = [
    { id: "skill:superpowers/brainstorming", kind: "skill", producers: 80, verifiedProducers: 40, invocations: 200, sessions: 90 },
    { id: "npx:@mcp/github", kind: "mcp", producers: 30, verifiedProducers: 9, invocations: 50, sessions: 25 },
  ];
  it("returns all rows with 1-based ranks when blank", () => {
    expect(filterRows(rows, "  ")).toEqual([{ row: rows[0], rank: 1 }, { row: rows[1], rank: 2 }]);
  });
  it("filters case-insensitively, preserving original rank", () => {
    expect(filterRows(rows, "GITHUB")).toEqual([{ row: rows[1], rank: 2 }]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @agentgem/marketplace test src/data.test.ts`
Expected: FAIL — `./data` not found.

- [ ] **Step 3: Create `src/types.ts`**

```ts
export interface AggIngredient {
  id: string;
  kind: string;
  producers: number;
  verifiedProducers: number;
  invocations: number;
  sessions: number;
}
export interface AggCoOccurrence {
  id: string;
  producers: number;
  verifiedProducers: number;
}
export interface AdoptionPoint {
  bucket: string;
  producers: number;
  verifiedProducers: number;
  invocations: number;
}
```

- [ ] **Step 4: Create `src/data.ts`** (copied verbatim from the console's Insights `data.ts`, with a local-types import)

```ts
/** Pure formatting + chart-math for the marketplace. Copied from the console's Insights data.ts. */
import type { AggIngredient } from "./types";

export interface PrettyId { name: string; scope?: string }
export interface RankedRow { row: AggIngredient; rank: number }

/** Public ingredient ids are self-describing — strip the prefix into name (+ scope). */
export function prettifyId(id: string, _kind: string): PrettyId {
  const colon = id.indexOf(":");
  if (colon <= 0) return { name: id };
  const prefix = id.slice(0, colon);
  const rest = id.slice(colon + 1);
  if (prefix === "skill" || prefix === "mcp") {
    const slash = rest.indexOf("/");
    return slash > 0 ? { name: rest.slice(slash + 1), scope: rest.slice(0, slash) } : { name: rest };
  }
  if (prefix === "url") return { name: rest, scope: "url" };
  return { name: rest, scope: prefix };
}

const KIND_LABELS: Record<string, string> = { skill: "Skill", mcp: "MCP", model: "Model", harness: "Harness" };
export function kindLabel(kind: string): string { return KIND_LABELS[kind] ?? kind; }

export function verifiedShare(producers: number, verified: number): number {
  return producers > 0 ? Math.min(1, verified / producers) : 0;
}

export function barWidths(values: number[]): number[] {
  if (values.length === 0) return [];
  const max = Math.max(1, ...values);
  return values.map((v) => v / max);
}

/** Space-separated "x,y" points for an SVG polyline; y inverted so taller = bigger. */
export function sparkPoints(values: number[], w: number, h: number, max = Math.max(1, ...values)): string {
  if (values.length === 0) return "";
  if (values.length === 1) { const y = (h - (values[0] / max) * h).toFixed(0); return `0,${y} ${w},${y}`; }
  const step = w / (values.length - 1);
  return values.map((v, i) => `${(i * step).toFixed(1)},${(h - (v / max) * h).toFixed(1)}`).join(" ");
}

/** Filter the leaderboard by a case-insensitive substring over name/scope/raw id.
 *  Rank is the row's 1-based position in the full (unfiltered) list, so ranks stay honest. */
export function filterRows(rows: AggIngredient[], query: string): RankedRow[] {
  const q = query.trim().toLowerCase();
  const ranked = rows.map((row, i) => ({ row, rank: i + 1 }));
  if (q === "") return ranked;
  return ranked.filter(({ row }) => {
    const p = prettifyId(row.id, row.kind);
    return (
      p.name.toLowerCase().includes(q) ||
      (p.scope?.toLowerCase().includes(q) ?? false) ||
      row.id.toLowerCase().includes(q)
    );
  });
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `pnpm --filter @agentgem/marketplace test src/data.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/marketplace/src/types.ts packages/marketplace/src/data.ts packages/marketplace/src/data.test.ts
git commit -m "feat(marketplace): aggregate types + copied pure helpers"
```

---

### Task 3: API client

**Files:**
- Create: `packages/marketplace/src/api.ts`, `src/api.test.ts`

**Interfaces:**
- Consumes: `AggIngredient`, `AggCoOccurrence`, `AdoptionPoint` (Task 2).
- Produces:
  - `makeApi(base: string)` → `{ getPopularity(q?: { kind?: string; limit?: number }): Promise<AggIngredient[]>; getCoOccurrence(q: { id: string; limit?: number }): Promise<AggCoOccurrence[]>; getAdoption(q: { id: string; bucket?: "week" | "month" }): Promise<AdoptionPoint[]> }`.
  - `defaultApiBase(): string` — reads `import.meta.env.VITE_API_BASE`, else `"https://agentgem.onrender.com"`.

- [ ] **Step 1: Write the failing test**

`src/api.test.ts`:
```ts
import { describe, it, expect, vi, afterEach } from "vitest";
import { makeApi } from "./api";

afterEach(() => vi.unstubAllGlobals());
const res = (body: unknown) => ({ ok: true, status: 200, text: async () => JSON.stringify(body) }) as unknown as Response;

describe("makeApi", () => {
  it("getPopularity hits the right URL with kind/limit and returns the array", async () => {
    const calls: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string) => { calls.push(String(url)); return res([{ id: "skill:a/b", kind: "skill", producers: 1, verifiedProducers: 0, invocations: 1, sessions: 1 }]); }));
    const api = makeApi("https://x");
    const out = await api.getPopularity({ kind: "skill", limit: 5 });
    expect(out[0].id).toBe("skill:a/b");
    expect(calls[0]).toBe("https://x/api/aggregator/popularity?kind=skill&limit=5");
  });

  it("getPopularity with no query omits the querystring", async () => {
    const calls: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string) => { calls.push(String(url)); return res([]); }));
    await makeApi("https://x").getPopularity();
    expect(calls[0]).toBe("https://x/api/aggregator/popularity");
  });

  it("getCoOccurrence + getAdoption encode the id and pass params", async () => {
    const calls: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string) => { calls.push(String(url)); return res([]); }));
    const api = makeApi("https://x");
    await api.getCoOccurrence({ id: "skill:a/b" });
    await api.getAdoption({ id: "skill:a/b", bucket: "month" });
    expect(calls[0]).toBe("https://x/api/aggregator/co-occurrence?id=skill%3Aa%2Fb");
    expect(calls[1]).toBe("https://x/api/aggregator/adoption?id=skill%3Aa%2Fb&bucket=month");
  });

  it("rejects on a non-2xx response", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: false, status: 500, text: async () => "" }) as unknown as Response));
    await expect(makeApi("https://x").getPopularity()).rejects.toThrow(/500/);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @agentgem/marketplace test src/api.test.ts`
Expected: FAIL — `./api` not found.

- [ ] **Step 3: Create `src/api.ts`**

```ts
import type { AggIngredient, AggCoOccurrence, AdoptionPoint } from "./types";

type Query = Record<string, string | number | undefined>;

async function get<T>(base: string, path: string, query: Query = {}): Promise<T> {
  const qs = Object.entries(query)
    .filter(([, v]) => v !== undefined)
    .map(([k, v]) => `${k}=${encodeURIComponent(String(v))}`)
    .join("&");
  const res = await fetch(base + path + (qs ? `?${qs}` : ""));
  if (!res.ok) throw new Error(`${path} -> ${res.status}`);
  return JSON.parse(await res.text()) as T;
}

export function makeApi(base: string) {
  return {
    getPopularity: (q: { kind?: string; limit?: number } = {}) =>
      get<AggIngredient[]>(base, "/api/aggregator/popularity", q),
    getCoOccurrence: (q: { id: string; limit?: number }) =>
      get<AggCoOccurrence[]>(base, "/api/aggregator/co-occurrence", q),
    getAdoption: (q: { id: string; bucket?: "week" | "month" }) =>
      get<AdoptionPoint[]>(base, "/api/aggregator/adoption", q),
  };
}

export function defaultApiBase(): string {
  return (import.meta.env?.VITE_API_BASE as string | undefined) ?? "https://agentgem.onrender.com";
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @agentgem/marketplace test src/api.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/marketplace/src/api.ts packages/marketplace/src/api.test.ts
git commit -m "feat(marketplace): typed public aggregator API client"
```

---

### Task 4: Leaderboard page

**Files:**
- Create: `packages/marketplace/src/pages/Leaderboard.tsx`, `src/pages/Leaderboard.test.tsx`, `src/styles.css` (started here)

**Interfaces:**
- Consumes: `makeApi` (Task 3); `prettifyId`, `kindLabel`, `verifiedShare`, `barWidths`, `filterRows` (Task 2); `AggIngredient` (Task 2).
- Produces: `Leaderboard({ api }: { api: ReturnType<typeof makeApi> })` — a React component. Rows link to `/ingredient/<encodeURIComponent(id)>` via a plain `<a>` (Task 6 upgrades navigation to `<Link>`; an `<a href>` works regardless).

- [ ] **Step 1: Write the failing test**

`src/pages/Leaderboard.test.tsx`:
```tsx
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent, waitFor } from "@testing-library/react";
import { Leaderboard } from "./Leaderboard";
import { makeApi } from "../api";

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
const res = (body: unknown) => ({ ok: true, status: 200, text: async () => JSON.stringify(body) }) as unknown as Response;
const rows = [
  { id: "skill:superpowers/brainstorming", kind: "skill", producers: 80, verifiedProducers: 40, invocations: 200, sessions: 90 },
  { id: "npx:@mcp/github", kind: "mcp", producers: 30, verifiedProducers: 9, invocations: 50, sessions: 25 },
];

describe("Leaderboard", () => {
  it("renders ranked rows from the API with producer + verified counts", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => res(rows)));
    render(<Leaderboard api={makeApi("")} />);
    expect(await screen.findByText("brainstorming")).toBeTruthy();
    expect(screen.getByText("@mcp/github")).toBeTruthy();
    expect(screen.getByText(/40 verified/i)).toBeTruthy();
  });

  it("filters via the search box (ranks preserved)", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => res(rows)));
    render(<Leaderboard api={makeApi("")} />);
    await screen.findByText("brainstorming");
    fireEvent.change(screen.getByLabelText("search ingredients"), { target: { value: "github" } });
    expect(screen.queryByText("brainstorming")).toBeNull();
    expect(screen.getByText("@mcp/github")).toBeTruthy();
    expect(screen.getByText("2")).toBeTruthy(); // original rank
  });

  it("shows the k-anon empty state when the API returns nothing", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => res([])));
    render(<Leaderboard api={makeApi("")} />);
    await waitFor(() => expect(screen.getByText(/no ingredients above the k-anonymity floor/i)).toBeTruthy());
  });

  it("links a row to its ingredient page (encoded id)", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => res(rows)));
    render(<Leaderboard api={makeApi("")} />);
    const link = (await screen.findByText("brainstorming")).closest("a");
    expect(link?.getAttribute("href")).toBe("/ingredient/" + encodeURIComponent("skill:superpowers/brainstorming"));
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @agentgem/marketplace test src/pages/Leaderboard.test.tsx`
Expected: FAIL — `./Leaderboard` not found.

- [ ] **Step 3: Create `src/pages/Leaderboard.tsx`**

```tsx
import { useEffect, useState } from "react";
import type { makeApi } from "../api";
import type { AggIngredient } from "../types";
import { prettifyId, kindLabel, verifiedShare, barWidths, filterRows } from "../data";

const KINDS = [
  { value: "all", label: "All" },
  { value: "skill", label: "Skill" },
  { value: "mcp", label: "MCP" },
];

export function Leaderboard({ api }: { api: ReturnType<typeof makeApi> }) {
  const [rows, setRows] = useState<AggIngredient[]>([]);
  const [kind, setKind] = useState("all");
  const [search, setSearch] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    setLoading(true); setError(null);
    api.getPopularity(kind === "all" ? {} : { kind })
      .then((r) => { if (alive) setRows(r); })
      .catch((e) => { if (alive) setError(String(e?.message ?? e)); })
      .finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, [api, kind]);

  const widths = barWidths(rows.map((r) => r.producers));
  const visible = filterRows(rows, search);

  return (
    <div className="ex-board">
      <div className="ex-tabs">
        {KINDS.map((k) => (
          <button key={k.value} type="button"
            className={"ex-tab" + (k.value === kind ? " is-active" : "")}
            onClick={() => setKind(k.value)}>{k.label}</button>
        ))}
      </div>
      <input className="ex-search" type="search" aria-label="search ingredients"
        placeholder="filter the leaderboard…" value={search}
        onChange={(e) => setSearch(e.target.value)} />
      {error && <p className="ex-error">Couldn't load the leaderboard: {error}</p>}
      {!error && loading && rows.length === 0 && <p className="ex-empty">Loading…</p>}
      {!error && !loading && rows.length === 0 && <p className="ex-empty">No ingredients above the k-anonymity floor yet.</p>}
      {rows.length > 0 && visible.length === 0 && <p className="ex-empty">No ingredients match “{search}”.</p>}
      <ol className="ex-rows">
        {visible.map(({ row: r, rank }) => {
          const p = prettifyId(r.id, r.kind);
          return (
            <li key={r.id}>
              <a className="ex-row" href={"/ingredient/" + encodeURIComponent(r.id)}>
                <span className="ex-rank">{rank}</span>
                <span className="ex-name">{p.name}{p.scope && <span className="ex-scope">{p.scope}</span>}</span>
                <span className="ex-kind">{kindLabel(r.kind)}</span>
                <span className="ex-bar"><span className="ex-bar-fill" style={{ width: `${(widths[rank - 1] * 100).toFixed(0)}%` }} /></span>
                <span className="ex-counts">{r.producers} producers · {r.verifiedProducers} verified ✓</span>
                <span className="ex-vshare"><span className="ex-vshare-fill" style={{ width: `${(verifiedShare(r.producers, r.verifiedProducers) * 100).toFixed(0)}%` }} /></span>
              </a>
            </li>
          );
        })}
      </ol>
    </div>
  );
}
```

- [ ] **Step 4: Create `src/styles.css`** (minimal, enough to render; not asserted by tests)

```css
:root { color-scheme: light; font-family: system-ui, sans-serif; }
.ex-tabs { display: flex; gap: 8px; margin-bottom: 8px; }
.ex-tab { padding: 4px 10px; border: 1px solid #ddd; border-radius: 6px; background: #fff; cursor: pointer; }
.ex-tab.is-active { background: #efe9df; }
.ex-search { width: 100%; box-sizing: border-box; padding: 6px 10px; margin: 8px 0; }
.ex-rows { list-style: none; padding: 0; margin: 0; }
.ex-row { display: grid; grid-template-columns: 2ch 1fr auto; gap: 8px; align-items: center; padding: 8px; text-decoration: none; color: inherit; }
.ex-scope { color: #888; margin-left: 6px; font-size: .85em; }
.ex-bar, .ex-vshare { background: #eee; height: 6px; border-radius: 3px; overflow: hidden; }
.ex-bar-fill { display: block; height: 100%; background: #b4543a; }
.ex-vshare-fill { display: block; height: 100%; background: #3a7d44; }
.ex-empty, .ex-error { color: #777; padding: 16px 8px; }
```

- [ ] **Step 5: Run test to verify it passes**

Run: `pnpm --filter @agentgem/marketplace test src/pages/Leaderboard.test.tsx`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/marketplace/src/pages/Leaderboard.tsx packages/marketplace/src/pages/Leaderboard.test.tsx packages/marketplace/src/styles.css
git commit -m "feat(marketplace): public leaderboard page (search + kind tabs)"
```

---

### Task 5: Ingredient detail page + Sparkline

**Files:**
- Create: `packages/marketplace/src/Sparkline.tsx`, `src/pages/Ingredient.tsx`, `src/pages/Ingredient.test.tsx`

**Interfaces:**
- Consumes: `makeApi` (Task 3); `prettifyId`, `sparkPoints` (Task 2).
- Produces:
  - `Sparkline({ values, verified }: { values: number[]; verified: number[] })` — an SVG overlay of two polylines on a shared scale.
  - `Ingredient({ api, id }: { api: ReturnType<typeof makeApi>; id: string })` — fetches co-occurrence + adoption for `id` and renders them.

- [ ] **Step 1: Write the failing test**

`src/pages/Ingredient.test.tsx`:
```tsx
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent, waitFor } from "@testing-library/react";
import { Ingredient } from "./Ingredient";
import { makeApi } from "../api";

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
const res = (body: unknown) => ({ ok: true, status: 200, text: async () => JSON.stringify(body) }) as unknown as Response;

function stub() {
  vi.stubGlobal("fetch", vi.fn(async (url: string) => {
    if (url.includes("/co-occurrence")) return res([{ id: "skill:superpowers/writing-plans", producers: 30, verifiedProducers: 15 }]);
    if (url.includes("/adoption")) return res([{ bucket: "2026-06-01", producers: 10, verifiedProducers: 4, invocations: 22 }]);
    throw new Error("unexpected " + url);
  }));
}

describe("Ingredient", () => {
  it("renders the prettified header, co-occurrence, and adoption", async () => {
    stub();
    render(<Ingredient api={makeApi("")} id="skill:superpowers/brainstorming" />);
    expect(await screen.findByText("brainstorming")).toBeTruthy();      // header
    await waitFor(() => expect(screen.getByText("writing-plans")).toBeTruthy()); // co-occurrence
    expect(screen.getByText(/adoption/i)).toBeTruthy();
  });

  it("refetches adoption when the bucket toggles", async () => {
    stub();
    render(<Ingredient api={makeApi("")} id="skill:superpowers/brainstorming" />);
    await screen.findByText("brainstorming");
    const before = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls.length;
    fireEvent.click(screen.getByRole("button", { name: "month" }));
    await waitFor(() => expect((globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls.length).toBeGreaterThan(before));
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @agentgem/marketplace test src/pages/Ingredient.test.tsx`
Expected: FAIL — `./Ingredient` not found.

- [ ] **Step 3: Create `src/Sparkline.tsx`**

```tsx
import { sparkPoints } from "./data";

export function Sparkline({ values, verified }: { values: number[]; verified: number[] }) {
  const w = 320, h = 64;
  const max = Math.max(1, ...values, ...verified);
  return (
    <svg className="ex-spark" viewBox={`0 0 ${w} ${h}`} width="100%" height={h} aria-hidden="true">
      <polyline fill="none" stroke="#b4543a" strokeWidth="2" points={sparkPoints(values, w, h, max)} />
      <polyline fill="none" stroke="#3a7d44" strokeWidth="2" strokeDasharray="4 3" points={sparkPoints(verified, w, h, max)} />
    </svg>
  );
}
```

- [ ] **Step 4: Create `src/pages/Ingredient.tsx`**

```tsx
import { useEffect, useState } from "react";
import type { makeApi } from "../api";
import type { AggCoOccurrence, AdoptionPoint } from "../types";
import { prettifyId } from "../data";
import { Sparkline } from "../Sparkline";

export function Ingredient({ api, id }: { api: ReturnType<typeof makeApi>; id: string }) {
  const [co, setCo] = useState<AggCoOccurrence[]>([]);
  const [series, setSeries] = useState<AdoptionPoint[]>([]);
  const [bucket, setBucket] = useState<"week" | "month">("week");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    setError(null);
    Promise.all([api.getCoOccurrence({ id }), api.getAdoption({ id, bucket })])
      .then(([c, a]) => { if (!alive) return; setCo(c); setSeries(a); })
      .catch((e) => { if (alive) setError(String(e?.message ?? e)); });
    return () => { alive = false; };
  }, [api, id, bucket]);

  const head = prettifyId(id, "skill");
  if (error) return <div className="ex-detail"><p className="ex-error">Couldn't load this ingredient: {error}</p></div>;

  return (
    <div className="ex-detail">
      <h2 className="ex-detail-head">{head.name}{head.scope && <span className="ex-scope">{head.scope}</span>}</h2>

      <section className="ex-card">
        <h3>Used together with</h3>
        {co.length === 0 && <p className="ex-empty">Not enough data yet.</p>}
        <ul className="ex-co">
          {co.map((c) => {
            const p = prettifyId(c.id, "skill");
            return <li key={c.id}><span>{p.name}</span><span className="ex-counts">{c.producers} · {c.verifiedProducers} ✓</span></li>;
          })}
        </ul>
      </section>

      <section className="ex-card">
        <div className="ex-card-head">
          <h3>Adoption</h3>
          <div className="ex-bucket">
            {(["week", "month"] as const).map((b) => (
              <button key={b} type="button" className={"ex-bucket-btn" + (b === bucket ? " is-active" : "")} onClick={() => setBucket(b)}>{b}</button>
            ))}
          </div>
        </div>
        <Sparkline values={series.map((s) => s.producers)} verified={series.map((s) => s.verifiedProducers)} />
        <p className="ex-legend"><span className="ex-dot ex-dot-prod" /> producers <span className="ex-dot ex-dot-ver" /> verified</p>
      </section>
    </div>
  );
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `pnpm --filter @agentgem/marketplace test src/pages/Ingredient.test.tsx`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/marketplace/src/Sparkline.tsx packages/marketplace/src/pages/Ingredient.tsx packages/marketplace/src/pages/Ingredient.test.tsx
git commit -m "feat(marketplace): ingredient detail page + sparkline"
```

---

### Task 6: Router + app shell + entry

**Files:**
- Create: `packages/marketplace/src/Router.tsx`, `src/Router.test.tsx`, `src/App.tsx`, `src/main.tsx`
- Modify: `packages/marketplace/src/smoke.test.ts` (delete — superseded)

**Interfaces:**
- Consumes: `Leaderboard` (Task 4), `Ingredient` (Task 5), `makeApi`/`defaultApiBase` (Task 3).
- Produces: `Router({ api })` rendering `Leaderboard` at `/` and `Ingredient` (decoded `:id`) at `/ingredient/:id`, reacting to `popstate`; `App` shell; `main.tsx` mounts it.

- [ ] **Step 1: Write the failing test**

`src/Router.test.tsx`:
```tsx
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup, waitFor } from "@testing-library/react";
import { Router } from "./Router";
import { makeApi } from "./api";

afterEach(() => { cleanup(); vi.unstubAllGlobals(); window.history.pushState({}, "", "/"); });
const res = (body: unknown) => ({ ok: true, status: 200, text: async () => JSON.stringify(body) }) as unknown as Response;

describe("Router", () => {
  it("renders the leaderboard at /", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => res([{ id: "skill:a/b", kind: "skill", producers: 5, verifiedProducers: 2, invocations: 9, sessions: 4 }])));
    window.history.pushState({}, "", "/");
    render(<Router api={makeApi("")} />);
    expect(await screen.findByText("b")).toBeTruthy();
  });

  it("renders the ingredient page at /ingredient/:id with the decoded id", async () => {
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      if (url.includes("/co-occurrence")) return res([{ id: "skill:c/d", producers: 1, verifiedProducers: 0 }]);
      return res([]);
    }));
    window.history.pushState({}, "", "/ingredient/" + encodeURIComponent("skill:superpowers/brainstorming"));
    render(<Router api={makeApi("")} />);
    expect(await screen.findByText("brainstorming")).toBeTruthy(); // header from decoded id
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @agentgem/marketplace test src/Router.test.tsx`
Expected: FAIL — `./Router` not found.

- [ ] **Step 3: Create `src/Router.tsx`**

```tsx
import { useEffect, useState } from "react";
import type { makeApi } from "./api";
import { Leaderboard } from "./pages/Leaderboard";
import { Ingredient } from "./pages/Ingredient";

// Navigation is intercepted globally in App (same-origin <a> clicks → pushState + popstate),
// so pages just use plain <a href> and this Router reacts to popstate.
export function Router({ api }: { api: ReturnType<typeof makeApi> }) {
  const [path, setPath] = useState(() => window.location.pathname);
  useEffect(() => {
    const onPop = () => setPath(window.location.pathname);
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);

  const ing = path.match(/^\/ingredient\/(.+)$/);
  if (ing) return <Ingredient api={api} id={decodeURIComponent(ing[1])} />;
  return <Leaderboard api={api} />;
}
```

- [ ] **Step 4: Run the router test to verify it passes**

Run: `pnpm --filter @agentgem/marketplace test src/Router.test.tsx`
Expected: PASS.

- [ ] **Step 5: Create `src/App.tsx` + `src/main.tsx`; delete the smoke test**

`src/App.tsx` (brand shell + intercept same-origin link clicks for SPA nav):
```tsx
import { useEffect } from "react";
import { makeApi, defaultApiBase } from "./api";
import { Router } from "./Router";

const api = makeApi(defaultApiBase());

export function App() {
  useEffect(() => {
    const onClick = (e: MouseEvent) => {
      const a = (e.target as HTMLElement).closest("a");
      if (!a) return;
      const href = a.getAttribute("href");
      if (!href || !href.startsWith("/") || a.target === "_blank" || e.metaKey || e.ctrlKey) return;
      e.preventDefault();
      window.history.pushState({}, "", href);
      window.dispatchEvent(new PopStateEvent("popstate"));
    };
    document.addEventListener("click", onClick);
    return () => document.removeEventListener("click", onClick);
  }, []);

  return (
    <div className="ex-app">
      <header className="ex-header"><a href="/" className="ex-brand">AgentGem Explore</a></header>
      <main className="ex-main"><Router api={api} /></main>
      <footer className="ex-footer">Trusted-adoption data, k-anonymized. <a href="https://agentgem.ai">agentgem.ai</a></footer>
    </div>
  );
}
```

`src/main.tsx`:
```tsx
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import "./styles.css";

const el = document.getElementById("root");
if (el) createRoot(el).render(<StrictMode><App /></StrictMode>);
```

Delete the now-superseded smoke test:
```bash
rm packages/marketplace/src/smoke.test.ts
```

- [ ] **Step 6: Full verify — tests + typecheck + build**

Run: `pnpm --filter @agentgem/marketplace test && pnpm --filter @agentgem/marketplace typecheck && pnpm --filter @agentgem/marketplace build`
Expected: all tests pass; tsc clean; `vite build` writes `packages/marketplace/dist/` including `_redirects`.

- [ ] **Step 7: Commit**

```bash
git add packages/marketplace/src/Router.tsx packages/marketplace/src/Router.test.tsx packages/marketplace/src/App.tsx packages/marketplace/src/main.tsx
git rm packages/marketplace/src/smoke.test.ts
git commit -m "feat(marketplace): history router + app shell + entry"
```

---

## Final verification

- [ ] **Run the whole package once more**

Run: `pnpm --filter @agentgem/marketplace test && pnpm --filter @agentgem/marketplace typecheck && pnpm --filter @agentgem/marketplace build`
Expected: green, clean, `dist/` produced (with `_redirects`).

- [ ] **Manual smoke (optional):** `pnpm --filter @agentgem/marketplace dev`, open the printed localhost URL with `VITE_API_BASE=https://agentgem.onrender.com` → leaderboard loads from the live aggregator (or its k-anon empty state); click a row → ingredient page; toggle week/month.

- [ ] **Deploy (separate, you-run-it):** a Cloudflare Pages runbook (project root `packages/marketplace`, build `pnpm --filter @agentgem/marketplace build`, output `packages/marketplace/dist`, env `VITE_API_BASE`, custom domain `app.agentgem.ai`) — authored after the build is green, mirroring the Render runbook.
