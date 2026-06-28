# React UI Console Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stand up a pnpm workspace with a private `@agentgem/console` React SPA that renders the gem inventory (Ledger panel) at `/console`, in parallel with the untouched vanilla UI at `/`.

**Architecture:** A new private package `packages/console` owns a small React 19 shell that mirrors `@agentback/console`'s composition contract (`ConsolePage[]` registry). It is an HTTP client of the existing REST API — it imports nothing from `src/gem`. esbuild bundles the SPA into a single self-contained `index.html`; the root build copies that into `dist/public/console/`, so `npx`, `npm i -g`, and the Electron desktop bundle ship it with no consumer-facing change (everything funnels through `dist/public/`).

**Tech Stack:** pnpm 10 workspace · React 19 + react-dom · `@agentback/client` (schema-typed REST calls) + zod 4 · esbuild (bundler) · vitest 3 + jsdom + @testing-library/react (console tests) · TypeScript 6 · the existing `@agentback/rest` server.

## Global Constraints

- The console package is `private: true` — NEVER published, NEVER a runtime dependency of `@ninemind/agentgem`. Only its built JS lands in the tarball, inside `dist/public/console/`.
- Do NOT modify the vanilla UI (`src/public/index.html`) or the `/` route. No cutover in this plan.
- Do NOT import anything from `src/gem` or any agentgem server module into `packages/console`. The panel reaches the API through `@agentback/client` only.
- API calls use `@agentback/client` (`defineRoute` + `createClient`), with **minimal client-side Zod response schemas** that validate only the fields the panel reads (zod strips the rest). Do NOT import agentgem's `src/schemas.ts` (it pulls node-only deps via `RUNNER_REGISTRY` and would bloat/break the browser bundle). When a shared browser-safe contract package is later extracted (deferred backend work), these minimal schemas collapse into imports from it.
- Do NOT add `express` as a direct dependency. Serve `/console` with a single `get()` route via `readFileSync`, mirroring how `/` is served in `src/index.ts`.
- Theme: port the warm-paper tokens locally (`--paper:#f4efe3; --ink:#211c15; --accent:#9a3324;` plus the rest of the `:root` block from `src/public/index.html`). Do NOT depend on `@agentback/console-theme`.
- Mount path is `/console`, behind the existing `originGuard`. Keep `app.get("/")` untouched.
- Root `tsc -b` includes only `src/**`; root vitest runs only `dist/**/__tests__/**/*.test.js`. Keep console TS + tests inside `packages/console` so neither root step picks them up.
- Git author for every commit: `Raymond Feng <raymond@ninemind.ai>`. End commit messages with the `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>` trailer.

---

### Task 1: Workspace scaffold + composition contract

**Files:**
- Create: `pnpm-workspace.yaml`
- Create: `packages/console/package.json`
- Create: `packages/console/tsconfig.json`
- Create: `packages/console/vitest.config.ts`
- Create: `packages/console/src/contract.ts`
- Create: `packages/console/src/registry.ts`
- Test: `packages/console/src/__tests__/registry.test.ts`

**Interfaces:**
- Produces: `ConsolePage` (`{ id: string; title: string; icon?: string; order: number; route: string; component: (p: { apiBase: string }) => ReactNode }`), `defineConsolePage(p: ConsolePage): ConsolePage`, `sortedPages(pages: ConsolePage[]): ConsolePage[]` (sorts ascending by `order`; throws `Error` on duplicate `id`).

- [ ] **Step 1: Create the workspace manifest**

`pnpm-workspace.yaml`:
```yaml
packages:
  - "packages/*"
```

- [ ] **Step 2: Create the console package manifest**

`packages/console/package.json`:
```json
{
  "name": "@agentgem/console",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "scripts": {
    "build": "node build-client.mjs",
    "typecheck": "tsc -p tsconfig.json --noEmit",
    "test": "vitest run"
  },
  "dependencies": {
    "@agentback/client": "^0.6.0",
    "react": "^19.0.0",
    "react-dom": "^19.0.0",
    "zod": "^4.4.3"
  },
  "devDependencies": {
    "@testing-library/react": "^16.1.0",
    "@types/react": "^19.0.0",
    "@types/react-dom": "^19.0.0",
    "esbuild": "^0.25.0",
    "jsdom": "^25.0.0",
    "typescript": "^6",
    "vitest": "^3"
  }
}
```

- [ ] **Step 3: Create the console tsconfig (noEmit; esbuild is the bundler)**

