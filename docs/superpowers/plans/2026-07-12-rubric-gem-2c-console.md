# Rubric-gem Phase 2C — console polish — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Make a bundled rubric fully visible/usable in the console: a workspace rubric chip, the rubric's `title` in Curate, and a one-click "Bundle into gem" button on RubricLibrary.

**Architecture:** One small server count field (`artifactCounts.rubric`) + console rendering; the rest is console-only. No engine/`buildGem`/wire-selection change (2B carries the selection).

**Tech Stack:** TypeScript (ESM), Zod, React, vitest (+ supertest for the CI gate). pnpm `tsc -b`.

## Global Constraints

- Console tests are NOT in CI (root `dist/**/__tests__` only). The **CI gate for 2C is one controller integration test** (Task 1) proving `artifactCounts.rubric` end-to-end. Console-package tests (Tasks 1–3) run locally via `pnpm --filter @agentgem/console exec vitest run <path>`.
- `artifactCounts.rubric` is **required** (a count is always present) — update the 3 fixture literals that construct `artifactCounts`.
- Curate: swap `name`→`title` **only at the display label**; `name` stays the selection key/identity everywhere.
- RubricLibrary "Bundle" is **additive** (union with `getKeys()`), reusing the `activeGem` store + `selKey` — mirrors the Workspaces "Open" pattern.
- No change to the eval engine, `/api/rubrics`, `buildGem`, or the wire selection schema.
- Commit trailer: `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`.

---

### Task 1: Workspace rubric count + chip

**Files:**
- Modify: `packages/base/src/workspaces.ts` (`WorkspaceSummary.artifactCounts` type ~line 23; `countArtifacts` seed ~line 57)
- Modify: `packages/console/src/api/routes.ts` (`WorkspaceSummarySchema.artifactCounts` ~line 114)
- Modify: `packages/console/src/panels/Workspaces/index.tsx` (`countChips` ~line 10)
- Modify fixtures: `packages/console/src/panels/Workspaces/Workspaces.test.tsx`, `packages/console/src/shell/ActiveGemSwitcher.test.tsx`, `packages/console/src/panels/Publish/index.test.tsx` (add `rubric: 0` to each `artifactCounts` literal)
- Test (CI gate): `src/__tests__/gem.controller.test.ts`

**Interfaces:** Produces `artifactCounts.rubric: number` end-to-end.

- [ ] **Step 1: Write the failing CI-gate test**

