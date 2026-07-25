# gemit Report Polish Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rebuild the `agentgem gemit` HTML report as a screenshot-shaped ceremonial card above an editorial dossier, collapsing the duplicated Training Grounds section and adding a cohort percentile that stays absent until real data exists.

**Architecture:** `renderRpgTheme` keeps its signature and stays the single entry point. The stylesheet and page runtime move to their own modules because both roughly double in size. A new pure `cohort.ts` gates the percentile claim. No scoring changes, no network, no new dependencies.

**Tech Stack:** TypeScript (ESM, NodeNext), vitest running **compiled `dist/`**, self-contained HTML built as TS template strings, `@agentgem/model` house-style tokens.

**Spec:** `docs/superpowers/specs/2026-07-25-gemit-report-polish-design.md`
**Visual reference:** `docs/superpowers/specs/2026-07-25-gemit-report-polish-mock.html` — open it in a browser before Task 3. It is the approved design, verified in both themes and at 42% scale.

## Global Constraints

- **Tests run compiled output, not source.** Every test cycle is `npx tsc -b && npx vitest run dist/__tests__/<file>.test.js`. Editing a `.ts` and running vitest alone tests the *previous* build.
- **Zero external URLs in rendered HTML.** Enforced by `expect(html).not.toMatch(/https?:\/\//)`. No fonts, no CDNs, no images, no fetch. Inline SVG only.
- **No runtime file reads for markup or CSS.** The npm tarball ships `dist/` only; templates must stay TS string builders.
- **`projectComposite`, `tierFor`, `autoSolvePath` stay pure, top-level, and serializable.** They are injected into the page via `f.toString()` so the interactive projection provably uses the same arithmetic as the score. Do not wrap them in closures over module state.
- **Never invent cohort numbers.** `COHORT` ships as `null`. A populated table may only come from `scripts/gemit-cohort.mjs` run against real published cards.
- **The share variant may display counts, never names.** `shareVariantOf` clears `topSkills`/`topSubagents`.
- **Baseline:** 17 tests pass in `dist/__tests__/gemitTheme.test.js` + `dist/__tests__/gemitShare.test.js` before you start.
- Match existing file style: `// Copyright (c) 2026 NineMind, Inc.` + `// SPDX-License-Identifier: MIT` + path comment header on every new file.

---

## File Structure

| File | Responsibility |
|---|---|
| `src/gemit/cohort.ts` | **new** — `Cohort` type, `COHORT` (null), `MIN_COHORT`, `percentileFor`. Pure. |
| `src/gemit/theme/styles.ts` | **new** — the stylesheet string, built on `HOUSE_TOKENS` + `themeAdapter("document")`. |
| `src/gemit/theme/runtime.ts` | **new** — `RUNTIME_JS`: ring sweep, what-if toggle, quests, confetti, copy. |
| `src/gemit/themeRpg.ts` | **modify** — `renderRpgTheme`, `perksFor`, `questsFor`, markup helpers. Re-exports keep test imports working. |
| `src/gemit/share.ts` | **modify** — `gemitShareUrls` appends percentile when present. |
| `scripts/gemit-cohort.mjs` | **new** — regenerates the cohort table from real published cards. |
| `src/__tests__/gemitCohort.test.ts` | **new** — `percentileFor` gating. |
| `src/__tests__/gemitTheme.test.ts` | **modify** — one assertion + new card/collapse coverage. |
| `src/__tests__/gemitShare.test.ts` | **modify** — percentile-absent share text. |

---

### Task 1: Cohort module

Pure gating logic, no UI. Ships the mechanism with the claim switched off.

**Files:**
- Create: `src/gemit/cohort.ts`
- Test: `src/__tests__/gemitCohort.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `interface Cohort { asOf: string; n: number; p: number[] }`, `const MIN_COHORT: number`, `const COHORT: Cohort | null`, `function percentileFor(composite: number, c?: Cohort | null): number | null`, `function cohortLabel(c: Cohort): string`.

- [ ] **Step 1: Write the failing test**

Create `src/__tests__/gemitCohort.test.ts`:

```ts
// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
// The cohort claim must be absent unless it is backed by a real, large-enough sample.
import { describe, expect, it } from "vitest";
import { COHORT, MIN_COHORT, type Cohort, cohortLabel, percentileFor } from "../gemit/cohort.js";

const table = (): Cohort => ({
  asOf: "2026-07-25",
  n: 1284,
  // percentile at each composite 0..100; monotonic, coarse on purpose
  p: Array.from({ length: 101 }, (_, i) => Math.min(99, Math.round(i * 0.99))),
});