`packages/console/tsconfig.json`:
```json
{
  "compilerOptions": {
    "target": "es2022",
    "module": "esnext",
    "moduleResolution": "bundler",
    "lib": ["es2022", "dom", "dom.iterable"],
    "jsx": "react-jsx",
    "strict": true,
    "noEmit": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "types": ["node"]
  },
  "include": ["src", "build-client.mjs"]
}
```

- [ ] **Step 4: Create the vitest config (jsdom)**

`packages/console/vitest.config.ts`:
```ts
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "jsdom",
    include: ["src/**/*.test.{ts,tsx}"],
    watch: false,
  },
});
```

- [ ] **Step 5: Install the workspace**

Run: `pnpm install`
Expected: resolves the new `@agentgem/console` member and installs react/esbuild/vitest into the workspace. No errors.

- [ ] **Step 6: Write the failing test**

`packages/console/src/__tests__/registry.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { defineConsolePage, sortedPages } from "../registry.js";

const page = (id: string, order: number) =>
  defineConsolePage({ id, title: id, order, route: `#/${id}`, component: () => null });

describe("sortedPages", () => {
  it("sorts pages ascending by order", () => {
    const out = sortedPages([page("b", 20), page("a", 10)]);
    expect(out.map((p) => p.id)).toEqual(["a", "b"]);
  });

  it("throws on duplicate id", () => {
    expect(() => sortedPages([page("a", 10), page("a", 20)])).toThrow(/duplicate/i);
  });
});
```

- [ ] **Step 7: Run the test to verify it fails**

Run: `pnpm -F @agentgem/console test`
Expected: FAIL — `Cannot find module '../registry.js'`.

- [ ] **Step 8: Write the contract and registry**

`packages/console/src/contract.ts`:
```ts
import type { ReactNode } from "react";

export interface ConsolePage {
  id: string;
  title: string;
  icon?: string;
  order: number;
  /** Hash route, e.g. '#/ledger'. */
  route: string;
  component: (props: { apiBase: string }) => ReactNode;
}

export const defineConsolePage = (p: ConsolePage): ConsolePage => p;
```

`packages/console/src/registry.ts`:
```ts
import type { ConsolePage } from "./contract.js";
export { defineConsolePage } from "./contract.js";
export type { ConsolePage } from "./contract.js";

/** Sort pages for the sidebar; reject duplicate ids (a wiring mistake). */
export function sortedPages(pages: ConsolePage[]): ConsolePage[] {
  const seen = new Set<string>();
  for (const p of pages) {
    if (seen.has(p.id)) throw new Error(`duplicate ConsolePage id: ${p.id}`);
    seen.add(p.id);
  }
  return [...pages].sort((a, b) => a.order - b.order);
}
```

- [ ] **Step 9: Run the test to verify it passes**

Run: `pnpm -F @agentgem/console test`
Expected: PASS (2 tests).

- [ ] **Step 10: Commit**

```bash
git add pnpm-workspace.yaml packages/console pnpm-lock.yaml
git -c user.name="Raymond Feng" -c user.email="raymond@ninemind.ai" commit -m "feat(console): workspace scaffold + ConsolePage composition contract

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 2: API routes (@agentback/client) + Ledger data utilities

A typed route module (minimal client-side Zod schemas) plus pure functions that shape the validated payloads — isolated from React so the logic is tested directly.

**Files:**
- Create: `packages/console/src/api/routes.ts`
- Create: `packages/console/src/panels/Ledger/data.ts`
- Test: `packages/console/src/panels/Ledger/data.test.ts`

**Interfaces:**
- Consumes: `@agentback/client` (`defineRoute`, `createClient`), `zod`.
- Produces (`api/routes.ts`):
  - `InventorySchema`, `UsageSchema` (minimal Zod; validate only fields the panel reads).
  - Inferred types `Inventory = z.infer<typeof InventorySchema>`, `Usage = z.infer<typeof UsageSchema>`, `Artifact`, `UsageItem`.
  - `inventoryRoute` = `defineRoute('GET', '/api/inventory', { response: InventorySchema })`, `usageRoute` = `defineRoute('GET', '/api/usage', { response: UsageSchema })`.
  - `makeClient(apiBase: string): Client` = `createClient({ baseURL: apiBase })`.
