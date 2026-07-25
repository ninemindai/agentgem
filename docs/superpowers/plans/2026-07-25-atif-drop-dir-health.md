# ATIF drop-dir health panel — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn the ATIF import diagnostics from #538 (which today reach only a server log) into a Watch-tab debug panel that shows which dropped files failed and why.

**Architecture:** Three layers, each testable alone. A pure `groupDiagnostics` helper and an FS `scanAtifHealth` entry point in `@agentgem/insight` (both reusing the existing `scanAtifSessions`), a one-line `/api/watch/atif-health` Express route, and a self-contained `AtifHealth` console component rendered above "Active sessions" that renders nothing unless there are issues.

**Tech Stack:** TypeScript (ESM, `.js` import specifiers), React (console), Express (app), Vitest + @testing-library/react. Design spec: `docs/superpowers/specs/2026-07-25-atif-drop-dir-health-design.md`.

## Global Constraints

- **ESM import specifiers end in `.js`** even for `.ts`/`.tsx` sources (e.g. `./watchStream.js`). Match the surrounding files.
- **Privacy:** diagnostics and the health payload carry **no transcript content** and **no absolute paths** — file identity is reduced to `basename` at the grouping boundary. This is the #538 invariant; do not widen it.
- **Do not change `SourceSpec.scanSessions`** or any shared 7-source interface. All new code is ATIF-scoped.
- **Tests run against compiled `dist/`** at the repo root: run `pnpm build` (or `tsc -b`) before the root Vitest. The real-FS ATIF test is flaky under concurrency — run it as a single file, as the commands below do.
- **CSS:** this is the **console** package. New classes get matching rules in `packages/console/src/shell/theme.css`, reusing existing tokens (`--accent`, `--border`, `--ink`, `--surface`) and mirroring the sibling `.watch-attn-banner` (theme.css:2530). No new design tokens.
- **Console tests are not in CI** — run them locally (`cd packages/console && npx vitest run <file>`).
- **License header:** new `.ts` files in `packages/insight` and `packages/app` start with the two-line SPDX header used by their siblings (`// Copyright (c) 2026 NineMind, Inc.` / `// SPDX-License-Identifier: MIT`). Console `.tsx` files in this repo have no header — match the neighbours.

---

### Task 1: `groupDiagnostics` — pure grouping helper (insight)

Groups a flat `AtifDiagnostics` array by code into display-ready rows, reducing paths to basenames. Pure — no FS.

**Files:**
- Modify: `packages/insight/src/atif/atifDiagnostics.ts` (append; consumes `isFileRejection`, `AtifDiagnosticCode`, `AtifDiagnostics` already defined there)
- Test: `src/__tests__/atif.test.ts` (append a `describe`)

**Interfaces:**
- Consumes (already exported in the same file): `isFileRejection(code: AtifDiagnosticCode): boolean`, types `AtifDiagnostic` (`{ code; path; stepId?; count?; schemaVersion? }`), `AtifDiagnostics = AtifDiagnostic[]`.
- Produces:
  - `interface AtifHealthFile { name: string; detail?: string }`
  - `interface AtifHealthGroup { code: AtifDiagnosticCode; rejection: boolean; occurrences: number; files: AtifHealthFile[] }`
  - `function groupDiagnostics(diags: AtifDiagnostics): AtifHealthGroup[]`

- [ ] **Step 1: Write the failing test**

Append to `src/__tests__/atif.test.ts`. Add `groupDiagnostics` to the existing `@agentgem/insight` import at the top of the file.

