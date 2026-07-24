# Miniapp Templates + Shared House Style — Design

**Date:** 2026-07-24
**Status:** Approved (design), pre-implementation
**Scope:** Slice 1 of 2. Adds a shared design-token module (`@agentgem/model`), two new miniapp
genres (`project-map`, `skill-tuner`), retrofits `session-heatmap` onto the shared tokens, and
replaces the Composer's hardcoded genre fork with a per-source template picker. Slice 2 (the
report/dashboard ACP briefs and the Blank `docTemplate`) is out of scope — see **Deferred**.

## Problem

AgentGem generates self-contained HTML from three places, and only one of them is given a concrete
starting artifact:

| Surface | Contract | Starting artifact? |
| --- | --- | --- |
| Play Studio | `MINIAPP_BUILDER_BRIEF` (`packages/play/src/builderBrief.ts`, 191 lines) | **yes** — `scaffolds.ts` |
| Rubric report | `REPORT_BUILDER_BRIEF` (`packages/insight/src/reportBrief.ts`) | no — prose only |
| Session dashboard | inline prompt (`packages/insight/src/dashboardRender.ts:67-70`) | no — prose only |

Separately, the miniapp template set is thin and game-shaped. `GENRES`
(`packages/play/src/genres.ts`) holds three games (`replay`, `skill-run`, `project-fun`) and one
analytical genre (`session-heatmap`, whose own guidance reads *"Analytical, not a game."*). There is
no non-game template for a project or a skill, and no shared visual language across any of it — each
scaffold hand-rolls its own CSS.

`anthropics/html-effectiveness` (MIT) is the design reference: 20 self-contained HTML files whose
house style already matches what `REPORT_BUILDER_BRIEF` describes in prose (serif display, system-ui
body, monospace numerals, one accent, no gradients/shadows/emoji, hand-rolled inline SVG). Its
`18`/`19`/`20` editor examples are the shape `skill-tuner` wants; `13`/`04` are the shape
`project-map` wants.

## Design

### 1. `houseStyle` — shared tokens, per-surface theming

New module `packages/model/src/houseStyle.ts`. Pure strings, no imports, no I/O (same discipline as
`builderBrief.ts`). Lives in `@agentgem/model` because both `@agentgem/play` and `@agentgem/insight`
already depend on it and it is the nearest common ancestor.

```ts
export const HOUSE_TOKENS: string;                    // --ink, --surface, --accent, --ok, --warn,
                                                      // type scale, spacing — declarations only
export type ThemeMode = "host" | "document" | "fixed";
export function themeAdapter(mode: ThemeMode): string; // CSS binding the SAME token names per surface
export const HOUSE_PARTIALS: {                        // structural CSS, opt-in per scaffold
  kpiRow: string; dataTable: string; svgBar: string;
};
```

All three exports are CSS strings a scaffold concatenates into its `<style>`; none emit markup.
A scaffold composes `HOUSE_TOKENS + themeAdapter("host") + <partials it uses>`.

Every surface writes `--ink`; only the binding differs:

| mode | binding | consumer |
| --- | --- | --- |
| `host` | `--ink: var(--color-text-primary, #141413)` — host vars with fallbacks | miniapp scaffolds (this slice) |
| `document` | `:root[data-theme]` pairs + `prefers-color-scheme` default | report renderer (slice 2) |
| `fixed` | literal `#f1eadb` / `#20190f` / `#9a3324` | dashboard renderer (slice 2) |

`mode` is a typed union so a scaffold cannot pass `document` and silently render unthemed inside the
null-origin iframe, where no `--color-*` vars exist.

Only `host` ships in this slice. `document` and `fixed` are defined and unit-tested but have no
consumer until slice 2 — this is deliberate: defining all three now is what makes the token set
surface-neutral rather than miniapp-shaped.

### 2. Templates

Three templates, sized to the data `sourceContext.ts` actually yields
(`SessionData` / `SkillData` / `ProjectData`, lines 8-10):

| Genre | Status | Renders | Declares |
| --- | --- | --- | --- |
| `session-heatmap` | **retrofit** | KPI row from `meta` stats → heatmap grid hero → click-to-reveal turn detail. Behavior unchanged; restyled onto `houseStyle`. | `session-data` (content) |
| `project-map` | **new** | Thesis line from `flavor` → file tree grouped by directory → per-extension counts as inline-SVG bar. | `local-project-access` (enhancement) |
| `skill-tuner` | **new** | Skill readout (trigger, description, body) with editable trigger/description, live preview, "copy skill markdown". | `copy-command` (enhancement) |