- Produces (`Ledger/data.ts`):
  - `LedgerGroup = { key: string; label: string; items: LedgerItem[] }`, `LedgerItem = { name: string; invocations: number }`.
  - `groupInventory(inv: Inventory): LedgerGroup[]` — one group per category (skills, mcpServers, instructions, hooks) in that fixed order; omits empty groups.
  - `mergeUsage(groups: LedgerGroup[], usage: Usage): LedgerGroup[]` — attaches `invocations` by matching usage `name` within the category's `type`; defaults to 0.
  - Category→usage-type + labels: `skills`→`skill` "Skills", `mcpServers`→`mcpServer` "MCP Servers", `instructions`→`instructions` "Instructions", `hooks`→`hook` "Hooks".

- [ ] **Step 0: Create the typed route module**

`packages/console/src/api/routes.ts`:
```ts
import { z } from "zod";
import { createClient, defineRoute, type Client } from "@agentback/client";

// Minimal client-side schemas: validate ONLY what the UI reads. Zod strips the
// server's extra artifact fields. When a shared browser-safe contract package is
// extracted later, replace these with imports from it.
const ArtifactSchema = z.object({ name: z.string() });
export const InventorySchema = z.object({
  skills: z.array(ArtifactSchema),
  mcpServers: z.array(ArtifactSchema),
  instructions: z.array(ArtifactSchema),
  hooks: z.array(ArtifactSchema),
  projects: z.array(z.unknown()).optional(),
});
const UsageItemSchema = z.object({ type: z.string(), name: z.string(), invocations: z.number() });
export const UsageSchema = z.object({ artifacts: z.array(UsageItemSchema) });

export type Artifact = z.infer<typeof ArtifactSchema>;
export type Inventory = z.infer<typeof InventorySchema>;
export type UsageItem = z.infer<typeof UsageItemSchema>;
export type Usage = z.infer<typeof UsageSchema>;

export const inventoryRoute = defineRoute("GET", "/api/inventory", { response: InventorySchema });
export const usageRoute = defineRoute("GET", "/api/usage", { response: UsageSchema });

export const makeClient = (apiBase: string): Client => createClient({ baseURL: apiBase });
```

- [ ] **Step 1: Write the failing test**

`packages/console/src/panels/Ledger/data.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { groupInventory, mergeUsage } from "./data.js";

const inv = {
  skills: [{ name: "pdf" }, { name: "csv" }],
  mcpServers: [{ name: "github" }],
  instructions: [],
  hooks: [],
};

const usage = {
  artifacts: [
    { type: "skill", name: "pdf", root: null, invocations: 5, sessionsUsedIn: 2, lastUsedMs: 1 },
    { type: "mcpServer", name: "github", root: null, invocations: 9, sessionsUsedIn: 3, lastUsedMs: 2 },
  ],
};

describe("groupInventory", () => {
  it("makes one group per non-empty category in fixed order", () => {
    const groups = groupInventory(inv as any);
    expect(groups.map((g) => g.key)).toEqual(["skills", "mcpServers"]);
    expect(groups[0].label).toBe("Skills");
    expect(groups[0].items.map((i) => i.name)).toEqual(["pdf", "csv"]);
  });
});

describe("mergeUsage", () => {
  it("attaches invocations by name within the category type, default 0", () => {
    const groups = mergeUsage(groupInventory(inv as any), usage as any);
    const pdf = groups[0].items.find((i) => i.name === "pdf")!;
    const csv = groups[0].items.find((i) => i.name === "csv")!;
    expect(pdf.invocations).toBe(5);
    expect(csv.invocations).toBe(0);
    expect(groups[1].items[0].invocations).toBe(9);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm -F @agentgem/console test`
Expected: FAIL — `Cannot find module './data.js'`.

- [ ] **Step 3: Write the implementation**

