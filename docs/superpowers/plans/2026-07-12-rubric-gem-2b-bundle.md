# Rubric-gem Phase 2B — bundle & publish — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Let a user select a global user rubric and bundle it into a gem — inventory carries rubrics, `buildGem` resolves a `rubrics` selection, the API wire carries both, and Curate offers a "Rubrics" category.

**Architecture:** `ConfigInventory` gains an optional `rubrics` field; `introspectConfig` populates it from `loadRubrics()` (capture already depends on insight); `buildGem` resolves `selection.rubrics` into artifacts; server + console schemas carry `rubrics`; Curate renders it as a category.

**Tech Stack:** TypeScript (ESM), Zod, vitest + supertest, pnpm `tsc -b` project references.

## Global Constraints

- **Rubrics are global** — the field/selection lives on `ConfigInventory`/top-level `GemSelection`, never `ProjectInventory`/`ProjectSelection`.
- **User rubrics only** — `loadRubrics()`, never `builtinRubrics()`.
- **`ConfigInventory.rubrics` is OPTIONAL** (`rubrics?: RubricArtifact[]`) — a required field breaks `packages/run/src/runGem.ts:157` + ~25 test literals.
- **Reuse existing types:** `RubricArtifact` (`packages/model/src/types.ts`), `RubricArtifactSchema` (`src/schemas.ts`), `loadRubrics`/`rubricToArtifact` (`@agentgem/insight`).
- **No change** to the eval engine, `/api/rubrics`, the run-and-report surface, `installRubricGem`, or `ProjectInventory`.
- **Tests that must gate in CI live under root `src/**/__tests__`** (CI gates only root `dist/**/__tests__`; console tests are NOT in CI). Suite = `pnpm test` = `tsc -b && vitest run` against `dist/`. Focused: `pnpm exec tsc -b && pnpm exec vitest run dist/<path>.test.js`.
- **Test isolation** via `AGENTGEM_HOME` (temp dir in `beforeAll`/restore in `afterAll`) — `defaultRubricsDir()` honors it.
- **Commit trailer:** end every message with `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`.

---

### Task 1: `ConfigInventory.rubrics` + `buildGem` resolves a rubric selection

**Files:**
- Modify: `packages/model/src/types.ts` (`ConfigInventory`, after `subagents`)
- Modify: `packages/build/src/buildGem.ts` (`GemSelection`; `{all}` push; resolution loop)
- Test: `src/gem/__tests__/buildGem.test.ts`

**Interfaces:**
- Produces: `ConfigInventory.rubrics?: RubricArtifact[]`; `GemSelection.rubrics?: string[]`; `buildGem` pushes selected/`all` rubrics into `Gem.artifacts`.

- [ ] **Step 1: Write the failing test**

Add to `src/gem/__tests__/buildGem.test.ts` (it already imports `buildGem` and builds `ConfigInventory` literals — mirror the existing style; add `type RubricArtifact` from `@agentgem/model` if not present):

```ts
describe("buildGem bundles rubrics (2B)", () => {
  const rubric: RubricArtifact = { type: "rubric", name: "team-hygiene", title: "Team hygiene", target: "overview", factors: [{ factor: "retry-storm" }] };
  const inv = (): ConfigInventory => ({ skills: [], mcpServers: [], instructions: [], hooks: [], subagents: [], rubrics: [rubric] });

  it("resolves a named rubric into the gem's artifacts", () => {
    const gem = buildGem(inv(), { rubrics: ["team-hygiene"] }, { name: "g" });
    expect(gem.artifacts.filter((a) => a.type === "rubric").map((a) => a.name)).toEqual(["team-hygiene"]);
  });
  it("includes rubrics under { all: true }", () => {
    const gem = buildGem(inv(), { all: true }, { name: "g" });
    expect(gem.artifacts.some((a) => a.type === "rubric" && a.name === "team-hygiene")).toBe(true);
  });
  it("throws on a missing rubric name", () => {
    expect(() => buildGem(inv(), { rubrics: ["nope"] }, { name: "g" })).toThrow(/No rubric 'nope'/);
  });
});
```

