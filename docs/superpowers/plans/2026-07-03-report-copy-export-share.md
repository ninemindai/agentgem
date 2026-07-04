# Report Copy / Export / Share Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give AgentGem's Insights and Analyze reports a consistent Copy / Export (.md, .json, PDF) / Share action row, all client-side.

**Architecture:** A pure serializer turns each report into a shared `ReportBlock[]` intermediate (layout defined once), rendered to markdown (Copy, `.md`) and to a self-contained print-HTML doc (PDF via a hidden print iframe). A presentational `ReportActions` component wires those strings to clipboard / download / `navigator.share`. Two panels (`InsightsReportCard`, `Analyze`) consume it.

**Tech Stack:** React 18 + TypeScript, Vitest + jsdom + @testing-library/react (colocated `*.test.tsx`), existing console CSS classes.

## Global Constraints

- **Local-only.** No server changes, no hosted `/share/:id` card, no new npm dependency.
- **No new UI primitives.** Match the codebase convention: raw `<button type="button">`, reuse the existing `ledger-view` button class, local `useState` + `setTimeout(…, 1600)` for "copied" feedback. There is no shared Button/Toast.
- **PDF = print-to-PDF** via a hidden iframe + `print()`. Not jsPDF.
- **Share button renders only when `navigator.share` is a function.** No dead buttons; no per-report URL (text hand-off only).
- **Markdown is the clipboard/`.md` format; `.json` is `JSON.stringify(raw, null, 2)`** of the raw report object (not the blocks).
- Empty sections (0 sessions / empty friction / empty candidates) are **omitted**, never rendered as an empty heading.
- Tests are **not** in this repo's CI; run `pnpm test` and `pnpm typecheck` in `packages/console` locally before finishing.
- Commit author is the repo default (Raymond Feng). End each commit message with the `Co-Authored-By: Claude` trailer.

## File Structure

- Create `packages/console/src/report/serialize.ts` — `ReportBlock` type, `insightsToBlocks`, `analyzeToBlocks`, `blocksToMarkdown`, `blocksToHtml`. Pure, no React/DOM.
- Create `packages/console/src/report/serialize.test.ts` — unit tests for the above.
- Create `packages/console/src/report/ReportActions.tsx` — the action-row component + local `downloadBlob` / `printHtml` helpers.
- Create `packages/console/src/report/ReportActions.test.tsx` — render + copy tests.
- Modify `packages/console/src/panels/Insights/index.tsx` — render `<ReportActions>` in `InsightsReportCard`.
- Modify `packages/console/src/panels/Curate/Analyze.tsx` — render `<ReportActions>` above the candidates list.
- Modify `packages/console/src/shell/theme.css` — add `.report-actions` layout class.

All commands below run from `packages/console/` unless noted.

---

### Task 1: Block intermediate + markdown/HTML renderers

**Files:**
- Create: `packages/console/src/report/serialize.ts`
- Test: `packages/console/src/report/serialize.test.ts`

**Interfaces:**
- Produces:
  - `type ReportBlock = { kind: "heading"; text: string } | { kind: "para"; text: string } | { kind: "table"; head: string[]; rows: string[][] } | { kind: "list"; items: string[] }`
  - `blocksToMarkdown(blocks: ReportBlock[]): string`
  - `blocksToHtml(blocks: ReportBlock[], title: string): string`

- [ ] **Step 1: Write the failing test**

Create `packages/console/src/report/serialize.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { blocksToMarkdown, blocksToHtml, type ReportBlock } from "./serialize.js";

const sample: ReportBlock[] = [
  { kind: "para", text: "A summary." },
  { kind: "heading", text: "By model" },
  { kind: "table", head: ["model", "n"], rows: [["opus", "3"], ["a|b", "1"]] },
  { kind: "list", items: ["one", "two"] },
];

describe("blocksToMarkdown", () => {
  it("renders headings, paras, tables (pipe-escaped) and lists", () => {
    const md = blocksToMarkdown(sample);
    expect(md).toContain("A summary.");
    expect(md).toContain("## By model");
    expect(md).toContain("| model | n |");
    expect(md).toContain("| --- | --- |");
    expect(md).toContain("| opus | 3 |");
    expect(md).toContain("| a\\|b | 1 |"); // pipe escaped so the table stays valid
    expect(md).toContain("- one");
    expect(md).toContain("- two");
  });
});

describe("blocksToHtml", () => {
  it("emits a self-contained doc with the title, print CSS and a table", () => {
    const html = blocksToHtml(sample, "My Report");
    expect(html.startsWith("<!doctype html>")).toBe(true);
    expect(html).toContain("<title>My Report</title>");
    expect(html).toContain("<h1>My Report</h1>");
    expect(html).toContain("@page");
    expect(html).toContain("<table>");
    expect(html).toContain("<th>model</th>");
  });

  it("escapes HTML in cell/para text", () => {
    const html = blocksToHtml([{ kind: "para", text: "<script>x</script>" }], "T");
    expect(html).toContain("&lt;script&gt;");
    expect(html).not.toContain("<script>x");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test -- serialize`