In `src/__tests__/gem.controller.test.ts` (reuse the suite's `AGENTGEM_HOME`/`client`; seed a user rubric like the 2B tests do), add:

```ts
describe("workspace counts a bundled rubric (2C)", () => {
  it("artifactCounts.rubric reflects a bundled rubric", async () => {
    mkdirSync(join(agentgemHomeDir, ".agentgem", "rubrics"), { recursive: true });
    writeFileSync(join(agentgemHomeDir, ".agentgem", "rubrics", "cnt.json"),
      JSON.stringify({ id: "cnt", title: "Counted", target: "overview", factors: [{ factor: "retry-storm" }] }));
    await client.post("/api/workspaces").send({ name: "rub-ws", selection: { rubrics: ["cnt"] } }).expect(200);
    const r = await client.get("/api/workspaces").expect(200);
    const ws = r.body.workspaces.find((w: { name: string }) => w.name === "rub-ws");
    expect(ws.artifactCounts.rubric).toBe(1);
  });
});
```

(If `/api/workspaces` GET/POST route names differ, locate them — the 2B archive test used `/api/archive`; the workspace-create route is `createWorkspaceRoute` → `POST /api/workspaces`, list is `GET /api/workspaces`.)

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm exec tsc -b && pnpm exec vitest run dist/__tests__/gem.controller.test.js -t "workspace counts a bundled rubric"`
Expected: FAIL — `ws.artifactCounts.rubric` is `undefined` (no bucket).

- [ ] **Step 3: Add the count**

In `packages/base/src/workspaces.ts`, `WorkspaceSummary.artifactCounts` type — add `rubric: number`:

```ts
  artifactCounts: { skill: number; mcp_server: number; instructions: number; hook: number; subagent: number; game: number; rubric: number };
```

`countArtifacts` seed:

```ts
  const c = { skill: 0, mcp_server: 0, instructions: 0, hook: 0, subagent: 0, game: 0, rubric: 0 };
```

In `packages/console/src/api/routes.ts`, `WorkspaceSummarySchema.artifactCounts`, add `rubric: z.number(),`.

In `packages/console/src/panels/Workspaces/index.tsx`, `countChips`, add before the `checks` entry:

```ts
    { label: "rubrics", n: c.rubric },
```

Add `rubric: 0` to the `artifactCounts` literal in each of: `Workspaces.test.tsx`, `ActiveGemSwitcher.test.tsx` (both literals), `Publish/index.test.tsx`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm exec tsc -b && pnpm exec vitest run dist/__tests__/gem.controller.test.js -t "workspace counts a bundled rubric"` (CI gate — PASS)
Then console: `pnpm --filter @agentgem/console exec vitest run src/panels/Workspaces` (countChips — PASS).

- [ ] **Step 5: Commit**

```bash
git add packages/base/src/workspaces.ts packages/console/src/api/routes.ts packages/console/src/panels/Workspaces/index.tsx packages/console/src/panels/Workspaces/Workspaces.test.tsx packages/console/src/shell/ActiveGemSwitcher.test.tsx packages/console/src/panels/Publish/index.test.tsx src/__tests__/gem.controller.test.ts
git commit -m "$(printf 'feat(rubric): count + chip a bundled rubric in the workspace surface\n\nCo-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>')"
```

---

### Task 2: Curate shows the rubric title

**Files:**
- Modify: `packages/console/src/api/routes.ts` (`ArtifactSchema` ~line 8)
- Modify: `packages/console/src/panels/Curate/data.ts` (`LedgerItem` ~line 3; `groupInventory` item map)
- Modify: `packages/console/src/panels/Curate/index.tsx` (row label ~line 390)
- Test: `packages/console/src/panels/Curate/Curate.test.tsx` (or `data.test.ts` if present) — console-only

**Interfaces:** Consumes the wire `title` (already sent server-side). Produces `LedgerItem.title?`.

- [ ] **Step 1: Write the failing test**

Add to the Curate test a `groupInventory` assertion that a rubric item carries `title`:

```ts
it("carries the rubric title through to the ledger item", () => {
  const groups = groupInventory({ skills: [], mcpServers: [], instructions: [], hooks: [], subagents: [],
    rubrics: [{ name: "team-hygiene", title: "Team hygiene", type: "rubric" }] } as unknown as Inventory);
  const rub = groups.find((g) => g.key === "rubrics");
  expect(rub?.items[0].title).toBe("Team hygiene");
});
```

(Import `groupInventory` and the `Inventory` type from `./data.js`. If a `data.test.ts` exists next to `data.ts`, add it there.)

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm --filter @agentgem/console exec vitest run src/panels/Curate`
Expected: FAIL — `title` undefined on the item (schema strips it / not mapped).

- [ ] **Step 3: Thread title through**

In `packages/console/src/api/routes.ts`, `ArtifactSchema`, add:

```ts
  title: z.string().optional(),   // rubric display title; other artifact types don't set it
```

In `packages/console/src/panels/Curate/data.ts`, `LedgerItem` interface, add `title?: string;`. In `groupInventory`'s item map, add `title: a.title,`.

In `packages/console/src/panels/Curate/index.tsx`, the row label (line ~390) — change ONLY the display span:

```tsx
                      <span className="ledger-item-name">{i.title ?? i.name}</span>
```

(Leave `key={i.name}` and every selection-key use of `i.name` unchanged.)

- [ ] **Step 4: Run to verify it passes**

Run: `pnpm --filter @agentgem/console exec vitest run src/panels/Curate`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/console/src/api/routes.ts packages/console/src/panels/Curate/data.ts packages/console/src/panels/Curate/index.tsx packages/console/src/panels/Curate/Curate.test.tsx
git commit -m "$(printf 'feat(rubric): show the rubric title (not kebab name) in Curate\n\nCo-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>')"
```

---

### Task 3: RubricLibrary "Bundle into gem" button

**Files:**
- Modify: `packages/console/src/panels/RubricLibrary/index.tsx` (imports + `RubricRow` action)
- Test: `packages/console/src/panels/RubricLibrary/RubricLibrary.test.tsx` (create — first test for this panel) — console-only

**Interfaces:** Consumes the `activeGem` store (`getKeys`/`setKeys`) + `selKey` (`Curate/selection.js`).

- [ ] **Step 1: Write the failing test**

Create `packages/console/src/panels/RubricLibrary/RubricLibrary.test.tsx`. Test the bundle action in isolation — the simplest reliable unit is a tiny exported helper; add one and test it:

```ts
import { describe, it, expect, beforeEach } from "vitest";
import { getKeys, setKeys, resetGem } from "../../activeGem.js";
import { selKey } from "../Curate/selection.js";
import { bundleRubric } from "./index.js";

describe("bundleRubric", () => {
  beforeEach(() => resetGem());
  it("adds the rubric's selection key (additive) and targets curate", () => {
    setKeys(new Set([selKey("skills", "existing")]));
    const hash = bundleRubric("team-hygiene");
    expect(getKeys().has(selKey("rubrics", "team-hygiene"))).toBe(true);
    expect(getKeys().has(selKey("skills", "existing"))).toBe(true); // additive, not replace
    expect(hash).toBe("#/curate");
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm --filter @agentgem/console exec vitest run src/panels/RubricLibrary`
Expected: FAIL — `bundleRubric` not exported.

- [ ] **Step 3: Add the helper + button**

In `packages/console/src/panels/RubricLibrary/index.tsx`, add imports:

```ts
import { getKeys, setKeys } from "../../activeGem.js";
import { selKey } from "../Curate/selection.js";
```

Add an exported helper (near the top, testable without rendering):

```ts
/** Add a rubric to the active gem selection (additive) and return the curate route to navigate to. */
export function bundleRubric(rubricId: string): string {
  setKeys(new Set([...getKeys(), selKey("rubrics", rubricId)]));
  return "#/curate";
}
```

In `RubricRow`, add a "Bundle" button alongside Edit/Delete/Run (after the Run button, line ~120):

```tsx
        <button type="button" className="ledger-view" onClick={() => { window.location.hash = bundleRubric(r.id); }}>Bundle ▸</button>
```

- [ ] **Step 4: Run to verify it passes**

Run: `pnpm --filter @agentgem/console exec vitest run src/panels/RubricLibrary`
Expected: PASS.

- [ ] **Step 5: Console typecheck + full root suite**

Run: `pnpm --filter @agentgem/console exec tsc -b` (console typecheck), then from repo root `pnpm test`.
Expected: green. If `consoleMount.test.js` is the only root failure, run `pnpm build` once and re-check it.

- [ ] **Step 6: Commit**

```bash
git add packages/console/src/panels/RubricLibrary/index.tsx packages/console/src/panels/RubricLibrary/RubricLibrary.test.tsx
git commit -m "$(printf 'feat(rubric): RubricLibrary "Bundle into gem" hands off to Curate\n\nCo-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>')"
```

---

## Self-Review

**Spec coverage:** Piece 1 (workspace chip) → Task 1; Piece 2 (Curate title) → Task 2; Piece 3 (RubricLibrary Bundle) → Task 3. ✅

**Placeholder scan:** none — full code per step; "if a data.test.ts exists" / "if route names differ" are locate-the-file instructions, not open requirements.

**Type consistency:** `artifactCounts.rubric: number` identical across `workspaces.ts` type, `countArtifacts` seed, and the console schema; `bundleRubric(rubricId): string` identical between test and impl; `selKey("rubrics", id)` identity matches 2B's `GROUP_OF.rubric = "rubrics"`.

**CI note:** only Task 1's controller test gates in CI; Tasks 2–3 are console-only (run locally). Task 1's `artifactCounts.rubric` is the one server contract change and it IS CI-gated end-to-end.
