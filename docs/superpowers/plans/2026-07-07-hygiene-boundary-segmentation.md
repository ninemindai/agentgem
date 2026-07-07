# Context-Hygiene Boundary Segmentation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a deterministic per-session task-episode segmentation + best-cut-point to the #161 hygiene report, rendered as a marker + band shading on the shared bloat curve — no LLM, no new endpoint.

**Architecture:** One pure `boundarySegments(session)` (change-point over the `clusterOf(arg)` sequence, smoothed, aligned to `contextSeries`); an additive `boundary?` field on `buildHygieneReport`/`HygieneReport` (rides the existing `/inspect/session/hygiene`); two optional overlay props on the shared `BloatCurve` and an episode list in `HygieneReport.tsx`.

**Tech Stack:** TypeScript ESM (`.js` specifiers), React (console), Vitest (server: `tsc -b && vitest run` over `dist/**/__tests__/**/*.test.js`; console: its own jsdom vitest).

## Global Constraints

- **Depends on PR #153 + #161 (merged):** `clusterOf` (`packages/insight/src/taskCluster.ts`), `buildHygieneReport` + the `HygieneReport` type (`src/sessionHygieneCore.ts`), `HygieneReportSchema` (server `src/gem.controller.ts:77`, client `packages/console/src/api/routes.ts:497`), the shared `BloatCurve` (`packages/console/src/panels/_shared/BloatCurve.tsx`), and `SessionSequence.contextSeries` (`TurnUsage[]` = `{turn,msgIndex,ctxTokens,cacheCreation,outTokens}`) + `ProcedureStep` (`{tool,verb,arg,msgIndex}`).
- **No LLM, no ACP, no new endpoint, no network** — `boundarySegments` is pure; it rides the existing hygiene report. This is the deterministic-first mandate.
- **Copyright header** on new files: `// Copyright (c) 2026 NineMind, Inc.` / `// SPDX-License-Identifier: MIT` / `// <repo-relative path>`.
- **ESM import specifiers end in `.js`**.
- **Additive:** `boundary?` is optional; attached only when the session has ≥2 episodes. Sessions without it, and every existing report consumer, are unaffected.
- **Privacy:** `label` is a low-cardinality cluster id (`pkg:x`/`dir:x`) from `clusterOf` — never a raw `arg`/path. The report carries turn indices + labels.
- **Constants** `SMOOTH_W`, `MIN_EPISODE` exported and tunable in one place.
- **`grep -a`** when searching `packages/insight/src/workflowScan.ts` (binary-classified).
- **Server tests** in `src/gem/__tests__/` (IN CI). **Console tests** are NOT in root CI — run via the console's own vitest.
- **Work in the worktree** `/Users/rfeng/Projects/ninemind/agentgem-boundary-judge` (branch `feat/hygiene-boundary-judge`), NOT the main checkout.
- **Commit identity** Raymond Feng <raymond@ninemind.ai>, with the `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>` trailer.

---

## File Structure

- **Create** `packages/insight/src/boundarySegments.ts` — the pure segmenter + types + constants. (Task 1)
- **Modify** `packages/insight/src/index.ts` — export the module. (Task 1)
- **Modify** `src/sessionHygieneCore.ts` — add `boundary?` to `HygieneReport`; compute + attach it (gated ≥2 episodes) in `buildHygieneReport`. (Task 2)
- **Modify** `src/gem.controller.ts` — add optional `boundary` to `HygieneReportSchema`. (Task 2)
- **Modify** `packages/console/src/api/routes.ts` — mirror `boundary?` on the client schema/type. (Task 3)
- **Modify** `packages/console/src/panels/_shared/BloatCurve.tsx` — optional `cutTurn` + `segments` props. (Task 3)
- **Modify** `packages/console/src/panels/Observe/HygieneReport.tsx` — render the overlay + episode list. (Task 3)
- **Create** `src/gem/__tests__/boundarySegments.test.ts` — server tests (CI). (Tasks 1, 2)
- **Modify** `packages/console/src/panels/Observe/HygieneReport.test.tsx` — boundary render (local). (Task 3)

