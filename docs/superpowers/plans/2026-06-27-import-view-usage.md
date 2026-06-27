# Import-view Usage Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Show cross-project usage (badges + Uses/Last-used sort + "Used only" filter) on global artifacts in the Import view, sourced from all Claude transcripts.

**Architecture:** Extend `GET /api/usage` with a `scope=global` mode that scans ALL Claude transcripts against an empty project inventory (so calls attribute to globals), cached by a transcript token. The Import modal reuses the ledger's usage machinery (extracted shared helpers) to badge/sort/filter global rows.

**Tech Stack:** TypeScript, Zod, `@agentback/openapi` decorators, Vitest. Client is plain inline JS in `src/public/index.html` (static — no build/typecheck, no JS test harness; verified by server tests + manual open).

## Global Constraints

- Spec: `docs/superpowers/specs/2026-06-27-import-view-usage-design.md`.
- Git identity for every commit: `Raymond Feng <raymond@ninemind.ai>` (`git -c user.name=... -c user.email=...`). End commit messages with `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`.
- Tests run from compiled `dist/` (`pnpm test` == `tsc -b && vitest run`). To run one test: `pnpm build && npx vitest run -t "<name>"`. ALWAYS `pnpm build` before vitest.
- `/api/usage` stays best-effort: any failure returns `{ artifacts: [] }`, never a 500.
- `scope=global` counts usage across ALL projects from CLAUDE transcripts only. Codex/agents/hermes are out of scope (separate spec / not scannable).
- Import "parity" = badges + Uses/Last-used sort + "Used only" filter (default ON). NOT the ledger's search/source/agent/type stack.
- Passive types (Instructions/Hooks) are always exempt from "Used only"; checked rows are always visible; a `…UsageLoaded` gate suppresses the filter until usage data lands (no first-paint flash).
- Surgical: do not change ledger behavior. The shared-helper extraction (Task 3) must keep `#inventory` behaving identically.

---

### Task 1: `scope=global` mode on `/api/usage` + `allClaudeTranscripts`

**Files:**
- Modify: `src/schemas.ts` (add `UsageQuerySchema` after `DirQuerySchema`, line ~330)
- Modify: `src/gem/workflowScan.ts` (add `allClaudeTranscripts` after `claudeTranscriptsForCwd`, ~line 89)
- Modify: `src/gem.controller.ts` (point `usage()` at `UsageQuerySchema`; add a `scope==="global"` branch; import `allClaudeTranscripts`)
- Test: `src/gem/__tests__/usageGlobal.test.ts` (create)

**Interfaces:**
- Consumes: `introspectConfig(dirs)`, `resolveDirs`, `scanWorkflow`, `claudeTranscriptsForCwd` (all already imported in the controller); `UsageItemSchema`/`UsageSchema` (already in schemas).
- Produces:
  - `allClaudeTranscripts(claudeDir: string): string[]` — every `~/.claude/projects/*/*.jsonl`, no cwd filter.
  - `GET /api/usage?scope=global` → `{ artifacts: Array<{type,name,root:null,invocations,sessionsUsedIn,lastUsedMs}> }` (globals only). `scope` absent = existing per-project behavior.
  - `UsageQuerySchema` = `{ dir?: string; projects?: string; scope?: "global" }`.

- [ ] **Step 1: Write the failing test**

Create `src/gem/__tests__/usageGlobal.test.ts`:

