# Usage-aware Lapidary Ledger Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let the Lapidary Ledger sort discovered artifacts by usage count / last-used time and hide never-used ones (default: show only used).

**Architecture:** A new best-effort `GET /api/usage` endpoint runs the existing synchronous `scanWorkflow()` for the active testbed and returns `ArtifactUsage[]`. The ledger client joins that onto its rows by `(type, name, root)`, stamping `data-invocations`/`data-lastused` + a badge, then layers two clickable sort-header toggles and a "Used only" filter onto the existing `filterRows()`/group machinery.

**Tech Stack:** TypeScript, Zod, `@agentback/openapi` decorators, Vitest. Client is plain inline JS in `src/public/index.html` (served static — no build/typecheck, no JS test harness; verified by the server tests + manual load).

## Global Constraints

- Spec: `docs/superpowers/specs/2026-06-27-ledger-usage-sort-filter-design.md`.
- Git identity for every commit: `Raymond Feng <raymond@ninemind.ai>` (`git -c user.name=... -c user.email=...`). End commit messages with `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`.
- Tests run from compiled `dist/` (`pnpm test` == `tsc -b && vitest run`). To run one test, build first then filter by name: `pnpm build && npx vitest run -t "<name>"`.
- The ledger shows ONLY the active testbed's project artifacts (globals are out of scope — reached via Import). Usage join keys on `root = activeTestbed`.
- `/api/usage` is best-effort: any failure returns `{ artifacts: [] }`, never a 500. The ledger must render regardless.
- "Used only" applies ONLY to Skills and MCP servers. Instructions and Hooks are always exempt (passive — no `tool_use`).
- Surgical changes only: do not refactor `renderInventoryPane()`, `filterRows()`, or the inventory endpoint beyond what each task requires.

---

### Task 1: `GET /api/usage` endpoint + `UsageSchema`

**Files:**
- Modify: `src/schemas.ts` (add `UsageItemSchema` + `UsageSchema` near `InventorySchema`, ~line 111-117)
- Modify: `src/gem.controller.ts` (add `usage()` method after `inventory()` at line 88-91; extend the schema import on line 28)
- Test: `src/gem/__tests__/usage.test.ts` (create)

**Interfaces:**
- Consumes (already exist):
  - `scanWorkflow(paths: string[], inv: ScanInventory, opts?): WorkflowSignal` and `claudeTranscriptsForCwd(claudeDir: string, root: string): string[]` from `./gem/workflowScan.js`
  - `introspectProject(root)`, `introspectConfig(dirs)` from `./gem/introspect.js`
  - `resolveDirs(dir?)`, `resolveProject(p)` from `./resolveDir.js`
  - `parseProjectsQuery(s?)` already used in `inventory()`
  - `DirQuerySchema` = `{ dir?: string; projects?: string }`
  - `ArtifactUsage` fields: `type, name, root, invocations, sessionsUsedIn, lastUsedMs`
- Produces (later tasks rely on):
  - `GET /api/usage?projects=<json-array>&dir=<opt>` → `{ artifacts: Array<{ type, name, root: string|null, invocations: number, sessionsUsedIn: number, lastUsedMs: number|null }> }`
  - Uses the FIRST entry of `projects` as the project root (the ledger sends `projects=[activeTestbed]`).

- [ ] **Step 1: Write the failing test**

Create `src/gem/__tests__/usage.test.ts` (mirrors the fixture style of `workflowAnalyze.test.ts`):