**Run commands** (from the worktree root `/Users/rfeng/Projects/ninemind/agentgem-boundary-judge`):
- Server single test: `tsc -b && npx vitest run dist/gem/__tests__/boundarySegments.test.js`
- Full server suite: `npm test`
- Console (local): `cd packages/console && npx vitest run src/panels/Observe/HygieneReport.test.tsx` ; typecheck `cd packages/console && npx tsc -b`

---

## Task 1: `boundarySegments` — the pure segmenter

**Files:**
- Create: `packages/insight/src/boundarySegments.ts`
- Modify: `packages/insight/src/index.ts` (add `export * from "./boundarySegments.js";`)
- Test: `src/gem/__tests__/boundarySegments.test.ts`

**Interfaces:**
- Consumes: `SessionSequence` (`{steps: ProcedureStep[], contextSeries?: TurnUsage[], ...}`) from `./workflowScan.js`; `clusterOf` from `./taskCluster.js`.
- Produces:
  - `export interface BoundarySegment { fromTurn: number; toTurn: number; label: string }`
  - `export interface SessionBoundary { segments: BoundarySegment[]; cutTurn: number | null }`
  - `export function boundarySegments(session: SessionSequence): SessionBoundary`
  - `export const SMOOTH_W = 2`, `export const MIN_EPISODE = 3`

- [ ] **Step 1: Write the failing test**

Create `src/gem/__tests__/boundarySegments.test.ts`:

```ts
// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
// src/gem/__tests__/boundarySegments.test.ts
import { describe, it, expect } from "vitest";
import { boundarySegments, SMOOTH_W, MIN_EPISODE } from "@agentgem/insight";
import type { ProcedureStep, SessionSequence, TurnUsage } from "@agentgem/insight";

// Build a session where turn i has one Read step of `clusters[i]` (a path), and a
// contextSeries with ctxTokens = ctx[i]. msgIndex = i for both step and turn, so
// each step aligns to its own turn.
function sess(clusters: (string | null)[], ctx: number[]): SessionSequence {
  const steps: ProcedureStep[] = [];
  clusters.forEach((c, i) => { if (c) steps.push({ tool: "Read", verb: "Read", arg: c, msgIndex: i }); });
  const contextSeries: TurnUsage[] = clusters.map((_, i) => ({ turn: i, msgIndex: i, ctxTokens: ctx[i], cacheCreation: 0, outTokens: 1 }));
  return { steps, sessionId: "s", transcript: "s.jsonl", atMs: 0, contextSeries };
}
const path = (pkg: string) => `packages/${pkg}/f.ts`;   // clusterOf -> pkg:<pkg>

describe("boundarySegments", () => {
  it("splits a two-area session into two episodes with a cut at the transition", () => {
    const clusters = [...Array(6).fill(path("a")), ...Array(6).fill(path("b"))];
    const ctx = [...Array(6).fill(200_000), ...Array(6).fill(900_000)];   // climb at the b boundary
    const { segments, cutTurn } = boundarySegments(sess(clusters, ctx));
    expect(segments.map((s) => s.label)).toEqual(["pkg:a", "pkg:b"]);
    expect(segments[0]).toMatchObject({ fromTurn: 0, toTurn: 5 });
    expect(segments[1]).toMatchObject({ fromTurn: 6, toTurn: 11 });
    expect(cutTurn).toBe(6);
  });

  it("returns one episode and no cut for a single-area session", () => {
    const { segments, cutTurn } = boundarySegments(sess(Array(8).fill(path("a")), Array(8).fill(300_000)));
    expect(segments).toHaveLength(1);
    expect(segments[0].label).toBe("pkg:a");
    expect(cutTurn).toBeNull();
  });

  it("smooths a single ping-pong blip away (still one episode)", () => {
    const clusters = [path("a"), path("a"), path("a"), path("b"), path("a"), path("a"), path("a"), path("a")]; // one stray b
    const { segments } = boundarySegments(sess(clusters, Array(8).fill(300_000)));
    expect(segments).toHaveLength(1);
    expect(segments[0].label).toBe("pkg:a");
  });

  it("carries the file cluster forward across pathless Bash turns", () => {
    // Read a, then pathless Bash (npm test) turns, then Read a again -> ONE pkg:a episode.
    const steps: ProcedureStep[] = [
      { tool: "Read", verb: "Read", arg: path("a"), msgIndex: 0 },
      { tool: "Bash", verb: "Bash:npm", arg: "npm test", msgIndex: 1 },   // clusterOf("npm test") -> null
      { tool: "Bash", verb: "Bash:npm", arg: "npm test", msgIndex: 2 },
      { tool: "Read", verb: "Read", arg: path("a"), msgIndex: 3 },
    ];
    const contextSeries: TurnUsage[] = [0, 1, 2, 3].map((i) => ({ turn: i, msgIndex: i, ctxTokens: 300_000, cacheCreation: 0, outTokens: 1 }));
    const { segments } = boundarySegments({ steps, sessionId: "s", transcript: "s.jsonl", atMs: 0, contextSeries });
    expect(segments).toHaveLength(1);
    expect(segments[0].label).toBe("pkg:a");
  });

  it("picks the cut at the boundary with the larger context climb when two compete", () => {
    // a(0-4) -> b(5-9) small climb -> c(10-14) big climb. Cut should be turn 10.
    const clusters = [...Array(5).fill(path("a")), ...Array(5).fill(path("b")), ...Array(5).fill(path("c"))];
    const ctx = [...Array(5).fill(200_000), ...Array(5).fill(300_000), ...Array(5).fill(950_000)];
    const { cutTurn } = boundarySegments(sess(clusters, ctx));
    expect(cutTurn).toBe(10);
  });

  it("degrades to empty with no contextSeries, no throw", () => {
    const s: SessionSequence = { steps: [{ tool: "Read", verb: "Read", arg: path("a"), msgIndex: 0 }], sessionId: "s", transcript: "s.jsonl", atMs: 0 };
    expect(boundarySegments(s)).toEqual({ segments: [], cutTurn: null });
  });

  it("exports the tunable constants", () => {
    expect(SMOOTH_W).toBe(2);
    expect(MIN_EPISODE).toBe(3);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `tsc -b && npx vitest run dist/gem/__tests__/boundarySegments.test.js`
Expected: FAIL — `boundarySegments` not exported.

- [ ] **Step 3: Write minimal implementation**

Create `packages/insight/src/boundarySegments.ts`:

```ts
// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
// packages/insight/src/boundarySegments.ts
//
// Deterministic task-episode segmentation of one session: a change-point pass over
// the clusterOf(arg) sequence, smoothed, aligned to the bloat curve. Yields the task
// episodes (turn ranges -> cluster label) and the single best cut turn (the episode
// boundary with the largest context climb across it). Pure: no fs, no LLM, no I/O.
// The primary cluster source is file-path steps; pathless Bash carries forward (see
// the boundary-judge spec). Constants are exported and tunable in one place.
import type { SessionSequence } from "./workflowScan.js";
import { clusterOf } from "./taskCluster.js";

export interface BoundarySegment { fromTurn: number; toTurn: number; label: string }
export interface SessionBoundary { segments: BoundarySegment[]; cutTurn: number | null }

export const SMOOTH_W = 2;      // ±window (turns) for dominant-cluster smoothing of ping-pong blips
export const MIN_EPISODE = 3;   // episodes shorter than this (turns) are merged into a neighbor