```ts
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GemController } from "../../gem.controller.js";

let home: string, claudeDir: string;
beforeAll(() => {
  home = mkdtempSync(join(tmpdir(), "uglobal-"));
  claudeDir = join(home, ".claude");
  // a GLOBAL skill (lives under claudeDir/skills) used across two projects
  const gskill = join(claudeDir, "skills", "diagram");
  mkdirSync(gskill, { recursive: true });
  writeFileSync(join(gskill, "SKILL.md"), "---\nname: diagram\ndescription: d\n---\nbody");
  const tu = (skill: string) => JSON.stringify({ type: "assistant", message: { role: "assistant", content: [{ type: "tool_use", name: "Skill", input: { skill } }] } });
  // project A: 2x diagram + 1x a project-only skill "localthing" (no global SKILL.md)
  const a = join(claudeDir, "projects", "encA"); mkdirSync(a, { recursive: true });
  writeFileSync(join(a, "a.jsonl"), [JSON.stringify({ cwd: "/projA" }), tu("diagram"), tu("diagram"), tu("localthing")].join("\n") + "\n");
  // project B: 3x diagram
  const b = join(claudeDir, "projects", "encB"); mkdirSync(b, { recursive: true });
  writeFileSync(join(b, "b.jsonl"), [JSON.stringify({ cwd: "/projB" }), tu("diagram"), tu("diagram"), tu("diagram")].join("\n") + "\n");
});
afterAll(() => rmSync(home, { recursive: true, force: true }));

describe("GET /api/usage?scope=global", () => {
  it("aggregates a global skill across all projects", async () => {
    const res = await new GemController().usage({ query: { dir: claudeDir, scope: "global" } });
    const diagram = res.artifacts.find((a) => a.type === "skill" && a.name === "diagram");
    expect(diagram).toBeTruthy();
    expect(diagram!.invocations).toBe(5);     // 2 (A) + 3 (B)
    expect(diagram!.root).toBeNull();
  });
  it("excludes project-only skills not in the global inventory", async () => {
    const res = await new GemController().usage({ query: { dir: claudeDir, scope: "global" } });
    expect(res.artifacts.find((a) => a.name === "localthing")).toBeFalsy();
  });
  it("returns empty (no throw) when there are no transcripts", async () => {
    const empty = mkdtempSync(join(tmpdir(), "ugempty-"));
    const res = await new GemController().usage({ query: { dir: join(empty, ".claude"), scope: "global" } });
    expect(res.artifacts).toEqual([]);
    rmSync(empty, { recursive: true, force: true });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm build && npx vitest run -t "scope=global"`
Expected: FAIL — `usage()` ignores `scope`, so it returns `[]` (no `projects`) → `diagram` not found (or a TS error on the `scope` query field).

- [ ] **Step 3: Add `UsageQuerySchema`**

In `src/schemas.ts`, immediately after the `DirQuerySchema` line (~330):

```ts
export const UsageQuerySchema = z.object({
  dir: z.string().optional(),
  projects: z.string().optional(),
  scope: z.enum(["global"]).optional(),
});
```

- [ ] **Step 4: Add `allClaudeTranscripts`**

In `src/gem/workflowScan.ts`, right after `claudeTranscriptsForCwd` ends (before `export function safeMtime`, ~line 89):

```ts
/** Every Claude transcript under ~/.claude/projects, regardless of cwd. */
export function allClaudeTranscripts(claudeDir: string): string[] {
  const projectsDir = join(claudeDir, "projects");
  let folders: import("node:fs").Dirent[];
  try { folders = readdirSync(projectsDir, { withFileTypes: true }); } catch { return []; }
  const out: string[] = [];
  for (const folder of folders) {
    if (!folder.isDirectory()) continue;
    const dir = join(projectsDir, folder.name);
    let files: string[];
    try { files = readdirSync(dir); } catch { continue; }
    for (const f of files) if (f.endsWith(".jsonl")) out.push(join(dir, f));
  }
  return out;
}
```

- [ ] **Step 5: Add the global branch to `usage()`**

In `src/gem.controller.ts`:
1. Change the `usage()` decorator + signature to use `UsageQuerySchema` (add it to the `./schemas.js` import group; it currently uses `DirQuerySchema`):
   ```ts
   @get("/usage", { query: UsageQuerySchema, response: UsageSchema })
   async usage(input: { query: z.infer<typeof UsageQuerySchema> }): Promise<z.infer<typeof UsageSchema>> {
   ```
