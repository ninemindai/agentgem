# Lessons-as-Artifacts (Gem Contributions #1) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn a distilled **Lesson** into an **instructions artifact** that folds into a Gem build — the missing, source-agnostic leg so a Playbook can carry wins (skills) + lessons (instructions).

**Architecture:** Mirror the *exact* shipped skill-draft path. A new `DistilledLesson` type + a pure `reflectionToLesson` source adapter (in `@agentgem/insight`); `lessonToArtifact` / `distilledLessonMarkdown` / `writeDistilledLesson` / `stageDistilledLessons` / `stageLessonsByEvidence` (in `@agentgem/capture`, symmetric to the skill helpers); a `DistilledLessonSchema` + a `distilledLessons` field threaded into the build request schemas; a `POST /api/workflow/lesson` accept endpoint; and lesson staging added beside every `stageDraftsByEvidence` build site. Server + model only; no UI; deterministic-only (no LLM) — the meaningful-session LLM source is subsystem #2.

**Tech Stack:** TypeScript ESM (`.js`-extension relative imports), Zod, @agentback REST, vitest. Spec: `docs/superpowers/specs/2026-06-30-lessons-as-artifacts-design.md`.

## Global Constraints

- **Base branch:** cut from freshly-fetched `origin/main` (currently `2b3abcc`), not local `main`.
- **Git identity:** commits authored as `Raymond Feng <raymond@ninemind.ai>`; end every commit message with `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`.
- **ESM:** relative imports use `.js` extensions; **package** imports (`@agentgem/insight`, `@agentgem/capture`, `@agentgem/model`, `@agentgem/build`) are extensionless. New exports are picked up automatically by the package barrels (`packages/insight/src/index.ts` re-exports `./distillTypes.js`; `packages/capture/src/index.ts` re-exports `./draftStage.js`) — no barrel edits needed.
- **Tests run from compiled `dist/`:** always `pnpm exec tsc -b` before `pnpm exec vitest run`. New tests live in `src/gem/__tests__/` (compiled to `dist/gem/__tests__/`) and import the package barrels, mirroring `src/gem/__tests__/draftStage.test.ts`.
- **Focused test command:** `pnpm exec tsc -b && pnpm exec vitest run dist/gem/__tests__/<name>.test.js`.
- **Privacy boundary (hard):** a lesson's artifact `content` may contain only the already-scrubbed `Reflection.detail` + a sessions **count** + importance — never raw transcript text, never `sessionId`s.
- **Deterministic only:** no LLM calls in this subsystem. No UI.
- **Surgical:** match the existing draftStage/distill style exactly; do not refactor neighboring code.

---

### Task 1: `DistilledLesson` type + `reflectionToLesson` source adapter

**Files:**
- Modify: `packages/insight/src/distillTypes.ts` (add type + functions; mirror `DistilledSkill`/`Reflection` already there)
- Test: `src/gem/__tests__/reflectionToLesson.test.ts` (create)

**Interfaces:**
- Consumes: `Reflection`, `Provenance` (already exported from `packages/insight/src/distillTypes.ts`).
- Produces:
  - `interface DistilledLesson { name: string; body: string; importance: "high" | "medium"; status: "draft"; evidence: { sessions: number; root: string; provenance: Provenance } }`
  - `reflectionToLesson(r: Reflection, root: string): DistilledLesson | null` — `null` for `kind === "unresolved-task"`.
  - `reflectionsToLessons(reflections: Reflection[], root: string): DistilledLesson[]` — maps, drops nulls, de-duplicates `name` (collision-suffix `-2`, `-3`, …).
  - `lessonSlug(detail: string): string` — kebab slug of the first ≤6 word-ish tokens; `"lesson"` when empty.

- [ ] **Step 1: Write the failing test**

Create `src/gem/__tests__/reflectionToLesson.test.ts`:

