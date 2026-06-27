# HANDOFF — agentgem React UI rewrite (start here in the new session)

Status: **design/scoping done; no implementation written.** All artifacts are on branch
`app-extract` (off `main`). The live vanilla UI (port 4317) and `main` are untouched.

## What we decided

- Replace the ~1,736-line inline-vanilla-JS UI (`src/public/index.html`) with a **React/TS**
  UI. Motivations: maintainability, planned UI expansion, team familiarity, testability.
- **Migration strategy: parallel build → single cutover.** Build React to parity on a
  branch while the vanilla app keeps serving; switch in one step at the end.

## The pivot that supersedes the first foundation spec

The user asked to follow **`/Users/rfeng/Projects/ninemind/agentback/packages/console`**
(`@agentback/console`) so the UI is **composable from multiple packages** and ready for
agentgem to become a monorepo. This **supersedes** the standalone-Vite foundation
spec/plan below — do NOT build the standalone `web/` Vite app; adopt the console pattern.

### The @agentback/console pattern (studied — use it)

Explicit static registration, two-sided contract (no auto-discovery, no runtime federation):

- **Client:** each tool package exports `pages: ConsolePage[]` from its `./console` entry via
  `defineConsolePage({id,title,icon,order,route, component: ({apiBase}) => <Panel/>})`. The
  console's `src/client/pages.tsx` imports + concatenates them; **esbuild** bundles ONE SPA
  (`dist/client/main.js`) by reaching into each tool's `./console` source TSX (resolved via
  the package `exports` map). Sidebar nav derived from the page list (sort by `order`).
- **Server:** each tool exports a `ConsoleFeature` (e.g. `contextConsoleFeature()`) that
  registers its API controller + advertises `apiBase`, per-panel `extra`, component CSS.
  `installConsole(app, {basePath:'/console', title, features, auth})` installs them and
  injects `window.__CONSOLE__` config the shell reads. Served on the existing
  `@agentback/rest` `RestApplication`.
- **Add a panel:** install package + one import/spread in `pages.tsx` + one `features` entry.
- **Build:** `tsc -b` (project refs, typecheck via `tsconfig.client.json` `noEmit`) +
  `build-client.mjs` (esbuild). `src/client` is EXCLUDED from the main tsconfig (esbuild is
  the bundler). React 19, esbuild ~0.28, vitest 4, zod 4.
- **Theme:** `@agentback/console-theme` (server-injected `THEME_CSS`).
- **Live reload:** SSE boot-id stream (`<basePath>/live`) refreshes panels on app restart.
- Reference: `agentback/packages/console/README.md` (read it — it documents the whole contract
  and the build-ordering gotchas).

### Why this fits agentgem

- agentgem **already** runs a `@agentback/rest` `RestApplication` (`src/index.ts`) and
  depends on `@agentback/core/mcp/openapi/rest-explorer@^0.5.2`.
- **`@agentback/console@0.6.0` and `@agentback/console-theme` are published on npm** →
  agentgem can `installConsole(app, …)` and add its screens as `ConsolePage`s without
  reinventing the shell.
- agentgem is currently a **single package** (no `pnpm-workspace.yaml`).

## Open decisions for the new session (resolve in brainstorming first)

1. **Reuse vs monorepo-replicate:** simplest first step is to depend on the published
   `@agentback/console` + `@agentback/console-theme` and register agentgem's screens as
   `ConsolePage`s in one place — no monorepo needed yet. Converting agentgem into a pnpm
   monorepo (each screen its own `@agentgem/*` package exporting `./console`) is the
   "fully composable" end-state but a bigger step. Decide whether to (a) reuse-console-now,
   monorepo-later, or (b) go monorepo from the start.
2. **Bump `@agentback/*` to ^0.6** (console is 0.6.0; agentgem is on 0.5.2) — check
   compatibility of rest/core/mcp/openapi when adding console.
3. **Theme:** reuse `@agentback/console-theme` vs port agentgem's warm-paper tokens into an
   `@agentgem/console-theme` (or a local theme feature). The warm-paper tokens live in
   `src/public/index.html`'s `<style> :root` (`--paper:#f4efe3; --ink:#211c15;
   --accent:#9a3324;` …).
4. **Served path:** console defaults to `/console`; agentgem serves its UI at `/`. Decide
   whether to mount the console at `/` (replace) or `/console` (parallel) during the build,
   then cut `/` over at the end.

## Recommended next steps (new session)

1. Re-open brainstorming with this handoff as context. Read `agentback/packages/console/
   README.md` and ONE contributing tool's `./console` export (e.g.
   `@agentback/context-explorer` or `console-chat`) to copy the exact `ConsolePage` /
   `ConsoleFeature` contract and the `tsconfig.client.json` + `build-client.mjs` shape.
2. Resolve the open decisions above (start with #1).
3. Rewrite the Foundation spec around the console pattern: add `@agentback/console` +
   `console-theme`, an agentgem console entry (`pages.tsx` + a `ConsoleFeature` for the
   gem-builder API), esbuild client build, `installConsole` wired into `src/index.ts` at
   `/console` (parallel to the live `/`). First shippable increment: the console shell +
   ONE real agentgem panel (e.g. the inventory/ledger) rendering through the existing API.
4. Then port screens one per sub-project (ledger → import → analyze → run → workspaces),
   each a `ConsolePage`, verified against the vanilla UI. Final sub-project: cut `/` over and
   delete the inline script.

## Superseded artifacts (kept for reference, do not execute as-is)

- `docs/superpowers/specs/2026-06-27-react-ui-foundation-design.md` — standalone-Vite
  foundation. Superseded by the console pattern (no monorepo/composability). Reuse its
  preconditions/verification notes only.
- `docs/superpowers/plans/2026-06-27-react-ui-foundation.md` — plan for the above. Superseded.

## Session state / cleanup

- Branch `app-extract` holds these docs. `main` has only this session's shipped fixes
  (usage features, SWR, the `let t` fix, the inline-JS build guard) — all live on 4317.
- A server is running on **http://127.0.0.1:4317** from the `try-app` worktree (`main`).
  Stop it with: `lsof -nP -iTCP:4317 -sTCP:LISTEN -t | xargs kill`. Worktrees to clean up
  when done: `.claude/worktrees/try-app`, `.claude/worktrees/app-extract`.