```ts
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GemController } from "../../gem.controller.js";

let home: string, projectRoot: string, claudeDir: string;
beforeAll(() => {
  home = mkdtempSync(join(tmpdir(), "usage-"));
  claudeDir = join(home, ".claude");
  projectRoot = join(home, "proj");
  const skillDir = join(projectRoot, ".claude", "skills", "qa");
  mkdirSync(skillDir, { recursive: true });
  writeFileSync(join(skillDir, "SKILL.md"), "---\nname: qa\ndescription: qa\n---\nbody");
  const folder = join(claudeDir, "projects", "enc");
  mkdirSync(folder, { recursive: true });
  writeFileSync(join(folder, "s.jsonl"), [
    JSON.stringify({ cwd: projectRoot }),
    JSON.stringify({ type: "assistant", message: { role: "assistant", content: [{ type: "tool_use", name: "Skill", input: { skill: "qa" } }] } }),
  ].join("\n") + "\n");
});
afterAll(() => rmSync(home, { recursive: true, force: true }));

describe("GET /api/usage", () => {
  it("reports invocations + lastUsedMs for a skill that fired", async () => {
    const res = await new GemController().usage({ query: { dir: claudeDir, projects: JSON.stringify([projectRoot]) } });
    const qa = res.artifacts.find((a) => a.type === "skill" && a.name === "qa");
    expect(qa).toBeTruthy();
    expect(qa!.invocations).toBeGreaterThan(0);
    expect(qa!.lastUsedMs == null).toBe(false);
  });

  it("returns empty artifacts (no throw) when no project is given", async () => {
    const res = await new GemController().usage({ query: {} });
    expect(res.artifacts).toEqual([]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm build && npx vitest run -t "GET /api/usage"`
Expected: FAIL — `usage` is not a method on `GemController` (TS build error or runtime "not a function").

- [ ] **Step 3: Add the schemas**

In `src/schemas.ts`, immediately after the `InventorySchema` block (~line 117), add:

```ts
export const UsageItemSchema = z.object({
  type: z.string(),
  name: z.string(),
  root: z.string().nullable(),
  invocations: z.number(),
  sessionsUsedIn: z.number(),
  lastUsedMs: z.number().nullable(),
});
export const UsageSchema = z.object({ artifacts: z.array(UsageItemSchema) });
```

- [ ] **Step 4: Add the controller endpoint**

In `src/gem.controller.ts`:

1. Add `UsageSchema` to the schema import group (the `import { ... } from "./schemas.js"` block that includes `InventorySchema`, around line 27-28).
2. Ensure `scanWorkflow` + `claudeTranscriptsForCwd` are imported from `./gem/workflowScan.js` (add the import if absent).
3. Add this method directly after `inventory()` (after line 91):

```ts
@get("/usage", { query: DirQuerySchema, response: UsageSchema })
async usage(input: { query: z.infer<typeof DirQuerySchema> }): Promise<z.infer<typeof UsageSchema>> {
  try {
    const roots = parseProjectsQuery(input.query.projects);
    const root = roots[0];
    if (!root) return { artifacts: [] };
    const dirs = resolveDirs(input.query.dir);
    const project = introspectProject(resolveProject(root));
    const globalInv = introspectConfig(dirs);
    const scanInv = { project, global: { skills: globalInv.skills, mcpServers: globalInv.mcpServers, hooks: globalInv.hooks } };
    const paths = claudeTranscriptsForCwd(dirs.claudeDir, root);
    const signal = scanWorkflow(paths, scanInv);
    return { artifacts: signal.artifacts.map((a) => ({
      type: a.type, name: a.name, root: a.root,
      invocations: a.invocations, sessionsUsedIn: a.sessionsUsedIn, lastUsedMs: a.lastUsedMs,
    })) };
  } catch {
    return { artifacts: [] };
  }
}
```

Note: `parseProjectsQuery` returns the parsed `projects` array; confirm it accepts the raw query string the way `inventory()` uses it. The `scanInv` shape is copied verbatim from `src/workflowStream.ts:44`.

- [ ] **Step 5: Run test to verify it passes**

Run: `pnpm build && npx vitest run -t "GET /api/usage"`
Expected: PASS (both cases).

- [ ] **Step 6: Run the full suite for regressions**

Run: `pnpm test`
Expected: PASS (no existing test breaks).

- [ ] **Step 7: Commit**

