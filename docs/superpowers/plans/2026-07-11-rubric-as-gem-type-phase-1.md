# Rubric as a Gem type — Phase 1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make a rubric a first-class Gem artifact (`RubricArtifact`) that serializes into and out of a `.gem` archive and can be installed into the existing rubric store — with zero change to the evaluation engine, catalog, API, or console UI.

**Architecture:** Add a `RubricArtifact` type + Zod schema to `@agentgem/model`/`src/schemas.ts` and to the `GemArtifact` union; teach `@agentgem/archive` to read/write a `rubrics/<name>.json` file per rubric; add `rubricToArtifact`/`artifactToRubric` adapters in `@agentgem/insight`; add an `installRubricGem` store-bridge helper in `src/rubricCore.ts` that writes an installed gem's rubric artifacts to `~/.agentgem/rubrics/` where `loadRubrics` already reads them. The evaluation engine keeps consuming the insight `Rubric` shape unchanged. Wiring these functions into buildGem-selection, the console install route, and the unified library is **out of scope** (Phase 2).

**Tech Stack:** TypeScript (ESM), Zod, vitest, pnpm workspaces with `tsc -b` project references.

## Global Constraints

- **Serialization boundary only.** No edits to the evaluation engine (`packages/insight/src/rubricReport.ts`, `criterionJudge.ts`), the catalog behavior (`resolveRubric`/`listRubrics` output), `/api/rubrics`, or the console UI.
- **Tests run against compiled `dist/`.** The suite is `pnpm test` = `tsc -b && vitest run` (`package.json:48`). Root vitest includes only `dist/**/__tests__/**/*.test.js` (`vitest.config.ts:5`), which is the CI gate. **Every new test MUST live under root `src/**/__tests__/`** (compiles to `dist/**/__tests__/`) — a test placed under `packages/*/src/__tests__` will NOT run in CI.
- **Focused test run:** `pnpm exec tsc -b && pnpm exec vitest run dist/<path>.test.js`. If you edit or remove already-compiled files and see stale behavior, `pnpm clean` then rebuild.
- **Rubric identity:** the artifact uses `name` (kebab, equal to the engine's `Rubric.id`) plus a display `title`. The insight `Rubric` shape keeps `id`/`title` and is not modified.
- **Kebab id regex (verbatim):** `/^[a-z0-9][a-z0-9-]{0,63}$/`.
- **Reserved built-ins:** rubric ids `hygiene` and `context-hygiene` (`packages/insight/src/rubrics.ts:170-197`) are built-in and must never be overwritten on install.
- **Commit trailer:** end every commit message with `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`.

---

### Task 1: `RubricArtifact` type in `@agentgem/model`

Define the rubric payload shapes directly in model (structurally mirroring insight's, so the adapters in Task 3 compile via structural typing — no cross-package relocation). `LlmCriterion.severity` is inlined as `"info" | "warn"` to avoid dragging insight's `DetectorSeverity` backwards across the package boundary.

**Files:**
- Modify: `packages/model/src/types.ts` (line 6 `ArtifactType`; add types before the `GemArtifact` union at line 145)
- Test: `src/__tests__/rubricArtifact.test.ts` (create)

**Interfaces:**
- Produces: `RubricArtifact`, `RubricFactorRef`, `LlmCriterion`, `RubricScopeKind`, `RubricGranularity` (exported from `@agentgem/model`); `"rubric"` added to `ArtifactType` and thereby to `ReferenceArtifact.refKind`.

- [ ] **Step 1: Write the failing test**

Create `src/__tests__/rubricArtifact.test.ts`:

```ts
// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
import { describe, it, expect } from "vitest";
import type { GemArtifact, RubricArtifact } from "@agentgem/model";

const hygiene: RubricArtifact = {
  type: "rubric",
  name: "hygiene",
  title: "Session hygiene",
  target: "overview",
  naturalScope: "project",
  factors: [{ factor: "retry-storm" }, { factor: "thrash-loop", weight: 2 }],
};

describe("RubricArtifact type", () => {
  it("is a member of the GemArtifact union", () => {
    const artifacts: GemArtifact[] = [hygiene];
    expect(artifacts[0].type).toBe("rubric");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm exec tsc -b`
Expected: FAIL — `error TS2305: Module '"@agentgem/model"' has no exported member 'RubricArtifact'`.

- [ ] **Step 3: Add the types**

In `packages/model/src/types.ts`, change line 6 to add `"rubric"`:

```ts
export type ArtifactType = "skill" | "mcp_server" | "instructions" | "hook" | "channel" | "subagent" | "game" | "rubric";
```

Then insert, immediately BEFORE the `GemArtifact` union declaration (currently line 145):

```ts
// ── Rubric payload (mirrors @agentgem/insight's Rubric shapes structurally; adapters bridge them) ──
export type RubricScopeKind = "session" | "project" | "all";
export type RubricGranularity = "session" | "aggregate";
export interface RubricFactorRef { factor: string; weight?: number }
export interface LlmCriterion {
  id: string;
  title: string;
  question: string;
  severity?: "info" | "warn";
  advice: string;
  granularity?: RubricGranularity;
}
export interface RubricArtifact {
  type: "rubric";
  name: string;               // kebab identity — equals the engine's Rubric.id
  title: string;              // display title
  target: string;
  naturalScope?: RubricScopeKind;
  factors: RubricFactorRef[];
  criteria?: LlmCriterion[];
}
```

Add `RubricArtifact` to the union on the next line:

```ts
export type GemArtifact = SkillArtifact | McpServerArtifact | InstructionsArtifact | HookArtifact | ChannelArtifact | SubagentArtifact | GameArtifact | ReferenceArtifact | RubricArtifact;
```

(`ReferenceArtifact.refKind` is typed `ArtifactType` at line 141, so it already accepts `"rubric"` — no edit needed there.)

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm exec tsc -b && pnpm exec vitest run dist/__tests__/rubricArtifact.test.js`
Expected: PASS (1 test).

- [ ] **Step 5: Commit**

```bash
git add packages/model/src/types.ts src/__tests__/rubricArtifact.test.ts
git commit -m "$(printf 'feat(model): add RubricArtifact to the GemArtifact union\n\nCo-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>')"
```

---

### Task 2: Zod `RubricArtifactSchema` in the wire union

The wire schema is a structural gate on the archive contract; the authoritative trim/collision validation still lives in `validateRubric` (used by the store bridge in Task 5). Mirror `validateRubric`'s structural rules (`packages/insight/src/rubrics.ts:89-126`).

**Files:**
- Modify: `src/schemas.ts` (add schemas near `SkillArtifactSchema` ~line 26; add to `GemArtifactSchema` union at line 129; add `"rubric"` to `ReferenceArtifactSchema.refKind` enum at line 95)
- Test: `src/__tests__/schemas.test.ts` (modify — import list at line 10-12 and a new `describe`)

**Interfaces:**
- Consumes: nothing from earlier tasks (Zod only).
- Produces: `RubricArtifactSchema` (exported from `../schemas.js` / `@agentgem/*` consumers); `"rubric"` accepted by `GemArtifactSchema` and `ReferenceArtifactSchema`.

- [ ] **Step 1: Write the failing test**

In `src/__tests__/schemas.test.ts`, add `RubricArtifactSchema` to the import from `../schemas.js` (the block ending line 12), then add this `describe` block at the end of the file:

```ts
describe("RubricArtifactSchema", () => {
  const valid = {
    type: "rubric",
    name: "my-rubric",
    title: "My rubric",
    target: "overview",
    naturalScope: "project",
    factors: [{ factor: "retry-storm", weight: 2 }],
    criteria: [{ id: "c1", title: "T", question: "Q?", advice: "A", severity: "warn" }],
  };

  it("GemArtifactSchema parses a valid rubric artifact", () => {
    expect(GemArtifactSchema.safeParse(valid).success).toBe(true);
  });

  it("rejects a non-kebab name", () => {
    expect(GemArtifactSchema.safeParse({ ...valid, name: "Bad Name" }).success).toBe(false);
  });

  it("rejects an empty factors array", () => {
    expect(GemArtifactSchema.safeParse({ ...valid, factors: [] }).success).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm exec tsc -b`
Expected: FAIL — `'RubricArtifactSchema' has no exported member` (import error).

- [ ] **Step 3: Add the schema**

In `src/schemas.ts`, insert after `SkillArtifactSchema` (after line 26):

```ts
const RubricFactorRefSchema = z.object({
  factor: z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/),
  weight: z.number().finite().min(0).optional(),
});

const LlmCriterionSchema = z.object({
  id: z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/),
  title: z.string().min(1),
  question: z.string().min(1),
  severity: z.enum(["info", "warn"]).optional(),
  advice: z.string().min(1),
  granularity: z.enum(["session", "aggregate"]).optional(),
});

export const RubricArtifactSchema = z.object({
  type: z.literal("rubric"),
  name: z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/),
  title: z.string().min(1),
  target: z.string().min(1),
  naturalScope: z.enum(["session", "project", "all"]).optional(),
  factors: z.array(RubricFactorRefSchema).min(1),
  criteria: z.array(LlmCriterionSchema).optional(),
});
```

Add `RubricArtifactSchema` as the final member of the `GemArtifactSchema` discriminated union (line 129-138):

```ts
export const GemArtifactSchema = z.discriminatedUnion("type", [
  SkillArtifactSchema,
  McpServerArtifactSchema,
  InstructionsArtifactSchema,
  HookArtifactSchema,
  ChannelArtifactSchema,
  SubagentArtifactSchema,
  GameArtifactSchema,
  ReferenceArtifactSchema,
  RubricArtifactSchema,
]);
```

Add `"rubric"` to the `ReferenceArtifactSchema.refKind` enum (line 95):

```ts
  refKind: z.enum(["skill", "mcp_server", "instructions", "hook", "channel", "subagent", "game", "rubric"]),
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm exec tsc -b && pnpm exec vitest run dist/__tests__/schemas.test.js`
Expected: PASS (all `wire schemas` tests including the 3 new ones).

- [ ] **Step 5: Commit**

```bash
git add src/schemas.ts src/__tests__/schemas.test.ts
git commit -m "$(printf 'feat(schemas): add RubricArtifactSchema to the gem-archive wire union\n\nCo-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>')"
```

---

### Task 3: `rubricToArtifact` / `artifactToRubric` adapters

Bridge the engine's `Rubric` (insight) and the wire `RubricArtifact` (model). ~5 lines each; the round-trip test is also the structural-drift guard between the two shapes.

**Files:**
- Create: `packages/insight/src/rubricArtifact.ts`
- Modify: `packages/insight/src/index.ts` (add re-export line near line 53, next to `export * from "./rubrics.js";`)
- Test: `src/__tests__/rubricArtifact.test.ts` (extend the file from Task 1)

**Interfaces:**
- Consumes: `RubricArtifact` from `@agentgem/model` (Task 1); `Rubric` from `./rubrics.js`.
- Produces: `rubricToArtifact(r: Rubric): RubricArtifact` and `artifactToRubric(a: RubricArtifact): Rubric`, exported from `@agentgem/insight`.

- [ ] **Step 1: Write the failing test**

Append to `src/__tests__/rubricArtifact.test.ts`. Add `rubricToArtifact, artifactToRubric` to the imports from `@agentgem/insight` (add an import line) and `builtinRubrics, type Rubric` too:

```ts
import { rubricToArtifact, artifactToRubric, builtinRubrics, type Rubric } from "@agentgem/insight";

describe("rubric <-> artifact adapters", () => {
  it("round-trips every built-in rubric", () => {
    for (const r of builtinRubrics()) {
      expect(artifactToRubric(rubricToArtifact(r))).toEqual(r);
    }
  });

  it("maps id<->name and preserves criteria", () => {
    const r: Rubric = {
      id: "with-crit",
      title: "With criteria",
      target: "overview",
      factors: [{ factor: "c1", weight: 3 }],
      criteria: [{ id: "c1", title: "T", question: "Q?", advice: "A", granularity: "aggregate" }],
    };
    const a = rubricToArtifact(r);
    expect(a.name).toBe("with-crit");
    expect(a.title).toBe("With criteria");
    expect(artifactToRubric(a)).toEqual(r);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm exec tsc -b`
Expected: FAIL — `'rubricToArtifact' has no exported member` (import error).

- [ ] **Step 3: Write the adapters**

Create `packages/insight/src/rubricArtifact.ts`:

```ts
// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
// packages/insight/src/rubricArtifact.ts
//
// Bridge the engine's Rubric (id/title, this package) and the wire RubricArtifact
// (name/title, @agentgem/model, a GemArtifact union member). The two payload shapes
// are structurally identical; only the identity field name differs (id <-> name).
import type { RubricArtifact } from "@agentgem/model";
import type { Rubric } from "./rubrics.js";

export function rubricToArtifact(r: Rubric): RubricArtifact {
  const a: RubricArtifact = { type: "rubric", name: r.id, title: r.title, target: r.target, factors: r.factors };
  if (r.naturalScope !== undefined) a.naturalScope = r.naturalScope;
  if (r.criteria !== undefined) a.criteria = r.criteria;
  return a;
}

export function artifactToRubric(a: RubricArtifact): Rubric {
  const r: Rubric = { id: a.name, title: a.title, target: a.target, factors: a.factors };
  if (a.naturalScope !== undefined) r.naturalScope = a.naturalScope;
  if (a.criteria !== undefined) r.criteria = a.criteria;
  return r;
}
```

In `packages/insight/src/index.ts`, add next to the other rubric export (line 53):

```ts
export * from "./rubricArtifact.js";
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm exec tsc -b && pnpm exec vitest run dist/__tests__/rubricArtifact.test.js`
Expected: PASS (all rubricArtifact tests).

- [ ] **Step 5: Commit**

```bash
git add packages/insight/src/rubricArtifact.ts packages/insight/src/index.ts src/__tests__/rubricArtifact.test.ts
git commit -m "$(printf 'feat(insight): add rubric<->artifact adapters\n\nCo-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>')"
```

---

### Task 4: Archive read/write for rubric artifacts

Teach `@agentgem/archive` to serialize a `RubricArtifact` to `rubrics/<name>.json` and read it back, mirroring the JSON-body pattern used by `mcp_server`/`hook`/`channel`. This is what lets a `.gem` carry a rubric losslessly.

**Files:**
- Modify: `packages/archive/src/archive.ts` (model type import block lines 5-10; write branch after the `hook` branch ~line 152; read branch immediately before the hook fallthrough at line 324)
- Test: `src/gem/__tests__/rubricArchive.test.ts` (create — model on `src/gem/__tests__/gameArchive.test.ts`)

**Interfaces:**
- Consumes: `RubricArtifact` and its payload types from `@agentgem/model` (Task 1).
- Produces: `writeGemArchive`/`readGemArchive` round-trip a `RubricArtifact` unchanged.

- [ ] **Step 1: Write the failing test**

Create `src/gem/__tests__/rubricArchive.test.ts`:

```ts
// src/gem/__tests__/rubricArchive.test.ts
import { describe, it, expect } from "vitest";
import { writeGemArchive, readGemArchive } from "@agentgem/archive";
import type { Gem, RubricArtifact } from "@agentgem/model";

const rubric: RubricArtifact = {
  type: "rubric",
  name: "context-hygiene",
  title: "Context hygiene",
  target: "overview",
  naturalScope: "all",
  factors: [{ factor: "task-sprawl" }, { factor: "reread-churn", weight: 2 }],
  criteria: [{ id: "deep", title: "Deep", question: "Deep review?", advice: "Do it", severity: "warn" }],
};

const gem: Gem = {
  name: "hygiene-pack",
  createdFrom: "test",
  artifacts: [rubric],
  checks: [],
  requiredSecrets: [],
};

describe("rubric archive round-trip", () => {
  it("writes and reads a rubric artifact unchanged", () => {
    const { files } = writeGemArchive(gem);
    expect("rubrics/context-hygiene.json" in files).toBe(true);
    const back = readGemArchive(files);
    expect(back.artifacts).toEqual([rubric]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm exec tsc -b && pnpm exec vitest run dist/gem/__tests__/rubricArchive.test.js`
Expected: FAIL — the round-tripped gem's artifacts are empty / `readGemArchive` throws `unknown artifact type 'rubric'` (the write branch drops it and/or the read branch rejects it).

- [ ] **Step 3: Implement the archive branches**

In `packages/archive/src/archive.ts`, extend the `@agentgem/model` type import (lines 5-10) to add the rubric types:

```ts
import type {
  Gem, GemArtifact, ArtifactType,
  SkillArtifact, McpServerArtifact, HookArtifact, GemCheck,
  ChannelArtifact, SecretRef, ReferenceArtifact, SubagentArtifact, GemContract, GameArtifact,
  LoopSpec, LoopGuardrails, LoopSchedule, LoopGoal,
  RubricArtifact, RubricScopeKind, RubricFactorRef, LlmCriterion,
} from "@agentgem/model";
```

Add the WRITE branch inside `writeGemArchive`, immediately after the `hook` branch (after line 152, before the loop's closing `}` at line 153):

```ts
    } else if (a.type === "rubric") {
      const path = `rubrics/${withExt(seg, ".json")}`;
      const body: Record<string, unknown> = { title: a.title, target: a.target, factors: a.factors };
      if (a.naturalScope !== undefined) body.naturalScope = a.naturalScope;
      if (a.criteria !== undefined) body.criteria = a.criteria;
      if (place(path, JSON.stringify(body, null, 2), a.name, "rubric")) artifacts.push({ type: "rubric", name: a.name, path });
```

Add the READ branch inside `readGemArchive`'s `.map`, immediately BEFORE the hook fallthrough (before line 324 `if (e.type !== "hook") throw ...`):

```ts
    if (e.type === "rubric") {
      const o = JSON.parse(body(e.path)) as { title: string; target: string; naturalScope?: RubricScopeKind; factors: RubricFactorRef[]; criteria?: LlmCriterion[] };
      const a: RubricArtifact = { type: "rubric", name: e.name, title: o.title, target: o.target, factors: o.factors };
      if (o.naturalScope !== undefined) a.naturalScope = o.naturalScope;
      if (o.criteria !== undefined) a.criteria = o.criteria;
      return a;
    }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm exec tsc -b && pnpm exec vitest run dist/gem/__tests__/rubricArchive.test.js`
Expected: PASS (1 test).

- [ ] **Step 5: Commit**

```bash
git add packages/archive/src/archive.ts src/gem/__tests__/rubricArchive.test.ts
git commit -m "$(printf 'feat(archive): serialize rubric artifacts to rubrics/<name>.json\n\nCo-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>')"
```

---

### Task 5: `installRubricGem` store bridge + end-to-end proof

Write an installed gem's rubric artifacts into `~/.agentgem/rubrics/` (the dir `loadRubrics` already reads), reusing `validateRubric` as the authority and refusing to overwrite built-in ids. The final test proves the whole path: build a gem → `exportGem` → `importGem` → `installRubricGem` → the rubric appears via `loadRubrics`. (Calling this from the console install route is Phase 2.)

**Files:**
- Modify: `src/rubricCore.ts` (add imports + `installRubricGem`)
- Test: `src/__tests__/rubricInstall.test.ts` (create)

**Interfaces:**
- Consumes: `artifactToRubric` (Task 3), `RubricArtifact` (Task 1), `validateRubric`/`builtinRubrics`/`loadRubrics`/`defaultRubricsDir` (existing `@agentgem/insight`), `rubricRegistry` (existing, `src/rubricCore.ts:43`), `exportGem`/`importGem` (`@agentgem/distribute`), `Gem` (`@agentgem/model`).
- Produces: `installRubricGem(gem: Gem, dir?: string): { installed: string[]; skipped: string[] }`.

- [ ] **Step 1: Write the failing test**

Create `src/__tests__/rubricInstall.test.ts`:

```ts
// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { builtinRubrics, loadRubrics, rubricToArtifact } from "@agentgem/insight";
import { exportGem, importGem } from "@agentgem/distribute";
import type { Gem } from "@agentgem/model";
import { installRubricGem } from "../rubricCore.js";

const dirs: string[] = [];
const tmp = () => { const d = mkdtempSync(join(tmpdir(), "rubric-install-")); dirs.push(d); return d; };
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

function gemWith(name: string): Gem {
  const r = builtinRubrics().find((x) => x.id === "context-hygiene")!;
  return { name, createdFrom: "test", artifacts: [{ ...rubricToArtifact(r), name }], checks: [], requiredSecrets: [] };
}

describe("installRubricGem", () => {
  it("installs rubric artifacts into the store so loadRubrics lists them", () => {
    const dir = tmp();
    const res = installRubricGem(gemWith("team-hygiene"), dir);
    expect(res.installed).toEqual(["team-hygiene"]);
    expect(loadRubrics(dir).map((r) => r.id)).toContain("team-hygiene");
  });

  it("refuses to overwrite a built-in id", () => {
    const dir = tmp();
    const res = installRubricGem(gemWith("hygiene"), dir);
    expect(res.installed).toEqual([]);
    expect(res.skipped).toEqual(["hygiene"]);
  });

  it("survives a full export -> import -> install round-trip", () => {
    const dir = tmp();
    const { bytes } = exportGem(gemWith("shared-hygiene"));
    const { gem } = importGem(bytes);
    installRubricGem(gem, dir);
    expect(loadRubrics(dir).map((r) => r.id)).toContain("shared-hygiene");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm exec tsc -b`
Expected: FAIL — `'installRubricGem' has no exported member` (import error).

- [ ] **Step 3: Implement `installRubricGem`**

In `src/rubricCore.ts`, add to the `@agentgem/insight` import block (lines 16-23) the names `artifactToRubric`:

```ts
  builtinRubrics, loadRubrics, validateRubric, defaultRubricsDir, evaluateRubric,
  artifactToRubric,
  DETECTORS, loadRuleDetectors,
```

Add a `@agentgem/model` type import for `Gem` and `RubricArtifact` (the file already imports `resolveDirs, resolveProject` from `@agentgem/model` at line 15 — extend it):

```ts
import { resolveDirs, resolveProject, type Gem, type RubricArtifact } from "@agentgem/model";
```

Then add the function (place it after `deleteRubric`, ~line 121):

```ts
/**
 * Install a gem's rubric artifacts into the rubric store (~/.agentgem/rubrics),
 * where loadRubrics already reads them. validateRubric is the authority (bad
 * rubrics are skipped); a built-in id is never overwritten. Returns the ids
 * written and the names skipped. Callers wire this into an install flow (Phase 2).
 */
export function installRubricGem(gem: Gem, dir = defaultRubricsDir()): { installed: string[]; skipped: string[] } {
  const builtinIds = new Set(builtinRubrics().map((r) => r.id));
  const reserved = new Set(rubricRegistry().map((s) => s.id));
  const installed: string[] = [];
  const skipped: string[] = [];
  for (const art of gem.artifacts) {
    if (art.type !== "rubric") continue;
    const rubricArt = art as RubricArtifact;
    const rubric = validateRubric(artifactToRubric(rubricArt), reserved);
    if (!rubric || builtinIds.has(rubric.id)) { skipped.push(rubricArt.name); continue; }
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, `${rubric.id}.json`), JSON.stringify(rubric, null, 2));
    installed.push(rubric.id);
  }
  return { installed, skipped };
}
```

(`mkdirSync`, `writeFileSync`, and `join` are already imported at `src/rubricCore.ts:12-13`.)

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm exec tsc -b && pnpm exec vitest run dist/__tests__/rubricInstall.test.js`
Expected: PASS (3 tests).