describe("percentileFor", () => {
  it("returns null when no cohort has been generated", () => {
    expect(percentileFor(79, null)).toBeNull();
    expect(percentileFor(79, undefined)).toBeNull();
  });

  it("returns null when the sample is too small to claim anything", () => {
    expect(percentileFor(79, { ...table(), n: MIN_COHORT - 1 })).toBeNull();
  });

  it("reads the percentile for a composite from a real table", () => {
    expect(percentileFor(79, table())).toBe(78);
    expect(percentileFor(0, table())).toBe(0);
    expect(percentileFor(100, table())).toBe(99);
  });

  it("clamps out-of-range composites instead of returning undefined", () => {
    expect(percentileFor(-5, table())).toBe(0);
    expect(percentileFor(150, table())).toBe(99);
  });

  it("returns null for a malformed table rather than a wrong number", () => {
    expect(percentileFor(79, { asOf: "2026-07-25", n: 1284, p: [] })).toBeNull();
  });

  it("ships with the claim switched off", () => {
    expect(COHORT).toBeNull();
  });
});

describe("cohortLabel", () => {
  it("discloses sample size and date so staleness is a stated fact", () => {
    expect(cohortLabel(table())).toBe("of 1,284 shared cards, Jul 2026");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
npx tsc -b 2>&1 | tail -5
```
Expected: FAIL — `Cannot find module '../gemit/cohort.js'`.

- [ ] **Step 3: Write minimal implementation**

Create `src/gemit/cohort.ts`:

```ts
// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
// src/gemit/cohort.ts
//
// Where an operator stands against everyone else who shared a card. The report is
// provably offline (gemitTheme.test.ts forbids any URL in the output), so the
// distribution ships BAKED into the package rather than fetched — regenerated by
// scripts/gemit-cohort.mjs from real published cards.
//
// COHORT is null until that script has actually been run. A table of plausible-looking
// numbers would be fabricated social proof in a document whose footer advertises
// deterministic scoring, so absence is the correct default, not a placeholder.

export interface Cohort {
  /** ISO date the table was generated. Rendered, so staleness is disclosed. */
  asOf: string;
  /** Sample size the percentiles were computed from. */
  n: number;
  /** index = composite 0..100, value = percentile 0..99. */
  p: number[];
}

/** Below this many cards a percentile is noise dressed as a fact. */
export const MIN_COHORT = 100;

export const COHORT: Cohort | null = null;

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

export function percentileFor(composite: number, c?: Cohort | null): number | null {
  if (!c || c.n < MIN_COHORT || c.p.length !== 101) return null;
  const i = Math.max(0, Math.min(100, Math.round(composite)));
  const v = c.p[i];
  return typeof v === "number" ? v : null;
}

export function cohortLabel(c: Cohort): string {
  const [y, m] = c.asOf.split("-");
  const month = MONTHS[Number(m) - 1] ?? m;
  return `of ${c.n.toLocaleString("en-US")} shared cards, ${month} ${y}`;
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
npx tsc -b && npx vitest run dist/__tests__/gemitCohort.test.js
```
Expected: PASS — 7 tests.

- [ ] **Step 5: Commit**

```bash
git add src/gemit/cohort.ts src/__tests__/gemitCohort.test.ts
git commit -m "feat(gemit): cohort percentile gate, claim off until real data

COHORT ships null; percentileFor returns null for absent, undersized, or
malformed tables so the card renders no band rather than a false one."
```

---

### Task 2: Extract styles and runtime (pure refactor, zero behaviour change)

Establishes the file structure before any redesign, so the redesign diff is readable.

**Files:**
- Create: `src/gemit/theme/styles.ts`, `src/gemit/theme/runtime.ts`
- Modify: `src/gemit/themeRpg.ts`

**Interfaces:**
- Consumes: nothing new.
- Produces: `export const STYLES: string` from `theme/styles.ts`; `export const RUNTIME_JS: string` from `theme/runtime.ts`.

- [ ] **Step 1: Confirm the baseline is green**

```bash
npx tsc -b && npx vitest run dist/__tests__/gemitTheme.test.js dist/__tests__/gemitShare.test.js
```
Expected: PASS — 17 tests. If not, stop and report; do not build on red.

- [ ] **Step 2: Move the stylesheet verbatim**

Create `src/gemit/theme/styles.ts` with the standard header comment, then **cut** the entire contents of the `<style>` block in `themeRpg.ts` (currently `:root { --bg: …` through the closing `}` of the `prefers-reduced-motion` block) and paste it as:

```ts
export const STYLES = `<paste the existing CSS here, unchanged>`;
```

Escape any backtick or `${` in the CSS (there are none today — verify with `grep -c '`' src/gemit/theme/styles.ts`).

- [ ] **Step 3: Move the runtime verbatim**

Create `src/gemit/theme/runtime.ts` and move the existing `const RUNTIME_JS = \`…\`` declaration into it unchanged, adding `export`.

- [ ] **Step 4: Wire the imports**

In `themeRpg.ts`, delete both moved blocks and add near the existing imports:

```ts
import { STYLES } from "./theme/styles.js";
import { RUNTIME_JS } from "./theme/runtime.js";
```

Replace the inline `<style>…</style>` in the returned template with `<style>${STYLES}</style>`.

- [ ] **Step 5: Verify nothing changed**

```bash
npx tsc -b && npx vitest run dist/__tests__/gemitTheme.test.js dist/__tests__/gemitShare.test.js
```
Expected: PASS — the same 17 tests. A pure move must not change one assertion.

- [ ] **Step 6: Commit**

```bash
git add src/gemit/theme/ src/gemit/themeRpg.ts
git commit -m "refactor(gemit): extract theme styles and runtime to modules

Pure move ahead of the redesign — both files roughly double in the next
commits. No behaviour change; the same 17 tests pass."
```

---

### Task 3: The card

Replaces the `.hero` block with the ceremonial card. Port markup and CSS from the committed mockup.

**Files:**
- Modify: `src/gemit/themeRpg.ts`, `src/gemit/theme/styles.ts`
- Test: `src/__tests__/gemitTheme.test.ts`

**Interfaces:**
- Consumes: `percentileFor`, `cohortLabel`, `COHORT` from Task 1.
- Produces: `function renderCard(data: GemitData): string` (module-private is fine; not imported by other tasks).

- [ ] **Step 1: Write the failing test**

Append to `src/__tests__/gemitTheme.test.ts` (add `import { COHORT } from "../gemit/cohort.js";` at the top):

```ts
describe("the card", () => {
  it("renders tier, ring, hook and pips as one screenshot-shaped block", () => {
    const html = renderRpgTheme(data());
    expect(html).toContain('class="card"');
    expect(html).toContain("Lapidary");
    expect(html).toContain('data-n="79"');                  // ring count-up target
    expect(html).toContain("1 pt from Master Lapidary");     // the hook
    expect((html.match(/class="pip/g) ?? []).length).toBe(3);
    expect(html).toContain("119-session streak");
    expect(html).toContain("4/5 techniques");
  });

  it("omits the cohort band entirely while COHORT is null", () => {
    expect(COHORT).toBeNull();                               // guards the premise
    const html = renderRpgTheme(data());
    expect(html).not.toContain("shared cards");
    expect(html).not.toContain("class=\"cohort\"");
    expect(html).not.toMatch(/top \d+%/i);
  });

  it("declares a solid tier colour before the gradient so it can never render invisible", () => {
    const html = renderRpgTheme(data());
    const tier = html.slice(html.indexOf(".tier{"), html.indexOf(".tier{") + 260);
    expect(tier.indexOf("color:#")).toBeLessThan(tier.indexOf("background-image:"));
    expect(tier).not.toMatch(/background:\s*linear-gradient/); // never the shorthand
  });

  it("shows no card at all on the doorway", () => {
    const html = renderRpgTheme(data({ insufficient: true, qualifyingSessions: 2, composite: 0, tierLevel: 1 }));
    expect(html).not.toContain('class="card"');
    expect(html).toContain("No score yet");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
npx tsc -b && npx vitest run dist/__tests__/gemitTheme.test.js
```
Expected: FAIL — `expected … to contain 'class="card"'`.

- [ ] **Step 3: Add the card CSS**

In `src/gemit/theme/styles.ts`, append the card rules. Copy them from the mockup — the selectors are `.card`, `.card::before`, `:root[data-theme="dark"] .card`, `.eyebrow`, `.crown`, `.ring`, `.ring svg`, `.ring .trk`, `.ring .arc`, `@keyframes sweep`, `.ring .num`, `.crown-txt`, `.tier`, `@keyframes shine`, `.flavor`, `.hook`, `.cohort`, `.pips`, `.pip*`, `@keyframes grow`, `.strip`, `.gems`, `.seam`.

The two rules that must be transcribed exactly (they encode verified fixes):

```css
.card{ --plate:#16181d; background:var(--plate); color:#ece7dc; border-radius:var(--radius);
  padding:var(--sp-4) var(--sp-4) var(--sp-3); position:relative; overflow:hidden;
  border:1px solid rgba(236,231,220,.09);
  box-shadow:inset 0 1px 0 rgba(255,244,216,.10),0 1px 2px rgba(0,0,0,.28),0 12px 32px -12px rgba(0,0,0,.45); }
:root[data-theme="dark"] .card{ --plate:#20242c; border-color:rgba(236,231,220,.16);
  box-shadow:inset 0 1px 0 rgba(255,244,216,.14),0 0 0 1px rgba(0,0,0,.5),0 16px 40px -16px rgba(0,0,0,.8); }
```

and the tier rule, whose declaration order is load-bearing:

```css
.tier{ font:600 clamp(38px,8vw,60px)/.95 var(--serif); letter-spacing:.02em;
  text-transform:uppercase; color:#e8c87d; margin:0;
  background-image:linear-gradient(96deg,#e8c87d 30%,#fff4d8 46%,#e8c87d 62%);
  -webkit-background-clip:text; background-clip:text; -webkit-text-fill-color:transparent;
  background-size:220% 100%; animation:shine 2.4s cubic-bezier(.4,0,.2,1) .5s 1 both; }
```

Add the dark binding to the `@media (prefers-color-scheme: dark)` block too, mirroring the existing pattern in that file so system-dark gets the lifted plate without an explicit `data-theme`.

- [ ] **Step 4: Write the card renderer**

In `themeRpg.ts`, add imports and a private helper above `renderRpgTheme`:

```ts
import { COHORT, cohortLabel, percentileFor } from "./cohort.js";

const RING_C = 339.3; // 2πr, r=54

function renderCard(d: GemitData): string {
  const tierName = TIER_NAMES[d.tierLevel - 1];
  const nextTier = d.tierLevel < 4 ? TIER_NAMES[d.tierLevel as 1 | 2 | 3] : null;
  const ptsToNext = nextTier ? [50, 65, 80][d.tierLevel - 1] - d.composite : 0;
  const hook = nextTier
    ? `${ptsToNext} pt${ptsToNext === 1 ? "" : "s"} from ${nextTier}`
    : "Top tier";
  const pct = percentileFor(d.composite, COHORT);
  const cohort = pct !== null && COHORT
    ? `<p class="cohort">Top <b>${100 - pct}%</b> &middot; ${escapeHtml(cohortLabel(COHORT))}</p>`
    : "";
  const { unlocked } = perksFor(d);
  const offset = (RING_C * (1 - d.composite / 100)).toFixed(1);
  const pip = (label: string, v: number, i: number): string => `
        <div class="pip${v < 50 ? " low" : ""}"><span>${label}</span><b class="mono">${v}</b>
          <i style="--w:${v}%;--d:${(0.25 + i * 0.12).toFixed(2)}s"></i></div>`;

  return `
    <section class="card">
      <p class="eyebrow">AgentGem &middot; Steering Assessment &middot; ${d.windowFrom} &rarr; ${d.windowTo}</p>
      <div class="crown">
        <div class="ring">
          <svg viewBox="0 0 132 132" aria-hidden="true"><circle class="trk" cx="66" cy="66" r="54"/><circle class="arc" cx="66" cy="66" r="54" style="stroke-dashoffset:${offset}"/></svg>
          <div class="num"><b class="mono count" data-n="${d.composite}">${d.composite}</b><span class="mono">/ 100</span></div>
        </div>
        <div class="crown-txt">
          <h1 class="tier">${tierName}</h1>
          <p class="flavor">${TIER_FLAVOR[d.tierLevel - 1]}</p>
          ${cohort}
          <span class="hook">${hook}</span>
        </div>
      </div>
      <div class="pips">${pip("Context", d.ctx, 0)}${pip("Process", d.proc, 1)}${pip("Setup", d.setup, 2)}
      </div>
      <div class="strip">
        <span class="gems">${"◈".repeat(unlocked.length)}${"◇".repeat(5 - unlocked.length)} <span>${unlocked.length}/5 techniques</span></span>
        <span>&#9889; ${d.boundedStreak}-session streak</span>
      </div>
    </section>`;
}
```

Then in `renderRpgTheme`, replace the entire `<header class="hero">…</header>` block of the non-insufficient branch with `${renderCard(data)}` followed by the seam:

```ts
    ${renderCard(data)}
    <div class="seam"><span>The Record Behind It</span></div>
```

Leave the `data.insufficient` branch's `<header class="hero">` doorway exactly as it is.

- [ ] **Step 5: Run tests**

```bash
npx tsc -b && npx vitest run dist/__tests__/gemitTheme.test.js
```
Expected: PASS for the four new card tests. The pre-existing `id="training"` test still passes here — Task 4 removes it.

- [ ] **Step 6: Commit**

```bash
git add src/gemit/themeRpg.ts src/gemit/theme/styles.ts src/__tests__/gemitTheme.test.ts
git commit -m "feat(gemit): ceremonial card replaces the hero

Ring gauge, tier stamp, hook pill, three pips and a techniques/streak strip
on a fixed dark plate that reads the same in both themes. Cohort band is
wired but renders nothing while COHORT is null."
```

---

### Task 4: Collapse Training Grounds into the discipline bars

Removes the duplicate section. This is the task that touches the one stale assertion.

**Files:**
- Modify: `src/gemit/themeRpg.ts`, `src/gemit/theme/styles.ts`, `src/gemit/theme/runtime.ts`
- Test: `src/__tests__/gemitTheme.test.ts`

**Interfaces:**
- Consumes: nothing new.
- Produces: one `discBar(label, axis, value, i)` helper replacing both `statBar` and `tgStat`.

- [ ] **Step 1: Update the stale assertion and add the regression guard**

In `src/__tests__/gemitTheme.test.ts`, in `"renders training grounds sliders, quest log, and the sim script"`, replace:

```ts
    expect(html).toContain('id="training"');
```

with:

```ts
    expect(html).toContain('id="disciplines"');
```

Then append a new block:

```ts
describe("the disciplines collapse", () => {
  it("renders each discipline exactly once — no twin section", () => {
    const html = renderRpgTheme(data());
    expect((html.match(/Context Discipline/g) ?? []).length).toBe(1);
    expect((html.match(/Process Quality/g) ?? []).length).toBe(1);
    expect((html.match(/Setup Maturity/g) ?? []).length).toBe(1);
    expect(html).not.toContain('id="training"');
    expect(html).not.toContain("Training Grounds");
  });

  it("keeps three slider handles and the what-if toggle on one set of bars", () => {
    const html = renderRpgTheme(data());
    expect((html.match(/role="slider"/g) ?? []).length).toBe(3);
    expect(html).toContain('class="wi"');
    expect(html).toContain('aria-pressed="false"');
  });

  it("keeps the projection readout and the auto-solve button", () => {
    const html = renderRpgTheme(data());
    expect(html).toContain('id="tg-comp"');
    expect(html).toContain('id="tg-tier"');
    expect(html).toContain('id="tg-solve"');
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
npx tsc -b && npx vitest run dist/__tests__/gemitTheme.test.js
```
Expected: FAIL — `Context Discipline` appears twice, and `id="disciplines"` is missing.

- [ ] **Step 3: Replace the two bar helpers with one**

In `themeRpg.ts`, delete `statBar` and `tgStat` and add:

```ts
// One bar per discipline, in two states. Measured is the default fill; what-if turns the
// same element into a slider whose projected fill sits over a ghost of the measured value.
// The floor in setAxis (v >= meas[axis]) means projection can never read below measured.
const discBar = (label: string, axis: string, v: number, i: number): string => `
      <div class="disc${v < 50 ? " low" : ""}" data-axis="${axis}">
        <div class="disc-head"><b>${label}</b><span class="tg-val mono">${v}</span></div>
        <div class="track" role="slider" tabindex="0" aria-label="Projected ${label}"
             aria-valuemin="${v}" aria-valuemax="100" aria-valuenow="${v}">
          <i class="tg-meas" style="--w:${v}%"></i><i class="tg-proj" style="width:${v}%;--d:${(0.2 + i * 0.12).toFixed(2)}s"></i>
        </div>
      </div>`;
```

- [ ] **Step 4: Replace both sections with one**

In `renderRpgTheme`, delete the whole `<section id="training">…</section>` block and replace the `<section><h2>The Three Disciplines</h2>…</section>` block with:

```ts
    <section id="disciplines">
      <h2>The Three Disciplines <em id="disc-mode">measured</em>
        <button class="wi" type="button" aria-pressed="false">What if?</button></h2>
      ${discBar("Context Discipline", "ctx", data.ctx, 0)}
      ${discBar("Process Quality", "proc", data.proc, 1)}
      ${discBar("Setup Maturity", "setup", data.setup, 2)}
      <p class="tg-rank mono" hidden>PROJECTED <span id="tg-comp">${data.composite}</span> / 100 &mdash; <span id="tg-tier">${tierName}</span></p>
      <button id="tg-solve" type="button"${data.tierLevel >= 4 ? " disabled" : ""} hidden>${data.tierLevel >= 4 ? "You&#39;re at the summit" : `Chart my path to ${TIER_NAMES[3]}`}</button>
    </section>
```

- [ ] **Step 5: Teach the runtime the two states**

In `src/gemit/theme/runtime.ts`, replace the `document.querySelectorAll(".tg-stat")` selector with `".disc"` and the `.tg-bar` selector with `".track"` throughout (four call sites: the forEach, `setAxis`'s `box.querySelector`, and the two `bar.querySelector` lines). Then append, just before the final `})();`:

```js
  var wi = document.querySelector(".wi");
  var sect = document.getElementById("disciplines");
  if (wi && sect) wi.addEventListener("click", function () {
    var on = wi.getAttribute("aria-pressed") !== "true";
    wi.setAttribute("aria-pressed", on ? "true" : "false");
    sect.classList.toggle("whatif", on);
    document.getElementById("disc-mode").textContent = on ? "projected" : "measured";
    document.querySelector(".tg-rank").hidden = !on;
    document.getElementById("tg-solve").hidden = !on;
    if (!on) { setAxis("ctx", meas.ctx); setAxis("proc", meas.proc); setAxis("setup", meas.setup);
      Array.prototype.forEach.call(document.querySelectorAll(".quests input[type=checkbox]"), function (cb) {
        cb.checked = false; cb.closest("li").classList.remove("done");
      });
    }
  });
```

- [ ] **Step 6: Add the two-state CSS**

In `theme/styles.ts`, delete the `.tg-stat`, `.tg-bar`, `.tg-note` and old `.stat*`/`.bar*` rules and add the `.disc`, `.disc-head`, `.track`, `.tg-meas`, `.tg-proj`, `.wi` rules from the mockup. Gate the interaction on the toggle:

```css
.track{ cursor:default; }
#disciplines.whatif .track{ cursor:ew-resize; touch-action:none; }
#disciplines:not(.whatif) .tg-meas{ display:none; }
.wi{ flex:none; order:2; align-self:center; }
h2::after{ order:1; }
```

- [ ] **Step 7: Run tests**

```bash
npx tsc -b && npx vitest run dist/__tests__/gemitTheme.test.js dist/__tests__/gemitShare.test.js
```
Expected: PASS — all tests including the three new collapse tests.

- [ ] **Step 8: Commit**

```bash
git add src/gemit/themeRpg.ts src/gemit/theme/ src/__tests__/gemitTheme.test.ts
git commit -m "feat(gemit): collapse Training Grounds into the discipline bars

One set of bars with measured/what-if states replaces two sections that
rendered identical labels and numbers. Slider handles, projection readout
and auto-solve are preserved, revealed by the toggle."
```

---

### Task 5: Dossier type roles, seam and section weights

Pure styling. No markup logic changes beyond section order.

**Files:**
- Modify: `src/gemit/theme/styles.ts`, `src/gemit/themeRpg.ts`
- Test: `src/__tests__/gemitTheme.test.ts`

**Interfaces:**
- Consumes: `HOUSE_TOKENS`, `themeAdapter` from `@agentgem/model`.
- Produces: nothing new.

- [ ] **Step 1: Write the failing test**

Append to `src/__tests__/gemitTheme.test.ts`:

```ts
describe("house style adoption", () => {
  it("builds on the shared token vocabulary rather than private colours", () => {
    const html = renderRpgTheme(data());
    expect(html).toContain("--surface:");
    expect(html).toContain("--ink:");
    expect(html).toContain("--serif:");
    expect(html).toContain("--mono:");
    expect(html).not.toContain("--panel2");   // retired private token
  });

  it("orders the dossier with the actionable section first", () => {
    const html = renderRpgTheme(data());
    expect(html.indexOf("Quest Log")).toBeLessThan(html.indexOf("Techniques Unlocked"));
    expect(html.indexOf("Techniques Unlocked")).toBeLessThan(html.indexOf("The Record"));
  });

  it("still ships no external URL after adopting house tokens", () => {
    expect(renderRpgTheme(data())).not.toMatch(/https?:\/\//);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
npx tsc -b && npx vitest run dist/__tests__/gemitTheme.test.js
```
Expected: FAIL — `--panel2` still present, Quest Log after Techniques.

- [ ] **Step 3: Rebuild the stylesheet head on house tokens**

At the top of `src/gemit/theme/styles.ts`:

```ts
import { HOUSE_TOKENS, themeAdapter } from "@agentgem/model";

export const STYLES = `${HOUSE_TOKENS}
${themeAdapter("document")}
` + `<the rest of the sheet>`;
```

Delete the old `:root{--bg…}`, `:root[data-theme="light"]` and `@media (prefers-color-scheme: light)` blocks. Rename every remaining use: `--bg`→`--surface`, `--panel`→`--surface-2`, `--panel2`→`--surface-2`, `--line`→`--border`, `--muted`→ drop (use `opacity:.6` per the house note that there is no dim-text token), `--accent`→`--accent`, `--gold`→ keep as a card-local literal (it lives only inside `.card`, which is theme-fixed).

Set the body font to serif per the spec:

```css
body{ margin:0; background:var(--surface); color:var(--ink);
      font:var(--t-body)/1.65 var(--serif); }
.mono{ font-family:var(--mono); font-variant-numeric:tabular-nums; }
```

- [ ] **Step 4: Reorder the dossier sections**

In `renderRpgTheme`, move the Quest Log `<section>` above the Techniques Unlocked `<section>`. Leave The Record and the provenance footer where they are.

- [ ] **Step 5: Run tests**

```bash
npx tsc -b && npx vitest run dist/__tests__/gemitTheme.test.js dist/__tests__/gemitShare.test.js
```
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/gemit/theme/styles.ts src/gemit/themeRpg.ts src/__tests__/gemitTheme.test.ts
git commit -m "feat(gemit): adopt houseStyle tokens and serif dossier

Private --bg/--panel/--line tokens give way to the shared --surface/--ink/
--border vocabulary via themeAdapter('document'). Quest Log leads the
dossier; serif body keeps the report a record rather than telemetry."
```

---

### Task 6: Share text carries the percentile only when it is real

**Files:**
- Modify: `src/gemit/share.ts`
- Test: `src/__tests__/gemitShare.test.ts`

**Interfaces:**
- Consumes: `percentileFor`, `COHORT` from Task 1.
- Produces: unchanged signature `gemitShareUrls(gemKey, data) => { shareUrl, xIntentUrl }`.

- [ ] **Step 1: Write the failing test**

Append to `src/__tests__/gemitShare.test.ts` (reuse that file's existing `data()`-style fixture; if it has none, inline the object from `gemitTheme.test.ts`):

```ts
describe("share text percentile", () => {
  it("omits any percentile claim while the cohort is absent", () => {
    const { xIntentUrl } = gemitShareUrls("me/gemit-2026-07-25", data());
    const text = decodeURIComponent(new URL(xIntentUrl).searchParams.get("text")!);
    expect(text).toContain("Lapidary");
    expect(text).toContain("79/100");
    expect(text).not.toMatch(/top \d+%/i);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
npx tsc -b && npx vitest run dist/__tests__/gemitShare.test.js
```
Expected: FAIL if the fixture import is missing; otherwise PASS trivially — that is fine, it is a guard against a future regression. Confirm it runs.

- [ ] **Step 3: Implement the conditional clause**

In `src/gemit/share.ts`:

```ts
import { COHORT, percentileFor } from "./cohort.js";
```

and in `gemitShareUrls`:

```ts
  const pct = percentileFor(data.composite, COHORT);
  const standing = pct === null ? "" : `, top ${100 - pct}%`;
  const text = `${tierName} — ${data.composite}/100${standing} on agent steering. What's your level?\n${shareUrl}`;
```

- [ ] **Step 4: Run tests**

```bash
npx tsc -b && npx vitest run dist/__tests__/gemitShare.test.js
```
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/gemit/share.ts src/__tests__/gemitShare.test.ts
git commit -m "feat(gemit): share text carries standing only when the cohort is real"
```

---

### Task 7: Cohort generator script

The path from `COHORT = null` to a real table. Not run as part of the build.

**Files:**
- Create: `scripts/gemit-cohort.mjs`

**Interfaces:**
- Consumes: `Cohort` shape from Task 1.
- Produces: prints a `src/gemit/cohort.ts` body to stdout; writes nothing.

- [ ] **Step 1: Write the script**

Create `scripts/gemit-cohort.mjs`:

```js
// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
// scripts/gemit-cohort.mjs
//
// Regenerates the baked cohort table in src/gemit/cohort.ts from real published gemit
// cards. Reads composites from stdin — one integer 0..100 per line — so the source of
// those numbers stays an explicit, auditable step rather than a hidden network call.
//
//   node scripts/gemit-cohort.mjs < composites.txt
//
// Prints the COHORT literal. Paste it over the `export const COHORT` line. Refuses to
// emit anything below MIN_COHORT samples: a percentile from a small sample is noise.

import { createInterface } from "node:readline";

const MIN_COHORT = 100;
const scores = [];

for await (const line of createInterface({ input: process.stdin })) {
  const n = Number(line.trim());
  if (Number.isInteger(n) && n >= 0 && n <= 100) scores.push(n);
}

if (scores.length < MIN_COHORT) {
  console.error(`refusing: ${scores.length} samples, need >= ${MIN_COHORT}`);
  process.exit(1);
}

scores.sort((a, b) => a - b);
// p[i] = share of the cohort strictly below composite i, as a 0..99 integer.
const p = Array.from({ length: 101 }, (_, i) => {
  let below = 0;
  while (below < scores.length && scores[below] < i) below += 1;
  return Math.min(99, Math.round((100 * below) / scores.length));
});

const asOf = new Date().toISOString().slice(0, 10);
console.log(`export const COHORT: Cohort | null = {
  asOf: ${JSON.stringify(asOf)},
  n: ${scores.length},
  p: [${p.join(",")}],
};`);
```

- [ ] **Step 2: Verify it refuses a small sample**

```bash
printf '70\n80\n90\n' | node scripts/gemit-cohort.mjs; echo "exit=$?"
```
Expected: `refusing: 3 samples, need >= 100` and `exit=1`.

- [ ] **Step 3: Verify it emits a valid table for a large sample**

```bash
node -e 'for(let i=0;i<500;i++)console.log(Math.floor(Math.random()*101))' \
  | node scripts/gemit-cohort.mjs | head -4
```
Expected: an `export const COHORT` literal with `n: 500` and a 101-element `p` array.

- [ ] **Step 4: Commit**

```bash
git add scripts/gemit-cohort.mjs
git commit -m "chore(gemit): cohort table generator

Reads composites on stdin and prints the COHORT literal. Refuses below 100
samples so a percentile is never computed from noise."
```

---

### Task 8: Browser verification

jsdom asserts behaviour, never appearance. This task is the appearance gate.

**Files:**
- Create: none (scratch only)
- Modify: none unless a defect is found

- [ ] **Step 1: Render all four states to disk**

```bash
npx tsc -b
node -e '
const {renderRpgTheme}=require("./dist/gemit/themeRpg.js");
const fs=require("node:fs");
const base={windowFrom:"2026-06-25",windowTo:"2026-07-25",qualifyingSessions:6405,scoredSessions:119,
projects:44,totalMsgs:476112,tokensOut:248446123,ctx:99,proc:81,setup:33,composite:79,tierLevel:3,
verdicts:{bounded:119,mixed:0,bloated:0},labels:{disciplined:43,loose:7,chaotic:5},verifyRatePct:24,
boundedStreak:119,firedFindings:[{id:"repeated-tool-error",title:"Repeated tool errors",sessions:17},
{id:"no-verify-finish",title:"Unverified finish",sessions:11},{id:"retry-storm",title:"Retry storm",sessions:9}],
skillVariety:12,subagentVariety:8,skillSessionsPct:62,subagentSessionsPct:41,topSkills:[],topSubagents:[],
insufficient:false};
const out=(n,d)=>fs.writeFileSync("/tmp/gemit-"+n+".html",renderRpgTheme(d));
out("lapidary",base);
out("prospector",{...base,ctx:22,proc:31,setup:12,composite:23,tierLevel:1,boundedStreak:2,
  subagentVariety:1,skillVariety:2,verifyRatePct:5,verdicts:{bounded:9,mixed:40,bloated:70}});
out("master",{...base,ctx:95,proc:92,setup:88,composite:92,tierLevel:4});
out("doorway",{...base,insufficient:true,qualifyingSessions:2,composite:0,tierLevel:1});
console.log("wrote 4");'
```

- [ ] **Step 2: Check each state in a real browser, both themes**

Open each file. For every one, confirm:
- The tier name is **visible** (the gradient-fallback check — if it is invisible, the `color:` declaration is in the wrong place or folded into the shorthand).
- The card separates from the page background in **dark** as well as light.
- `Context Discipline` appears exactly once.
- `What if?` toggles the bars to draggable, reveals the projection readout, and reverts cleanly.
- No cohort band anywhere.

Specifically on `gemit-prospector.html`: confirm the **ring at composite 23 reads as low, not broken** — this is the spec's open risk and the mockup never exercised it. If it looks wrong, add a minimum visible arc and note it in the commit.

On `gemit-doorway.html`: confirm no card, no tier name, no score.

- [ ] **Step 3: Check the thumbnail crop**

Zoom the Lapidary page to ~40% and confirm tier, composite, hook and all three pips stay legible.

- [ ] **Step 4: Full suite**

```bash
pnpm test 2>&1 | tail -15
```
Expected: PASS. Pre-existing unrelated failures, if any, must be reported as pre-existing, not silently absorbed.

- [ ] **Step 5: Commit any fixes and open the PR**

```bash
git fetch origin
git log --oneline origin/main..HEAD          # confirm ahead of origin/main only
git push -u origin <branch>
gh pr create --title "feat(gemit): two-register card + dossier redesign" --body "…"
gh run watch <run-id> --exit-status
gh pr merge --rebase --delete-branch
git fetch && git show origin/main:src/gemit/cohort.ts | head -3   # verify EVERY commit landed
```

---

## Self-Review

**Spec coverage:** card → T3; cohort gate → T1; cohort generator → T7; Training Grounds collapse → T4; house tokens + serif body + section weights → T5; share percentile → T6; file decomposition → T2; browser + prospector-ring risk → T8. No spec section is unimplemented.

**Known deviation:** the spec's file table lists `theme/styles.ts` and `theme/runtime.ts` as created during the redesign; this plan creates them in a separate pure-refactor commit (T2) so the redesign diff is reviewable. Same end state.

**Type consistency:** `percentileFor(composite, c)` and `cohortLabel(c)` are used in T3 and T6 exactly as defined in T1. `discBar` (T4) replaces both `statBar` and `tgStat`. The runtime's `meas`/`setAxis` names are the existing ones and are reused, not redefined.

**Percentile direction:** `p[i]` is the share *below* composite `i`, so "top X%" is rendered as `100 - pct`. This is applied consistently in T3 and T6; T1's tests assert the raw table value, not the display string.