```ts
// src/gem/__tests__/reflectionToLesson.test.ts
import { describe, it, expect } from "vitest";
import { reflectionToLesson, reflectionsToLessons, lessonSlug } from "@agentgem/insight";
import type { Reflection } from "@agentgem/insight";

const prov = (sessionIds: string[]) => ({
  occurrences: sessionIds.map((sessionId, i) => ({ sessionId, transcript: "t.jsonl", messageIndices: [i], atMs: 0 })),
});
const refl = (kind: Reflection["kind"], detail: string, sessionIds = ["s1"]): Reflection => ({
  kind, detail, importance: "high", provenance: prov(sessionIds),
});

describe("lessonSlug", () => {
  it("kebabs the leading words and caps length", () => {
    expect(lessonSlug("Always rebuild dist before running vitest because reasons here")).toBe("always-rebuild-dist-before-running-vitest");
  });
  it("falls back to 'lesson' for empty/symbol-only detail", () => {
    expect(lessonSlug("!!! ???")).toBe("lesson");
  });
});

describe("reflectionToLesson", () => {
  it("promotes a recurring-pattern to a draft lesson with sessions count + root", () => {
    const l = reflectionToLesson(refl("recurring-pattern", "Rebuild dist before vitest.", ["s1", "s2", "s1"]), "/repo");
    expect(l).not.toBeNull();
    expect(l!.status).toBe("draft");
    expect(l!.body).toBe("Rebuild dist before vitest.");
    expect(l!.importance).toBe("high");
    expect(l!.evidence.root).toBe("/repo");
    expect(l!.evidence.sessions).toBe(2); // distinct sessionIds
    expect(l!.name).toBe("rebuild-dist-before-vitest");
  });
  it("promotes a recurring-decision too", () => {
    expect(reflectionToLesson(refl("recurring-decision", "Prefer worktrees.", ["s1"]), "/r")).not.toBeNull();
  });
  it("excludes unresolved-task (returns null)", () => {
    expect(reflectionToLesson(refl("unresolved-task", "Finish the migration.", ["s1"]), "/r")).toBeNull();
  });
});

describe("reflectionsToLessons", () => {
  it("drops nulls and de-duplicates colliding names", () => {
    const ls = reflectionsToLessons([
      refl("recurring-pattern", "Same lesson text.", ["s1"]),
      refl("unresolved-task", "ignored", ["s1"]),
      refl("recurring-decision", "Same lesson text.", ["s2"]),
    ], "/r");
    expect(ls).toHaveLength(2);
    expect(ls.map((l) => l.name)).toEqual(["same-lesson-text", "same-lesson-text-2"]);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm exec tsc -b && pnpm exec vitest run dist/gem/__tests__/reflectionToLesson.test.js`
Expected: FAIL — `reflectionToLesson`/`reflectionsToLessons`/`lessonSlug` are not exported (compile or import error).

- [ ] **Step 3: Add the type + functions**

Append to `packages/insight/src/distillTypes.ts` (after the existing `DistilledSkill` interface):

```ts
// A distilled LESSON: a salient learning rendered as draft instructions. Mirrors
// DistilledSkill (status:"draft", evidence carries the coordinates-only provenance),
// but source-agnostic — provenance may span one or many sessions, no recurrence assumed.
export interface DistilledLesson {
  name: string;          // kebab slug, path-safe
  body: string;          // the scrubbed lesson text (already privacy-safe)
  importance: "high" | "medium";
  status: "draft";
  evidence: { sessions: number; root: string; provenance: Provenance };
}

export function lessonSlug(detail: string): string {
  const slug = detail.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "")
    .split("-").filter(Boolean).slice(0, 6).join("-");
  return slug || "lesson";
}

// One reflection → one draft lesson. `root` is the analyze project root (a Reflection
// carries no root). `unresolved-task` is a personal gap, not a shareable lesson → null.
export function reflectionToLesson(r: Reflection, root: string): DistilledLesson | null {
  if (r.kind === "unresolved-task") return null;
  const sessions = new Set(r.provenance.occurrences.map((o) => o.sessionId)).size;
  return { name: lessonSlug(r.detail), body: r.detail, importance: r.importance, status: "draft",
    evidence: { sessions, root, provenance: r.provenance } };
}

// Batch adapter: map → drop nulls → de-duplicate names (collision-suffix -2, -3, …).
export function reflectionsToLessons(reflections: Reflection[], root: string): DistilledLesson[] {
  const out: DistilledLesson[] = [];
  const seen = new Map<string, number>();
  for (const r of reflections) {
    const l = reflectionToLesson(r, root);
    if (!l) continue;
    const n = seen.get(l.name) ?? 0;
    seen.set(l.name, n + 1);
    out.push(n === 0 ? l : { ...l, name: `${l.name}-${n + 1}` });
  }
  return out;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm exec tsc -b && pnpm exec vitest run dist/gem/__tests__/reflectionToLesson.test.js`