```bash
git add src/schemas.ts src/gem.controller.ts src/gem/__tests__/usage.test.ts
git -c user.name="Raymond Feng" -c user.email="raymond@ninemind.ai" commit -m "feat(ledger): GET /api/usage — per-artifact invocations + lastUsedMs

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 2: Client — fetch usage and decorate ledger rows

**Files:**
- Modify: `src/public/index.html` — `load()` (~line 773-785) and add a `decorateUsage()` helper; tweak the row badge in `group()` is NOT needed (badge is appended by `decorateUsage`).

**Interfaces:**
- Consumes: `GET /api/usage?projects=<json>` from Task 1; the rendered rows produced by `renderInventoryPane()` — each `#inventory label.row` has a checkbox with `data-kind` (`projectSkills`/`projectMcpServers`/`projectHooks`/`projectInstructions`) and `data-name`; `activeTestbed` is the project root.
- Produces (later tasks rely on): every `#inventory label.row` carries `data-invocations` (string int, default `"0"`), `data-lastused` (string epoch-ms, default `""`), and `data-passive` (`"1"` for instructions/hooks, else absent). A `.usebadge` span is appended inside the row's `<span>`.

- [ ] **Step 1: Add the kind→type map and `decorateUsage()` helper**

In `src/public/index.html`, near `renderInventoryPane()` (after it, ~line 811), add:

```js
// Map a ledger checkbox kind to the usage artifact type from /api/usage.
const KIND_TO_USAGE_TYPE = {
  projectSkills: "skill", projectMcpServers: "mcp_server",
  projectHooks: "hook", projectInstructions: "instructions",
};
function fmtDay(ms){ try { return new Date(ms).toISOString().slice(0,10); } catch { return ""; } }

// Join /api/usage onto the freshly rendered rows: stamp data-* and append a badge.
async function decorateUsage(){
  let artifacts = [];
  try {
    const qs = `?projects=${encodeURIComponent(JSON.stringify(projects))}`;
    const r = await fetch("/api/usage" + qs);
    artifacts = (await r.json()).artifacts || [];
  } catch { artifacts = []; }   // best-effort: rows keep zero usage
  const map = new Map();        // `${type}|${name}|${root}` -> {invocations,lastUsedMs}
  for (const a of artifacts) map.set(`${a.type}|${a.name}|${a.root}`, a);

  document.querySelectorAll("#inventory label.row").forEach(row => {
    const cb = row.querySelector("input[type=checkbox]");
    const kind = cb && cb.dataset.kind;
    const type = KIND_TO_USAGE_TYPE[kind];
    const passive = type === "instructions" || type === "hook";
    if (passive) row.dataset.passive = "1";
    const u = type ? map.get(`${type}|${(cb.dataset.name)||""}|${activeTestbed}`) : null;
    const inv = u ? u.invocations : 0;
    row.dataset.invocations = String(inv);
    row.dataset.lastused = u && u.lastUsedMs ? String(u.lastUsedMs) : "";
    // badge: only for non-passive, used artifacts
    const host = row.querySelector("span");
    const old = host && host.querySelector(".usebadge");
    if (old) old.remove();
    if (host && !passive && inv > 0) {
      const day = u && u.lastUsedMs ? ` · ${esc(fmtDay(u.lastUsedMs))}` : "";
      host.insertAdjacentHTML("beforeend", ` <span class="usebadge d">· ${inv} use${inv===1?"":"s"}${day}</span>`);
    }
  });
}
```

- [ ] **Step 2: Call it after render in `load()`**

In `load()`, after `renderInventoryPane();` (line 784), add:

```js
  await decorateUsage();   // best-effort usage join; never blocks the ledger
```

(Leave the existing `renderInventoryPane()` call inside other flows as-is — Task 4 re-applies the filter; usage decoration only needs to run on `load()`.)

- [ ] **Step 3: Verify manually**

Run: `pnpm dev` (builds + starts the server). Open the app, open/select a testbed whose project skills have been used in past sessions.
Expected: used Skills/MCP rows show a `· N uses · YYYY-MM-DD` badge; never-used rows show none; Instructions/Hooks show none. In devtools, those rows have `data-invocations`/`data-lastused` set; passive rows have `data-passive="1"`.

- [ ] **Step 4: Commit**

