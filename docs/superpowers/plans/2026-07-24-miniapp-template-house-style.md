# Miniapp Templates + Shared House Style Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship a shared design-token module and two new non-game miniapp templates (`project-map`, `skill-tuner`), retrofit `session-heatmap` onto the shared tokens, and replace the Composer's hardcoded genre fork with a per-source template picker.

**Architecture:** One CSS-token module (`HOUSE_TOKENS` + `themeAdapter(mode)` + `HOUSE_PARTIALS`) lands in `@agentgem/model`, the nearest common ancestor of `@agentgem/play` and `@agentgem/insight`. Miniapp scaffolds compose it with the `"host"` adapter, which binds shared token names to the four host-injected CSS variables with fallbacks. Each new genre is wired through all five touchpoints in a single task, because two of them are compile-enforced and the build breaks if they land apart.

**Tech Stack:** TypeScript (ESM, `tsc -b` project references), vitest running compiled `dist/`, React (console panel), pnpm workspaces.

**Spec:** `docs/superpowers/specs/2026-07-24-miniapp-template-house-style-design.md`

**Worktree:** `/Users/rfeng/Projects/ninemind/agentgem-worktrees/miniapp-templates`, branch `feat/miniapp-template-house-style` (already created off `origin/main`).

## Global Constraints

- **Every scaffold must pass `staticGate` before the Studio agent touches it.** A scaffold is a runnable starting point, not a sketch.
- **Seal rules apply to all scaffold HTML:** no external `src=`/`href=` (only `data:` or `#`), no bare module imports, and none of the words `fetch`, `XMLHttpRequest`, `WebSocket`, `EventSource`, `importScripts`, `navigator.sendBeacon` anywhere in executable code — **the scan matches inside comments and string literals too**. Content inside `<script type="application/json">` is exempt.
- **Only four host CSS variables exist** (`packages/play/src/hostStyles.ts:10-13`): `--color-background-primary`, `--color-background-secondary`, `--color-text-primary`, `--color-border-primary`. Every miniapp colour must resolve through one of these with a literal fallback, or be a literal. Dim text uses `opacity`, not a token.
- **Genre ids are public marketplace taxonomy.** `parseTags.ts:7` — Studio publishes `["game", <genre>, ...userTags]` and the marketplace reads them back as the genre facet. `project-map` and `skill-tuner` are final once anything publishes.
- **Tests live in `src/**/__tests__/*.test.ts`** and vitest runs the **compiled** `dist/` (`vitest.config` include: `dist/**/__tests__/**/*.test.js`). Always rebuild before running.
- **Run tests with `pnpm test`** (= `tsc -b && vitest run`). Full rebuild is `pnpm build` (= `tsc -b && node scripts/build-console.mjs`); `tsc -b` alone leaves the console bundle stale.
- **`packages/console` vitest and typecheck are NOT in CI.** Task 6 must be verified locally.
- **Never commit to `main`.** Work stays on `feat/miniapp-template-house-style`; integration is via PR.

**Deviation from the spec, deliberate:** the spec's Testing section proposed adding the new scaffolds to
`src/play/__tests__/gameGate.static.test.ts`. This plan instead gives each scaffold its own
`scaffolds.<name>.test.ts`, each asserting `staticGate(...)` alongside that scaffold's own structural
checks. Same coverage, but a failure names the scaffold rather than a shared gate test.

---

### Task 1: Shared house-style module

**Files:**
- Create: `packages/model/src/houseStyle.ts`
- Modify: `packages/model/src/index.ts`
- Test: `src/__tests__/houseStyle.test.ts`

**Interfaces:**
- Consumes: nothing (leaf module, no imports).
- Produces:
  - `HOUSE_TOKEN_NAMES: readonly string[]` — colour tokens every adapter must bind
  - `HOUSE_TOKENS: string` — surface-invariant `:root` block (type stack, scale, spacing, radius)
  - `type ThemeMode = "host" | "document" | "fixed"`
  - `themeAdapter(mode: ThemeMode): string` — CSS binding every name in `HOUSE_TOKEN_NAMES`
  - `HOUSE_PARTIALS: { kpiRow: string; dataTable: string; svgBar: string }` — structural CSS

- [ ] **Step 1: Write the failing test**

Create `src/__tests__/houseStyle.test.ts`:

```ts
// src/__tests__/houseStyle.test.ts
import { describe, it, expect } from "vitest";
import { HOUSE_TOKENS, HOUSE_TOKEN_NAMES, HOUSE_PARTIALS, themeAdapter } from "@agentgem/model";

const MODES = ["host", "document", "fixed"] as const;

describe("houseStyle", () => {
  it("every theme mode binds every shared colour token", () => {
    for (const mode of MODES) {
      const css = themeAdapter(mode);
      for (const name of HOUSE_TOKEN_NAMES) {
        expect(`${mode}:${name}:${css.includes(`${name}:`)}`).toBe(`${mode}:${name}:true`);
      }
    }
  });

  it("the host adapter resolves through host variables with literal fallbacks", () => {
    const css = themeAdapter("host");
    expect(css).toContain("var(--color-text-primary,");
    expect(css).toContain("var(--color-background-primary,");
    expect(css).toContain("var(--color-border-primary,");
  });

  it("the fixed adapter uses no CSS variables (dashboard has no host)", () => {
    expect(themeAdapter("fixed")).not.toContain("var(--color-");
  });

  it("invariant tokens carry the type stack and scale", () => {
    expect(HOUSE_TOKENS).toContain("--serif:");
    expect(HOUSE_TOKENS).toContain("--mono:");
    expect(HOUSE_TOKENS).toContain("--t-display:");
  });

  it("partials are non-empty CSS and emit no markup", () => {
    for (const css of Object.values(HOUSE_PARTIALS)) {
      expect(css.length).toBeGreaterThan(0);
      expect(css).not.toContain("<");
    }
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm test -- houseStyle`
Expected: FAIL — `tsc -b` errors that `@agentgem/model` has no exported member `HOUSE_TOKENS`.

