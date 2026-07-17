# App Redesign P0 — implementation plan

Executes the eng+design-reviewed spec (`../agentgem-biz/strategy/app-redesign-proposal.md`,
reviewed 2026-07-16). P0 = first-run reveal + progressive disclosure. Worktree
`agentgem-worktrees/app-redesign`, branch `app-redesign` off origin/main 542a4c92.

## Global Constraints

- **Build/test:** full rebuild = root `pnpm build` (`tsc -b && node scripts/build-console.mjs`);
  root tests = `pnpm test` (vitest over compiled `dist/**/__tests__`; `tsc -b` is the typecheck).
  Console tests = `cd packages/console && pnpm test` (vitest+jsdom, capped 4 workers) — **NOT in
  CI; must pass locally.** Run only suites covering your change per task; the final task runs
  everything.
- **Design tokens (mandatory, no new colors/typefaces):** `packages/console/src/shell/theme.css` —
  paper `#f1eadb`, ink `#20190f`, ink-soft `#463d2c`, muted `#8a7f69` (muted only for ≥14px
  secondary text; body text uses ink-soft), terracotta accent `#9a3324` (ONE primary action per
  surface), emerald `#2f6b3a` (means "certified/battle-tested" only), hairline `#ddd0b7`.
  Display font Fraunces (`--font-display`), UI Hanken Grotesk (`--font-ui`).
- **agentback contract:** the server validates-but-never-strips responses; the CONSOLE Zod schemas
  (packages/console/src/api/routes.ts) STRIP unknown fields and THROW on missing ones — every new
  field added to a console response schema must carry `.default(...)` where a default is sensible.
- **No module-scoped mutable state** — React state/hooks/context only.
- **Hidden ≠ unregistered:** every page stays routable by hash forever; disclosure filters the rail
  render only. Visiting a hidden route neither errors nor unlocks.
- **Unlock is server state**, never localStorage (desktop app and browser are different origins).
  Group-expansion UI state IS localStorage (matches `sidebar.ts` idiom).
- **Motion:** exactly three (scan progress, count-up, status pulse); all honor
  `prefers-reduced-motion` by rendering static final values.
- Each task: TDD (failing test first where practical), commit at end with a specific message,
  ending with `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`.

## Task 1: Backend — WorkflowItem evidence fields + composed home-summary endpoint

**Files:** `src/gem/scorecard.ts`, new `src/home.controller.ts` (register alongside existing
controllers — grep how `gem.controller.ts`/`dream.controller.ts` are registered),
`packages/console/src/api/routes.ts`, tests beside existing controller tests (root `src/**/__tests__`
pattern — note vitest runs the compiled `dist/**` copies; run via `pnpm test` after `tsc -b`).

1. Extend the exposed `WorkflowItem` (currently `{ key, name, confidence, portable }`,
   `src/gem/scorecard.ts:~38`) with `sessions: number` (evidence/source count) and
   `lastSeenMs: number`. Read `scoreProject`/candidate plumbing to find the truthful source
   (skeleton source counts / transcript mtimes). If a field is genuinely unavailable without new
   scanning, populate with 0 and note it in your report — do not invent data.
2. New endpoint `GET /api/home/summary` returning ONE composed read model:
   - `usage`: totals aggregated from `scanSessionsCached` (`@agentgem/insight` observeScan —
     Claude+Codex): `{ sessions, spanDays, activeMs, tokensIn, tokensOut, tokensCache }`.
     NOTE: `src/usage/reporter.ts` is the signed-in aggregator POST side-effect — do NOT use it as
     the read model; reuse the observe aggregation the Overview/observe routes already use (grep
     `scanSessionsCached` call sites).
   - `claudeSessions: number` (Claude-only session count — the fire-gate input).
   - `gate`: `{ usageEmpty: boolean, claudeBelowGate: boolean }` with the gate constant
     `CLAUDE_GATE_MIN_SESSIONS = 10` defined server-side.
   - `scorecardCached: boolean` (a cached scorecard exists → the reveal can pre-fill stale).
   - `projectsScanned: number` and `projectsCap: number` (the 12-recent cap from
     `scorecard.ts:33`) so the UI can label scope honestly.
3. Console route schema for `/home/summary` in `packages/console/src/api/routes.ts` with
   `.default()` on every new field (see Global Constraints).
4. Tests: endpoint returns composed shape on a temp AGENTGEM_HOME with seeded transcripts (follow
   existing controller test fixtures); gate flags flip at the boundary (9 vs 10 Claude sessions);
   WorkflowItem carries the new fields.

