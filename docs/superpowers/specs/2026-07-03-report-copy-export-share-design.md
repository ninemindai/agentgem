# Report copy / export / share — design

**Date:** 2026-07-03
**Branch:** `feat/report-copy-export`
**Status:** approved, ready for implementation plan

## Goal

Give AgentGem's generated **reports** a consistent affordance to **copy**, **export**, and **share** their contents. First pass wires two report surfaces:

- **Insights** — `InsightsReportCard` in `packages/console/src/panels/Insights/index.tsx`
- **Analyze** — `packages/console/src/panels/Curate/Analyze.tsx`

Success criterion: on both surfaces a user can (1) copy the report as markdown to the clipboard, (2) download it as `.md`, `.json`, or PDF, and (3) hand it to the OS share sheet where the platform supports it — with the report→text layout defined once and unit-tested.

## Scope decisions (settled during brainstorming)

- **Local-only.** No hosted `/share/:id` card, no server changes, no deploy gate. Insights reports contain private session detail (goals, friction, narrative distilled from local sessions); publishing them to a public hosted card is deliberately out of scope.
- **"Share" = native OS share sheet** via `navigator.share({ title, text })`, handing off the markdown text. There is no per-report URL, so social-intent links (which need a URL) do **not** apply. The Share button is rendered **only when `navigator.share` exists** — no dead buttons.
- **PDF = print-to-PDF, zero dependencies.** Build a clean self-contained HTML render in a hidden iframe and call `print()`; the user chooses "Save as PDF" in the OS dialog. Explicitly *not* jsPDF (avoids a ~350KB dependency and manual PDF layout).
- **Markdown is the clipboard format** (pastes cleanly into a PR/issue/doc). `.json` export is the raw report object (precedent: Materialize already offers Copy/Download JSON).
- **Two surfaces only.** The primitive is built to extend to Benchmark / Observe / Journey later, but those are not wired in this pass.

## Architecture

One reusable primitive plus a shared serializer, consumed by two panels. Every layout/serialization unit is a pure function.

### New module: `packages/console/src/report/`

#### `serialize.ts` — pure report → text

A small block intermediate is defined once and rendered to two targets (markdown for Copy/`.md`, HTML for print-to-PDF), so the two layouts cannot drift apart.

```ts
export type ReportBlock =
  | { kind: 'heading'; text: string }
  | { kind: 'para'; text: string }
  | { kind: 'table'; head: string[]; rows: string[][] }
  | { kind: 'list'; items: string[] };

// Layout defined ONCE per report:
export function insightsToBlocks(report: InsightsReportView, scanned: number): ReportBlock[];
export function analyzeToBlocks(/* Analyze's report shape */): ReportBlock[];

// Renderers (shared across both reports):
export function blocksToMarkdown(blocks: ReportBlock[]): string;
export function blocksToHtml(blocks: ReportBlock[], title: string): string; // full self-contained <html> doc with print CSS
```

- `blocksToHtml` emits a complete standalone document: `<!doctype html>` + inline `<style>` (including `@page` / `@media print`) + the rendered blocks. It is written into the print iframe verbatim; it does not depend on the console's stylesheet.
- Charts (donut / by-model bars) are **not** carried into any export — the by-model numbers appear as a `table` block, the outcomes totals as a `para`/`table`. Charts are decorative; both the markdown and PDF are text/table.
- `.json` export does **not** use blocks — it is `JSON.stringify(report, null, 2)` of the raw report object.

Empty-ish handling: sections with no data (0 sessions, empty friction, empty publish candidates) are **omitted entirely** rather than rendering an empty heading.

#### `ReportActions.tsx` — the action row (presentational + browser-API glue)

```ts
interface ReportActionsProps {
  title: string;      // e.g. "AgentGem Insights" — share sheet title + PDF doc <title>
  filename: string;   // e.g. "agentgem-insights" — base name for downloads
  markdown: string;   // for Copy + .md
  json: string;       // for .json
  html: string;       // for print-to-PDF
}
```

