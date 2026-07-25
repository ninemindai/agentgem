# gemit report polish — two-register card + dossier

Status: design approved 2026-07-25. Implementation pending.

## Problem

`agentgem gemit` renders a handsome, well-typeset report that nobody screenshots.

Three concrete faults in the current `src/gemit/themeRpg.ts`:

1. **Twin sections.** "The Three Disciplines" and "Training Grounds" render the same
   three labels with the same three numbers, stacked adjacently. A first-time reader
   parses the second block as a rendering bug.
2. **No hero.** Six sections carry identical visual weight across one calm scroll.
   There is no frame worth capturing. The best viral copy in the document —
   `1 pt from Master Lapidary` — is set in 14px muted mono inside a thin box.
3. **Off the house style.** The report predates `packages/model/src/houseStyle.ts`
   and uses hand-rolled tokens plus Georgia for every role. The rest of AgentGem
   (miniapps, rubric report, dashboard) converged on the shared vocabulary in
   PRs #539–#545; gemit was never swept.

Fault 3 is the smallest visual gap — the rendered light theme already sits close to
the house `document` palette. The divergence that matters is **type roles**, not colour.

## Goals

- A screenshot-shaped hero that reads at thumbnail size.
- Cohort standing ("top N%") *when and only when* that claim is true.
- Section weights that differentiate, per `anthropics/html-effectiveness`.
- More game ceremony, without turning the analysis into a toy.

## Non-goals

- Changing any score. Scoring stays in `src/gemit/score.ts`, untouched.
- Network access from the report. The offline invariant holds (see Constraints).
- A separate share-only renderer. One `renderRpgTheme`, one look.

## Constraints (load-bearing)

| Constraint | Enforced by | Consequence |
|---|---|---|
| Zero external URLs | `gemitTheme.test.ts`: `expect(html).not.toMatch(/https?:\/\//)` | No fonts, no CDN, no live cohort fetch. Inline SVG only. |
| Template is a TS string builder | npm tarball ships `dist/` only | No runtime file reads for markup or CSS. |
| Projection cannot drift from scoring | `simSrc = [projectComposite, tierFor, autoSolvePath].map(f => f.toString())` | The sim trio stays plain, serializable, un-minified. |
| Share variant omits names | `shareVariantOf` clears `topSkills`/`topSubagents` | Anything new the card displays must be a count, never a name. |

The `f.toString()` serialization is the sharpest of these: it is why the interactive
projection provably uses the same arithmetic as the score. Any refactor that makes
those three functions non-serializable (closures over module state, minifier-mangled
names) silently breaks the guarantee. Keep them pure and top-level.

## Design

### Two registers with a hard seam

```
┌────────────────────────────┐
│                            │  THE CARD — game register
│       L A P I D A R Y      │  ~1 screen, designed crop
│       ◜ 79 ◝ ring gauge    │  tier stamp · ring · cohort
│   top 21% · 1 pt from      │  hook line · pips · streak
│      Master Lapidary       │
│   ctx 99  proc 81  set 33  │
│   ◈◈◈◈◇ 4/5    ⚡ 119      │
└────────────────────────────┘
──────────── seam ───────────
  THE THREE DISCIPLINES        THE DOSSIER — editorial register
  ...                          house type roles, varied weight
  TECHNIQUES · QUEST LOG
  THE RECORD
```

The register switch is itself the differentiation `html-effectiveness` asks for.
Hierarchy at the document level, not just within sections.

### The card

Contents, in weight order: tier name (stamped, `clamp(38px, 8vw, 60px)`), composite
ring gauge with count-up, cohort band (conditional), hook line, three discipline pips,
techniques `◈◈◈◈◇` and streak `⚡`.

The ring is inline SVG with animated `stroke-dashoffset` — it reads at thumbnail size
where an 8px-tall bar does not, and SVG is already in the house vocabulary
(`HOUSE_PARTIALS.svgBar`). Verified: at 42% scale every card element stays legible.

Sized so the card occupies roughly the first 1.91:1 crop at the 700px content width
(min-height ~366px), which is the aspect both X unfurls and manual screenshots favour.

**The card keeps a fixed dark plate in both themes.** A shared screenshot then looks
identical regardless of the sender's theme, and the card reads as an object rather
than a page section. This costs contrast on a dark page, where the plate merges with
the background — so the dark binding lifts the plate and strengthens the edge:

```css
.card{ --plate:#16181d; border:1px solid rgba(236,231,220,.09);
       box-shadow:inset 0 1px 0 rgba(255,244,216,.10), … }
:root[data-theme="dark"] .card{ --plate:#20242c;
       border-color:rgba(236,231,220,.16);
       box-shadow:inset 0 1px 0 rgba(255,244,216,.14), 0 0 0 1px rgba(0,0,0,.5), … }
```

Verified in both themes before this spec was amended.

**Gradient tier name needs a solid-colour fallback declared first.** The shine effect
uses `background-clip:text` + `-webkit-text-fill-color:transparent`; if the gradient
fails to paint, the title renders *invisible* rather than unstyled. Declare
`color:#e8c87d` before `background-image`, and never fold the gradient into the
`background` shorthand.

### The dossier

Type roles adopted from `HOUSE_TOKENS`: `--serif` for display, section headings **and
body prose**, `--mono` for every numeral and label. `--sans` is used only for the
small uppercase labels inside `.cell`.