- [ ] **Step 3: Write the implementation**

Create `packages/model/src/houseStyle.ts`:

```ts
// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
// The shared visual contract for every self-contained HTML document AgentGem generates: miniapp
// scaffolds (packages/play) today, and the report + dashboard render agents (packages/insight) in
// slice 2. ONE token vocabulary, three bindings — a surface changes how a token resolves, never
// what it is called.
//
// Lives in @agentgem/model because it is the nearest common ancestor of play and insight.
// Pure strings. No imports, no I/O.

/** Colour tokens EVERY themeAdapter mode must bind. The drift test iterates this list, so a token
 *  added to one binding and forgotten in another fails rather than rendering `unset`.
 *  Deliberately has no dim-text token: only four host variables exist (hostStyles.ts), none of them
 *  a secondary text colour, so dim text is expressed with `opacity` instead. */
export const HOUSE_TOKEN_NAMES = [
  "--ink", "--surface", "--surface-2", "--border", "--accent", "--ok", "--warn",
] as const;

/** Surface-invariant tokens: type stack, scale, spacing, radius. Identical on every surface. */
export const HOUSE_TOKENS = `:root{
  --serif: ui-serif, Georgia, "Times New Roman", serif;
  --sans: system-ui, -apple-system, "Segoe UI", sans-serif;
  --mono: ui-monospace, "SF Mono", Menlo, Consolas, monospace;
  --t-display: 28px; --t-h2: 17px; --t-body: 14px; --t-small: 11px;
  --sp-1: 6px; --sp-2: 12px; --sp-3: 18px; --sp-4: 30px;
  --radius: 8px;
}`;

export type ThemeMode = "host" | "document" | "fixed";

// Accent/status colours are literal in every mode: no host variable carries them, and the report's
// light/dark pair uses the same hues at both ends.
const ACCENT = `--accent:#c96442; --ok:#5f7a4a; --warn:#b0552f;`;

/** Bind the shared token names for one surface. */
export function themeAdapter(mode: ThemeMode): string {
  if (mode === "host") {
    // Miniapps: the host may inject its palette; most hosts send none, so the fallback is what renders.
    return `:root{
  --ink: var(--color-text-primary, #e8edf4);
  --surface: var(--color-background-primary, #0d1117);
  --surface-2: var(--color-background-secondary, #151b24);
  --border: var(--color-border-primary, #263041);
  ${ACCENT}
}`;
  }
  if (mode === "document") {
    // Standalone documents (reports): explicit data-theme wins, prefers-color-scheme is the default.
    return `:root{ --ink:#141413; --surface:#faf9f5; --surface-2:#f0eee6; --border:#d1cfc5; ${ACCENT} }
:root[data-theme="dark"]{ --ink:#e8e6e1; --surface:#131312; --surface-2:#1d1d1b; --border:#3d3d3a; }
@media (prefers-color-scheme: dark){
  :root:not([data-theme="light"]){ --ink:#e8e6e1; --surface:#131312; --surface-2:#1d1d1b; --border:#3d3d3a; }
}`;
  }
  // Dashboard: a fixed palette, no theming — it renders inside a host that supplies no variables.
  return `:root{ --ink:#20190f; --surface:#f1eadb; --surface-2:#e6dcc8; --border:#cdc0a6;
  --accent:#9a3324; --ok:#2f6b3a; --warn:#9a3324; }`;
}

/** Structural CSS a scaffold opts into. Class names are prefixed `hs-` so they cannot collide with
 *  whatever the Studio agent writes inside the AGENTGEM:GAME-LOGIC markers. */
export const HOUSE_PARTIALS = {
  kpiRow: `.hs-kpis{display:flex;flex-wrap:wrap;gap:var(--sp-3);margin:var(--sp-3) 0}
.hs-kpi{min-width:88px}
.hs-kpi b{display:block;font:600 24px/1.1 var(--mono);color:var(--ink)}
.hs-kpi span{display:block;font:500 var(--t-small)/1.4 var(--sans);text-transform:uppercase;letter-spacing:.08em;opacity:.6;margin-top:3px}`,

  dataTable: `.hs-table{width:100%;border-collapse:collapse;font:var(--t-body)/1.5 var(--sans)}
.hs-table th{text-align:left;font:600 var(--t-small) var(--sans);text-transform:uppercase;letter-spacing:.08em;opacity:.6;padding:0 var(--sp-2) var(--sp-1) 0}
.hs-table td{padding:var(--sp-1) var(--sp-2) var(--sp-1) 0;border-top:1px solid var(--border);vertical-align:top}
.hs-table td.hs-num{font:var(--t-body) var(--mono);text-align:right}
.hs-scroll{overflow-x:auto}`,

  svgBar: `.hs-bar{display:block;width:100%;height:auto}
.hs-bar rect{fill:var(--accent)}
.hs-bar text{fill:var(--ink);font:var(--t-small) var(--mono);opacity:.75}`,
} as const;
```

- [ ] **Step 4: Add the barrel export**

In `packages/model/src/index.ts`, add alongside the existing `export * from "./types.js";`:

```ts
export * from "./houseStyle.js";
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `pnpm test -- houseStyle`
Expected: PASS, 5 tests.

- [ ] **Step 6: Commit**

```bash
git add packages/model/src/houseStyle.ts packages/model/src/index.ts src/__tests__/houseStyle.test.ts
git commit -m "feat(model): shared house-style tokens with per-surface theme adapters"
```

---

### Task 2: Genre/source mismatch guard

Generalizing the genre fork lets a caller post a genre that does not belong to the source kind. Today that is impossible because `sourceContext.ts` checks one literal. This guard lands **before** the new genres so they inherit it.

**Files:**
- Modify: `packages/play/src/sourceContext.ts`
- Test: `src/play/__tests__/sourceContext.mismatch.test.ts`

**Interfaces:**
- Consumes: `genreFor(id)` from `packages/play/src/genres.ts`; `GenreSpec.sourceKind`.
- Produces: `extractSource` throws `Error("genre '<genre>' does not accept a <kind> source")` on mismatch.