Renders raw `<button>` elements (matching the codebase convention — there is no shared Button/Toast primitive) in a `.report-actions` row:

- **Copy** → `navigator.clipboard.writeText(markdown)`, flips label to `✓ Copied` for ~1.6s (the established local-`useState` + `setTimeout` micro-pattern used by `ShareLinks`, `Discover`'s `CopyCmd`, and Materialize's ticket copy).
- **.md** → download `${filename}.md` (`text/markdown`).
- **.json** → download `${filename}.json` (`application/json`).
- **PDF** → open a hidden iframe, write `html`, call `contentWindow.print()`, remove the iframe after printing.
- **Share** → `navigator.share({ title, text: markdown })`. Rendered only when `typeof navigator !== 'undefined' && navigator.share`.

Low-level `copyText` / `downloadBlob` helpers already exist in `Materialize/exporters.ts`, but that is a panel directory. To avoid a panel-importing-another-panel coupling, `ReportActions.tsx` defines its own ~10 lines of `copyText` / `downloadBlob` locally and leaves Materialize untouched. This is a deliberate, minor duplication (cheaper than the wrong coupling); a follow-up may promote both call sites to a shared `lib/`. **We do not refactor Materialize in this pass.**

### Consumers

- **Insights** — in `InsightsReportCard`, add a report-level header row inside `.insights-report` rendering `<ReportActions>` with `markdown = useMemo(() => blocksToMarkdown(insightsToBlocks(report, scanned)), [report, scanned])` (and likewise `html`, `json`). This is distinct from the existing section-level `Build a Gem` / `Contribute` buttons, which stay where they are.
- **Analyze** — same header-row treatment at the top of `<section className="analyze">`.

### Styling

One new `.report-actions` class in `packages/console/src/shell/theme.css`, reusing existing button visuals (e.g. the `ledger-view` look) so the row reads as native. No design-system work.

## Data flow

```
report data (already in memory)
  → insightsToBlocks / analyzeToBlocks   (pure)
      → blocksToMarkdown → markdown ──► Copy, .md download, Share text
      → blocksToHtml     → html     ──► print iframe → OS "Save as PDF"
  → JSON.stringify(report)          ──► .json download
```

## Error handling

- `navigator.clipboard.writeText` can reject (permissions / insecure context): catch and leave the button label unchanged (no crash, no false `✓ Copied`).
- `navigator.share` can reject on user-cancel: swallow the rejection (cancel is not an error).
- Print iframe: append to `document.body`, write doc, call `print()` inside `onload`; remove the iframe on a short timeout after `print()` returns. If iframe creation throws, no-op.
- Downloads use an object URL revoked after the click.

## Testing

- **Unit-test the pure serializers** (the real value, and runnable without a DOM):
  - `insightsToBlocks` / `analyzeToBlocks`: populated report → expected block structure.
  - `blocksToMarkdown`: block set → expected markdown (headings, table pipes, list bullets).
  - `blocksToHtml`: contains the title, a `<table>` for table blocks, print CSS; is a self-contained doc.
  - Edge cases: 0 sessions / empty friction / empty candidates → those sections omitted (no empty headings).
- **Light render test** for `ReportActions`: buttons present; Share hidden when `navigator.share` is undefined; Copy calls `navigator.clipboard.writeText` with the markdown.
- Console tests are **not** in this repo's CI (`ci.yml` runs only root `pnpm test`), so `packages/console` vitest + typecheck are run **locally** before finishing.

## Out of scope (deferred)

- Hosted `/share/:id` insights card (would require extending the share discriminated union across `routes.ts`, `share.proxy.controller.ts`, `share.controller.ts`, `shareStore.ts`, and `website/edge/src/share.js`, plus an API redeploy).
- jsPDF / rasterized PDF, PNG export.
- Wiring Benchmark / Observe / Journey surfaces.
- Promoting `copyText` / `downloadBlob` to a shared `lib/` and de-duplicating Materialize.