Expected: PASS (all cases).

- [ ] **Step 5: Commit**

```bash
git add packages/insight/src/distillTypes.ts src/gem/__tests__/reflectionToLesson.test.ts
git commit -m "feat(insight): DistilledLesson type + reflectionToLesson source adapter

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 2: `lessonToArtifact` + `distilledLessonMarkdown`

**Files:**
- Modify: `packages/capture/src/draftStage.ts` (add beside `distilledSkillMarkdown`/`distilledToArtifact`)
- Test: `src/gem/__tests__/lessonStage.test.ts` (create)

**Interfaces:**
- Consumes: `DistilledLesson` (Task 1, from `@agentgem/insight`); `InstructionsArtifact` (from `@agentgem/model`).
- Produces:
  - `distilledLessonMarkdown(l: DistilledLesson): string`
  - `lessonToArtifact(l: DistilledLesson): InstructionsArtifact` — `{ type: "instructions", name: l.name, content: <markdown> }`.

- [ ] **Step 1: Write the failing test**

Create `src/gem/__tests__/lessonStage.test.ts`:

```ts
// src/gem/__tests__/lessonStage.test.ts
import { describe, it, expect } from "vitest";
import { distilledLessonMarkdown, lessonToArtifact } from "@agentgem/capture";
import type { DistilledLesson } from "@agentgem/insight";

const lesson: DistilledLesson = {
  name: "rebuild-dist-before-vitest",
  body: "Rebuild dist before running vitest, or stale compiled tests run.",
  importance: "high",
  status: "draft",
  evidence: { sessions: 3, root: "/r", provenance: { occurrences: [
    { sessionId: "secret-session-id", transcript: "t.jsonl", messageIndices: [4], atMs: 0 },
  ] } },
};

describe("distilledLessonMarkdown", () => {
  it("renders the lesson body + a sessions-count footer", () => {
    const md = distilledLessonMarkdown(lesson);
    expect(md).toContain("Rebuild dist before running vitest");
    expect(md).toContain("3 sessions");
    expect(md).toContain("importance: high");
  });
  it("never leaks raw provenance (no sessionId in content)", () => {
    expect(distilledLessonMarkdown(lesson)).not.toContain("secret-session-id");
  });
});

