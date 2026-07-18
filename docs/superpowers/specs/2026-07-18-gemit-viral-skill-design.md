# `/gemit` — a viral, installable steering self-assessment

**Status:** Draft — needs eng review before implementation.

## What this is

A growth loop packaged as a skill. `/gemit` is a tiny installable skill any dev can add to
their coding agent; it runs `npx -y @ninemind/agentgem gemit`, which scores the operator's
**agent-steering expertise** over their last 30 days of local sessions using AgentGem's
existing deterministic detectors, renders a fun, interactive **RPG character sheet** as a
self-contained HTML report, and — on an explicit share action — publishes that report as an
**unlisted miniapp** on the marketplace with a prefilled social post. The share link unfurls
as the rendered card; the landing page's chrome carries the "What's your steering level?"
invite with the `/gemit` install one-liner. The invite *is* the artifact.

The loop: see a card on X/LinkedIn → open the live miniapp → copy one command → get your own
card in ~2 minutes → share. Every run is a soft trial of the real product (real CLI, real
detectors), and every share mints a marketplace identity.

## Decisions already made (brainstorm record)

| Question | Decision | Why |
|---|---|---|
| Who consumes the score? | Public self-promotion (viral share), not a trust credential | Gaming stops mattering; shareability is the design goal |
| Evidence base | **Process-first**: the score IS the aggregated steering signal | Most faithful to "steering expertise"; Goodhart-benign (inflating it ≈ adopting the habits) |
| Dimensions | **Context discipline · Process quality · Setup maturity** (mining leverage excluded) | Measures how you drive, not what you've minted |
| Viral unit | Wrapped-style recap over a **rolling 30-day window ending at run date** | Comparison bait with enough sessions to be non-embarrassing; "monthly" cadence comes from re-running, not a calendar gate |
| Runtime | **npx-backed skill** — thin SKILL.md over `npx -y @ninemind/agentgem gemit` | Zero install, zero logic duplication, every run demos the product |
| Art direction | **Themed templates**, default = RPG character sheet (anime-adjacent) | Stats-as-identity is the most reshared dev-social format; multiple themes keep the feed diverse and add a re-share trigger |
| Share artifact | Each report published as its **own immutable unlisted miniapp** | Viewer touches the real animated sheet; old links never rewrite; reuses sealed-iframe + OG rails |

## Grounding — what exists vs what's new

| Piece | Today | Verdict |
|---|---|---|
| Steering signals | Deterministic, LLM-free detectors: context hygiene (`packages/insight/src/contextHygiene.ts` — bounded/mixed/bloated score) + process quality (`packages/insight/src/detectors.ts` — `retry-storm`, `thrash-loop`, `no-verify-finish`, …) | **Exists** — gemit only aggregates |
| Setup maturity | Inventory/introspection (`packages/capture/src/introspect.ts`, `skillRoots.ts`) + usage (`resolveUsage.ts`): what the harness carries and whether it gets used | **Exists** — needs a small index (0–100) over artifact presence × usage |
| Transcript access | `packages/capture/src/transcriptIndex.ts` — cold reads in ms, inventory-independent | **Exists** |
| CLI slot | `src/cli.ts` is a thin dispatcher; every subcommand lazy-imports its module (`learn`, `get`, `bind`, `warm`…) | **New subcommand, existing pattern** — `agentgem gemit` |
| Identity for publish | `agentgem bind` + GitHub device flow (`src/bind/deviceFlow.ts`, `bindCore.ts`) | **Exists** — gemit share triggers it once if unbound |
| Unlisted publish | `Visibility = "public" \| "unlisted" \| "private"` (`packages/aggregator/src/catalog.ts:12`); miniapp publish via `POST /api/play/publish` (`packages/console/src/api/routes.ts:1185`); archive-only unlisted shares already supported (`catalog.ts:188`) | **Exists** — gemit calls the same publish core the console route uses (NOT the HTTP route; the CLI runs headless, no local server) |
| OG unfurl | Miniapp OG card = real screenshot via sealed-iframe shim (og-screenshot-capture V2) | **Exists** — verify it runs for unlisted entities |
| Miniapp constraints | Sealed iframe, `needs` reconciliation, srcdoc anchor sealing, known sizing traps | **Constraint, not work** — the report is self-contained with `needs: none` by design |
| Skill distribution | Marketplace publish + skills.sh indexing + curated sources | **Exists** — `/gemit` SKILL.md is just another published skill |