- [ ] **Step 5: Run the full suite (no regressions)**

Run: `pnpm test`
Expected: PASS — entire suite green, including existing `dist/__tests__/rubrics.test.js`, `rubricCore.test.js`, `schemas.test.js`, and `dist/gem/__tests__/archive.test.js`.

- [ ] **Step 6: Commit**

```bash
git add src/rubricCore.ts src/__tests__/rubricInstall.test.ts
git commit -m "$(printf 'feat(rubric): installRubricGem writes gem rubric artifacts to the store\n\nCo-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>')"
```

---

## Self-Review

**Spec coverage:**
- §A (RubricArtifact type in model, structural-mirror approach) → Task 1. ✅
- §B (adapters; engine unchanged) → Task 3; "engine unchanged" enforced by the Global Constraints and the absence of any edit to `rubricReport.ts`/`criterionJudge.ts`. ✅
- §C (store stays JSON; export via `rubricToArtifact`, install writes to `~/.agentgem/rubrics`) → the archive serialization is Task 4; the install-to-store bridge is Task 5. Export/install **call-site wiring** (buildGem selection, console route) is a spec non-goal → Phase 2. ✅
- §D (Zod schema + drift guard in the CI-gated `schemas.test.ts`) → Task 2. ✅
- §E (round-trip; install→run parity; schema accept/reject; legacy load unchanged; drift) → Task 3 (round-trip), Task 5 (install→loadRubrics parity + built-in refusal + export/import e2e), Task 2 (schema accept/reject), Task 5 Step 5 (`pnpm test` proves legacy rubric tests still pass). ✅

**Placeholder scan:** No TBD/TODO; every code step shows full code and every run step shows the exact command + expected result. ✅

**Type consistency:** `rubricToArtifact`/`artifactToRubric` signatures identical across Tasks 3 and 5; `RubricArtifact`/`RubricFactorRef`/`LlmCriterion`/`RubricScopeKind` names identical across Tasks 1, 2, 4; `installRubricGem` return shape `{ installed, skipped }` identical between its test (Task 5 Step 1) and implementation (Step 3). ✅

**Note on "install → run parity":** the spec's success criterion ("appears in the rubric picker and runs with identical results") is proven at the store level — Task 5 shows the installed rubric is listed by `loadRubrics` (the picker's source, `rubricCore.ts:57-60`). Because install writes the exact JSON `saveRubric` would write and the engine reads that JSON unchanged, run-time results are identical by construction; no engine test is needed or in scope.
