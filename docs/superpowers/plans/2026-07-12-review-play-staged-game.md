# Gem Review Staging — Play a Staged Game (follow-on)

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development. Steps use `- [ ]`.

**Goal:** Let a reviewer PLAY a staged game/miniapp gem in the sealed player instead of installing it to a workspace (a game installed to `.claude/` can't be tested). Closes Plan 2b's one deliberate MVP shortcut (the planted TODO at `packages/console/src/panels/Reviews/index.tsx:103`).

**Architecture:** a new `/api/review/play` local route (mirrors the aggregator's `game-html`: `fetchReviewArchive` → `importGem` → the `game` artifact's `html`), consumed by the Reviews inbox detail — when `manifest.artifactKinds` includes `"game"`, a **"Play to test"** button opens a sealed-play modal wrapping the existing standalone `Runner` component. Non-game gems keep "Install to test".

**Tech Stack:** TS (ESM `.js`), AgentBack controller, Zod; React + the `Runner` sealed player + `useDialogA11y` modal chrome; Vitest.

**Scope:** small follow-on to the merged review-staging feature. No aggregator change (a staged gem's html is extracted locally from the archive the reviewer already fetches).

## Global Constraints
- ESM `.js` specifiers. Console tests NOT in CI (run `pnpm -C packages/console exec vitest run` locally); the local `ReviewController` test IS in CI (`dist/**/__tests__`).
- The play route reuses the SIGNED `fetchReviewArchive` (never a session bearer). It returns ONLY `{ html }` — no bytes, no install.
- The sealed player is broker-less for staged play: `<Runner html={...} interactive maxHeight={...} />` with NO `apiBase`/`name`/`needs` (a staged game under review must not reach the MCP-Apps capability broker).

## File Structure
- **Modify** `src/review.controller.ts` — add `@post("/play")` (or `@get` with query) returning the staged game html.
- **Modify** `src/gem/reviewClient.ts` — a `fetchReviewGameHtml` helper OR reuse `fetchReviewArchive` + extract in the controller (prefer: extract in the controller, mirroring `gameHtml`).
- **Modify** `packages/console/src/api/routes.ts` — `reviewPlayRoute`.
- **Modify** `packages/console/src/panels/Reviews/index.tsx` — game detection + "Play to test" button + sealed-play modal.
- **Create** `packages/console/src/panels/Reviews/PlayModal.tsx` (or inline) — the modal wrapping `Runner`.
- Tests: `src/__tests__/reviewController.test.ts` (play route), `packages/console/src/panels/Reviews/__tests__/Reviews.test.tsx` (button + modal).

---

## Task 1: `/api/review/play` — return the staged game html

**Files:** Modify `src/review.controller.ts`; Test `src/__tests__/reviewController.test.ts`.

**Interface:**
```ts
const ReviewPlayBody = z.object({ requestId: z.string() });
const ReviewPlayResult = z.object({ html: z.string() });
@post("/play", { body: ReviewPlayBody, response: ReviewPlayResult })
async play(input): // fetchReviewArchive(signed) -> importGem -> game artifact -> { html }; 404 not_a_game / review_archive_gone
```

**Behavior:** mirror `src/aggregator.controller.ts`'s `gameHtml` (read it): `const bytes = await fetchReviewArchive({ requestId, identity: loadOrCreateIdentity() })`; if null → 404 `review_archive_gone`; `const { gem } = importGem(bytes)`; `const game = gem.artifacts.find(a => a.type === "game") as {html?: unknown} | undefined`; if `!game || typeof game.html !== "string"` → 404 `not_a_game`; else `return { html: game.html }`. No `createWorkspace`, no consent gate (rendering html in a sealed frame runs no executables).

- [ ] **Step 1: failing test** — in `reviewController.test.ts`, the reviewClient `fetchReviewArchive` mock already exists; add a test: mock `fetchReviewArchive` → real-ish bytes, mock `importGem` (already mocked in that file) to return a gem with a `game` artifact `{type:"game", html:"<h1>hi</h1>"}` → `play({body:{requestId:"r1"}})` returns `{html:"<h1>hi</h1>"}`; and a gem with NO game artifact → rejects (404 not_a_game); and `fetchReviewArchive`→null → rejects (404). (Extend the existing `@agentgem/distribute` importGem mock to vary per-test, or add a dedicated describe with its own mock.)
- [ ] **Step 2: run RED** — `pnpm -w exec tsc -b && npx vitest run dist/__tests__/reviewController.test.js -t play`.
- [ ] **Step 3: implement** the `play` method (read `gameHtml` in `src/aggregator.controller.ts` first; match its find/404 logic + `importGem(Buffer.from(bytes))` if needed).
- [ ] **Step 4: GREEN.**
- [ ] **Step 5: commit** — `feat(review-console): /review/play returns a staged game's html for sealed play`.

---

## Task 2: Reviews inbox "Play to test" + sealed-play modal

**Files:** Modify `packages/console/src/api/routes.ts` (`reviewPlayRoute`), `packages/console/src/panels/Reviews/index.tsx`; Create `packages/console/src/panels/Reviews/PlayModal.tsx`; Test `Reviews.test.tsx`.

**Interfaces:**
```ts
export const reviewPlayRoute = defineRoute("POST", "/api/review/play", { body: z.object({ requestId: z.string() }), response: z.object({ html: z.string() }) });
```

**Behavior:**
- In `RequestDetail`, detect game-ness: `const isGame = Array.isArray(detail?.manifest?.artifactKinds) && detail.manifest.artifactKinds.includes("game")` (the detail's `manifest` is `z.any()` — narrow it locally). Read the current detail-fetch to know where `manifest` lands.
- Where "Install to test" renders (`Reviews/index.tsx:199-214`): if `isGame`, render **"Play to test"** INSTEAD (not both). Clicking it calls `reviewPlayRoute.call(makeClient(apiBase), { body: { requestId: summary.id } })`, and on success opens `PlayModal` with the returned `html`. Handle the 404 (`not_a_game`/`review_archive_gone`) → the same friendly-message path install uses. Non-game gems keep the existing "Install to test" button unchanged.
- `PlayModal`: a `role="dialog"` overlay (copy the `ConnectGitHubModal` + `useDialogA11y` pattern — focus trap, Escape, click-backdrop-to-close) wrapping `<Runner html={html} interactive maxHeight={...} />` from `packages/console/src/panels/Play/Runner.js`. NO `apiBase`/`name`/`needs` on the Runner (broker-less sealed preview). A title bar ("Playing `<gemKey>@<version>` — staged for review") + a close button.

- [ ] **Step 1: failing test** — `Reviews.test.tsx`: a request whose `reviewGetRoute` detail has `manifest.artifactKinds: ["game"]` → the detail shows "Play to test" (not "Install to test"); clicking it calls `reviewPlayRoute` with the requestId and the play modal (a `dialog`) appears; a request with `artifactKinds: ["skill"]` still shows "Install to test". (Mock `reviewPlayRoute` → `{html:"<h1>x</h1>"}`; `Runner` renders a sandboxed iframe — assert the dialog/role is present, not the iframe internals.)
- [ ] **Step 2: run RED.**
- [ ] **Step 3: implement** the route + the detection + button swap + `PlayModal`. Read `Runner.tsx` props + `ConnectGitHubModal.tsx`/`useDialogA11y.ts` first.
- [ ] **Step 4: GREEN** + full console suite + typecheck.
- [ ] **Step 5: commit** — `feat(review-ui): play a staged game in a sealed modal from the Reviews inbox`.

---

## Task 3: Full suite + PR
- [ ] `pnpm test` (root — the `/review/play` controller test is in the CI-gated `dist/__tests__`) and `pnpm -C packages/console exec vitest run` (console) — both green. tsc/typecheck clean.
- [ ] Push `feat/review-play`, PR against `main`: "feat: play a staged game in the review inbox (closes the install-to-test game shortcut)". Note it depends on the merged review-staging feature; console tests run locally. Watch `test (24)`; merge `--rebase` on green; verify commits landed.

## Self-Review
- Reuses the exact `gameHtml` extraction (find `type==="game"` → `.html`, 404 `not_a_game`) and the standalone `Runner` sealed player — no new sealing/security surface. ✓
- Broker-less Runner for staged play (no apiBase/name/needs) so a staged game can't reach the MCP-Apps capability broker. ✓
- Game→Play REPLACES Install (a workspace-installed game is untestable); non-game unchanged. ✓
- Play route is signed (`fetchReviewArchive`), returns only `{html}`. ✓

## Follow-ons
- Poster/thumbnail in the inbox row for game gems (the GameArtifact has `poster`).
- If a staged game declares `needs` (capabilities), decide whether to broker them in review (currently broker-less — safest).