## Task 2: Backend — homeState (unlock, migration, reveal-seen)

**Files:** new `src/home/state.ts` (persistence — follow the `src/dream/store.ts` JSON-in-HOME
idiom), extend `src/home.controller.ts`, `packages/console/src/api/routes.ts`, tests.

1. Persisted `homeState` in AGENTGEM_HOME (JSON file): `{ unlockedAt?: number,
   firstSeenVersion?: string, existingUser?: boolean, revealSeenAt?: number }`.
2. On first read when the file is absent: compute `existingUser` ONCE = other AGENTGEM_HOME
   artifacts predate this feature (transcript index / warm cache / config file exists — grep HOME
   layout helpers to enumerate candidates); record `firstSeenVersion` = current package version.
3. `GET /api/home/state` → `{ unlocked, existingUser, revealSeen }` where
   `unlocked = unlockedAt set OR existingUser OR (≥1 gem exists — reuse the inventory/gems lookup
   the console's gems routes use)`. One-way semantics: unlock never reverts (deleting gems does not
   re-lock).
4. `POST /api/home/state` body `{ unlocked?: true, revealSeen?: true }` — sets timestamps, one-way
   only (reject/ignore false).
5. Console schemas with `.default(false)`s. Tests: fresh HOME → not existingUser, locked; HOME with
   pre-existing artifacts → existingUser+unlocked; unlock persists; revealSeen persists; gems-exist
   path unlocks.

## Task 3: Console contract + registry — groups and disclosure flags

**Files:** `packages/console/src/contract.ts`, `packages/console/src/registry.ts`, every
`packages/console/src/panels/*/index.tsx` page definition that gains a flag, registry tests
(`packages/console/src/` test conventions — colocated `*.test.ts(x)`).

1. `ConsolePage` gains: `group?: "make" | "evidence" | "background" | "power"`,
   `hiddenUntilUnlock?: boolean`, `hidden?: boolean` (never in rail — Publish only).
2. Page assignments (disposition table §4 of the proposal):
   - Foreground (no group, always visible): overview (Home), curate, gems; footer unchanged:
     settings, memory.
   - `make` + hiddenUntilUnlock: materialize, deploy, setup.
   - Publish: `hidden: true` (registry publish is disabled in code; panel stays routable).
   - `evidence` + hiddenUntilUnlock: benchmark, rubrics, rubricLibrary, sessions, recall, sources.
   - `background` + hiddenUntilUnlock: mine, dreaming, optimize, watch.
   - `power` + hiddenUntilUnlock: reviews, chat, play, arcade.
3. `registry.ts`: new `railModel(pages, unlocked)` → `{ foreground: ConsolePage[], groups: Array<{
   key, label, pages }> }` with group order Make · Evidence · Background · Power tools; groups
   empty/omitted when locked; `hidden` pages never appear. Update `assertPlacement` so a page is
   valid with (phase|footer) OR group — do NOT break existing pages. Keep `phaseGroups` working
   during the transition (Task 4 retires its use in Shell; do not delete it here).
4. Tests: railModel locked → exactly overview/curate/gems foreground, no groups; unlocked → four
   groups in order with the assignments above; publish never present; footer unchanged.

## Task 4: Shell — grouped rail, unlock hook, Show everything, route fallback

**Files:** `packages/console/src/shell/Shell.tsx`, `packages/console/src/shell/theme.css`,
`Shell.test.tsx` (+ new tests), small hook file (e.g. `packages/console/src/shell/useHomeState.ts`).

1. `useHomeState()` hook: fetches `GET /api/home/state` (via the typed api client in
   `packages/console/src/api/`), exposes `{ unlocked, existingUser, revealSeen, setUnlocked,
   setRevealSeen }` (POSTs one-way). React state only.
2. Shell nav renders `railModel(pages, unlocked)`: foreground items always; groups as collapsed
   labeled headers (`Make`, `Evidence`, `Background`, `Power tools`) with per-group expansion
   persisted in localStorage key `agentgem.console.groups` (same defensive-parse idiom as
   `sidebar.ts`). The Observe/Build phase toggle RETIRES from the rail (keep `phase` metadata on
   pages; remove the toggle UI + `goPhase`; per-phase route memory simplifies to last-route).
3. Nav footer gains **"Show everything"** (only while locked): expands all groups AND
   `setUnlocked(true)`.
