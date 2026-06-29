# Goldmine Scorecard Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a "goldmine scorecard" — an asset-framed, count-only assessment of the reusable workflows in a user's local agent session logs — as the hero of the Observe panel, with a distill CTA, on-demand LLM enrich, and a local opt-in canvas trophy.

**Architecture:** A new deterministic aggregator (`src/gem/scorecard.ts`) runs the *existing* analyze pipeline (`discoverProjects` → `scanWorkflow` → `extractCandidates`) across all local projects and rolls the per-project candidates up into a `Scorecard`. A new `GET /api/scorecard` route serves it; a new React hero in the Observe panel renders it and reuses the shipped Curate>Analyze distill flow and `/api/workflow/analyze/stream` enrich. A dependency-free `<canvas>` trophy exports aggregate counts only.

**Tech Stack:** TypeScript (Node ESM), Zod, the in-repo `@agentback/client` route layer, Vitest (runs compiled tests from `dist/`), React (packages/console).

## Global Constraints

- **Count-only, no `$`** — never render a dollar/latent-value figure in v1.
- **Score the asset, not the person** — no skill/IQ grade; no comparative/percentile/leaderboard.
- **No new transcript parsing** — reuse `scanWorkflow` / `extractCandidates` verbatim.
- **Deterministic core** — `/api/scorecard` makes **no** LLM or network calls; LLM enrich is the existing `/api/workflow/analyze/stream` only, on drill-in.
- **Trophy is aggregate-only & local** — exported artifact carries aggregate counts + tagline + date + AgentGem wordmark; **never** project names, repo paths, workflow names, or raw transcript content. No upload, no backend, no account.
- **Trophy is dependency-free** — render on `<canvas>`; do NOT add `html-to-image` or any package.
- **Tests run from `dist/`** — the test cycle is `npx tsc -b && npx vitest run <filter>`. Run `pnpm clean` first only after a file rename/move.
- **Hero copy (verbatim shape):** `"Your log holds N reusable workflows — M battle-tested, K worth sharing."`

---

### Task 1: Pure scorecard aggregator (types + scoring)

The deterministic heart. Pure functions over already-produced signals — no fs, no LLM.

**Files:**
- Create: `src/gem/scorecard.ts`
- Test: `src/gem/__tests__/scorecard.test.ts`

**Interfaces:**
- Consumes (from existing code):
  - `WorkflowSignal` from `./workflowScan.js` — fields used: `root`, `sessions.scanned`, `sessions.spanDays`.
  - `ProcedureCandidate` from `./distillTypes.js` — `extends GatedCandidate extends ProcedureGroup`, so fields: `key: string`, `verbs: string[]`, `sessions: number`, `priorConfidence: "high"|"medium"|"low"`, `skeleton: DistilledSkill` (with `skeleton.name: string`, `skeleton.tools: string[]`).
  - `Reflection` from `./distillTypes.js` — `{ kind, detail: string, importance: "high"|"medium", provenance }`.
- Produces (later tasks rely on these exact names/types):
  - `type ProjectLoad = { root: string; label: string; signal: WorkflowSignal; candidates: ProcedureCandidate[]; reflections: Reflection[] }`
  - `type ProjectGoldmine = { root: string; label: string; breadth: number; battleTested: number; portable: number; topCandidates: { name: string; confidence: "high"|"medium"|"low" }[] }`
  - `type Scorecard = { breadth: number; battleTested: number; portable: number; gaps: string[]; projects: ProjectGoldmine[]; generatedAtMs: number; degraded: boolean }`
  - `function isPortable(c: ProcedureCandidate): boolean`
  - `function scoreProject(load: ProjectLoad): ProjectGoldmine`
  - `function aggregateScorecard(loads: ProjectLoad[], nowMs: number, degraded: boolean): Scorecard`

- [ ] **Step 1: Write the failing test**