```ts
describe("groupDiagnostics", () => {
  it("groups by code, reduces paths to basenames, sums occurrences, and orders rejections first", () => {
    const groups = groupDiagnostics([
      { code: "orphan_tool_result", path: "/drop/partial.json", stepId: 2, count: 40 },
      { code: "unknown_schema_version", path: "/drop/conv-1.json", schemaVersion: "trajectory-v1" },
      { code: "unknown_schema_version", path: "/drop/conv-2.json" },
    ]);
    // rejections (unknown_schema_version) come before degradations (orphan_tool_result)
    expect(groups.map((g) => g.code)).toEqual(["unknown_schema_version", "orphan_tool_result"]);

    const rej = groups[0];
    expect(rej.rejection).toBe(true);
    expect(rej.occurrences).toBe(2);                       // two diagnostics, no counts → 1 + 1
    expect(rej.files).toEqual([{ name: "conv-1.json" }, { name: "conv-2.json" }]); // basenames, no absolute paths

    const deg = groups[1];
    expect(deg.rejection).toBe(false);
    expect(deg.occurrences).toBe(40);                      // count honoured
    expect(deg.files).toEqual([{ name: "partial.json", detail: "step 2" }]);
  });

  it("collapses the same file+step but keeps distinct steps of one file", () => {
    const [g] = groupDiagnostics([
      { code: "orphan_tool_result", path: "/drop/a.json", stepId: 1 },
      { code: "orphan_tool_result", path: "/drop/a.json", stepId: 1 },
      { code: "orphan_tool_result", path: "/drop/a.json", stepId: 3 },
    ]);
    expect(g.files).toEqual([{ name: "a.json", detail: "step 1" }, { name: "a.json", detail: "step 3" }]);
    expect(g.occurrences).toBe(3);
  });

  it("returns an empty array for no diagnostics", () => {
    expect(groupDiagnostics([])).toEqual([]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /Users/rfeng/Projects/ninemind/agentgem-worktrees/atif-health && pnpm build && npx vitest run dist/__tests__/atif.test.js -t groupDiagnostics`
Expected: FAIL — `groupDiagnostics is not a function` (or a build error that the export is missing).

- [ ] **Step 3: Write minimal implementation**

Append to `packages/insight/src/atif/atifDiagnostics.ts`. Add `basename` to the imports (the file currently imports nothing from node; add the line below the existing header comment):

```ts
import { basename } from "node:path";
```

Then append:

