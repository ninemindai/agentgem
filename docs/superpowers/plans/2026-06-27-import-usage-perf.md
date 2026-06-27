# Import-usage perf Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the Import view's global usage feel instant (stale-while-revalidate scan) and never look broken during a cold scan (loading indicator).

**Architecture:** Factor the global scan into a pure `computeGlobalUsage()`; the `scope=global` endpoint serves an exact-token cache hit, else serves any prior result immediately and refreshes in the background (single-flight), else does one blocking first scan. The Import modal shows a "Loading usage…" state while the fetch is in flight.

**Tech Stack:** TypeScript, Zod, `@agentback/openapi`, Vitest. Client is inline JS in `src/public/index.html` (static — no typecheck/test harness; verified by build + manual).

## Global Constraints

- Spec: `docs/superpowers/specs/2026-06-27-import-usage-perf-design.md`.
- Git identity every commit: `Raymond Feng <raymond@ninemind.ai>`; message ends with `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`.
- Tests run from compiled `dist/` (`pnpm test` == `tsc -b && vitest run`). One test: `pnpm build && npx vitest run -t "<name>"`. ALWAYS `pnpm build` first.
- `/api/usage` stays best-effort: any failure returns `{ artifacts: [] }`, never a 500. The background refresh is fully guarded and never throws to a request.
- SWR: exact-token hit → return it; else prior result exists → return it (stale) + background single-flight refresh; else → one blocking scan, cache, return.
- Staleness of ~1 session is acceptable (usage-discovery view).
- Loading indicator is Import-only (do not touch the ledger's `decorateUsage`/`#inventory`).
- Surgical: backend changes confined to the new `globalUsage.ts`, `usageCache.ts`, and the `scope=global` branch of `usage()`; frontend changes confined to `src/public/index.html`'s import path.

---

### Task 1: Stale-while-revalidate `scope=global`

**Files:**
- Create: `src/gem/globalUsage.ts`
- Modify: `src/gem/usageCache.ts` (add `readGlobalUsageCacheStale`)
- Modify: `src/gem.controller.ts` (add a module-level guard; rewrite the `scope==="global"` branch at lines 99-113; add imports)
- Test: `src/gem/__tests__/globalUsage.test.ts` (create)

**Interfaces:**
- Consumes: `introspectConfig`, `scanWorkflow`, `allClaudeTranscripts`, `transcriptToken`, `resolveDirs`, `readGlobalUsageCache`, `writeGlobalUsageCache` (all already imported in the controller or their modules).
- Produces:
  - `computeGlobalUsage(dirs, paths: string[]): { artifacts: {type,name,root:null,invocations,sessionsUsedIn,lastUsedMs}[] }` in `src/gem/globalUsage.ts`.
  - `readGlobalUsageCacheStale(): { artifacts: unknown[] } | null` in `src/gem/usageCache.ts` (returns the stored result regardless of token; null if no cache file).
  - `GET /api/usage?scope=global` now: exact-token hit → return; else stale present → return stale + background refresh; else → blocking first scan.

- [ ] **Step 1: Write the failing tests**

Create `src/gem/__tests__/globalUsage.test.ts`:

```ts
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GemController } from "../../gem.controller.js";
import { computeGlobalUsage } from "../globalUsage.js";
import { readGlobalUsageCacheStale, writeGlobalUsageCache } from "../usageCache.js";
import { allClaudeTranscripts } from "../workflowScan.js";
import { resolveDirs } from "../../resolveDir.js";

let home: string, claudeDir: string;
beforeAll(() => {
  home = mkdtempSync(join(tmpdir(), "guse-"));
  claudeDir = join(home, ".claude");
  const gskill = join(claudeDir, "skills", "diagram");
  mkdirSync(gskill, { recursive: true });
  writeFileSync(join(gskill, "SKILL.md"), "---\nname: diagram\ndescription: d\n---\nbody");
  const tu = (s: string) => JSON.stringify({ type: "assistant", message: { role: "assistant", content: [{ type: "tool_use", name: "Skill", input: { skill: s } }] } });
  const a = join(claudeDir, "projects", "encA"); mkdirSync(a, { recursive: true });
  writeFileSync(join(a, "a.jsonl"), [JSON.stringify({ cwd: "/projA" }), tu("diagram"), tu("diagram")].join("\n") + "\n");
  const b = join(claudeDir, "projects", "encB"); mkdirSync(b, { recursive: true });
  writeFileSync(join(b, "b.jsonl"), [JSON.stringify({ cwd: "/projB" }), tu("diagram")].join("\n") + "\n");
});
afterAll(() => rmSync(home, { recursive: true, force: true }));

describe("computeGlobalUsage", () => {
  it("aggregates a global skill across all transcripts, globals only", () => {
    const dirs = resolveDirs(claudeDir);
    const res = computeGlobalUsage(dirs, allClaudeTranscripts(dirs.claudeDir));
    const d = res.artifacts.find((a) => a.name === "diagram");
    expect(d).toBeTruthy();
    expect(d!.invocations).toBe(3);   // 2 (A) + 1 (B)
    expect(d!.root).toBeNull();
  });
});

describe("stale-while-revalidate", () => {
  let h2: string, prev: string | undefined;
  beforeEach(() => { h2 = mkdtempSync(join(tmpdir(), "swr-")); prev = process.env.AGENTGEM_HOME; process.env.AGENTGEM_HOME = h2; });
  afterEach(() => { if (prev === undefined) delete process.env.AGENTGEM_HOME; else process.env.AGENTGEM_HOME = prev; rmSync(h2, { recursive: true, force: true }); });

  it("readGlobalUsageCacheStale returns the stored result regardless of token", () => {
    const r = { artifacts: [{ type: "skill", name: "x", root: null, invocations: 9, sessionsUsedIn: 1, lastUsedMs: 1 }] };
    writeGlobalUsageCache("token-A", r);
    expect(readGlobalUsageCacheStale()).toEqual(r);   // even though we never pass token-A
  });
  it("readGlobalUsageCacheStale returns null when no cache exists", () => {
    expect(readGlobalUsageCacheStale()).toBeNull();
  });
  it("endpoint serves a stale cache synchronously when the live token differs", async () => {
    // prime a stale entry under a bogus token; the real scan of `claudeDir` yields a different token
    const stale = { artifacts: [{ type: "skill", name: "STALE", root: null, invocations: 42, sessionsUsedIn: 1, lastUsedMs: 1 }] };
    writeGlobalUsageCache("bogus-token", stale);
    const res = await new GemController().usage({ query: { dir: claudeDir, scope: "global" } });
    expect(res.artifacts).toEqual(stale.artifacts);   // served the stale result, not a fresh scan
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm build && npx vitest run -t "computeGlobalUsage" -t "stale-while-revalidate"`
Expected: FAIL — `../globalUsage.js` and `readGlobalUsageCacheStale` do not exist (TS/module errors).

- [ ] **Step 3: Create `src/gem/globalUsage.ts`**

```ts
// src/gem/globalUsage.ts
//
// Pure global-usage scan: count which GLOBAL artifacts fired across the given
// transcripts. An empty project inventory means every resolved call attributes
// to a global (no project shadowing).
import { introspectConfig } from "./introspect.js";
import { scanWorkflow } from "./workflowScan.js";
import type { resolveDirs } from "../resolveDir.js";

export interface GlobalUsageResult {
  artifacts: { type: string; name: string; root: null; invocations: number; sessionsUsedIn: number; lastUsedMs: number | null }[];
}

export function computeGlobalUsage(dirs: ReturnType<typeof resolveDirs>, paths: string[]): GlobalUsageResult {
  const globalInv = introspectConfig(dirs);
  const emptyProject = { root: "", name: "", skills: [], mcpServers: [], instructions: [], hooks: [] };
  const scanInv = { project: emptyProject, global: { skills: globalInv.skills, mcpServers: globalInv.mcpServers, hooks: globalInv.hooks } };
  const signal = scanWorkflow(paths, scanInv);
  return {
    artifacts: signal.artifacts
      .filter((a) => a.root === null)
      .map((a) => ({ type: a.type, name: a.name, root: a.root as null, invocations: a.invocations, sessionsUsedIn: a.sessionsUsedIn, lastUsedMs: a.lastUsedMs })),
  };
}
```

If TypeScript complains that `emptyProject` doesn't match the `ProjectInventory` shape `scanWorkflow` expects, add the missing field as an empty array — do NOT change `scanWorkflow`. (This mirrors the existing inline block that already type-checks at controller lines 106-107.)

- [ ] **Step 4: Add `readGlobalUsageCacheStale` to `src/gem/usageCache.ts`**

Append (the module already has `cachePath()` and imports `readFileSync`):

```ts
/** The stored result regardless of token (for stale-while-revalidate). null if no cache file. */
export function readGlobalUsageCacheStale(): { artifacts: unknown[] } | null {
  try {
    const j = JSON.parse(readFileSync(cachePath(), "utf8")) as { result?: { artifacts: unknown[] } };
    return j && j.result ? j.result : null;
  } catch { return null; }
}
```

- [ ] **Step 5: Rewrite the global branch in `src/gem.controller.ts`**

1. Add imports: `computeGlobalUsage` from `./gem/globalUsage.js`; add `readGlobalUsageCacheStale` to the existing `./gem/usageCache.js` import (which already brings `readGlobalUsageCache, writeGlobalUsageCache`).
2. Add a module-level guard near the top of the file (after imports, before/above the controller class):
   ```ts
   let globalUsageRefreshing = false;
   ```
3. Replace the current `if (input.query.scope === "global") { ... }` block (lines 99-114) with:
   ```ts
   if (input.query.scope === "global") {
     const dirs = resolveDirs(input.query.dir);
     const paths = allClaudeTranscripts(dirs.claudeDir);
     const token = transcriptToken(paths);
     const exact = readGlobalUsageCache(token);
     if (exact) return exact as z.infer<typeof UsageSchema>;
     const stale = readGlobalUsageCacheStale();
     if (stale) {
       if (!globalUsageRefreshing) {
         globalUsageRefreshing = true;
         void Promise.resolve().then(() => {
           try { writeGlobalUsageCache(token, computeGlobalUsage(dirs, paths)); }
           catch (e) { console.error("[usage] bg refresh failed:", e); }
           finally { globalUsageRefreshing = false; }
         });
       }
       return stale as z.infer<typeof UsageSchema>;
     }
     const result = computeGlobalUsage(dirs, paths);
     writeGlobalUsageCache(token, result);
     return result;
   }
   ```
   (The per-project branch below it is unchanged. The whole body stays inside the existing `try/catch → { artifacts: [] }`.)

- [ ] **Step 6: Run the tests to verify they pass**

Run: `pnpm build && npx vitest run -t "computeGlobalUsage" -t "stale-while-revalidate"`
Expected: PASS (all cases). Note the stale-serve test asserts the response equals the primed stale result — proving SWR serves stale synchronously.

- [ ] **Step 7: Full suite**

Run: `pnpm test`
Expected: PASS — `usageGlobal.test.ts` and `usageCache.test.ts` still green (the first-ever-scan path and exact-hit path are unchanged in behavior).

- [ ] **Step 8: Commit**

```bash
git add src/gem/globalUsage.ts src/gem/usageCache.ts src/gem.controller.ts src/gem/__tests__/globalUsage.test.ts
git -c user.name="Raymond Feng" -c user.email="raymond@ninemind.ai" commit -m "perf(usage): stale-while-revalidate global usage scan

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 2: "Loading usage…" indicator in the Import modal

**Files:**
- Modify: `src/public/index.html` (import control bar markup; `openImport()`; `.sortbtn:disabled` CSS)

**Interfaces:**
- Consumes: `decorateImportUsage()` (existing, async, sets `impUsageLoaded` + runs sort/filter at its end); the import control bar `#importModal .bar` with `#impSortUses`/`#impSortLast`/`#impUsedOnly`.
- Produces: a `#impLoading` indicator shown only while the usage fetch is in flight; sort/Used-only controls disabled during that window.

No client test harness — verified by `pnpm build` + manual Import open.

- [ ] **Step 1: Add the indicator markup**

In `src/public/index.html`, the import control bar (the `<div class="bar" style="margin-bottom:8px">` added previously, containing `#impSortUses`/`#impSortLast`/`#impUsedOnly`). Add the loading span at the end of that bar:

```html
        <span id="impLoading" class="d" hidden style="margin-left:8px">Loading usage…</span>
```

- [ ] **Step 2: Add disabled-control styling**

Near the `.sortbtn` CSS rules, add:

```css
  .sortbtn:disabled,.bar .chk input:disabled{opacity:.5;cursor:default}
```

- [ ] **Step 3: Show/hide the indicator around the usage fetch in `openImport`**

In `openImport()`, find the existing `await decorateImportUsage();` call (added when the Import-view usage feature landed). Replace that single line with a guarded show → await → hide that survives a fetch rejection:

```js
  const impLoad = document.getElementById("impLoading");
  const impCtrls = [...document.querySelectorAll("#importModal .bar .sortbtn"), document.getElementById("impUsedOnly")];
  impLoad.hidden = false; impCtrls.forEach(el => { if (el) el.disabled = true; });
  try { await decorateImportUsage(); }
  finally { impLoad.hidden = true; impCtrls.forEach(el => { if (el) el.disabled = false; }); }
```

(`decorateImportUsage` already catches its own fetch failure and sets `impUsageLoaded`, but the `try/finally` guarantees the indicator never sticks on even if something throws.)

- [ ] **Step 4: Build and verify manually**

Run: `pnpm build` (must succeed).
Then run the server against a large `~/.claude` (or a synthetic one) and open the Import modal:
- First open (cold cache): the **"Loading usage…"** text shows and the sort/Used-only controls are dimmed for the duration of the scan, then clear and the list becomes badged + filtered.
- Subsequent opens (stale-while-revalidate): the indicator flashes briefly (stale served instantly) and the list is immediately badged/filtered.

- [ ] **Step 5: Commit**

```bash
git add src/public/index.html
git -c user.name="Raymond Feng" -c user.email="raymond@ninemind.ai" commit -m "feat(import): 'Loading usage…' indicator while the global scan runs

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Self-Review

**Spec coverage:**
- §Part 1 backend SWR: `computeGlobalUsage` (globalUsage.ts), `readGlobalUsageCacheStale` (usageCache.ts), the SWR branch + single-flight guard (controller) → Task 1. ✓
- §Part 2 frontend loading indicator (markup, disabled controls, show/hide around fetch) → Task 2. ✓
- Best-effort/error handling: endpoint try/catch unchanged; bg refresh guarded (try/catch/finally); stale read swallows errors; frontend try/finally → Tasks 1 & 2. ✓
- Tradeoff (bg scan occupies event loop): documented in spec; the single-flight guard is implemented. ✓
- Out of scope (incremental cache, ledger indicator, worker threads, Codex) → not implemented. ✓

**Placeholder scan:** none — every step has complete code.

**Type consistency:** `computeGlobalUsage(dirs, paths)` defined in Task 1 Step 3 and consumed in the controller branch (Step 5) + tests with matching args; `readGlobalUsageCacheStale()` signature consistent Task 1 Step 4 ↔ controller ↔ test; `globalUsageRefreshing` guard declared once; `#impLoading`/`#impSortUses`/`#impSortLast`/`#impUsedOnly` ids consistent Task 2; `decorateImportUsage` referenced as the existing async fn.

**Honesty note:** Task 2 is inline JS in a static HTML file with no harness (consistent with prior work) — manual verification stated. The risky logic (SWR + scan) is server-side and unit-tested in Task 1, including a test that proves stale is served synchronously on token mismatch.
