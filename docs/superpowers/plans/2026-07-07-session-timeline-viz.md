# Session Timeline Visualization Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn the History → Session detail view (`TranscriptViewer`) into two lenses on the same run — a context-window timeline (primary, with hygiene folded into a right rail) and a Map⇄Transcript structure toggle — driven by data already on the wire plus one small uncapped event capture in the scan.

**Architecture:** Server: capture an uncapped `eventSeries` (skill + subagent invocations, by `msgIndex`) during the workflow scan and surface it as `events[]` on the existing `/api/inspect/session/hygiene` response. Client: three pure view-model modules (`toolCategory`, `ctxTimeline`, `phases`) feed two new React components (`ContextTimeline` replaces the `HygieneReport` block; `StructureView` wraps the turn tree with a Map⇄Transcript toggle). No new route, no nav change.

**Tech Stack:** TypeScript, Zod route schemas (`@agentgem/base` house pattern), React 18, inline SVG (no chart lib), Vitest (`jsdom` for console, node for server), `@agentgem/insight` scan.

## Global Constraints

- Node floor `>=24`.
- Client and server Zod schemas must stay byte-identical: `HygieneReportSchema` exists in **both** `src/gem.controller.ts` and `packages/console/src/api/routes.ts` — every change to one is mirrored in the other.
- New fields are **additive and optional** (`.optional()` / `?`) so old cached scans and older clients keep working.
- ① (context timeline + hygiene) stays **Claude-only** (`agent === "claude"`); ② (structure map) works for both agents.
- `packages/insight/src/workflowScan.ts` is **binary-classified by git/grep** — always use `grep -a` on it.
- Console tests are **not in CI** — run them locally. Root suite (`test (24)` / `test (26)`) gates the server change; run the **full** insight/gem suite (hardcoded-count tests exist).
- Do **not** delete `packages/console/src/panels/_shared/BloatCurve.tsx` — it may still be used by the Watch live-nudge; this plan supersedes it only inside `HygieneReport`'s slot.
- Vitest runs compiled `dist/` for the root package — after renames/removals, clean stale `dist/` (keep `*.tsbuildinfo` in mind) before trusting a run.
- Commits: end message with `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`. Work happens on branch `feat/session-timeline-viz` (worktree `../agentgem-session-viz`).

---

## File Structure

**Server (root package `src/` + `packages/insight`):**
- Modify `packages/insight/src/workflowScan.ts` — add `SessionEvent` type, `eventSeries?` on `SessionSequence`, uncapped capture in the assistant-content loop.
- Modify `packages/insight/src/index.ts` — export `SessionEvent`.
- Modify `src/sessionHygieneCore.ts` — add `events` to `HygieneReport`, populate from `session.eventSeries`.
- Modify `src/gem.controller.ts` — add `events` to `HygieneReportSchema`.
- Modify `packages/console/src/api/routes.ts` — mirror `events` on `HygieneReportSchema`.
- Tests: `src/gem/__tests__/workflowScan.test.ts`, `src/gem/__tests__/sessionHygiene.test.ts`.

**Client (`packages/console/src/panels/Observe/`):**
- Create `toolCategory.ts` — `catOf(tool)` + `CATEGORY_COLOR` map (shared by ① markers and ② cells).
- Create `ctxTimeline.ts` — pure `(curve, events, cap) → TimelineModel`.
- Create `phases.ts` — pure `(TranscriptView) → Phase[]`.
- Create `ContextTimeline.tsx` — fetches hygiene, renders SVG chart + folded rail. Replaces `<HygieneReport>` in `TranscriptViewer`.
- Create `PhaseFlamestrip.tsx` — one phase row (header + skill/agent pills + flamestrip).
- Create `StructureView.tsx` — Map⇄Transcript toggle; owns phase list vs. delegates to the turn tree.
- Create `turnTree.tsx` — `Turn`/`Span`/`summarize` extracted from `TranscriptViewer` (breaks the `TranscriptViewer`↔`StructureView` import cycle).
- Modify `TranscriptViewer.tsx` — swap `HygieneReport`→`ContextTimeline`; move `Turn`/`Span`/`summarize` into `turnTree.tsx`; move the `<ol.tv-turns>` block into `StructureView` (as `Transcript` mode) and default to `Map`.
- Modify `TranscriptDiff.tsx` — repoint its `Span`/`summarize` import to `turnTree.js`.
- Modify `packages/console/src/shell/theme.css` (or the Observe css module in use) — styles for `.ct*`, `.sv*`, `.phase*` classes.
- Tests: `toolCategory.test.ts`, `ctxTimeline.test.ts`, `phases.test.ts`, `ContextTimeline.test.tsx`, `StructureView.test.tsx` (all colocated in `Observe/`).

---

## Task 1: Uncapped skill+subagent event capture in the scan

**Files:**
- Modify: `packages/insight/src/workflowScan.ts` (type near line 28–43; capture in the assistant-content loop near lines 418–457)
- Modify: `packages/insight/src/index.ts` (add export)
- Test: `src/gem/__tests__/workflowScan.test.ts`

**Interfaces:**
- Produces: `interface SessionEvent { msgIndex: number; kind: "skill" | "agent"; name: string }` and `SessionSequence.eventSeries?: SessionEvent[]` (uncapped; skill + subagent only). Consumed by Task 2.

**Why not reuse `steps`:** `steps` skips `Skill` (diverted to the skill-inventory branch at line 439) and is capped at `SEQ_CAP_PER_SESSION = 40`. `contextSeries` is uncapped; `eventSeries` mirrors it — one entry per skill/subagent invocation, no cap — so markers cover the whole run.

