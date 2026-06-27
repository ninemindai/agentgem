# React UI Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stand up a standalone Vite + React + TypeScript app under `web/` that builds, runs, renders the warm-paper agentgem shell, and fetches one real backend endpoint through a dev proxy — the foundation for the React UI migration.

**Architecture:** A self-contained `web/` Vite project (its own package.json/tsconfig/node_modules), strict TS, with a `/api` dev proxy to the existing backend (port 4317). The Express server and the live vanilla UI are NOT touched (parallel-build strategy; cutover is a later sub-project). Ported design tokens make the shell already look like agentgem.

**Tech Stack:** Vite, React 19, TypeScript (strict), Vitest + @testing-library/react + jsdom.

## Global Constraints

- Spec: `docs/superpowers/specs/2026-06-27-react-ui-foundation-design.md`.
- Git identity every commit: `Raymond Feng <raymond@ninemind.ai>`; message ends with `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`.
- All new code is **strict TypeScript** (`"strict": true` in `web/tsconfig.json`) — this is the point of the rewrite.
- **Do not modify any file outside `web/`.** The backend, `src/`, root `package.json`/`tsconfig.json`, and `src/public/index.html` stay exactly as they are (parallel build; server untouched).
- The backend default port is **4317**; the dev proxy targets `http://127.0.0.1:4317`.
- API contract is fixed — call the existing `/api/*` endpoints; do not change them.
- Commands run inside `web/` use that project's own `npm` (separate from the root pnpm project).

---

### Task 1: Scaffold the `web/` Vite + React + TS app

**Files:**
- Create: `web/package.json`, `web/tsconfig.json`, `web/tsconfig.node.json`, `web/vite.config.ts`, `web/index.html`, `web/src/main.tsx`, `web/src/App.tsx`, `web/src/styles/tokens.css`, `web/.gitignore`

**Interfaces:**
- Produces: a buildable Vite app whose `App` component renders the agentgem header. Later tasks import `App` from `web/src/App.tsx` and add an API call.

- [ ] **Step 1: Create `web/package.json`**

```json
{
  "name": "agentgem-web",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "vite",
    "build": "tsc -b && vite build",
    "preview": "vite preview",
    "test": "vitest run"
  },
  "dependencies": {
    "react": "^19.0.0",
    "react-dom": "^19.0.0"
  },
  "devDependencies": {
    "@types/react": "^19.0.0",
    "@types/react-dom": "^19.0.0",
    "@vitejs/plugin-react": "^4.3.0",
    "typescript": "^5.6.0",
    "vite": "^6.0.0",
    "vitest": "^2.1.0",
    "jsdom": "^25.0.0",
    "@testing-library/react": "^16.1.0",
    "@testing-library/jest-dom": "^6.6.0"
  }
}
```
(If `npm install` resolves newer compatible majors, accept them — pin only if something breaks.)

- [ ] **Step 2: Create `web/tsconfig.json` (strict, DOM)**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "useDefineForClassFields": true,
    "lib": ["ES2022", "DOM", "DOM.Iterable"],
    "module": "ESNext",
    "moduleResolution": "bundler",
    "jsx": "react-jsx",
    "strict": true,
    "noUnusedLocals": true,
    "noUnusedParameters": true,
    "noFallthroughCasesInSwitch": true,
    "skipLibCheck": true,
    "types": ["vitest/globals", "@testing-library/jest-dom"],
    "noEmit": true
  },
  "include": ["src"],
  "references": [{ "path": "./tsconfig.node.json" }]
}
```

- [ ] **Step 3: Create `web/tsconfig.node.json` (for vite.config.ts)**

```json
{
  "compilerOptions": {
    "composite": true,
    "module": "ESNext",
    "moduleResolution": "bundler",
    "allowSyntheticDefaultImports": true,
    "strict": true,
    "skipLibCheck": true
  },
  "include": ["vite.config.ts"]
}
```

- [ ] **Step 4: Create `web/vite.config.ts` (React plugin + /api dev proxy + vitest)**

```ts
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      // Proxy API calls to the running backend so the browser only talks to the
      // Vite origin. changeOrigin rewrites Host/Origin so the backend originGuard
      // accepts the request as same-origin.
      "/api": { target: "http://127.0.0.1:4317", changeOrigin: true },
    },
  },
  test: {
    globals: true,
    environment: "jsdom",
    setupFiles: ["./src/test/setup.ts"],
  },
});
```

- [ ] **Step 5: Create `web/index.html` (Vite entry)**

```html
<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>🐴 agentgem — Gem Builder</title>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/src/main.tsx"></script>
  </body>
</html>
```

- [ ] **Step 6: Create `web/src/styles/tokens.css` (ported design tokens + base)**

Copy the `:root` custom properties and base element styles **verbatim** from the `<style>` block in `src/public/index.html` (the warm-paper tokens: `--paper:#f4efe3; --paper-2:#efe8d8; --card:#fbf8f1; --ink:#211c15; --line:#ddd2bb; --accent:#9a3324;` plus `--muted`, the `--ui`/`--display` font vars, and `--r`, and the `body { background; color; font }` base). Read them from `src/public/index.html` and reproduce exactly so ported screens match. Begin the file with:

```css
/* Design tokens + base, ported verbatim from src/public/index.html <style>. */
:root {
  /* ...copy the exact --paper / --ink / --accent / fonts / radius vars... */
}
/* ...copy the base body/element rules... */
```

- [ ] **Step 7: Create `web/src/App.tsx` (static shell — header only for now)**

```tsx
export function App() {
  return (
    <header style={{ display: "flex", alignItems: "center", gap: 10, padding: "12px 16px" }}>
      <svg className="mark" viewBox="0 0 40 40" width={28} height={28} aria-hidden="true">
        <path d="M20 2 L36 14 L20 38 L4 14 Z" fill="#9a3324" />
      </svg>
      <h1 style={{ font: "600 18px/1 var(--display, system-ui)", margin: 0 }}>agentgem</h1>
      <span style={{ fontSize: 12, color: "var(--muted, #6b6256)" }}>Gem Builder</span>
    </header>
  );
}
```

- [ ] **Step 8: Create `web/src/main.tsx`**

```tsx
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App.tsx";
import "./styles/tokens.css";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
```

- [ ] **Step 9: Create `web/.gitignore`**

```
node_modules
dist
```

- [ ] **Step 10: Install and build**

Run: `cd web && npm install && npm run build`
Expected: install succeeds; `npm run build` (tsc strict + vite) completes with no errors and produces `web/dist/`.

- [ ] **Step 11: Commit**

```bash
git add web/package.json web/package-lock.json web/tsconfig.json web/tsconfig.node.json web/vite.config.ts web/index.html web/src/main.tsx web/src/App.tsx web/src/styles/tokens.css web/.gitignore
git -c user.name="Raymond Feng" -c user.email="raymond@ninemind.ai" commit -m "feat(web): scaffold Vite + React + strict TS app shell with ported design tokens

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 2: Test harness (Vitest + React Testing Library)

**Files:**
- Create: `web/src/test/setup.ts`, `web/src/__tests__/App.test.tsx`

**Interfaces:**
- Consumes: `App` from `web/src/App.tsx` (Task 1).
- Produces: a working `npm test` (Vitest + jsdom + RTL) — the pattern every later screen port follows.

- [ ] **Step 1: Create the test setup `web/src/test/setup.ts`**

```ts
import "@testing-library/jest-dom/vitest";
```

- [ ] **Step 2: Write the failing test `web/src/__tests__/App.test.tsx`**

```tsx
import { render, screen } from "@testing-library/react";
import { App } from "../App.tsx";

test("renders the agentgem header", () => {
  render(<App />);
  expect(screen.getByRole("heading", { name: "agentgem" })).toBeInTheDocument();
  expect(screen.getByText("Gem Builder")).toBeInTheDocument();
});
```

- [ ] **Step 3: Run the test to verify the harness works**

Run: `cd web && npm test`
Expected: PASS (the header already renders from Task 1). If the run errors on config (jsdom/setup not wired), fix `vite.config.ts` `test` block / `setup.ts` until the test runs and passes. The deliverable is a green `npm test`.

- [ ] **Step 4: Commit**

```bash
git add web/src/test/setup.ts web/src/__tests__/App.test.tsx
git -c user.name="Raymond Feng" -c user.email="raymond@ninemind.ai" commit -m "test(web): Vitest + RTL harness with App shell render test

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 3: Typed API client + shell fetches a real endpoint

**Files:**
- Create: `web/src/api/types.ts`, `web/src/api/client.ts`
- Modify: `web/src/App.tsx` (fetch + render an inventory count), `web/src/__tests__/App.test.tsx` (mock the client)

**Interfaces:**
- Consumes: `App` (Task 1), the test harness (Task 2).
- Produces:
  - `fetchJson<T>(path: string, init?: RequestInit): Promise<T>` in `web/src/api/client.ts`
  - `getInventory(): Promise<InventoryResponse>` in `web/src/api/client.ts`
  - `InventoryResponse` in `web/src/api/types.ts` (`{ skills: unknown[]; mcpServers: unknown[]; instructions: unknown[]; hooks: unknown[] }`)

- [ ] **Step 1: Create `web/src/api/types.ts`**

```ts
// Hand-authored response shapes for the endpoints the foundation touches.
// (Roadmap: generate from the backend @agentback/openapi spec at the first screen port.)
export interface InventoryResponse {
  skills: unknown[];
  mcpServers: unknown[];
  instructions: unknown[];
  hooks: unknown[];
}
```

- [ ] **Step 2: Create `web/src/api/client.ts`**

```ts
import type { InventoryResponse } from "./types.ts";

export async function fetchJson<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, { credentials: "same-origin", ...init });
  if (!res.ok) throw new Error(`${init?.method ?? "GET"} ${path} → ${res.status}`);
  return (await res.json()) as T;
}

export const getInventory = (): Promise<InventoryResponse> =>
  fetchJson<InventoryResponse>("/api/inventory");
```