`packages/console/src/panels/Ledger/data.ts`:
```ts
import type { Inventory, Usage } from "../../api/routes.js";

export interface LedgerItem { name: string; invocations: number }
export interface LedgerGroup { key: string; label: string; items: LedgerItem[] }

type InventoryCategory = "skills" | "mcpServers" | "instructions" | "hooks";

/** Inventory category -> usage `type` + sidebar label, in display order. */
const CATEGORIES: { key: InventoryCategory; type: string; label: string }[] = [
  { key: "skills", type: "skill", label: "Skills" },
  { key: "mcpServers", type: "mcpServer", label: "MCP Servers" },
  { key: "instructions", type: "instructions", label: "Instructions" },
  { key: "hooks", type: "hook", label: "Hooks" },
];

export function groupInventory(inv: Inventory): LedgerGroup[] {
  return CATEGORIES
    .map(({ key, label }) => ({
      key,
      label,
      items: (inv[key] ?? []).map((a) => ({ name: a.name, invocations: 0 })),
    }))
    .filter((g) => g.items.length > 0);
}

export function mergeUsage(groups: LedgerGroup[], usage: Usage): LedgerGroup[] {
  const typeOf = new Map(CATEGORIES.map((c) => [c.key, c.type]));
  return groups.map((g) => {
    const type = typeOf.get(g.key as InventoryCategory);
    const counts = new Map(
      usage.artifacts.filter((u) => u.type === type).map((u) => [u.name, u.invocations]),
    );
    return { ...g, items: g.items.map((i) => ({ ...i, invocations: counts.get(i.name) ?? 0 })) };
  });
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm -F @agentgem/console test`
Expected: PASS (4 tests total).

- [ ] **Step 5: Commit**

```bash
git add packages/console/src/api packages/console/src/panels/Ledger
git -c user.name="Raymond Feng" -c user.email="raymond@ninemind.ai" commit -m "feat(console): typed @agentback/client routes + Ledger data utils

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 3: Ledger panel component + register in pages

**Files:**
- Create: `packages/console/src/panels/Ledger/index.tsx`
- Create: `packages/console/src/pages.tsx`
- Test: `packages/console/src/panels/Ledger/Ledger.test.tsx`

**Interfaces:**
- Consumes: `groupInventory`, `mergeUsage` (Task 2); `defineConsolePage` (Task 1).
- Produces: `Ledger({ apiBase }: { apiBase: string }): JSX.Element`, `ledgerPage: ConsolePage` (id `ledger`, order 10, route `#/ledger`, title "Ledger"), and `pages: ConsolePage[]` (the registry, initially `[ledgerPage]`).

- [ ] **Step 1: Write the failing test**

`packages/console/src/panels/Ledger/Ledger.test.tsx`:
```tsx
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import { Ledger } from "./index.js";

afterEach(cleanup);

// @agentback/client parses responses via `response.text()` + JSON.parse and
// reads `ok`/`status` — so the stub only needs those.
const res = (body: unknown) =>
  ({ ok: true, status: 200, text: async () => JSON.stringify(body) }) as unknown as Response;

function mockFetch() {
  return vi.fn(async (url: string | URL) => {
    const u = String(url);
    if (u.includes("/api/inventory"))
      return res({ skills: [{ name: "pdf" }], mcpServers: [], instructions: [], hooks: [] });
    if (u.includes("/api/usage"))
      return res({ artifacts: [{ type: "skill", name: "pdf", invocations: 7 }] });
    throw new Error(`unexpected url ${u}`);
  });
}

describe("Ledger", () => {
  it("renders the inventory grouped, with usage badges", async () => {
    vi.stubGlobal("fetch", mockFetch());
    render(<Ledger apiBase="" />);
    expect(await screen.findByText("Skills")).toBeTruthy();
    expect(await screen.findByText("pdf")).toBeTruthy();
    expect(await screen.findByText("7")).toBeTruthy();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm -F @agentgem/console test`
Expected: FAIL — `Cannot find module './index.js'`.

- [ ] **Step 3: Write the panel component**

`packages/console/src/panels/Ledger/index.tsx`:
```tsx
import { useEffect, useState } from "react";
import { defineConsolePage } from "../../registry.js";
import { inventoryRoute, usageRoute, makeClient, type Usage } from "../../api/routes.js";
import { groupInventory, mergeUsage, type LedgerGroup } from "./data.js";

export function Ledger({ apiBase }: { apiBase: string }) {
  const [groups, setGroups] = useState<LedgerGroup[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    const client = makeClient(apiBase);
    (async () => {
      try {
        const inv = await inventoryRoute.call(client);
        let usage: Usage = { artifacts: [] };
        try { usage = await usageRoute.call(client); } catch { /* usage badges are optional */ }
        if (alive) setGroups(mergeUsage(groupInventory(inv), usage));
      } catch (e) {
        if (alive) setError(e instanceof Error ? e.message : String(e));
      }
    })();
    return () => { alive = false; };
  }, [apiBase]);

  if (error) return <p className="ledger-error">Could not load inventory: {error}</p>;
  if (!groups) return <p className="ledger-loading">Loading…</p>;
  if (groups.length === 0) return <p className="ledger-empty">No artifacts found.</p>;

  return (
    <div className="ledger">
      {groups.map((g) => (
        <section className="ledger-group" key={g.key}>
          <h2 className="ledger-group-label">{g.label}</h2>
          <ul className="ledger-items">
            {g.items.map((i) => (
              <li className="ledger-item" key={i.name}>
                <span className="ledger-item-name">{i.name}</span>
                <span className="ledger-badge" title="invocations">{i.invocations}</span>
              </li>
            ))}
          </ul>
        </section>
      ))}
    </div>
  );
}

export const ledgerPage = defineConsolePage({
  id: "ledger",
  title: "Ledger",
  icon: "◆",
  order: 10,
  route: "#/ledger",
  component: ({ apiBase }) => <Ledger apiBase={apiBase} />,
});
```