```ts
// src/gem/__tests__/scorecard.test.ts
import { describe, it, expect } from "vitest";
import { isPortable, scoreProject, aggregateScorecard, type ProjectLoad } from "../scorecard.js";
import type { ProcedureCandidate } from "../distillTypes.js";
import type { WorkflowSignal } from "../workflowScan.js";

// Minimal candidate factory — only the fields scorecard.ts reads.
function cand(over: Partial<ProcedureCandidate> & { key: string }): ProcedureCandidate {
  return {
    key: over.key,
    verbs: over.verbs ?? ["a", "b", "c"],
    sessions: over.sessions ?? 3,
    sampleSessionIdx: 0,
    sessionIdxs: [0],
    sample: { steps: [], sessionId: "s", transcript: "t.jsonl", atMs: 0 } as any,
    provenance: { occurrences: [] },
    priorConfidence: over.priorConfidence ?? "low",
    skeleton: { name: over.skeleton?.name ?? over.key, tools: over.skeleton?.tools ?? ["Bash"] } as any,
  } as ProcedureCandidate;
}

function sig(root: string): WorkflowSignal {
  return { root, flavor: "claude", sessions: { scanned: 5, firstMs: 0, lastMs: 0, spanDays: 7 },
    artifacts: [], models: [], unresolved: [], coOccurrence: [], shapes: [], notes: [] };
}

describe("isPortable", () => {
  it("is true for a high-confidence candidate using a Skill or mcp tool", () => {
    expect(isPortable(cand({ key: "k1", priorConfidence: "high", skeleton: { name: "k1", tools: ["Skill", "Bash"] } as any }))).toBe(true);
    expect(isPortable(cand({ key: "k2", priorConfidence: "high", skeleton: { name: "k2", tools: ["mcp__pw__click"] } as any }))).toBe(true);
  });
  it("is false when not battle-tested, or tools are repo-local only", () => {
    expect(isPortable(cand({ key: "k3", priorConfidence: "medium", skeleton: { name: "k3", tools: ["Skill"] } as any }))).toBe(false);
    expect(isPortable(cand({ key: "k4", priorConfidence: "high", skeleton: { name: "k4", tools: ["Edit", "Bash"] } as any }))).toBe(false);
  });
});

describe("scoreProject", () => {
  it("counts breadth, battle-tested, and portable for one project", () => {
    const load: ProjectLoad = {
      root: "/r/alpha", label: "alpha", signal: sig("/r/alpha"), reflections: [],
      candidates: [
        cand({ key: "k1", priorConfidence: "high", skeleton: { name: "k1", tools: ["Skill"] } as any }),
        cand({ key: "k2", priorConfidence: "high", skeleton: { name: "k2", tools: ["Edit"] } as any }),
        cand({ key: "k3", priorConfidence: "low", skeleton: { name: "k3", tools: ["Bash"] } as any }),
      ],
    };
    const p = scoreProject(load);
    expect(p).toMatchObject({ root: "/r/alpha", label: "alpha", breadth: 3, battleTested: 2, portable: 1 });
    expect(p.topCandidates[0]).toEqual({ name: "k1", confidence: "high" });
  });
});

describe("aggregateScorecard", () => {
  it("dedups breadth by candidate key across projects and sums tiers", () => {
    const shared = cand({ key: "shared", priorConfidence: "high", skeleton: { name: "shared", tools: ["Skill"] } as any });
    const a: ProjectLoad = { root: "/r/a", label: "a", signal: sig("/r/a"), reflections: [{ kind: "recurring-pattern", detail: "gap-A", importance: "high", provenance: { occurrences: [] } }],
      candidates: [shared, cand({ key: "x", priorConfidence: "low" })] };
    const b: ProjectLoad = { root: "/r/b", label: "b", signal: sig("/r/b"), reflections: [],
      candidates: [shared] };
    const sc = aggregateScorecard([a, b], 1234, false);
    expect(sc.breadth).toBe(2);            // {shared, x} — "shared" not double-counted
    expect(sc.battleTested).toBe(2);       // shared(high) in a + shared(high) in b
    expect(sc.portable).toBe(2);
    expect(sc.gaps).toContain("gap-A");
    expect(sc.projects).toHaveLength(2);
    expect(sc).toMatchObject({ generatedAtMs: 1234, degraded: false });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx tsc -b && npx vitest run scorecard`
Expected: FAIL — `Cannot find module '../scorecard.js'`.

- [ ] **Step 3: Write minimal implementation**

