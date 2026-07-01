# 💎 Diamond Apex Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Render a Diamond apex seal (5 diamond-white gemstones) when a gem is maxed on all three rating axes: `grade === 3 && starCurve(stars) === 5 && adoptionCurve(installs) === 5`.

**Architecture:** A pure `isDiamond` predicate in `gems/rating.ts` (reusing the existing curves) + a diamond render branch in `StoneRating.tsx`. Marketplace-only; grade/stars/installs already flow from #C/#D.

**Tech Stack:** `@agentgem/marketplace` (React 19 + Vite + Vitest + jsdom). Gates: `pnpm --filter @agentgem/marketplace test|typecheck|build`.

## Global Constraints

- Additive/surgical: the non-diamond render path stays byte-for-byte unchanged.
- Predicate reuses the existing `starCurve`/`adoptionCurve` breakpoints — NO new numeric thresholds.
- `title`/`aria-label` carries "Diamond · apex" so the meaning is non-visual (accessibility).
- Match neighboring style; MIT header if the marketplace files carry one (check a sibling).
- Commit identity: `git -c user.name="Raymond Feng" -c user.email="raymond@ninemind.ai" commit`; messages end with `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`. Stage explicitly; verify `git show HEAD --stat`.

---

### Task 1: `isDiamond` predicate

**Files:**
- Modify: `packages/marketplace/src/gems/rating.ts`
- Test: `packages/marketplace/src/gems/rating.test.ts` (extend)

**Interfaces — Produces:** `isDiamond(grade: number | undefined, stars: number, installs?: number): boolean`.

- [ ] **Step 1: Write the failing test** — add to `rating.test.ts`:
```ts
import { isDiamond } from "./rating"; // (add to the existing import)

describe("isDiamond", () => {
  it("is true only when maxed on all three axes (grade 3 + 21 stars + 50 installs)", () => {
    expect(isDiamond(3, 21, 50)).toBe(true);
    expect(isDiamond(3, 999, 999)).toBe(true);
  });
  it("is false if any single axis is below the max", () => {
    expect(isDiamond(2, 21, 50)).toBe(false);   // grade below 3
    expect(isDiamond(3, 20, 50)).toBe(false);   // stars below 21 (starCurve !== 5)
    expect(isDiamond(3, 21, 49)).toBe(false);   // installs below 50 (adoptionCurve !== 5)
    expect(isDiamond(undefined, 21, 50)).toBe(false); // no grade
    expect(isDiamond(3, 0, 0)).toBe(false);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm --filter @agentgem/marketplace test -- rating`
Expected: FAIL — `isDiamond` not exported.

- [ ] **Step 3: Implement** — in `packages/marketplace/src/gems/rating.ts` (after `stoneRating`):
```ts
// Diamond apex: maxed on all THREE independent axes at once (reuses the curve breakpoints).
// Rare + honest + cross-type — grade 3 AND >=21 stars AND >=50 real k-anon installs.
export function isDiamond(grade: number | undefined, stars: number, installs = 0): boolean {
  return grade === 3 && starCurve(stars) === 5 && adoptionCurve(installs) === 5;
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `pnpm --filter @agentgem/marketplace test -- rating`
Expected: PASS.

- [ ] **Step 5: Commit**
```bash
git add packages/marketplace/src/gems/rating.ts packages/marketplace/src/gems/rating.test.ts
git -c user.name="Raymond Feng" -c user.email="raymond@ninemind.ai" commit -m "feat(marketplace): isDiamond predicate — apex on all three rating axes

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 2: Diamond render treatment

**Files:**
- Modify: `packages/marketplace/src/StoneRating.tsx`, `packages/marketplace/src/styles.css`
- Test: `packages/marketplace/src/StoneRating.test.tsx` (extend)

**Interfaces:** Consumes `isDiamond` (Task 1).

