# Trim the Insights Panel from the Desktop Console — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove the `Insights` panel from the desktop console (`packages/console`) — it's replaced by the live public marketplace — without touching any other panel's behavior.

**Architecture:** Pure removal. The console nav is data-driven (Shell renders groups from the `pages[]` list), so dropping a panel is: delete its directory, remove its one `pages.tsx` entry, delete the API client routes only it consumed, and clean up the one dead deep-link it fed into Get Gems. Verified by typecheck (catches dangling refs) + the existing Vitest suite + running the console.

**Tech Stack:** React 19 + TypeScript, Vitest + jsdom (`@agentgem/console`). Tests run on `src` directly (no compile step). ESM imports use `.js` extensions (this package's convention).

## Global Constraints

- Package `@agentgem/console`. Run scripts via `pnpm --filter @agentgem/console <script>` (`test`, `typecheck`, `build`).
- ESM imports keep the **`.js`** extension (e.g. `from "./panels/GetGems/index.js"`) — match the existing files; do NOT switch to extensionless.
- **Insights only.** Get Gems keeps all real behavior (registry ready-check + search + install). Observe / Mine / Optimize / Received / Your Gems / Curate / Materialize / Deploy / Settings / Workspaces are untouched.
- The **server-side** aggregator controller and the Observe/session telemetry routes stay — only the four network-discovery *client* routes that Insights consumed are removed.
- Removal order matters: **Task 1 first** (removing Insights deletes the only caller of `setPendingQuery`), **then Task 2** removes the now-orphaned deep-link. Doing Task 2 first would break `Insights/Detail.tsx`.

## File structure (what changes)

```
packages/console/src/
  panels/Insights/                 DELETE entire dir (index, Leaderboard, Pulse, Detail, Sparkline, data + tests)
  pages.tsx                        MODIFY  drop insightsPage import + array entry
  api/routes.ts                    MODIFY  delete the 4 Insights-only aggregator routes/schemas/types (lines ~40–66)
  panels/GetGems/intent.ts         DELETE  (orphaned once Insights is gone)
  panels/GetGems/intent.test.ts    DELETE
  panels/GetGems/index.tsx         MODIFY  drop the takePendingQuery deep-link wiring
  panels/GetGems/GetGems.test.tsx  MODIFY  drop the two pending-query test cases
```

---

### Task 1: Remove the Insights panel + registration + dead aggregator routes

**Files:**
- Delete: `packages/console/src/panels/Insights/` (whole directory)
- Modify: `packages/console/src/pages.tsx`
- Modify: `packages/console/src/api/routes.ts`

**Interfaces:**
- Consumes: nothing new.
- Produces: a console with no Insights panel and no `insights` route. After this task, `packages/console/src/panels/GetGems/intent.ts` still exists and still exports `setPendingQuery`/`takePendingQuery`; Get Gems still imports `takePendingQuery` (returns `null` now). That dead deep-link is cleaned in Task 2.

- [ ] **Step 1: Confirm the baseline is green**

Run: `pnpm --filter @agentgem/console test && pnpm --filter @agentgem/console typecheck`
Expected: PASS (this is the pre-change baseline; if it's already failing, stop and report).

- [ ] **Step 2: Delete the Insights panel directory**

Run:
```bash
git rm -r packages/console/src/panels/Insights
```
Expected: removes `index.tsx`, `Leaderboard.tsx`, `Pulse.tsx`, `Detail.tsx`, `Sparkline.tsx`, `data.ts`, and `*.test.{ts,tsx}`.

- [ ] **Step 3: Remove the Insights registration from `pages.tsx`**

The file currently is:
```tsx
// The composable seam: add a screen with one import + one array entry.
import type { ConsolePage } from "./registry.js";
import { observePage } from "./panels/Observe/index.js";
import { optimizePage } from "./panels/Optimize/index.js";
import { minePage } from "./panels/Mine/index.js";
import { curatePage } from "./panels/Curate/index.js";
import { materializePage } from "./panels/Materialize/index.js";
import { workspacesPage } from "./panels/Workspaces/index.js";
import { getGemsPage } from "./panels/GetGems/index.js";
import { settingsPage } from "./panels/Settings/index.js";
import { receivedPage } from "./panels/Received/index.js";
import { deployPage } from "./panels/Deploy/index.js";
import { insightsPage } from "./panels/Insights/index.js";

export const pages: ConsolePage[] = [observePage, optimizePage, minePage, curatePage, materializePage, workspacesPage, getGemsPage, settingsPage, receivedPage, deployPage, insightsPage];
```

Remove the `insightsPage` import line **and** the trailing `, insightsPage` from the array, leaving:
```tsx
// The composable seam: add a screen with one import + one array entry.
import type { ConsolePage } from "./registry.js";
import { observePage } from "./panels/Observe/index.js";
import { optimizePage } from "./panels/Optimize/index.js";
import { minePage } from "./panels/Mine/index.js";
import { curatePage } from "./panels/Curate/index.js";
import { materializePage } from "./panels/Materialize/index.js";
import { workspacesPage } from "./panels/Workspaces/index.js";
import { getGemsPage } from "./panels/GetGems/index.js";
import { settingsPage } from "./panels/Settings/index.js";
import { receivedPage } from "./panels/Received/index.js";
import { deployPage } from "./panels/Deploy/index.js";

export const pages: ConsolePage[] = [observePage, optimizePage, minePage, curatePage, materializePage, workspacesPage, getGemsPage, settingsPage, receivedPage, deployPage];
```

- [ ] **Step 4: Remove the Insights-only aggregator routes from `api/routes.ts`**

Delete this entire contiguous block (the `// ── Aggregator insights …` comment through the four `export type` lines — schemas `AggIngredientSchema`/`AggCoOccurrenceSchema`/`AdoptionPointSchema`/`AggOverviewSchema`, routes `popularityRoute`/`coOccurrenceRoute`/`adoptionRoute`/`overviewRoute`, and types `AggIngredient`/`AggCoOccurrence`/`AdoptionPoint`/`AggOverview`):

```tsx
// ── Aggregator insights (public-read; k-anon enforced server-side) ──
const AggIngredientSchema = z.object({
  id: z.string(), kind: z.string(), producers: z.number(),
  verifiedProducers: z.number(), invocations: z.number(), sessions: z.number(),
});
const AggCoOccurrenceSchema = z.object({ id: z.string(), producers: z.number(), verifiedProducers: z.number() });
const AdoptionPointSchema = z.object({ bucket: z.string(), producers: z.number(), verifiedProducers: z.number(), invocations: z.number() });
const AggOverviewSchema = z.object({ ingredients: z.number(), producers: z.number(), verifiedProducers: z.number(), invocations: z.number(), sessions: z.number() });

export const popularityRoute = defineRoute("GET", "/api/aggregator/popularity", {
  query: z.object({ kind: z.string().optional(), limit: z.number().optional() }),
  response: z.array(AggIngredientSchema),
});
export const coOccurrenceRoute = defineRoute("GET", "/api/aggregator/co-occurrence", {
  query: z.object({ id: z.string(), limit: z.number().optional() }),
  response: z.array(AggCoOccurrenceSchema),
});
export const adoptionRoute = defineRoute("GET", "/api/aggregator/adoption", {
  query: z.object({ id: z.string(), bucket: z.enum(["week", "month"]).optional() }),
  response: z.array(AdoptionPointSchema),
});
export const overviewRoute = defineRoute("GET", "/api/aggregator/overview", { response: AggOverviewSchema });

export type AggIngredient = z.infer<typeof AggIngredientSchema>;
export type AggCoOccurrence = z.infer<typeof AggCoOccurrenceSchema>;
export type AdoptionPoint = z.infer<typeof AdoptionPointSchema>;
export type AggOverview = z.infer<typeof AggOverviewSchema>;
```

Leave the rest of `routes.ts` (including the Observe/session telemetry routes further down) untouched. If `z` or `defineRoute` becomes unused after this deletion, the typecheck in Step 5 will flag it — but they are used by many other routes in this file, so they stay.

- [ ] **Step 5: Verify typecheck + tests are green**

Run: `pnpm --filter @agentgem/console typecheck`
Expected: PASS, no "Cannot find name 'insightsPage'", no dangling `popularityRoute`/`AggOverview`/etc. references. A failure here means something outside Insights still imported a removed symbol — investigate that importer (the spec verified there are none, so this should be clean).

Run: `pnpm --filter @agentgem/console test`
Expected: PASS. The Insights tests are gone; Get Gems' `intent.test.ts` and `GetGems.test.tsx` still pass (they exercise `intent.ts`, which still exists after Task 1).

- [ ] **Step 6: Commit**

```bash
git add -A packages/console/src/pages.tsx packages/console/src/api/routes.ts
git commit -m "feat(console): remove the Insights panel (superseded by the marketplace)"
```
(The `git rm` from Step 2 is already staged; `git add -A` on the two modified files completes the staging. Verify with `git status` that the Insights dir shows as deleted.)

---

### Task 2: Remove the orphaned Insights→Get Gems deep-link

**Files:**
- Delete: `packages/console/src/panels/GetGems/intent.ts`
- Delete: `packages/console/src/panels/GetGems/intent.test.ts`
- Modify: `packages/console/src/panels/GetGems/index.tsx`
- Modify: `packages/console/src/panels/GetGems/GetGems.test.tsx`

**Interfaces:**
- Consumes: the Task-1 state (Insights gone, so `setPendingQuery` has no remaining caller).
- Produces: Get Gems with no pending-query mechanism — it opens with an empty search box. Registry ready-check, search, and install are unchanged.

- [ ] **Step 1: Delete the intent module + its test**

Run:
```bash
git rm packages/console/src/panels/GetGems/intent.ts packages/console/src/panels/GetGems/intent.test.ts
```

- [ ] **Step 2: Remove the deep-link wiring from `GetGems/index.tsx`**

Make three edits:

1. Delete the import (currently line 10):
```tsx
import { takePendingQuery } from "./intent.js";
```

2. Delete the pending state hook (currently line 19):
```tsx
  const [pending] = useState<string | null>(() => takePendingQuery()); // one-shot, captured at mount
```

3. Delete the entire pending `useEffect` (currently lines 45–52):
```tsx
  useEffect(() => {
    if (!pending) return;
    setQ(pending);
    if (ready) void search(pending);
    // run only when `ready` flips; `pending` is captured once at mount.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready]);
```

Leave the `import { useEffect, useState } from "react";` line as-is — both are still used (the registry ready-check `useEffect` and the `q`/`results`/etc. `useState`s remain).

- [ ] **Step 3: Update `GetGems.test.tsx` — drop the deep-link case, keep the on-mount case**

Make these edits to `packages/console/src/panels/GetGems/GetGems.test.tsx`:

1. Delete the intent import (currently line 4):
```tsx
import { setPendingQuery, takePendingQuery } from "./intent.js";
```

2. Simplify the `afterEach` (currently line 6) — remove the `takePendingQuery()` drain:
```tsx
afterEach(() => { cleanup(); takePendingQuery(); });
```
becomes:
```tsx
afterEach(() => { cleanup(); });
```

3. **Delete this entire test** — it exercises the removed deep-link (`setPendingQuery`):
```tsx
it("auto-runs a search from a pending cross-panel query", async () => {
  const calls: string[] = [];
  vi.stubGlobal("fetch", vi.fn(async (url: string | URL) => {
    const u = String(url);
    if (u.includes("/api/registry/ready")) return res({ ready: true });
    if (u.includes("/api/registry/search")) {
      calls.push(u);
      return res({ results: [{ key: "acme/brainstorming-kit", latest: "1.0.0", score: 1, description: "kit", tags: [] }] });
    }
    throw new Error(`unexpected ${u}`);
  }));
  setPendingQuery("brainstorming");
  render(<GetGems apiBase="" />);
  expect(await screen.findByText("acme/brainstorming-kit")).toBeTruthy();
  expect((screen.getByLabelText("search registry") as HTMLInputElement).value).toBe("brainstorming");
  expect(calls.some((u) => u.includes("brainstorming"))).toBe(true);
});
```

4. **Keep the second test, but retitle it** — it never used the removed symbols, and "Get Gems does not search on mount" is still valid coverage. Drop the now-stale `(no pending query)` parenthetical:
```tsx
it("does not auto-search on a normal visit (no pending query)", async () => {
```
becomes:
```tsx
it("does not auto-search on mount", async () => {
```
Leave that test's body unchanged. Keep every other test in the file as-is.

- [ ] **Step 4: Verify typecheck + tests are green**

Run: `pnpm --filter @agentgem/console typecheck`
Expected: PASS — no references to `./intent.js`, `takePendingQuery`, `setPendingQuery`, or `pending` remain.

Run: `pnpm --filter @agentgem/console test`
Expected: PASS — the remaining Get Gems tests (ready-check, search, install) pass; the two deleted cases are gone.

- [ ] **Step 5: Commit**

```bash
git add -A packages/console/src/panels/GetGems/index.tsx packages/console/src/panels/GetGems/GetGems.test.tsx
git commit -m "refactor(console): drop the orphaned Insights→Get Gems deep-link"
```

---

## Final verification

- [ ] **Full gate**

Run: `pnpm --filter @agentgem/console test && pnpm --filter @agentgem/console typecheck && pnpm --filter @agentgem/console build`
Expected: tests pass, typecheck clean, the console bundle builds.

- [ ] **Run it (the real check)**

Build and serve the console locally (the package's normal dev/serve path), open it, and confirm:
- The **Library** nav group lists Your Gems · Get Gems · Received — **no Insights**.
- Visiting `#/insights` no longer resolves to a panel (the route is gone).
- **Get Gems** still opens (empty search box), and its registry search/install still work.
- The Observe group (Inspect · Mine · Optimize) and the other panels are unchanged.

If any step requires a build artifact that's stale, clean the console build output first, then rebuild.