Sessions get a retrofit rather than a fourth genre because `session-heatmap` is already the
analytical session template; a second would duplicate it. Retrofitting one and adding two exercises
both paths the following slices will keep using.

**`project-map` and thin data.** `ProjectData` is `{ path, flavor, files: string[] }` — file names
only, no contents. It can render structure and counts; it cannot render architecture. It therefore
declares `local-project-access` as an **enhancement**: with a host it upgrades to the real
inventory, with none it renders the baked file list. `portability.ts:19` already classifies that
capability as `"enhancement"`, so `assertPortable` demands no baked fallback and publish is never
blocked — the degradation path is enforced by existing code.

**`skill-tuner` and the clipboard.** `portability.ts:25` classifies `copy-command` as an
enhancement, *"egress to the clipboard, never a game's primary content."* So the tuner is a readable
skill readout first and an editor second. Tuner state is in-memory by design (the storage shim dies
on reload); `agentgemApp.copyCommand(text)` (`mcpAppClient.ts:71`) is the one-way exit. `ember.ts:30,246`
is the working precedent for a built-in miniapp declaring and calling it.

### 3. Genre wiring

Adding a genre touches five places. Two are already compile-enforced; this slice makes a third so.

| Touchpoint | File | Enforcement |
| --- | --- | --- |
| `GAME_GENRES` | `packages/model/src/types.ts:50` | source of the union |
| `GENRE_TAGS` | `packages/console/src/panels/Play/parseTags.ts:10-16` | **compile** — `_GenreDrift` |
| Composer picker | `packages/console/src/panels/Play/Composer.tsx` | **compile (new)** — `Record<GameGenre, …>` |
| `GENRES` | `packages/play/src/genres.ts` | test (`genres.test.ts`) |
| `SCAFFOLDS` + `sourceContext` branch | `packages/play/src/{scaffolds,sourceContext}.ts` | test (`genres.test.ts`) |

Genre ids are **public taxonomy**, not internal keys: `parseTags.ts:7` documents that Studio
publishes `["game", <genre>, ...userTags]` and the marketplace reads them back as the genre facet.
`project-map` and `skill-tuner` are therefore permanent once anything publishes — renaming later
orphans facets on published gems.

### 4. Composer picker

`Composer.tsx:105` currently forks on a single literal:

```ts
const genre = source.kind === "session" && sessionGenre === "session-heatmap" ? { genre: sessionGenre } : {};
```

Replaced by a local `Record<GameGenre, { label: string; blurb: string; sourceKind: GameSource["kind"] }>`,
filtered to the selected source kind. Typing the record against `GameGenre` makes it exhaustive — a
new genre without a picker entry is a compile error. Kept as a local literal with `import type` only,
because a runtime import of `GAME_GENRES` drags `node:*` into the browser bundle (the constraint
`parseTags.ts:9` already documents).

### 5. Data flow

The plumbing exists. `seedStudio(source, readers, name, genre)` (`studio.ts:92`) already accepts an
optional genre and threads it to `extractSource(source, readers, genre)`. This slice widens the
branch rather than adding a parameter:

```
Composer (source kind + template)
  → playStudioRoute { source, genre }
  → seedStudio → extractSource → { genre, data, brief, createdFrom }
  → scaffoldFor(GENRES[genre].scaffold) + seedHtml(…, redactForBake(data))
  → <name>.html + meta.json { genre, needs }
```

## Failure modes

**Genre/source mismatch (new hole).** Today mismatch is impossible — `sourceContext.ts:39` checks
the literal `genre === "session-heatmap"` inside the `source.kind === "session"` branch. Once the
Composer offers a list, a caller can post `{source:{kind:"session"}, genre:"skill-tuner"}` and
`extractSource` would ignore the genre and seed a replay. Fix: assert
`genreFor(genre).sourceKind === source.kind` and throw a named error. `GenreSpec.sourceKind` already
exists and is currently unused for validation.

**Unregistered genre.** `genreFor()` and `scaffoldFor()` throw on unknown ids. `GENRES`, `SCAFFOLDS`
and the `sourceContext` branch are runtime-only, so a half-wired genre throws at seed time for a real
user. Covered by the `genres.test.ts` extension below.

