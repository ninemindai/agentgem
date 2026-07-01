# Stone Rating Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Render a 1–5 "Stone" rating (N filled gemstones in the cut's color) on each marketplace gem, where `stones = min(5, max(scorecardFloor, starCurve(stars)))` — an authoring-quality floor baked into the `.gem` at build, raised by community stars.

**Architecture:** A pure `scorecardFloor` (1..3) is computed at build from workflow confidence, baked onto `Gem.grade`, forwarded by both publish paths to `discovery.grade` (mirroring `type`/`publishedBy`), surfaced on `RegistryGem`, and blended client-side with the marketplace's existing star counts.

**Tech Stack:** TypeScript ESM monorepo; `@agentgem/{model,build,distribute}` + server (`src/`) + `@agentgem/marketplace` (React/Vite/Vitest). Server tests run against compiled `dist/` (`tsc -b` first). Marketplace: `pnpm --filter @agentgem/marketplace test|typecheck|build`.

## Global Constraints

- Every source file carries the three-line MIT header used by its neighbors (copy an adjacent file's header verbatim).
- **`grade` is the floor only (1..3), never the blended rating; never bake stars into the gem.** Stars blend client-side.
- **`grade` is read from the gem/archive, NEVER from a request body** (unforgeable, same posture as `publishedBy`).
- **No fabricated floor:** where scorecard confidence data is absent, leave `grade` undefined → marketplace uses `floor=1` → pure star curve.
- **Omit `grade` when undefined** everywhere (gem, discovery) so existing no-grade gems stay byte-identical (immutable-digest safety).
- Additive threading only — mirror the existing `type`/`publishedBy` lines exactly; do not reformat or touch unrelated code.
- Commit identity: `git -c user.name="Raymond Feng" -c user.email="raymond@ninemind.ai" commit`; every message ends with `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`. Stage explicitly (Edit/Write don't `git add`); verify `git show HEAD --stat` includes every file incl. tests.
- Star curve thresholds (the single source; server-doc + marketplace mirror must match): `0→1, 1–2→2, 3–7→3, 8–20→4, 21+→5`. Floor rubric: `1; +1 if battleTested≥1; +1 if portable≥1` (clamp 1..3).

---

### Task 1: `scorecardFloor` pure function (model)

**Files:**
- Create: `packages/model/src/gemGrade.ts`
- Modify: `packages/model/src/index.ts` (export it)
- Test: `src/gem/__tests__/gemGrade.test.ts`

**CONVENTION (verified):** `packages/model` (and `build`/`distribute`) have NO test runner — only a `build` script. ALL tests live in the ROOT server suite under `src/**/__tests__/`, import from the `@agentgem/*` packages, and run via the root `pnpm test` (`tsc -b && vitest run` over `dist/**/__tests__/**/*.test.js`). Model code from #3 is tested this way in `src/gem/__tests__/gemTypes.test.ts` — mirror it.

**Interfaces:**
- Produces: `scorecardFloor(sc: { breadth: number; battleTested: number; portable: number }): number` (1..3); `GEM_GRADE_MIN = 1`, `GEM_GRADE_MAX = 3`.

- [ ] **Step 1: Write the failing test** — `src/gem/__tests__/gemGrade.test.ts` (import from `@agentgem/model`, the built package — NOT a relative path):

```ts
// <copy the 3-line MIT header from src/gem/__tests__/gemTypes.test.ts>
import { describe, it, expect } from "vitest";
import { scorecardFloor, GEM_GRADE_MIN, GEM_GRADE_MAX } from "@agentgem/model";

describe("scorecardFloor", () => {
  it("floors at 1 with no battle-tested/portable workflows", () => {
    expect(scorecardFloor({ breadth: 4, battleTested: 0, portable: 0 })).toBe(1);
  });
  it("rises to 2 with at least one battle-tested workflow", () => {
    expect(scorecardFloor({ breadth: 1, battleTested: 1, portable: 0 })).toBe(2);
  });
  it("rises to 3 when also portable, and clamps there", () => {
    expect(scorecardFloor({ breadth: 9, battleTested: 5, portable: 3 })).toBe(3);
  });
  it("exposes the 1..3 bounds", () => {
    expect([GEM_GRADE_MIN, GEM_GRADE_MAX]).toEqual([1, 3]);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run (from repo root): `pnpm exec tsc -b && pnpm exec vitest run dist/gem/__tests__/gemGrade.test.js`
Expected: FAIL — `scorecardFloor` not exported from `@agentgem/model`.

- [ ] **Step 3: Implement** — `packages/model/src/gemGrade.ts`:

```ts
// <copy the 3-line MIT header from an adjacent packages/model source file>

/** Bounds of the authoring-quality floor baked onto a gem (Gem.grade). */
export const GEM_GRADE_MIN = 1;
export const GEM_GRADE_MAX = 3;

/**
 * The authoring-quality FLOOR (1..3) for a gem, derived from its scorecard axes.
 * A gem with ≥1 high-confidence ("battle-tested") workflow floors at 2; one that is
 * also portable floors at 3. `breadth` is accepted for a future tweak but does not
 * raise the floor (breadth alone isn't quality). The final 1..5 stone rating blends
 * this floor with community stars client-side — this is only the floor.
 */
export function scorecardFloor(sc: { breadth: number; battleTested: number; portable: number }): number {
  let f = GEM_GRADE_MIN;
  if (sc.battleTested >= 1) f++;
  if (sc.portable >= 1) f++;
  return Math.min(GEM_GRADE_MAX, Math.max(GEM_GRADE_MIN, f));
}
```

In `packages/model/src/index.ts`, add (match the file's export style):
```ts
export * from "./gemGrade.js";
```

- [ ] **Step 4: Run to verify it passes**

Run (from repo root): `pnpm exec tsc -b && pnpm exec vitest run dist/gem/__tests__/gemGrade.test.js`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/model/src/gemGrade.ts packages/model/src/index.ts src/gem/__tests__/gemGrade.test.ts
git -c user.name="Raymond Feng" -c user.email="raymond@ninemind.ai" commit -m "feat(model): scorecardFloor — authoring-quality gem grade (1..3)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 2: `Gem.grade` field + `buildGem` opts threading

**Files:**
- Modify: `packages/model/src/types.ts` (Gem interface), `src/schemas.ts` (GemSchema), `packages/build/src/buildGem.ts` (opts + return)
- Test: extend `src/gem/__tests__/buildGem.test.ts` (the existing root-suite test for `@agentgem/build`'s `buildGem`)

**CONVENTION:** same as Task 1 — the test lives in the ROOT suite (`src/gem/__tests__/buildGem.test.ts` already exists and tests `buildGem`); import `buildGem` from `@agentgem/build`. Run via root `pnpm test`.

**Interfaces:**
- Consumes: nothing new.
- Produces: `Gem.grade?: number`; `buildGem(..., opts: { …; grade?: number })` sets `grade` on the returned gem only when defined.

- [ ] **Step 1: Write the failing test** — add cases to `src/gem/__tests__/buildGem.test.ts` (reuse that file's existing inventory/selection fixture builders — read it first for the exact helpers):

```ts
// (added to the existing describe, reusing its fixtures; buildGem imported from "@agentgem/build")

describe("buildGem grade", () => {
  it("bakes opts.grade onto the gem", () => {
    const gem = buildGem(/* minimal inventory */, /* minimal selection */, { name: "g", grade: 3 });
    expect(gem.grade).toBe(3);
  });
  it("omits grade when not supplied (key absent, not undefined-valued)", () => {
    const gem = buildGem(/* minimal inventory */, /* minimal selection */, { name: "g" });
    expect("grade" in gem).toBe(false);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run (from repo root): `pnpm exec tsc -b && pnpm exec vitest run dist/gem/__tests__/buildGem.test.js`
Expected: FAIL — `gem.grade` undefined / `grade` type not on Gem.

- [ ] **Step 3: Implement**

`packages/model/src/types.ts` — add to the `Gem` interface (after `requiredSecrets`):
```ts
  grade?: number;                        // authoring-quality floor (1..3), baked at build; absent when unmeasured
```

`src/schemas.ts` — in `GemSchema` (after `requiredSecrets`):
```ts
  grade: z.number().int().min(1).max(3).optional(),
```

`packages/build/src/buildGem.ts` — extend `opts` (line 30) with `grade?: number;`, and in the return object (currently ends with `requiredSecrets,` at ~:112) spread the grade only when defined:
```ts
  return {
    name: opts.name ?? "gem",
    createdFrom: opts.createdFrom ?? "unknown",
    artifacts,
    checks,
    requiredSecrets,
    ...(opts.grade != null ? { grade: opts.grade } : {}),
  };
```

- [ ] **Step 4: Run to verify it passes**

Run (from repo root): `pnpm exec tsc -b && pnpm exec vitest run dist/gem/__tests__/buildGem.test.js`
Expected: PASS (existing buildGem tests + the 2 new grade cases, no regression).

- [ ] **Step 5: Commit**

```bash
git add packages/model/src/types.ts src/schemas.ts packages/build/src/buildGem.ts src/gem/__tests__/buildGem.test.ts
git -c user.name="Raymond Feng" -c user.email="raymond@ninemind.ai" commit -m "feat(build): bake Gem.grade (authoring floor) via buildGem opts

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 3: Compute the floor at `/scorecard/build`

**Files:**
- Modify: `src/gem.controller.ts` (`scorecardBuild`, ~:385–406)
- Test: extend the existing scorecardBuild controller test (find it: `grep -rl scorecardBuild src/**/__tests__ 2>/dev/null` / search `src` for `scorecardBuild` in test files)

**Interfaces:**
- Consumes: `scorecardFloor` (Task 1), `isPortable` (already imported in gem.controller), `buildGem` opts.grade (Task 2).

- [ ] **Step 1: Write the failing test**

In the scorecardBuild test, add a case: build over a project whose selected candidates include ≥1 with `priorConfidence: "high"` and portable tools → assert the returned gem's `grade === 3`; and a case with only low-confidence candidates → assert `grade` is absent (or 1 is NOT asserted — absent). Mirror the fixture the existing scorecardBuild test uses for `loadProject`. Example shape:
```ts
  it("bakes grade=3 for battle-tested portable selections", async () => {
    // fixture: loadProject returns candidates incl. one { priorConfidence:"high", tools:[non-local] }
    const gem = await controller.scorecardBuild({ body: { /* selections over those keys */ } });
    expect(gem.grade).toBe(3);
  });
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm exec tsc -b && pnpm exec vitest run <compiled scorecardBuild test path>`
Expected: FAIL — grade undefined (not yet computed).

- [ ] **Step 3: Implement**

In `scorecardBuild` (`src/gem.controller.ts`), the loop already collects `chosen` candidates per selection into `drafts`/`projSel`. Accumulate the scorecard axes over exactly the chosen candidates that feed the gem, then pass the floor into `buildGem`. Add (before the loop) accumulators and (inside the loop, where `chosen` is known) tally; after the loop compute the floor:

```ts
    const keys = new Set<string>();
    let battleTested = 0, portable = 0;
    // ... inside the existing `for (const sel of ...)` loop, after `const chosen = ...`:
    for (const c of chosen) {
      keys.add(c.key);
      if (c.priorConfidence === "high") battleTested++;
      if (isPortable(c)) portable++;
    }
    // ... after the loop, before buildGem:
    const grade = scorecardFloor({ breadth: keys.size, battleTested, portable });
    const gem = buildGem(inventory, { projects: projSel }, { name: input.body.name ?? "goldmine-gem", createdFrom: resolveDirs(dir).claudeDir, grade });
    return gem;
```

Add `scorecardFloor` to the existing `./gem/scorecard.js`/model import (import from `@agentgem/model`). Confirm `isPortable` and `priorConfidence` are already available (they are — `isPortable` is imported at :187 and used in `scorecardWorkflow`).

- [ ] **Step 4: Run to verify it passes**

Run: `pnpm exec tsc -b && pnpm exec vitest run <compiled scorecardBuild test path>`
Expected: PASS. Also run the full existing scorecardBuild/scorecard suite for no regression.

- [ ] **Step 5: Commit**

```bash
git add src/gem.controller.ts <the test file>
git -c user.name="Raymond Feng" -c user.email="raymond@ninemind.ai" commit -m "feat(gem): compute scorecard floor at /scorecard/build → gem.grade

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 4: Thread `grade?` through discovery + publishGem (distribute)

**Files:**
- Modify: `packages/distribute/src/registry.ts` (RegistryItemDiscovery, buildDiscovery, publishGem)
- Test: extend `src/gem/__tests__/registryPublish.test.ts` (the root-suite test for `@agentgem/distribute`'s `publishGem` — it already covers `type`/`publishedBy` and has the capturing publisher helper)

**CONVENTION:** same as Tasks 1/2 — test lives in the root suite; import `publishGem`/`buildDiscovery` from `@agentgem/distribute`; run via root `pnpm test`. Run cmd: `pnpm exec tsc -b && pnpm exec vitest run dist/gem/__tests__/registryPublish.test.js`.

**Interfaces:**
- Produces: `RegistryItemDiscovery.grade?: number`; `buildDiscovery(..., { …, grade? })`; `publishGem(args: { …; grade?: number })` → stamps `discovery.grade`.

- [ ] **Step 1: Write the failing test** — mirror the existing `publishedBy`-threads-onto-discovery test:
```ts
  it("threads grade onto discovery when supplied", async () => {
    const { publisher, captured } = capturing();               // reuse the existing capturing publisher helper
    await publishGem({ gem, scope: "alice", version: "1.0.0", index: emptyIndex(), publisher, grade: 3 });
    const idx = JSON.parse(captured()["registry.json"]);
    expect(idx.items["@alice/<name>"].discovery.grade).toBe(3);
  });
  it("omits discovery.grade when not supplied", async () => {
    const { publisher, captured } = capturing();
    await publishGem({ gem, scope: "alice", version: "1.0.0", index: emptyIndex(), publisher });
    const idx = JSON.parse(captured()["registry.json"]);
    expect("grade" in idx.items["@alice/<name>"].discovery).toBe(false);
  });
```

- [ ] **Step 2: Run to verify it fails**

Run (from repo root): `pnpm exec tsc -b && pnpm exec vitest run dist/gem/__tests__/registryPublish.test.js`
Expected: FAIL — `discovery.grade` undefined.

- [ ] **Step 3: Implement** — mirror the `type`/`publishedBy` lines exactly:

`RegistryItemDiscovery` (after `publishedBy?`):
```ts
  grade?: number;       // authoring-quality floor (1..3) forwarded from the gem; the marketplace blends it with stars
```

`buildDiscovery` — extend opts `{ …; type?: string; publishedBy?: string; grade?: number }` and after `if (opts.publishedBy) d.publishedBy = opts.publishedBy;`:
```ts
  if (opts.grade != null) d.grade = opts.grade;
```

`publishGem` args — add `grade?: number;`; and in the `buildDiscovery(...)` call add `grade: args.grade`.

- [ ] **Step 4: Run to verify it passes**

Run (from repo root): `pnpm exec tsc -b && pnpm exec vitest run dist/gem/__tests__/registryPublish.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/distribute/src/registry.ts src/gem/__tests__/registryPublish.test.ts
git -c user.name="Raymond Feng" -c user.email="raymond@ninemind.ai" commit -m "feat(distribute): thread gem grade onto registry discovery

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 5: Both publish paths forward `gem.grade`

**Files:**
- Modify: `src/gem.controller.ts` (the `registryPublish` handler — the console publish path), `src/registry/uploadPublish.ts` (the marketplace upload path)
- Test: extend `src/registry/__tests__/uploadPublish.test.ts`

**Interfaces:**
- Consumes: `publishGem` args.grade (Task 4); `gem.grade` (Task 2).

- [ ] **Step 1: Write the failing test** — in `uploadPublish.test.ts`, extend the existing 200 test (or add one): a `.gem` whose gem carries `grade: 2` (build the fixture gem with grade, or set it on the imported gem object the fake source captures) publishes with `discovery.grade === 2`; and assert a request body field `grade: 5` is IGNORED (the published discovery.grade reflects the archive's 2, not the body):
```ts
    // gem fixture built with grade:2; body includes a bogus grade:5
    ...
    expect(idx.items["@alice/test-gem"].discovery.grade).toBe(2);   // from the archive, not the body
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm exec tsc -b && pnpm exec vitest run dist/registry/__tests__/uploadPublish.test.js`
Expected: FAIL — grade not forwarded.

- [ ] **Step 3: Implement**

`src/registry/uploadPublish.ts` — in the `publishGem({ … })` call (currently passes `gem, scope, version, name, tags, description, index, publisher, type, publishedBy`), add:
```ts
        grade: gem.grade,                                          // forwarded from the archive (never the request body)
```
(Do NOT add `grade` to the request body type; it is intentionally never read from the body.)

`src/gem.controller.ts` `registryPublish` — locate its `publishGem({ … })` call and add `grade: gem.grade,` (the gem it publishes is the built/received gem carrying the baked grade). If the handler resolves the gem via a build/selection, that gem already carries `grade` from Task 3 for scorecard-built gems.

- [ ] **Step 4: Run to verify it passes**

Run: `pnpm exec tsc -b && pnpm exec vitest run dist/registry/__tests__/uploadPublish.test.js`
Expected: PASS (existing 6 + the new grade assertions).

- [ ] **Step 5: Commit**

```bash
git add src/registry/uploadPublish.ts src/gem.controller.ts src/registry/__tests__/uploadPublish.test.ts
git -c user.name="Raymond Feng" -c user.email="raymond@ninemind.ai" commit -m "feat(registry): forward gem.grade from both publish paths (from archive, unforgeable)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 6: Surface `grade` on the public catalog (3 mirrors)

**Files:**
- Modify: `src/gem/publicCatalog.ts` (RegistryGem + mapping), `src/schemas.ts` (RegistryGemSchema), `packages/marketplace/src/types.ts` (RegistryGem)
- Test: extend the publicCatalog test (find: `grep -rl publicCatalog src/**/__tests__ 2>/dev/null` or search `src` tests for `type: item.discovery`)

**Interfaces:**
- Produces: `RegistryGem.grade?: number` (server + marketplace mirrors), populated from `discovery.grade`.

- [ ] **Step 1: Write the failing test** — in the publicCatalog test, a registry index whose item has `discovery.grade: 3` → the mapped `RegistryGem.grade === 3`; absent discovery.grade → `grade` undefined. Mirror the existing `type`/`publishedBy` mapping assertions.

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm exec tsc -b && pnpm exec vitest run <compiled publicCatalog test path>`
Expected: FAIL — `grade` not mapped.

- [ ] **Step 3: Implement**

`src/gem/publicCatalog.ts` — add `grade?: number;` to `RegistryGem` (after `publishedBy?`), and in the mapping object (where it sets `type: item.discovery?.type, publishedBy: item.discovery?.publishedBy,`) add:
```ts
    grade: item.discovery?.grade,
```

`src/schemas.ts` `RegistryGemSchema` — add `grade: z.number().int().min(1).max(3).optional(),`.

`packages/marketplace/src/types.ts` `RegistryGem` — add `grade?: number;` (match the file's field style; it already carries `type?`/etc. from #5-browse — put `grade` beside them).

- [ ] **Step 4: Run to verify it passes**

Run: `pnpm exec tsc -b && pnpm exec vitest run <compiled publicCatalog test path>` and `pnpm --filter @agentgem/marketplace typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/gem/publicCatalog.ts src/schemas.ts packages/marketplace/src/types.ts <the test file>
git -c user.name="Raymond Feng" -c user.email="raymond@ninemind.ai" commit -m "feat(catalog): surface gem grade on RegistryGem (server + marketplace mirrors)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 7: Marketplace — `stoneRating` + `StoneRating` render

**Files:**
- Create: `packages/marketplace/src/gems/rating.ts`, `packages/marketplace/src/StoneRating.tsx`
- Modify: `packages/marketplace/src/pages/Gems.tsx`, `packages/marketplace/src/pages/Gem.tsx` (render the rating; ensure star counts are available/batched)
- Test: `packages/marketplace/src/gems/rating.test.ts`, `packages/marketplace/src/StoneRating.test.tsx`

**Interfaces:**
- Consumes: `RegistryGem.grade` (Task 6), `cutMeta` (`./gems/cuts` — returns `{ label, gemstone, bg, fg }`; use `fg` for filled gemstone color, `bg` for the outline), the existing `makeStars` batched `get(kind, ids[])`.
- Produces: `starCurve(stars): number` (1..5), `stoneRating(floor: number | undefined, stars: number): number` (1..5); `<StoneRating cut grade stars />`.

- [ ] **Step 1: Write the failing tests**

`packages/marketplace/src/gems/rating.test.ts`:
```ts
// <MIT header if the marketplace uses one; match neighbors>
import { describe, it, expect } from "vitest";
import { starCurve, stoneRating } from "./rating";

describe("starCurve", () => {
  it("maps star counts to 1..5 buckets", () => {
    expect([0,1,2,3,7,8,20,21,999].map(starCurve)).toEqual([1,2,2,3,3,4,4,5,5]);
  });
});
describe("stoneRating", () => {
  it("takes the max of floor and star curve, clamped to 5", () => {
    expect(stoneRating(3, 0)).toBe(3);      // floor wins with no stars
    expect(stoneRating(1, 25)).toBe(5);     // stars win
    expect(stoneRating(undefined, 0)).toBe(1); // no floor → 1
    expect(stoneRating(3, 999)).toBe(5);    // clamp
  });
});
```

`packages/marketplace/src/StoneRating.test.tsx`:
```tsx
import { describe, it, expect, afterEach } from "vitest";
import { render, cleanup } from "@testing-library/react";
import { StoneRating } from "./StoneRating";

afterEach(() => cleanup());
describe("StoneRating", () => {
  it("renders 5 gemstones with N filled", () => {
    const { container } = render(<StoneRating cut="skill" grade={3} stars={0} />);
    expect(container.querySelectorAll("[data-stone]").length).toBe(5);
    expect(container.querySelectorAll('[data-stone="filled"]').length).toBe(3);
  });
  it("unknown cut still renders (neutral), grade undefined + 0 stars → 1 filled", () => {
    const { container } = render(<StoneRating cut={undefined} grade={undefined} stars={0} />);
    expect(container.querySelectorAll('[data-stone="filled"]').length).toBe(1);
  });
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `pnpm --filter @agentgem/marketplace test -- rating StoneRating`
Expected: FAIL — modules don't exist.

- [ ] **Step 3: Implement**

`packages/marketplace/src/gems/rating.ts`:
```ts
// The star→stone curve, mirrored from the server-doc thresholds (0→1,1–2→2,3–7→3,
// 8–20→4,21+→5). The final stone count blends the authoring floor (grade, from the
// gem) with community stars: stones = min(5, max(floor, starCurve(stars))).
export function starCurve(stars: number): number {
  if (stars >= 21) return 5;
  if (stars >= 8) return 4;
  if (stars >= 3) return 3;
  if (stars >= 1) return 2;
  return 1;
}
export function stoneRating(floor: number | undefined, stars: number): number {
  return Math.min(5, Math.max(floor ?? 1, starCurve(stars)));
}
```

`packages/marketplace/src/StoneRating.tsx`:
```tsx
import { cutMeta } from "./gems/cuts";
import { stoneRating } from "./gems/rating";

const NEUTRAL = { fg: "#8a8f98", bg: "#e6e8eb" };

/** N filled gemstones (of 5) in the cut's color — the gem's Stone rating. */
export function StoneRating({ cut, grade, stars }: { cut?: string; grade?: number; stars: number }) {
  const m = cutMeta(cut);
  const fg = m?.fg ?? NEUTRAL.fg;
  const bg = m?.bg ?? NEUTRAL.bg;
  const n = stoneRating(grade, stars);
  const label = `${n} of 5 · ${m?.gemstone ?? "gem"}`;
  return (
    <span className="ex-stones" title={label} aria-label={label}>
      {Array.from({ length: 5 }, (_, i) => {
        const filled = i < n;
        return (
          <span
            key={i}
            data-stone={filled ? "filled" : "empty"}
            className="ex-stone"
            style={{ color: filled ? fg : bg }}
          >
            ◆
          </span>
        );
      })}
    </span>
  );
}
```
Add a minimal `.ex-stones`/`.ex-stone` rule to `packages/marketplace/src/styles.css` if needed (inline-flex, small gap, font-size ~0.8em) — mirror the `.ex-cut` rule's altitude.

`Gems.tsx` / `Gem.tsx` — read the current file first. These pages already show `CutBadge` and use stars. Render `<StoneRating cut={g.cut} grade={g.grade} stars={counts[g.key] ?? 0} />` on each gem card / the detail header, beside the `CutBadge`. **Star counts must be batched:** if the list page already fetches `stars.get("gem", ids)` for the ★ counts, reuse that `counts` map — do NOT add a per-gem fetch. If it doesn't yet fetch gem stars for the list, add ONE `stars.get("gem", gems.map(g => g.key))` call in the existing load effect and thread the `counts` map down. (Mirror how the ingredient pages batch star counts.)

- [ ] **Step 4: Run to verify they pass + gates**

Run: `pnpm --filter @agentgem/marketplace test && pnpm --filter @agentgem/marketplace typecheck && pnpm --filter @agentgem/marketplace build`
Expected: whole marketplace suite PASS + typecheck + build clean. If a `Gems.test.tsx` asserts a single batched star call, confirm it still holds (one call for the list).

- [ ] **Step 5: Commit**

```bash
git add packages/marketplace/src/gems/rating.ts packages/marketplace/src/gems/rating.test.ts packages/marketplace/src/StoneRating.tsx packages/marketplace/src/StoneRating.test.tsx packages/marketplace/src/pages/Gems.tsx packages/marketplace/src/pages/Gem.tsx packages/marketplace/src/styles.css
git -c user.name="Raymond Feng" -c user.email="raymond@ninemind.ai" commit -m "feat(marketplace): Stone rating — N colored gemstones blending grade + stars

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Final verification (after all tasks)

- Server: `pnpm exec tsc -b` clean; `pnpm test` green (build console first — `consoleMount` needs it; known real-FS scan flakes aside); the new/extended tests (gemGrade, buildGem.grade, scorecardBuild, distribute registry, uploadPublish, publicCatalog) pass.
- Marketplace: `pnpm --filter @agentgem/marketplace test|typecheck|build` clean.
- Whole-branch review (opus — a publish-path + rating change): verify grade is never read from a request body (unforgeable), the omit-when-undefined keeps no-grade gems byte-identical, the star fetch is batched (no per-gem fanout), and the marketplace curve mirrors the server-doc thresholds.

## The result this delivers

Each marketplace gem shows a 1–5 Stone rating — N filled gemstones in its cut's color — floored by baked authoring quality and raised by community stars, uniform across both publish paths. Diamond + real adoption telemetry remain deferred; the `max(floor, …)` shape absorbs that telemetry when it lands.
