# PR C — Stored-Miniapp Migration to the MCP Apps Client (inert) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development. Checkbox (`- [ ]`) steps.

**Goal:** Rewrite stored/shared miniapps that embed the private `agentgem:request/feed` bridge so they speak the new MCP Apps client shim — a 3-state codemod plus a migrate route and an on-read backstop. **Inert:** the codemod isn't invoked by the runtime yet (Runner cutover is PR D); it's additive and safe to land.

**Architecture:** `migrateMiniappHtml(html)` (in `@agentgem/play`) detects the old bridge and rewrites its two boilerplate regions to `mcpAppClient`-based glue, injecting the shim; returns `{html, outcome}` with `outcome ∈ {"migrated","already","unrecognized"}`. `POST /api/play/migrate` walks `listMiniapps()`, migrates each in place (bumping `engineVersion` in meta, re-`saveMiniapp` to re-gate + re-dual-write), and reports per-app outcomes. `readMiniapp` gains an idempotent on-read backstop so any un-migrated copy still plays migrated. Baked data guarantees an un-migrated copy is at worst *degraded* (no live refresh), never blank.

**Tech Stack:** TypeScript ESM; `@agentgem/play` (tests from compiled dist at repo root); `@agentback/openapi` route in `src/play.controller.ts`.

## Global Constraints

- **Node >=24.** Copyright header on new `packages/play` files (`// Copyright (c) 2026 NineMind, Inc.` / `// SPDX-License-Identifier: MIT`).
- **`@agentgem/play` tests run from COMPILED dist:** `pnpm exec tsc -b && pnpm exec vitest run dist/play/__tests__/<x>.test.js`. Use `tsc -b --force` for the authoritative typecheck (incremental can false-pass from stale `.tsbuildinfo`).
- **Controller tests** run from dist too: `pnpm exec vitest run dist/__tests__/<x>.test.js`.
- **Reuse:** `MCP_CLIENT_MARKER` + `mcpAppClient` from `./mcpAppClient.js` (PR B); `replayScaffold` output as the golden fixture (import via a small test helper or reconstruct from `scaffoldFor("replay")`).
- **The old bridge (what to detect/replace)** lives in `packages/play/src/scaffolds.ts` `replayScaffold()`: a top region — `window.addEventListener("message", (e) => { … d.type === "agentgem:feed" && d.channel === "session-data" … boot() … });` and `function requestData() { … postMessage({ type: "agentgem:request", want: "session-data" }, "*") … }` — plus a bottom retry loop calling `requestData()`. The `AGENTGEM:GAME-LOGIC` block and the baked `<script id="game-data">` must be left UNTOUCHED.
- This PR is INERT — do NOT modify `Runner.tsx` or `scaffolds.ts`.

---

### Task 1: `migrateMiniappHtml` codemod (3-state)

**Files:**
- Create: `packages/play/src/migrate.ts`
- Modify: `packages/play/src/index.ts` (export `migrateMiniappHtml`, `type MigrateOutcome`)
- Test: `src/play/__tests__/migrate.test.ts`

**Interface (Produces):**
```ts
export type MigrateOutcome = "migrated" | "already" | "unrecognized";
export function migrateMiniappHtml(html: string): { html: string; outcome: MigrateOutcome };
```

**Contract:**
- If `html.includes(MCP_CLIENT_MARKER)` → `{ html, outcome:"already" }` (idempotent no-op).
- Else if it contains BOTH `"agentgem:request"` and `"agentgem:feed"` (the old bridge) → rewrite:
  1. Inject the shim `<script>` (`mcpAppClient()`) at the start of `<head>` (same head-injection approach as `sandboxDoc`), so `window.agentgemApp` exists before the game script runs.
  2. Replace the old `window.addEventListener("message", (e) => { … agentgem:feed … });` region with:
     ```js
     if (window.agentgemApp) window.agentgemApp.onNotification("ui/notifications/tool-result", function (p) { if (p && p.toolName === "agentgem_get_session_data") { DATA = p.chunk || {}; boot(); } });
     ```
  3. Replace the old `function requestData() { … agentgem:request … }` with:
     ```js
     function requestData() { if (window.agentgemApp) window.agentgemApp.callTool("agentgem_get_session_data").then(function (d) { if (d) { DATA = d; boot(); } }).catch(function () {}); }
     ```
     (Keeping `requestData` defined means the existing bottom retry loop stays harmless — the shim itself does the bounded `ui/initialize` retry.)
  Use regexes anchored on the invariant substrings (`agentgem:feed`, `agentgem:request`) so minor reformatting still matches; the `DATA`/`boot` identifiers stay in the game IIFE scope. If BOTH replacements succeed → `{ migratedHtml, outcome:"migrated" }`.
- Else (no marker, no recognizable bridge) → `{ html, outcome:"unrecognized" }` (loud — the route reports it; do NOT throw).

- [ ] **Step 1: Write the tests (behavioral gate)**

