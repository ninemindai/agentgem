# Rubric-gem Phase 2A — Install-back wiring — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A received rubric-gem's rubric lands in `~/.agentgem/rubrics/` and shows in the Rubrics picker, via all three receive-time install handlers, with each response reporting `{ installed, skipped }`.

**Architecture:** Call the existing (Phase 1) `installRubricGem(gem)` in `applyGem`, `installHosted`, and `registryInstall` (`src/gem.controller.ts`), and add an additive optional `rubrics` field to each handler's response schema + its console-route mirror. `gemToInventory` (`packages/run/src/runGem.ts`) is documented, not changed — rubrics are global, not a testbed artifact. No inventory-model, `GemSelection`, `buildGem`, or console-UI change (those are slices 2B/2C).

**Tech Stack:** TypeScript (ESM), Zod, `@agentback/rest` controllers, vitest + supertest, pnpm `tsc -b` project references.

## Global Constraints

- **Install-wiring only.** No change to the eval engine, catalog functions, `/api/rubrics`, the Rubrics/RubricLibrary panels, `ConfigInventory`/`ProjectInventory`, `GemSelection`, `buildGem`, or Curate.
- **`installRubricGem(gem)` is called with the DEFAULT dir** (`defaultRubricsDir()` → `agentgemHome()`, honors `AGENTGEM_HOME`, `packages/model/src/resolveDir.ts:28`). Never inject a `dir` through the controller.
- **The `rubrics` response field is additive and OPTIONAL**, shape exactly `{ installed: string[]; skipped: string[] }`. No existing response field is changed.
- **Rubrics are declarative** — they must not affect `installHosted`'s consent gate. `executableArtifacts` (`src/gem/hostedInstall.ts:11`) filters only `mcp_server`/`hook`; a rubric-only gem must install without a `consent_required` 409.
- **Tests live under root `src/**/__tests__`** (CI gates only root `dist/**/__tests__`). Suite = `pnpm test` = `tsc -b && vitest run` against compiled `dist/`. Focused: `pnpm exec tsc -b && pnpm exec vitest run dist/<path>.test.js`.
- **Test isolation** uses the `AGENTGEM_HOME` seam (set to a `mkdtempSync` temp dir; the existing `src/__tests__/gem.controller.test.ts` already does this in `beforeAll`/`afterAll`).
- **Commit trailer:** end every commit message with `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`.

---

### Task 1: Optional `rubrics` field on the three install responses

**Files:**
- Modify: `src/schemas.ts` (add `RubricInstallResultSchema`; add the field to `GemApplyResponseSchema` at :776 and `RegistryInstallResponseSchema` at :980)
- Modify: `src/gem.controller.ts` (add the field to the inline `InstallHostedResult` at :16; import `RubricInstallResultSchema`)
- Modify: `packages/console/src/api/routes.ts` (add the field to `gemApplyRoute` :418, `installHostedRoute` :809, `registryInstallRoute` :298 responses)
- Test: `src/__tests__/schemas.test.ts`

**Interfaces:**
- Produces: `RubricInstallResultSchema` (exported from `../schemas.js`); an optional `rubrics: { installed: string[]; skipped: string[] }` on all three server response schemas + their three console-route mirrors.

- [ ] **Step 1: Write the failing test**

In `src/__tests__/schemas.test.ts`, add `GemApplyResponseSchema, RubricInstallResultSchema` to the import from `../schemas.js`, then add at the end of the file:

```ts
describe("install responses carry an optional rubrics result", () => {
  it("RubricInstallResultSchema parses installed/skipped and rejects a missing array", () => {
    expect(RubricInstallResultSchema.safeParse({ installed: ["a"], skipped: [] }).success).toBe(true);
    expect(RubricInstallResultSchema.safeParse({ installed: ["a"] }).success).toBe(false);
  });
  it("GemApplyResponseSchema accepts rubrics and also omits it", () => {
    const base = { dir: "/d", name: "g", written: [], skipped: [] };
    expect(GemApplyResponseSchema.safeParse(base).success).toBe(true);
    expect(GemApplyResponseSchema.safeParse({ ...base, rubrics: { installed: ["r"], skipped: [] } }).success).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm exec tsc -b`
