# Design — React UI rewrite: console pattern in a pnpm workspace

Date: 2026-06-27
Branch: `feat/react-ui-console` (off `main`)
Status: design approved; implementation not started.

Supersedes `2026-06-27-react-ui-foundation-design.md` (standalone Vite app) and resolves the
open decisions in `HANDOFF-react-ui-rewrite.md`. The handoff's assumption that agentgem could
depend on the published `@agentback/console` and register its own screens is **wrong** (see
"Why not reuse the published console" below); this spec replaces that path.

## Goal of this first increment

Stand up the workspace + a self-owned console shell + **one real panel** (the Ledger/inventory)
rendering live data, served at `/console` **in parallel** with the untouched vanilla UI at `/`.

Explicit non-goals for this increment:
- No cutover. Vanilla UI keeps serving `/`. No deletion of `src/public/index.html`.
- No backend refactoring. The console imports nothing from `src/gem`; it is an HTTP client of
  the existing REST API. (Backend/kernel extraction deferred — see `monorepo-deferred`.)
- No porting of the other screens yet (import, analyze, run, workspaces) — those are follow-on
  `ConsolePage`s in later efforts.

Success criteria:
- `pnpm build` at the repo root emits `dist/public/console/main.js` (+ `index.html`, css).
- Visiting `/console` on the running server renders the gem inventory from `/api/inventory`
  with usage badges from `/api/usage`, in warm-paper styling.
- `npx`/`npm i -g @ninemind/agentgem` and the Electron desktop app both still launch and serve
  the vanilla `/` unchanged, and additionally ship the new `/console` assets.
- vitest covers the page registry shape, the Ledger panel render against mocked fetch, and the
  packaging invariant (`dist/public/console/main.js` exists after build).

## Decisions (resolved in brainstorming)

1. **Foundation: monorepo from the start**, UI-focused scope only. pnpm workspace; the existing
   root package stays `@ninemind/agentgem` (server + CLI, published, unchanged). One new
   **private** package `@agentgem/console` holds the React SPA.
2. **Self-own the console shell** — do NOT depend on `@agentback/console` for the product UI
   (see below). Replicate its composition *contract* (`ConsolePage[]` registry + a per-screen
   server seam) in a small owned shell.
3. **Theme: port warm-paper tokens locally** — copy the `:root` tokens from
   `src/public/index.html` (`--paper:#f4efe3; --ink:#211c15; --accent:#9a3324; …`) into a local
   theme CSS. No `@agentback/console-theme` dependency.
4. **Mount path: `/console`, parallel to `/`.** Cutover is a deliberate later step.

### Why not reuse the published `@agentback/console`

The published `@agentback/console@0.6.0` exports **only its server entry** (`installConsole`,
`mountConsole`, `ConsoleFeature`, …) for its own three first-party dev tools (context, schema,
REST, MCP inspectors). Its client SPA shell (`App.tsx`/`main.tsx`) is **not** exported, and its
`src/client/pages.tsx` is an internal file that hardcodes those three tools. The SPA is bundled
by esbuild **at the console's publish time**, so an external consumer cannot inject its own
`ConsolePage`s into the frozen bundle. Therefore agentgem must own a client build that bundles
its own `pages.tsx`. We replicate the *pattern*, not the *package*.

## Workspace & distribution architecture

```
agentgem/                       repo root = @ninemind/agentgem (server + CLI, published)
├── pnpm-workspace.yaml         NEW: packages: ['packages/*']  (root is also a member)
├── package.json                build script gains a console-build + copy step; serves /console
├── src/index.ts                ~6 new lines: static mount of dist/public/console at /console
└── packages/
    └── console/                NEW @agentgem/console — PRIVATE, never published
        ├── package.json        private:true; deps react/react-dom; devDeps esbuild, vitest, jsdom
        ├── build-client.mjs    esbuild → dist/{main.js,index.html,main.css}
        ├── tsconfig.client.json  noEmit typecheck (esbuild bundles; excluded from root tsc -b)
        └── src/
            ├── contract.ts     ConsolePage + defineConsolePage
            ├── pages.tsx       the composable seam: ConsolePage[] (one import+spread per screen)
            ├── main.tsx        SPA entry (mounts shell)
            ├── shell/          sidebar nav (from pages, sorted by order), hash router, theme CSS,
            │                   optional live-reload SSE hook
            └── panels/
                └── Ledger/     first real panel (index.tsx exports ledgerPage)
```

### Distribution invariant: everything funnels through `dist/public/`

Both shipping channels resolve UI assets **relative to the server file, from `dist/public/`** —
neither consumes a workspace runtime dependency:

| Channel | Mechanism today | After this change |
|---|---|---|
| `npx` / `npm i -g` | `files:["dist"]` ships `dist/`; `scripts/copy-public.mjs` fills `dist/public/`; server reads `dist/public/index.html` | `dist/public/console/` is inside `dist/`, already covered by `files:["dist"]` — no `files`/`bin` change |
| Desktop (Electron) | `desktop/scripts/bundle-core.mjs` esbuilds `dist/index.js` and `cpSync(dist/public → core-dist/public)` wholesale | picks up `console/` for **free** — no change to `bundle-core.mjs` |

Consequence baked into the design: **`@agentgem/console` is a build-time asset producer, not a
runtime dependency.** It stays `private`, is never installed by consumers, and only its built JS
lands in the published tarball (inside `dist/public/console/`). The React/esbuild devDeps are
dev/CI cost only; `prepublishOnly` already runs a full `pnpm build`.

## Composition contract (the monorepo-composable seam)

```ts
// packages/console/src/contract.ts
export interface ConsolePage {
  id: string;
  title: string;
  icon?: ReactNode;
  order: number;            // sidebar sort key
  route: string;            // hash route, e.g. '#/ledger'
  component: (props: { apiBase: string }) => ReactNode;
}
export const defineConsolePage = (p: ConsolePage): ConsolePage => p;
```

```ts
// packages/console/src/pages.tsx  ← the ONE place edited to add a screen
import { ledgerPage } from './panels/Ledger';
export const pages: ConsolePage[] = [ ledgerPage ];   // later: importPage, analyzePage, …
```

Adding a screen later = author a panel that exports a `ConsolePage`, add one import + one array
entry here. This mirrors `@agentback/console`'s registration model and keeps a future
package-per-screen split mechanical.

## Shell

`src/shell/` — small React 19 app, no router dependency:
- Sidebar nav derived from `pages` sorted by `order`; active route from `window.location.hash`.
- Hash-based routing (`hashchange` listener) selects the page whose `route` matches.
- Warm-paper theme: local CSS with the ported `:root` tokens.
- `apiBase = ''` (same origin) — the agentgem server hosts the SPA.
- Optional: a live-reload SSE hook that refreshes on app restart. May be deferred if it adds
  friction; not required for the success criteria.

## Build pipeline

- `packages/console/build-client.mjs`: esbuild bundles `src/main.tsx` → `dist/main.js` (React
  inlined, minified), emits `index.html` (script + style tags) and `main.css`.
- Root `package.json` `build`: after `copy-public.mjs`, run the console build and copy
  `packages/console/dist/*` → `dist/public/console/`. (A small `scripts/build-console.mjs` or an
  added pnpm step; exact wiring decided in the plan.)
- Typecheck: `tsconfig.client.json` with `noEmit`, JSX react-jsx; the console `src/client` tree
  is excluded from the root `tsc -b` so the server typecheck/build stays clean (esbuild is the
  bundler for the client).

## Server wiring (`src/index.ts`)

~6 lines, inside `createApp` after the existing `/` handler:
```ts
const consoleDir = join(here, "public", "console");
server.expressApp.use("/console", originGuard, express.static(consoleDir));
server.expressApp.get("/console", originGuard, (_req, res) =>
  res.type("html").send(readFileSync(join(consoleDir, "index.html"), "utf8")));
```
`app.get("/")` → vanilla, untouched. The console sits behind the same `originGuard` as the rest.
(Exact static-middleware form confirmed against the installed express version during impl.)

## First panel — Ledger

`src/panels/Ledger/` fetches `/api/inventory` (grouped gem inventory) and overlays usage badges
from `/api/usage`, rendered in warm-paper styling. **Read-only** for this increment — no
selection, no mutation, no export. It exists to prove the full vertical slice end to end:
workspace build → SPA bundle → static mount → real API → npx/desktop packaging, at the smallest
surface. Selection/build/export and the stage rail come with later panels.

## Testing

vitest 4 in `packages/console` (jsdom):
1. **Registry shape** — `pages` have unique `id`s and are renderable in `order` order.
2. **Ledger render** — mounts the panel against a mocked `fetch` returning a small inventory +
   usage payload; asserts gems group correctly and usage badges appear.
3. **Packaging invariant** — a root-level check that after `pnpm build`, `dist/public/console/
   main.js` exists (guards the npx + desktop contract). May be a lightweight script assertion
   rather than a vitest case if that's cleaner.

## Risks / open items for the plan

- Exact `express.static` API shape against the installed express major (4 in desktop peer; root
  uses `@agentback/rest`'s express) — verify during impl.
- Whether the live-reload SSE hook is worth including now or deferred.
- `tsconfig` project-reference wiring so the root `tsc -b` ignores the console client without
  breaking `pnpm -r` typechecks — settle in the plan.
- pnpm workspace install must not change what end users download; verified by the packaging
  test, but double-check the published tarball contents (`pnpm pack --dry-run`) once built.