Expected: FAIL — cannot resolve `./serialize.js` / exports not defined.

- [ ] **Step 3: Write minimal implementation**

Create `packages/console/src/report/serialize.ts`:

```ts
// Pure report → text serialization. A small block intermediate is defined once
// per report (insightsToBlocks / analyzeToBlocks) and rendered to two targets so
// the markdown and print-HTML layouts cannot drift apart.

export type ReportBlock =
  | { kind: "heading"; text: string }
  | { kind: "para"; text: string }
  | { kind: "table"; head: string[]; rows: string[][] }
  | { kind: "list"; items: string[] };

export function blocksToMarkdown(blocks: ReportBlock[]): string {
  const esc = (s: string) => s.replace(/\|/g, "\\|"); // keep table cells valid
  const out: string[] = [];
  for (const b of blocks) {
    if (b.kind === "heading") out.push(`## ${b.text}`);
    else if (b.kind === "para") out.push(b.text);
    else if (b.kind === "list") out.push(b.items.map((i) => `- ${i}`).join("\n"));
    else {
      out.push(
        `| ${b.head.map(esc).join(" | ")} |`,
        `| ${b.head.map(() => "---").join(" | ")} |`,
        ...b.rows.map((r) => `| ${r.map(esc).join(" | ")} |`),
      );
    }
  }
  return out.join("\n\n") + "\n";
}

const escapeHtml = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