2. Add `allClaudeTranscripts` to the `./gem/workflowScan.js` import (alongside `scanWorkflow`, `claudeTranscriptsForCwd`).
3. As the FIRST thing inside the existing `try {`, add the global branch:
   ```ts
   if (input.query.scope === "global") {
     const dirs = resolveDirs(input.query.dir);
     const paths = allClaudeTranscripts(dirs.claudeDir);
     const globalInv = introspectConfig(dirs);
     const emptyProject = { root: "", name: "", skills: [], mcpServers: [], instructions: [], hooks: [] };
     const scanInv = { project: emptyProject, global: { skills: globalInv.skills, mcpServers: globalInv.mcpServers, hooks: globalInv.hooks } };
     const signal = scanWorkflow(paths, scanInv);
     return { artifacts: signal.artifacts
       .filter((a) => a.root === null)
       .map((a) => ({ type: a.type, name: a.name, root: a.root, invocations: a.invocations, sessionsUsedIn: a.sessionsUsedIn, lastUsedMs: a.lastUsedMs })) };
   }
   ```
   (The existing per-project code stays below it, unchanged. The whole method body remains wrapped in the existing `try/catch → { artifacts: [] }`.)

Note: `introspectProject`'s `ProjectInventory` type may require the exact field set `{ root, name, skills, mcpServers, instructions, hooks }`. The `emptyProject` literal matches that shape; if TS complains about a missing field, add it as an empty array — do not change `scanWorkflow`.

- [ ] **Step 6: Run the test to verify it passes**

Run: `pnpm build && npx vitest run -t "scope=global"`
Expected: PASS (all three cases).

- [ ] **Step 7: Run the full suite**

Run: `pnpm test`
Expected: PASS (existing per-project `/api/usage` tests in `usage.test.ts` still green).

- [ ] **Step 8: Commit**

```bash
git add src/schemas.ts src/gem/workflowScan.ts src/gem.controller.ts src/gem/__tests__/usageGlobal.test.ts
git -c user.name="Raymond Feng" -c user.email="raymond@ninemind.ai" commit -m "feat(usage): GET /api/usage?scope=global — cross-project global usage

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 2: Cache the global usage scan

**Files:**
- Create: `src/gem/usageCache.ts`
- Modify: `src/gem.controller.ts` (wrap the global scan in cache read/write)
- Test: `src/gem/__tests__/usageCache.test.ts` (create)

**Interfaces:**
- Consumes: `transcriptToken(paths: string[]): string` and `agentgemHome()` (from `analysisCache.ts` / `resolveDir.ts`); `allClaudeTranscripts` (Task 1).
- Produces:
  - `readGlobalUsageCache(token: string): { artifacts: unknown[] } | null`
  - `writeGlobalUsageCache(token: string, result: { artifacts: unknown[] }): void`
  - Behavior: single persistent entry at `~/.agentgem/global-usage-cache.json` (`{ token, result }`); a token mismatch or any IO error reads as a miss (`null`). Best-effort; never throws.

- [ ] **Step 1: Write the failing test**

Create `src/gem/__tests__/usageCache.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readGlobalUsageCache, writeGlobalUsageCache } from "../usageCache.js";

let home: string, prev: string | undefined;
beforeEach(() => { home = mkdtempSync(join(tmpdir(), "ugcache-")); prev = process.env.AGENTGEM_HOME; process.env.AGENTGEM_HOME = home; });
afterEach(() => { if (prev === undefined) delete process.env.AGENTGEM_HOME; else process.env.AGENTGEM_HOME = prev; rmSync(home, { recursive: true, force: true }); });