```ts
export interface AtifHealthFile {
  /** basename only — never an absolute path (privacy: see #538). */
  name: string;
  /** e.g. "step 2" for step-scoped codes; absent for whole-file rejections. */
  detail?: string;
}

export interface AtifHealthGroup {
  code: AtifDiagnosticCode;
  /** isFileRejection(code): drives red (rejected) vs amber (degraded) in the UI. */
  rejection: boolean;
  /** Sum of per-diagnostic counts within this code. */
  occurrences: number;
  /** Distinct offending files, by basename (+ step detail). */
  files: AtifHealthFile[];
}

/**
 * Fold a flat diagnostics array into display-ready groups: one per code, paths
 * reduced to basenames, rejections ordered before degradations. Pure — the FS
 * scan that produces the input lives in ../sources/atif.ts.
 */
export function groupDiagnostics(diags: AtifDiagnostics): AtifHealthGroup[] {
  const byCode = new Map<AtifDiagnosticCode, AtifHealthGroup>();
  for (const d of diags) {
    let g = byCode.get(d.code);
    if (!g) { g = { code: d.code, rejection: isFileRejection(d.code), occurrences: 0, files: [] }; byCode.set(d.code, g); }
    g.occurrences += d.count ?? 1;
    const name = basename(d.path);
    const detail = typeof d.stepId === "number" ? `step ${d.stepId}` : undefined;
    if (!g.files.some((f) => f.name === name && f.detail === detail)) g.files.push({ name, detail });
  }
  // Rejections first (the file was dropped), then degradations. Number(true) - Number(false) = 1.
  return [...byCode.values()].sort((a, b) => Number(b.rejection) - Number(a.rejection));
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd /Users/rfeng/Projects/ninemind/agentgem-worktrees/atif-health && pnpm build && npx vitest run dist/__tests__/atif.test.js -t groupDiagnostics`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/insight/src/atif/atifDiagnostics.ts src/__tests__/atif.test.ts
git commit -m "feat(insight): groupDiagnostics folds ATIF diagnostics into display groups"
```

---

### Task 2: `scanAtifHealth` — FS entry point (insight)

Scans the drop dir and returns `{ totalFiles, imported, groups }`, reusing `scanAtifSessions`.

**Files:**
- Modify: `packages/insight/src/sources/atif.ts` (append; add `groupDiagnostics` + type imports from `../atif/atifDiagnostics.js`, add `SourceEnv` import from `../sources.js`)
- Test: `src/__tests__/atif.test.ts` (append a `describe`)

**Interfaces:**
- Consumes: `scanAtifSessions(files: string[]): Promise<{ stats: SessionStat[]; diagnostics: AtifDiagnostics }>` (same file), `atifSource.roots(env: SourceEnv): string[]` (same file), `listFiles(dir, suffix): string[]` (already imported from `../observeScan.js`), `groupDiagnostics` (Task 1), `SourceEnv` (`{ baseDir?: string; codexDir?: string }` from `../sources.js`).
- Produces:
  - `interface AtifHealth { totalFiles: number; imported: number; groups: AtifHealthGroup[] }`
  - `function scanAtifHealth(env?: SourceEnv): Promise<AtifHealth>`

- [ ] **Step 1: Write the failing test**

Append to `src/__tests__/atif.test.ts`. Add `scanAtifHealth` to the `@agentgem/insight` import. `MIN_DOC`, `mkdtempSync`, `writeFileSync`, `rmSync`, `join`, `tmpdir` are already imported at the top of this file.

```ts
describe("scanAtifHealth", () => {
  it("reports totals and grouped issues for a mixed drop dir, with no absolute paths", async () => {
    const dir = mkdtempSync(join(tmpdir(), "agentgem-atif-health-"));
    try {
      writeFileSync(join(dir, "good.json"), MIN_DOC);
      writeFileSync(join(dir, "junk.json"), "not a trajectory");
      writeFileSync(join(dir, "foreign.json"), JSON.stringify({ schema_version: "trajectory-v1", agent: { name: "x", version: "1" }, steps: [{}] }));

      const health = await scanAtifHealth({ baseDir: dir });
      expect(health.totalFiles).toBe(3);
      expect(health.imported).toBe(1);                       // only good.json parses
      expect(health.groups.map((g) => g.code).sort()).toEqual(["invalid_json", "unknown_schema_version"]);
      expect(health.groups.find((g) => g.code === "unknown_schema_version")!.files).toEqual([{ name: "foreign.json" }]);
      // privacy: the temp dir's absolute path must not appear anywhere in the payload
      expect(JSON.stringify(health)).not.toContain(dir);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it("returns empty groups for a clean drop dir", async () => {
    const dir = mkdtempSync(join(tmpdir(), "agentgem-atif-clean-"));
    try {
      writeFileSync(join(dir, "good.json"), MIN_DOC);
      const health = await scanAtifHealth({ baseDir: dir });
      expect(health).toMatchObject({ totalFiles: 1, imported: 1, groups: [] });
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /Users/rfeng/Projects/ninemind/agentgem-worktrees/atif-health && pnpm build && npx vitest run dist/__tests__/atif.test.js -t scanAtifHealth`
Expected: FAIL — `scanAtifHealth is not a function`.

- [ ] **Step 3: Write minimal implementation**

In `packages/insight/src/sources/atif.ts`, extend the import from `../atif/atifDiagnostics.js` to include the grouping helper and types (the file already imports `summarizeDiagnostics, type AtifDiagnostics` from there — add to that line):

```ts
import { summarizeDiagnostics, groupDiagnostics, type AtifDiagnostics, type AtifHealthGroup } from "../atif/atifDiagnostics.js";
```

Add a `SourceEnv` import from the sources barrel (near the top, beside the other insight imports):

```ts
import type { SourceEnv } from "../sources.js";
```

Then append at the end of the file:

```ts
export interface AtifHealth {
  /** *.json files present in the drop dir. */
  totalFiles: number;
  /** How many of them parsed into a session. */
  imported: number;
  /** Import problems, grouped by reason; empty when the drop dir is clean. */
  groups: AtifHealthGroup[];
}

/**
 * Scan the drop dir for a health snapshot: totals plus grouped diagnostics.
 * Resolves the root exactly as the source does and reuses scanAtifSessions, so
 * it sees the same files the telemetry scan sees. `env.baseDir` is the test
 * override for the drop dir (same as the source).
 */
export async function scanAtifHealth(env: SourceEnv = {}): Promise<AtifHealth> {
  const files = atifSource.roots(env).flatMap((r) => listFiles(r, ".json"));
  const { stats, diagnostics } = await scanAtifSessions(files);
  return { totalFiles: files.length, imported: stats.length, groups: groupDiagnostics(diagnostics) };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd /Users/rfeng/Projects/ninemind/agentgem-worktrees/atif-health && pnpm build && npx vitest run dist/__tests__/atif.test.js -t scanAtifHealth`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/insight/src/sources/atif.ts src/__tests__/atif.test.ts
git commit -m "feat(insight): scanAtifHealth reports drop-dir totals + grouped issues"
```

---

### Task 3: `/api/watch/atif-health` route (app)

One-line Express route delegating to `scanAtifHealth`. Verified by build/typecheck (Express routes are not unit-tested in this codebase; the route is exercised end-to-end by Task 4's browser verify).

**Files:**
- Modify: `packages/app/src/appCommon.ts` — add `scanAtifHealth` to the `@agentgem/insight` import (the block ending at the `openArtifactOutcomesStore, outcomeCredit } from "@agentgem/insight";` line ~40-41), and add the route beside `/api/watch/sessions` (~line 270).

**Interfaces:**
- Consumes: `scanAtifHealth(env?): Promise<AtifHealth>` (Task 2), `originGuard` (already in scope in this file).
- Produces: `GET /api/watch/atif-health` → the `AtifHealth` JSON shape.

- [ ] **Step 1: Add the import**

In the `@agentgem/insight` import block in `packages/app/src/appCommon.ts`, add `scanAtifHealth`:

```ts
import { buildGoldmineBrief, type GoldmineBriefInput,
  openArtifactOutcomesStore, outcomeCredit, scanAtifHealth } from "@agentgem/insight";
```

- [ ] **Step 2: Add the route**

Immediately after the `/api/watch/sessions` handler (the `res.json({ sessions: listActiveSessions() } as never));` line), add:

```ts
  // Watch ATIF health: which files in the ~/.agentgem/atif drop dir failed to
  // import, grouped by reason. Read-only, basenames only (no absolute paths, no
  // transcript content). Drives the Watch tab's drop-dir debug panel.
  server.expressApp.get("/api/watch/atif-health", originGuard, async (_req, res) =>
    res.json(await scanAtifHealth() as never));
```

- [ ] **Step 3: Build to verify it typechecks**

Run: `cd /Users/rfeng/Projects/ninemind/agentgem-worktrees/atif-health && pnpm build`
Expected: build succeeds with no TypeScript errors (the pre-existing `theme.css` `*`-in-comment warning is fine).

- [ ] **Step 4: Commit**

```bash
git add packages/app/src/appCommon.ts
git commit -m "feat(app): /api/watch/atif-health serves drop-dir import health"
```

---

### Task 4: `AtifHealth` console panel + wiring (console)

The debug panel: fetch the health payload, render nothing unless there are issues, else a collapsible red/amber summary with per-code groups. Plus the `fetchAtifHealth` data function, the render site in Watch, and the CSS.

**Files:**
- Modify: `packages/console/src/panels/Watch/watchStream.ts` — add `AtifHealth`/`AtifHealthGroup`/`AtifHealthFile` types + `fetchAtifHealth`.
- Create: `packages/console/src/panels/Watch/AtifHealth.tsx`
- Modify: `packages/console/src/panels/Watch/index.tsx` — render `<AtifHealth>` above "Active sessions", bump a refresh key on Refresh.
- Modify: `packages/console/src/shell/theme.css` — `.watch-atif-*` block.
- Create: `packages/console/src/panels/Watch/AtifHealth.test.tsx`

**Interfaces:**
- Consumes: `GET /api/watch/atif-health` (Task 3).
- Produces (from `watchStream.ts`): `interface AtifHealthFile { name: string; detail?: string }`, `interface AtifHealthGroup { code: string; rejection: boolean; occurrences: number; files: AtifHealthFile[] }`, `interface AtifHealth { totalFiles: number; imported: number; groups: AtifHealthGroup[] }`, `fetchAtifHealth(apiBase: string): Promise<AtifHealth>`. Component export `AtifHealth({ apiBase, refreshKey }: { apiBase: string; refreshKey?: number })`.

- [ ] **Step 1: Add the data function + types to `watchStream.ts`**

Append to `packages/console/src/panels/Watch/watchStream.ts` (types are defined locally, matching how `WatchSession` is declared in this file rather than imported from insight):

```ts
export interface AtifHealthFile { name: string; detail?: string }
export interface AtifHealthGroup { code: string; rejection: boolean; occurrences: number; files: AtifHealthFile[] }
export interface AtifHealth { totalFiles: number; imported: number; groups: AtifHealthGroup[] }

export async function fetchAtifHealth(apiBase: string): Promise<AtifHealth> {
  const r = await fetch(`${apiBase}/api/watch/atif-health`);
  if (!r.ok) throw new Error(`atif-health ${r.status}`);
  return (await r.json()) as AtifHealth;
}
```

- [ ] **Step 2: Write the failing component test**

Create `packages/console/src/panels/Watch/AtifHealth.test.tsx`:

```tsx
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import { AtifHealth } from "./AtifHealth.js";

afterEach(() => { cleanup(); vi.restoreAllMocks(); });

const res = (body: unknown) => ({ ok: true, status: 200, json: async () => body }) as unknown as Response;
const stub = (body: unknown) => { vi.stubGlobal("fetch", vi.fn(async () => res(body))); };

const flush = () => new Promise((r) => setTimeout(r, 0));

describe("AtifHealth", () => {
  it("renders nothing when there are no issues", async () => {
    stub({ totalFiles: 5, imported: 5, groups: [] });
    const { container } = render(<AtifHealth apiBase="" />);
    await flush();
    expect(container.textContent).toBe("");
  });

  it("shows a red rejection summary and expands to the group", async () => {
    stub({
      totalFiles: 20, imported: 3,
      groups: [
        { code: "unknown_schema_version", rejection: true, occurrences: 12, files: Array.from({ length: 12 }, (_, i) => ({ name: `conv-${i}.json` })) },
        { code: "orphan_tool_result", rejection: false, occurrences: 40, files: [{ name: "partial.json", detail: "step 2" }] },
      ],
    });
    render(<AtifHealth apiBase="" />);
    await flush();
    // headline: distinct problem files = 12 + 1 = 13
    expect(screen.getByText(/3\/20 imported · 13 with issues/)).toBeTruthy();
    const root = screen.getByText(/3\/20 imported/).closest(".watch-atif")!;
    expect(root.className).toContain("is-rejection");

    // collapsed: group codes not shown yet
    expect(screen.queryByText(/unknown_schema_version/)).toBeNull();
    fireEvent.click(screen.getByRole("button", { expanded: false }));
    expect(screen.getByText(/unknown_schema_version/)).toBeTruthy();
    // file list elides past 6
    expect(screen.getByText(/\(\+6\)/)).toBeTruthy();
    expect(screen.getByText(/partial\.json \(step 2\)/)).toBeTruthy();
  });

  it("uses the degraded (amber) class when no group is a rejection", async () => {
    stub({ totalFiles: 4, imported: 4, groups: [{ code: "orphan_tool_result", rejection: false, occurrences: 2, files: [{ name: "a.json", detail: "step 1" }] }] });
    render(<AtifHealth apiBase="" />);
    await flush();
    const root = screen.getByText(/4\/4 imported/).closest(".watch-atif")!;
    expect(root.className).toContain("is-degraded");
  });
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `cd /Users/rfeng/Projects/ninemind/agentgem-worktrees/atif-health/packages/console && npx vitest run src/panels/Watch/AtifHealth.test.tsx`
Expected: FAIL — cannot resolve `./AtifHealth.js`.

- [ ] **Step 4: Write the component**

Create `packages/console/src/panels/Watch/AtifHealth.tsx`:

```tsx
import { useEffect, useState } from "react";
import { fetchAtifHealth, type AtifHealth as Health } from "./watchStream.js";

// One-line human gloss per code so the user knows what to fix. Keys mirror
// AtifDiagnosticCode in @agentgem/insight (kept as a plain map to avoid a
// cross-package type import in the console).
const GLOSS: Record<string, string> = {
  invalid_json: "not valid JSON — the file is corrupt or truncated",
  not_an_object: "valid JSON but not an object — likely wrapped in an array",
  unknown_schema_version: "not an ATIF file — wrong or missing schema_version",
  missing_agent: "no agent block — the converter left it out",
  no_steps: "no steps — an empty session",
  timestamps_missing: "no step timestamps — dated by file mtime instead",
  orphan_tool_result: "tool result with no matching call — a converter bug",
};

const MAX_FILES = 6;

export function AtifHealth({ apiBase, refreshKey }: { apiBase: string; refreshKey?: number }) {
  const [health, setHealth] = useState<Health | null>(null);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    let alive = true;
    fetchAtifHealth(apiBase)
      .then((h) => { if (alive) setHealth(h); })
      .catch(() => { if (alive) setHealth(null); });
    return () => { alive = false; };
  }, [apiBase, refreshKey]);

  if (!health || health.groups.length === 0) return null;

  const problemFiles = new Set(health.groups.flatMap((g) => g.files.map((f) => f.name))).size;
  const anyRejection = health.groups.some((g) => g.rejection);

  return (
    <div className={"watch-atif" + (anyRejection ? " is-rejection" : " is-degraded")}>
      <button type="button" className="watch-atif-summary" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
        <span className="watch-atif-caret">{open ? "▾" : "▸"}</span>
        {" "}ATIF drop-dir · {health.imported}/{health.totalFiles} imported · {problemFiles} with issues
      </button>
      {open && (
        <ul className="watch-atif-groups">
          {health.groups.map((g) => (
            <li key={g.code} className={"watch-atif-group" + (g.rejection ? " is-rejection" : " is-degraded")}>
              <div className="watch-atif-code">
                <span className="watch-atif-mark">{g.rejection ? "✗" : "⚠"}</span>
                {" "}{g.code} — {g.files.length} file{g.files.length === 1 ? "" : "s"}
                {g.occurrences > g.files.length ? `, ${g.occurrences}×` : ""}
                <span className="ws-chip">{g.rejection ? "rejected" : "degraded"}</span>
              </div>
              <div className="watch-atif-gloss">{GLOSS[g.code] ?? g.code}</div>
              <div className="watch-atif-files">
                {g.files.slice(0, MAX_FILES).map((f, i) => (
                  <span key={i} className="watch-atif-file">{f.name}{f.detail ? ` (${f.detail})` : ""}</span>
                ))}
                {g.files.length > MAX_FILES && <span className="watch-atif-more">… (+{g.files.length - MAX_FILES})</span>}
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `cd /Users/rfeng/Projects/ninemind/agentgem-worktrees/atif-health/packages/console && npx vitest run src/panels/Watch/AtifHealth.test.tsx`
Expected: PASS (3 tests).

- [ ] **Step 6: Add the CSS block**

Append to `packages/console/src/shell/theme.css` (mirrors `.watch-attn-banner` at line 2530; reuses existing tokens with the `var(--x, fallback)` idiom already used in `Watch/index.tsx`):

```css
.watch-atif { margin: 0 0 8px; border-radius: 8px; font-size: 13px; border: 1px solid var(--border, #ccc); overflow: hidden; }
.watch-atif.is-rejection { border-color: rgba(154, 51, 36, .4); }
.watch-atif-summary { display: block; width: 100%; text-align: left; padding: 8px 12px; cursor: pointer; border: 0; font: inherit; background: var(--surface, #fff); color: var(--ink, #222); }
.watch-atif.is-rejection .watch-atif-summary { background: #fbeee9; color: var(--accent); }
.watch-atif-caret { display: inline-block; width: 12px; }
.watch-atif-groups { list-style: none; margin: 0; padding: 4px 12px 8px; }
.watch-atif-group { padding: 6px 0; border-top: 1px solid var(--border, #ccc); }
.watch-atif-code { font-weight: 600; display: flex; gap: 6px; align-items: center; flex-wrap: wrap; }
.watch-atif-mark { font-weight: 700; }
.watch-atif-gloss { opacity: .7; margin: 2px 0; }
.watch-atif-files { display: flex; flex-wrap: wrap; gap: 6px; }
.watch-atif-file { font-family: var(--mono, ui-monospace, monospace); font-size: 12px; }
.watch-atif-more { opacity: .6; font-size: 12px; }
```

- [ ] **Step 7: Render the panel in Watch**

In `packages/console/src/panels/Watch/index.tsx`:

Add the import near the top (beside the `SessionFeed` import):

```ts
import { AtifHealth } from "./AtifHealth.js";
```

Add a refresh-key state inside the `Watch` component, next to the other `useState` calls (e.g. after the `alertPrefs` state):

```ts
  const [healthKey, setHealthKey] = useState(0);
```

Change the Refresh button's handler so it also re-fetches health — replace `onClick={loadSessions}` on the Refresh button with:

```tsx
                onClick={() => { loadSessions(); setHealthKey((k) => k + 1); }}
```

Render the panel at the top of the left column, immediately inside `<div style={{ flex: "1 1 260px", minWidth: 240 }}>` and before the `run-status` header row that contains "Active sessions":

```tsx
          <AtifHealth apiBase={apiBase} refreshKey={healthKey} />
```

- [ ] **Step 8: Build, re-run the component test, and verify in a browser**

Run: `cd /Users/rfeng/Projects/ninemind/agentgem-worktrees/atif-health && pnpm build && cd packages/console && npx vitest run src/panels/Watch/AtifHealth.test.tsx`
Expected: build succeeds; component test PASS.

Then verify appearance with the `verify` skill: seed `~/.agentgem/atif` with a good file, a junk file, and a `trajectory-v1` file (as in Task 2's test), open the console Watch tab, and confirm the red panel appears above Active sessions, expands, and shows the groups + glosses. jsdom asserts behavior; the browser confirms it looks right.

- [ ] **Step 9: Commit**

```bash
git add packages/console/src/panels/Watch/watchStream.ts \
        packages/console/src/panels/Watch/AtifHealth.tsx \
        packages/console/src/panels/Watch/AtifHealth.test.tsx \
        packages/console/src/panels/Watch/index.tsx \
        packages/console/src/shell/theme.css
git commit -m "feat(console): ATIF drop-dir health panel in the Watch tab"
```

---

### Task 5: Full-suite regression + PR

**Files:** none (verification only).

- [ ] **Step 1: Run the full root suite**

Run: `cd /Users/rfeng/Projects/ninemind/agentgem-worktrees/atif-health && pnpm test`
Expected: all green (the new insight tests included; console tests are separate and already run in Task 4).

- [ ] **Step 2: Push and open the PR**

```bash
cd /Users/rfeng/Projects/ninemind/agentgem-worktrees/atif-health
git push -u origin feat/atif-drop-dir-health
gh pr create --base main --head feat/atif-drop-dir-health \
  --title "feat: ATIF drop-dir health panel in Watch" \
  --body "Surfaces the #538 import diagnostics as a Watch-tab debug panel — which dropped files failed and why. Renders only when there are issues; basenames only (no paths, no transcript content). Spec + plan in docs/superpowers/. Insight tests green; console component test green (console tests are not in CI, run locally)."
```

- [ ] **Step 3: Watch CI and merge when green**

Run: `gh run watch <run-id> --exit-status` then `gh pr merge --rebase --delete-branch`.
Note: `--delete-branch` errors on the local branch-delete step because `main` is checked out elsewhere; the **remote merge still succeeds**. Verify: `git fetch origin && git show origin/main:packages/console/src/panels/Watch/AtifHealth.tsx | head -1` returns the import line.

---

## Self-Review

**Spec coverage:**
- Layer 1 (`groupDiagnostics` + `scanAtifHealth`) → Tasks 1, 2. ✅
- Layer 2 (route) → Task 3. ✅
- Layer 3 (component, fetch, render site, CSS) → Task 4. ✅
- Render-only-when-issues → Task 4 Step 4 (`if (!health || health.groups.length === 0) return null`) + test Step 2 case 1. ✅
- `problemFiles` counting model → Task 4 component + test asserts `13 with issues` from 12+1. ✅
- Red vs amber → Task 4 `is-rejection`/`is-degraded` + tests. ✅
- Privacy (basenames, no content) → Task 1 basename mapping + Task 2 `not.toContain(dir)` assertion. ✅
- Reuse `scanAtifSessions` → Task 2. ✅
- Testing across three layers + browser verify → Tasks 1–4. ✅
- Out-of-scope items (no dismiss/re-scan/polling) → honored; none added. ✅

**Placeholder scan:** No TBD/TODO; every code step has complete code; every command has an expected result. ✅

**Type consistency:** `AtifHealthGroup`/`AtifHealthFile`/`AtifHealth` names identical across insight (Tasks 1–2) and the console's local mirror (Task 4). `scanAtifHealth(env?)`, `fetchAtifHealth(apiBase)`, `groupDiagnostics(diags)` referenced consistently. Console `AtifHealthGroup.code` is `string` (a deliberate loosening at the package boundary, noted in the component); insight's is `AtifDiagnosticCode` — the JSON crosses the wire as a string, so this is sound. ✅
