# Stone Rating (Gem Contributions #C — stars + scorecard-floor gem rating) — Design

**Date:** 2026-06-30
**Status:** Approved-pending-review — subsystem **C** of the Gem Contributions program (the "remaining items" set was A console publish → B marketplace upload → **C stone rating**). Follows #3 (cuts/`type`) and #4a (`publishedBy`) — same additive-discovery-field pattern.

## Goal

Render a **1–5 "Stone" rating** on each marketplace gem: **N filled gemstones in the cut's color** (the color already ships via #5-browse's `CutBadge`; C adds the *count*). The count is
`stones = max(scorecardFloor, starCurve(starCount))`, clamped 1..5 — an **authoring-quality floor** (baked into the `.gem` at build) raised by **community stars** (the existing public `/api/stars?kind=gem` counts). **No new adoption/telemetry pipeline** (that stays deferred); no server-observed installs — the marketplace/registry can't see installs, so we deliberately use stars + the authoring scorecard as the honest v1 signal.

## Decisions (settled with the user)

1. **Adoption signal = stars only.** Defer the real install/adoption telemetry pipeline. The rating blends public star counts with an authoring floor.
2. **Rating model = `max(floor, starCurve)`.** A well-built gem shows a respectable rating at 0 stars; stars push it up. Avoids the "everything is 1 stone at low scale" failure of a pure star threshold.
3. **Floor baked into the `.gem` at build time.** The scorecard floor is an *authoring* property, so it travels *inside* the gem — both publish paths (console **and** marketplace upload) then forward it uniformly to `discovery.grade`, exactly as `artifactKinds`/`type` already travel with the gem. (Computing it live at publish is impossible on the upload path, which only has `.gem` bytes.)
4. **💎 Diamond apex seal = deferred.** Needs broad real adoption; dishonest at current star scale. Not built.

## Context (ground-truth verified)

- **All gem builds funnel through one function:** `buildGem(inventory, selection, opts)` (`packages/build/src/buildGem.ts:27`, opts at :30). ~6 call sites in `src/gem.controller.ts` (`/gem`, `/scorecard/build`, `/scaffold-checks`, `/transfer/send`, …) all call it. **Single baking seam.**
- **The `Gem` type** (`packages/model/src/types.ts:144`): `{ name, createdFrom, artifacts, checks, requiredSecrets }`. `GemSchema` (`src/schemas.ts:413`) mirrors it. → add optional `grade`.
- **The scorecard axes are session-derived:** `aggregateScorecard(loads,…)` (`src/gem/scorecard.ts:85`) computes `breadth` (distinct workflow keys), `battleTested` (candidates with `priorConfidence==="high"`), `portable` (high-confidence + non-local tools via `isPortable`). Data lives on `ProcedureCandidate`s. The **`/scorecard/build`** endpoint (`gem.controller.ts:385`) already loads these candidates (`loaded.candidates`, `isPortable(c)`) when it builds the "goldmine" gem — so a floor **is** derivable there. The plain **`/gem`** path builds from an introspected inventory that does not carry per-workflow confidence, so a floor is **not** reliably derivable there.
- **`buildGem` does NOT receive the scorecard.** It gets `inventory`+`selection`+`opts`. So the floor is computed by the *caller* that has scorecard data and passed via a new `opts.grade`.
- **Discovery threading pattern (mirror exactly):** `RegistryItemDiscovery` (`packages/distribute/src/registry.ts:13`) already carries additive `type?` (:19) and `publishedBy?` (:20). `buildDiscovery(gem, scope, opts)` (:206) copies `opts.type`/`opts.publishedBy` onto `d` (:216). `publishGem(args)` (:243/:262) threads them. → add `grade?: number` the same way.
- **Public catalog:** `RegistryGemSchema` (`src/schemas.ts:703`) + `src/gem/publicCatalog.ts` `RegistryGem` + the marketplace's own `packages/marketplace/src/types.ts` `RegistryGem` are three mirrors the catalog flows through. Each gets `grade?`.
- **Marketplace is standalone** (cannot import `@agentgem/model`). It already mirrors the server's cuts in `packages/marketplace/src/gems/cuts.ts` (`CUTS`/`cutMeta`, provably mirroring `BUILTIN_CUTS`). The stone-rating pure fn is mirrored the same way. Stars are fetched via `makeStars` (`stars.ts`, `GET /api/stars?kind=gem&ids=…` → `{ counts: { id: number } }`).
- **#5-browse render:** `CutBadge` (`packages/marketplace/src/CutBadge.tsx`) renders one colored pill from `cutMeta(cut)`; used inside the gem card `<a>` (card-anchor invariant: badge is a `span` inside `<a>`, `StarButton` a sibling after `</a>`).