- [ ] **Step 1: Write the failing test**

Create `src/play/__tests__/sourceContext.mismatch.test.ts`:

```ts
// src/play/__tests__/sourceContext.mismatch.test.ts
import { describe, it, expect } from "vitest";
import { extractSource, type SourceReaders } from "@agentgem/play";

const readers: SourceReaders = {
  readSession: async () => ({ sessionId: "s1", meta: {}, turns: [] }),
  readSkill: async () => ({ name: "k", content: "c" }),
  readProject: async () => ({ path: "/p", flavor: "node", files: ["a.ts"] }),
};

describe("extractSource genre/source agreement", () => {
  it("rejects a genre whose sourceKind does not match the source", async () => {
    const source = { kind: "session", agent: "claude", sessionId: "s1", summary: "x" } as const;
    await expect(extractSource(source, readers, "skill-run")).rejects.toThrow(/does not accept a session source/);
  });

  it("accepts a genre that matches the source kind", async () => {
    const source = { kind: "session", agent: "claude", sessionId: "s1", summary: "x" } as const;
    const out = await extractSource(source, readers, "session-heatmap");
    expect(out.genre).toBe("session-heatmap");
  });

  it("still defaults when no genre is requested", async () => {
    const source = { kind: "session", agent: "claude", sessionId: "s1", summary: "x" } as const;
    const out = await extractSource(source, readers, undefined);
    expect(out.genre).toBe("replay");
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm test -- sourceContext.mismatch`
Expected: FAIL — the first case resolves to a `replay` result instead of rejecting.

- [ ] **Step 3: Write the implementation**

In `packages/play/src/sourceContext.ts`, import `genreFor` and add the assertion at the top of `extractSource`, before any branch:

```ts
import { genreFor } from "./genres.js";

// …inside extractSource, first statement:
  // A requested genre must belong to the source kind. Before the Composer offered a template list this
  // was structurally impossible (one literal check inside the session branch); with a list, a mismatched
  // pair would silently seed the DEFAULT genre and hand the user the wrong miniapp.
  if (genre && genreFor(genre).sourceKind !== source.kind) {
    throw new Error(`genre '${genre}' does not accept a ${source.kind} source`);
  }
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm test -- sourceContext.mismatch`
Expected: PASS, 3 tests.

- [ ] **Step 5: Run the full play suite for regressions**

Run: `pnpm test -- play`
Expected: PASS. The existing session fork still resolves `session-heatmap` and `replay`.

- [ ] **Step 6: Commit**

```bash
git add packages/play/src/sourceContext.ts src/play/__tests__/sourceContext.mismatch.test.ts
git commit -m "feat(play): reject a genre whose sourceKind does not match the seeded source"
```

---

### Task 3: Retrofit `session-heatmap` onto the house style

No new genre. This proves the shared tokens work on a shipped scaffold, and guards the regression that would make the genre unpublishable.

**Files:**
- Modify: `packages/play/src/scaffolds.ts` (`heatmapScaffold`, currently at line 210)
- Test: `src/play/__tests__/scaffolds.houseStyle.test.ts`

**Interfaces:**
- Consumes: `HOUSE_TOKENS`, `themeAdapter`, `HOUSE_PARTIALS` from `@agentgem/model` (Task 1).
- Produces: no signature change — `scaffoldFor("heatmap")` still returns a string.

- [ ] **Step 1: Write the failing test**

Create `src/play/__tests__/scaffolds.houseStyle.test.ts`:

```ts
// src/play/__tests__/scaffolds.houseStyle.test.ts
import { describe, it, expect } from "vitest";
import { scaffoldFor, staticGate, assertPortable } from "@agentgem/play";
import { HOUSE_TOKEN_NAMES } from "@agentgem/model";

describe("heatmap scaffold on the shared house style", () => {
  const html = () => scaffoldFor("heatmap");

  it("passes the static gate untouched by the studio agent", () => {
    expect(staticGate(html())).toEqual({ ok: true, failures: [] });
  });

  it("binds every shared colour token", () => {
    for (const name of HOUSE_TOKEN_NAMES) {
      expect(`${name}:${html().includes(`${name}:`)}`).toBe(`${name}:true`);
    }
  });

  it("still resolves through the host variables", () => {
    expect(html()).toContain("var(--color-background-primary,");
  });

  it("keeps the game-data seam so a seeded bundle stays portable", () => {
    // session-heatmap declares session-data, a CONTENT capability: assertPortable fails Save unless a
    // non-empty timeline is baked. Seeding writes that block; the scaffold must not rename or drop it.
    const seeded = html().replace(
      "</head>",
      `<script id="game-data" type="application/json">{"timeline":[{"role":"user","tsMs":0,"text":"hi"}]}</script></head>`,
    );
    expect(assertPortable(seeded, ["session-data"])).toEqual({ ok: true, failures: [] });
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm test -- scaffolds.houseStyle`
Expected: FAIL on "binds every shared colour token" — the current scaffold hardcodes `#7c5cff`, `#8b98ac` and names no `--ink`.

- [ ] **Step 3: Rewrite the scaffold's style block**

In `packages/play/src/scaffolds.ts`, add the import at the top:

```ts
import { HOUSE_TOKENS, HOUSE_PARTIALS, themeAdapter } from "@agentgem/model";
```

Replace the `<style>…</style>` block inside `heatmapScaffold()` with:

```ts
<style>
  :root { color-scheme: light dark; }
  ${HOUSE_TOKENS}
  ${themeAdapter("host")}
  ${HOUSE_PARTIALS.kpiRow}
  html,body { height:100%; margin:0; overflow:hidden;
    background: var(--surface); color: var(--ink); font: var(--t-body)/1.5 var(--sans); }
  #wrap { max-width:820px; margin:0 auto; padding:var(--sp-3); box-sizing:border-box; height:100%; display:flex; flex-direction:column; }
  .wait { display:grid; place-items:center; height:100%; opacity:.6; font-size:15px; }
  .title { font:700 var(--t-display) var(--serif); text-align:center; }
  .title .sub { display:block; font:600 var(--t-small) var(--sans); letter-spacing:.14em; text-transform:uppercase; opacity:.6; margin-top:3px; }
  #grid { display:grid; gap:3px; margin:var(--sp-3) 0; }
  .row-label { font:600 var(--t-small) var(--sans); text-transform:uppercase; letter-spacing:.08em; opacity:.7; align-self:center; padding-right:6px; }
  .cell { border-radius:4px; border:1px solid var(--border); cursor:pointer; aspect-ratio:1; }
  .cell:hover { outline:2px solid var(--accent); }
  .axis { font:500 10px var(--sans); opacity:.55; text-align:center; }
  #detail { flex:1; overflow:auto; background: var(--surface-2);
    border:1px solid var(--border); border-radius:var(--radius); padding:10px var(--sp-2); min-height:70px; }
  #detail .line { font:500 12.5px var(--sans); opacity:.9; margin-bottom:5px; }
  #detail .empty { opacity:.5; }
  #legend { display:flex; align-items:center; gap:6px; font:500 var(--t-small) var(--sans); opacity:.7; margin-bottom:6px; }
  #legend .sw { width:12px; height:12px; border-radius:3px; display:inline-block; }
</style>
```

Leave everything between the `AGENTGEM:GAME-LOGIC` markers unchanged — this task restyles only.

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm test -- scaffolds.houseStyle`
Expected: PASS, 4 tests.

- [ ] **Step 5: Verify no existing gate test regressed**

Run: `pnpm test -- gameGate`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/play/src/scaffolds.ts src/play/__tests__/scaffolds.houseStyle.test.ts
git commit -m "feat(play): retrofit the session-heatmap scaffold onto the shared house style"
```

---

### Task 4: `project-map` genre

All five touchpoints land together: two are compile-enforced and the build breaks if they split.

**Files:**
- Modify: `packages/model/src/types.ts:50` (`GAME_GENRES`)
- Modify: `packages/console/src/panels/Play/parseTags.ts:10` (`GENRE_TAGS`)
- Modify: `packages/play/src/genres.ts` (`GENRES`)
- Modify: `packages/play/src/scaffolds.ts` (new `projectMapScaffold()`, register in `SCAFFOLDS`)
- Modify: `packages/play/src/sourceContext.ts` (project branch honours the genre)
- Test: `src/play/__tests__/genres.test.ts` (extend), `src/play/__tests__/scaffolds.projectMap.test.ts` (new)

**Interfaces:**
- Consumes: `HOUSE_TOKENS`, `themeAdapter`, `HOUSE_PARTIALS` (Task 1); the mismatch guard (Task 2).
- Produces: genre id `"project-map"`, scaffold id `"project-map"`, `ProjectData` shape `{ path: string; flavor: string; files: string[] }` rendered from `#game-data`.

- [ ] **Step 1: Replace the stale genre assertion with an exhaustive one**

Edit `src/play/__tests__/genres.test.ts`. Replace the first `it(...)` block (lines 6-12) with:

```ts
  it("every declared genre is fully wired: GENRES entry, sourceKind, and a resolvable scaffold", () => {
    for (const id of GAME_GENRES) {
      const spec = GENRES[id];
      expect(`${id}:spec`).toBe(`${id}:${spec ? "spec" : "missing"}`);
      expect(["session", "skill", "project", "html", "blank"]).toContain(spec.sourceKind);
      expect(() => scaffoldFor(spec.scaffold)).not.toThrow();
    }
  });
```

and widen the imports at the top of the file:

```ts
import { GENRES, genreFor, scaffoldFor } from "@agentgem/play";
import { GAME_GENRES } from "@agentgem/model";
```

This is the assertion that converts the three non-compile-enforced touchpoints into a test failure. It iterates `GAME_GENRES`, so it cannot go stale the way the previous hand-listed version did.

- [ ] **Step 2: Write the failing scaffold test**

Create `src/play/__tests__/scaffolds.projectMap.test.ts`:

```ts
// src/play/__tests__/scaffolds.projectMap.test.ts
import { describe, it, expect } from "vitest";
import { scaffoldFor, staticGate, assertPortable } from "@agentgem/play";

describe("project-map scaffold", () => {
  const html = () => scaffoldFor("project-map");

  it("passes the static gate untouched", () => {
    expect(staticGate(html())).toEqual({ ok: true, failures: [] });
  });

  it("reads its data from the game-data seam", () => {
    expect(html()).toContain('getElementById("game-data")');
  });

  it("declares local-project-access as an enhancement, so it needs no baked timeline", () => {
    expect(assertPortable(html(), ["local-project-access"])).toEqual({ ok: true, failures: [] });
  });

  it("calls the inventory tool with a literal name so needs-reconciliation can see it", () => {
    // A non-literal tool name is rejected outright by Save: the reconciler reads source text.
    expect(html()).toContain('callTool("agentgem_get_inventory"');
  });
});
```

- [ ] **Step 3: Run both tests to verify they fail**

Run: `pnpm test -- genres scaffolds.projectMap`
Expected: FAIL — `scaffoldFor('project-map')` throws `unknown scaffold 'project-map'`.

- [ ] **Step 4: Add the scaffold**

In `packages/play/src/scaffolds.ts`, add before the `SCAFFOLDS` record:

```ts
// An analytical readout of a project: structure and counts, not architecture. ProjectData is
// { path, flavor, files: string[] } — file NAMES only, no contents — so this renders what it actually
// has and upgrades via local-project-access when a host is present. No host (app.agentgem.ai) means
// the baked list is what renders, which is why the boot path never waits on the bridge.
function projectMapScaffold(): string {
  return `<!doctype html>
