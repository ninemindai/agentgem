# `/learn` on a Session Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** One command/endpoint that distills a single named-or-latest Claude session into the existing dream review queue — intent-driven, never auto-accepting.

**Architecture:** A thin `learnFromSession` core resolves one transcript from the project's server-derived list, runs the existing `scanWorkflow → distillWorkflow + extractReflections` pipeline over it, and lands results via `harvestEntries` (new `"LEARN"` phase) → `enqueueNew` (existing dedup). Exposed as `POST /api/dream/learn` on the dream controller and an `agentgem learn` CLI subcommand. Spec: `docs/superpowers/specs/2026-07-03-learn-session-design.md`.

**Tech Stack:** TypeScript ESM monorepo (pnpm), vitest from compiled `dist/` (`pnpm exec tsc -b && pnpm exec vitest run dist/<path>.test.js`), AgentBack decorated controllers (tested by direct class instantiation with a `base` seam).

## Global Constraints

- Working dir: the `../agentgem-learn` worktree, branch `learn-session`.
- Nothing lands without accept: `/learn` only enqueues to the dream review queue — no writes to skills/lessons/gems.
- No cache reads or writes: single-session results must not touch the project-scoped distill cache.
- The `session` ref is compared against basenames of the server-derived transcript list; it is NEVER joined into a path. Unknown ref → `InvalidInputError` (→ 400 / CLI exit 2).
- "Nothing distilled" is success (`enqueued: 0`, CLI exit 0).
- No console (`packages/console`) code changes. Node built-ins only; no new dependencies. Commits `feat(scope):`/`fix(scope):`/`test(scope):`.

---

### Task 1: Queue phase `"LEARN"` (types + harvest + queue schema)

**Files:**
- Modify: `src/dream/types.ts` (line ~21: `phase: "DEEP" | "REM";`)
- Modify: `src/dream/harvest.ts` (`harvestEntries` at line 20; the two `phase: "DEEP"` literals at lines ~26 and ~39)
- Modify: `src/dream.controller.ts` (`QueueItemSchema.phase` at line ~35)
- Test: `src/dream/__tests__/harvest.test.ts` (extend)

**Interfaces:**
- Consumes: existing `DreamQueueEntry`, `harvestEntries(root, distilled, reflections, nowMs)`.
- Produces: `DreamQueueEntry.phase: "DEEP" | "REM" | "LEARN"`; `harvestEntries(root, distilled, reflections, nowMs, phase: "DEEP" | "LEARN" = "DEEP")` — Task 2 calls it with `"LEARN"`. `QueueItemSchema.phase` accepts `"LEARN"` so `GET /dream/queue` doesn't reject LEARN entries at response validation.

- [ ] **Step 1: Write the failing test**

Add to `src/dream/__tests__/harvest.test.ts` (read the file first; reuse its existing fixture helpers for `DistilledSkill`/`Reflection` — it necessarily has them since it tests `harvestEntries`):

```ts
  it("stamps entries with the given phase (LEARN) and defaults to DEEP", () => {
    // Reuse the file's existing skill/reflection fixtures for these calls.
    const learn = harvestEntries("/p", [skillFixture()], [], 1, "LEARN");
    expect(learn[0].phase).toBe("LEARN");
    const deep = harvestEntries("/p", [skillFixture()], [], 1);
    expect(deep[0].phase).toBe("DEEP");
    // Same evidence → same key regardless of phase: LEARN dedupes against DEEP harvests.
    expect(learn[0].key).toBe(deep[0].key);
  });
```