- [ ] **Step 4: Create the page registry**

`packages/console/src/pages.tsx`:
```tsx
// The composable seam: add a screen with one import + one array entry.
import type { ConsolePage } from "./registry.js";
import { ledgerPage } from "./panels/Ledger/index.js";

export const pages: ConsolePage[] = [ledgerPage];
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `pnpm -F @agentgem/console test`
Expected: PASS (5 tests total).

- [ ] **Step 6: Commit**

```bash
git add packages/console/src/panels/Ledger/index.tsx packages/console/src/panels/Ledger/Ledger.test.tsx packages/console/src/pages.tsx
git -c user.name="Raymond Feng" -c user.email="raymond@ninemind.ai" commit -m "feat(console): Ledger panel + page registry

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 4: Shell (sidebar + hash routing + theme) + SPA entry

**Files:**
- Create: `packages/console/src/shell/Shell.tsx`
- Create: `packages/console/src/shell/theme.css`
- Create: `packages/console/src/main.tsx`
- Test: `packages/console/src/shell/Shell.test.tsx`

**Interfaces:**
- Consumes: `sortedPages` (Task 1), `pages` (Task 3).
- Produces: `Shell({ pages, apiBase }: { pages: ConsolePage[]; apiBase: string }): JSX.Element` — renders a `<nav>` with a button per page (titles in `order`), and the active page's component. Active page = the one whose `route` equals `window.location.hash`, falling back to the first page. Updates on `hashchange`.

- [ ] **Step 1: Write the failing test**

`packages/console/src/shell/Shell.test.tsx`:
```tsx
import { describe, it, expect, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent, act } from "@testing-library/react";
import { Shell } from "./Shell.js";
import { defineConsolePage } from "../registry.js";

afterEach(() => { cleanup(); window.location.hash = ""; });

const pages = [
  defineConsolePage({ id: "a", title: "Alpha", order: 10, route: "#/a", component: () => <p>panel-a</p> }),
  defineConsolePage({ id: "b", title: "Beta", order: 20, route: "#/b", component: () => <p>panel-b</p> }),
];

describe("Shell", () => {
  it("lists nav items in order and renders the first panel by default", () => {
    render(<Shell pages={pages} apiBase="" />);
    const labels = screen.getAllByRole("button").map((b) => b.textContent);
    expect(labels).toEqual(["Alpha", "Beta"]);
    expect(screen.getByText("panel-a")).toBeTruthy();
  });

  it("switches panel on hashchange", () => {
    render(<Shell pages={pages} apiBase="" />);
    act(() => { window.location.hash = "#/b"; window.dispatchEvent(new HashChangeEvent("hashchange")); });
    expect(screen.getByText("panel-b")).toBeTruthy();
  });

  it("navigates when a nav button is clicked", () => {
    render(<Shell pages={pages} apiBase="" />);
    fireEvent.click(screen.getByText("Beta"));
    expect(window.location.hash).toBe("#/b");
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm -F @agentgem/console test`
Expected: FAIL — `Cannot find module './Shell.js'`.

- [ ] **Step 3: Write the Shell**

`packages/console/src/shell/Shell.tsx`:
```tsx
import { useEffect, useState } from "react";
import { sortedPages, type ConsolePage } from "../registry.js";

export function Shell({ pages, apiBase }: { pages: ConsolePage[]; apiBase: string }) {
  const ordered = sortedPages(pages);
  const [hash, setHash] = useState(() => window.location.hash);

  useEffect(() => {
    const onHash = () => setHash(window.location.hash);
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);

  const active = ordered.find((p) => p.route === hash) ?? ordered[0];

  return (
    <div className="console">
      <nav className="console-nav">
        <div className="console-brand">AgentGem</div>
        {ordered.map((p) => (
          <button
            key={p.id}
            className={"console-nav-item" + (p === active ? " is-active" : "")}
            onClick={() => { window.location.hash = p.route; }}
          >
            {p.icon ? <span className="console-nav-icon">{p.icon}</span> : null}
            {p.title}
          </button>
        ))}
      </nav>
      <main className="console-main">{active?.component({ apiBase })}</main>
    </div>
  );
}
```