export function boundarySegments(session: SessionSequence): SessionBoundary {
  const series = session.contextSeries ?? [];
  const N = series.length;
  if (N === 0) return { segments: [], cutTurn: null };

  // 1. turn -> cluster. series is ascending by msgIndex (turn order); a step aligns to
  //    the last series turn whose msgIndex <= step.msgIndex. Last non-null wins per turn.
  const turnCluster: (string | null)[] = new Array(N).fill(null);
  const steps = [...session.steps].sort((a, b) => a.msgIndex - b.msgIndex);
  let si = 0;
  for (const st of steps) {
    while (si + 1 < N && series[si + 1].msgIndex <= st.msgIndex) si++;
    const c = clusterOf(st.arg);
    if (c) turnCluster[si] = c;
  }
  // carry forward, then back-fill leading nulls with the first known cluster
  let last: string | null = null;
  for (let i = 0; i < N; i++) { if (turnCluster[i] == null) turnCluster[i] = last; else last = turnCluster[i]; }
  const firstKnown = turnCluster.find((c) => c != null) ?? null;
  for (let i = 0; i < N && turnCluster[i] == null; i++) turnCluster[i] = firstKnown;

  // 2. smooth: dominant (mode) cluster in ±SMOOTH_W, collapsing single-turn detours
  const smoothed: (string | null)[] = turnCluster.map((cur, i) => {
    const counts = new Map<string, number>();
    for (let j = Math.max(0, i - SMOOTH_W); j <= Math.min(N - 1, i + SMOOTH_W); j++) {
      const c = turnCluster[j]; if (c) counts.set(c, (counts.get(c) ?? 0) + 1);
    }
    let best = cur, bestN = 0;
    for (const [c, n] of counts) if (n > bestN) { best = c; bestN = n; }
    return best;
  });

  // 3. run-length encode into episodes
  const rle: BoundarySegment[] = [];
  for (let i = 0; i < N; i++) {
    const label = smoothed[i] ?? "";
    const prev = rle[rle.length - 1];
    if (prev && prev.label === label) prev.toTurn = i;
    else rle.push({ fromTurn: i, toTurn: i, label });
  }
  // 3b. merge sub-MIN_EPISODE episodes into the previous (or, if first, hand turns to next)
  const out: BoundarySegment[] = [];
  for (let k = 0; k < rle.length; k++) {
    const ep = rle[k];
    if (ep.toTurn - ep.fromTurn + 1 >= MIN_EPISODE) { out.push({ ...ep }); continue; }
    if (out.length) out[out.length - 1].toTurn = ep.toTurn;
    else if (k + 1 < rle.length) rle[k + 1].fromTurn = ep.fromTurn;
    else out.push({ ...ep });
  }
  // 3c. coalesce any now-adjacent same-label episodes
  const segments: BoundarySegment[] = [];
  for (const ep of out) {
    const prev = segments[segments.length - 1];
    if (prev && prev.label === ep.label) prev.toTurn = ep.toTurn;
    else segments.push({ ...ep });
  }

  // 4. cut = boundary with the largest context climb across it (post mean - pre mean)
  if (segments.length <= 1) return { segments, cutTurn: null };
  const mean = (from: number, to: number) => {
    let s = 0; for (let i = from; i <= to; i++) s += series[i].ctxTokens; return s / (to - from + 1);
  };
  let cutTurn = segments[1].fromTurn, best = -Infinity;
  for (let k = 1; k < segments.length; k++) {
    const climb = mean(segments[k].fromTurn, segments[k].toTurn) - mean(segments[k - 1].fromTurn, segments[k - 1].toTurn);
    if (climb > best) { best = climb; cutTurn = segments[k].fromTurn; }
  }
  return { segments, cutTurn };
}
```

Add to `packages/insight/src/index.ts`:
```ts
export * from "./boundarySegments.js";
```

- [ ] **Step 4: Run test to verify it passes**

Run: `tsc -b && npx vitest run dist/gem/__tests__/boundarySegments.test.js`
Expected: PASS (7 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/insight/src/boundarySegments.ts packages/insight/src/index.ts src/gem/__tests__/boundarySegments.test.ts
git -c user.name="Raymond Feng" -c user.email="raymond@ninemind.ai" commit -m "feat(insight): deterministic boundarySegments — task episodes + best cut turn

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 2: Attach `boundary?` to the hygiene report

**Files:**
- Modify: `src/sessionHygieneCore.ts` (the `HygieneReport` interface ~line 32; `buildHygieneReport` ~line 39)
- Modify: `src/gem.controller.ts` (the `HygieneReportSchema` ~line 77)
- Test: `src/gem/__tests__/boundarySegments.test.ts` (append)

**Interfaces:**
- Consumes: `boundarySegments` + `SessionBoundary` (Task 1); the existing `buildHygieneReport`.
- Produces: `HygieneReport` gains `boundary?: SessionBoundary`, present ONLY when `boundarySegments(session).segments.length >= 2`; `HygieneReportSchema` gains an optional matching `boundary`.

- [ ] **Step 1: Write the failing test** (append)

```ts
import { scanWorkflow, buildHygieneReport } from "@agentgem/insight";
import { mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { HygieneReportSchema } from "../../gem.controller.js";

const emptyInv = { project: { root: "/r", skills: [], mcpServers: [], hooks: [], instructions: [] }, global: { skills: [], mcpServers: [], hooks: [] } } as any;

function writeTwoArea(dir: string): string {
  const lines: string[] = [JSON.stringify({ sessionId: "b", type: "user", message: { role: "user", content: "go" } })];
  const push = (pkg: string, ctx: number) => lines.push(JSON.stringify({
    type: "assistant",
    message: { role: "assistant", model: "claude-opus-4-8[1m]",
      content: [{ type: "tool_use", name: "Read", input: { file_path: `packages/${pkg}/f.ts` } }],
      usage: { input_tokens: 100, cache_read_input_tokens: ctx, cache_creation_input_tokens: 2000, output_tokens: 10 } },
  }));
  for (let i = 0; i < 6; i++) push("a", 200_000);
  for (let i = 0; i < 6; i++) push("b", 950_000);
  const p = join(dir, "b.jsonl"); writeFileSync(p, lines.join("\n")); return p;
}
function writeOneArea(dir: string): string {
  const lines: string[] = [JSON.stringify({ sessionId: "o", type: "user", message: { role: "user", content: "go" } })];
  for (let i = 0; i < 5; i++) lines.push(JSON.stringify({ type: "assistant", message: { role: "assistant", model: "claude-opus-4-8[1m]",
    content: [{ type: "tool_use", name: "Read", input: { file_path: "packages/a/f.ts" } }],
    usage: { input_tokens: 100, cache_read_input_tokens: 300_000, cache_creation_input_tokens: 2000, output_tokens: 10 } } }));
  const p = join(dir, "o.jsonl"); writeFileSync(p, lines.join("\n")); return p;
}

describe("buildHygieneReport boundary", () => {
  it("attaches boundary with ≥2 episodes + a cut turn for a two-area session", () => {
    const dir = mkdtempSync(join(tmpdir(), "bnd-"));
    const rep = buildHygieneReport(scanWorkflow([writeTwoArea(dir)], emptyInv, { retainSequences: true }));
    expect(rep.boundary).toBeDefined();
    expect(rep.boundary!.segments.length).toBeGreaterThanOrEqual(2);
    expect(rep.boundary!.cutTurn).not.toBeNull();
    expect(HygieneReportSchema.parse(rep)).toEqual(rep);   // schema mirrors the shape
  });
  it("omits boundary for a single-area session", () => {
    const dir = mkdtempSync(join(tmpdir(), "bnd2-"));
    const rep = buildHygieneReport(scanWorkflow([writeOneArea(dir)], emptyInv, { retainSequences: true }));
    expect(rep.boundary).toBeUndefined();
    expect(HygieneReportSchema.parse(rep)).toEqual(rep);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `tsc -b && npx vitest run dist/gem/__tests__/boundarySegments.test.js`
Expected: FAIL — `rep.boundary` undefined for the two-area session (not yet attached) / `HygieneReportSchema` lacks `boundary`.

- [ ] **Step 3: Write minimal implementation**

In `src/sessionHygieneCore.ts`:
1. Import: add `boundarySegments, type SessionBoundary` to the existing `@agentgem/insight` import (confirm with `grep -an "from \"@agentgem/insight\"" src/sessionHygieneCore.ts`).
2. Extend the interface (after `hygiene: HygieneVerdict;`):
   ```ts
     boundary?: SessionBoundary;
   ```
3. In `buildHygieneReport`, before the `return {`, compute it from the same `session`:
   ```ts
   const boundary = session ? boundarySegments(session) : undefined;
   ```
   and in the returned object literal add (after `hygiene: hygieneScore(factors),`):
   ```ts
     ...(boundary && boundary.segments.length >= 2 ? { boundary } : {}),
   ```

In `src/gem.controller.ts`, extend `HygieneReportSchema` (after the `hygiene:` line ~90) with an optional boundary:
```ts
  boundary: z.object({
    segments: z.array(z.object({ fromTurn: z.number(), toTurn: z.number(), label: z.string() })),
    cutTurn: z.number().nullable(),
  }).optional(),
```

- [ ] **Step 4: Run test to verify it passes**

Run: `tsc -b && npx vitest run dist/gem/__tests__/boundarySegments.test.js`
Then confirm no regression in the #161 hygiene suites: `npx vitest run dist/gem/__tests__/sessionHygiene.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/sessionHygieneCore.ts src/gem.controller.ts src/gem/__tests__/boundarySegments.test.ts
git -c user.name="Raymond Feng" -c user.email="raymond@ninemind.ai" commit -m "feat(insight): attach boundary segmentation to the hygiene report (≥2 episodes)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 3: Client — `BloatCurve` overlays + report rendering

**Files:**
- Modify: `packages/console/src/api/routes.ts` (mirror `boundary?` on the client `HygieneReportSchema` ~line 497)
- Modify: `packages/console/src/panels/_shared/BloatCurve.tsx` (optional `cutTurn` + `segments` props)
- Modify: `packages/console/src/panels/Observe/HygieneReport.tsx` (render overlay + episode list)
- Test: `packages/console/src/panels/Observe/HygieneReport.test.tsx` (extend)

**Interfaces:**
- Consumes: the `/inspect/session/hygiene` report now carrying `boundary?` (Task 2).
- Produces: `BloatCurve` accepts `cutTurn?: number | null` + `segments?: BoundarySegmentView[]`; `HygieneReport.tsx` renders them when present.

- [ ] **Step 1: Write the failing test** (extend `HygieneReport.test.tsx`)

Add to the existing `HygieneReport.test.tsx` a report carrying `boundary` and assert the episode list renders. Reuse the file's existing `sample`/route-mock pattern; add:

```tsx
it("renders the boundary episode list + cut reading when boundary is present", async () => {
  vi.spyOn(routes.hygieneRoute, "call").mockResolvedValue({
    ...sample,
    hygiene: { score: 20, verdict: "bloated" },
    boundary: {
      segments: [{ fromTurn: 0, toTurn: 5, label: "pkg:a" }, { fromTurn: 6, toTurn: 11, label: "pkg:b" }],
      cutTurn: 6,
    },
  } as any);
  render(<HygieneReport apiBase="/" agent="claude" sessionId="s1" />);
  expect(await screen.findByText(/pkg:a/)).toBeTruthy();
  expect(await screen.findByText(/pkg:b/)).toBeTruthy();
  expect(await screen.findByText(/turn 6/i)).toBeTruthy();   // the cut reading names the turn
});

it("renders no episode list when boundary is absent", async () => {
  vi.spyOn(routes.hygieneRoute, "call").mockResolvedValue({ ...sample, hygiene: { score: 90, verdict: "bounded" } } as any);
  render(<HygieneReport apiBase="/" agent="claude" sessionId="s1" />);
  await screen.findByText(/bounded/i);
  expect(screen.queryByText(/task area/i)).toBeNull();
});
```

> Read the top of the existing `HygieneReport.test.tsx` first to reuse its exact `sample` object + `routes`/`vi.spyOn` setup and imports (`grep -an "sample\|hygieneRoute\|import" packages/console/src/panels/Observe/HygieneReport.test.tsx`).

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/console && npx vitest run src/panels/Observe/HygieneReport.test.tsx`
Expected: FAIL — no episode list / no cut reading rendered; `boundary` not on the client type.

- [ ] **Step 3: Write minimal implementation**

In `packages/console/src/api/routes.ts`, extend the client `HygieneReportSchema` (mirror the server) — add after its `curve`/`factors`/`hygiene` fields:
```ts
  boundary: z.object({
    segments: z.array(z.object({ fromTurn: z.number(), toTurn: z.number(), label: z.string() })),
    cutTurn: z.number().nullable(),
  }).optional(),
```

In `packages/console/src/panels/_shared/BloatCurve.tsx`, add the optional props (default absent → existing call sites unchanged). Extend the signature and, inside the `useEffect` after the curve/cap are drawn, add band shading + the cut marker. `cutTurn`/segment turns map to the array index by turn number (curve is contiguous `turn === index`, but look up defensively):

```tsx
export interface BoundarySegmentView { fromTurn: number; toTurn: number; label: string }

export function BloatCurve({ curve, cap, width = 320, height = 90, cutTurn = null, segments }:
  { curve: CurvePoint[]; cap: number; width?: number; height?: number; cutTurn?: number | null; segments?: BoundarySegmentView[] }) {
  const ref = useRef<HTMLCanvasElement | null>(null);
  useEffect(() => {
    const cv = ref.current; if (!cv) return;
    const ctx = cv.getContext("2d"); if (!ctx) return;
    const w = cv.width, h = cv.height, pad = 4;
    const cssVar = (k: string, fallback: string) => getComputedStyle(document.documentElement).getPropertyValue(k).trim() || fallback;
    const heat = cssVar("--accent", "#9a3324");
    const grid = cssVar("--muted", "#8a7f69");
    ctx.clearRect(0, 0, w, h);
    const N = curve.length; if (N === 0) return;
    const idxOfTurn = (t: number) => { const i = curve.findIndex((p) => p.turn === t); return i >= 0 ? i : Math.max(0, Math.min(N - 1, t)); };
    const X = (i: number) => pad + (w - 2 * pad) * (N > 1 ? i / (N - 1) : 0);
    const Y = (v: number) => h - pad - (h - 2 * pad) * Math.min(1, v / cap);
    // faint alternating band shading behind the curve, one band per episode
    if (segments && segments.length > 1) {
      segments.forEach((s, k) => {
        if (k % 2 === 0) return;   // shade every other band
        const x0 = X(idxOfTurn(s.fromTurn)), x1 = X(idxOfTurn(s.toTurn));
        ctx.fillStyle = grid + "18"; ctx.fillRect(x0, pad, Math.max(1, x1 - x0), h - 2 * pad);
      });
    }
    // area + line (existing)
    ctx.beginPath(); ctx.moveTo(X(0), h - pad);
    curve.forEach((p, i) => ctx.lineTo(X(i), Y(p.ctxTokens)));
    ctx.lineTo(X(N - 1), h - pad); ctx.closePath();
    ctx.fillStyle = heat + "22"; ctx.fill();
    ctx.beginPath(); curve.forEach((p, i) => (i ? ctx.lineTo(X(i), Y(p.ctxTokens)) : ctx.moveTo(X(i), Y(p.ctxTokens))));
    ctx.strokeStyle = heat; ctx.lineWidth = 1.5; ctx.stroke();
    // cap line (existing)
    ctx.strokeStyle = grid; ctx.setLineDash([3, 3]);
    ctx.beginPath(); ctx.moveTo(pad, Y(cap)); ctx.lineTo(w - pad, Y(cap)); ctx.stroke(); ctx.setLineDash([]);
    // cut marker
    if (cutTurn != null) {
      const xc = X(idxOfTurn(cutTurn));
      ctx.strokeStyle = heat; ctx.setLineDash([2, 2]); ctx.lineWidth = 1.5;
      ctx.beginPath(); ctx.moveTo(xc, pad); ctx.lineTo(xc, h - pad); ctx.stroke(); ctx.setLineDash([]);
    }
  }, [curve, cap, cutTurn, segments]);
  return <canvas ref={ref} width={width} height={height} className="hyg-canvas" role="img" aria-label="Context size per turn" />;
}
```

> Match the EXISTING `BloatCurve` body when editing — the area/line/cap-line block above is what's already there; you are only adding the `cutTurn`/`segments` params, the shading block, and the cut-marker block. Read the current file first and keep its existing drawing identical.

In `packages/console/src/panels/Observe/HygieneReport.tsx`, where it renders `<BloatCurve curve={rep.curve} cap={rep.meta.cap} />`, pass the overlay props and add the episode list. Read the current render (`grep -an "BloatCurve\|rep.curve\|boundary" packages/console/src/panels/Observe/HygieneReport.tsx`), then:
```tsx
<BloatCurve curve={rep.curve} cap={rep.meta.cap} cutTurn={rep.boundary?.cutTurn ?? null} segments={rep.boundary?.segments} />
{rep.boundary && (
  <div className="hyg-episodes">
    <p className="obs-muted">
      Looked like {rep.boundary.segments.length} task areas
      {rep.boundary.cutTurn != null ? ` — a clean break around turn ${rep.boundary.cutTurn} would have kept each window lean.` : "."}
    </p>
    <ul className="hyg-episode-list">
      {rep.boundary.segments.map((s) => (
        <li key={s.fromTurn}><span className="mono">{s.fromTurn}–{s.toTurn}</span> {s.label}</li>
      ))}
    </ul>
  </div>
)}
```

Add minimal CSS for `.hyg-episodes`/`.hyg-episode-list` to `packages/console/src/shell/theme.css` near the other `.hyg-*` rules (list-reset, small, muted). Reuse existing tokens.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd packages/console && npx vitest run src/panels/Observe/HygieneReport.test.tsx`
Then typecheck: `cd packages/console && npx tsc -b`
Expected: all PASS / clean.

- [ ] **Step 5: Commit**

```bash
git add packages/console/src/api/routes.ts packages/console/src/panels/_shared/BloatCurve.tsx packages/console/src/panels/Observe/HygieneReport.tsx packages/console/src/shell/theme.css packages/console/src/panels/Observe/HygieneReport.test.tsx
git -c user.name="Raymond Feng" -c user.email="raymond@ninemind.ai" commit -m "feat(console): render boundary segmentation on the bloat curve + episode list

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Final verification

- [ ] Server suite: `npm test` (includes `boundarySegments.test.js` + unaffected #161 suites).
- [ ] Console: `cd packages/console && npx vitest run src/panels/Observe/HygieneReport.test.tsx && npx tsc -b`.
- [ ] Manual smoke (optional): open a real bloated multi-area Claude session in Inspect → Session; confirm the bloat curve shows band shading + a dashed cut marker and the episode list reads "Looked like N task areas — a clean break around turn K…"; open a single-area session and confirm no episode section.

## Out of scope (deferred Tier-2)

- The LLM confirm/refute + natural-language episode labels (a later optional layer behind this same UI).
- Batch boundary analysis across the leaderboard; streaming.
