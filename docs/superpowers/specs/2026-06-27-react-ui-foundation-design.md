# React UI — Foundation (sub-project 1 of the React migration)

Date: 2026-06-27
Status: Approved (design)

## Why (the program this belongs to)

The agentgem UI is today a single `src/public/index.html` with a ~1,736-line inline
vanilla-JS `<script>` (DOM APIs + `innerHTML` template strings, no framework, no build, no
tests). It is hard to maintain and extend, has no test harness, and recently shipped a
UI-breaking bug silently (a global `let t` collided with an extension-injected global). The
team wants a React/TypeScript UI for **maintainability, planned UI expansion, team
familiarity, and testability**.

**Migration strategy (decided): parallel build, single cutover.** Build the React app to
full parity on a branch, screen by screen, each verified against the current UI. The
existing vanilla app keeps serving the whole time; we switch the server to the React build
in one step at the end. No coexistence/interop plumbing.

**Program decomposition** (each its own spec → plan → build cycle):
1. **Foundation (THIS spec):** Vite + React + TS toolchain; typed API client + shared
   types; ported design tokens; a running app shell that fetches one real endpoint through
   a dev proxy; a component test harness. The Express server is **untouched** (still serves
   the vanilla UI).
2. **Screen ports (one sub-project each):** testbed chip/picker → inventory/ledger
   (search, source/agent/type filters, Uses/Last-used sort, Used-only, usage badges) →
   import modal (badges/sort/used-only/loading indicator) → analyze/recommend (incl. SSE
   stream) → run (incl. SSE stream) → workspaces / gem builder / get-gems.
3. **Cutover & cleanup:** point the Express server at the React build; delete the inline
   script and `index.html`'s script; retire `scripts/check-inline-js.mjs`.

This spec covers **the Foundation only**. The API contract (`/api/*`) and the warm-paper
visual design are preserved throughout — React re-renders the same screens calling the same
endpoints.

## Goals (Foundation)

1. A standalone React/TS app under `web/` that builds (`vite build`) and runs (`vite dev`).
2. A typed API-client layer + response types, proven by fetching one real endpoint.
3. The warm-paper **design tokens** ported (so ported screens look identical later).
4. A component **test harness** (Vitest + React Testing Library) with one passing test.
5. The Express server and the live vanilla UI are **unchanged** (parallel build).

Non-goals: any real screen logic, porting all component CSS, or touching how the server
serves the app (those are screen-port / cutover sub-projects).

## Verified preconditions

- Backend serves `/` → `index.html` and `/api/*` (incl. SSE: `/api/workflow/analyze/stream`,
  `/api/gem/run/stream`) on `PORT` default **4317** (`src/index.ts:47,52,55,61`).
- The backend applies an **origin guard** middleware (`originGuard`) to browser requests
  (same-origin/CSRF protection) — the dev proxy must present requests acceptably (below).
- Repo TypeScript is `^6`; the build is `tsc -b` (Node/server). The `web/` app has its own
  toolchain and does **not** go through the server `tsconfig.json`.
- The design tokens live in index.html's `<style>` `:root` (e.g. `--paper:#f4efe3`,
  `--ink:#211c15`, `--accent:#9a3324`, `--paper-2`, `--card:#fbf8f1`, `--line:#ddd2bb`,
  `--muted`, display/ui fonts, `--r`). These are copied verbatim.

## Design

### 1. Project layout — `web/`

A standalone Vite app at repo root (isolated from `src/`):

```
web/
  index.html                # Vite entry (links /src/main.tsx)
  package.json              # web app deps + scripts (separate from root)
  tsconfig.json             # React/DOM/strict TS for the web app
  vite.config.ts            # React plugin + /api dev proxy
  src/
    main.tsx                # ReactDOM.createRoot(...).render(<App/>)
    App.tsx                 # shell: header + empty main
    styles/tokens.css       # ported :root design tokens + base/reset
    api/
      client.ts             # fetchJson<T>() wrapper (handles origin/credentials)
      types.ts              # response interfaces (hand-authored for now)
    __tests__/App.test.tsx  # shell render test
```

**Stack:** Vite (latest) + React 19 + TypeScript (strict — this is new code, so strict from
day one, unlike the legacy script). React plugin: `@vitejs/plugin-react`.