<html lang="en"><head>${mcpAppClient()}<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Project Map</title>
<style>
  :root { color-scheme: light dark; }
  ${HOUSE_TOKENS}
  ${themeAdapter("host")}
  ${HOUSE_PARTIALS.kpiRow}
  ${HOUSE_PARTIALS.svgBar}
  html,body { height:100%; margin:0; overflow:hidden;
    background: var(--surface); color: var(--ink); font: var(--t-body)/1.5 var(--sans); }
  #stage { position:fixed; inset:0; overflow:auto; }
  #wrap { max-width:820px; margin:0 auto; padding:var(--sp-4) var(--sp-3); box-sizing:border-box; }
  .eyebrow { font:500 var(--t-small) var(--mono); text-transform:uppercase; letter-spacing:.08em; opacity:.6; }
  h1 { font:500 var(--t-display) var(--serif); letter-spacing:-.01em; margin:var(--sp-1) 0 var(--sp-2); }
  .dir { font:600 var(--t-small) var(--mono); text-transform:uppercase; letter-spacing:.06em; opacity:.6;
    margin:var(--sp-3) 0 var(--sp-1); }
  .file { font:var(--t-body) var(--mono); opacity:.9; padding:2px 0; }
  .src { font:500 var(--t-small) var(--sans); opacity:.55; margin-top:var(--sp-3); }
</style></head>
<body>
  <div id="stage"><div id="wrap"><div id="app"></div></div></div>
  <script>
  (function () {
    "use strict";
    var app = document.getElementById("app");
    var esc = function (s) { return String(s).replace(/[&<>]/g, function (c) { return ({ "&":"&amp;", "<":"&lt;", ">":"&gt;" })[c]; }); };
    var dataEl = document.getElementById("game-data");
    var DATA = dataEl ? JSON.parse(dataEl.textContent || "{}") : {};
    var LIVE = false;

    // ==== AGENTGEM:GAME-LOGIC START ====
    function groupByDir(files) {
      var out = {};
      (files || []).forEach(function (f) {
        var i = String(f).lastIndexOf("/");
        var dir = i < 0 ? "." : String(f).slice(0, i);
        (out[dir] = out[dir] || []).push(i < 0 ? String(f) : String(f).slice(i + 1));
      });
      return out;
    }
    function extCounts(files) {
      var out = {};
      (files || []).forEach(function (f) {
        var m = /\\.([a-z0-9]+)$/i.exec(String(f));
        var k = m ? m[1].toLowerCase() : "(none)";
        out[k] = (out[k] || 0) + 1;
      });
      return Object.keys(out).map(function (k) { return { ext: k, n: out[k] }; })
        .sort(function (a, b) { return b.n - a.n; }).slice(0, 8);
    }
    function barSvg(rows) {
      if (!rows.length) return "";
      var max = rows[0].n, h = rows.length * 22, w = 620;
      var bars = rows.map(function (r, i) {
        var bw = Math.max(2, Math.round((r.n / max) * (w - 190)));
        return '<rect x="130" y="' + (i * 22 + 4) + '" width="' + bw + '" height="14" rx="3"></rect>' +
          '<text x="0" y="' + (i * 22 + 15) + '">' + esc(r.ext) + '</text>' +
          '<text x="' + (136 + bw) + '" y="' + (i * 22 + 15) + '">' + r.n + '</text>';
      }).join("");
      return '<svg class="hs-bar" viewBox="0 0 ' + w + ' ' + h + '" role="img" aria-label="files by extension">' + bars + '</svg>';
    }
    function render() {
      var files = DATA.files || [];
      var dirs = groupByDir(files);
      var dirNames = Object.keys(dirs).sort();
      var exts = extCounts(files);
      app.innerHTML =
        '<div class="eyebrow">project map' + (LIVE ? " · live" : " · snapshot") + '</div>' +
        "<h1>" + esc(DATA.path || "this project") + "</h1>" +
        '<div class="hs-kpis">' +
          '<div class="hs-kpi"><b>' + files.length + "</b><span>files</span></div>" +
          '<div class="hs-kpi"><b>' + dirNames.length + "</b><span>directories</span></div>" +
          '<div class="hs-kpi"><b>' + esc(DATA.flavor || "—") + "</b><span>flavor</span></div>" +
        "</div>" +
        barSvg(exts) +
        dirNames.map(function (d) {
          return '<div class="dir">' + esc(d) + "</div>" +
            dirs[d].sort().map(function (f) { return '<div class="file">' + esc(f) + "</div>"; }).join("");
        }).join("") +
        '<div class="src">' + (LIVE ? "upgraded from the local inventory" : "baked snapshot — no host connected") + "</div>";
    }
    render();

    // Enhancement only: with a host, upgrade to the real inventory. With none, the baked list stands.
    if (window.agentgemApp) {
      window.agentgemApp.callTool("agentgem_get_inventory", {}).then(function (inv) {
        if (inv && inv.files && inv.files.length) { DATA = { path: DATA.path, flavor: DATA.flavor, files: inv.files }; LIVE = true; render(); }
      }).catch(function () { /* no host, or consent refused — the snapshot is already rendered */ });
    }
    // ==== AGENTGEM:GAME-LOGIC END ====
  })();
  </script>
</body></html>`;
}
```

Register it in `SCAFFOLDS`:

```ts
const SCAFFOLDS: Record<string, string> = {
  replay: replayScaffold(),
  "skill-run": minimalTemplate("Skill Run", "⚙ practice"),
  "project-fun": minimalTemplate("Project Fun", "★ play"),
  heatmap: heatmapScaffold(),
  "project-map": projectMapScaffold(),
};
```

- [ ] **Step 5: Add the genre**

In `packages/model/src/types.ts:50`:

```ts
export const GAME_GENRES = ["replay", "skill-run", "project-fun", "session-heatmap", "project-map"] as const;
```

In `packages/console/src/panels/Play/parseTags.ts:10` (compile-enforced — the console will not build until this matches):

```ts
const GENRE_TAGS = ["replay", "skill-run", "project-fun", "session-heatmap", "project-map"] as const;
```