Expected: FAIL — `'RubricInstallResultSchema' has no exported member` (import error).

- [ ] **Step 3: Add the schema + fields (server)**

In `src/schemas.ts`, add near the other install schemas (immediately before `GemApplyResponseSchema` at line 776):

```ts
export const RubricInstallResultSchema = z.object({
  installed: z.array(z.string()),
  skipped: z.array(z.string()),
});
```

Add the field to `GemApplyResponseSchema` (:776):

```ts
export const GemApplyResponseSchema = z.object({
  dir: z.string(),
  name: z.string(),
  written: z.array(ImportedRefSchema),
  skipped: z.array(z.object({ artifact: z.string(), reason: z.string() })),
  rubrics: RubricInstallResultSchema.optional(),
});
```

Add the field to `RegistryInstallResponseSchema` (:980):

```ts
export const RegistryInstallResponseSchema = z.object({
  plan: InstallPlanSchema,
  applied: z.discriminatedUnion("mode", [
    z.object({ mode: z.literal("materialize"), dest: z.string(), written: z.array(z.string()) }),
    z.object({ mode: z.literal("workspace"), workspace: z.string() }),
  ]),
  rubrics: RubricInstallResultSchema.optional(),
});
```

In `src/gem.controller.ts`, add `RubricInstallResultSchema` to the existing import from `./schemas.js` (the block around line 265 that already imports `GemApplyRequestSchema, GemApplyResponseSchema, …`), then extend the inline `InstallHostedResult` (:16):

```ts
const InstallHostedResult = z.object({ workspace: z.string(), executables: z.object({ mcp: z.array(z.string()), hooks: z.array(z.string()) }), rubrics: RubricInstallResultSchema.optional() });
```

- [ ] **Step 4: Add the fields (console-route mirrors)**

In `packages/console/src/api/routes.ts`, add a local shape once (near the top, after the imports):

```ts
const RubricInstallResult = z.object({ installed: z.array(z.string()), skipped: z.array(z.string()) });
```

Add `rubrics: RubricInstallResult.optional(),` to the `response:` object of each of these three route defs:
- `gemApplyRoute` (:418) — inside its `response: z.object({ dir, name, written, skipped })`.
- `installHostedRoute` (:809) — inside its `response: z.object({ workspace, executables })`.
- `registryInstallRoute` (:298) — inside its `response: z.object({ applied })`.

- [ ] **Step 5: Run test to verify it passes**

Run: `pnpm exec tsc -b && pnpm exec vitest run dist/__tests__/schemas.test.js`
Expected: PASS (all `schemas.test.js`, including the 2 new cases).

- [ ] **Step 6: Commit**

```bash
git add src/schemas.ts src/gem.controller.ts packages/console/src/api/routes.ts src/__tests__/schemas.test.ts
git commit -m "$(printf 'feat(rubric): optional rubrics{installed,skipped} on the three install responses\n\nCo-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>')"
```

---

### Task 2: Wire `installRubricGem` into all three handlers (+ applyGem integration tests)

**Files:**
- Modify: `src/gem.controller.ts` (import `installRubricGem`; call it in `applyGem` :901, `installHosted` :664, `registryInstall` :1285; include `rubrics` in each return)
- Modify: `packages/run/src/runGem.ts` (one-line comment on `gemToInventory` :156)
- Test: `src/__tests__/gem.controller.test.ts` (new `describe` block + a shared `rubricGemBytes` helper)

**Interfaces:**
- Consumes: `installRubricGem(gem): { installed: string[]; skipped: string[] }` (`src/rubricCore.ts`, Phase 1); the `rubrics` response field (Task 1).
- Produces: the `rubricGemBytes(gemName, rubricId)` test helper reused by Task 3.