```bash
git add src/public/index.html
git -c user.name="Raymond Feng" -c user.email="raymond@ninemind.ai" commit -m "feat(ledger): join /api/usage onto rows with a usage badge

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 3: Client — two clickable sort-header toggles

**Files:**
- Modify: `src/public/index.html` — add two toggle controls to the filter bar (near the search/source/agent/type controls, the `#typeBar`/`#agentBar` area ~line 250-257 markup region and their wiring ~line 804); add `sortRows()`; stamp original order at render.

**Interfaces:**
- Consumes: `data-invocations` / `data-lastused` from Task 2; the `#inventory .group` containers and their `label.row` children.
- Produces: a module-level `sortState = { key: null|"uses"|"last", dir: "desc"|"asc" }`; a `sortRows()` that reorders rows within each group; rows carry `data-order` (original index) so "off" restores insertion order.

- [ ] **Step 1: Add the toggle markup**

In the filter-bar markup (alongside the existing search/source controls, ~line 250), add:

```html
<button type="button" id="sortUses" class="sortbtn" title="sort by usage count">Uses</button>
<button type="button" id="sortLast" class="sortbtn" title="sort by last used">Last used</button>
```

Add minimal CSS near the Lapidary Ledger styles (~line 16+):

```css
.sortbtn{font:inherit;cursor:pointer;border:1px solid var(--line);background:transparent;border-radius:6px;padding:2px 8px}
.sortbtn[data-dir]{border-color:var(--seal);font-weight:600}
.sortbtn[data-dir=desc]::after{content:" ↓"}
.sortbtn[data-dir=asc]::after{content:" ↑"}
```

- [ ] **Step 2: Stamp original order at render**

In `renderInventoryPane()`, in the existing `document.querySelectorAll("#inventory label.row").forEach(row => {...})` block (~line 800), add inside the loop:

```js
    row.dataset.order = String([...row.parentNode.querySelectorAll("label.row")].indexOf(row));
```

- [ ] **Step 3: Add `sortRows()` and the toggle wiring**

After `decorateUsage()` (Task 2), add:

```js
let sortState = { key: null, dir: "desc" };
function sortRows(){
  document.querySelectorAll("#inventory .group").forEach(g => {
    const rows = [...g.querySelectorAll("label.row")];
    rows.sort((a, b) => {
      if (!sortState.key) return Number(a.dataset.order) - Number(b.dataset.order);
      const f = sortState.key === "uses" ? "invocations" : "lastused";
      const av = Number(a.dataset[f] || 0), bv = Number(b.dataset[f] || 0);
      return sortState.dir === "desc" ? bv - av : av - bv;
    });
    rows.forEach(r => g.appendChild(r));   // re-append in sorted order
  });
}
function cycleSort(key){
  if (sortState.key !== key) { sortState = { key, dir: "desc" }; }
  else if (sortState.dir === "desc") { sortState.dir = "asc"; }
  else { sortState = { key: null, dir: "desc" }; }   // desc -> asc -> off
  // reflect button state (mutually exclusive)
  const map = { uses: "sortUses", last: "sortLast" };
  for (const k of Object.keys(map)) {
    const el = document.getElementById(map[k]);
    if (sortState.key === k) el.dataset.dir = sortState.dir; else el.removeAttribute("data-dir");
  }
  sortRows();
}
document.getElementById("sortUses").addEventListener("click", () => cycleSort("uses"));
document.getElementById("sortLast").addEventListener("click", () => cycleSort("last"));
```

- [ ] **Step 4: Re-apply sort after a usage decoration**

At the end of `decorateUsage()`, add `sortRows();` so a sort chosen before a re-render survives.

- [ ] **Step 5: Verify manually**

Run: `pnpm dev`, open a testbed with mixed usage.
Expected: clicking **Uses** orders each group by count desc (↓), again → asc (↑), again → original order. **Last used** behaves the same and deactivates **Uses** when clicked. Sorting stays within Skills / MCP / Hooks groups.

- [ ] **Step 6: Commit**