Rationale for a separate `web/package.json`: the web app needs browser-targeted deps
(react, vite) and its own strict tsconfig (DOM lib); keeping it out of the root package
avoids polluting the server/CLI dependency tree and the `tsc -b` build. (A root script can
delegate, e.g. `"build:web": "npm --prefix web run build"`, but wiring the server to serve
the output is the **cutover** sub-project — not here.)

### 2. Dev proxy + origin guard

`web/vite.config.ts` proxies API calls to the running backend so the browser only ever talks
to the Vite origin (no CORS in the browser):

```ts
server: {
  proxy: {
    "/api": { target: "http://127.0.0.1:4317", changeOrigin: true },
  },
}
```

`changeOrigin: true` rewrites the forwarded `Host`/`Origin` to the target, so the backend's
`originGuard` sees a same-origin request and accepts it. **Foundation must confirm a proxied
`/api/inventory` call succeeds through the guard**; if `changeOrigin` is insufficient, the
fallback is a small dev-only allowance in `originGuard` for the Vite origin (documented, dev-
only, never in production — production is same-origin after cutover). This is the one
integration risk to nail down in Foundation.

### 3. Design tokens

`web/src/styles/tokens.css`: copy the `:root { --paper … }` custom properties and base
element styles (font, background, color) **verbatim** from index.html's `<style>`, imported
once in `main.tsx`. Component-level CSS is ported per screen later; Foundation ports only the
tokens + base so the shell already looks like agentgem (warm paper, terracotta accent).

### 4. API client + types

`web/src/api/client.ts`:
```ts
export async function fetchJson<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, { credentials: "same-origin", ...init });
  if (!res.ok) throw new Error(`${init?.method ?? "GET"} ${path} → ${res.status}`);
  return res.json() as Promise<T>;
}
```
`web/src/api/types.ts`: hand-authored interfaces for the endpoints Foundation touches
(`InventoryResponse` with `skills`/`mcpServers`/`instructions`/`hooks`). Per-screen ports add
their own types. (Roadmap option, not now: generate a typed client from the backend's
`@agentback/openapi` spec to keep client/server types in lockstep — evaluate during the first
screen port.)

A first endpoint fn proves the pattern:
```ts
export const getInventory = () => fetchJson<InventoryResponse>("/api/inventory");
```

### 5. App shell

`web/src/App.tsx`: render the agentgem header (the inline-SVG mark + "agentgem" + "Gem
Builder" tag + a testbed-chip placeholder) and an empty main region. On mount, call
`getInventory()` and show a tiny status (e.g. "N global skills") — purely to prove the full
chain end-to-end (Vite → proxy → backend → typed client → React render). No real screens.

### 6. Test harness

Vitest + `@testing-library/react` + jsdom configured in `web/`. One test
(`App.test.tsx`): render `<App/>` with `getInventory` mocked, assert the header renders and
the mocked count appears. Establishes the pattern every later screen port will follow
(addresses the "testability" goal).

## Data flow (dev)

```
browser (localhost:5173, the Vite app)
  → React App mounts → getInventory() → fetch("/api/inventory")
  → Vite dev server proxies /api → http://127.0.0.1:4317 (running backend, changeOrigin)
  → backend originGuard accepts (same-origin via proxy) → returns inventory JSON
  → typed client → App renders "N global skills"
```
Production serving of the built `web/dist` is the **cutover** sub-project; not in Foundation.

## Error handling

- `fetchJson` throws on non-2xx; `App` shows a small error string (no crash) so a backend-down
  state is visible, not silent.
- The dev proxy is dev-only; production is same-origin post-cutover (no proxy).

## Testing / verification

- `npm --prefix web run build` succeeds (strict tsc + Vite bundle, no errors).
- `npm --prefix web test` passes (the shell test).
- Manual: with the backend running on 4317, `npm --prefix web run dev` → open the Vite URL →
  the warm-paper shell renders the header and a real inventory count fetched through the
  proxy; **no console errors**; the origin guard accepts the proxied call (the key risk).
- The existing backend `pnpm test` and the live vanilla UI are unaffected (Foundation adds
  `web/` only; it changes no server file).

## Out of scope (later sub-projects)

- Any real screen (ledger, import, analyze, run, workspaces) — each is its own sub-project.
- Porting all component CSS — only tokens + base here.
- Wiring the Express server to serve the React build, and deleting the inline script — that
  is the **cutover** sub-project.
- OpenAPI client codegen, routing/state libraries — evaluate when the first real screen needs
  them; not pre-adopted.