In `packages/play/src/genres.ts`, add to `GENRES`:

```ts
  "project-map": {
    id: "project-map", sourceKind: "project", title: "Project Map", scaffold: "project-map",
    needs: ["local-project-access"],
    guidance:
      "Build an analytical readout of the PROJECT in the DATA: files grouped by directory, counts by " +
      "extension, the flavor as the thesis line. Structure and counts only — the data carries file NAMES, " +
      "not contents, so never claim to describe architecture. Analytical, not a game.",
  },
```

- [ ] **Step 6: Honour the genre in the project branch**

In `packages/play/src/sourceContext.ts`, replace the final project `return` (currently line 53) with:

```ts
  return {
    genre: genre === "project-map" ? "project-map" : "project-fun",
    createdFrom: source, data: p,
    brief: genre === "project-map"
      ? `Build an analytical map of the project at ${source.path} (${source.flavor}).`
      : `Make a light themed mini-game seeded by the project at ${source.path} (${source.flavor}).`,
  };
```

- [ ] **Step 7: Run the tests to verify they pass**

Run: `pnpm test -- genres scaffolds.projectMap sourceContext`
Expected: PASS.

- [ ] **Step 8: Verify the console still compiles (the drift guard)**

Run: `pnpm build`
Expected: success. If `parseTags.ts` was missed, `tsc` fails on `_GenreDrift` — that is the guard working.

- [ ] **Step 9: Commit**

```bash
git add packages/model/src/types.ts packages/play/src/genres.ts packages/play/src/scaffolds.ts \
        packages/play/src/sourceContext.ts packages/console/src/panels/Play/parseTags.ts \
        src/play/__tests__/genres.test.ts src/play/__tests__/scaffolds.projectMap.test.ts
git commit -m "feat(play): project-map genre — analytical project readout on the house style"
```

---

### Task 5: `skill-tuner` genre

**Files:**
- Modify: `packages/model/src/types.ts:50`, `packages/console/src/panels/Play/parseTags.ts:10`
- Modify: `packages/play/src/genres.ts`, `packages/play/src/scaffolds.ts`, `packages/play/src/sourceContext.ts`
- Test: `src/play/__tests__/scaffolds.skillTuner.test.ts`

**Interfaces:**
- Consumes: Task 1 exports; Task 4's exhaustive `genres.test.ts` assertion (which will now also cover this genre with no edit).
- Produces: genre id `"skill-tuner"`, scaffold id `"skill-tuner"`, `SkillData` shape `{ name, content, trigger? }` rendered from `#game-data`.

- [ ] **Step 1: Write the failing test**

Create `src/play/__tests__/scaffolds.skillTuner.test.ts`:

```ts
// src/play/__tests__/scaffolds.skillTuner.test.ts
import { describe, it, expect } from "vitest";
import { scaffoldFor, staticGate, assertPortable, deriveNeeds } from "@agentgem/play";

describe("skill-tuner scaffold", () => {
  const html = () => scaffoldFor("skill-tuner");

  it("passes the static gate untouched", () => {
    expect(staticGate(html())).toEqual({ ok: true, failures: [] });
  });

  it("derives copy-command from a literal method call", () => {
    // Save derives needs from source text; an aliased reference would be pruned and then fail at play time.
    expect(deriveNeeds(html())).toContain("copy-command");
  });

  it("needs no baked timeline: copy-command is an enhancement, not content", () => {
    expect(assertPortable(html(), ["copy-command"])).toEqual({ ok: true, failures: [] });
  });

  it("renders the skill readout before any host call, so it is useful with no clipboard", () => {
    expect(html()).toContain('getElementById("game-data")');
    expect(html()).toContain("render()");
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm test -- scaffolds.skillTuner`
Expected: FAIL — `unknown scaffold 'skill-tuner'`.

- [ ] **Step 3: Add the scaffold**

In `packages/play/src/scaffolds.ts`, add before `SCAFFOLDS`:

```ts
// A skill readout you can tune. Readout FIRST: portability.ts classifies copy-command as an
// enhancement — "egress to the clipboard, never a game's primary content" — so this must be worth
// opening when the clipboard is refused or no host exists. Tuner state is in-memory on purpose:
// storage in a null-origin frame is a shim that dies on reload.
function skillTunerScaffold(): string {
  return `<!doctype html>
<html lang="en"><head>${mcpAppClient()}<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Skill Tuner</title>
<style>
  :root { color-scheme: light dark; }
  ${HOUSE_TOKENS}
  ${themeAdapter("host")}
  html,body { height:100%; margin:0; overflow:hidden;
    background: var(--surface); color: var(--ink); font: var(--t-body)/1.5 var(--sans); }
  #stage { position:fixed; inset:0; overflow:auto; }
  #wrap { max-width:760px; margin:0 auto; padding:var(--sp-4) var(--sp-3); box-sizing:border-box; }
  .eyebrow { font:500 var(--t-small) var(--mono); text-transform:uppercase; letter-spacing:.08em; opacity:.6; }
  h1 { font:500 var(--t-display) var(--serif); letter-spacing:-.01em; margin:var(--sp-1) 0 var(--sp-3); }
  label { display:block; font:600 var(--t-small) var(--sans); text-transform:uppercase; letter-spacing:.08em;
    opacity:.6; margin:var(--sp-3) 0 var(--sp-1); }
  input, textarea { width:100%; box-sizing:border-box; background:var(--surface-2); color:var(--ink);
    border:1px solid var(--border); border-radius:var(--radius); padding:var(--sp-1) var(--sp-2);
    font:var(--t-body) var(--mono); }
  textarea { min-height:150px; resize:vertical; }
  .row { display:flex; gap:var(--sp-2); align-items:center; margin-top:var(--sp-3); flex-wrap:wrap; }
  button { background:var(--accent); color:#fff; border:0; border-radius:var(--radius);
    padding:8px var(--sp-3); font:600 var(--t-body) var(--sans); cursor:pointer; }
  button.ghost { background:transparent; color:var(--ink); border:1px solid var(--border); }
  .note { font:500 var(--t-small) var(--sans); opacity:.6; }
  pre { background:var(--surface-2); border:1px solid var(--border); border-radius:var(--radius);
    padding:var(--sp-2); overflow:auto; font:var(--t-body) var(--mono); white-space:pre-wrap; }