(If the test file already imports `ConfigInventory`/`buildGem`, reuse those imports; add only what's missing.)

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm exec tsc -b`
Expected: FAIL — `rubrics` not on `ConfigInventory`/`GemSelection` (type errors).

- [ ] **Step 3: Add the field + the resolution**

In `packages/model/src/types.ts`, add to `ConfigInventory` (after the `subagents` line, before `projects?`):

```ts
  rubrics?: RubricArtifact[];   // global user rubrics available to bundle (2B); optional — not every inventory has them
```

In `packages/build/src/buildGem.ts`, add `rubrics?: string[]` to the non-`all` variant of `GemSelection` (alongside `subagents?`):

```ts
      subagents?: string[];
      rubrics?: string[];
      projects?: Record<string, ProjectSelection>;
```

In the `{all:true}` branch, append rubrics to the global push:

```ts
  if ("all" in selection && selection.all) {
    artifacts.push(...inventory.skills, ...inventory.mcpServers, ...inventory.instructions, ...inventory.hooks, ...inventory.subagents, ...(inventory.rubrics ?? []));
    for (const p of projects) artifacts.push(...p.skills, ...p.mcpServers, ...p.instructions, ...p.hooks, ...p.subagents);
  } else {
```

In the named-category section, add a rubric loop after the `subagents` loop (mirroring `skills`):

```ts
    for (const n of sel.rubrics ?? []) {
      const a = (inventory.rubrics ?? []).find((r) => r.name === n);
      if (!a) throw new InvalidInputError(`No rubric '${n}'. Available: ${(inventory.rubrics ?? []).map((r) => r.name).join(", ") || "(none)"}`);
      artifacts.push(a);
    }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm exec tsc -b && pnpm exec vitest run dist/gem/__tests__/buildGem.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/model/src/types.ts packages/build/src/buildGem.ts src/gem/__tests__/buildGem.test.ts
git commit -m "$(printf 'feat(rubric): buildGem resolves a rubrics selection into the gem\n\nCo-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>')"
```

---

### Task 2: `introspectConfig` surfaces user rubrics in the inventory

**Files:**
- Modify: `packages/capture/src/introspect.ts` (import from `@agentgem/insight`; add `rubrics` to the `introspectConfig` return, line 286)
- Test: `src/gem/__tests__/introspect.test.ts`

**Interfaces:**
- Consumes: `ConfigInventory.rubrics` (Task 1).
- Produces: `introspectConfig().rubrics` = user rubrics as `RubricArtifact[]`.

- [ ] **Step 1: Write the failing test**

Add to `src/gem/__tests__/introspect.test.ts` (it already sets `AGENTGEM_HOME`/temp dirs — reuse that harness; if it doesn't, add a `beforeEach`/`afterEach` that sets `process.env.AGENTGEM_HOME` to a `mkdtempSync` dir and restores it):

```ts
describe("introspectConfig surfaces user rubrics (2B)", () => {
  it("returns user rubrics as rubric artifacts, excluding built-ins", () => {
    const home = mkdtempSync(join(tmpdir(), "agh-rub-"));
    const prev = process.env.AGENTGEM_HOME; process.env.AGENTGEM_HOME = home;
    try {
      mkdirSync(join(home, ".agentgem", "rubrics"), { recursive: true });
      writeFileSync(join(home, ".agentgem", "rubrics", "team.json"),
        JSON.stringify({ id: "team", title: "Team", target: "overview", factors: [{ factor: "retry-storm" }] }));
      const inv = introspectConfig({ claudeDir: join(home, ".claude") });
      expect((inv.rubrics ?? []).map((r) => r.name)).toContain("team");
      expect((inv.rubrics ?? []).map((r) => r.name)).not.toContain("hygiene"); // built-in excluded
    } finally {
      if (prev !== undefined) process.env.AGENTGEM_HOME = prev; else delete process.env.AGENTGEM_HOME;
      rmSync(home, { recursive: true, force: true });
    }
  });
});
```

Ensure the test file imports `introspectConfig` from `@agentgem/capture` and `mkdtempSync, mkdirSync, writeFileSync, rmSync` from `node:fs`, `tmpdir` from `node:os`, `join` from `node:path` (add any missing).

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm exec tsc -b && pnpm exec vitest run dist/gem/__tests__/introspect.test.js -t "surfaces user rubrics"`
Expected: FAIL — `inv.rubrics` is `undefined`.

- [ ] **Step 3: Populate rubrics in introspectConfig**

In `packages/capture/src/introspect.ts`, add the import (after the `@agentgem/model` import block, ~line 8):

```ts
import { loadRubrics, rubricToArtifact } from "@agentgem/insight";
```

In `introspectConfig`'s return literal (line 286), add the `rubrics` key (user rubrics only — `loadRubrics()` reads `~/.agentgem/rubrics`, never built-ins):

```ts
  return { skills: dedupByName(skillList), mcpServers: dedupByName(mcpList), instructions, hooks: uniqueHookNames(hookList), subagents: dedupByName(subagentList), rubrics: loadRubrics().map(rubricToArtifact) };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm exec tsc -b && pnpm exec vitest run dist/gem/__tests__/introspect.test.js -t "surfaces user rubrics"`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/capture/src/introspect.ts src/gem/__tests__/introspect.test.ts
git commit -m "$(printf 'feat(rubric): introspectConfig surfaces user rubrics in the inventory\n\nCo-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>')"
```

---

### Task 3: Server schemas carry rubrics; /api/inventory returns them

**Files:**
- Modify: `src/schemas.ts` (`InventorySchema` line 212 + `GemSelectionSchema` line 247)
- Test: `src/__tests__/gem.controller.test.ts`

**Interfaces:**
- Consumes: Tasks 1–2. Produces: `/api/inventory` response includes `rubrics`; a request selection `{ rubrics: [...] }` survives to `buildGem`.

- [ ] **Step 1: Write the failing test**

In `src/__tests__/gem.controller.test.ts` (reuse the suite's `AGENTGEM_HOME` isolation + `client`), add:

```ts
describe("rubric bundling through the API (2B)", () => {
  beforeAll(() => {
    // agentgemHomeDir is the suite's AGENTGEM_HOME temp dir (set in the file's root beforeAll)
    mkdirSync(join(agentgemHomeDir, ".agentgem", "rubrics"), { recursive: true });
    writeFileSync(join(agentgemHomeDir, ".agentgem", "rubrics", "team.json"),
      JSON.stringify({ id: "team", title: "Team", target: "overview", factors: [{ factor: "retry-storm" }] }));
  });
  it("GET /api/inventory lists the user rubric under rubrics", async () => {
    const r = await client.get("/api/inventory").expect(200);
    expect((r.body.rubrics ?? []).map((x: { name: string }) => x.name)).toContain("team");
  });
  it("POST /api/archive with a rubric selection produces an archive carrying it", async () => {
    const out = mkdtempSync(join(tmpdir(), "rub-arch-"));
    const gemFile = join(out, "r.gem");
    try {
      await client.post("/api/archive").send({ dir, selection: { rubrics: ["team"] }, name: "r", outFile: gemFile }).expect(200);
      const gem = readGemArchive(unpackTar(readFileSync(gemFile)));
      expect(gem.artifacts.some((a) => a.type === "rubric" && a.name === "team")).toBe(true);
    } finally { rmSync(out, { recursive: true, force: true }); }
  });
});
```

(`readGemArchive`, `unpackTar` are already imported in this file; `dir` and `agentgemHomeDir` are file-scoped from the root `beforeAll`.)

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm exec tsc -b && pnpm exec vitest run dist/__tests__/gem.controller.test.js -t "rubric bundling through the API"`
Expected: FAIL — `r.body.rubrics` stripped (InventorySchema lacks it) and/or the archive lacks the rubric (selection `rubrics` stripped by `GemSelectionSchema`).

- [ ] **Step 3: Add rubrics to the server schemas**

In `src/schemas.ts`, add to `InventorySchema` (line 212, after `subagents`):

```ts
  rubrics: z.array(RubricArtifactSchema).optional(),
```

Add to the object variant of `GemSelectionSchema` (line 247, after `subagents`):

```ts
    rubrics: z.array(z.string()).optional(),
```

(`RubricArtifactSchema` is already defined earlier in `src/schemas.ts`.)

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm exec tsc -b && pnpm exec vitest run dist/__tests__/gem.controller.test.js -t "rubric bundling through the API"`
Expected: PASS (2 cases).

- [ ] **Step 5: Commit**

```bash
git add src/schemas.ts src/__tests__/gem.controller.test.ts
git commit -m "$(printf 'feat(rubric): carry rubrics on the inventory + selection wire schemas\n\nCo-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>')"
```

---

### Task 4: Curate "Rubrics" category (console)

**Files:**
- Modify: `packages/console/src/api/routes.ts` (`InventorySchema` line 22 + `GemSelectionSchema` line 96)
- Modify: `packages/console/src/panels/Curate/data.ts` (`InventoryCategory` + `CATEGORIES`)
- Modify: `packages/console/src/panels/Curate/selection.ts` (`GemSelection` + `GROUP_OF` + `buildSelection`)
- Test: `packages/console/src/panels/Curate/Curate.test.tsx` (local-only; console tests are not in CI)

**Interfaces:**
- Consumes: Task 3 wire shape. Produces: a "Rubrics" ledger group; a rubric pick round-trips into `buildSelection().rubrics`.

- [ ] **Step 1: Write the failing test**

Add to `packages/console/src/panels/Curate/selection.ts`'s test (or the panel test `Curate.test.tsx`) a unit assertion on `buildSelection`:

```ts
it("round-trips a rubric pick into selection.rubrics", () => {
  const sel = buildSelection(new Set([selKey("rubrics", "team-hygiene")]));
  expect(sel.rubrics).toEqual(["team-hygiene"]);
});
```

(If a `selection.test.ts` exists next to `selection.ts`, add it there; otherwise add to `Curate.test.tsx`. Import `buildSelection, selKey` from `./selection.js`.)

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @agentgem/console exec vitest run src/panels/Curate` (console tests run in-package)
Expected: FAIL — `sel.rubrics` is `undefined`.

- [ ] **Step 3: Add the category + selection + schemas**

In `packages/console/src/api/routes.ts`:
- `InventorySchema` (line 22, after `subagents`): `rubrics: z.array(ArtifactSchema).optional(),`
- `GemSelectionSchema` object variant (line 96, after `subagents`): `rubrics: z.array(z.string()).optional(),`

In `packages/console/src/panels/Curate/data.ts`:
- Add `"rubrics"` to the `InventoryCategory` union (line 15).
- Add to `CATEGORIES` (after `hooks`): `{ key: "rubrics", type: "rubric", label: "Rubrics" },`

In `packages/console/src/panels/Curate/selection.ts`:
- Add `rubrics?: string[];` to the `GemSelection` interface.
- Add `rubric: "rubrics",` to `GROUP_OF`.
- Add to `buildSelection` (after the `instructions` branch): `if (byGroup.rubrics?.length) sel.rubrics = byGroup.rubrics;`

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @agentgem/console exec vitest run src/panels/Curate`
Expected: PASS.

- [ ] **Step 5: Typecheck + full suite**

Run: `pnpm --filter @agentgem/console exec tsc -b` (console typecheck — NOT in CI, so run locally), then from repo root `pnpm test`.
Expected: both green. If `consoleMount.test.js` is the only root failure, run `pnpm build` once and re-check it (known environmental).

- [ ] **Step 6: Commit**

```bash
git add packages/console/src/api/routes.ts packages/console/src/panels/Curate/data.ts packages/console/src/panels/Curate/selection.ts packages/console/src/panels/Curate/Curate.test.tsx
git commit -m "$(printf 'feat(rubric): Curate surfaces a Rubrics category to bundle\n\nCo-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>')"
```

---

## Self-Review

**Spec coverage:** §1 model → Task 1; §2 capture → Task 2; §3 build → Task 1; §4 server schemas → Task 3; §5 /api/inventory (no code) → covered by Task 3's InventorySchema; §6 console schemas → Task 4; §7 Curate → Task 4. Testing (buildGem, introspectConfig, API, console) → Tasks 1–4. ✅

**Placeholder scan:** none — every code step shows the full edit; every run step shows the command + expected result. Console-test placement ("if a selection.test.ts exists") is a locate-the-file instruction, not an open requirement.

**Type consistency:** `RubricArtifact` shape identical across Tasks 1/3; `GemSelection.rubrics?: string[]` identical across build (Task 1), server schema (Task 3), console (Task 4); `rubricToArtifact` reused (not redefined). `ConfigInventory.rubrics` optional everywhere.

**CI note:** Tasks 1–3 tests gate in CI (root `dist/**/__tests__`); Task 4's console test does NOT gate in CI (run locally). The API integration test (Task 3) is the CI-gated end-to-end proof that a rubric bundles through the real request path.