describe("global usage cache", () => {
  it("returns the stored result for a matching token", () => {
    const r = { artifacts: [{ type: "skill", name: "diagram", root: null, invocations: 5, sessionsUsedIn: 2, lastUsedMs: 1 }] };
    writeGlobalUsageCache("tok-1", r);
    expect(readGlobalUsageCache("tok-1")).toEqual(r);
  });
  it("returns null for a different token (stale)", () => {
    writeGlobalUsageCache("tok-1", { artifacts: [] });
    expect(readGlobalUsageCache("tok-2")).toBeNull();
  });
  it("returns null when nothing was ever written", () => {
    expect(readGlobalUsageCache("anything")).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm build && npx vitest run -t "global usage cache"`
Expected: FAIL — `../usageCache.js` does not exist.

- [ ] **Step 3: Create the cache module**

Create `src/gem/usageCache.ts` (mirrors `analysisCache.ts`'s best-effort style):

```ts
// src/gem/usageCache.ts
//
// Single-entry persistent cache for the (expensive: reads every transcript)
// global usage scan. Keyed by a transcript token that changes whenever any
// session is added/updated, so it self-refreshes. Best-effort: failures never throw.
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { agentgemHome } from "../resolveDir.js";

function cachePath(): string { return join(agentgemHome(), ".agentgem", "global-usage-cache.json"); }

export function readGlobalUsageCache(token: string): { artifacts: unknown[] } | null {
  try {
    const j = JSON.parse(readFileSync(cachePath(), "utf8")) as { token?: string; result?: { artifacts: unknown[] } };
    return j && j.token === token && j.result ? j.result : null;
  } catch { return null; }
}

export function writeGlobalUsageCache(token: string, result: { artifacts: unknown[] }): void {
  try {
    const path = cachePath();
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify({ token, result }), "utf8");
  } catch { /* best-effort */ }
}
```

- [ ] **Step 4: Run the cache test to verify it passes**

Run: `pnpm build && npx vitest run -t "global usage cache"`
Expected: PASS (all three).

- [ ] **Step 5: Wire the cache into the global branch**

In `src/gem.controller.ts`, import `transcriptToken` (from `./gem/analysisCache.js`, where `readAnalysisCache`/`writeAnalysisCache` already come from) and `readGlobalUsageCache, writeGlobalUsageCache` (from `./gem/usageCache.js`). Update the global branch from Task 1 to consult the cache:

```ts
if (input.query.scope === "global") {
  const dirs = resolveDirs(input.query.dir);
  const paths = allClaudeTranscripts(dirs.claudeDir);
  const token = transcriptToken(paths);
  const cached = readGlobalUsageCache(token);
  if (cached) return cached as z.infer<typeof UsageSchema>;
  const globalInv = introspectConfig(dirs);
  const emptyProject = { root: "", name: "", skills: [], mcpServers: [], instructions: [], hooks: [] };
  const scanInv = { project: emptyProject, global: { skills: globalInv.skills, mcpServers: globalInv.mcpServers, hooks: globalInv.hooks } };
  const signal = scanWorkflow(paths, scanInv);
  const result = { artifacts: signal.artifacts
    .filter((a) => a.root === null)
    .map((a) => ({ type: a.type, name: a.name, root: a.root, invocations: a.invocations, sessionsUsedIn: a.sessionsUsedIn, lastUsedMs: a.lastUsedMs })) };
  writeGlobalUsageCache(token, result);
  return result;
}
```

- [ ] **Step 6: Verify the endpoint still passes + full suite**

Run: `pnpm test`
Expected: PASS — the `scope=global` tests from Task 1 still pass (a fresh temp home means a cache miss then populate; identical results), plus the new cache unit tests, plus everything else.

- [ ] **Step 7: Commit**

```bash
git add src/gem/usageCache.ts src/gem.controller.ts src/gem/__tests__/usageCache.test.ts
git -c user.name="Raymond Feng" -c user.email="raymond@ninemind.ai" commit -m "feat(usage): cache the global usage scan by transcript token

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 3: Extract shared client helpers (badge + sortRowsIn)

**Files:**
- Modify: `src/public/index.html` (add `usageBadgeHtml`; refactor `decorateUsage` badge build; add `sortRowsIn`; refactor `sortRows`)

**Interfaces:**
- Consumes: existing `fmtDay`, `esc`.
- Produces (Task 4 relies on these):
  - `usageBadgeHtml(inv, lastUsedMs)` → the ` <span class="usebadge d">· N use(s) · date</span>` string (date omitted when `lastUsedMs` falsy).
  - `sortRowsIn(containerSel, state)` → sorts `label.row` within each `${containerSel} .group` by `state` (`{key:null|"uses"|"last", dir:"desc"|"asc"}`); `key:null` restores `data-order`.

This is a pure refactor — the ledger (`#inventory`) must behave identically. No new tests (no client harness); verified by `pnpm build` + reading.

- [ ] **Step 1: Add `usageBadgeHtml` and use it in `decorateUsage`**

In `src/public/index.html`, just after `fmtDay` (line ~824) add:

```js
function usageBadgeHtml(inv, lastUsedMs){
  const day = lastUsedMs ? ` · ${esc(fmtDay(lastUsedMs))}` : "";
  return ` <span class="usebadge d">· ${inv} use${inv===1?"":"s"}${day}</span>`;
}
```

Then in `decorateUsage()` replace the inline badge build (currently):

```js
    if (host && !passive && inv > 0) {
      const day = u && u.lastUsedMs ? ` · ${esc(fmtDay(u.lastUsedMs))}` : "";
      host.insertAdjacentHTML("beforeend", ` <span class="usebadge d">· ${inv} use${inv===1?"":"s"}${day}</span>`);
    }
```

with:

```js
    if (host && !passive && inv > 0) host.insertAdjacentHTML("beforeend", usageBadgeHtml(inv, u.lastUsedMs));
```

- [ ] **Step 2: Add `sortRowsIn` and refactor `sortRows`**

Replace the current `sortRows()` (lines ~862-873):

```js
function sortRows(){
  document.querySelectorAll("#inventory .group").forEach(g => {
    const rows = [...g.querySelectorAll("label.row")];
    rows.sort((a, b) => {
      if (!sortState.key) return Number(a.dataset.order) - Number(b.dataset.order);
      const f = sortState.key === "uses" ? "invocations" : "lastused";
      const av = Number(a.dataset[f] || 0), bv = Number(b.dataset[f] || 0);
      return sortState.dir === "desc" ? bv - av : av - bv;
    });
    rows.forEach(r => g.appendChild(r));
  });
}
```

with a generalized version plus a thin wrapper that preserves the ledger call:

```js
function sortRowsIn(containerSel, state){
  document.querySelectorAll(containerSel + " .group").forEach(g => {
    const rows = [...g.querySelectorAll("label.row")];
    rows.sort((a, b) => {
      if (!state.key) return Number(a.dataset.order) - Number(b.dataset.order);
      const f = state.key === "uses" ? "invocations" : "lastused";
      const av = Number(a.dataset[f] || 0), bv = Number(b.dataset[f] || 0);
      return state.dir === "desc" ? bv - av : av - bv;
    });
    rows.forEach(r => g.appendChild(r));
  });
}
function sortRows(){ sortRowsIn("#inventory", sortState); }
```

(`cycleSort` still calls `sortRows()` — unchanged. `decorateUsage` still calls `sortRows()` — unchanged.)

- [ ] **Step 3: Build and verify no regression**

Run: `pnpm build`
Expected: success. Re-read the two edited regions: `decorateUsage` badge line now calls `usageBadgeHtml(inv, u.lastUsedMs)`; `sortRows()` delegates to `sortRowsIn("#inventory", sortState)`; the comparator logic inside `sortRowsIn` is identical to the old `sortRows` (just `sortState` → `state`, `#inventory` → `containerSel`).

- [ ] **Step 4: Commit**

```bash
git add src/public/index.html
git -c user.name="Raymond Feng" -c user.email="raymond@ninemind.ai" commit -m "refactor(ledger): extract usageBadgeHtml + sortRowsIn (no behavior change)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 4: Import-view badges, sort, and "Used only" filter

**Files:**
- Modify: `src/public/index.html` (import modal markup; `openImport()`; new `decorateImportUsage`, `cycleImportSort`, `filterImportRows`; one-time wiring)

**Interfaces:**
- Consumes: `usageBadgeHtml`, `sortRowsIn` (Task 3); `esc`; `GET /api/usage?scope=global` (Tasks 1-2); the existing `openImport()` and its `grp()` row builder.
- Produces: import rows carry `data-invocations`/`data-lastused`/`data-passive`/`data-order`; the import modal has working Uses/Last-used sort + default-on "Used only".

No client test harness — verified by `pnpm build` + manual modal open. Keep the predicate simple/pure where possible.

- [ ] **Step 1: Add the control bar to the import modal**

In `src/public/index.html`, the import modal body is (line ~315):

```html
    <div class="modal-body" style="padding:14px"><div id="importInventory">Loading…</div></div>
```

Change it to insert a control bar above the list:

```html
    <div class="modal-body" style="padding:14px">
      <div class="bar" style="margin-bottom:8px">
        <button type="button" id="impSortUses" class="sortbtn" title="sort by usage count">Uses</button>
        <button type="button" id="impSortLast" class="sortbtn" title="sort by last used">Last used</button>
        <label class="chk"><input type="checkbox" id="impUsedOnly" checked> Used only</label>
      </div>
      <div id="importInventory">Loading…</div>
    </div>
```

- [ ] **Step 2: Add import state, kind map, and the three import functions**

Near the ledger's `decorateUsage`/`sortRows` helpers (after `cycleSort`, ~line 885), add:

```js
const IKIND_TO_USAGE_TYPE = { skills: "skill", mcpServers: "mcp_server", hooks: "hook", instructions: "instructions" };
let impUsageLoaded = false;
let impSortState = { key: null, dir: "desc" };

async function decorateImportUsage(){
  let artifacts = [];
  try { artifacts = (await (await fetch("/api/usage?scope=global")).json()).artifacts || []; }
  catch { artifacts = []; }
  const map = new Map();                              // globals: key on type|name (root always null)
  for (const a of artifacts) map.set(`${a.type}|${a.name}`, a);
  document.querySelectorAll("#importInventory label.row").forEach(row => {
    const cb = row.querySelector("input[type=checkbox]");
    const type = IKIND_TO_USAGE_TYPE[cb && cb.dataset.ikind];
    const passive = type === "instructions" || type === "hook";
    if (passive) row.dataset.passive = "1"; else delete row.dataset.passive;
    const u = type ? map.get(`${type}|${(cb.dataset.name)||""}`) : null;
    const inv = u ? u.invocations : 0;
    row.dataset.invocations = String(inv);
    row.dataset.lastused = u && u.lastUsedMs ? String(u.lastUsedMs) : "";
    const host = row.querySelector("span");
    const old = host && host.querySelector(".usebadge"); if (old) old.remove();
    if (host && !passive && inv > 0) host.insertAdjacentHTML("beforeend", usageBadgeHtml(inv, u.lastUsedMs));
  });
  impUsageLoaded = true;
  sortRowsIn("#importInventory", impSortState);
  filterImportRows();
}

function cycleImportSort(key){
  if (impSortState.key !== key) { impSortState = { key, dir: "desc" }; }
  else if (impSortState.dir === "desc") { impSortState.dir = "asc"; }
  else { impSortState = { key: null, dir: "desc" }; }
  const map = { uses: "impSortUses", last: "impSortLast" };
  for (const k of Object.keys(map)) {
    const el = document.getElementById(map[k]);
    if (impSortState.key === k) el.dataset.dir = impSortState.dir; else el.removeAttribute("data-dir");
  }
  sortRowsIn("#importInventory", impSortState);
}

function filterImportRows(){
  const usedOnly = (document.getElementById("impUsedOnly") || {}).checked;
  document.querySelectorAll("#importInventory label.row").forEach(row => {
    const cbx = row.querySelector("input[type=checkbox]");
    const matchUsed = !usedOnly || !impUsageLoaded || row.dataset.passive === "1"
      || (cbx && cbx.checked) || Number(row.dataset.invocations || 0) > 0;
    row.style.display = matchUsed ? "" : "none";
  });
  document.querySelectorAll("#importInventory .group").forEach(g => {
    const all = g.querySelectorAll("label.row");
    const shown = [...all].filter(r => r.style.display !== "none").length;
    const h2 = g.querySelector("h2");
    if (h2 && !h2.dataset.base) h2.dataset.base = h2.textContent;
    if (h2) h2.textContent = usedOnly ? `${h2.dataset.base} — showing ${shown}` : h2.dataset.base;
  });
}
```

- [ ] **Step 3: Stamp order + decorate inside `openImport`, reset the gate**

In `openImport()` (line ~1827): at the TOP of the function (right after the early-return guards), add:

```js
  impUsageLoaded = false;   // suppress Used-only until global usage lands (no flash)
```

After the line `document.getElementById("importInventory").innerHTML = h;`, and after the existing checkbox `change` wiring loop that follows it, add order stamping + decoration:

```js
  document.querySelectorAll("#importInventory .group").forEach(g => {
    [...g.querySelectorAll("label.row")].forEach((r, i) => { r.dataset.order = String(i); });
  });
  await decorateImportUsage();
```

(`openImport` is already `async`, so `await` is valid.)

- [ ] **Step 4: Wire the import controls once**

Near the ledger's existing sort/usedOnly wiring (search for `getElementById("sortUses").addEventListener`), add the import equivalents:

```js
document.getElementById("impSortUses").addEventListener("click", () => cycleImportSort("uses"));
document.getElementById("impSortLast").addEventListener("click", () => cycleImportSort("last"));
const impUsedOnlyEl = document.getElementById("impUsedOnly");
if (impUsedOnlyEl) impUsedOnlyEl.addEventListener("change", filterImportRows);
```

- [ ] **Step 5: Build and verify manually**

Run: `pnpm build` (must succeed).
Then run the app against a home with global-skill usage and open the Import modal:

```bash
# from the worktree root:
PORT=4323 node dist/index.js &   # then in the UI: open a testbed, click "Import from machine"
```

Expected on opening Import: used global skills/MCP show `· N uses · date` badges; never-used globals are hidden (Used only on by default); Instructions/Hooks always shown; clicking **Uses**/**Last used** reorders within each group (desc→asc→off); unticking **Used only** reveals unused globals. (If you have no global usage locally, build a synthetic `HOME` like the spec's test fixture and point the server at it via `HOME=<tmp>`.)

- [ ] **Step 6: Commit**

```bash
git add src/public/index.html
git -c user.name="Raymond Feng" -c user.email="raymond@ninemind.ai" commit -m "feat(import): usage badges + sort + Used-only filter in the Import view

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Self-Review

**Spec coverage:**
- §Part 1 backend `scope=global` (flag, `allClaudeTranscripts`, empty-project scan, globals-only) → Task 1. ✓
- §Part 1 cache (`usageCache.ts`, token) → Task 2. ✓
- §Part 2 shared extraction (`usageBadgeHtml`, `sortRowsIn`) → Task 3. ✓
- §Part 2 import controls + `decorateImportUsage` + `cycleImportSort` + `filterImportRows` + `impUsageLoaded` gate + checked/passive exemption + `data-order` → Task 4. ✓
- Best-effort/error handling → Task 1 try/catch (inherited), Task 2 best-effort cache, Task 4 fetch catch. ✓
- Out-of-scope (Codex/agents/hermes, search stack) → not implemented. ✓
- Testing: backend covered (usageGlobal + usageCache); client honestly noted as manual (no harness). ✓

**Placeholder scan:** none — every code step has complete code.

**Type consistency:** `UsageQuerySchema` (Task 1) consumed verbatim in Task 1 Step 5; `allClaudeTranscripts` signature consistent Tasks 1↔2; `readGlobalUsageCache`/`writeGlobalUsageCache` signatures consistent Task 2↔wiring; `usageBadgeHtml(inv,lastUsedMs)` and `sortRowsIn(containerSel,state)` defined in Task 3 and called with matching args in Task 4; `IKIND_TO_USAGE_TYPE`/`impSortState`/`impUsageLoaded` consistent within Task 4; `data-invocations`/`data-lastused`/`data-passive`/`data-order` attribute names match the ledger contract.

**Note on honesty:** Tasks 3-4 touch inline JS in a static HTML file with no JS test harness (same as the merged ledger feature). Stated plainly; the real branching logic (the global scan + cache) is server-side and unit-tested. Task 3 is a pure refactor whose only risk is ledger regression — flagged for the reviewer to confirm `#inventory` behavior is unchanged.