## The three bugs in the obvious sketch (must avoid)

1. **Fabricating a floor where there's no scorecard.** The plain `/gem` build path lacks per-workflow confidence. Do **not** invent a floor from thin data — leave `grade` **undefined** there. Undefined `grade` → marketplace uses `floor = 1` → pure `starCurve`. Honest: no floor claimed when none is measured.
2. **Baking a *rating*, not a *floor*.** `gem.grade` is the **floor only** (1..3, authoring quality). The final 1..5 stone count is computed **client-side** by blending with live stars. Never bake stars into the gem (they change; the gem is immutable).
3. **Star fetch fanout.** The gem list page must not issue one `/api/stars` request per gem. `makeStars.get(kind, ids[])` already takes a batch of ids → fetch all counts in one call for the visible list (mirror how star counts are already batched).

## Components (files)

### Model / build (the floor)
- **`packages/model/src/gemGrade.ts`** (new, DI-free, pure) — `scorecardFloor(sc: { breadth: number; battleTested: number; portable: number }): 1 | 2 | 3`. Rubric (clamped 1..3):
  `let f = 1; if (battleTested >= 1) f++; if (portable >= 1) f++;` → i.e. a gem with at least one high-confidence workflow floors at 2, and one that's also portable floors at 3. `breadth` is not part of the floor (breadth alone isn't quality) but is accepted for a future tweak. Exported alongside a `GEM_GRADE_MIN=1`/`GEM_GRADE_MAX=3`.
- **`packages/model/src/types.ts`** — `Gem` gains `grade?: number` (the baked floor, 1..3; absent when not measured).
- **`packages/build/src/buildGem.ts`** — `opts` gains `grade?: number`; the returned gem sets `grade: opts.grade` (omit the key when undefined, so existing gem snapshots/digests are unchanged for gems built without a grade).
- **`src/schemas.ts`** — `GemSchema` gains `grade: z.number().int().min(1).max(3).optional()`.

### Server (compute at the scorecard build path + thread through publish)
- **`src/gem.controller.ts` `scorecardBuild`** (:385) — after collecting `chosen` candidates, compute the floor from exactly the selected candidates that go into the gem: `scorecardFloor({ breadth: distinct keys, battleTested: count priorConfidence==="high", portable: count isPortable })` and pass `grade` into `buildGem(…, { …, grade })`. (This is the "goldmine gem" path — the one with real confidence data.) The plain `/gem` path is left unchanged (no `grade`).
- **`packages/distribute/src/registry.ts`** — `RegistryItemDiscovery.grade?: number`; `buildDiscovery` opts + copy (`if (opts.grade != null) d.grade = opts.grade`); `publishGem` args + thread. Mirror `type`/`publishedBy` line-for-line.
- **Both publish paths forward `gem.grade`:**
  - console publish (`registryPublish` in `gem.controller.ts`) — pass `grade: gem.grade` (whatever the built gem carries).
  - marketplace upload-publish (`src/registry/uploadPublish.ts`, shipped in B) — `importGem(bytes).gem` already yields the gem; pass `grade: gem.grade` to `publishGem`. **`grade` is read from the archive, never from the request body** (same unforgeable-by-construction posture as `publishedBy`).
- **`src/gem/publicCatalog.ts`** (`RegistryGem`) + **`src/schemas.ts` `RegistryGemSchema`** — add `grade?: number`, populated from `discovery.grade`.