- [ ] **Step 4: Write the theme CSS (ported warm-paper tokens)**

`packages/console/src/shell/theme.css`:
```css
:root {
  --paper: #f4efe3;
  --ink: #211c15;
  --accent: #9a3324;
  --muted: #6b6354;
  --line: #d9cfbb;
  --raised: #fbf8f1;
}
* { box-sizing: border-box; }
body { margin: 0; background: var(--paper); color: var(--ink);
  font: 14px/1.5 ui-sans-serif, system-ui, -apple-system, sans-serif; }
.console { display: grid; grid-template-columns: 220px 1fr; min-height: 100vh; }
.console-nav { border-right: 1px solid var(--line); padding: 16px 8px;
  display: flex; flex-direction: column; gap: 4px; background: var(--raised); }
.console-brand { font-weight: 700; color: var(--accent); padding: 8px; letter-spacing: .02em; }
.console-nav-item { display: flex; align-items: center; gap: 8px; width: 100%;
  background: none; border: 0; text-align: left; padding: 8px; border-radius: 6px;
  color: var(--ink); cursor: pointer; font: inherit; }
.console-nav-item:hover { background: rgba(0,0,0,.04); }
.console-nav-item.is-active { background: var(--paper); color: var(--accent); font-weight: 600; }
.console-main { padding: 24px 28px; }
.ledger-group { margin-bottom: 24px; }
.ledger-group-label { font-size: 12px; text-transform: uppercase; letter-spacing: .06em;
  color: var(--muted); margin: 0 0 8px; }
.ledger-items { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 2px; }
.ledger-item { display: flex; align-items: center; justify-content: space-between;
  padding: 6px 10px; border: 1px solid var(--line); border-radius: 6px; background: var(--raised); }
.ledger-badge { font-variant-numeric: tabular-nums; color: var(--muted); font-size: 12px;
  background: var(--paper); border: 1px solid var(--line); border-radius: 999px; padding: 0 8px; }
.ledger-loading, .ledger-empty, .ledger-error { color: var(--muted); }
.ledger-error { color: var(--accent); }
```

- [ ] **Step 5: Write the SPA entry**

`packages/console/src/main.tsx`:
```tsx
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { Shell } from "./shell/Shell.js";
import { pages } from "./pages.js";
import "./shell/theme.css";

const el = document.getElementById("root");
if (el) createRoot(el).render(<StrictMode><Shell pages={pages} apiBase="" /></StrictMode>);
```

- [ ] **Step 6: Run the test to verify it passes**

Run: `pnpm -F @agentgem/console test`
Expected: PASS (8 tests total).

- [ ] **Step 7: Commit**

```bash
git add packages/console/src/shell packages/console/src/main.tsx
git -c user.name="Raymond Feng" -c user.email="raymond@ninemind.ai" commit -m "feat(console): shell (sidebar + hash routing), warm-paper theme, SPA entry

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 5: esbuild build → self-contained `index.html`

**Files:**
- Create: `packages/console/build-client.mjs`
- Test: `packages/console/src/__tests__/build.test.ts`

**Interfaces:**
- Produces: running `node build-client.mjs` (cwd `packages/console`) writes `packages/console/dist/index.html` — one self-contained file with the bundled JS and CSS inlined and a `<div id="root"></div>` mount node.

- [ ] **Step 1: Write the build script**

`packages/console/build-client.mjs`:
```js
// Bundle the console SPA into ONE self-contained dist/index.html: esbuild bundles
// main.tsx (JS + imported CSS) into memory, then we inline both into an HTML
// shell. A single file means the agentgem server serves it with one route
// (readFileSync), exactly like the vanilla index.html — no static middleware.
import { build } from "esbuild";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const out = join(here, "dist");

const result = await build({
  entryPoints: [join(here, "src", "main.tsx")],
  bundle: true,
  format: "esm",
  target: "es2022",
  jsx: "automatic",
  minify: true,
  write: false,
  loader: { ".css": "css" },
  outdir: out,
});