- [ ] **Step 3: Update the test to mock the client and assert the count `web/src/__tests__/App.test.tsx`**

```tsx
import { render, screen } from "@testing-library/react";
import { vi } from "vitest";
import { App } from "../App.tsx";

vi.mock("../api/client.ts", () => ({
  getInventory: vi.fn().mockResolvedValue({ skills: [{}, {}, {}], mcpServers: [], instructions: [], hooks: [] }),
}));

test("renders the agentgem header", () => {
  render(<App />);
  expect(screen.getByRole("heading", { name: "agentgem" })).toBeInTheDocument();
});

test("shows the global skill count fetched from the API", async () => {
  render(<App />);
  expect(await screen.findByText(/3 global skills/)).toBeInTheDocument();
});
```

- [ ] **Step 4: Run the test to verify it fails**

Run: `cd web && npm test`
Expected: FAIL — `App` doesn't fetch/display the count yet.

- [ ] **Step 5: Wire the fetch into `web/src/App.tsx`**

```tsx
import { useEffect, useState } from "react";
import { getInventory } from "./api/client.ts";

export function App() {
  const [status, setStatus] = useState("loading…");
  useEffect(() => {
    getInventory()
      .then((inv) => setStatus(`${inv.skills.length} global skills`))
      .catch((e) => setStatus(`error: ${String(e)}`));
  }, []);
  return (
    <header style={{ display: "flex", alignItems: "center", gap: 10, padding: "12px 16px" }}>
      <svg className="mark" viewBox="0 0 40 40" width={28} height={28} aria-hidden="true">
        <path d="M20 2 L36 14 L20 38 L4 14 Z" fill="#9a3324" />
      </svg>
      <h1 style={{ font: "600 18px/1 var(--display, system-ui)", margin: 0 }}>agentgem</h1>
      <span style={{ fontSize: 12, color: "var(--muted, #6b6256)" }}>Gem Builder</span>
      <span style={{ marginLeft: "auto", fontSize: 12, color: "var(--muted, #6b6256)" }}>{status}</span>
    </header>
  );
}
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `cd web && npm test`
Expected: PASS (both tests). Then `npm run build` to confirm strict tsc still compiles.

- [ ] **Step 7: VERIFY THE DEV PROXY + ORIGIN GUARD (the key integration risk)**

This cannot be unit-tested — it is the foundation's load-bearing integration check.
1. Ensure the backend is running on 4317 (the existing app: `node dist/index.js` from a built backend, or the already-running instance).
2. In `web/`: `npm run dev` → open the printed Vite URL (e.g. http://localhost:5173).
3. Confirm: the warm-paper header renders AND the right side shows a **real** global-skill count (e.g. "233 global skills") fetched via the proxied `/api/inventory`. Open devtools → Network → `/api/inventory` returns **200** (not a 403 from the origin guard) and there are **no console errors**.
4. If `/api/inventory` returns 403 (origin guard rejected the proxied request): the documented dev-only fallback is to allow the Vite dev origin in the guard for dev. Since this plan must not modify backend files, STOP and report this as a finding — resolving it (a dev-only originGuard allowance) is a backend change that needs its own decision, not part of the web/ foundation.

Record the outcome (status code + rendered count) in your report.

- [ ] **Step 8: Commit**

```bash
git add web/src/api/types.ts web/src/api/client.ts web/src/App.tsx web/src/__tests__/App.test.tsx
git -c user.name="Raymond Feng" -c user.email="raymond@ninemind.ai" commit -m "feat(web): typed API client + shell fetches /api/inventory through the dev proxy

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Self-Review

**Spec coverage:**
- §Design 1 (web/ layout, Vite+React+strict TS) → Task 1. ✓
- §Design 2 (dev proxy + origin guard) → Task 3 Step 7 (explicit verification + the documented fallback escalation). ✓
- §Design 3 (design tokens ported verbatim) → Task 1 Step 6. ✓
- §Design 4 (API client + types + getInventory) → Task 3. ✓
- §Design 5 (app shell fetches one endpoint) → Task 3 Steps 5/7. ✓
- §Design 6 (Vitest + RTL harness + one test) → Task 2 (+ extended in Task 3). ✓
- Server/vanilla-UI untouched → Global Constraint + no task modifies anything outside `web/`. ✓

**Placeholder scan:** the only intentionally-"copy from source" step is the design-tokens port (Task 1 Step 6) — it names the exact variables and source location; the values are copied verbatim rather than invented, which is correct (do not fabricate token values). All code steps have complete code.

**Type consistency:** `fetchJson<T>`, `getInventory(): Promise<InventoryResponse>`, and `InventoryResponse` are defined in Task 3 and used consistently in `App.tsx` and the test mock. `App` import path `../App.tsx` consistent across tests.

**Risk note for the executor:** Task 3 Step 7 (proxy ↔ origin guard) is the one place this can fail in a way the plan can't fully pre-solve without touching the backend. The plan deliberately stops and escalates rather than modifying backend files, because a dev-only originGuard change is a backend decision outside this foundation's scope.