### Marketplace (blend + render)
- **`packages/marketplace/src/types.ts`** (`RegistryGem`) — add `grade?: number`.
- **`packages/marketplace/src/gems/rating.ts`** (new, pure, mirrors the server curve) — `starCurve(stars: number): 1|2|3|4|5` (0→1, 1–2→2, 3–7→3, 8–20→4, 21+→5) and `stoneRating(floor: number | undefined, stars: number): number` = `Math.min(5, Math.max(floor ?? 1, starCurve(stars)))`.
- **`packages/marketplace/src/StoneRating.tsx`** (new) — renders `N` filled gemstones + `5−N` outline, in the cut's color (`cutMeta(cut)?.color`, falling back to a neutral gem when the cut is unknown). Small, inline, card-anchor-safe (a `span`). Accepts `{ cut, grade, stars }`.
- **`packages/marketplace/src/pages/Gems.tsx`** — fetch star counts for the visible gems in one batched `stars.get("gem", ids)` call; render `<StoneRating cut={g.cut} grade={g.grade} stars={counts[g.key] ?? 0} />` on each card (beside or under the existing `CutBadge`). **`packages/marketplace/src/pages/Gem.tsx`** — same on the detail page.

## Testing

- **`scorecardFloor`** (`packages/model` unit): 0/0/0→1; battleTested≥1→2; battleTested+portable→3; clamps at 3.
- **`buildGem`** (`packages/build`): `grade` passed through to the gem; omitted key when undefined (snapshot/no-grade gem unchanged).
- **`scorecardBuild`** (server): a build over high-confidence portable candidates yields `gem.grade === 3`; over low-confidence candidates yields a lower/absent grade. (Reuse the existing scorecardBuild test fixtures.)
- **`buildDiscovery`/`publishGem`** (`packages/distribute`): `grade` threads onto discovery when supplied; absent otherwise (mirror the `type`/`publishedBy` tests).
- **upload-publish** (`src/registry/__tests__/uploadPublish.test.ts`, extend): a `.gem` carrying `grade` publishes with `discovery.grade` set from the archive; a request body attempting to set `grade` is ignored (unforgeable — the field isn't read from the body).
- **`stoneRating`/`starCurve`** (marketplace unit): curve boundaries (0,1,3,8,21); `max(floor, curve)` (floor 3 + 0 stars → 3; floor 1 + 25 stars → 5; clamp at 5).
- **`StoneRating.tsx`** (marketplace component): renders N filled of 5 in the cut color; unknown cut → neutral, no crash; grade undefined + 0 stars → 1 filled.
- **`Gems.tsx`** (marketplace): stars fetched in ONE batched call for the list (assert a single `stars.get` with all ids); a gem with `grade` + stars renders the blended count.
- Gates: server `pnpm exec tsc -b` + full `pnpm test` (build console first); `pnpm --filter @agentgem/marketplace test|typecheck|build`.

## Out of scope (deferred)

- **💎 Diamond apex seal** — needs broad real adoption; not honestly reachable from stars at current scale.
- **Real install/adoption telemetry** — the aggregator `UsageAttestation` pipeline for gem installs (registryInstall/applyGem/runGemWithAgent emit sites) stays deferred. When it lands, it *raises* the rating above the star curve the same way stars do — the `max(floor, …)` shape absorbs it.
- **Floor on the plain `/gem` build path** — left unmeasured (grade undefined) until that path carries confidence data; those gems rate on stars alone. Not a regression (no rating exists today).
- **Backfilling `grade` onto the already-published `@ninemind/brainstorming-kit`** — optional one-off (like the #5-browse `type` backfill); note but don't require.

## Risks

- **Floor asymmetry by build path** (scorecard-build has it, plain /gem doesn't) — accepted and honest: undefined→pure-stars, never a fabricated floor. Documented in the UI copy if needed ("rating grows with community stars").
- **Immutable-gem digest** — adding `grade` to a gem changes its serialized bytes/digest for gems that carry it. New gems only; already-published gems are untouched (re-publishing the same version is a no-op). Confirm the omit-when-undefined keeps existing no-grade gems byte-identical.
- **Star curve tuning at scale** — the thresholds are a guess for a young registry; they're a single pure fn (`rating.ts`), trivially retunable, and mirrored on one server curve doc. Not load-bearing for correctness.
- **Hot files** — `registry.ts`, `gem.controller.ts`, `schemas.ts`, marketplace `Gems.tsx` are concurrently active; keep diffs additive, branch off latest `origin/main` (98d6764), integrate promptly.