`src/play/__tests__/migrate.test.ts` covering, using `scaffoldFor("replay")` as the golden fixture:
- **Golden migration:** `migrateMiniappHtml(scaffoldFor("replay"))` → `outcome:"migrated"`; result contains `MCP_CLIENT_MARKER`; result NO LONGER contains `"agentgem:request"` or the old `addEventListener("message"` feed listener; result STILL contains the `AGENTGEM:GAME-LOGIC` markers and any `id="game-data"` handling.
- **Idempotent:** feeding the migrated html back → `outcome:"already"`, html unchanged.
- **Unrecognized:** a self-contained bundle with no bridge (e.g. `scaffoldFor("project-fun")`) → `outcome:"unrecognized"`, html unchanged; and never throws.
- **Still valid:** the migrated replay html passes `gameGate` and `assertPortable(migrated, ["session-data"])` — **provided the fixture bakes a timeline** (build a baked variant by injecting a non-empty `<script id="game-data" type="application/json">{"meta":{},"timeline":[{"role":"user","text":"hi"}]}</script>` into the fixture's `<body>` before migrating, since `assertPortable` requires it). (`gameGate` is async — await it.)

- [ ] **Step 2: RED** — `pnpm exec tsc -b && pnpm exec vitest run dist/play/__tests__/migrate.test.js` → FAIL.
- [ ] **Step 3: Implement `migrate.ts` to the contract + export.**
- [ ] **Step 4: GREEN** — rerun → PASS; then `pnpm exec tsc -b --force` → exit 0.
- [ ] **Step 5: Commit**
```bash
git add packages/play/src/migrate.ts packages/play/src/index.ts src/play/__tests__/migrate.test.ts
git commit -m "feat(play): migrateMiniappHtml — rewrite the old bridge to the MCP Apps client"
```

---

### Task 2: `POST /api/play/migrate` route + on-read backstop

**Files:**
- Modify: `packages/play/src/miniapps.ts` (`readMiniapp` applies `migrateMiniappHtml` idempotently to the returned html; add `migrateAllMiniapps()` helper)
- Modify: `src/play.controller.ts` (add the route) + `src/schemas.ts` (`PlayMigrateResponseSchema`)
- Test: `src/play/__tests__/migrateMiniapps.test.ts` (helper + backstop) and `src/__tests__/playRoutes.test.ts` (route; append)

**Interfaces (Produces):**
```ts
// miniapps.ts
export function migrateAllMiniapps(): { name: string; outcome: MigrateOutcome; commit: string | null }[];
// readMiniapp returns migrated html (in-memory backstop); the stored file is unchanged until the route runs.
// play.controller.ts
@post("/play/migrate") migrate(): Promise<{ results: { name: string; outcome: string }[] }>
```

**Contract:**
- `readMiniapp(name)`: after reading, return `{ ...r, html: migrateMiniappHtml(r.html).html }` — so the player always gets migrated html even if the file wasn't rewritten yet. (Meta unchanged; this is the zero-silent-break backstop.)
- `migrateAllMiniapps()`: for each `listMiniapps()` entry, read the RAW stored html (a raw read that does NOT apply the backstop — add an internal `readMiniappRaw` or read the file directly), run `migrateMiniappHtml`; if `"migrated"`, bump `meta.engineVersion` (e.g. append `+mcp` or increment) and `saveMiniapp({name, html:migrated, meta})` (re-gates + re-dual-writes); collect `{name, outcome, commit}`. `"already"`/`"unrecognized"` → no write, recorded.
- Route wraps `migrateAllMiniapps()` → `{ results }`; `AgentError(..., {status:400})` on throw.

- [ ] **Step 1: Write tests**
- `migrateMiniapps.test.ts` (temp `AGENTGEM_HOME`, `saveMiniapp` a baked replay with the OLD bridge, then): `migrateAllMiniapps()` reports `outcome:"migrated"` and the STORED file now contains `MCP_CLIENT_MARKER` and a bumped `engineVersion`; a second run reports `"already"`. Also: `readMiniapp` returns migrated html even before `migrateAllMiniapps` runs (backstop), while the stored file is still raw.
- `playRoutes.test.ts`: `POST /api/play/migrate` (via `ctrl.migrate()`) returns `results` with the saved miniapp's outcome.

- [ ] **Step 2: RED** — `pnpm exec tsc -b && pnpm exec vitest run dist/play/__tests__/migrateMiniapps.test.js dist/__tests__/playRoutes.test.js` → FAIL.
- [ ] **Step 3: Implement** the backstop + helper + route + schema.
- [ ] **Step 4: GREEN** — rerun → PASS; `pnpm exec tsc -b --force` → 0; `pnpm exec vitest run dist/play dist/__tests__/playRoutes.test.js dist/__tests__/playMcpRoute.test.js` → green.
- [ ] **Step 5: Commit**
```bash
git add packages/play/src/miniapps.ts src/play.controller.ts src/schemas.ts src/play/__tests__/migrateMiniapps.test.ts src/__tests__/playRoutes.test.ts
git commit -m "feat(play): /api/play/migrate + on-read migration backstop"
```

## Notes for PR D (cutover)
- Published/aggregator archives are NOT rewritten here; they render baked data broker-less on the marketplace (no regression). If desired, migrate-on-publish is a later add.
- The on-read backstop means the stored-file migration (this route) is an optimization, not a correctness prerequisite.