let js = "";
let css = "";
for (const f of result.outputFiles) {
  if (f.path.endsWith(".js")) js = f.text;
  else if (f.path.endsWith(".css")) css = f.text;
}

const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>AgentGem Console</title>
<style>${css}</style>
</head>
<body>
<div id="root"></div>
<script type="module">${js}</script>
</body>
</html>
`;

mkdirSync(out, { recursive: true });
writeFileSync(join(out, "index.html"), html);
console.log(`[console] wrote ${join(out, "index.html")} (${html.length} bytes)`);
```

- [ ] **Step 2: Write the failing test**

`packages/console/src/__tests__/build.test.ts`:
```ts
import { describe, it, expect, beforeAll } from "vitest";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const pkg = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

describe("build-client", () => {
  beforeAll(() => { execFileSync("node", ["build-client.mjs"], { cwd: pkg }); }, 60000);

  it("emits a self-contained index.html with the mount node and bundle", () => {
    const html = readFileSync(join(pkg, "dist", "index.html"), "utf8");
    expect(html).toContain('<div id="root"></div>');
    expect(html).toContain("<script type=\"module\">");
    expect(html.length).toBeGreaterThan(1000);
  });
});
```

- [ ] **Step 3: Run the test to verify it fails, then passes**

Run: `pnpm -F @agentgem/console test`
Expected: the test runs the build in `beforeAll`; PASS (9 tests total). If `dist/index.html` were missing the build would have thrown — confirm the assertion passes.

- [ ] **Step 4: Ignore the build output**

Append to `packages/console/.gitignore` (create it):
```
dist/
node_modules/
```

- [ ] **Step 5: Commit**