describe("lessonToArtifact", () => {
  it("produces an instructions artifact carrying the markdown", () => {
    const a = lessonToArtifact(lesson);
    expect(a.type).toBe("instructions");
    expect(a.name).toBe("rebuild-dist-before-vitest");
    expect(a.content).toContain("Rebuild dist before running vitest");
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm exec tsc -b && pnpm exec vitest run dist/gem/__tests__/lessonStage.test.js`
Expected: FAIL — `distilledLessonMarkdown`/`lessonToArtifact` not exported.

- [ ] **Step 3: Implement**

In `packages/capture/src/draftStage.ts`, extend the imports and add the functions. Update the existing model import to also bring in `InstructionsArtifact`, and the insight import to bring in `DistilledLesson`:

```ts
import type { ConfigInventory, SkillArtifact, InstructionsArtifact } from "@agentgem/model";
import type { DistilledSkill, DistilledLesson } from "@agentgem/insight";
```

Add (next to `distilledSkillMarkdown`/`distilledToArtifact`):

```ts
// Render a lesson as instructions markdown: the scrubbed body + a coordinates-free
// footer (sessions COUNT + importance only — never sessionIds or raw content).
export function distilledLessonMarkdown(l: DistilledLesson): string {
  const n = l.evidence.sessions;
  return [
    `# Lesson: ${l.name}`,
    "",
    l.body.trim(),
    "",
    `> Distilled from ${n} session${n === 1 ? "" : "s"} — importance: ${l.importance}.`,
    "",
  ].join("\n");
}

export function lessonToArtifact(l: DistilledLesson): InstructionsArtifact {
  return { type: "instructions", name: l.name, content: distilledLessonMarkdown(l) };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm exec tsc -b && pnpm exec vitest run dist/gem/__tests__/lessonStage.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/capture/src/draftStage.ts src/gem/__tests__/lessonStage.test.ts
git commit -m "feat(capture): lessonToArtifact + distilledLessonMarkdown

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 3: lesson staging into the gem build + `writeDistilledLesson`

**Files:**
- Modify: `packages/capture/src/draftStage.ts` (add staging + write helpers)
- Test: `src/gem/__tests__/lessonStage.test.ts` (extend Task 2's file)

**Interfaces:**
- Consumes: `lessonToArtifact` (Task 2); `ConfigInventory` (`@agentgem/model`); `agentgemHome` (already imported in `draftStage.ts`); `buildGem` (`@agentgem/build`) for the integration test.
- Produces:
  - `writeDistilledLesson(l: DistilledLesson, base?: string): string` — writes `<base>/.agentgem/distilled/lessons/<name>.md`, returns the path.
  - `stageDistilledLessons(inv: ConfigInventory, lessons: DistilledLesson[], root: string): ConfigInventory` — pure; merges lesson artifacts into `inventory.instructions` (project-scoped by `root`, else top-level); no-op (same ref) when empty; never mutates input.
  - `stageLessonsByEvidence(inv: ConfigInventory, lessons: DistilledLesson[]): ConfigInventory` — groups by `evidence.root`, applies `stageDistilledLessons` per root.

- [ ] **Step 1: Write the failing test**

Append to `src/gem/__tests__/lessonStage.test.ts`:

```ts
import { writeDistilledLesson, stageDistilledLessons, stageLessonsByEvidence } from "@agentgem/capture";
import { buildGem } from "@agentgem/build";
import type { ConfigInventory } from "@agentgem/model";
import { mkdtempSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

function emptyInv(): ConfigInventory {
  return {
    skills: [], mcpServers: [], instructions: [], hooks: [],
    projects: [{ root: "/r", name: "app", skills: [], mcpServers: [], instructions: [], hooks: [] }],
  };
}
const at = (root: string): DistilledLesson => ({ ...lesson, evidence: { ...lesson.evidence, root } });

describe("stageDistilledLessons", () => {
  it("stages a lesson so buildGem includes it as an instructions artifact", () => {
    const staged = stageDistilledLessons(emptyInv(), [at("/r")], "/r");
    const gem = buildGem(staged, { projects: { "/r": { includeInstructions: true } } });
    const art = gem.artifacts.find((a) => a.name === "rebuild-dist-before-vitest");
    expect(art?.type).toBe("instructions");
  });
  it("does not mutate the input inventory", () => {
    const inv = emptyInv();
    stageDistilledLessons(inv, [at("/r")], "/r");
    expect(inv.projects![0].instructions).toHaveLength(0);
  });
  it("is a no-op (same ref) for an empty list", () => {
    const inv = emptyInv();
    expect(stageDistilledLessons(inv, [], "/r")).toBe(inv);
  });
});

describe("stageLessonsByEvidence", () => {
  it("routes each lesson to its evidence.root", () => {
    const staged = stageLessonsByEvidence(emptyInv(), [at("/r")]);
    expect(staged.projects![0].instructions).toHaveLength(1);
  });
});

describe("writeDistilledLesson", () => {
  it("writes .agentgem/distilled/lessons/<name>.md and returns the path", () => {
    const base = mkdtempSync(join(tmpdir(), "lessonw-"));
    const path = writeDistilledLesson(at("/r"), base);
    expect(path).toBe(join(base, ".agentgem", "distilled", "lessons", "rebuild-dist-before-vitest.md"));
    expect(existsSync(path)).toBe(true);
    expect(readFileSync(path, "utf8")).toContain("Rebuild dist before running vitest");
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm exec tsc -b && pnpm exec vitest run dist/gem/__tests__/lessonStage.test.js`
Expected: FAIL — the three new functions are not exported.

- [ ] **Step 3: Implement**

In `packages/capture/src/draftStage.ts`, ensure `mkdirSync, writeFileSync` and `join` are imported (they already are, used by `writeDistilledDraft`/`stageDistilledDrafts`). Add:

```ts
// Persist an accepted lesson to <base>/.agentgem/distilled/lessons/<name>.md for review/promote.
// `name` is a validated kebab slug (re-validated at the accept endpoint), so path-safe.
export function writeDistilledLesson(l: DistilledLesson, base: string = agentgemHome()): string {
  const dir = join(base, ".agentgem", "distilled", "lessons");
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `${l.name}.md`);
  writeFileSync(path, distilledLessonMarkdown(l), "utf8");
  return path;
}

// Merge lessons into inventory.instructions — project-scoped by `root`, else top-level.
// Pure; never mutates input; no-op (same ref) when empty. Symmetric to stageDistilledDrafts.
export function stageDistilledLessons(inv: ConfigInventory, lessons: DistilledLesson[], root: string): ConfigInventory {
  if (!lessons.length) return inv;
  const arts = lessons.map(lessonToArtifact);
  const matched = (inv.projects ?? []).some((p) => p.root === root);
  const projects = (inv.projects ?? []).map((p) =>
    p.root === root ? { ...p, instructions: [...p.instructions, ...arts] } : p);
  return matched
    ? { ...inv, projects }
    : { ...inv, instructions: [...inv.instructions, ...arts], projects: inv.projects ? projects : undefined };
}

// Stage each lesson into the project named by its own evidence.root (lessons may span projects).
export function stageLessonsByEvidence(inv: ConfigInventory, lessons: DistilledLesson[]): ConfigInventory {
  if (!lessons.length) return inv;
  const byRoot = new Map<string, DistilledLesson[]>();
  for (const l of lessons) {
    const list = byRoot.get(l.evidence.root) ?? [];
    list.push(l);
    byRoot.set(l.evidence.root, list);
  }
  let out = inv;
  for (const [root, list] of byRoot) out = stageDistilledLessons(out, list, root);
  return out;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm exec tsc -b && pnpm exec vitest run dist/gem/__tests__/lessonStage.test.js`
Expected: PASS — including the `buildGem` integration test (a staged lesson appears in the gem as an `instructions` artifact). This is the headline proof: **a lesson reaches a gem.**

- [ ] **Step 5: Commit**

```bash
git add packages/capture/src/draftStage.ts src/gem/__tests__/lessonStage.test.ts
git commit -m "feat(capture): stage lessons into gem builds + writeDistilledLesson

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 4: `DistilledLessonSchema` + thread `distilledLessons` through the build endpoints

**Files:**
- Modify: `src/schemas.ts` (add `DistilledLessonSchema`; add `distilledLessons` to 3 request schemas)
- Modify: `src/gem.controller.ts` (import `stageLessonsByEvidence`; stage lessons at the 3 `distilledLessons`-bearing build sites)
- Test: `src/gem/__tests__/lessonBuild.test.ts` (create)

**Interfaces:**
- Consumes: `DistilledLessonSchema` shape mirrors `DistilledLesson` (Task 1); `stageLessonsByEvidence` (Task 3); existing `stageDraftsByEvidence`, `introspectAll`, `buildGem`.
- Produces: `DistilledLessonSchema` (exported from `src/schemas.ts`); a `distilledLessons?: DistilledLesson[]` field on `GemRequestSchema`, `ScaffoldChecksRequestSchema`, `TransferSendRequestSchema`.

- [ ] **Step 1: Write the failing test**

Create `src/gem/__tests__/lessonBuild.test.ts` (drives the controller's `/gem` build through staging):

```ts
// src/gem/__tests__/lessonBuild.test.ts
import { describe, it, expect } from "vitest";
import { DistilledLessonSchema, GemRequestSchema } from "../../schemas.js";

describe("DistilledLessonSchema", () => {
  it("accepts a valid lesson and rejects a bad importance", () => {
    const ok = { name: "x", body: "b", importance: "high", status: "draft",
      evidence: { sessions: 1, root: "/r", provenance: { occurrences: [] } } };
    expect(DistilledLessonSchema.safeParse(ok).success).toBe(true);
    expect(DistilledLessonSchema.safeParse({ ...ok, importance: "low" }).success).toBe(false);
    expect(DistilledLessonSchema.safeParse({ ...ok, status: "installed" }).success).toBe(false);
  });
  it("is wired into GemRequestSchema as an optional array (shape key present)", () => {
    // The field-threading itself is guarded by tsc (the controller reads
    // input.body.distilledLessons) + Task 3's staging proof; here we only assert
    // the key exists on the request schema so a regression that drops it is caught.
    expect(Object.keys((GemRequestSchema as unknown as { shape: Record<string, unknown> }).shape))
      .toContain("distilledLessons");
  });
});
```

*Grounded:* `src/gem/__tests__/*` reach `src/` via `../../` — confirmed by sibling tests (e.g. `src/gem/__tests__/scorecardBuild.test.ts` imports `from "../../gem.controller.js"`). So `../../schemas.js` resolves to `src/schemas.ts` (compiled `dist/gem/__tests__/…` → `dist/schemas.js`). `GemRequestSchema` is a `z.object`, so `.shape` exposes its keys.

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm exec tsc -b && pnpm exec vitest run dist/gem/__tests__/lessonBuild.test.js`
Expected: FAIL — `DistilledLessonSchema` is not exported.

- [ ] **Step 3: Add the schema + thread the field**

In `src/schemas.ts`, add after `ReflectionSchema` (which ends near line 189):

```ts
export const DistilledLessonSchema = z.object({
  name: z.string(),
  body: z.string(),
  importance: z.enum(["high", "medium"]),
  status: z.literal("draft"),
  evidence: z.object({
    sessions: z.number(),
    root: z.string(),
    provenance: ProvenanceSchema,
  }),
});
```

Add one line to each of `GemRequestSchema`, `ScaffoldChecksRequestSchema`, `TransferSendRequestSchema` (right beside their existing `distilledDrafts:` line):

```ts
  distilledLessons: z.array(DistilledLessonSchema).optional(),
```

In `src/gem.controller.ts`, extend the existing capture import (currently `import { writeDistilledDraft, stageDraftsByEvidence } from "@agentgem/capture";`) to also import `stageLessonsByEvidence`, then at each of the three `distilledLessons`-bearing build sites — `/gem`, `/scaffold-checks`, `/transfer/send` — wrap the inventory so lessons stage alongside drafts. For `/gem`:

```ts
    const inventory = stageLessonsByEvidence(
      stageDraftsByEvidence(introspectAll(input.body.dir, input.body.projects), input.body.distilledDrafts ?? []),
      input.body.distilledLessons ?? [],
    );
```

Apply the identical wrap at `/scaffold-checks` and `/transfer/send` (same `input.body.*` references). Leave `scorecardBuild` (which builds `drafts` internally, not from the request body) unchanged — its lesson source is subsystem #2.

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm exec tsc -b && pnpm exec vitest run dist/gem/__tests__/lessonBuild.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/schemas.ts src/gem.controller.ts src/gem/__tests__/lessonBuild.test.ts
git commit -m "feat(api): DistilledLessonSchema + thread distilledLessons into gem builds

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 5: `POST /api/workflow/lesson` accept endpoint

**Files:**
- Modify: `src/gem.controller.ts` (add the endpoint; import `writeDistilledLesson`)
- Test: `src/gem/__tests__/workflowLesson.test.ts` (create)

**Interfaces:**
- Consumes: `DistilledLessonSchema` (Task 4); `WorkflowDraftWriteResponseSchema` (existing, `{ path: string }` — reuse); `writeDistilledLesson` (Task 3).
- Produces: `POST /api/workflow/lesson` — body `DistilledLessonSchema`, response `{ path }`. Re-validates the kebab `name` (defense-in-depth, it composes a path) and writes via `writeDistilledLesson`.

- [ ] **Step 1: Write the failing test**

Create `src/gem/__tests__/workflowLesson.test.ts`. `GemController` is **zero-arg** (`new GemController()`, confirmed by `src/__tests__/gem.controller.test.ts` and `src/gem/__tests__/workflowAnalyze.test.ts`). The endpoint writes to the **default** `agentgemHome()`, so wrap with `useHermeticHome()` (the same fixture the scorecard controller tests use) to redirect `AGENTGEM_HOME` to a temp dir — otherwise the test writes into the developer's real `~/.agentgem`:

```ts
// src/gem/__tests__/workflowLesson.test.ts
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { GemController } from "../../gem.controller.js";
import { useHermeticHome } from "../../__tests__/support/hermeticHome.js";

let restoreHome: () => void;
beforeAll(() => { restoreHome = useHermeticHome(); });
afterAll(() => restoreHome());

const lesson = (name: string) => ({ name, body: "Rebuild dist before vitest.", importance: "high" as const,
  status: "draft" as const, evidence: { sessions: 2, root: "/r", provenance: { occurrences: [] } } });

describe("POST /api/workflow/lesson", () => {
  it("writes the lesson under the (hermetic) home and returns its path", async () => {
    const c = new GemController();
    const { path } = await c.writeWorkflowLesson({ body: lesson("rebuild-dist-before-vitest") });
    expect(path.endsWith("/.agentgem/distilled/lessons/rebuild-dist-before-vitest.md")).toBe(true);
    expect(existsSync(path)).toBe(true);
    expect(readFileSync(path, "utf8")).toContain("Rebuild dist before vitest");
  });
  it("rejects a non-kebab name", async () => {
    const c = new GemController();
    await expect(c.writeWorkflowLesson({ body: lesson("Bad Name!") })).rejects.toThrow(/invalid lesson name/);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm exec tsc -b && pnpm exec vitest run dist/gem/__tests__/workflowLesson.test.js`
Expected: FAIL — `writeWorkflowLesson` does not exist.

- [ ] **Step 3: Implement**

In `src/gem.controller.ts`, add `writeDistilledLesson` to the `@agentgem/capture` import, and add the endpoint right after the existing `writeWorkflowDraft` method (`POST /workflow/draft`):

```ts
  // Accept a distilled LESSON: persist it to .agentgem/distilled/lessons/<name>.md for
  // review/promote (mirrors workflow/draft). The kebab name is re-validated here (defense
  // in depth) since it composes a path.
  @post("/workflow/lesson", { body: DistilledLessonSchema, response: WorkflowDraftWriteResponseSchema })
  async writeWorkflowLesson(input: { body: z.infer<typeof DistilledLessonSchema> }): Promise<z.infer<typeof WorkflowDraftWriteResponseSchema>> {
    const lesson = input.body;
    if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(lesson.name)) throw new Error(`invalid lesson name '${lesson.name}'`);
    return { path: writeDistilledLesson(lesson) };
  }
```

Ensure `DistilledLessonSchema` and `WorkflowDraftWriteResponseSchema` are imported in `src/gem.controller.ts` (check the existing `from "./schemas.js"` import block and add `DistilledLessonSchema` if absent; `WorkflowDraftWriteResponseSchema` is already imported for `workflow/draft`).

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm exec tsc -b && pnpm exec vitest run dist/gem/__tests__/workflowLesson.test.js`
Expected: PASS.

- [ ] **Step 5: Run the full focused suite for this feature + commit**

```bash
pnpm exec tsc -b && pnpm exec vitest run dist/gem/__tests__/reflectionToLesson.test.js dist/gem/__tests__/lessonStage.test.js dist/gem/__tests__/lessonBuild.test.js dist/gem/__tests__/workflowLesson.test.js
```
Expected: all PASS.

```bash
git add src/gem.controller.ts src/gem/__tests__/workflowLesson.test.ts
git commit -m "feat(api): POST /api/workflow/lesson accept endpoint

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Final verification (after all tasks)

- `pnpm exec tsc -b` clean (whole workspace compiles).
- The four feature test files pass: `pnpm exec vitest run dist/gem/__tests__/reflectionToLesson.test.js dist/gem/__tests__/lessonStage.test.js dist/gem/__tests__/lessonBuild.test.js dist/gem/__tests__/workflowLesson.test.js`.
- Full suite (`pnpm test`) — expect green except the known real-FS scan flakes under full-suite concurrency (observeScan/scorecard/observe.controller — pre-existing, verify any failure in isolation before attributing it to this change).

## The loop this delivers

`Reflection → reflectionToLesson → DistilledLesson` → either **(a)** `POST /api/workflow/lesson` writes a reviewable `.agentgem/distilled/lessons/<name>.md`, or **(b)** passed as `distilledLessons` to `/gem` (or `/scaffold-checks`, `/transfer/send`) → `stageLessonsByEvidence` → an `instructions` artifact in the built gem. A Playbook can now carry **wins (skills) + lessons (instructions)**. The meaningful-single-session LLM source (#2) emits `DistilledLesson`s through this same seam.