```ts
// src/gem/scorecard.ts
//
// Deterministic "goldmine scorecard": rolls the existing analyze pipeline's
// per-project candidates up into asset-framed counts. Pure — no fs, no LLM.
// breadth = distinct reusable workflows; battleTested = mature (priorConfidence
// "high"); portable = mature AND general enough to travel beyond its origin repo.
import { basename } from "node:path";
import type { WorkflowSignal } from "./workflowScan.js";
import type { ProcedureCandidate, Reflection } from "./distillTypes.js";

// A workflow "travels" when it leans on portable capability (a Skill or an MCP
// tool) rather than only repo-local edits (Bash/Edit/Write). This is the
// implementable form of the spec's `ArtifactUsage.root === null` portability
// proxy, computed from the candidate's own tool list.
const PORTABLE_TOOL_RE = /^(Skill|mcp__)/;
const MAX_GAPS = 5;
const TOP_CANDIDATES = 5;

export type ProjectLoad = {
  root: string;
  label: string;
  signal: WorkflowSignal;
  candidates: ProcedureCandidate[];
  reflections: Reflection[];
};

export type ProjectGoldmine = {
  root: string;
  label: string;
  breadth: number;
  battleTested: number;
  portable: number;
  topCandidates: { name: string; confidence: "high" | "medium" | "low" }[];
};

export type Scorecard = {
  breadth: number;
  battleTested: number;
  portable: number;
  gaps: string[];
  projects: ProjectGoldmine[];
  generatedAtMs: number;
  degraded: boolean;
};

export function isPortable(c: ProcedureCandidate): boolean {
  return c.priorConfidence === "high" && c.skeleton.tools.some((t) => PORTABLE_TOOL_RE.test(t));
}

export function scoreProject(load: ProjectLoad): ProjectGoldmine {
  const cs = load.candidates;
  return {
    root: load.root,
    label: load.label || basename(load.root),
    breadth: new Set(cs.map((c) => c.key)).size,
    battleTested: cs.filter((c) => c.priorConfidence === "high").length,
    portable: cs.filter(isPortable).length,
    topCandidates: cs.slice(0, TOP_CANDIDATES).map((c) => ({ name: c.skeleton.name, confidence: c.priorConfidence })),
  };
}

export function aggregateScorecard(loads: ProjectLoad[], nowMs: number, degraded: boolean): Scorecard {
  const projects = loads.map(scoreProject);
  const allKeys = new Set<string>();
  let battleTested = 0;
  let portable = 0;
  const gaps: string[] = [];
  for (const load of loads) {
    for (const c of load.candidates) {
      allKeys.add(c.key);
      if (c.priorConfidence === "high") battleTested++;
      if (isPortable(c)) portable++;
    }
    for (const r of load.reflections) if (r.importance === "high" && !gaps.includes(r.detail)) gaps.push(r.detail);
  }
  return {
    breadth: allKeys.size,
    battleTested,
    portable,
    gaps: gaps.slice(0, MAX_GAPS),
    projects,
    generatedAtMs: nowMs,
    degraded,
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx tsc -b && npx vitest run scorecard`
Expected: PASS (all `scorecard.test.ts` cases green).

- [ ] **Step 5: Commit**

```bash
git add src/gem/scorecard.ts src/gem/__tests__/scorecard.test.ts
git commit -m "feat(scorecard): pure goldmine aggregator (breadth/battle-tested/portable)"
```

---

### Task 2: Project-signal loader / orchestrator

Wire the existing pipeline into `ProjectLoad[]`. fs/pipeline calls are injected so the orchestration is unit-testable without a real `~/.claude` store.

**Files:**
- Modify: `src/gem/scorecard.ts` (append the orchestrator)
- Test: `src/gem/__tests__/scorecard.test.ts` (append a composition test)

**Interfaces:**
- Consumes:
  - `discoverProjects(dirs)` from `./testbedFlavors.js` → `ProjectCandidate[]` where `ProjectCandidate = { path: string; flavor; lastUsed; exists: boolean }`.
  - `resolveDirs(dir?)`, `resolveProject(root)` from `../resolveDir.js`.
  - `introspectProject(root)`, `introspectConfig(opts)` from `./introspect.js`.
  - `claudeTranscriptsForCwd(claudeDir, root)`, `scanWorkflow(paths, scanInv, opts)` from `./workflowScan.js`.
  - `extractCandidates(signal, scanInv, opts)` from `./extract.js` → `{ candidates: ProcedureCandidate[]; reflections: Reflection[] }`.