4. Route resolution: keep exact/prefix matching for ALL pages (hidden included); fallback (empty or
   unknown hash) targets overview's route explicitly.
5. `requiresGem` dim behavior unchanged and composes with groups (Deploy visible in Make when
   unlocked, dimmed without an active gem).
6. Styling: group headers in Hanken Grotesk smallcaps muted (≥14px), hairline separators; no new
   colors.
7. Tests (REGRESSION-CRITICAL, mandated by eng review): (a) default/unknown hash lands on
   overview; (b) deep links `#/optimize`, `#/watch`, `#/publish` still resolve to their panels
   while hidden from rail; (c) `requiresGem` still dims post-unlock; (d) locked rail shows exactly
   Home/Curate/Gems + footer; (e) unlocked rail shows the four groups; (f) Show everything unlocks
   (POST called) and expands; (g) group expansion persists across remount via localStorage.

## Task 5: Home/reveal panel — consent, streaming reveal, states, broadsheet layout

**Files:** `packages/console/src/panels/Observe/index.tsx` (Home rendering; keep the page id
`overview` and route `#/overview`), new component files under `panels/Observe/` (e.g. `Reveal.tsx`,
`useRevealData.ts`), `theme.css` additions, colocated tests. Reuse `panels/Mine/Scorecard.tsx` +
`card.ts` components for the returning-user scoreboard — do not re-render a second scorecard UI.

Visual reference: the approved Broadsheet mockup
(`~/.gstack/projects/ninemindai-agentgem/designs/first-run-reveal-20260716/reveal-variants.html`,
variant B) — masthead, 54px-class Fraunces headline sentence, hairline ledger row, one terracotta
CTA. Hero copy (literal): kicker terracotta **"You're sitting on a goldmine:"** then
**"`B` reusable workflows — `T` battle-tested, `P` ready to share."** Subline (ink-soft):
**"mined from `N` sessions over `X` days — ~`H` active hours, `M` tokens — across your
`projectsScanned` most recent projects."**

1. Mode selection via `useHomeState` + `GET /api/home/summary`:
   - First run (`!revealSeen && !existingUser`): consent beat → ceremony.
   - Existing user (`existingUser && !revealSeen`): one-time dismissible "here's what changed +
     your numbers" ceremony variant (dismiss ⇒ `setRevealSeen`).
   - Returning (`revealSeen`): condensed masthead scoreboard (Mine scorecard components) + the
     Overview panel's existing content beneath. NO deltas (P0.5).
2. **Hard pre-consent gate:** in first-run mode render masthead + one sentence + one button ONLY —
   *"AgentGem reads your local session history — locally; nothing leaves this machine — to find
   what you've built."* / button **"Scan my sessions"**. No `/home/summary`, no scorecard stream,
   no observe fetches before the click.
3. On consent: fetch summary + open `GET /api/scorecard/stream` (SSE — reuse the console's existing
   stream consumption pattern; grep how Mine/insights consume `streamOf` routes). Render the reveal
   skeleton (paper, hairlines, empty ledger slots) immediately; numbers COUNT UP driven by ONE
   shared rAF loop as frames land; `prefers-reduced-motion` ⇒ static final values; `aria-live="polite"`
   announces final values once.