- [ ] **Step 1: Write the failing test**

Add to `src/gem/__tests__/workflowScan.test.ts` (follow the existing fixture style in that file — it already builds a transcript array and calls `scanWorkflow`). If the file has a helper to write a temp `.jsonl`, reuse it; otherwise mirror the nearest existing test's setup.

```ts
import { describe, it, expect } from "vitest";
import { scanWorkflow } from "@agentgem/insight";
// reuse whatever temp-file / inventory helper the sibling tests in this file use.

describe("scanWorkflow eventSeries", () => {
  it("captures skill and subagent invocations by msgIndex, uncapped and skill-named", () => {
    // A transcript whose assistant turns invoke a Skill and spawn a Task subagent.
    // Build it the same way the other tests in this file build fixtures.
    const path = writeFixtureTranscript([
      assistantWithUsage({ ctx: 1000 }),
      assistantToolUse("Skill", { skill: "superpowers:brainstorming" }),
      assistantToolUse("Task", { subagent_type: "Explore", description: "look around" }),
      assistantToolUse("Bash", { command: "ls" }), // NOT an event
    ]);
    const signal = scanWorkflow([path], MINIMAL_INV, { retainSequences: true });
    const evs = signal.sequences!.sessions[0].eventSeries!;
    expect(evs).toEqual([
      { msgIndex: expect.any(Number), kind: "skill", name: "superpowers:brainstorming" },
      { msgIndex: expect.any(Number), kind: "agent", name: "Explore" },
    ]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @agentgem/insight test -- workflowScan` (or the repo's root `pnpm test -- workflowScan.test`)
Expected: FAIL — `eventSeries` is `undefined`.

- [ ] **Step 3: Add the type and the capture**

In `packages/insight/src/workflowScan.ts` add the type next to `ProcedureStep` (~line 28):

```ts
export interface SessionEvent { msgIndex: number; kind: "skill" | "agent"; name: string }
```

Add the field to `SessionSequence` (~line 43):

```ts
export interface SessionSequence { steps: ProcedureStep[]; missionHint?: MissionHint; sessionId: string; transcript: string; atMs: number; model?: string; contextSeries?: TurnUsage[]; eventSeries?: SessionEvent[] }
```

Declare the accumulator next to `contextSeries` (~line 395):

```ts
    const eventSeries: SessionEvent[] = [];
```

In the assistant-content loop, capture the skill in the existing Skill branch (~line 439, alongside the `touch(...)` calls) — gated on `retainSequences`, uncapped, non-sidechain:

```ts
          if (name === "Skill" && typeof block.input?.skill === "string") {
            const skill = String(block.input.skill);
            if (opts.retainSequences && !rec?.isSidechain) eventSeries.push({ msgIndex: lineIdx, kind: "skill", name: skill });
            // …existing matchSkill / touch / bumpUnresolved lines stay unchanged…
```

Capture subagents where builtin tool calls are handled (the `else` branch around line 456, before/after the `steps.push`) — detect `Task`/`Agent` by name, prefer `subagent_type`:

```ts
            if (opts.retainSequences && !rec?.isSidechain && (name === "Task" || name === "Agent")) {
              const sub = typeof block.input?.subagent_type === "string" ? block.input.subagent_type : name;
              eventSeries.push({ msgIndex: lineIdx, kind: "agent", name: sub });
            }
```

Attach it to the emitted session coords (~line 487), same pattern as `contextSeries`:

```ts
      const coords = { sessionId: sessionId || basename.replace(/\.jsonl$/, ""), transcript: basename, atMs: ms, model: sessionPrimaryModel(currentSessionRecords), ...(contextSeries.length ? { contextSeries } : {}), ...(eventSeries.length ? { eventSeries } : {}) };
```

Export the type in `packages/insight/src/index.ts` (add to the existing `workflowScan.js` re-export line):

```ts
export type { SessionEvent } from "./workflowScan.js";
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @agentgem/insight test -- workflowScan`
Expected: PASS. Also run the full insight suite (`pnpm --filter @agentgem/insight test`) — nothing else references `eventSeries`, so no regressions.

- [ ] **Step 5: Commit**

```bash
git add packages/insight/src/workflowScan.ts packages/insight/src/index.ts src/gem/__tests__/workflowScan.test.ts
git commit -m "feat(insight): capture uncapped skill+subagent eventSeries in workflow scan

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 2: Surface `events[]` on the hygiene report + both schemas

**Files:**
- Modify: `src/sessionHygieneCore.ts:32-55` (`HygieneReport` interface + `buildHygieneReport`)
- Modify: `src/gem.controller.ts` (`HygieneReportSchema`, ~line 77-90)
- Modify: `packages/console/src/api/routes.ts` (`HygieneReportSchema`, ~line 497-505)
- Test: `src/gem/__tests__/sessionHygiene.test.ts`

**Interfaces:**
- Consumes: `SessionSequence.eventSeries` + `SessionEvent` (Task 1).
- Produces: `HygieneReport.events: SessionEvent[]` on the wire (client type `HygieneReport["events"]`). Consumed by Task 4/6.

- [ ] **Step 1: Write the failing test**

Add to `src/gem/__tests__/sessionHygiene.test.ts` (it already imports `buildHygieneReport` or scans a fixture — follow the file's existing style):

```ts
it("includes skill/subagent events on the report", () => {
  const signal = { sequences: { root: "", sessions: [{
    sessionId: "s1", transcript: "s1.jsonl", atMs: 0, steps: [], contextSeries: [],
    eventSeries: [{ msgIndex: 3, kind: "skill", name: "review" }],
  }] } } as any;
  const rep = buildHygieneReport(signal);
  expect(rep.events).toEqual([{ msgIndex: 3, kind: "skill", name: "review" }]);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test -- sessionHygiene`
Expected: FAIL — `rep.events` is `undefined`.

- [ ] **Step 3: Add `events` to the interface + builder**

In `src/sessionHygieneCore.ts`, extend the interface (line 32) and the return (line 44). Import `SessionEvent`:

```ts
import { /* …existing… */ type SessionEvent } from "@agentgem/insight";

export interface HygieneReport {
  meta: { sessionId: string; transcript: string; model: string | null; cap: number };
  curve: TurnUsage[];
  events: SessionEvent[];
  factors: DetectorSummary[];
  hygiene: HygieneVerdict;
}
```

In `buildHygieneReport`, add one line to the returned object (after `curve:`):

```ts
    curve: session?.contextSeries ?? [],
    events: session?.eventSeries ?? [],
```

- [ ] **Step 4: Mirror the field in both Zod schemas**

In `src/gem.controller.ts` `HygieneReportSchema` (after the `curve:` line):

```ts
  events: z.array(z.object({ msgIndex: z.number(), kind: z.enum(["skill", "agent"]), name: z.string() })),
```

Identical line in `packages/console/src/api/routes.ts` `HygieneReportSchema` (after its `curve:` line).

- [ ] **Step 5: Run tests to verify they pass**

Run: `pnpm test -- sessionHygiene` (PASS), then `pnpm --filter @agentgem/console test -- routes` if such a test exists, and typecheck the console (`pnpm --filter @agentgem/console exec tsc --noEmit`) so the mirrored schema compiles.
Expected: PASS / no type errors.

- [ ] **Step 6: Commit**

```bash
git add src/sessionHygieneCore.ts src/gem.controller.ts packages/console/src/api/routes.ts src/gem/__tests__/sessionHygiene.test.ts
git commit -m "feat(insight): surface skill/subagent events on the session hygiene report

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 3: `toolCategory` — shared tool→category→color map

**Files:**
- Create: `packages/console/src/panels/Observe/toolCategory.ts`
- Test: `packages/console/src/panels/Observe/toolCategory.test.ts`

**Interfaces:**
- Produces: `type ToolCategory = "read"|"write"|"bash"|"skill"|"agent"|"ask"|"task"|"other"`; `catOf(tool: string): ToolCategory`; `CATEGORY_COLOR: Record<ToolCategory, string>` (CSS `var(--…)` strings). Consumed by Tasks 4, 6, 7.

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect } from "vitest";
import { catOf, CATEGORY_COLOR } from "./toolCategory.js";

describe("catOf", () => {
  it("maps known tools to categories", () => {
    expect(catOf("Read")).toBe("read");
    expect(catOf("Edit")).toBe("write");
    expect(catOf("Bash")).toBe("bash");
    expect(catOf("Skill")).toBe("skill");
    expect(catOf("Task")).toBe("agent");
    expect(catOf("Agent")).toBe("agent");
    expect(catOf("AskUserQuestion")).toBe("ask");
    expect(catOf("TaskUpdate")).toBe("task");
    expect(catOf("Wibble")).toBe("other");
  });
  it("has a color for every category", () => {
    (["read","write","bash","skill","agent","ask","task","other"] as const)
      .forEach((c) => expect(CATEGORY_COLOR[c]).toMatch(/^var\(--/));
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @agentgem/console test -- toolCategory`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the module**

```ts
// packages/console/src/panels/Observe/toolCategory.ts
export type ToolCategory = "read" | "write" | "bash" | "skill" | "agent" | "ask" | "task" | "other";

const MAP: Record<string, ToolCategory> = {
  Read: "read", Grep: "read", Glob: "read", LS: "read", ToolSearch: "read",
  Write: "write", Edit: "write", NotebookEdit: "write",
  Bash: "bash",
  Skill: "skill",
  Task: "agent", Agent: "agent",
  AskUserQuestion: "ask",
  TaskCreate: "task", TaskUpdate: "task",
};

export function catOf(tool: string): ToolCategory {
  return MAP[tool] ?? "other";
}

export const CATEGORY_COLOR: Record<ToolCategory, string> = {
  read: "var(--blue)", write: "var(--green)", bash: "var(--slate)", skill: "var(--purple)",
  agent: "var(--pink)", ask: "var(--amber)", task: "var(--teal)", other: "var(--muted)",
};
```

(Confirm the actual CSS custom-property names in `shell/theme.css` — the console uses `--accent`/`--muted`; if `--blue` etc. don't exist, add them in Task 6's CSS step or map to the closest existing token. Keep this file's values in sync with whatever tokens ship.)

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @agentgem/console test -- toolCategory`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/console/src/panels/Observe/toolCategory.ts packages/console/src/panels/Observe/toolCategory.test.ts
git commit -m "feat(console): shared tool→category→color map for session views

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 4: `ctxTimeline` — pure timeline view-model

**Files:**
- Create: `packages/console/src/panels/Observe/ctxTimeline.ts`
- Test: `packages/console/src/panels/Observe/ctxTimeline.test.ts`

**Interfaces:**
- Consumes: `HygieneReport["curve"]`, `HygieneReport["events"]`, `cap: number`, `CATEGORY_COLOR`/`catOf` (Task 3).
- Produces:
  ```ts
  interface Marker { x: number; kind: "skill" | "agent"; name: string }  // x in [0,1]
  interface Jump { turn: number; delta: number; ctx: number; cause: string; category: ToolCategory }
  interface TimelineModel {
    n: number; ymax: number;
    points: { x: number; ctx: number; out: number }[]; // x,ctx,out normalized-ready (raw values)
    markers: Marker[];
    jumps: Jump[];   // top 4 positive deltas, desc
  }
  function buildTimeline(curve: HygieneReport["curve"], events: HygieneReport["events"], cap: number): TimelineModel
  ```
  Consumed by Task 6.

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect } from "vitest";
import { buildTimeline } from "./ctxTimeline.js";

const curve = [
  { turn: 0, msgIndex: 1, ctxTokens: 1000, cacheCreation: 500, outTokens: 10 },
  { turn: 1, msgIndex: 4, ctxTokens: 5000, cacheCreation: 4000, outTokens: 20 },
  { turn: 2, msgIndex: 7, ctxTokens: 5200, cacheCreation: 100, outTokens: 5 },
];
const events = [{ msgIndex: 4, kind: "skill" as const, name: "review" }];

describe("buildTimeline", () => {
  it("ranks jumps by delta and attributes the skill cause", () => {
    const m = buildTimeline(curve, events, 1_000_000);
    expect(m.n).toBe(3);
    expect(m.jumps[0]).toMatchObject({ turn: 1, delta: 4000, category: "skill" });
    expect(m.jumps[0].cause).toMatch(/review/);
  });
  it("places a marker at the skill's turn position", () => {
    const m = buildTimeline(curve, events, 1_000_000);
    expect(m.markers).toEqual([{ x: 0.5, kind: "skill", name: "review" }]);
  });
  it("returns an empty model for a curve shorter than 2", () => {
    expect(buildTimeline([curve[0]], [], 1000).jumps).toEqual([]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @agentgem/console test -- ctxTimeline`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the module**

```ts
// packages/console/src/panels/Observe/ctxTimeline.ts
import type { HygieneReport } from "../../api/routes.js";
import { catOf, type ToolCategory } from "./toolCategory.js";

export interface Marker { x: number; kind: "skill" | "agent"; name: string }
export interface Jump { turn: number; delta: number; ctx: number; cause: string; category: ToolCategory }
export interface TimelineModel {
  n: number; ymax: number;
  points: { x: number; ctx: number; out: number }[];
  markers: Marker[];
  jumps: Jump[];
}

export function buildTimeline(curve: HygieneReport["curve"], events: HygieneReport["events"], cap: number): TimelineModel {
  const n = curve.length;
  const empty: TimelineModel = { n, ymax: 0, points: [], markers: [], jumps: [] };
  if (n < 2) return { ...empty, points: curve.map((p, i) => ({ x: n <= 1 ? 0 : i / (n - 1), ctx: p.ctxTokens, out: p.outTokens })) };

  const peak = Math.max(...curve.map((p) => p.ctxTokens));
  const ymax = Math.min(cap, Math.ceil(peak / 50_000) * 50_000) || peak;
  const xOf = (i: number) => i / (n - 1);
  const points = curve.map((p, i) => ({ x: xOf(i), ctx: p.ctxTokens, out: p.outTokens }));

  // markers: map each event's msgIndex to the nearest curve point index.
  const idxByMsg = curve.map((p) => p.msgIndex);
  const nearest = (msgIndex: number) => {
    let best = 0, bd = Infinity;
    idxByMsg.forEach((mi, i) => { const d = Math.abs(mi - msgIndex); if (d < bd) { bd = d; best = i; } });
    return best;
  };
  const markers: Marker[] = events.map((e) => ({ x: xOf(nearest(e.msgIndex)), kind: e.kind, name: e.name }));

  // jumps: top 4 positive ctx deltas; cause from an event on that point, else cache-creation.
  const evByPoint = new Map<number, HygieneReport["events"][number]>();
  events.forEach((e) => evByPoint.set(nearest(e.msgIndex), e));
  const rows: Jump[] = [];
  for (let i = 1; i < n; i++) {
    const delta = curve[i].ctxTokens - curve[i - 1].ctxTokens;
    if (delta <= 0) continue;
    const e = evByPoint.get(i);
    let cause: string, category: ToolCategory;
    if (e?.kind === "skill") { cause = `loaded skill ${e.name}`; category = "skill"; }
    else if (e?.kind === "agent") { cause = `subagent ${e.name} folded back`; category = "agent"; }
    else if (curve[i].cacheCreation > 8000) { cause = `context injection (+${Math.round(curve[i].cacheCreation / 1000)}k new)`; category = "other"; }
    else { cause = "model output"; category = "other"; }
    rows.push({ turn: curve[i].turn, delta, ctx: curve[i].ctxTokens, cause, category });
  }
  rows.sort((a, b) => b.delta - a.delta);
  return { n, ymax, points, markers, jumps: rows.slice(0, 4) };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @agentgem/console test -- ctxTimeline`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/console/src/panels/Observe/ctxTimeline.ts packages/console/src/panels/Observe/ctxTimeline.test.ts
git commit -m "feat(console): pure timeline view-model (markers + ranked context jumps)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 5: `phases` — pure TranscriptView → Phase[]

**Files:**
- Create: `packages/console/src/panels/Observe/phases.ts`
- Test: `packages/console/src/panels/Observe/phases.test.ts`

**Interfaces:**
- Consumes: `TranscriptView`, `TranscriptTurn`, `TranscriptSpan` (from `../../api/routes.js`).
- Produces:
  ```ts
  interface Phase { label: string; turns: number; out: number; tools: string[]; skills: number; agents: number }
  function phasesOf(view: TranscriptView): Phase[]
  ```
  `tools` is the ordered list of `tool_call` span names across the phase (for the flamestrip); `skills`/`agents` are counts (Skill spans / Task+Agent spans). A phase starts at each `user` message span; assistant turns before the first user prompt fold into a `"(session start)"` phase. Consumed by Task 7.

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect } from "vitest";
import { phasesOf } from "./phases.js";

const view = {
  sessionId: "s", agent: "claude", meta: {} as any,
  turns: [
    { id: "t0", role: "user", tsMs: 0, tokens: { in: 0, out: 0, cache: 0 },
      spans: [{ kind: "message", role: "user", text: "do the thing" }] },
    { id: "t1", role: "assistant", tsMs: 1, tokens: { in: 0, out: 30, cache: 0 },
      spans: [{ kind: "tool_call", name: "Read", input: "x" }, { kind: "tool_call", name: "Skill", input: "y" }] },
  ],
} as any;

describe("phasesOf", () => {
  it("splits at user prompts and aggregates tools/skills", () => {
    const ps = phasesOf(view);
    expect(ps).toHaveLength(1);
    expect(ps[0]).toMatchObject({ label: "do the thing", turns: 1, out: 30, tools: ["Read", "Skill"], skills: 1, agents: 0 });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @agentgem/console test -- phases`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the module**

```ts
// packages/console/src/panels/Observe/phases.ts
import type { TranscriptView, TranscriptTurn } from "../../api/routes.js";

export interface Phase { label: string; turns: number; out: number; tools: string[]; skills: number; agents: number }

function firstUserText(turn: TranscriptTurn): string | null {
  const m = turn.spans.find((s) => s.kind === "message" && s.role === "user");
  return m && m.kind === "message" ? m.text.split("\n", 1)[0].slice(0, 120) : null;
}

export function phasesOf(view: TranscriptView): Phase[] {
  const phases: Phase[] = [];
  let cur: Phase | null = null;
  const ensure = (label: string) => { cur = { label, turns: 0, out: 0, tools: [], skills: 0, agents: 0 }; phases.push(cur); return cur; };

  for (const turn of view.turns) {
    const ut = turn.role === "user" ? firstUserText(turn) : null;
    if (ut !== null) { ensure(ut); continue; }
    if (!cur) cur = ensure("(session start)");
    cur.turns += 1;
    cur.out += turn.tokens.out;
    for (const s of turn.spans) {
      if (s.kind !== "tool_call") continue;
      cur.tools.push(s.name);
      if (s.name === "Skill") cur.skills += 1;
      if (s.name === "Task" || s.name === "Agent") cur.agents += 1;
    }
  }
  return phases.filter((p) => p.turns > 0);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @agentgem/console test -- phases`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/console/src/panels/Observe/phases.ts packages/console/src/panels/Observe/phases.test.ts
git commit -m "feat(console): pure phase segmentation from a session transcript

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 6: `ContextTimeline` component + swap into TranscriptViewer

**Files:**
- Create: `packages/console/src/panels/Observe/ContextTimeline.tsx`
- Modify: `packages/console/src/panels/Observe/TranscriptViewer.tsx:76` (replace `<HygieneReport …/>` with `<ContextTimeline …/>`)
- Modify: console CSS (`shell/theme.css` or the Observe stylesheet) — `.ct`, `.ct-chart`, `.ct-rail`, `.hyg-verdict` (reuse existing), `.jump`, marker/legend classes; add `--blue/--green/--purple/--pink/--amber/--slate/--teal` tokens (light + dark) if absent.
- Test: `packages/console/src/panels/Observe/ContextTimeline.test.tsx`

**Interfaces:**
- Consumes: `hygieneRoute` (existing), `buildTimeline` (Task 4), `CATEGORY_COLOR` (Task 3), `HygieneReport` type (Task 2 field).
- Produces: `export function ContextTimeline({ apiBase, agent, sessionId }: { apiBase: string; agent: "claude" | "codex"; sessionId: string })`. Same props as `HygieneReport` (drop-in).

- [ ] **Step 1: Write the failing test** (mirror `HygieneReport.test.tsx`)

```tsx
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import { ContextTimeline } from "./ContextTimeline.js";
import * as routes from "../../api/routes.js";

const sample = {
  meta: { sessionId: "s1", transcript: "s1.jsonl", model: "claude-opus-4-8[1m]", cap: 1_000_000 },
  curve: [
    { turn: 0, msgIndex: 1, ctxTokens: 100_000, cacheCreation: 2000, outTokens: 10 },
    { turn: 1, msgIndex: 4, ctxTokens: 500_000, cacheCreation: 40_000, outTokens: 20 },
  ],
  events: [{ msgIndex: 4, kind: "skill", name: "review" }],
  factors: [{ id: "context-pinned", title: "Window pinned", advice: "Cut earlier.", severity: "warn", count: 1, sessions: 1 }],
  hygiene: { score: 41, verdict: "bloated" },
};

beforeEach(() => vi.restoreAllMocks());

describe("ContextTimeline", () => {
  it("renders the verdict, a fired factor, and a ranked jump", async () => {
    vi.spyOn(routes.hygieneRoute, "call").mockResolvedValue(sample as any);
    render(<ContextTimeline apiBase="/" agent="claude" sessionId="s1" />);
    expect(await screen.findByText(/bloated/i)).toBeTruthy();
    expect(await screen.findByText(/Window pinned/i)).toBeTruthy();
    expect(await screen.findByText(/review/i)).toBeTruthy(); // jump cause names the skill
  });
  it("renders nothing for codex", () => {
    const { container } = render(<ContextTimeline apiBase="/" agent="codex" sessionId="s1" />);
    expect(container.firstChild).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @agentgem/console test -- ContextTimeline`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the component**

Fetch/loading/codex-guard identical to `HygieneReport` (copy its `useEffect`/`agent!=="claude"` shape). Render an SVG chart (left) + a rail (right) built from `buildTimeline(rep.curve, rep.events, rep.meta.cap)`. Keep the SVG self-contained; use a `viewBox` with a min-width and wrap in an `overflow-x:auto` container. Cap the jumps list at `model.jumps` (already ≤4) and the factors list to `count > 0`; give the rail `overflow-y:auto` so it never stretches the card (spec edge-handling).

```tsx
// packages/console/src/panels/Observe/ContextTimeline.tsx
import { useEffect, useState } from "react";
import { hygieneRoute, makeClient, type HygieneReport as Report } from "../../api/routes.js";
import { buildTimeline } from "./ctxTimeline.js";
import { CATEGORY_COLOR } from "./toolCategory.js";
import { fmtTokens } from "./data.js";

export function ContextTimeline({ apiBase, agent, sessionId }: { apiBase: string; agent: "claude" | "codex"; sessionId: string }) {
  const [rep, setRep] = useState<Report | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (agent !== "claude") return;
    let alive = true;
    setLoading(true); setError(null); setRep(null);
    hygieneRoute.call(makeClient(apiBase), { query: { id: sessionId, agent } })
      .then((r) => { if (alive) setRep(r); })
      .catch((e) => { if (alive) setError(String(e?.message ?? e)); })
      .finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, [apiBase, agent, sessionId]);

  if (agent !== "claude") return null;
  if (loading) return <div className="obs hyg"><div className="obs-muted">Analyzing…</div></div>;
  if (error) return <div className="obs hyg"><div className="obs-error">{error}</div></div>;
  if (!rep || rep.curve.length === 0) return <div className="obs hyg"><div className="obs-muted">No context data for this session.</div></div>;

  const m = buildTimeline(rep.curve, rep.events, rep.meta.cap);
  const W = Math.max(560, m.n * 0.9), H = 300, PL = 48, PR = 10, PT = 14, PB = 34;
  const iw = W - PL - PR, ih = H - PT - PB;
  const X = (x: number) => PL + x * iw;
  const Y = (v: number) => PT + ih - (v / (m.ymax || 1)) * ih;

  return (
    <div className="obs ct">
      <div className="ct-chart">
        <div className="ct-scroll" style={{ overflowX: "auto" }}>
          <svg viewBox={`0 0 ${W} ${H}`} width={W} height={H} role="img" aria-label="Context window over the session">
            {[0.5, 0.8].map((f) => (
              <rect key={f} x={PL} y={Y(m.ymax)} width={iw} height={Y(f * m.ymax) - Y(m.ymax)}
                fill={f >= 0.8 ? "color-mix(in srgb, var(--red) 11%, transparent)" : "color-mix(in srgb, var(--amber) 9%, transparent)"} />
            ))}
            <path d={`M ${X(0)} ${Y(m.points[0].ctx)} ` + m.points.map((p) => `L ${X(p.x)} ${Y(p.ctx)}`).join(" ") + ` L ${X(1)} ${Y(0)} L ${X(0)} ${Y(0)} Z`}
              fill="color-mix(in srgb, var(--blue) 18%, transparent)" />
            <path d={`M ${X(0)} ${Y(m.points[0].ctx)} ` + m.points.map((p) => `L ${X(p.x)} ${Y(p.ctx)}`).join(" ")}
              fill="none" stroke="var(--blue)" strokeWidth={1.5} />
            {m.markers.map((mk, i) => (
              <circle key={i} cx={X(mk.x)} cy={PT + 7} r={3} fill={mk.kind === "skill" ? CATEGORY_COLOR.skill : CATEGORY_COLOR.agent}>
                <title>{mk.kind}: {mk.name}</title>
              </circle>
            ))}
          </svg>
        </div>
      </div>
      <div className="ct-rail">
        <div className={"hyg-verdict is-" + rep.hygiene.verdict}>
          <span className="hyg-score">{fmtTokens(Math.max(...rep.curve.map((c) => c.ctxTokens)))}</span>
          <span className="hyg-word">{rep.hygiene.verdict}</span>
        </div>
        <div className="rail-h">Why — hygiene factors</div>
        <ul className="ct-facs">
          {rep.factors.filter((f) => f.count > 0).map((f) => (
            <li key={f.id}><b>{f.title}</b> <span className="obs-muted">×{f.count}</span><div className="obs-muted">{f.advice}</div></li>
          ))}
        </ul>
        <div className="rail-h">Biggest context jumps</div>
        {m.jumps.map((j, i) => (
          <div className="jump" key={i}>
            <div className="jbadge">+{fmtTokens(j.delta)}</div>
            <div className="jbody"><div className="t">turn {j.turn} · <span style={{ color: CATEGORY_COLOR[j.category] }}>{j.category}</span></div>
              <div className="obs-muted">{j.cause}</div></div>
          </div>
        ))}
      </div>
    </div>
  );
}
```

- [ ] **Step 4: Swap into `TranscriptViewer` + add CSS**

In `TranscriptViewer.tsx`, change the import and the render line (~76):

```tsx
import { ContextTimeline } from "./ContextTimeline.js";
// …
{view && <ContextTimeline apiBase={apiBase} agent={agent} sessionId={view.sessionId} />}
```

Add the `.ct*`/`.rail-h`/`.jump`/`.ct-facs` styles and any missing `--blue/--green/…` tokens to the console stylesheet (both light + dark), following the mockup layout (grid `1fr 288px`, rail `overflow-y:auto`, wraps below chart under ~880px).

- [ ] **Step 5: Run tests + typecheck**

Run: `pnpm --filter @agentgem/console test -- ContextTimeline` (PASS) and `pnpm --filter @agentgem/console exec tsc --noEmit` (clean).

- [ ] **Step 6: Commit**

```bash
git add packages/console/src/panels/Observe/ContextTimeline.tsx packages/console/src/panels/Observe/ContextTimeline.test.tsx packages/console/src/panels/Observe/TranscriptViewer.tsx packages/console/src/shell/theme.css
git commit -m "feat(console): context timeline replaces the hygiene block in session view

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 7: `StructureView` (Map ⇄ Transcript) + wire the turn tree

**Files:**
- Create: `packages/console/src/panels/Observe/turnTree.tsx` (extract `Turn`, `Span`, `summarize` here to break the import cycle)
- Create: `packages/console/src/panels/Observe/PhaseFlamestrip.tsx`
- Create: `packages/console/src/panels/Observe/StructureView.tsx`
- Modify: `packages/console/src/panels/Observe/TranscriptViewer.tsx:80-87,114-158` (move `<ol className="tv-turns">` into `StructureView`; move `Turn`/`Span`/`summarize` into `turnTree.tsx` and re-import)
- Modify: `packages/console/src/panels/Observe/TranscriptDiff.tsx:9` (import `Span`, `summarize` from `./turnTree.js` instead of `./TranscriptViewer.js`)
- Modify: console CSS — `.sv*`, `.phase*`, `.strip`, `.cell`, `.band` (from the mockup)
- Test: `packages/console/src/panels/Observe/StructureView.test.tsx`

**Interfaces:**
- Consumes: `phasesOf` (Task 5), `catOf`/`CATEGORY_COLOR` (Task 3), `TranscriptView`, `Turn` (from `turnTree.js`).
- Produces: `export function StructureView({ view, collapsed, onToggle }: { view: TranscriptView; collapsed: Set<string>; onToggle: (id: string) => void })`. Defaults to `"map"` mode. Also `turnTree.tsx` re-exports `Turn`, `Span`, `summarize` (moved verbatim from `TranscriptViewer`, no logic change).

**Break the cycle first:** `StructureView` needs `Turn`; `TranscriptViewer` needs `StructureView`. If `Turn` stays in `TranscriptViewer`, that's a circular import. So Step 3 moves `Turn`/`Span`/`summarize` into `turnTree.tsx` (both files import from there; no cycle). `TranscriptDiff` already imports `Span`/`summarize` from `TranscriptViewer` — repoint it to `turnTree.js`.

- [ ] **Step 1: Write the failing test**

```tsx
import { describe, it, expect } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { StructureView } from "./StructureView.js";

const view = {
  sessionId: "s", agent: "claude", meta: {} as any,
  turns: [
    { id: "u0", role: "user", tsMs: 0, tokens: { in: 0, out: 0, cache: 0 }, spans: [{ kind: "message", role: "user", text: "write the doc" }] },
    { id: "a0", role: "assistant", tsMs: 1, tokens: { in: 0, out: 5, cache: 0 }, spans: [{ kind: "tool_call", name: "Write", input: "f" }] },
  ],
} as any;

describe("StructureView", () => {
  it("defaults to Map and shows a phase label + tool cell", () => {
    render(<StructureView view={view} collapsed={new Set()} onToggle={() => {}} />);
    expect(screen.getByText(/write the doc/i)).toBeTruthy();
    expect(screen.getByText(/Write/)).toBeTruthy();
  });
  it("switches to Transcript mode", () => {
    render(<StructureView view={view} collapsed={new Set()} onToggle={() => {}} />);
    fireEvent.click(screen.getByRole("button", { name: /transcript/i }));
    expect(screen.getByText(/write the doc/i)).toBeTruthy(); // verbatim message now shown
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @agentgem/console test -- StructureView`
Expected: FAIL — module not found.

- [ ] **Step 3: Write `PhaseFlamestrip.tsx`**

```tsx
// packages/console/src/panels/Observe/PhaseFlamestrip.tsx
import { catOf, CATEGORY_COLOR } from "./toolCategory.js";
import type { Phase } from "./phases.js";
import { fmtTokens } from "./data.js";

export function PhaseFlamestrip({ phase, index }: { phase: Phase; index: number }) {
  const cells: { t: string; n: number }[] = [];
  for (const t of phase.tools) { const last = cells[cells.length - 1]; if (last && last.t === t) last.n++; else cells.push({ t, n: 1 }); }
  return (
    <div className="phase">
      <div className="ph">
        <div className="idx">{index + 1}</div>
        <div className="lbl" title={phase.label}>{phase.label}</div>
        <div className="st">{phase.turns}t · {fmtTokens(phase.out)} out{phase.skills ? ` · ◆${phase.skills}` : ""}{phase.agents ? ` · ▲${phase.agents}` : ""}</div>
      </div>
      {cells.length > 0 && (
        <div className="strip">
          {cells.map((c, i) => (
            <span key={i} className="cell" style={{ background: CATEGORY_COLOR[catOf(c.t)] }} title={`${c.t} ×${c.n}`}>{c.t}{c.n > 1 ? ` ·${c.n}` : ""}</span>
          ))}
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 3b: Extract the turn tree into `turnTree.tsx`**

Move `Turn` (lines 92-112), `Span` (114-119), `ToolCall` (121-144), `summarize` (147-153) and its `firstLine` helper (155-158) **verbatim** out of `TranscriptViewer.tsx` into a new `turnTree.tsx`, keeping their `export`s and the `fmtTokens`/`relTime` imports they use. In `TranscriptViewer.tsx`, delete those definitions and add `import { Turn, Span, summarize } from "./turnTree.js";` (only what it still references). In `TranscriptDiff.tsx:9`, change `from "./TranscriptViewer.js"` to `from "./turnTree.js"`. Run `pnpm --filter @agentgem/console exec tsc --noEmit` — expect clean (pure move, no behavior change).

- [ ] **Step 4: Write `StructureView.tsx`** (reuses `Turn` from `turnTree.js` for Transcript mode)

```tsx
// packages/console/src/panels/Observe/StructureView.tsx
import { useState } from "react";
import type { TranscriptView } from "../../api/routes.js";
import { phasesOf } from "./phases.js";
import { PhaseFlamestrip } from "./PhaseFlamestrip.js";
import { Turn } from "./turnTree.js";

export function StructureView({ view, collapsed, onToggle }: { view: TranscriptView; collapsed: Set<string>; onToggle: (id: string) => void }) {
  const [mode, setMode] = useState<"map" | "tx">("map");
  const phases = mode === "map" ? phasesOf(view) : [];
  return (
    <div className="obs sv">
      <div className="sv-head">
        <span className="t">What happened, in order</span>
        <div className="seg">
          <button type="button" className={mode === "map" ? "on" : ""} onClick={() => setMode("map")}>◆ Map</button>
          <button type="button" className={mode === "tx" ? "on" : ""} onClick={() => setMode("tx")}>≣ Transcript</button>
        </div>
      </div>
      <div className="sv-body">
        {mode === "map"
          ? phases.map((p, i) => <PhaseFlamestrip key={i} phase={p} index={i} />)
          : <ol className="tv-turns">{view.turns.map((turn) => (
              <Turn key={turn.id} turn={turn} startMs={view.meta.startMs} open={!collapsed.has(turn.id)} onToggle={() => onToggle(turn.id)} />
            ))}</ol>}
      </div>
    </div>
  );
}
```

In `TranscriptViewer.tsx`: replace the `<ol className="tv-turns">…</ol>` block (lines 80-87) with `<StructureView view={view} collapsed={collapsed} onToggle={toggle} />` and add `import { StructureView } from "./StructureView.js";`. The `collapsed`/`toggle`/`setAll` state stays in `TranscriptViewer` (Transcript mode still honors Expand/Collapse all). `Turn` now lives in `turnTree.js` (Step 3b), so no export-from-TranscriptViewer is needed.

- [ ] **Step 5: Add CSS + run tests**

Add `.sv*`, `.phase*`, `.strip`, `.cell`, `.seg` styles (from the mockup). Run:
`pnpm --filter @agentgem/console test -- StructureView` (PASS) and `pnpm --filter @agentgem/console exec tsc --noEmit` (clean).

- [ ] **Step 6: Commit**

```bash
git add packages/console/src/panels/Observe/turnTree.tsx packages/console/src/panels/Observe/PhaseFlamestrip.tsx packages/console/src/panels/Observe/StructureView.tsx packages/console/src/panels/Observe/StructureView.test.tsx packages/console/src/panels/Observe/TranscriptViewer.tsx packages/console/src/panels/Observe/TranscriptDiff.tsx packages/console/src/shell/theme.css
git commit -m "feat(console): Map⇄Transcript structure toggle in session view

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 8: Full-suite verification + manual check

**Files:** none (verification only)

- [ ] **Step 1: Run the full console suite** (catches hardcoded-count / snapshot tests)

Run: `pnpm --filter @agentgem/console test`
Expected: all green. Fix any count/snapshot tests your new components tripped.

- [ ] **Step 2: Run the root suite** (gates the server change in CI)

Run: `pnpm test` (root)
Expected: green, including `workflowScan.test`, `sessionHygiene.test`. If `dist/` is stale after edits, rebuild before trusting the run.

- [ ] **Step 3: Manual check via the run skill** (real session, real data)

Launch the console (`/run` or the project's app-launch skill), open History → a Claude session, and confirm: the context timeline renders with the verdict/factors/jumps rail; skill/subagent markers appear on the curve; the Map⇄Transcript toggle flips and Transcript still shows verbatim turns. Open a **Codex** session and confirm ① hides gracefully while ② Map still works.

- [ ] **Step 4: Commit any fixes, then open the PR**

```bash
git push -u origin feat/session-timeline-viz
gh pr create --title "feat(console): session timeline + structure map in History → Session" --body "$(cat <<'EOF'
Two lenses in the session detail view (TranscriptViewer): a context-window timeline (hygiene folded into a right rail, skill/subagent markers, ranked context jumps) and a Map⇄Transcript structure toggle. Adds an uncapped skill/subagent eventSeries to the scan, surfaced as events[] on /api/inspect/session/hygiene.

Spec: docs/superpowers/specs/2026-07-07-session-timeline-viz-design.md

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

Then follow the repo's PR lifecycle: `gh run watch <run-id> --exit-status`, merge `--rebase --delete-branch` once `test (24)`/`test (26)` are green, and verify each commit's content is on `origin/main` afterward.

---

## Deferred (not in this plan — from the spec)

- **Share/teach view ③** — a presentation-grade recap card; falls out of `phasesOf` + hero aggregates.
- **Prompt markers on the timeline** — user-prompt positions on the curve (phase boundaries already visible in ② Map).
- **Per-phase peak-context bar in ② Map** — needs `msgIndex` on `TranscriptView` turns to join the curve; ② stays pure-transcript (Codex-safe) without it.
- **Skill names in ② flamestrip cells** — the transcript route scrubs the Skill arg; names are surfaced in ① via `eventSeries` instead.
- **Jump-cause look-back window** — currently same-point attribution; a 1–2 turn look-back could better blame a Read that inflates the *next* turn.