- Produces:
  - `interface ScorecardDeps { discover(dir?: string): { path: string }[]; loadProject(root: string, dir?: string): { signal: WorkflowSignal; candidates: ProcedureCandidate[]; reflections: Reflection[] } | null }`
  - `function collectScorecard(dir: string | undefined, projects: string[] | undefined, nowMs: number, deps?: ScorecardDeps): Scorecard`

- [ ] **Step 1: Write the failing test (append to scorecard.test.ts)**

```ts
import { collectScorecard, type ScorecardDeps } from "../scorecard.js";

describe("collectScorecard", () => {
  it("composes discover + per-project load into a Scorecard via injected deps", () => {
    const deps: ScorecardDeps = {
      discover: () => [{ path: "/r/a" }, { path: "/r/b" }],
      loadProject: (root) => ({
        signal: sig(root),
        reflections: [],
        candidates: [cand({ key: `${root}-k`, priorConfidence: "high", skeleton: { name: "k", tools: ["Skill"] } as any })],
      }),
    };
    const sc = collectScorecard(undefined, undefined, 99, deps);
    expect(sc.projects.map((p) => p.root)).toEqual(["/r/a", "/r/b"]);
    expect(sc.breadth).toBe(2);
    expect(sc.battleTested).toBe(2);
    expect(sc.portable).toBe(2);
    expect(sc.degraded).toBe(false);
  });

  it("restricts to the given projects and marks degraded when a load fails", () => {
    const deps: ScorecardDeps = {
      discover: () => [{ path: "/r/a" }, { path: "/r/b" }],
      loadProject: (root) => (root === "/r/a" ? { signal: sig(root), reflections: [], candidates: [] } : null),
    };
    const sc = collectScorecard(undefined, ["/r/a"], 1, deps);
    expect(sc.projects.map((p) => p.root)).toEqual(["/r/a"]);
    expect(sc.degraded).toBe(false);
    const sc2 = collectScorecard(undefined, undefined, 1, deps);
    expect(sc2.degraded).toBe(true);   // /r/b load returned null
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx tsc -b && npx vitest run scorecard`
Expected: FAIL — `collectScorecard` / `ScorecardDeps` not exported.

- [ ] **Step 3: Write minimal implementation (append to scorecard.ts)**

```ts
import { discoverProjects } from "./testbedFlavors.js";
import { resolveDirs, resolveProject } from "../resolveDir.js";
import { introspectProject, introspectConfig } from "./introspect.js";
import { claudeTranscriptsForCwd, scanWorkflow } from "./workflowScan.js";
import { extractCandidates } from "./extract.js";

export interface ScorecardDeps {
  discover(dir?: string): { path: string }[];
  loadProject(root: string, dir?: string): { signal: WorkflowSignal; candidates: ProcedureCandidate[]; reflections: Reflection[] } | null;
}

// Default deps run the real, shipped analyze pipeline — the same wiring as
// src/workflowStream.ts, minus the LLM (deterministic only).
export const defaultScorecardDeps: ScorecardDeps = {
  discover: (dir) => discoverProjects(resolveDirs(dir)),
  loadProject: (root, dir) => {
    try {
      const dirs = resolveDirs(dir);
      const project = introspectProject(resolveProject(root));
      const globalInv = introspectConfig(dirs);
      const scanInv = { project, global: { skills: globalInv.skills, mcpServers: globalInv.mcpServers, hooks: globalInv.hooks } };
      const paths = claudeTranscriptsForCwd(dirs.claudeDir, root);
      const signal = scanWorkflow(paths, scanInv, { retainSequences: true });
      const { candidates, reflections } = extractCandidates(signal, scanInv);
      return { signal, candidates, reflections };
    } catch {
      return null;
    }
  },
};

export function collectScorecard(
  dir: string | undefined,
  projects: string[] | undefined,
  nowMs: number,
  deps: ScorecardDeps = defaultScorecardDeps,
): Scorecard {
  const roots = projects?.length ? projects : deps.discover(dir).map((p) => p.path);
  const loads: ProjectLoad[] = [];
  let degraded = false;
  for (const root of roots) {
    const loaded = deps.loadProject(root, dir);
    if (!loaded) { degraded = true; continue; }
    loads.push({ root, label: basename(root), ...loaded });
  }
  return aggregateScorecard(loads, nowMs, degraded);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx tsc -b && npx vitest run scorecard`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/gem/scorecard.ts src/gem/__tests__/scorecard.test.ts