- [ ] **Step 1: Write the failing test** — add to `StoneRating.test.tsx`:
```tsx
it("renders the Diamond apex (data-diamond + 5 filled) when maxed on all axes", () => {
  const { container } = render(<StoneRating cut="skill" grade={3} stars={21} installs={50} />);
  expect(container.querySelector('[data-diamond="true"]')).toBeTruthy();
  expect(container.querySelectorAll('[data-stone="filled"]').length).toBe(5);
});
it("a 5-of-5 gem that is NOT diamond (maxed by one axis only) shows no diamond seal", () => {
  const { container } = render(<StoneRating cut="skill" grade={3} stars={21} installs={0} />);
  expect(container.querySelector('[data-diamond="true"]')).toBeNull(); // stars alone → 5 of 5, not Diamond
  expect(container.querySelectorAll('[data-stone="filled"]').length).toBe(5);
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm --filter @agentgem/marketplace test -- StoneRating`
Expected: FAIL — no `data-diamond`.

- [ ] **Step 3: Implement**

`packages/marketplace/src/StoneRating.tsx` — import `isDiamond`; after `const n = stoneRating(...)` add `const diamond = isDiamond(grade, stars, installs ?? 0);`. Diamond palette + label + wrapper hook:
```tsx
const DIAMOND = { fg: "#7fd7ff", bg: "#e8f7ff" }; // crystal-blue apex (cross-type, not a cut color)
// ...
const label = diamond ? `Diamond · apex · ${m?.gemstone ?? "gem"}` : `${n} of 5 · ${m?.gemstone ?? "gem"}`;
const fillFg = diamond ? DIAMOND.fg : fg;
const fillBg = diamond ? DIAMOND.bg : bg;
return (
  <span className={"ex-stones" + (diamond ? " ex-stones--diamond" : "")} data-diamond={diamond ? "true" : undefined} title={label} aria-label={label}>
    {Array.from({ length: 5 }, (_, i) => {
      const filled = diamond || i < n;   // diamond → all 5 filled
      return (
        <span key={i} data-stone={filled ? "filled" : "empty"} className="ex-stone" style={{ color: filled ? fillFg : fillBg }}>
          {diamond ? "♦" : "◆"}
        </span>
      );
    })}
  </span>
);
```
(Keep the non-diamond branch identical to today: same `◆`, same `fg`/`bg`, no `data-diamond` attribute — `undefined` omits it.)

`packages/marketplace/src/styles.css` — add a minimal `.ex-stones--diamond` rule (a subtle crystal treatment; optional gentle shimmer via a light gradient/animation — keep it tasteful and cheap), mirroring `.ex-stone`'s altitude. No layout change.

- [ ] **Step 4: Run to verify + gates**

Run: `pnpm --filter @agentgem/marketplace test && pnpm --filter @agentgem/marketplace typecheck && pnpm --filter @agentgem/marketplace build`
Expected: whole marketplace suite green + typecheck + build clean.

- [ ] **Step 5: Commit**
```bash
git add packages/marketplace/src/StoneRating.tsx packages/marketplace/src/StoneRating.test.tsx packages/marketplace/src/styles.css
git -c user.name="Raymond Feng" -c user.email="raymond@ninemind.ai" commit -m "feat(marketplace): Diamond apex render — 5 crystal gemstones when maxed on all axes

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Final verification

- `pnpm --filter @agentgem/marketplace test|typecheck|build` all green; the non-diamond render is unchanged (existing StoneRating tests still pass).
- Whole-branch review (sonnet — small UI diff): predicate reuses curves (no new thresholds); non-diamond path byte-unchanged; `data-diamond`/`aria-label` present; distinguishes "5 of 5" from "Diamond".

## The result this delivers

The Cut × Stone visual is complete: color = cut, count = 1–5 rating (floor + stars + adoption), and 💎 Diamond = the rare cross-type apex when a gem is best-built AND broadly starred AND broadly adopted — honestly reachable now that real install telemetry (#D) feeds the count.