- [ ] **Step 1: Write the failing test**

In `src/__tests__/gem.controller.test.ts`, add to the imports:

```ts
import { rubricToArtifact, builtinRubrics, loadRubrics } from "@agentgem/insight";
import type { RubricArtifact } from "@agentgem/model";
```

(`writeGemArchive`, `packTar`, and `type Gem` are already imported.) Then add, after the existing `POST /api/gem/apply` describe block:

```ts
// Build a .gem (base64) carrying exactly one rubric artifact with the given id.
function rubricGemBytes(gemName: string, rubricId: string): string {
  const base = builtinRubrics().find((r) => r.id === "context-hygiene")!;
  const rubric: RubricArtifact = { ...rubricToArtifact(base), name: rubricId };
  const gem: Gem = { name: gemName, createdFrom: "test", artifacts: [rubric], checks: [], requiredSecrets: [] };
  return packTar(writeGemArchive(gem).files).toString("base64");
}

describe("POST /api/gem/apply installs a bundled rubric globally", () => {
  it("lands the rubric in the store and reports it", async () => {
    const target = mkdtempSync(join(tmpdir(), "apply-rub-"));
    try {
      const r = await client.post("/api/gem/apply")
        .send({ bytesBase64: rubricGemBytes("rub-pack", "team-hygiene"), dir: target }).expect(200);
      expect(r.body.rubrics.installed).toContain("team-hygiene");
      expect(loadRubrics().map((x: { id: string }) => x.id)).toContain("team-hygiene");
    } finally { rmSync(target, { recursive: true, force: true }); }
  });
  it("skips a rubric whose id collides with a built-in", async () => {
    const target = mkdtempSync(join(tmpdir(), "apply-rub2-"));
    try {
      const r = await client.post("/api/gem/apply")
        .send({ bytesBase64: rubricGemBytes("rub-pack2", "hygiene"), dir: target }).expect(200);
      expect(r.body.rubrics.skipped).toContain("hygiene");
      expect(r.body.rubrics.installed).not.toContain("hygiene");
    } finally { rmSync(target, { recursive: true, force: true }); }
  });
  it("reports empty rubrics for a skill-only gem", async () => {
    const gem: Gem = { name: "skill-only", createdFrom: "test",
      artifacts: [{ type: "skill", name: "s", source: "project", content: "# S" }], checks: [], requiredSecrets: [] };
    const bytesBase64 = packTar(writeGemArchive(gem).files).toString("base64");
    const target = mkdtempSync(join(tmpdir(), "apply-noskill-"));
    try {
      const r = await client.post("/api/gem/apply").send({ bytesBase64, dir: target }).expect(200);
      expect(r.body.rubrics).toEqual({ installed: [], skipped: [] });
    } finally { rmSync(target, { recursive: true, force: true }); }
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm exec tsc -b && pnpm exec vitest run dist/__tests__/gem.controller.test.js -t "installs a bundled rubric"`
Expected: FAIL — `r.body.rubrics` is `undefined` (handler doesn't populate it yet), so `.installed` throws / `toContain` fails.

- [ ] **Step 3: Wire the handlers**

In `src/gem.controller.ts`, add `installRubricGem` to the existing `./rubricCore.js` import (line 31):

```ts
import { listRubricsWithMeta, validateRubricInput, saveRubric, deleteRubric, installRubricGem } from "./rubricCore.js";
```

`applyGem` (:901) — add the call and field:

```ts
  async applyGem(input: { body: z.infer<typeof GemApplyRequestSchema> }): Promise<z.infer<typeof GemApplyResponseSchema>> {
    const { gem } = importGem(Buffer.from(input.body.bytesBase64, "base64"));
    const dir = resolveProject(input.body.dir);
    const { written, skipped } = materializeGemToTestbed(gem, dir, (input.body.flavor ?? "claude") as TestbedFlavorId);
    const rubrics = installRubricGem(gem);
    return { dir, name: gem.name, written, skipped, rubrics };
  }
```

`installHosted` (:664) — add after `createWorkspace` (so a consent-refused install writes nothing):

```ts
    createWorkspace(name, gem, { version });
    const rubrics = installRubricGem(gem);
    return { workspace: name, executables, rubrics };
```

`registryInstall` (:1285) — compute once after `resolveInstall`, include in both mode returns:

```ts
    const { plan, gem } = await resolveInstall({ refs: input.body.refs, mode: input.body.mode, target: input.body.target as TargetId | undefined, source, a2aServer: input.body.a2aServer });
    const rubrics = installRubricGem(gem);
    const installed = plan.items.map((it) => ({ gemKey: it.key, version: it.version, gemDigest: "" }));
    if (input.body.mode === "materialize") {
      if (!input.body.dest) throw new Error("materialize mode requires `dest`");
      writeArchiveDir(input.body.dest, plan.materialize!.files);
      void emitAdoption(installed);
      return { plan, applied: { mode: "materialize", dest: input.body.dest, written: Object.keys(plan.materialize!.files) }, rubrics };
    }
    const name = input.body.workspaceName ?? gem.name;
    createWorkspace(name, gem);
    void emitAdoption(installed);
    return { plan, applied: { mode: "workspace", workspace: name }, rubrics };
```

In `packages/run/src/runGem.ts`, add a comment inside `gemToInventory` (after the `for` loop, before `return inv;`):

```ts
  // type === "rubric" artifacts are intentionally NOT partitioned here: rubrics are global
  // (~/.agentgem/rubrics) with no testbed home. They are installed at gem-receive time by
  // installRubricGem in the install handlers (src/gem.controller.ts), not materialized to a testbed.
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm exec tsc -b && pnpm exec vitest run dist/__tests__/gem.controller.test.js -t "installs a bundled rubric"`
Expected: PASS (3 cases).

- [ ] **Step 5: Note the registryInstall coverage gap**

`registryInstall`'s success path has no cheap test harness (its only existing test, `gem.controller.test.ts:927`, asserts it *throws* without a configured registry source). Its rubric wiring is byte-identical to `applyGem`/`installHosted`, and `installRubricGem` is unit-tested (Phase 1). This is a deliberate, documented coverage gap — record it in the task report so the final review can decide whether a registry-source fixture is warranted. Do **not** invent a heavy registry fixture here.

- [ ] **Step 6: Commit**

```bash
git add src/gem.controller.ts packages/run/src/runGem.ts src/__tests__/gem.controller.test.ts
git commit -m "$(printf 'feat(rubric): install bundled rubrics at receive-time in all three install handlers\n\nCo-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>')"
```

---

### Task 3: installHosted integration test (stub aggregator) — install + no consent prompt

**Files:**
- Test: `src/__tests__/gem.controller.test.ts` (new `describe` block; reuses the Task 2 `rubricGemBytes` helper)

**Interfaces:**
- Consumes: `rubricGemBytes` (Task 2); `installHosted`'s `rubrics` field (Tasks 1–2); the `AGENTGEM_AGGREGATOR_URL` seam (`src/gem/hostedInstall.ts:29-33`, `fetchHostedArchive` resolves its base from that env var).

- [ ] **Step 1: Write the failing-then-passing test**

`createServer` from `node:http` is already imported. Add after the Task 2 rubric-apply block:

```ts
describe("POST /api/install-hosted installs a bundled rubric with no consent prompt", () => {
  let stub: ReturnType<typeof createServer>;
  let prevAgg: string | undefined;
  beforeAll(async () => {
    const b64 = rubricGemBytes("hosted-rub", "hosted-hygiene");
    stub = createServer((_req, res) => {
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ archiveBase64: b64 }));   // fetchHostedArchive reads { archiveBase64 }
    });
    await new Promise<void>((resolve) => stub.listen(0, resolve));
    const addr = stub.address() as import("node:net").AddressInfo;
    prevAgg = process.env.AGENTGEM_AGGREGATOR_URL;
    process.env.AGENTGEM_AGGREGATOR_URL = `http://127.0.0.1:${addr.port}`;
  });
  afterAll(async () => {
    await new Promise<void>((resolve) => stub.close(() => resolve()));
    if (prevAgg !== undefined) process.env.AGENTGEM_AGGREGATOR_URL = prevAgg;
    else delete process.env.AGENTGEM_AGGREGATOR_URL;
  });
  it("returns 200 (no consent_required) and reports the installed rubric", async () => {
    const r = await client.post("/api/install-hosted").send({ key: "acme/hosted", version: "0.1.0" }).expect(200);
    expect(r.body.rubrics.installed).toContain("hosted-hygiene");
    expect(loadRubrics().map((x: { id: string }) => x.id)).toContain("hosted-hygiene");
  });
});
```

- [ ] **Step 2: Run the test**

Run: `pnpm exec tsc -b && pnpm exec vitest run dist/__tests__/gem.controller.test.js -t "install-hosted installs a bundled rubric"`
Expected: PASS. (A rubric-only gem has no executable artifacts, so `hasExecutable` is false → no `consent_required` 409; the `.expect(200)` is the consent-not-triggered assertion.)

- [ ] **Step 3: Full suite (no regressions)**

Run: `pnpm test`
Expected: PASS. If `consoleMount.test.js` is the only failure, that is the known environmental case (needs `pnpm build` to produce `dist/console`); run `pnpm build` once and re-check `consoleMount` to confirm it passes with the console bundle. Note any pre-existing failure explicitly rather than attributing it to this change.

- [ ] **Step 4: Commit**

```bash
git add src/__tests__/gem.controller.test.ts
git commit -m "$(printf 'test(rubric): installHosted lands a bundled rubric without a consent prompt\n\nCo-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>')"
```

---

## Self-Review

**Spec coverage:**
- §"install at receive-time, all three paths" → Task 2 wires `applyGem`/`installHosted`/`registryInstall`. ✅
- §"surface {installed,skipped}" → Task 1 (schema field) + Task 2/3 (populated + asserted). ✅
- §"consent gate unaffected" → Task 3 asserts a rubric-only `installHosted` returns 200, not 409. ✅
- §"gemToInventory document not change" → Task 2 Step 3 comment; no `ConfigInventory` edit. ✅
- §"deliberate asymmetry / no inventory-model change" → no `ConfigInventory`/`GemSelection`/`buildGem`/Curate files touched. ✅
- §Testing (per-handler, built-in skip, non-rubric, consent) → Task 2 (apply: install/skip/non-rubric) + Task 3 (hosted: install/consent). registryInstall success path is a documented gap (Task 2 Step 5). ✅
- §Test isolation via `AGENTGEM_HOME` → reuses `gem.controller.test.ts`'s existing `beforeAll` isolation. ✅

**Placeholder scan:** none — every code step shows full code; every run step shows the command + expected result. The registryInstall coverage gap is explicitly flagged, not silently skipped.

**Type consistency:** `rubrics` field shape `{ installed: string[]; skipped: string[] }` is identical across `RubricInstallResultSchema` (Task 1), the three handlers' returns (Task 2), and the console mirrors; `rubricGemBytes(gemName, rubricId)` signature is identical where defined (Task 2) and reused (Task 3); `installRubricGem`'s `{ installed, skipped }` return matches the field verbatim.

**Note on the shared test store:** all rubric tests run under the suite-wide `AGENTGEM_HOME` set in `gem.controller.test.ts`'s `beforeAll`; assertions use `.toContain`/response-body checks (never whole-store equality), so accumulated rubric files across cases don't cause cross-test interference.
