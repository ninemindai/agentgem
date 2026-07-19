# gemit Interactive Report ("Training Grounds") — Design

Approved 2026-07-19. Upgrades the gemit rpg report from a static sheet to an interactive,
animated one — improvement actions, a what-if simulator, and a juice pass — while keeping the
scoring deterministic and the document self-contained. Ships on BOTH the local report and the
shared card (same single template, same payload).

## Constraints (inherited, non-negotiable)

- **Self-contained HTML**: inline CSS/JS only, no external URLs, data: assets only. Must run
  inside the marketplace's sealed iframe (CSP `default-src 'none'`, null-origin sandbox) AND as
  a local file. `navigator.clipboard` may be unavailable in the sandbox — degrade, never depend.
- **Themes are presentation-only** over one payload; scoring never varies by theme. Two runs over
  the same inputs produce the same card.
- **Privacy**: the share variant strips `topSkills`/`topSubagents` names. Nothing in this design
  may reintroduce names into the shared document. New payload fields are counts only.
- **Honesty split (the core design rule)**: the MEASURED score is immutable on screen. All
  interactivity operates on a visually distinct PROJECTED layer (the Training Grounds). Exact
  projections only where the payload fully determines them; anything else is labeled "assumed".
- `prefers-reduced-motion` disables all animation (existing rule, extended to new effects).

## 1. Core mechanic — measured vs. projected

New **Training Grounds** section below The Three Disciplines:

- A what-if copy of the three discipline bars with drag handles. Pointer (click/drag on track)
  and keyboard (`role="slider"`, `aria-valuenow`, arrow keys ±1, shift+arrow ±5) both work.
- A what-if value can never go below its measured value (training doesn't remove skill; also
  keeps the projection ≥ measured invariant simple).
- Projected rank line recomputes live: `round(0.4·ctx + 0.4·proc + 0.2·setup)` with the weights
  and tier thresholds interpolated at render time from `score.ts` exports — no constant drift.
- Crossing a tier threshold upward: tier name flips (CSS 3D flip) + a ~30-particle confetti
  burst (positioned divs, no canvas dependency); crossing downward flips back quietly.
- **"Chart my path to Master Lapidary"** button (label uses the actual next/top tier name):
  computes the smallest slider deltas to reach tier 4 (greedy by composite-points-per-axis-point:
  ctx/proc first at weight .4, setup last at .2, capped at 100 each) and animates the sliders
  there over ~1.2s. At top tier already → button reads "You're at the summit" and is disabled.

## 2. Quest log — actions that drive the simulator

"Still Sealed" (locked perks) and "Shadows to Train" (fired findings) merge into a **Quest Log**;
"Techniques Unlocked" stays as-is (trophies).

Each quest row: checkbox + title + remedy line + effect chip + (for perk quests) a progress meter.

- **Progress meters (exact)**: every locked perk's threshold and current value are in the payload
  (bounded rate, subagentVariety/5, skillVariety/8, boundedStreak/20, verifyRatePct/60). Render
  `current/target` with a small meter bar.
- **Remedies (static mapping, presentation-side)**: keyed by perk name / finding id with a generic
  fallback. Setup remedies are the product funnel ("install skill/subagent gems"); context
  remedies reference /clear + delegation; process remedies reference verify-before-done. Any
  command string (e.g. `npx -y @ninemind/agentgem gemit`) renders select-on-click with a
  try/catch clipboard copy button.