(If the file's skill fixture has a different name, use that name — the assertion structure stays identical.)

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm exec tsc -b && pnpm exec vitest run dist/dream/__tests__/harvest.test.js`
Expected: FAIL at compile — `harvestEntries` takes 4 arguments.

- [ ] **Step 3: Implement**

`src/dream/types.ts`: change the phase line to

```ts
  phase: "DEEP" | "REM" | "LEARN";
```

`src/dream/harvest.ts`: change the signature to

```ts
export function harvestEntries(root: string, distilled: DistilledSkill[], reflections: Reflection[], nowMs: number, phase: "DEEP" | "LEARN" = "DEEP"): DreamQueueEntry[] {
```

and replace both `phase: "DEEP",` literals inside it with `phase,`.

`src/dream.controller.ts`: change `QueueItemSchema`'s phase line to

```ts
  phase: z.enum(["DEEP", "REM", "LEARN"]),
```

(The console's Dreaming API types don't enumerate the queue item's phase — verified — so no console change.)

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm exec tsc -b && pnpm exec vitest run dist/dream/__tests__/harvest.test.js dist/__tests__/dream.controller.test.js`
Expected: PASS (all — existing DEEP/REM behavior unchanged by the defaulted param).

- [ ] **Step 5: Commit**

```bash
git add src/dream/types.ts src/dream/harvest.ts src/dream.controller.ts src/dream/__tests__/harvest.test.ts
git commit -m "feat(dream): LEARN queue phase — intent-driven entries distinguishable from harvests"
```

---

### Task 2: `learnFromSession` core

**Files:**
- Create: `src/learnCore.ts`
- Test: `src/__tests__/learnCore.test.ts` (new)

**Interfaces:**
- Consumes: `harvestEntries(..., "LEARN")` (Task 1); `enqueueNew`, `readQueue` from `src/dream/store.js`; `claudeTranscriptsForCwd`, `scanWorkflow`, `distillWorkflow`, `extractReflections` from `@agentgem/insight`; `introspectConfig`, `introspectProject` from `@agentgem/capture`; `resolveDirs`, `resolveProject`, `InvalidInputError` from `@agentgem/model`.
- Produces: `learnFromSession(opts): Promise<LearnResult>` with `LearnResult = { session: string; enqueued: number; skills: number; lessons: number; degraded: boolean }` — Tasks 3–4 call it.

- [ ] **Step 1: Write the failing test**

Create `src/__tests__/learnCore.test.ts`:

```ts
// src/__tests__/learnCore.test.ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { learnFromSession } from "../learnCore.js";
import { readQueue } from "../dream/store.js";
import type { DistilledSkill } from "@agentgem/insight";

const PROJ = "/Users/me/work/app";
let home: string;      // claude-home parent fixture
let claudeDir: string;
let base: string;      // queue store home

// Two sessions for PROJ; s-old older than s-new by mtime.
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "learn-"));
  claudeDir = join(home, ".claude");
  const enc = join(claudeDir, "projects", "enc-a");
  mkdirSync(enc, { recursive: true });
  for (const f of ["s-old.jsonl", "s-new.jsonl"]) {
    writeFileSync(join(enc, f), JSON.stringify({ type: "summary" }) + "\n" + JSON.stringify({ cwd: PROJ }) + "\n");
  }
  utimesSync(join(enc, "s-old.jsonl"), new Date(1000), new Date(1000));
  utimesSync(join(enc, "s-new.jsonl"), new Date(2000), new Date(2000));
  base = mkdtempSync(join(tmpdir(), "learn-base-"));
});
afterEach(() => { rmSync(home, { recursive: true, force: true }); rmSync(base, { recursive: true, force: true }); });

const prov = { occurrences: [{ sessionId: "s1", transcript: "t.jsonl", messageIndices: [1], atMs: 5 }] };
const fakeSkill = {
  name: "extract-api-client", description: "d", confidence: "high",
  evidence: { sessions: 1, exampleSequence: [], root: PROJ, provenance: prov },
} as unknown as DistilledSkill;
const distillOne = async () => ({ distilled: [fakeSkill], degraded: false });

describe("learnFromSession", () => {
  it("distills the newest session by default and enqueues LEARN entries", async () => {
    const r = await learnFromSession({ root: PROJ, dir: claudeDir, base, distillWf: distillOne, extractRefl: () => [] });
    expect(r.session).toBe("s-new.jsonl");
    expect(r).toMatchObject({ enqueued: 1, skills: 1, lessons: 0, degraded: false });
    const q = readQueue(base);
    expect(q).toHaveLength(1);
    expect(q[0]).toMatchObject({ kind: "skill", phase: "LEARN", name: "extract-api-client", status: "queued" });
  });

  it("targets a named session, with or without .jsonl", async () => {
    for (const ref of ["s-old", "s-old.jsonl"]) {
      const r = await learnFromSession({ root: PROJ, dir: claudeDir, base, session: ref, distillWf: distillOne, extractRefl: () => [] });
      expect(r.session).toBe("s-old.jsonl");
    }
  });

  it("rejects an unknown session ref with InvalidInputError (never treats it as a path)", async () => {
    await expect(learnFromSession({ root: PROJ, dir: claudeDir, base, session: "../../etc/passwd" }))
      .rejects.toThrow(/no session/i);
  });

  it("rejects a project with no sessions", async () => {
    await expect(learnFromSession({ root: "/Users/me/other", dir: claudeDir, base }))
      .rejects.toThrow(/no sessions/i);
  });

  it("re-learning the same evidence enqueues 0 (queue dedup)", async () => {
    await learnFromSession({ root: PROJ, dir: claudeDir, base, distillWf: distillOne, extractRefl: () => [] });
    const r2 = await learnFromSession({ root: PROJ, dir: claudeDir, base, distillWf: distillOne, extractRefl: () => [] });
    expect(r2).toMatchObject({ enqueued: 0, skills: 1 });
    expect(readQueue(base)).toHaveLength(1);
  });

  it("nothing distilled is a success, not an error", async () => {
    const r = await learnFromSession({
      root: PROJ, dir: claudeDir, base,
      distillWf: async () => ({ distilled: [], degraded: true }),
      extractRefl: () => [],
    });
    expect(r).toMatchObject({ enqueued: 0, skills: 0, lessons: 0, degraded: true });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm exec tsc -b && pnpm exec vitest run dist/__tests__/learnCore.test.js`
Expected: FAIL at compile — `../learnCore.js` does not exist.

- [ ] **Step 3: Implement the core**

Create `src/learnCore.ts`:

```ts
// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
// src/learnCore.ts
//
// The intent-driven distillation front door ("/learn on a session"): run the existing
// extractor pipeline over ONE transcript and land candidates in the dream review queue
// with phase "LEARN". Never auto-accepts (queue → accept/dismiss is the only exit) and
// never touches the project-scoped distill cache — a single session's results must not
// masquerade as the project-wide distill. The session ref selects from the server-derived
// transcript list by basename; it is never joined into a path.
import { statSync } from "node:fs";
import { basename } from "node:path";
import { introspectConfig, introspectProject } from "@agentgem/capture";
import { resolveDirs, resolveProject, InvalidInputError } from "@agentgem/model";
import {
  claudeTranscriptsForCwd, scanWorkflow, distillWorkflow, extractReflections,
} from "@agentgem/insight";
import { harvestEntries } from "./dream/harvest.js";
import { enqueueNew } from "./dream/store.js";

export interface LearnResult {
  session: string;   // basename of the distilled transcript
  enqueued: number;  // entries actually added (post-dedup)
  skills: number;    // candidate skills found (pre-dedup)
  lessons: number;   // candidate lessons found (pre-dedup, post reflectionToLesson filter)
  degraded: boolean; // LLM path unavailable → heuristic-only
}

export async function learnFromSession(opts: {
  root: string;
  dir?: string;
  session?: string;
  now?: () => number;
  distillWf?: typeof distillWorkflow;
  extractRefl?: typeof extractReflections;
  base?: string;
}): Promise<LearnResult> {
  const dirs = resolveDirs(opts.dir);
  const root = resolveProject(opts.root);
  const paths = claudeTranscriptsForCwd(dirs.claudeDir, root);
  if (!paths.length) throw new InvalidInputError(`no sessions recorded for ${root}`);

  let target: string;
  if (opts.session) {
    const want = opts.session.endsWith(".jsonl") ? opts.session : `${opts.session}.jsonl`;
    const hit = paths.find((p) => basename(p) === want);
    if (!hit) throw new InvalidInputError(`no session '${opts.session}' recorded for this project (${paths.length} known)`);
    target = hit;
  } else {
    target = paths
      .map((p) => ({ p, m: statSync(p).mtimeMs }))
      .sort((a, b) => b.m - a.m)[0].p;
  }

  const project = introspectProject(root);
  const g = introspectConfig(dirs);
  const scanInv = { project, global: { skills: g.skills, mcpServers: g.mcpServers, hooks: g.hooks } };
  const signal = scanWorkflow([target], scanInv, { retainSequences: true });
  const wf = await (opts.distillWf ?? distillWorkflow)(signal, scanInv);
  const reflections = (opts.extractRefl ?? extractReflections)(signal);

  const entries = harvestEntries(root, wf.distilled, reflections, (opts.now ?? Date.now)(), "LEARN");
  const added = enqueueNew(entries, opts.base);
  return {
    session: basename(target),
    enqueued: added.length,
    skills: wf.distilled.length,
    lessons: entries.filter((e) => e.kind === "lesson").length,
    degraded: wf.degraded,
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm exec tsc -b && pnpm exec vitest run dist/__tests__/learnCore.test.js`
Expected: PASS (6 tests). If `introspectProject` throws on the fixture project path not existing on disk, create the project dir in the fixture (`mkdirSync(PROJ...)` won't work — it's an absolute fake path). In that case switch the fixture to a real temp project root: `const PROJ = mkdtempSync(join(tmpdir(), "learn-proj-"))` set in `beforeEach` and used in the transcript `cwd` lines — adjust assertions accordingly. (Check how `src/__tests__/workflowCore.test.ts` handles this — it uses `"/proj"` with `introspectProject`? If it passes a fake path there, the fake `PROJ` is fine as written.)

- [ ] **Step 5: Commit**

```bash
git add src/learnCore.ts src/__tests__/learnCore.test.ts
git commit -m "feat(learn): learnFromSession — distill one session into the dream review queue"
```

---

### Task 3: `POST /api/dream/learn`

**Files:**
- Modify: `src/dream.controller.ts` (add schemas near the existing ones at ~line 18-53; add the endpoint method after `run` at ~line 132)
- Test: `src/__tests__/dream.controller.test.ts` (extend)

**Interfaces:**
- Consumes: `learnFromSession` (Task 2).
- Produces: `POST /api/dream/learn` with body `{ root, dir?, session? }` → `LearnResult` JSON. `InvalidInputError` → 400 via the app's existing error mapping.

- [ ] **Step 1: Write the failing test**

Add to `src/__tests__/dream.controller.test.ts` (the file tests the controller class directly with a `base` seam — follow that pattern; add the fs/os/path imports it already has):

```ts
  it("POST /dream/learn distills a session into the queue and returns counts", async () => {
    // Claude-home fixture with one session for a project.
    const home = mkdtempSync(join(tmpdir(), "dreamlearn-"));
    const claudeDir = join(home, ".claude");
    const enc = join(claudeDir, "projects", "enc-a");
    mkdirSync(enc, { recursive: true });
    writeFileSync(join(enc, "s1.jsonl"), JSON.stringify({ type: "summary" }) + "\n" + JSON.stringify({ cwd: "/Users/me/work/app" }) + "\n");
    const c = new DreamController();
    (c as unknown as { base: string }).base = base;
    try {
      const r = await c.learn({ body: { root: "/Users/me/work/app", dir: claudeDir } });
      // Synthetic near-empty transcript: the real pipeline finds nothing — that is success.
      expect(r.session).toBe("s1.jsonl");
      expect(r.enqueued).toBe(0);
      expect(typeof r.degraded).toBe("boolean");
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("POST /dream/learn rejects an unknown session ref", async () => {
    const home = mkdtempSync(join(tmpdir(), "dreamlearn-"));
    const claudeDir = join(home, ".claude");
    mkdirSync(join(claudeDir, "projects"), { recursive: true });
    const c = new DreamController();
    (c as unknown as { base: string }).base = base;
    try {
      await expect(c.learn({ body: { root: "/Users/me/work/app", dir: claudeDir, session: "nope" } }))
        .rejects.toThrow(/no session/i);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
```

(Adjust the imports at the top of the test file if `mkdirSync`/`writeFileSync`/`rmSync` aren't already imported — check first.)

- [ ] **Step 2: Run to verify they fail**

Run: `pnpm exec tsc -b && pnpm exec vitest run dist/__tests__/dream.controller.test.js`
Expected: FAIL at compile — `c.learn` does not exist.

- [ ] **Step 3: Implement the endpoint**

In `src/dream.controller.ts`, add near the other schemas:

```ts
const LearnBody = z.object({
  root: z.string().min(1),
  dir: z.string().optional(),      // claude-home override (tests / non-default homes)
  session: z.string().optional(),  // transcript basename (".jsonl" optional); default: newest
});
const LearnResultSchema = z.object({
  session: z.string(),
  enqueued: z.number(),
  skills: z.number(),
  lessons: z.number(),
  degraded: z.boolean(),
});
```

Import the core: `import { learnFromSession } from "./learnCore.js";` and add the method to the class:

```ts
  // Intent-driven distillation ("/learn on a session"): run the extractor over one
  // transcript now and land candidates in this review queue as phase:"LEARN". The
  // second entry point into the same queue — accept/dismiss flow is unchanged.
  @post("/dream/learn", { body: LearnBody, response: LearnResultSchema })
  async learn(input: { body: z.infer<typeof LearnBody> }): Promise<z.infer<typeof LearnResultSchema>> {
    return learnFromSession({ ...input.body, base: this.base });
  }
```

- [ ] **Step 4: Run to verify they pass**

Run: `pnpm exec tsc -b && pnpm exec vitest run dist/__tests__/dream.controller.test.js dist/__tests__/learnCore.test.js`
Expected: PASS (all).

- [ ] **Step 5: Commit**

```bash
git add src/dream.controller.ts src/__tests__/dream.controller.test.ts
git commit -m "feat(dream): POST /dream/learn — intent-driven session distillation endpoint"
```

---

### Task 4: `agentgem learn` CLI

**Files:**
- Create: `src/learnCli.ts`
- Modify: `src/cli.ts` (dispatch after the `verify` block at ~line 88; HELP line after the verify line at ~line 41)
- Test: `src/__tests__/learnCli.test.ts` (new)

**Interfaces:**
- Consumes: `learnFromSession`, `LearnResult` (Task 2); `InvalidInputError` from `@agentgem/model`.
- Produces: `runLearnCommand(args: string[], deps?: { learn?: typeof learnFromSession; out?: (l: string) => void; err?: (l: string) => void }): Promise<number>` — exit 0 on success (including nothing-distilled), 2 on usage/containment errors.

- [ ] **Step 1: Write the failing test**

Create `src/__tests__/learnCli.test.ts`:

```ts
// src/__tests__/learnCli.test.ts
import { describe, it, expect } from "vitest";
import { runLearnCommand } from "../learnCli.js";
import { InvalidInputError } from "@agentgem/model";
import type { LearnResult } from "../learnCore.js";

const result = (over: Partial<LearnResult> = {}): LearnResult =>
  ({ session: "s1.jsonl", enqueued: 2, skills: 2, lessons: 0, degraded: false, ...over });

describe("agentgem learn", () => {
  it("prints a summary and exits 0 on success", async () => {
    const lines: string[] = [];
    const code = await runLearnCommand(["/proj"], { learn: async () => result(), out: (l) => lines.push(l) });
    expect(code).toBe(0);
    expect(lines.some((l) => l.includes("s1.jsonl"))).toBe(true);
    expect(lines.some((l) => l.includes("2 queued"))).toBe(true);
  });

  it("nothing distilled exits 0 with an honest message", async () => {
    const lines: string[] = [];
    const code = await runLearnCommand(["/proj"], { learn: async () => result({ enqueued: 0, skills: 0 }), out: (l) => lines.push(l) });
    expect(code).toBe(0);
    expect(lines.some((l) => /nothing (new )?distilled/i.test(l))).toBe(true);
  });

  it("passes --session and --dir through, defaults root to cwd", async () => {
    let got: { root?: string; session?: string; dir?: string } = {};
    await runLearnCommand(["--session", "abc", "--dir", "/ch"], {
      learn: async (o) => { got = o; return result(); }, out: () => {},
    });
    expect(got.session).toBe("abc");
    expect(got.dir).toBe("/ch");
    expect(got.root).toBe(process.cwd());
  });

  it("maps InvalidInputError to exit 2 with the message", async () => {
    const errs: string[] = [];
    const code = await runLearnCommand(["/proj", "--session", "nope"], {
      learn: async () => { throw new InvalidInputError("no session 'nope'"); }, err: (l) => errs.push(l),
    });
    expect(code).toBe(2);
    expect(errs.some((l) => l.includes("no session"))).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm exec tsc -b && pnpm exec vitest run dist/__tests__/learnCli.test.js`
Expected: FAIL at compile — `../learnCli.js` does not exist.

- [ ] **Step 3: Implement**

Create `src/learnCli.ts`:

```ts
// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
// src/learnCli.ts — `agentgem learn [root] [--session <id>] [--dir <claude-home>]`:
// distill one session into the dream review queue from the terminal, no server needed.
// Exit codes: 0 success (including "nothing distilled"); 2 usage/containment errors.
import { InvalidInputError } from "@agentgem/model";
import { learnFromSession } from "./learnCore.js";

interface LearnCliDeps {
  learn?: typeof learnFromSession;
  out?: (line: string) => void;
  err?: (line: string) => void;
}

export async function runLearnCommand(args: string[], deps: LearnCliDeps = {}): Promise<number> {
  const out = deps.out ?? ((l) => console.log(l));
  const err = deps.err ?? ((l) => console.error(l));
  const learn = deps.learn ?? learnFromSession;

  const flagValue = (name: string): string | undefined =>
    args.includes(name) ? args[args.indexOf(name) + 1] : undefined;
  for (const name of ["--session", "--dir"]) {
    const v = flagValue(name);
    if (args.includes(name) && (v === undefined || v.startsWith("--"))) {
      err(`${name} requires a value`);
      return 2;
    }
  }
  const positional = args.filter((a, i) => !a.startsWith("--") && args[i - 1] !== "--session" && args[i - 1] !== "--dir");
  const root = positional[0] ?? process.cwd();

  try {
    const r = await learn({ root, session: flagValue("--session"), dir: flagValue("--dir") });
    if (r.enqueued === 0 && r.skills === 0 && r.lessons === 0) {
      out(`nothing distilled from ${r.session}${r.degraded ? " (heuristic-only: LLM path unavailable)" : ""}`);
      return 0;
    }
    out(`${r.session}: ${r.skills} skill candidate(s), ${r.lessons} lesson(s) — ${r.enqueued} queued for review` +
        (r.enqueued < r.skills + r.lessons ? " (rest already queued or reviewed)" : ""));
    out(`review in the Dreaming panel or GET /api/dream/queue`);
    return 0;
  } catch (e) {
    if (e instanceof InvalidInputError) { err(e.message); return 2; }
    err((e as Error).message);
    return 2;
  }
}
```

Wire into `src/cli.ts` after the `verify` block:

```ts
  // `agentgem learn [root]` — distill one session into the dream review queue now.
  if (argv[0] === "learn") {
    const { runLearnCommand } = await import("./learnCli.js");
    process.exitCode = await runLearnCommand(argv.slice(1));
    return;
  }
```

And add to the HELP command list (after the verify line, matching its style):

```
  agentgem learn [root]                 Distill the latest session into the review queue (--session <id>; --dir <claude-home>)
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm exec tsc -b && pnpm exec vitest run dist/__tests__/learnCli.test.js`
Expected: PASS (4 tests). Note: the first test expects a line containing "2 queued" — the summary line satisfies it.

- [ ] **Step 5: Commit**

```bash
git add src/learnCli.ts src/cli.ts src/__tests__/learnCli.test.ts
git commit -m "feat(cli): agentgem learn — distill a session into the review queue from the terminal"
```

---

### Task 5: Full verification

**Files:** none (verification only)

- [ ] **Step 1: Build + full root suite**

Run: `pnpm build && pnpm test`
Expected: all green. Known flakes: observeScan/scorecard/observe.controller real-FS tests can time out under full-suite concurrency (and under CPU contention from concurrent sessions) — re-run failures in isolation before blaming the change.

- [ ] **Step 2: Console tests + typecheck (not in CI)**

Run: `pnpm --dir packages/console test && pnpm --dir packages/console exec tsc --noEmit`
Expected: all green — no console changes in this slice (the Dreaming queue item type doesn't enumerate `phase`).

- [ ] **Step 3: CLI smoke**

Run: `node dist/cli.js learn --session`
Expected: `--session requires a value`, exit code 2 — proves dispatch wiring without a real distill.

- [ ] **Step 4: Branch state**

```bash
git status --short   # expect empty (never commit .superpowers/)
git log --oneline origin/main..HEAD   # spec + 4 code commits
```