</style></head>
<body>
  <div id="stage"><div id="wrap"><div id="app"></div></div></div>
  <script>
  (function () {
    "use strict";
    var app = document.getElementById("app");
    var esc = function (s) { return String(s).replace(/[&<>]/g, function (c) { return ({ "&":"&amp;", "<":"&lt;", ">":"&gt;" })[c]; }); };
    var dataEl = document.getElementById("game-data");
    var DATA = dataEl ? JSON.parse(dataEl.textContent || "{}") : {};
    var state = { name: DATA.name || "skill", trigger: String(DATA.trigger || ""), body: String(DATA.content || "") };

    // ==== AGENTGEM:GAME-LOGIC START ====
    function markdown() {
      return "---\\nname: " + state.name + "\\ndescription: " + state.trigger + "\\n---\\n\\n" + state.body;
    }
    function render() {
      app.innerHTML =
        '<div class="eyebrow">skill tuner</div>' +
        "<h1>" + esc(state.name) + "</h1>" +
        "<label for=\\"trg\\">description / trigger</label>" +
        '<input id="trg" value="' + esc(state.trigger).replace(/"/g, "&quot;") + '" />' +
        "<label for=\\"bdy\\">body</label>" +
        '<textarea id="bdy">' + esc(state.body) + "</textarea>" +
        "<label>preview</label><pre id=\\"pv\\">" + esc(markdown()) + "</pre>" +
        '<div class="row"><button id="copy">Copy skill markdown</button>' +
        '<span class="note" id="msg">Edits live in this frame only — copy to keep them.</span></div>';

      document.getElementById("trg").addEventListener("input", function (e) { state.trigger = e.target.value; preview(); });
      document.getElementById("bdy").addEventListener("input", function (e) { state.body = e.target.value; preview(); });
      document.getElementById("copy").addEventListener("click", copyOut);
    }
    function preview() { document.getElementById("pv").textContent = markdown(); }
    function say(t) { document.getElementById("msg").textContent = t; }
    function copyOut() {
      var text = markdown();
      if (!window.agentgemApp) { fallback(text); return; }
      window.agentgemApp.copyCommand(text).then(function () { say("Copied to your clipboard."); })
        .catch(function () { fallback(text); });
    }
    // No host, or consent refused: show the markdown selectable so the readout is still useful.
    function fallback(text) {
      var pv = document.getElementById("pv");
      pv.textContent = text;
      var r = document.createRange(); r.selectNodeContents(pv);
      var sel = window.getSelection(); sel.removeAllRanges(); sel.addRange(r);
      say("Clipboard unavailable — selected the markdown instead.");
    }
    render();
    // ==== AGENTGEM:GAME-LOGIC END ====
  })();
  </script>
</body></html>`;
}
```

Register it:

```ts
  "skill-tuner": skillTunerScaffold(),
```

- [ ] **Step 4: Add the genre**

`packages/model/src/types.ts:50`:

```ts
export const GAME_GENRES = ["replay", "skill-run", "project-fun", "session-heatmap", "project-map", "skill-tuner"] as const;
```

`packages/console/src/panels/Play/parseTags.ts:10`:

```ts
const GENRE_TAGS = ["replay", "skill-run", "project-fun", "session-heatmap", "project-map", "skill-tuner"] as const;
```

`packages/play/src/genres.ts`:

```ts
  "skill-tuner": {
    id: "skill-tuner", sourceKind: "skill", title: "Skill Tuner", scaffold: "skill-tuner",
    needs: ["copy-command"],
    guidance:
      "Build a readable readout of the SKILL in the DATA — name, trigger/description, body — that the " +
      "user can also edit and copy back out as markdown. Readout first: the copy path may be refused, " +
      "and the miniapp must still be worth opening. Analytical, not a game.",
  },
```

- [ ] **Step 5: Honour the genre in the skill branch**

In `packages/play/src/sourceContext.ts`, replace the skill branch `return` (currently line 47) with:

```ts
    return {
      genre: genre === "skill-tuner" ? "skill-tuner" : "skill-run",
      createdFrom: source, data: k,
      brief: genre === "skill-tuner"
        ? `Build a readout and tuner for the skill "${source.skillName}".`
        : `Make a playable challenge that exercises the skill "${source.skillName}".`,
    };
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `pnpm test -- scaffolds.skillTuner genres sourceContext`
Expected: PASS. `genres.test.ts` covers the new genre with no edit — Task 4's assertion iterates `GAME_GENRES`.

- [ ] **Step 7: Full build and full suite**

Run: `pnpm build && pnpm test`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add packages/model/src/types.ts packages/play/src/genres.ts packages/play/src/scaffolds.ts \
        packages/play/src/sourceContext.ts packages/console/src/panels/Play/parseTags.ts \
        src/play/__tests__/scaffolds.skillTuner.test.ts
git commit -m "feat(play): skill-tuner genre — skill readout with clipboard egress"
```

---

### Task 6: Composer template picker

Replaces the hardcoded `sessionGenre` fork with a per-source list. **`packages/console` is not in CI** — verify locally.

**Files:**
- Modify: `packages/console/src/panels/Play/Composer.tsx` (the `sessionGenre` state and line 105)
- Test: `packages/console/src/panels/Play/__tests__/Composer.test.tsx` (extend)

**Interfaces:**
- Consumes: `GameGenre` (type-only import), the genre ids from Tasks 4 and 5.
- Produces: `PLAY_TEMPLATES: Record<GameGenre, { label: string; blurb: string; sourceKind: Kind }>` — exhaustive, so a future genre without an entry is a compile error.

- [ ] **Step 1: Write the failing test**

Add to `packages/console/src/panels/Play/__tests__/Composer.test.tsx`. Check the file's existing imports
first — the test below needs `playStudioRoute` (from `../../../api/routes.js`), `vi`, `fireEvent` and
`waitFor`; add whichever are missing rather than assuming they are present.

```tsx
it("offers the templates for the selected source kind and posts the chosen genre", async () => {
  const spy = vi.spyOn(playStudioRoute, "call").mockResolvedValue({ name: "m1" } as never);
  const { getByText, findByText } = render(<Composer apiBase="" onCreated={() => {}} />);

  fireEvent.click(getByText("Skill"));
  // skill-run and skill-tuner are the skill-kind templates; project-map must not appear.
  expect(await findByText("Skill Tuner")).toBeTruthy();
  expect(document.body.textContent?.includes("Project Map")).toBe(false);

  fireEvent.click(getByText("Skill Tuner"));
  fireEvent.click(getByText("Create"));
  await waitFor(() => expect(spy).toHaveBeenCalled());
  expect(spy.mock.calls[0][1].body.genre).toBe("skill-tuner");
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter @agentgem/console test -- Composer`
Expected: FAIL — no "Skill Tuner" node; the picker does not exist.

- [ ] **Step 3: Add the exhaustive template table**

At the top of `packages/console/src/panels/Play/Composer.tsx`, beside the existing `type Kind`:

```tsx
import type { GameGenre } from "@agentgem/model";

// Exhaustive by construction: keying on GameGenre makes a new genre without a picker entry a COMPILE
// error. Kept as a local literal with a type-only import — a runtime import of GAME_GENRES would drag
// node:* into the browser bundle (the same constraint parseTags.ts documents).
const PLAY_TEMPLATES: Record<GameGenre, { label: string; blurb: string; sourceKind: Kind }> = {
  replay: { label: "Session Replay", blurb: "A playable replay of the session", sourceKind: "session" },
  "session-heatmap": { label: "Session Heatmap", blurb: "Activity by time bucket", sourceKind: "session" },
  "skill-run": { label: "Skill Run", blurb: "A challenge that exercises the skill", sourceKind: "skill" },
  "skill-tuner": { label: "Skill Tuner", blurb: "Read and tune the skill, copy it back out", sourceKind: "skill" },
  "project-fun": { label: "Project Fun", blurb: "A light themed mini-game", sourceKind: "project" },
  "project-map": { label: "Project Map", blurb: "Files by directory and extension", sourceKind: "project" },
};

function templatesFor(kind: Kind): [GameGenre, (typeof PLAY_TEMPLATES)[GameGenre]][] {
  return (Object.entries(PLAY_TEMPLATES) as [GameGenre, (typeof PLAY_TEMPLATES)[GameGenre]][])
    .filter(([, t]) => t.sourceKind === kind);
}
```

- [ ] **Step 4: Replace the state and the fork**

Replace the `sessionGenre` state declaration (near line 82) with:

```tsx
  // Which template the chosen source forks into. Reset when the source kind changes, because a genre
  // is only valid for its own sourceKind — the server now rejects a mismatched pair outright.
  const [template, setTemplate] = useState<GameGenre | null>(null);
```

Replace the fork at line 105 with:

```tsx
      const genre = template ? { genre: template } : {};
```

Wherever `setKind` is called, also clear the template:

```tsx
  function chooseKind(k: Kind) { setKind(k); setTemplate(null); }
```

and use `chooseKind` in place of `setKind` in the source-kind tab handlers.

- [ ] **Step 5: Render the picker**

Insert above the Create button, visible for `project`/`session`/`skill` (not `html`/`blank`):

```tsx
      {(kind === "project" || kind === "session" || kind === "skill") && (
        <div className="play-templates">
          <p className="play-intro" style={{ margin: "8px 0 4px" }}>Template</p>
          <ul className="play-src">
            {templatesFor(kind).map(([id, t]) => (
              <li key={id}>
                <button
                  className={`play-src-item${template === id ? " is-sel" : ""}`}
                  onClick={() => setTemplate(id)}
                >
                  <strong>{t.label}</strong>
                  <span>{t.blurb}</span>
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
```

- [ ] **Step 6: Verify every class name has a CSS rule**

Per CLAUDE.md, an unstyled className ships as raw browser defaults. Check each one used above:

Run: `grep -c "play-src-item\|play-templates\|is-sel" packages/console/src/styles.css`
Expected: > 0 for each. Reuse the existing `.play-src` row styling; add rules for any class that returns 0, matching the sibling `play-src` block and the `--ink`/`--surface`/`--brand` tokens.

- [ ] **Step 7: Run the console tests**

Run: `pnpm --filter @agentgem/console test -- Composer`
Expected: PASS.

- [ ] **Step 8: Verify in a real browser**

jsdom asserts behavior, never appearance. Use the `verify` skill to build and drive the console: open Play → Composer, select each source kind, confirm the template list changes and shows only that kind's templates, seed one `project-map` and one `skill-tuner`, and confirm each renders in the Runner rather than a blank frame.

- [ ] **Step 9: Full build and commit**

```bash
pnpm build && pnpm test
git add packages/console/src/panels/Play/Composer.tsx packages/console/src/styles.css \
        packages/console/src/panels/Play/__tests__/Composer.test.tsx
git commit -m "feat(console): per-source template picker replaces the hardcoded session genre fork"
```

---

## Definition of done

- [ ] `pnpm build && pnpm test` green from a clean `dist/`.
- [ ] `scaffoldFor()` returns a gate-passing bundle for `heatmap`, `project-map`, `skill-tuner`.
- [ ] `genres.test.ts` iterates `GAME_GENRES` and fails if any genre is half-wired.
- [ ] Seeding a session source with a skill genre throws a named error.
- [ ] Composer shows only the selected source kind's templates; console builds locally.
- [ ] Both new templates verified rendering in a real browser (not just jsdom).
- [ ] PR opened against `origin/main`; `test (24)` green before merge; each commit's content verified on `origin/main` after merge.