Serif body was chosen over sans after building both and comparing them rendered: sans
reads as product telemetry, serif as a record of your work. `gemit` is a keepsake you
post, not a dashboard you monitor, and the mono numerals supply enough contrast on
their own. (The earlier draft of this spec recommended sans; the mockup overturned it.)

Section weights, loudest first: Quest Log (the actionable part) → Disciplines →
Techniques → The Record → provenance footer.

The `What if?` toggle sits inline at the end of the `h2` rule, not floated beside the
lede — `h2::after{order:1}` + `.wi{order:2;align-self:center}` puts it after the hairline.

### Training Grounds collapses into the stat bars

Delete `tgStat`. One set of discipline bars with two states:

- **measured** (default) — static fill, current look.
- **what-if** — same bars become draggable; measured value persists as a ghost track.

A single `What if?` toggle switches state. Quest checkboxes drive projection as they
do today; toggling off restores the measured display. The existing floor
(`v = Math.max(meas[axis], …)`) is preserved — projection can never read below measured.

This removes the duplicate section, halves the bar CSS, and turns two components
showing identical numbers into one component with two states.

### Cohort — mechanism now, claim when true

New `src/gemit/cohort.ts`:

```ts
export interface Cohort {
  asOf: string;      // ISO date the table was generated
  n: number;         // sample size
  p: number[];       // index = composite 0..100, value = percentile
}
export const MIN_COHORT = 100;
export const COHORT: Cohort | null = null;   // until generated from real cards
export function percentileFor(composite: number, c: Cohort | null): number | null;
```

`percentileFor` returns `null` when `c === null` or `c.n < MIN_COHORT`. The card's
cohort band renders only on a non-null percentile; its absence shifts nothing else.

**No invented data.** A baked table populated with plausible numbers would be
fabricated social proof in a document whose footer advertises "deterministic
detectors, no LLM in the loop." `scripts/gemit-cohort.mjs` regenerates the table from
real published `gemit` gems; until it is run against the aggregator, `COHORT` stays
`null` and the band stays absent.

When present the band is self-disclosing: `top 21% · of 1,284 shared cards, Jul 2026`.
Staleness is a stated fact, not a hidden defect.

### Share text

`gemitShareUrls` appends the percentile only when `percentileFor` is non-null:
`Lapidary — 79/100, top 21% on agent steering. What's your level?`

## File decomposition

`themeRpg.ts` is 468 lines doing five jobs and this work grows the CSS and runtime
JS substantially. Split the two that grow most, keep the entry stable:

| File | Contents |
|---|---|
| `src/gemit/themeRpg.ts` | `renderRpgTheme`, `perksFor`, `questsFor`, markup helpers. Re-exports so existing test imports keep working. |
| `src/gemit/theme/styles.ts` | The stylesheet string, built on `HOUSE_TOKENS` + `themeAdapter("document")`. |
| `src/gemit/theme/runtime.ts` | `RUNTIME_JS` — ring sweep, what-if toggle, quests, confetti, copy. |
| `src/gemit/cohort.ts` | `Cohort`, `COHORT`, `MIN_COHORT`, `percentileFor`. |

Perks and quests stay in `themeRpg.ts`: they are pure, already exported, already
tested there, and moving them is churn without benefit.

## Testing

Existing `gemitTheme.test.ts` passes unchanged **except one assertion**. In
`"renders training grounds sliders, quest log, and the sim script"`:

```ts
expect(html).toContain('id="training"');   // ← must change; the section is removed
```

Everything else in that file survives the redesign by construction and must keep
passing: the three `role="slider"` handles (the collapsed bars keep the role), the
`data-n` count-up span, `1 pt from Master Lapidary`, `id="confetti"`,
`function autoSolvePath`, `GEMIT_CONST`, `prefers-reduced-motion`, hostile-string
escaping, the JSON island round-trip, and the doorway's refusal to name a tier.

That file is the contract for self-containment, escaping, the JSON island, and the
insufficient-data doorway. Treat any *other* failure in it as a regression, not as a
test to update.

New coverage:

- `percentileFor` returns `null` for `null` cohort, for `n < MIN_COHORT`, and a
  correct percentile for a populated table.
- Rendered HTML contains no cohort band when `COHORT` is `null`.
- Rendered HTML contains exactly one set of discipline bars (the twin-section
  regression guard): the `Context Discipline` label appears once.
- The what-if toggle and the ring are present for scored data, absent for
  `insufficient`.
- `gemitShareUrls` omits the percentile clause when the cohort is absent.

Verification is a real browser screenshot at both themes plus a thumbnail-scale
check — jsdom asserts behaviour, never appearance.

## Risks

- ~~Register seam reads as two documents.~~ Tested in the mockup: the eye stops at the
  seam label and re-enters in the new register cleanly. Not a risk.
- **Ring gauge at small composites.** A 12/100 ring looks broken rather than low. The
  mockup only exercised 79 — a Prospector-tier card is untested.
  Mitigation: minimum visible arc, and the `.low` accent already used by the bars.
- **Cohort never gets generated**, leaving dead code. Accepted: the gating branch is
  four lines and the alternative is shipping a false claim.

## Open

`/games/:key` OG unfurl behaviour is unverified — the marketplace is a separate
CF Pages build outside this repo. The card is justified by manual screenshot-and-post
regardless; if the unfurl is a real artifact screenshot, it benefits for free.
