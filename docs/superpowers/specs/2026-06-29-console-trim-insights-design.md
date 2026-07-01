# Trim the Insights Panel from the Desktop Console — Design

**Date:** 2026-06-29
**Status:** Approved (brainstorming) — ready for implementation plan

## Goal

Remove the `Insights` panel from the desktop console (`packages/console`). It showed the network-wide aggregator dashboard (ingredient leaderboard, adoption pulse, per-ingredient detail), which is now **fully replaced by the live public marketplace** at `app.agentgem.ai`. The desktop console is a local-first app; network-wide discovery belongs in the public marketplace, not the desktop. Everything else in the console stays.

## Context

`packages/console` is the React desktop console (the journey IA: Curate · Materialize · Deploy · the Observe group · the Library group · Settings). The **Library** group holds four panels: `your-gems`, `insights`, `get-gems`, `received`. The marketplace (shipped & deployed, PR #31) reproduces — and supersedes — exactly what `Insights` displayed, reading the same public aggregator endpoints.

The console-UI and aggregator/marketplace lineages, previously split across two `main`s, have **reconciled**: `origin/main` now carries both the full console (incl. Insights) and the marketplace package + deploy config. This trim bases off `origin/main` and is purely a `packages/console` change.

## Scope decision

**Remove `Insights` only.** Get Gems stays. The two discovery panels are not symmetric:
- `Insights` is *exactly* replaced by the live marketplace M1 → removing it leaves **no gap**.
- `Get Gems` is a **registry search-and-install** panel; its public replacement is marketplace **M1.5 (gem-browse), which is not built yet** → removing it now would strand registry discovery/install. It is trimmed later, in the M1.5 slice.

## Removal surface

The Shell renders the nav from a data-driven panel list, so dropping a panel needs no Shell rewiring.

1. **Delete `packages/console/src/panels/Insights/`** — `index.tsx`, `Leaderboard.tsx`, `Pulse.tsx`, `Detail.tsx`, `Sparkline.tsx`, `data.ts`, and their `*.test.{ts,tsx}`. Nothing outside this directory imports these (the marketplace has its own independent copies).

2. **`packages/console/src/pages.tsx`** — remove the `insightsPage` import and its entry in the `pages: ConsolePage[]` array. `Shell`'s `groups.library` then renders without Insights automatically.

3. **`packages/console/src/api/routes.ts`** — remove the now-dead aggregator **client** routes (`popularity`, `co-occurrence`, `adoption`) and the types only Insights consumed (e.g. `AggIngredient`, `AggCoOccurrence`, `AdoptionPoint`, and any `RankedRow`/aggregate helpers exclusive to Insights). Verified: Insights is the **only** caller. The **server-side** aggregator controller is untouched — it serves the marketplace.

4. **Dead deep-link cleanup.** The `Insights/Detail.tsx` ingredient click was the only producer of the `GetGems/intent.ts` pending-query holder (`setPendingQuery` → navigate to `#/get-gems`). With Insights gone the holder is permanently dead. Remove it cleanly:
   - Delete `packages/console/src/panels/GetGems/intent.ts` and `intent.test.ts`.
   - Simplify `packages/console/src/panels/GetGems/index.tsx` to drop the `takePendingQuery` import + the `useState(() => takePendingQuery())` one-shot (Get Gems opens with an empty search box). All real Get Gems behavior — registry ready-check, search, install — is unchanged.

5. **Tests.** Insights tests are deleted with the directory. Update `GetGems/GetGems.test.tsx` to drop the pending-query cases (the imports of `setPendingQuery`/`takePendingQuery` and the deep-link assertions). Fix any panel-count or Library-group membership assertion that surfaces in `registry`/`pages`/`observeGroup` tests (a name grep found none referencing "insights", so changes here should be minimal or none).

## Out of scope

- **Get Gems** — kept; trimmed in the marketplace M1.5 slice.
- **Observe / Mine / Optimize / Received / Your Gems** — all local-relevant, kept.
- **Server aggregator API + controller** — kept (serves the marketplace).
- No nav/IA redesign, no relabeling of the remaining Library group.

## Testing / verification

- `pnpm --filter @agentgem/console test` — green (Insights tests gone; Get Gems + registry tests pass).
- `pnpm --filter @agentgem/console typecheck` — clean (no dangling imports/types).
- Build the console and **run it**: confirm the Library nav no longer lists Insights, the `#/insights` route is gone, and Get Gems / the other panels still work.

## Risks

- **Dangling references:** a missed import of an Insights export or a removed aggregate route/type would fail typecheck — the typecheck gate catches these.
- **Hidden Insights consumer:** mitigated by the verified grep (only Insights imports its own files and the aggregate routes); the build/typecheck confirms.