New code is confined to: one aggregation module, one tier mapping, one HTML template, one CLI
subcommand, one SKILL.md, and marketplace page chrome for the invite CTA.

## The score

Three dimensions, each 0–100, computed over the last 30 days of sessions across all local
projects (minimum-evidence floor: **≥ 5 qualifying sessions**, else the report renders a
friendly "go steer some agents first" state and never a score):

- **CTX — Context discipline.** From per-session hygiene scores: share of bounded vs bloated
  sessions, task-sprawl/reread-churn rates. Time-weighted (recent sessions count more).
- **PROC — Process quality.** From process-quality detector firings per session:
  verify-before-finish rate, retry-storm rate, thrash-loop rate. Inverted and normalized.
- **SETUP — Setup maturity.** Presence × usage of harness artifacts across active projects
  (CLAUDE.md, skills, subagents, rubrics; invocation recency). Presence alone caps low —
  unused setup is shelf-ware.

**Tier** = mapping over the weighted composite (weights and thresholds are fixed v1 constants
in one module, golden-tested):

| Tier | Flavor |
|---|---|
| Prospector | You're finding the veins |
| Cutter | Clean breaks, most days |
| Lapidary | The window stays lean; done means verified |
| Master Lapidary | The harness works for you |

All arithmetic is deterministic and LLM-free — two runs over the same transcripts produce the
same sheet, which matters when thousands of cards get compared.

## The report — themed templates

The report is **one data payload rendered by one of a small set of themes**. The scoring
never varies by theme; a theme is a presentation function over the same aggregates, so cards
stay comparable across styles. Every theme must emit self-contained, miniapp-conforming HTML
(the constraints below apply to all of them). Selected via `--theme <name>` (the `/gemit`
skill offers the menu conversationally); default = `rpg`.

v1 themes (small on purpose — each is a maintained artifact):

- **`rpg` (default)** — anime-adjacent character sheet: class emblem, stat bars, perk slots.
- **`card`** — holographic trading card: rarity border by tier, maximum screenshot density.
- **`arcade`** — retro end-of-level results: pixel font, rank letter, high-score table of
  your own windows.

Regenerating the same window in a different theme is free and local; sharing publishes the
themed HTML (theme name rides in the payload so the landing chrome can label it).

The default `rpg` sheet — self-contained interactive HTML (inline CSS/JS/data, no network to
view), anime-adjacent character-sheet framing:

- **Class emblem + tier name** (the headline screenshot object).
- **Three stat bars** (CTX · PROC · SETUP) that animate on load.
- **Perks**: detector-derived habits, unlocked ("Clean Breaker — 82% bounded") and visibly
  **locked** (the unfired detectors — next month's retention hook).
- **XP trend**: this 30-day window vs the previous one, when history suffices.
- **Brag stats**: sessions steered, % bounded, verify rate, longest clean streak.
- Flavor text is playful; every number is a real detector output. No invented percentiles in
  v1 — rarity lines only if/when the hosted benchmark population clears a threshold; the
  fallback comparison hook is your own trend.

The same artifact must be a conforming miniapp: `needs: none`, no external links inside the
sealed frame, sizing per the known sealed-iframe rules. One HTML plays identically from the
local file and the marketplace page.

## The flows

### `agentgem gemit` (local, no auth)

1. Locate the Claude home (same resolution as the server; `--dir` override like `learn`).
2. Index transcripts → run detectors + hygiene + setup scan → aggregate → tier.
3. Write `gemit-report.html` in the chosen theme (`--theme rpg|card|arcade`, default `rpg`;
   path printed; `--open` opens the browser; default opens on TTY).
4. Print the score summary and the share hint.

Headless by design: no local server starts, no console required.

### `agentgem gemit --share` (publish)

1. Ensure identity: if unbound, run the existing device-flow bind inline (one-time).
2. Print **exactly what will be published** (tier, three stat values, perk names, session
   count, window dates — no transcripts, no project names, no paths) and confirm on TTY
   (`--yes` skips for scripted use).
3. Publish the report HTML as a **new immutable unlisted miniapp** (one per report; key
   embeds the window end date, e.g. `gemit-<handle>-2026-07-18` — re-sharing the same day
   updates that key in place, a new day mints a new card). Never in browse/search.
4. Print the share URL + a prefilled X intent URL ("Just pulled my agent-steering card —
   Lapidary class 💎 What's yours?" + link). There is **no Share button inside the report**
   in v1 — the CLI (and the `/gemit` skill, conversationally) owns sharing; the sealed
   published copy can't call out anyway, and the marketplace page chrome owns sharing there.

### The landing (marketplace page)

Existing miniapp page serves the sheet in the sealed iframe. Page chrome adds, for
`gemit`-kind entities: the **"What's your steering level?"** CTA with the copyable
`npx -y @ninemind/agentgem gemit` one-liner (skill install as secondary), and the standard
"powered by AgentGem" path. Play count doubles as share analytics ("your July card was viewed
340×" — next month's re-share trigger).

### The skill

`/gemit` SKILL.md: instructs the agent to run the npx command, open the report, and offer
`--share`. Published to the marketplace (public), indexed on skills.sh. The skill contains no
scoring logic — it can iterate daily without touching versioned scoring.

## Privacy

- Nothing leaves the machine until the user confirms share; the pre-publish print is the
  contract.
- Published payload is card aggregates only. The report generator must never inline project
  names, file paths, or transcript excerpts into the HTML (they'd otherwise ride into the
  published miniapp) — enforced by a test that greps the emitted HTML for fixture project
  names/paths.
- Unlisted = link-only; the aggregator's visibility predicate already excludes unlisted from
  every browse/search surface (`catalog.ts:50`).
- Local report is screenshot-shareable with zero auth — the escape hatch is free.

## States

- **Empty** (< 5 sessions): doorway, not a dead end — what gemit measures, "steer a few
  sessions and come back," no score shown.
- **Thin history** (no prior window): XP trend omitted, not zeroed.
- **Share failure** (offline, publish error): report still exists locally; error names the
  step and the retry (`gemit --share` is re-runnable; republish of the same window updates
  the same key rather than minting duplicates).
- **Old CLI via npx**: npx pins latest by default; report footer carries the CLI version so
  compared cards are interpretable.

## Testing

- Golden-fixture tests: fixture transcript set → exact dimension scores, tier, perk list
  (core aggregation + tier mapping).
- Emitted-HTML tests, **run per theme**: self-contained (no external URLs), valid as a
  miniapp (`needs: none`), contains no fixture project names/paths (privacy grep). Themes
  share one test harness so adding a theme is adding a fixture entry, not a test suite.
- Publish-path test: share posts aggregates-only payload; unlisted visibility asserted via
  the aggregator's existing catalog helpers.
- Real-browser verification: report animation, marketplace sealed-iframe rendering, OG unfurl
  of an unlisted gemit entity.
- CI note: root `dist/__tests__` is the CI gate — core scoring tests live under root `src/`
  so they're collected.

## Slicing (each PR ships value alone)

1. **PR-1 — score core + local report.** Aggregation module + tier mapping + the `rpg` theme
   + `agentgem gemit` subcommand (no share), with the theme seam (`--theme`) in place. Golden
   + HTML tests. *Deliverable: anyone with the npm package can generate their card locally.*
   Additional themes (`card`, `arcade`) land as independent follow-ups any time after PR-1 —
   each is a template + a fixture entry.
2. **PR-2 — share as unlisted miniapp.** `--share` with device-flow bind, aggregates-only
   payload, immutable-per-window publish, share/intent URLs. *Deliverable: the full loop
   minus landing polish.*
3. **PR-3 — landing chrome + skill.** Marketplace CTA chrome for gemit entities, OG
   verification for unlisted, publish the `/gemit` skill to marketplace + skills.sh.
   *Deliverable: the viral loop closes.*

## Open questions (flag for eng/design review)

1. **Tier names** are screenshot-permanent — playtest before PR-1 lands the constants?
   Same question for the v1 theme roster (`rpg`/`card`/`arcade`) and their names.
2. **`npx gemit` alias package** (standalone bin wrapping the same command) for an even
   shorter invite line — worth the extra publish surface?
3. **Publish core seam**: exact reuse point behind `POST /api/play/publish` for a headless
   CLI caller (client + auth without the local server) — implementer to pin during PR-2.
4. **OG capture on unlisted**: confirm the screenshot shim runs for archive-only unlisted
   entities or needs a small enablement.
5. **Immutable republish semantics**: same-window re-share updates in place (recommended
   above) vs strict immutability — pin against how `gem_archives` versioning behaves.