```bash
git add src/public/index.html
git -c user.name="Raymond Feng" -c user.email="raymond@ninemind.ai" commit -m "feat(ledger): clickable Uses / Last-used sort toggles (within groups)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 4: Client — "Used only" filter, on by default

**Files:**
- Modify: `src/public/index.html` — add the checkbox markup to the filter bar; extend `filterRows()` (~line 885-913); ensure it runs after `decorateUsage()`.

**Interfaces:**
- Consumes: `data-invocations` and `data-passive` from Task 2; the existing `filterRows()` predicate and group-count update.
- Produces: a `#usedOnly` checkbox (`checked` by default) folded into the `filterRows()` match predicate.

- [ ] **Step 1: Add the checkbox markup**

In the filter bar (near the sort buttons from Task 3), add:

```html
<label class="chk"><input type="checkbox" id="usedOnly" checked> Used only</label>
```

- [ ] **Step 2: Fold it into `filterRows()`**

In `filterRows()` (~line 885), after the existing filter values are read, add:

```js
  const usedOnly = (document.getElementById("usedOnly") || {}).checked;
```

Then in the per-row predicate inside `document.querySelectorAll("#inventory label.row").forEach(row => {...})`, compute and AND in the used match (passive rows always pass):

```js
    const matchUsed = !usedOnly || row.dataset.passive === "1" || Number(row.dataset.invocations || 0) > 0;
```

and change the visibility line to include it:

```js
    row.style.display = matchQ && matchSrc && matchAgent && matchType && matchUsed ? "" : "none";
```

Also include `usedOnly` (when checked) in the `active` flag so group counts show "— showing N":

```js
  const active = q || src || agentFilterActive || typeFilterActive || usedOnly;
```

- [ ] **Step 3: Wire the change handler and re-filter after decoration**

After the sort wiring (Task 3), add:

```js
const usedOnlyEl = document.getElementById("usedOnly");
if (usedOnlyEl) usedOnlyEl.addEventListener("change", filterRows);
```

At the end of `decorateUsage()` (after `sortRows()`), add `filterRows();` so the default "Used only" state hides never-used rows once usage data lands.

- [ ] **Step 4: Verify manually**

Run: `pnpm dev`, open a testbed.
Expected: on load, only used Skills/MCP rows are visible, plus ALL Instructions and Hooks (passive, exempt). Unticking **Used only** reveals never-used Skills/MCP. Search/source/agent/type filters still compose. Group headers read "— showing N".

- [ ] **Step 5: Full suite + commit**

Run: `pnpm test`
Expected: PASS (server unaffected).

```bash
git add src/public/index.html
git -c user.name="Raymond Feng" -c user.email="raymond@ninemind.ai" commit -m "feat(ledger): 'Used only' filter (on by default; passive types exempt)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Self-Review

**Spec coverage:**
- §1 server `/api/usage` → Task 1. ✓
- §2 client join + badge → Task 2. ✓
- §3 two clickable sort headers (desc→asc→off, mutually exclusive, within groups) → Task 3. ✓
- §4 "Used only" on by default, folded into `filterRows()` → Task 4. ✓
- Passive exemption (Instructions/Hooks) → Task 2 stamps `data-passive`, Task 4 honors it. ✓
- Error handling (best-effort `[]`, graceful degrade) → Task 1 try/catch + Task 2 fetch catch. ✓
- Testing: server endpoint covered by `usage.test.ts`; client has no harness in this repo (index.html is static, untested) → manual verification steps, stated honestly. ✓
- Out-of-scope items (scan cache, globals, cross-group sort, `sessionsUsedIn` in UI) → not implemented. ✓

**Placeholder scan:** No TBD/TODO; all code blocks complete. ✓

**Type consistency:** `decorateUsage`/`sortRows`/`filterRows`/`cycleSort` names consistent across tasks; `data-invocations`/`data-lastused`/`data-passive`/`data-order` attribute names consistent; usage types `skill`/`mcp_server`/`hook`/`instructions` match `ArtifactType`. ✓

**Note on testing honesty:** The client logic (Tasks 2-4) is inline JS in a static HTML file with no existing JS test harness. Per the user's coding rules, this is stated plainly rather than fabricating a harness; if a jsdom/vitest-dom harness is desired later, the pure helpers (`sortRows` comparator, the used-match predicate) are written to be extractable. The real branching logic — the scan and join — lives server-side and IS unit-tested.