4. States (each a rendered branch with literal copy, per proposal §3.3): loading skeleton;
   slow (>8s: usage half complete, goldmine section "still assaying your workflows…"); truly cold
   (usage empty AND claudeBelowGate) → prospecting state *"Not enough history to assay yet —
   AgentGem needs about 10 sessions."* (do NOT promise the warmer is watching — it may be off);
   Codex-heavy (usage present, claudeBelowGate) → full usage half + goldmine section shows the
   Claude-only explainer (*"workflow analysis reads your Claude sessions — usage covers Claude +
   Codex"*), NEVER prospecting copy; sparse (a zero asset count) → that ledger row is not rendered,
   substitute earn-it line; per-section degrade row on partial errors; hard failure → diagnostic
   state (what failed, path in mono, one retry button).
5. Gaps whisper BELOW the CTA block, muted italic: *"Still unmined: …"* from scorecard gaps.
   Provenance footnote at the bottom (muted, 12-13px is acceptable for footnote per mockup).
6. Tests: mode selection (4 modes); pre-consent makes zero API calls (assert fetch spy); fire-gate
   branches (cold / codex-heavy / rich); zero-row suppression; reduced-motion static render;
   count-up reaches exact final values; retry on hard failure refetches.

## Task 6: CTA — deterministic build now, distill enrichment behind it

**Files:** `panels/Observe/Reveal.tsx` (CTA + working state), possibly a small
`panels/Observe/useFirstGem.ts`, `src/gem.controller.ts` ONLY if the existing endpoints need a
missing field (prefer zero backend change), tests.

1. FIRST: read `POST /api/scorecard/build` (`gem.controller.ts:981`, body
   `ScorecardBuildRequestSchema`, response `GemSchema`) and confirm request shape for "build THIS
   candidate". Report what it actually does in your report.
2. CTA (one terracotta primary): label **"Turn your top workflow into a Gem"**, sub-line
   *"assembled now — deep distill keeps improving it in the background."* Candidate = highest
   confidence battleTested; tiebreak confidence then `lastSeenMs` (Task 1 fields). Display: title +
   evidence counts only. Secondary text affordance *"choose a different one"* → opens the candidate
   list (simple inline list; no new panel).
3. On click: disable immediately (double-click guard) → `POST /scorecard/build` → on gem: ceremony
   moment (emerald gem card, Fraunces name, one continue action), `setUnlocked(true)` via
   homeState, THEN kick the background distill enrichment (the existing background distill path —
   grep `POST /inspect/distill` / `computeDistill` kickoff used by Curate) fire-and-forget with
   `.catch` surfaced to the status line only. Continue action routes to Curate with the gem
   (existing Curate deep-link/naming flow).
4. Build failure: CTA re-enables with candidate preserved + *"try again"* + utility-language error
   line. Enrichment failure never revokes the built gem.
5. Tests: click → build called once (double-click guarded); success → unlock POSTed + ceremony
   rendered; failure → candidate preserved + retry works; enrichment kickoff fired after gem
   exists; enrichment failure does not unmount ceremony.

## Task 7: Rail-footer status line + Review inbox badge

**Files:** `packages/console/src/shell/Shell.tsx` (footer), small `useBackgroundJobs.ts` hook,
`theme.css`, tests.

1. Status line above footer pages: composes EXISTING transient signals only — warm status (grep the
   warm status route the console already uses, e.g. `/api/warm/status`) + any active background
   tasks it exposes. Renders: active → *"Working in the background: N jobs ▸"* with a quiet
   terracotta-free pulse (opacity, not color); idle → *"Background jobs idle"*; warm disabled/off
   (desktop default `AGENTGEM_WARM=off`) → *"Background jobs off — enable in Settings"*. Expands
   inline to a small job list; rows deep-link to the demoted panels (`#/mine`, `#/dreaming`, …).
   NO new job framework; no durable history.
2. Review inbox rail entry: piggyback the existing dream queue status/poll (grep how Dreaming polls
   `/api/dream/queue` or status — reuse, don't add a new poller). When queue count > 0, a rail item
   **"Review inbox"** with count badge appears among foreground items, routing to the Dreaming
   panel's queue view. Absent at 0.
3. Tests: off/idle/active renderings; job rows deep-link; inbox absent at 0, present with badge at
   n>0, routes to dreaming.

## Task 8: Migration ceremony, a11y/motion sweep, full verification

**Files:** touched panels/shell from prior tasks; no new surfaces.

1. Existing-user one-time ceremony variant (Task 5 mode 2) gets its final copy: *"AgentGem has a
   new home screen — here's what your sessions add up to."* + dismiss ("Take me to my console") ⇒
   `setRevealSeen`, full nav from first paint (existingUser ⇒ unlocked already, Task 2).
2. Unlock choreography: after the Task 6 ceremony, groups animate into the rail (CSS transition,
   one-line labels), `aria-live="polite"`: *"Console unlocked — 4 new groups."*
   `prefers-reduced-motion` ⇒ no animation.
3. Sweep: muted-ink usage ≥14px only (grep new classes); every new `ex-`/class has a matching
   `theme.css` rule; focus-visible on all new interactive elements (global idiom); ledger rows
   full-row clickable ≥32px.
4. Run EVERYTHING locally: root `pnpm build` then `pnpm test`; `cd packages/console && pnpm test`
   and typecheck. Fix fallout (the default-route change WILL break existing Shell/App tests — that
   is the mandated regression work, update them intentionally, never delete assertions).
5. Browser verification of the signature funnel per the repo's verify recipe (temp AGENTGEM_HOME:
   consent → scan → reveal → CTA → gem ceremony → unlock ramp; then existing-user path with a
   seeded HOME). Screenshot evidence in the report.