**No host, or refused consent.** Both new templates call host tools and must survive their absence:
on app.agentgem.ai the handshake gives up after ~4s and every `callTool` rejects with `"no host"`.
`project-map` catches and keeps its baked file list; `skill-tuner` catches a `copy-command`
rejection (`-32001`) and falls back to a selectable textarea.

**Retrofit regression.** `session-heatmap` declares `session-data`, a **content** capability, so
`assertPortable` fails Save unless `#game-data` carries a non-empty `timeline` array
(`portability.ts:41-48`). Restyling must not rename or drop that block.

**Shared-module blast radius.** A bad `houseStyle` edit breaks every template at once — the accepted
cost of the shared partial. Mitigated by per-scaffold gate tests failing together rather than
shipping.

## Files changed

| File | Change |
| --- | --- |
| `packages/model/src/houseStyle.ts` | **new** — tokens, `themeAdapter`, partials |
| `packages/model/src/index.ts` | add `export * from "./houseStyle.js";` to the barrel |
| `packages/model/src/types.ts` | `GAME_GENRES` += `project-map`, `skill-tuner` |
| `packages/play/src/scaffolds.ts` | new `projectMapScaffold()`, `skillTunerScaffold()`; `heatmapScaffold()` onto `houseStyle`; register in `SCAFFOLDS` |
| `packages/play/src/genres.ts` | two `GENRES` entries |
| `packages/play/src/sourceContext.ts` | generalize genre branches; `sourceKind` assertion |
| `packages/play/src/portability.ts` | no change — both new caps already classified |
| `packages/console/src/panels/Play/parseTags.ts` | `GENRE_TAGS` += two |
| `packages/console/src/panels/Play/Composer.tsx` | template picker replaces the `sessionGenre` fork |

## Testing

Play tests live in **`src/play/__tests__/`** (repo root), not `packages/play/src/__tests__/`; vitest
runs the compiled `dist/`, so rebuild before running.

- **`src/play/__tests__/genres.test.ts`** — extend: every `GameGenre` resolves to a `GENRES` entry
  **and** a non-throwing `scaffoldFor()`. Converts the three unenforced touchpoints into a build
  failure. (It currently asserts `sourceKind` per genre one line at a time — the new assertion should
  iterate `GAME_GENRES` so it cannot go stale.)
- **`src/play/__tests__/gameGate.static.test.ts`** — add both new scaffolds and the retrofitted
  heatmap. This backs the invariant that a scaffold is gate-passing *before* the Studio agent touches
  it.
- **new — `sourceContext` mismatch** — seeding a session source with `skill-tuner` throws a named error.
- **new — portability** — the retrofitted `session-heatmap` scaffold still yields a non-empty baked
  `timeline` through `assertPortable`.
- **new — `houseStyle`** — each `themeAdapter` mode emits the full token set, so a token added to one
  binding and forgotten in another fails rather than rendering `unset`.

Not tested: visual output (jsdom asserts behavior, never appearance — per CLAUDE.md; use the
`verify` skill in a real browser) and the Studio agent's edits (non-deterministic).

**CI caveat.** `packages/console` vitest and typecheck are not in CI (per CLAUDE.md), so the
Composer picker's exhaustiveness guard must be verified locally before merge — the compile error only
fires where the console actually builds.

## Deferred (slice 2)

- `REPORT_BUILDER_BRIEF` and `dashboardRender`'s prompt embed `houseStyle` with the `document` and
  `fixed` adapters, replacing prose descriptions of the same CSS.
- Retrofitted report exemplars (html-effectiveness `11`/`12`) rebuilt around the `#report-data`
  anti-hallucination seam. **Not shippable unretrofitted** — those files bake numbers into prose,
  which is precisely what `REPORT_BUILDER_BRIEF` forbids, and a few-shot exemplar teaches by
  imitation.
- Blank `docTemplate` — a second Blank starting point (`blankStudio` hardcodes the canvas
  `minimalTemplate` at `studio.ts:138`), plus the paired `MINIAPP_BUILDER_BRIEF` edit branching its
  full-window layout rule (`builderBrief.ts:172`) on canvas-app vs document-app, and the
  byte-identical `skills/agentgem-miniapp/SKILL.md` mirror the drift test requires.

## Out of scope

- Restyling the three game genres (`replay`, `skill-run`, `project-fun`).
- Any change to `gameGate`, the seal, or the capability broker.
- Importing html-effectiveness HTML verbatim. The files are MIT-licensed and may be adapted; any
  copied code carries its attribution. Templates here are written against `houseStyle`, using those
  files as the design reference, not as a vendored dependency.