```bash
git add packages/console/build-client.mjs packages/console/src/__tests__/build.test.ts packages/console/.gitignore
git -c user.name="Raymond Feng" -c user.email="raymond@ninemind.ai" commit -m "feat(console): esbuild self-contained index.html build

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 6: Root build wiring — copy console into `dist/public/console/`

**Files:**
- Create: `scripts/build-console.mjs`
- Modify: `package.json` (root `build` script)
- Test: `scripts/__tests__/build-console.test.mjs` (a standalone node assertion; not part of the compiled vitest suite)

**Interfaces:**
- Consumes: `packages/console` build output (Task 5).
- Produces: after the root `build`, `dist/public/console/index.html` exists. The root `build` script runs the console build then copies its `dist/index.html` to `dist/public/console/index.html`.

- [ ] **Step 1: Write the copy script**

`scripts/build-console.mjs`:
```js
// Build the @agentgem/console SPA and fold its single index.html into the root
// dist/public/console/ — the only place both `npx`/`-g` (files:["dist"]) and the
// desktop bundle (cpSync dist/public) look. The console package is private and
// never a runtime dep; only this built HTML ships.
import { execFileSync } from "node:child_process";
import { mkdirSync, copyFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const pkg = join(root, "packages", "console");

execFileSync("node", ["build-client.mjs"], { cwd: pkg, stdio: "inherit" });

const dest = join(root, "dist", "public", "console");
mkdirSync(dest, { recursive: true });
copyFileSync(join(pkg, "dist", "index.html"), join(dest, "index.html"));
console.log(`[build-console] copied console SPA -> ${join(dest, "index.html")}`);
```

- [ ] **Step 2: Wire it into the root build**

Modify `package.json` `scripts.build` (currently `tsc -b && node scripts/check-inline-js.mjs && node scripts/copy-public.mjs`):
```json
"build": "tsc -b && node scripts/check-inline-js.mjs && node scripts/copy-public.mjs && node scripts/build-console.mjs",
```

- [ ] **Step 3: Write the failing test**

`scripts/__tests__/build-console.test.mjs`:
```js
// Standalone packaging-invariant check (run via `node`, not the compiled vitest
// suite). Guards that the build emits the console SPA where npx + desktop expect it.
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
execFileSync("pnpm", ["build"], { cwd: root, stdio: "inherit" });
assert.ok(existsSync(join(root, "dist", "public", "console", "index.html")),
  "dist/public/console/index.html must exist after pnpm build");
console.log("[build-console.test] OK — console SPA present in dist/public/console");
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `node scripts/__tests__/build-console.test.mjs`
Expected: runs `pnpm build` (tsc + guards + copy-public + build-console), then prints `OK`. Exit 0.

- [ ] **Step 5: Commit**

```bash
git add scripts/build-console.mjs scripts/__tests__/build-console.test.mjs package.json
git -c user.name="Raymond Feng" -c user.email="raymond@ninemind.ai" commit -m "build: fold @agentgem/console SPA into dist/public/console (npx + desktop)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 7: Server mount at `/console`

**Files:**
- Modify: `src/index.ts` (add a `consoleHtml()` loader + a `get("/console")` route)
- Test: `src/__tests__/consoleMount.test.ts`

**Interfaces:**
- Consumes: the built `dist/public/console/index.html` (Task 6), with a dev fallback to `packages/console/dist/index.html`.
- Produces: `GET /console` → 200, `text/html`, behind `originGuard`. `/` is unchanged.

- [ ] **Step 1: Write the failing test**

`src/__tests__/consoleMount.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import request from "supertest";
import { createApp } from "../index.js";

describe("GET /console", () => {
  it("serves the console SPA as html, same-origin", async () => {
    const app = await createApp(0);
    const server = await app.restServer;
    const res = await request(server.expressApp).get("/console").set("Host", "127.0.0.1");
    expect(res.status).toBe(200);
    expect(res.type).toMatch(/html/);
    expect(res.text).toContain('<div id="root"></div>');
  });
});
```

Note: this is a root-suite test — it compiles to `dist/src/__tests__/consoleMount.test.js` and runs under the root vitest `include`. It requires `dist/public/console/index.html`, produced by Task 6's build. Run the root build before this test (the `test` script's `tsc -b` does not run `build-console`, so build first).

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm build && pnpm vitest run dist/src/__tests__/consoleMount.test.js`
Expected: FAIL — 404 (no `/console` route yet).

- [ ] **Step 3: Add the loader + route to `src/index.ts`**

After the existing `pageHtml()` function (around line 30), add:
```ts
function consoleHtml(): string {
  for (const p of [
    join(here, "public", "console", "index.html"),
    join(here, "..", "packages", "console", "dist", "index.html"),
  ]) {
    try { return readFileSync(p, "utf8"); } catch { /* try next */ }
  }
  return '<!doctype html><div id="root"></div><p>console not built — run pnpm build</p>';
}
```

Inside `createApp`, after the `server.expressApp.get("/", …)` line (line 47), add:
```ts
const consolePage = consoleHtml();
server.expressApp.get("/console", originGuard, (_req, res) => res.type("html").send(consolePage));
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm build && pnpm vitest run dist/src/__tests__/consoleMount.test.js`
Expected: PASS.

- [ ] **Step 5: Run the full root suite to check for regressions**

Run: `pnpm test`
Expected: all existing tests + the new mount test PASS. (Reminder from project memory: if anything looks stale, `pnpm clean && pnpm build` then re-run, since vitest runs compiled `dist` tests.)

- [ ] **Step 6: Commit**

```bash
git add src/index.ts src/__tests__/consoleMount.test.ts
git -c user.name="Raymond Feng" -c user.email="raymond@ninemind.ai" commit -m "feat: mount @agentgem/console SPA at /console (parallel to vanilla /)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Final verification

- [ ] `pnpm build` succeeds and `dist/public/console/index.html` exists.
- [ ] `pnpm test` (root) is green, including `consoleMount.test`.
- [ ] `pnpm -F @agentgem/console test` is green (registry, data, Ledger, Shell, build).
- [ ] `node dist/index.js` then open `http://127.0.0.1:4317/console` → Ledger renders real inventory with usage badges; `http://127.0.0.1:4317/` still serves the vanilla UI.
- [ ] `pnpm pack --dry-run` lists `dist/public/console/index.html` and does NOT list `packages/console` sources (private package not published).

## Self-review notes (coverage map)

- Spec "workspace + private console package" → Task 1.
- Spec "composition contract / pages.tsx seam" → Tasks 1 + 3.
- Spec "first read-only Ledger panel against /api/inventory + /api/usage" → Tasks 2 + 3.
- Spec "shell + warm-paper theme ported locally" → Task 4.
- Spec "esbuild single SPA" → Task 5.
- Spec "build-time asset producer into dist/public/console; npx + desktop unchanged" → Task 6 (+ pack check in Final verification).
- Spec "mount /console parallel to /, behind originGuard" → Task 7.
- Spec testing (registry shape, Ledger render vs mocked fetch, packaging invariant) → Tasks 1, 3, 6.