export function blocksToHtml(blocks: ReportBlock[], title: string): string {
  const body = blocks
    .map((b) => {
      if (b.kind === "heading") return `<h2>${escapeHtml(b.text)}</h2>`;
      if (b.kind === "para") return `<p>${escapeHtml(b.text)}</p>`;
      if (b.kind === "list") return `<ul>${b.items.map((i) => `<li>${escapeHtml(i)}</li>`).join("")}</ul>`;
      const head = `<tr>${b.head.map((h) => `<th>${escapeHtml(h)}</th>`).join("")}</tr>`;
      const rows = b.rows.map((r) => `<tr>${r.map((c) => `<td>${escapeHtml(c)}</td>`).join("")}</tr>`).join("");
      return `<table><thead>${head}</thead><tbody>${rows}</tbody></table>`;
    })
    .join("\n");
  return `<!doctype html><html><head><meta charset="utf-8"><title>${escapeHtml(title)}</title><style>
@page { margin: 2cm; }
body { font: 14px/1.5 -apple-system, system-ui, sans-serif; color: #111; max-width: 46rem; margin: 0 auto; padding: 1rem; }
h1 { font-size: 1.5rem; } h2 { font-size: 1.1rem; margin-top: 1.4em; }
table { border-collapse: collapse; width: 100%; margin: 0.5em 0; }
th, td { border: 1px solid #ccc; padding: 4px 8px; text-align: left; vertical-align: top; }
th { background: #f4f4f4; }
ul { padding-left: 1.2em; }
</style></head><body><h1>${escapeHtml(title)}</h1>${body}</body></html>`;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test -- serialize`
Expected: PASS (both describe blocks).

- [ ] **Step 5: Commit**

```bash
git add packages/console/src/report/serialize.ts packages/console/src/report/serialize.test.ts
git commit -m "feat(report): block intermediate + markdown/HTML renderers

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: Report-specific serializers (insights + analyze)

**Files:**
- Modify: `packages/console/src/report/serialize.ts`
- Test: `packages/console/src/report/serialize.test.ts`

**Interfaces:**
- Consumes: `ReportBlock` (Task 1); `InsightsReportView` from `../panels/Insights/insightsStream.js`; `AnalyzeCandidate` from `../panels/Curate/analyzeStream.js`.
- Produces:
  - `insightsToBlocks(report: InsightsReportView, scanned?: number | null): ReportBlock[]`
  - `analyzeToBlocks(candidates: AnalyzeCandidate[]): ReportBlock[]`

- [ ] **Step 1: Write the failing test**

Append to `packages/console/src/report/serialize.test.ts`:

```ts
import { insightsToBlocks, analyzeToBlocks } from "./serialize.js";
import type { InsightsReportView } from "../panels/Insights/insightsStream.js";
import type { AnalyzeCandidate } from "../panels/Curate/analyzeStream.js";

const fullReport: InsightsReportView = {
  totals: { sessions: 5, mostly: 3, partially: 1, not: 1 },
  outcomes_summary: "Mostly good.",
  narrative: "You worked on auth and billing.",
  by_model: [
    { model: "opus", mostly: 2, partially: 0, not: 0, total: 2 },
    { model: "sonnet", mostly: 1, partially: 1, not: 1, total: 3 },
  ],
  friction: [{ sessionId: "s1", detail: "retry storm on tests" }],
  publish_candidates: [{ sessionId: "s2", goal: "add JWT auth", why: "clean, reusable" }],
};

describe("insightsToBlocks", () => {
  it("includes narrative, summary, totals, by-model, candidates and friction", () => {
    const blocks = insightsToBlocks(fullReport, 12);
    const md = blocksToMarkdown(blocks);
    expect(md).toContain("You worked on auth and billing.");
    expect(md).toContain("Mostly good.");
    expect(md).toContain("5 sessions judged");
    expect(md).toContain("most-recent 5 of 12 scanned");
    expect(md).toContain("## By model");
    expect(md).toContain("| opus | 2 | 0 | 0 | 2 |");
    expect(md).toContain("## Worth publishing");
    expect(md).toContain("add JWT auth");
    expect(md).toContain("## Friction");
    expect(md).toContain("- retry storm on tests");
  });

  it("omits empty sections and the by-model table when only one model", () => {
    const bare: InsightsReportView = {
      totals: { sessions: 1, mostly: 1, partially: 0, not: 0 },
      outcomes_summary: "",
      narrative: "",
      by_model: [{ model: "opus", mostly: 1, partially: 0, not: 0, total: 1 }],
      friction: [],
      publish_candidates: [],
    };
    const md = blocksToMarkdown(insightsToBlocks(bare));
    expect(md).not.toContain("## By model");
    expect(md).not.toContain("## Worth publishing");
    expect(md).not.toContain("## Friction");
    expect(md).not.toContain("scanned"); // no cap note when scanned is undefined
  });
});

describe("analyzeToBlocks", () => {
  it("renders one section per candidate with meta, description and artifacts", () => {
    const candidates: AnalyzeCandidate[] = [
      { name: "test-runner", description: "runs the suite", confidence: "high", include: [{ type: "skill", name: "vitest" }, { type: "hook", name: "pre-push" }] },
    ];
    const md = blocksToMarkdown(analyzeToBlocks(candidates));
    expect(md).toContain("## test-runner");
    expect(md).toContain("Confidence: high · 2 artifacts");
    expect(md).toContain("runs the suite");
    expect(md).toContain("- skill: vitest");
    expect(md).toContain("- hook: pre-push");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test -- serialize`
Expected: FAIL — `insightsToBlocks` / `analyzeToBlocks` not exported.

- [ ] **Step 3: Write minimal implementation**

Append to `packages/console/src/report/serialize.ts`:

```ts
import type { InsightsReportView } from "../panels/Insights/insightsStream.js";
import type { AnalyzeCandidate } from "../panels/Curate/analyzeStream.js";

export function insightsToBlocks(report: InsightsReportView, scanned?: number | null): ReportBlock[] {
  const blocks: ReportBlock[] = [];
  const t = report.totals;
  if (report.narrative) blocks.push({ kind: "para", text: report.narrative });
  if (report.outcomes_summary) blocks.push({ kind: "para", text: report.outcomes_summary });

  const capped = scanned != null && scanned > t.sessions;
  blocks.push({
    kind: "para",
    text:
      `${t.sessions} session${t.sessions === 1 ? "" : "s"} judged — ` +
      `${t.mostly} mostly, ${t.partially} partially, ${t.not} not.` +
      (capped ? ` (most-recent ${t.sessions} of ${scanned} scanned)` : ""),
  });

  const byModel = report.by_model ?? [];
  if (byModel.length > 1) {
    blocks.push({ kind: "heading", text: "By model" });
    blocks.push({
      kind: "table",
      head: ["model", "mostly", "partially", "not", "sessions"],
      rows: byModel.map((m) => [m.model, String(m.mostly), String(m.partially), String(m.not), String(m.total)]),
    });
  }

  const candidates = report.publish_candidates ?? [];
  if (candidates.length > 0) {
    blocks.push({ kind: "heading", text: "Worth publishing" });
    blocks.push({ kind: "table", head: ["goal", "why"], rows: candidates.map((c) => [c.goal, c.why]) });
  }

  const friction = report.friction ?? [];
  if (friction.length > 0) {
    blocks.push({ kind: "heading", text: "Friction" });
    blocks.push({ kind: "list", items: friction.map((f) => f.detail) });
  }

  return blocks;
}

export function analyzeToBlocks(candidates: AnalyzeCandidate[]): ReportBlock[] {
  const blocks: ReportBlock[] = [];
  for (const c of candidates) {
    blocks.push({ kind: "heading", text: c.name });
    blocks.push({
      kind: "para",
      text: `Confidence: ${c.confidence} · ${c.include.length} artifact${c.include.length === 1 ? "" : "s"}`,
    });
    if (c.description) blocks.push({ kind: "para", text: c.description });
    if (c.include.length > 0) {
      blocks.push({ kind: "list", items: c.include.map((a) => `${a.type}: ${a.name}`) });
    }
  }
  return blocks;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test -- serialize`
Expected: PASS (all serialize describe blocks).

- [ ] **Step 5: Commit**

```bash
git add packages/console/src/report/serialize.ts packages/console/src/report/serialize.test.ts
git commit -m "feat(report): insights + analyze block serializers

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 3: ReportActions component

**Files:**
- Create: `packages/console/src/report/ReportActions.tsx`
- Test: `packages/console/src/report/ReportActions.test.tsx`

**Interfaces:**
- Produces: `ReportActions({ title, filename, markdown, json, html }: { title: string; filename: string; markdown: string; json: string; html: string })` — a React component.

- [ ] **Step 1: Write the failing test**

Create `packages/console/src/report/ReportActions.test.tsx`:

```tsx
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor, cleanup } from "@testing-library/react";
import { ReportActions } from "./ReportActions.js";