- **Effect chips**: checking a quest animates the corresponding what-if slider up by the quest's
  effect; unchecking reverses it. Interplay with manual drags is increment-based: a check adds
  its delta to the axis's CURRENT what-if value, an uncheck subtracts it, and manual drags set
  the value directly without touching checkboxes — everything clamps to [measured, 100].
  - **Setup quests: exact.** With the new payload fields (§4) the setup formula
    `0.45·skillSessionsPct + 0.25·subagentSessionsPct + 0.15·min(1, skillVariety/10) +
    0.15·min(1, subagentVariety/5)` is fully recomputable client-side, so "add N skill types"
    or "use skills in more sessions" quests carry true "+N pts" chips.
  - **CTX/PROC quests: assumed.** Per-session detector inputs don't ship, so these chips read
    "assumed +5" (finding quests; +3 for perk-style habits) and are visually tagged `~`.
  - **Degradation**: on already-published cards missing the §4 fields, setup quests fall back to
    assumed chips too. The script feature-detects fields, never crashes on old payloads.

## 3. Juice pass

- Rank number counts up 0→N (~1s, rAF, ease-out); tier name stamps in (scale 1.15→1 settle).
- Measured bars fill staggered (0.15s base delay + 0.12s/bar — keeps the existing screenshot
  caveat, documented in code).
- Perk/quest cards: subtle hover lift. All effects ≤300ms except the two entrance animations.
- `@media (prefers-reduced-motion: reduce)`: every animation and the confetti are disabled;
  count-up renders final values immediately.

## 4. Payload additions (additive, both variants)

In `src/gemit/score.ts`:

- `GemitData` gains `skillSessionsPct: number` and `subagentSessionsPct: number` (0–100 ints,
  share of qualifying sessions that used ≥1 skill / ≥1 subagent). Computed from existing
  aggregation locals; counts only, so the share privacy strip is untouched.
- Export `COMPOSITE_WEIGHTS = { ctx: 0.4, proc: 0.4, setup: 0.2 }` and
  `SETUP_WEIGHTS = { sessions: 0.45, subSessions: 0.25, variety: 0.15, subVariety: 0.15 }`;
  `computeGemitData` uses them (no numeric behavior change), the theme interpolates them.

## 5. Architecture & testability

- All new logic stays in the `rpg` theme file family. `themeRpg.ts` keeps the template;
  a new sibling **`themeRpgSim.ts`** holds the pure simulation functions:
  - `projectComposite(ctx, proc, setup, weights): number`
  - `tierFor(composite, thresholds): 1|2|3|4` (reuses score.ts's exported thresholds)
  - `autoSolvePath(current: {ctx,proc,setup}, targetTier, weights, thresholds): {ctx,proc,setup}`
  - `setupScoreFrom(fields, setupWeights): number` and `questEffects(data): QuestEffect[]`
    (each `{id, axis, delta, exact}`)
- These are unit-tested in TS, then serialized into the page with `Function.prototype.toString()`
  (we ship plain tsc output, never minified — documented in a code comment as a load-bearing
  assumption). Rules for serializable functions: no closures, no imports, params-only — enforced
  by a test that `new Function`-revives each serialized body and re-runs a sample case.
- The page script is one inline `<script>` reading `#gemit-data`, wiring sliders/quests/confetti
  to the revived pure functions. Render tests assert: island carries the new fields + weights,
  slider roles exist, quest remedies and effect chips render, reduced-motion block present.
- Tests live in root `src/__tests__/` (gemitScore/gemitTheme/gemitSim additions); dist-test
  convention (`npx tsc -b` then vitest on `dist/__tests__/`).

## 6. Verification

- Unit: pure sim functions (composite/tier/auto-solve edge cases: already-top-tier, clamping,
  stacking), payload fields, render assertions, serialization revival test.
- Browser (real): open the local report — drag sliders, check quests, trigger confetti,
  auto-solve; then load the html through the marketplace `GamePlayer` sealed iframe (local vite
  dev) to confirm the sandbox doesn't break pointer/keyboard interactivity or the clipboard
  fallback. Screenshot both.
- Re-publish the dogfood card (`gemit --share --yes`, same-day upsert) so the live shared card
  exercises the interactive template end-to-end.

## Out of scope

- New themes (ninja/card) and theme-name labeling.
- Cover-image capture for OG.
- Any change to detectors, scoring math, tier thresholds, or the CLI surface.
