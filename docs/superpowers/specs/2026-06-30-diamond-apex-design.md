# 💎 Diamond Apex Seal (Gem Contributions — the Cut × Stone capstone) — Design

**Date:** 2026-06-30
**Status:** Approved-pending-review — the visual capstone of the Cut × Stone program, now honestly reachable because #D (adoption telemetry) ships real k-anon install counts. Marketplace-only; the data (grade/stars/installs) already flows in from #C and #D.

## Goal

Render a **Diamond apex seal** on a gem that is maxed on all three orthogonal rating axes at once. Diamond is a **rare, cross-type apex — NOT a per-cut color**: when it qualifies, the 5-gemstone Stone rating row "graduates" from the cut's color to **5 diamond-white gemstones**. The row itself signals the apex; no extra glyph.

## Decisions (settled with the user)

1. **Predicate = all three axes maxed** (reuses the EXISTING curve breakpoints — no new magic numbers):
   `isDiamond = grade === 3 && starCurve(stars) === 5 && adoptionCurve(installs) === 5`
   i.e. best-built authoring floor (grade 3) AND community endorsement (≥21 stars) AND broad real adoption (≥50 k-anon installs). Genuinely rare, honest, cross-type.
2. **Render = replace with 5 diamonds** (the chosen visual): when `isDiamond`, all 5 gemstones render in a diamond-white/crystal treatment instead of the cut color; `title`/`aria-label` = "Diamond · apex". Otherwise the existing N-of-5 cut-colored behavior is unchanged.
3. **Marketplace-only, client-side** — like the rest of the rating, `isDiamond` is a pure fn in `gems/rating.ts` and the branch lives in `StoneRating.tsx`. No server change (grade from `RegistryGem.grade`, stars from `/api/stars`, installs from `/api/aggregator/gem-adoption` all already fetched).

## Context (ground-truth verified)

- `packages/marketplace/src/gems/rating.ts` (post-#D): `starCurve(stars)` (0→1…21+→5), `adoptionCurve(installs)` (0/<5→1, 5-9→3, 10-49→4, 50+→5), `stoneRating(floor, stars, installs) = min(5, max(floor??1, starCurve(stars), adoptionCurve(installs)))`.
- `packages/marketplace/src/StoneRating.tsx` (post-#D): `StoneRating({ cut, grade, stars, installs })` → `n = stoneRating(grade, stars, installs ?? 0)`; renders 5 `<span data-stone="filled|empty" className="ex-stone" style={{ color: filled ? fg : bg }}>◆</span>` where `fg`/`bg` come from `cutMeta(cut)` (or `NEUTRAL`). Rendered in `pages/Gems.tsx` (list) and `pages/Gem.tsx` (detail), which pass `cut`/`grade`/`stars`/`installs`.
- `packages/marketplace/src/styles.css` has `.ex-stones`/`.ex-stone` (from #C).
- Marketplace is standalone (mirrors), React 19 + Vitest + jsdom.

## Components (files)

### Predicate
- **`packages/marketplace/src/gems/rating.ts`** — add:
  ```ts
  // Diamond apex: maxed on all THREE independent axes at once (reuses the curve breakpoints).
  // Rare + honest + cross-type — grade 3 AND >=21 stars AND >=50 real k-anon installs.
  export function isDiamond(grade: number | undefined, stars: number, installs = 0): boolean {
    return grade === 3 && starCurve(stars) === 5 && adoptionCurve(installs) === 5;
  }
  ```

### Render
- **`packages/marketplace/src/StoneRating.tsx`** — after computing `n`, compute `const diamond = isDiamond(grade, stars, installs ?? 0);`. When `diamond`: render all 5 stones as filled with the DIAMOND palette (a diamond-white/crystal color, e.g. `fg = "#7fd7ff"` crystal-blue on a pale `bg`, or a dedicated `.ex-stone--diamond` class carrying the treatment); `title`/`aria-label` = `Diamond · apex · ${m?.gemstone ?? "gem"}`; add a `data-diamond="true"` hook on the `.ex-stones` wrapper for the test + styling. When not diamond: the existing behavior, byte-for-byte. Keep the glyph `◆` (styling, not a different character, carries the diamond read) OR use `♦` for the diamond variant — implementer's call to match the chosen mock; a subtle CSS shimmer (a gentle gradient/animation) is optional polish, not required.
- **`packages/marketplace/src/styles.css`** — add a `.ex-stone--diamond` (or `.ex-stones[data-diamond] .ex-stone`) rule for the crystal treatment (a diamond-white/blue tint; optional subtle shimmer). Keep it minimal, mirroring `.ex-stone`'s altitude.

## Testing

- **`isDiamond`** (`gems/rating.test.ts`, extend): true only when grade===3 AND stars≥21 AND installs≥50; false if any one is below (grade 2 / 20 stars / 49 installs each → false); false when grade undefined.
- **`StoneRating.tsx`** (`StoneRating.test.tsx`, extend): a qualifying gem (`grade={3} stars={21} installs={50}`) → the wrapper has `data-diamond="true"` and all 5 stones filled; a non-qualifying maxed-by-one-axis gem (e.g. `grade={3} stars={21} installs={0}`) → NO `data-diamond`, renders the normal 5 cut-colored (still `n===5` from stars, but not diamond). This distinguishes "5 of 5" from "Diamond".
- Gates: `pnpm --filter @agentgem/marketplace test | typecheck | build`.

## Out of scope (deferred / unchanged)

- No server change, no new data (grade/stars/installs already flow).
- Adoption sybil/quarantine, apply/run emit sites — separate deferred items (Diamond's honesty rests on #D's k-anon, which limits exposure; a sybil actor inflating installs to fake Diamond is bounded by the same k-anon + the future quarantine follow-up).
- A "Diamond" filter facet / sort — could follow, not now.

## Risks

- **Unreachable at current scale** — nothing has grade 3 + 21 stars + 50 installs yet, so Diamond shows nowhere today. Intended: it's the aspirational ceiling, laid ahead of the volume (like #C/#D). The predicate + render are exercised by tests, not live data.
- **Colorblind/contrast** — the diamond-white treatment must stay distinguishable from the neutral (unknown-cut) gray and from a light cut tint; pick a crystal-blue with sufficient contrast, and the `title`/`aria-label` "Diamond · apex" carries the meaning non-visually.
- **Hot file** — `StoneRating.tsx`/`rating.ts` are the same files #C/#D touched; additive branch, integrate promptly (branch off latest `origin/main` a88f150).