git commit -m "feat(scorecard): collectScorecard orchestrator over the analyze pipeline"
```

---

### Task 3: Server route `GET /api/scorecard`

**Files:**
- Modify: `src/gem.controller.ts` (add schema + route handler)
- Test: `src/gem/__tests__/scorecardRoute.test.ts`

**Interfaces:**
- Consumes: `collectScorecard` (Task 2); `DirQuerySchema` (already imported in controller, carries `{ dir?, projects? }`); `parseProjectsQuery(s)` (already defined at `gem.controller.ts:618`).
- Produces: `GET /api/scorecard` returning the `Scorecard` JSON shape.

- [ ] **Step 1: Write the failing test**

```ts
// src/gem/__tests__/scorecardRoute.test.ts
import { describe, it, expect } from "vitest";
import { GemController } from "../../gem.controller.js";

describe("GET /api/scorecard handler", () => {
  it("returns a count-only scorecard shape for the given projects", async () => {
    const ctrl = new GemController();
    const res = await ctrl.scorecard({ query: { projects: JSON.stringify([process.cwd()]) } as any });
    expect(res).toHaveProperty("breadth");
    expect(res).toHaveProperty("battleTested");
    expect(res).toHaveProperty("portable");
    expect(Array.isArray(res.projects)).toBe(true);
    expect(typeof res.generatedAtMs).toBe("number");
    // Count-only guarantee: no dollar/value field leaks into the payload.
    expect(JSON.stringify(res)).not.toMatch(/\$|latentValue|dollars/);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx tsc -b && npx vitest run scorecardRoute`
Expected: FAIL — `ctrl.scorecard is not a function`.

- [ ] **Step 3: Write minimal implementation**

Add the import near the other `./gem/*` imports at the top of `src/gem.controller.ts`:

```ts
import { collectScorecard, type Scorecard } from "./gem/scorecard.js";
```

Add the response schema next to `ObservePayloadSchema` (around `src/gem.controller.ts:15`):

```ts
const ScorecardSchema = z.object({
  breadth: z.number(),
  battleTested: z.number(),
  portable: z.number(),
  gaps: z.array(z.string()),
  projects: z.array(z.object({
    root: z.string(), label: z.string(),
    breadth: z.number(), battleTested: z.number(), portable: z.number(),
    topCandidates: z.array(z.object({ name: z.string(), confidence: z.enum(["high", "medium", "low"]) })),
  })),
  generatedAtMs: z.number(),
  degraded: z.boolean(),
}) satisfies z.ZodType<Scorecard>;
```

Add the route method inside `class GemController` (next to the `observe` method near line 171). `DirQuerySchema` already validates `{ dir?, projects? }`:

```ts
  @get("/scorecard", { query: DirQuerySchema, response: ScorecardSchema })
  async scorecard(input: { query: z.infer<typeof DirQuerySchema> }): Promise<z.infer<typeof ScorecardSchema>> {
    return collectScorecard(input.query.dir, parseProjectsQuery(input.query.projects), Date.now());
  }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx tsc -b && npx vitest run scorecardRoute`
Expected: PASS (real pipeline over `process.cwd()`; counts may be 0 but the shape holds).

- [ ] **Step 5: Commit**

```bash
git add src/gem.controller.ts src/gem/__tests__/scorecardRoute.test.ts
git commit -m "feat(scorecard): GET /api/scorecard route (deterministic, count-only)"
```

---

### Task 4: Console route definition `scorecardRoute`

**Files:**
- Modify: `packages/console/src/api/routes.ts` (add schema + route + types)

**Interfaces:**
- Consumes: `defineRoute` (already imported), `z` (already imported).
- Produces: `scorecardRoute` (GET `/api/scorecard`) and `type Scorecard` for the panel.

- [ ] **Step 1: Add the schema, route, and exported type**

Append near `observeRoute` (around `packages/console/src/api/routes.ts:346`):

```ts
export const ScorecardSchema = z.object({
  breadth: z.number(),
  battleTested: z.number(),
  portable: z.number(),
  gaps: z.array(z.string()),
  projects: z.array(z.object({
    root: z.string(), label: z.string(),
    breadth: z.number(), battleTested: z.number(), portable: z.number(),
    topCandidates: z.array(z.object({ name: z.string(), confidence: z.enum(["high", "medium", "low"]) })),
  })),
  generatedAtMs: z.number(),
  degraded: z.boolean(),
});
export type Scorecard = z.infer<typeof ScorecardSchema>;
export type ProjectGoldmine = Scorecard["projects"][number];

export const scorecardRoute = defineRoute("GET", "/api/scorecard", {
  query: z.object({ dir: z.string().optional(), projects: z.string().optional() }),
  response: ScorecardSchema,
});
```

- [ ] **Step 2: Typecheck the console package**

Run: `cd packages/console && npx tsc -p tsconfig.json --noEmit`
Expected: PASS (no type errors).

- [ ] **Step 3: Commit**

```bash
git add packages/console/src/api/routes.ts
git commit -m "feat(scorecard): console scorecardRoute + Scorecard type"
```

---

### Task 5: Canvas trophy (pure label mapping + draw + share)

**Files:**
- Create: `packages/console/src/panels/Observe/trophy.ts`
- Test: `packages/console/src/panels/Observe/__tests__/trophy.test.ts`

**Interfaces:**
- Consumes: `Scorecard` from `../../api/routes.js`.
- Produces:
  - `function trophyLines(sc: Scorecard): { title: string; counts: string[]; tagline: string }` — pure; the ONLY text drawn on the card. Aggregate counts only — never project/workflow names.
  - `function drawTrophy(canvas: HTMLCanvasElement, sc: Scorecard): void`
  - `async function shareTrophy(canvas: HTMLCanvasElement): Promise<void>` — `navigator.share` with download-PNG fallback.

- [ ] **Step 1: Write the failing test**

```ts
// packages/console/src/panels/Observe/__tests__/trophy.test.ts
import { describe, it, expect } from "vitest";
import { trophyLines } from "../trophy.js";
import type { Scorecard } from "../../../api/routes.js";

const sc: Scorecard = {
  breadth: 14, battleTested: 3, portable: 5, gaps: [], generatedAtMs: 0, degraded: false,
  projects: [{ root: "/secret/repo", label: "secret-repo", breadth: 14, battleTested: 3, portable: 5, topCandidates: [{ name: "deploy-flow", confidence: "high" }] }],
};

describe("trophyLines", () => {
  it("renders aggregate counts only", () => {
    const t = trophyLines(sc);
    expect(t.counts).toEqual(["14 reusable workflows", "3 battle-tested", "5 worth sharing"]);
    expect(t.title.toLowerCase()).toContain("goldmine");
  });
  it("never leaks project names, repo paths, or workflow names", () => {
    const blob = JSON.stringify(trophyLines(sc));
    expect(blob).not.toMatch(/secret|repo|deploy-flow/);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/console && npx vitest run trophy`
Expected: FAIL — `Cannot find module '../trophy.js'`.

- [ ] **Step 3: Write minimal implementation**

```ts
// packages/console/src/panels/Observe/trophy.ts
//
// Aggregate-only, local, opt-in trophy. trophyLines() is the single source of
// what text appears on the card — counts only, so project/workflow names can
// never leak into a shared image ("share the trophy, not the goldmine").
import type { Scorecard } from "../../api/routes.js";

const W = 1200, H = 630;   // OG-image proportions

export function trophyLines(sc: Scorecard): { title: string; counts: string[]; tagline: string } {
  return {
    title: "My Agent Goldmine",
    counts: [
      `${sc.breadth} reusable workflows`,
      `${sc.battleTested} battle-tested`,
      `${sc.portable} worth sharing`,
    ],
    tagline: "Valued with AgentGem",
  };
}

export function drawTrophy(canvas: HTMLCanvasElement, sc: Scorecard): void {
  canvas.width = W; canvas.height = H;
  const ctx = canvas.getContext("2d");
  if (!ctx) return;
  const { title, counts, tagline } = trophyLines(sc);
  ctx.fillStyle = "#0b0f17"; ctx.fillRect(0, 0, W, H);
  ctx.fillStyle = "#e8edf5"; ctx.textBaseline = "top";
  ctx.font = "600 48px system-ui, sans-serif"; ctx.fillText(title, 80, 80);
  ctx.font = "700 64px system-ui, sans-serif";
  counts.forEach((line, i) => { ctx.fillStyle = i === 0 ? "#7cc4ff" : "#e8edf5"; ctx.fillText(line, 80, 200 + i * 96); });
  ctx.fillStyle = "#6b7689"; ctx.font = "400 28px system-ui, sans-serif"; ctx.fillText(tagline, 80, H - 80);
  ctx.fillStyle = "#7cc4ff"; ctx.font = "700 28px system-ui, sans-serif"; ctx.fillText("AgentGem", W - 260, H - 80);
}

export async function shareTrophy(canvas: HTMLCanvasElement): Promise<void> {
  const blob: Blob | null = await new Promise((res) => canvas.toBlob((b) => res(b), "image/png"));
  if (!blob) return;
  const file = new File([blob], "agentgem-goldmine.png", { type: "image/png" });
  const nav = navigator as Navigator & { canShare?: (d: { files: File[] }) => boolean };
  if (nav.share && nav.canShare?.({ files: [file] })) {
    await nav.share({ files: [file], title: "My Agent Goldmine" });
    return;
  }
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url; a.download = "agentgem-goldmine.png"; a.click();
  URL.revokeObjectURL(url);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd packages/console && npx vitest run trophy`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/console/src/panels/Observe/trophy.ts packages/console/src/panels/Observe/__tests__/trophy.test.ts
git commit -m "feat(scorecard): dependency-free canvas trophy (aggregate-only, opt-in)"
```

---

### Task 6: Observe-panel scorecard hero

**Files:**
- Create: `packages/console/src/panels/Observe/Scorecard.tsx`
- Modify: `packages/console/src/panels/Observe/index.tsx` (mount the hero above the dashboard)
- Test: `packages/console/src/panels/Observe/__tests__/Scorecard.test.tsx`

**Interfaces:**
- Consumes: `scorecardRoute`, `makeClient`, `type Scorecard` from `../../api/routes.js`; `drawTrophy`, `shareTrophy` from `./trophy.js`.
- Produces: `ScorecardHero` React component.

- [ ] **Step 1: Write the failing test**

```tsx
// packages/console/src/panels/Observe/__tests__/Scorecard.test.tsx
import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { ScorecardHero } from "../Scorecard.js";
import type { Scorecard } from "../../../api/routes.js";

const sc: Scorecard = {
  breadth: 14, battleTested: 3, portable: 5, gaps: ["wire up CI"], generatedAtMs: 0, degraded: false,
  projects: [{ root: "/r/a", label: "alpha", breadth: 14, battleTested: 3, portable: 5, topCandidates: [] }],
};

describe("ScorecardHero", () => {
  it("renders the asset-framed counts", async () => {
    render(<ScorecardHero data={sc} onDistill={vi.fn()} />);
    expect(await screen.findByText(/14 reusable workflows/i)).toBeTruthy();
    expect(screen.getByText(/3 battle-tested/i)).toBeTruthy();
    expect(screen.getByText(/5 worth sharing/i)).toBeTruthy();
  });
  it("never renders a dollar figure", () => {
    const { container } = render(<ScorecardHero data={sc} onDistill={vi.fn()} />);
    expect(container.textContent).not.toMatch(/\$/);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/console && npx vitest run Scorecard`
Expected: FAIL — `Cannot find module '../Scorecard.js'`.

- [ ] **Step 3: Write minimal implementation**

```tsx
// packages/console/src/panels/Observe/Scorecard.tsx
import { useRef } from "react";
import type { Scorecard, ProjectGoldmine } from "../../api/routes.js";
import { drawTrophy, shareTrophy } from "./trophy.js";

// Asset-framed hero. Counts link into the existing Curate>Analyze distill flow
// via onDistill(root); the share button exports the aggregate-only trophy.
export function ScorecardHero({ data, onDistill }: { data: Scorecard; onDistill: (root: string) => void }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const top: ProjectGoldmine | undefined = data.projects[0];
  const onShare = () => { const c = canvasRef.current; if (!c) return; drawTrophy(c, data); void shareTrophy(c); };
  return (
    <section className="scorecard-hero" aria-label="Goldmine scorecard">
      <h2>Your log holds <strong>{data.breadth} reusable workflows</strong></h2>
      <ul className="scorecard-counts">
        <li>{data.breadth} reusable workflows</li>
        <li><button onClick={() => top && onDistill(top.root)}>{data.battleTested} battle-tested</button></li>
        <li><button onClick={() => top && onDistill(top.root)}>{data.portable} worth sharing</button></li>
      </ul>
      {data.gaps.length > 0 && <p className="scorecard-gaps">Next: {data.gaps.join(" · ")}</p>}
      <button className="scorecard-share" onClick={onShare}>Share your goldmine</button>
      <canvas ref={canvasRef} style={{ display: "none" }} />
      {data.degraded && <span className="scorecard-degraded" title="Some projects could not be fully scanned">partial</span>}
    </section>
  );
}
```

Mount it in `packages/console/src/panels/Observe/index.tsx`: fetch via `scorecardRoute.call(makeClient(apiBase), { query: {} })` alongside the existing `observeRoute` fetch, store in state, and render `<ScorecardHero data={scorecard} onDistill={(root) => navigate to Curate>Analyze for root} />` above the existing `<Dashboard>`. Use the panel's existing navigation mechanism (the same one Curate's Analyze uses) for `onDistill`; if no cross-panel navigation helper exists, set `window.location.hash = "#/curate"` as the v1 hop.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd packages/console && npx vitest run Scorecard`
Expected: PASS.

- [ ] **Step 5: Typecheck + commit**

Run: `cd packages/console && npx tsc -p tsconfig.json --noEmit`
Expected: PASS.

```bash
git add packages/console/src/panels/Observe/Scorecard.tsx packages/console/src/panels/Observe/index.tsx packages/console/src/panels/Observe/__tests__/Scorecard.test.tsx
git commit -m "feat(scorecard): Observe-panel goldmine hero with distill CTA + trophy share"
```

---

### Task 7: Full build + manual verification

**Files:** none (verification only)

- [ ] **Step 1: Full build & test**

Run: `pnpm build && pnpm test`
Expected: build succeeds; full suite green (including the new scorecard tests).

- [ ] **Step 2: Manual trophy/canvas check (untestable-by-pixels, verify by eye)**

Run the app (`node dist/index.js`), open the Observe panel, confirm:
- hero reads `"Your log holds N reusable workflows — M battle-tested, K worth sharing"` with real local counts;
- clicking `battle-tested` / `worth sharing` lands in the Curate>Analyze distill flow;
- "Share your goldmine" produces a PNG (share sheet or download) showing **only** aggregate counts + "AgentGem" — no project or workflow names.

- [ ] **Step 3: Commit any fixups**

```bash
git add -A && git commit -m "chore(scorecard): build + manual-verification fixups"
```

---

## Self-Review

**Spec coverage:**
- Deterministic aggregator over existing pipeline → Tasks 1–2. ✓
- `GET /api/scorecard`, count-only, no LLM → Task 3. ✓
- Observe-panel hero + distill CTA + on-demand enrich (reuses existing analyze stream via the Curate>Analyze hop) → Task 6. ✓
- breadth / battleTested / portable definitions (portable via `skeleton.tools` Skill|mcp proxy — the implementable form of the spec's `root === null`) → Task 1. ✓
- Gaps (deterministic v1 from reflections) → Task 1 (`aggregateScorecard`). ✓
- Canvas trophy, aggregate-only, local, opt-in, dependency-free, `navigator.share`+download → Task 5. ✓
- Privacy ("trophy not goldmine") enforced + tested → Task 5 leak test + Task 3 count-only test. ✓
- Tests run from `dist/` → every run step uses `tsc -b`/`pnpm build` first. ✓

**Placeholder scan:** no TBD/TODO; every code step shows full code. The one judgment call (cross-panel navigation for `onDistill`) has a concrete v1 fallback (`window.location.hash = "#/curate"`). ✓

**Type consistency:** `Scorecard` / `ProjectGoldmine` / `ProjectLoad` / `ScorecardDeps` / `collectScorecard` / `isPortable` / `scoreProject` / `aggregateScorecard` / `trophyLines` / `drawTrophy` / `shareTrophy` / `ScorecardHero` names match across all tasks. Server `ScorecardSchema` (Task 3) and console `ScorecardSchema` (Task 4) are structurally identical. ✓

**Known risk (flagged in spec):** if `skeleton.tools` does not in practice carry `Skill`/`mcp__` tokens (verb↔tool mismatch), `portable` collapses toward 0; the sanctioned fallback is `portable = battleTested` — change `isPortable` to `c.priorConfidence === "high"`. Task 7 manual check surfaces this.