afterEach(() => {
  cleanup();
  // @ts-expect-error test cleanup
  delete (navigator as any).share;
});

const props = { title: "T", filename: "f", markdown: "MD-BODY", json: "{}", html: "<html></html>" };

describe("ReportActions", () => {
  it("renders copy/export buttons and hides Share when navigator.share is absent", () => {
    render(<ReportActions {...props} />);
    expect(screen.getByText("Copy")).toBeTruthy();
    expect(screen.getByText(".md")).toBeTruthy();
    expect(screen.getByText(".json")).toBeTruthy();
    expect(screen.getByText("PDF")).toBeTruthy();
    expect(screen.queryByText("Share")).toBeNull();
  });

  it("shows Share when navigator.share exists", () => {
    Object.defineProperty(navigator, "share", { value: vi.fn(), configurable: true });
    render(<ReportActions {...props} />);
    expect(screen.getByText("Share")).toBeTruthy();
  });

  it("copies the markdown and flips the label to ✓ Copied", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    render(<ReportActions {...props} />);
    fireEvent.click(screen.getByText("Copy"));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith("MD-BODY"));
    await screen.findByText("✓ Copied");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test -- ReportActions`
Expected: FAIL — cannot resolve `./ReportActions.js`.

- [ ] **Step 3: Write minimal implementation**

Create `packages/console/src/report/ReportActions.tsx`:

```tsx
import { useState } from "react";

// Local copies of the download primitive so this shared component does not import
// from a sibling panel dir (Materialize/exporters.ts has an equivalent). Small,
// deliberate duplication; a later pass may promote both to a shared lib/.
function downloadBlob(filename: string, type: string, data: string): void {
  const blob = new Blob([data], { type });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

// Print-to-PDF: render a self-contained doc in a hidden iframe and print it, so
// only the report prints (not the whole console) and no dependency is needed.
function printHtml(html: string): void {
  const iframe = document.createElement("iframe");
  Object.assign(iframe.style, { position: "fixed", right: "0", bottom: "0", width: "0", height: "0", border: "0" });
  iframe.onload = () => {
    iframe.contentWindow?.focus();
    iframe.contentWindow?.print();
    setTimeout(() => iframe.remove(), 1000);
  };
  document.body.appendChild(iframe);
  const doc = iframe.contentDocument;
  if (!doc) { iframe.remove(); return; }
  doc.open();
  doc.write(html);
  doc.close();
}

export function ReportActions({ title, filename, markdown, json, html }: {
  title: string; filename: string; markdown: string; json: string; html: string;
}) {
  const [copied, setCopied] = useState(false);
  const canShare = typeof navigator !== "undefined" && typeof navigator.share === "function";

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(markdown);
      setCopied(true);
      setTimeout(() => setCopied(false), 1600);
    } catch {
      /* clipboard blocked (insecure context / denied) — leave the label unchanged */
    }
  };
  const share = async () => {
    try { await navigator.share({ title, text: markdown }); }
    catch { /* user cancelled or unsupported — cancel is not an error */ }
  };

  return (
    <div className="report-actions">
      <button type="button" className="ledger-view" onClick={copy}>{copied ? "✓ Copied" : "Copy"}</button>
      <button type="button" className="ledger-view" onClick={() => downloadBlob(`${filename}.md`, "text/markdown", markdown)}>.md</button>
      <button type="button" className="ledger-view" onClick={() => downloadBlob(`${filename}.json`, "application/json", json)}>.json</button>
      <button type="button" className="ledger-view" onClick={() => printHtml(html)}>PDF</button>
      {canShare && <button type="button" className="ledger-view" onClick={share}>Share</button>}
    </div>
  );
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test -- ReportActions`
Expected: PASS (3 tests). Note: `printHtml` and downloads are exercised in the app, not asserted here (jsdom does not implement `print()`).

- [ ] **Step 5: Commit**

```bash
git add packages/console/src/report/ReportActions.tsx packages/console/src/report/ReportActions.test.tsx
git commit -m "feat(report): ReportActions row (copy/.md/.json/PDF/share)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 4: Wire Insights + add layout CSS

**Files:**
- Modify: `packages/console/src/panels/Insights/index.tsx`
- Modify: `packages/console/src/shell/theme.css`

**Interfaces:**
- Consumes: `ReportActions` (Task 3); `insightsToBlocks`, `blocksToMarkdown`, `blocksToHtml` (Tasks 1–2).

- [ ] **Step 1: Add imports**

In `packages/console/src/panels/Insights/index.tsx`, change the React import (line 1) to add `useMemo`:

```ts
import { useEffect, useMemo, useRef, useState } from "react";
```

Add after the existing local imports (e.g. after line 10, the `timeAgo` import):

```ts
import { ReportActions } from "../../report/ReportActions.js";
import { insightsToBlocks, blocksToMarkdown, blocksToHtml } from "../../report/serialize.js";
```

- [ ] **Step 2: Build the serialized strings and render the row**

In `InsightsReportCard`, after the `friction` const (line 173) and before `return (`, add:

```ts
  const blocks = useMemo(() => insightsToBlocks(report, scanned), [report, scanned]);
  const markdown = useMemo(() => blocksToMarkdown(blocks), [blocks]);
  const html = useMemo(() => blocksToHtml(blocks, "AgentGem Insights"), [blocks]);
  const json = useMemo(() => JSON.stringify(report, null, 2), [report]);
```

Then insert the row as the first child of `<div className="insights-report">` (immediately after the opening tag on line 175):

```tsx
    <div className="insights-report">
      <ReportActions title="AgentGem Insights" filename="agentgem-insights" markdown={markdown} json={json} html={html} />
      {report.narrative && <p className="insights-narrative">{report.narrative}</p>}
```

- [ ] **Step 3: Add the layout class**

Append to `packages/console/src/shell/theme.css`:

```css
.report-actions {
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
  margin-bottom: 12px;
}
```

- [ ] **Step 4: Typecheck and run the Insights test**

Run: `pnpm typecheck`
Expected: no errors.

Run: `pnpm test -- Insights`
Expected: PASS — the existing `InsightsReportCard.test.tsx` still passes (the row is additive; if that test queries by button/section text, confirm it does not assert exact child order).

- [ ] **Step 5: Commit**

```bash
git add packages/console/src/panels/Insights/index.tsx packages/console/src/shell/theme.css
git commit -m "feat(report): copy/export/share row on Insights report

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 5: Wire Analyze

**Files:**
- Modify: `packages/console/src/panels/Curate/Analyze.tsx`

**Interfaces:**
- Consumes: `ReportActions` (Task 3); `analyzeToBlocks`, `blocksToMarkdown`, `blocksToHtml` (Tasks 1–2).

- [ ] **Step 1: Add imports**

In `packages/console/src/panels/Curate/Analyze.tsx`, add after the existing imports (after line 5, the `Loading` import):

```ts
import { ReportActions } from "../../report/ReportActions.js";
import { analyzeToBlocks, blocksToMarkdown, blocksToHtml } from "../../report/serialize.js";
```

- [ ] **Step 2: Compute blocks in the row body and render the row above the candidate list**

Inside `rows.map((r) => {`, after `const active = activePath === r.path;` (line 81), add:

```ts
              const analyzeBlocks = analyzeToBlocks(candidates);
              const analyzeTitle = `AgentGem analysis — ${r.label}`;
```

Then, inside the `active &&` block, immediately before `{candidates.map((c) => (` (line 106), insert:

```tsx
                      {candidates.length > 0 && (
                        <ReportActions
                          title={analyzeTitle}
                          filename="agentgem-analyze"
                          markdown={blocksToMarkdown(analyzeBlocks)}
                          json={JSON.stringify(candidates, null, 2)}
                          html={blocksToHtml(analyzeBlocks, analyzeTitle)}
                        />
                      )}
```

- [ ] **Step 3: Typecheck and run the Curate tests**

Run: `pnpm typecheck`
Expected: no errors.

Run: `pnpm test -- Curate Analyze`
Expected: PASS (no regressions; the row only appears when `candidates.length > 0`).

- [ ] **Step 4: Commit**

```bash
git add packages/console/src/panels/Curate/Analyze.tsx
git commit -m "feat(report): copy/export/share row on Analyze candidates

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 6: Full verification

**Files:** none (verification only).

- [ ] **Step 1: Full console test suite**

Run: `pnpm test`
Expected: PASS — all console tests green, including the new `report/` tests.

- [ ] **Step 2: Typecheck the whole console package**

Run: `pnpm typecheck`
Expected: no errors.

- [ ] **Step 3: Manual smoke (drive the app)**

Build/run the console, open Insights, generate a report, and confirm: Copy flips to "✓ Copied" and the clipboard holds markdown; `.md` and `.json` download; PDF opens the print dialog showing only the report; Share appears only on a `navigator.share`-capable browser. Repeat on Analyze after analyzing a project with at least one candidate.

- [ ] **Step 4: Final commit (only if the smoke pass required a fix)**

```bash
git add -A
git commit -m "fix(report): smoke-test adjustments

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Self-Review

**Spec coverage:**
- Local-only, no server/dep → Global Constraints; Tasks add only client files. ✓
- Copy (markdown) → Task 3 `copy` + Tasks 1–2 markdown. ✓
- Export `.md` / `.json` → Task 3 download buttons; `.json` from raw object. ✓
- PDF (print-to-PDF, no dep) → Task 3 `printHtml` + Task 1 `blocksToHtml`. ✓
- Share (conditional native) → Task 3 `canShare` gate. ✓
- `ReportBlock` intermediate feeding md + html → Tasks 1–2. ✓
- Empty sections omitted → Task 2 conditionals + test. ✓
- Two consumers (Insights, Analyze) → Tasks 4–5. ✓
- Reuse `ledger-view`, no new primitive; one CSS class → Task 3 classNames + Task 4 CSS. ✓
- Serializers unit-tested; ReportActions render-tested; run console tests locally → Tasks 1–3, 6. ✓
- Out of scope (hosted card, jsPDF, other surfaces) → not present in any task. ✓

**Placeholder scan:** No TBD/TODO; every code step shows full code; every command has expected output. ✓

**Type consistency:** `ReportBlock`, `insightsToBlocks(report, scanned)`, `analyzeToBlocks(candidates)`, `blocksToMarkdown(blocks)`, `blocksToHtml(blocks, title)`, and `ReportActions({title,filename,markdown,json,html})` are used identically across Tasks 1–5. `InsightsReportView` / `AnalyzeCandidate` import paths match the read source files. ✓
