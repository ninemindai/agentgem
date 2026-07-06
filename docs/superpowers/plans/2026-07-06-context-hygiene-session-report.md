# Context-Hygiene Per-Session Report Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Surface the PR #153 context-hygiene engine in Inspect → Session — opening a Claude session auto-renders a bloat-curve + `bounded`/`mixed`/`bloated` verdict + fired-detector rows, all computed server-side by the real engine.

**Architecture:** A pure `buildHygieneReport(signal)` derives the report from a scanned `WorkflowSignal`; a thin `sessionHygiene(id, agent)` wraps it with the same resolve+scan setup `inspectDistill` already uses; a thin `@get("/inspect/session/hygiene")` controller delegates to it; a `HygieneReport.tsx` component (modeled exactly on the existing `DistillSection`) auto-fetches on session open and renders the report inline in `TranscriptViewer`. No threshold logic in the browser.

**Tech Stack:** TypeScript ESM, Zod route schemas (`@agentback/client` `defineRoute`), React (console), Vitest (`tsc -b && vitest run`, tests compiled to `dist/` and globbed from `dist/**/__tests__/**/*.test.js`).

## Global Constraints

- **Depends on PR #153** (`feat/context-hygiene-detectors`). This branch (`feat/context-hygiene-session-report`) is stacked on it; all of `contextCap`, `runDetectors`, `DETECTORS`, `hygieneScore`, `HygieneVerdict`, `TurnUsage`, `DetectorSummary`, `SessionSequence.contextSeries` are already exported from `@agentgem/insight`.
- **Copyright header** on every new `.ts`/`.tsx` file, verbatim: `// Copyright (c) 2026 NineMind, Inc.` / `// SPDX-License-Identifier: MIT` / `// <repo-relative path>`.
- **ESM import specifiers end in `.js`** even for `.ts`/`.tsx` sources.
- **Claude-only:** the endpoint rejects `agent !== "claude"` with `InvalidInputError("Context hygiene is available for Claude sessions only.")`; the UI omits the whole section for Codex.
- **Privacy:** the response carries `DetectorSummary` (counts/advice) + `TurnUsage` (integers) + a scrubbed transcript basename only — never an `arg`/path.
- **`grep -a`** when searching `packages/insight/src/workflowScan.ts` (control byte → grep skips it as binary).
- **Server tests** live in `src/gem/__tests__/` (IN CI). **Console tests** (`packages/console/src/**/*.test.tsx`) are NOT in CI — run locally with the console's own vitest.
- **Commit identity** Raymond Feng <raymond@ninemind.ai>, with the `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>` trailer.

---

## File Structure

- **Modify** `packages/insight/src/contextHygiene.ts` — export `HYGIENE_FACTOR_IDS`; redefine `assessesHygiene` in terms of it. (Task 1)
- **Modify** `packages/insight/src/rubricReport.ts` — `export` the existing module-private `summariesForSpecs`. (Task 1)
- **Create** `src/sessionHygieneCore.ts` — `HygieneReport` type, pure `buildHygieneReport(signal)`, thin `sessionHygiene(id, agent)`. (Task 2)
- **Modify** `src/gem.controller.ts` — `HygieneReportSchema` + `@get("/inspect/session/hygiene")`. (Task 3)
- **Modify** `packages/console/src/api/routes.ts` — mirrored `HygieneReportSchema`, `hygieneRoute`, `HygieneReport` type. (Task 4)
- **Create** `packages/console/src/panels/Observe/HygieneReport.tsx` — the component. (Task 4)
- **Modify** `packages/console/src/panels/Observe/TranscriptViewer.tsx:66` — render `<HygieneReport>` beside `<DistillSection>`. (Task 4)
- **Create** `src/gem/__tests__/sessionHygiene.test.ts` — server test (in CI). (Tasks 2, 3)
- **Create** `packages/console/src/panels/Observe/HygieneReport.test.tsx` — component test (local). (Task 4)

**Run commands** (repo root `/Users/rfeng/Projects/ninemind/agentgem`):
- Server single test: `tsc -b && npx vitest run dist/gem/__tests__/sessionHygiene.test.js`
- Full server suite: `npm test`
- Console tests (local): `cd packages/console && npx vitest run src/panels/Observe/HygieneReport.test.tsx`

---

## Task 1: Insight exports for reuse

**Files:**
- Modify: `packages/insight/src/contextHygiene.ts`
- Modify: `packages/insight/src/rubricReport.ts`
- Test: `src/gem/__tests__/sessionHygiene.test.ts` (create; Task 2 appends)

**Interfaces:**
- Produces: `export const HYGIENE_FACTOR_IDS: ReadonlySet<string>` (the five hygiene ids); `summariesForSpecs` becomes exported from `rubricReport.ts` (signature unchanged: `(specs: DetectorSpec[], findings: DetectorFinding[]) => DetectorSummary[]`).

- [ ] **Step 1: Write the failing test**

Create `src/gem/__tests__/sessionHygiene.test.ts`:

```ts
// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
// src/gem/__tests__/sessionHygiene.test.ts
import { describe, it, expect } from "vitest";
import { HYGIENE_FACTOR_IDS, summariesForSpecs, DETECTORS } from "@agentgem/insight";

describe("HYGIENE_FACTOR_IDS", () => {
  it("is exactly the five context-hygiene detector ids", () => {
    expect([...HYGIENE_FACTOR_IDS].sort()).toEqual(
      ["cache-churn-late", "context-pinned", "reread-churn", "task-pingpong", "task-sprawl"]);
  });
});

describe("summariesForSpecs (now exported)", () => {
  it("returns one row per spec with count 0 when unfired", () => {
    const specs = DETECTORS.filter((d) => HYGIENE_FACTOR_IDS.has(d.id));
    const rows = summariesForSpecs(specs, []);
    expect(rows).toHaveLength(5);
    expect(rows.every((r) => r.count === 0)).toBe(true);
    expect(rows.map((r) => r.id).sort()).toEqual([...HYGIENE_FACTOR_IDS].sort());
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `tsc -b && npx vitest run dist/gem/__tests__/sessionHygiene.test.js`
Expected: FAIL — `HYGIENE_FACTOR_IDS` and `summariesForSpecs` not exported.

- [ ] **Step 3: Write minimal implementation**

In `packages/insight/src/contextHygiene.ts`, replace the `WEIGHTS` map and `assessesHygiene` region. Find the current block with `grep -an "const WEIGHTS\|export function assessesHygiene" packages/insight/src/contextHygiene.ts`. Add the exported set right after the `WEIGHTS` declaration and redefine `assessesHygiene`:

```ts
// The five context-hygiene factor ids (the WEIGHTS keys), exported so consumers
// can filter DETECTORS / gate the hygiene verdict without re-listing them.
export const HYGIENE_FACTOR_IDS: ReadonlySet<string> = new Set(Object.keys(WEIGHTS));

export function assessesHygiene(summaries: DetectorSummary[]): boolean {
  return summaries.some((s) => HYGIENE_FACTOR_IDS.has(s.id));
}
```

Remove the previous `assessesHygiene` body (the `s.id in WEIGHTS` version) so there is exactly one definition.

In `packages/insight/src/rubricReport.ts`, add `export` to the existing `summariesForSpecs`. Confirm with `grep -an "function summariesForSpecs" packages/insight/src/rubricReport.ts`, then change `function summariesForSpecs(` to `export function summariesForSpecs(`.

- [ ] **Step 4: Run test to verify it passes**

Run: `tsc -b && npx vitest run dist/gem/__tests__/sessionHygiene.test.js`
Then confirm no regression in the PR #153 suites: `npx vitest run dist/gem/__tests__/contextHygiene.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/insight/src/contextHygiene.ts packages/insight/src/rubricReport.ts src/gem/__tests__/sessionHygiene.test.ts
git -c user.name="Raymond Feng" -c user.email="raymond@ninemind.ai" commit -m "feat(insight): export HYGIENE_FACTOR_IDS + summariesForSpecs for reuse

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 2: `sessionHygieneCore` — pure report builder + resolver wrapper

**Files:**
- Create: `src/sessionHygieneCore.ts`
- Test: `src/gem/__tests__/sessionHygiene.test.ts` (append)

**Interfaces:**
- Consumes: `HYGIENE_FACTOR_IDS`, `summariesForSpecs` (Task 1), and from `@agentgem/insight`: `scanWorkflow`, `runDetectors`, `DETECTORS`, `hygieneScore`, `contextCap`, `resolveClaudeSession`, and types `WorkflowSignal`, `TurnUsage`, `DetectorSummary`, `HygieneVerdict`, `ScanInventory`, `SessionSequence`; plus `introspectAll` (`@agentgem/capture`) and `resolveProject` (`@agentgem/model`).
- Produces:
  - `export interface HygieneReport { meta: { sessionId: string; transcript: string; model: string | null; cap: number }; curve: TurnUsage[]; factors: DetectorSummary[]; hygiene: HygieneVerdict }`
  - `export function buildHygieneReport(signal: WorkflowSignal): HygieneReport` — pure; derives everything from the first scanned session.
  - `export async function sessionHygiene(id: string, agent: string): Promise<HygieneReport>` — resolve + scan + build (the thin I/O wrapper the controller calls).

- [ ] **Step 1: Write the failing test** (append to `sessionHygiene.test.ts`)

`buildHygieneReport` lives in the app layer (`src/sessionHygieneCore.ts`), NOT the `@agentgem/insight` package — import it by relative path. From the compiled test at `dist/gem/__tests__/`, that path is `../../sessionHygieneCore.js`.

```ts
import { mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { scanWorkflow } from "@agentgem/insight";
import { buildHygieneReport } from "../../sessionHygieneCore.js";

const emptyInv = { project: { root: "/r", skills: [], mcpServers: [], hooks: [], instructions: [] }, global: { skills: [], mcpServers: [], hooks: [] } } as any;

function writeTranscript(dir: string, usages: Array<{ input: number; cacheRead: number; cacheCreate: number }>): string {
  const lines: string[] = [JSON.stringify({ sessionId: "sessH", type: "user", message: { role: "user", content: "do it" } })];
  usages.forEach((u, i) => lines.push(JSON.stringify({
    type: "assistant",
    message: {
      role: "assistant", model: "claude-opus-4-8[1m]",
      content: [{ type: "tool_use", name: "Read", input: { file_path: `packages/p${i}/f.ts` } }],
      usage: { input_tokens: u.input, cache_read_input_tokens: u.cacheRead, cache_creation_input_tokens: u.cacheCreate, output_tokens: 10 },
    },
  })));
  const p = join(dir, "sessH.jsonl");
  writeFileSync(p, lines.join("\n"));
  return p;
}

describe("buildHygieneReport", () => {
  it("derives curve, factors, and verdict from a scanned signal", () => {
    const dir = mkdtempSync(join(tmpdir(), "hyg-"));
    const path = writeTranscript(dir, [
      { input: 100, cacheRead: 400_000, cacheCreate: 2000 },
      { input: 100, cacheRead: 500_000, cacheCreate: 3000 },
    ]);
    const signal = scanWorkflow([path], emptyInv, { retainSequences: true });
    const rep = buildHygieneReport(signal);
    expect(rep.meta.model).toBe("claude-opus-4-8[1m]");
    expect(rep.meta.cap).toBe(1_000_000);
    expect(rep.curve).toHaveLength(2);
    expect(rep.curve[0].ctxTokens).toBe(402_100);      // 100 + 400000 + 2000
    expect(rep.factors).toHaveLength(5);               // one row per hygiene factor
    expect(rep.hygiene.verdict).toBe("bounded");       // short, un-pinned session
  });

  it("returns an empty curve and bounded verdict when the signal has no session", () => {
    const rep = buildHygieneReport({ root: "/r", flavor: "claude", sessions: { scanned: 0, firstMs: 0, lastMs: 0, spanDays: 0 }, models: [], artifacts: [], unresolved: [], coOccurrence: [], shapes: [], notes: [] } as any);
    expect(rep.curve).toEqual([]);
    expect(rep.factors).toHaveLength(5);
    expect(rep.hygiene.verdict).toBe("bounded");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `tsc -b && npx vitest run dist/gem/__tests__/sessionHygiene.test.js`
Expected: FAIL — `../../sessionHygieneCore.js` / `buildHygieneReport` does not exist.

- [ ] **Step 3: Write minimal implementation**

Create `src/sessionHygieneCore.ts`:

```ts
// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
// src/sessionHygieneCore.ts
//
// Per-session context-hygiene report: run the five hygiene detectors + score
// over one scanned transcript and shape the result for Inspect → Session. The
// scan/resolve setup mirrors inspectDistill; all detector logic and thresholds
// come from @agentgem/insight (no re-implementation here).
import {
  scanWorkflow, runDetectors, DETECTORS, hygieneScore, contextCap,
  HYGIENE_FACTOR_IDS, summariesForSpecs, resolveClaudeSession,
  type WorkflowSignal, type TurnUsage, type DetectorSummary, type HygieneVerdict,
} from "@agentgem/insight";
import { introspectAll } from "@agentgem/capture";
import { resolveProject } from "@agentgem/model";

export interface HygieneReport {
  meta: { sessionId: string; transcript: string; model: string | null; cap: number };
  curve: TurnUsage[];
  factors: DetectorSummary[];
  hygiene: HygieneVerdict;
}

export function buildHygieneReport(signal: WorkflowSignal): HygieneReport {
  const session = signal.sequences?.sessions?.[0];
  const model = session?.model ?? null;
  const specs = DETECTORS.filter((d) => HYGIENE_FACTOR_IDS.has(d.id));
  const factors = summariesForSpecs(specs, runDetectors(signal));
  return {
    meta: {
      sessionId: session?.sessionId ?? "",
      transcript: session?.transcript ?? "",
      model,
      cap: contextCap(model ?? undefined),
    },
    curve: session?.contextSeries ?? [],
    factors,
    hygiene: hygieneScore(factors),
  };
}

export async function sessionHygiene(id: string, agent: string): Promise<HygieneReport> {
  if (agent !== "claude") throw new Error("Context hygiene is available for Claude sessions only.");
  const found = await resolveClaudeSession(id);
  if (!found || !found.cwd) throw new Error(`No Claude session '${id}' found (or it has no recorded project).`);
  const inventory = introspectAll(undefined, [found.cwd]);
  const project = (inventory.projects ?? []).find((p) => p.root === resolveProject(found.cwd!));
  if (!project) throw new Error(`Project for session '${id}' not found in inventory.`);
  const scanInv = { project, global: { skills: inventory.skills, mcpServers: inventory.mcpServers, hooks: inventory.hooks } };
  const signal = scanWorkflow([found.path], scanInv, { retainSequences: true });
  return buildHygieneReport(signal);
}
```

> Note: `sessionHygiene` throws plain `Error`; the controller (Task 3) re-wraps the guard as `InvalidInputError` for a clean 400. `buildHygieneReport` is the unit-tested logic; `sessionHygiene` is thin I/O proven by the identical `inspectDistill` pattern.

- [ ] **Step 4: Run test to verify it passes**

Run: `tsc -b && npx vitest run dist/gem/__tests__/sessionHygiene.test.js`
Expected: PASS (4 tests total in the file now).

- [ ] **Step 5: Commit**

```bash
git add src/sessionHygieneCore.ts src/gem/__tests__/sessionHygiene.test.ts
git -c user.name="Raymond Feng" -c user.email="raymond@ninemind.ai" commit -m "feat(insight): sessionHygiene core — buildHygieneReport + resolver wrapper

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 3: Controller endpoint `GET /inspect/session/hygiene`

**Files:**
- Modify: `src/gem.controller.ts` (add schema near the other `Inspect*` schemas ~line 51; add handler after `inspectSessionAtif` ~line 414)
- Test: `src/gem/__tests__/sessionHygiene.test.ts` (append — schema round-trip)

**Interfaces:**
- Consumes: `sessionHygiene`, `buildHygieneReport`, `HygieneReport` (Task 2).
- Produces: `HygieneReportSchema` (a Zod schema whose `z.infer` structurally equals `HygieneReport`) and a `@get("/inspect/session/hygiene")` route reusing `InspectSessionQuerySchema`.

- [ ] **Step 1: Write the failing test** (append)

```ts
import { HygieneReportSchema } from "../../gem.controller.js";

describe("HygieneReportSchema", () => {
  it("accepts a buildHygieneReport output unchanged (server schema matches core shape)", () => {
    const dir = mkdtempSync(join(tmpdir(), "hyg2-"));
    const path = writeTranscript(dir, [{ input: 100, cacheRead: 400_000, cacheCreate: 2000 }]);
    const rep = buildHygieneReport(scanWorkflow([path], emptyInv, { retainSequences: true }));
    const parsed = HygieneReportSchema.parse(rep);
    expect(parsed).toEqual(rep);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `tsc -b && npx vitest run dist/gem/__tests__/sessionHygiene.test.js`
Expected: FAIL — `HygieneReportSchema` not exported from `gem.controller.ts`.

- [ ] **Step 3: Write minimal implementation**

In `src/gem.controller.ts`, add the schema near the other inspect schemas (after `InspectSessionQuerySchema`, ~line 55). Confirm imports: `sessionHygiene` and `HygieneReport` must be imported — add `import { sessionHygiene, type HygieneReport } from "./sessionHygieneCore.js";` near the other local-module imports.

```ts
export const HygieneReportSchema = z.object({
  meta: z.object({
    sessionId: z.string(), transcript: z.string(),
    model: z.string().nullable(), cap: z.number(),
  }),
  curve: z.array(z.object({
    turn: z.number(), msgIndex: z.number(),
    ctxTokens: z.number(), cacheCreation: z.number(), outTokens: z.number(),
  })),
  factors: z.array(z.object({
    id: z.string(), title: z.string(), advice: z.string(),
    severity: z.enum(["info", "warn"]), count: z.number(), sessions: z.number(),
  })),
  hygiene: z.object({ score: z.number(), verdict: z.enum(["bounded", "mixed", "bloated"]) }),
});
```

Add the handler after `inspectSessionAtif` (~line 414):

```ts
  @get("/inspect/session/hygiene", { query: InspectSessionQuerySchema, response: HygieneReportSchema })
  async inspectSessionHygiene(input: { query: z.infer<typeof InspectSessionQuerySchema> }): Promise<HygieneReport> {
    if (input.query.agent !== "claude") throw new InvalidInputError("Context hygiene is available for Claude sessions only.");
    try {
      return await sessionHygiene(input.query.id, input.query.agent);
    } catch (err) {
      throw new InvalidInputError((err as Error).message);
    }
  }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `tsc -b && npx vitest run dist/gem/__tests__/sessionHygiene.test.js`
Then the full server suite to confirm the new route didn't break controller wiring: `npm test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/gem.controller.ts src/gem/__tests__/sessionHygiene.test.ts
git -c user.name="Raymond Feng" -c user.email="raymond@ninemind.ai" commit -m "feat(console): GET /inspect/session/hygiene endpoint

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 4: Console route + `HygieneReport` component wired into TranscriptViewer

**Files:**
- Modify: `packages/console/src/api/routes.ts` (mirror schema + route + type; near `inspectSessionRoute` ~line 475)
- Create: `packages/console/src/panels/Observe/HygieneReport.tsx`
- Modify: `packages/console/src/panels/Observe/TranscriptViewer.tsx:66`
- Test: `packages/console/src/panels/Observe/HygieneReport.test.tsx` (local — not in CI)

**Interfaces:**
- Consumes: the `/api/inspect/session/hygiene` endpoint (Task 3).
- Produces: `hygieneRoute` + `HygieneReport` type (client), and a `<HygieneReport agent sessionId apiBase>` component rendered inline in `TranscriptViewer`.

- [ ] **Step 1: Write the failing test**

Create `packages/console/src/panels/Observe/HygieneReport.test.tsx`:

```tsx
// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
// packages/console/src/panels/Observe/HygieneReport.test.tsx
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { HygieneReport } from "./HygieneReport.js";
import * as routes from "../../api/routes.js";

const sample = {
  meta: { sessionId: "s1", transcript: "s1.jsonl", model: "claude-opus-4-8[1m]", cap: 1_000_000 },
  curve: [{ turn: 0, msgIndex: 1, ctxTokens: 402_100, cacheCreation: 2000, outTokens: 10 }],
  factors: [
    { id: "context-pinned", title: "Window pinned at the context cap", advice: "Cut earlier.", severity: "warn", count: 1, sessions: 1 },
    { id: "task-sprawl", title: "Many tasks in one session", advice: "Split them.", severity: "warn", count: 0, sessions: 0 },
  ],
  hygiene: { score: 78, verdict: "bounded" },
};

beforeEach(() => vi.restoreAllMocks());

describe("HygieneReport", () => {
  it("renders the verdict and the fired factor after auto-loading", async () => {
    vi.spyOn(routes.hygieneRoute, "call").mockResolvedValue(sample as any);
    render(<HygieneReport apiBase="/" agent="claude" sessionId="s1" />);
    expect(await screen.findByText(/bounded/i)).toBeTruthy();
    expect(await screen.findByText(/Window pinned/i)).toBeTruthy();      // fired factor shown
    expect(screen.queryByText(/Many tasks/i)).toBeNull();               // unfired factor collapsed
  });

  it("renders 'No context data' when the curve is empty", async () => {
    vi.spyOn(routes.hygieneRoute, "call").mockResolvedValue({ ...sample, curve: [] } as any);
    render(<HygieneReport apiBase="/" agent="claude" sessionId="s1" />);
    expect(await screen.findByText(/No context data/i)).toBeTruthy();
  });

  it("renders nothing for a Codex session (no fetch)", () => {
    const spy = vi.spyOn(routes.hygieneRoute, "call");
    const { container } = render(<HygieneReport apiBase="/" agent="codex" sessionId="s1" />);
    expect(container.firstChild).toBeNull();
    expect(spy).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/console && npx vitest run src/panels/Observe/HygieneReport.test.tsx`
Expected: FAIL — `./HygieneReport.js` and `routes.hygieneRoute` do not exist.

- [ ] **Step 3: Write minimal implementation**

In `packages/console/src/api/routes.ts`, after `inspectSessionRoute` (~line 475), mirror the server schema and add the route + type. Reuse the existing inspect query shape (the same `{ id, agent }` `inspectSessionRoute` uses):

```ts
export const HygieneReportSchema = z.object({
  meta: z.object({ sessionId: z.string(), transcript: z.string(), model: z.string().nullable(), cap: z.number() }),
  curve: z.array(z.object({ turn: z.number(), msgIndex: z.number(), ctxTokens: z.number(), cacheCreation: z.number(), outTokens: z.number() })),
  factors: z.array(z.object({ id: z.string(), title: z.string(), advice: z.string(), severity: z.enum(["info", "warn"]), count: z.number(), sessions: z.number() })),
  hygiene: z.object({ score: z.number(), verdict: z.enum(["bounded", "mixed", "bloated"]) }),
});
export const hygieneRoute = defineRoute("GET", "/api/inspect/session/hygiene", {
  query: z.object({ id: z.string(), agent: z.enum(["claude", "codex"]) }),
  response: HygieneReportSchema,
});
export type HygieneReport = z.infer<typeof HygieneReportSchema>;
```

Create `packages/console/src/panels/Observe/HygieneReport.tsx` (modeled on `DistillSection` — auto-fetch on mount, Claude-only, inline; the canvas is adapted from `mockups/context-bloat-report.html`'s hero):

```tsx
// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
// packages/console/src/panels/Observe/HygieneReport.tsx
import { useEffect, useRef, useState } from "react";
import { hygieneRoute, makeClient, type HygieneReport as Report } from "../../api/routes.js";

export function HygieneReport({ apiBase, agent, sessionId }: { apiBase: string; agent: "claude" | "codex"; sessionId: string }) {
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

  return (
    <div className="obs hyg">
      <div className="hyg-head">Context hygiene</div>
      {loading && <div className="obs-muted">Analyzing…</div>}
      {error && <div className="obs-error">{error}</div>}
      {rep && rep.curve.length === 0 && <div className="obs-muted">No context data for this session.</div>}
      {rep && rep.curve.length > 0 && (
        <>
          <div className={"hyg-verdict is-" + rep.hygiene.verdict}>
            <span className="hyg-score">{rep.hygiene.score}</span>
            <span className="hyg-word">{rep.hygiene.verdict}</span>
          </div>
          <BloatCurve curve={rep.curve} cap={rep.meta.cap} />
          <ul className="hyg-factors">
            {rep.factors.filter((f) => f.count > 0).map((f) => (
              <li key={f.id}><b>{f.title}</b> <span className="obs-muted">×{f.count}</span><div className="obs-muted">{f.advice}</div></li>
            ))}
          </ul>
          {rep.factors.every((f) => f.count === 0) && <div className="obs-muted">All {rep.factors.length} checks passed.</div>}
        </>
      )}
    </div>
  );
}

function BloatCurve({ curve, cap }: { curve: Report["curve"]; cap: number }) {
  const ref = useRef<HTMLCanvasElement | null>(null);
  useEffect(() => {
    const cv = ref.current; if (!cv) return;
    const ctx = cv.getContext("2d"); if (!ctx) return;
    const w = cv.width, h = cv.height, pad = 4;
    const css = (k: string) => getComputedStyle(document.documentElement).getPropertyValue(k).trim() || "#f0883e";
    const heat = css("--obs-accent");
    ctx.clearRect(0, 0, w, h);
    const N = curve.length;
    const X = (i: number) => pad + (w - 2 * pad) * (N > 1 ? i / (N - 1) : 0);
    const Y = (v: number) => h - pad - (h - 2 * pad) * Math.min(1, v / cap);
    ctx.beginPath(); ctx.moveTo(X(0), h - pad);
    curve.forEach((p, i) => ctx.lineTo(X(i), Y(p.ctxTokens)));
    ctx.lineTo(X(N - 1), h - pad); ctx.closePath();
    ctx.fillStyle = heat + "22"; ctx.fill();
    ctx.beginPath(); curve.forEach((p, i) => (i ? ctx.lineTo(X(i), Y(p.ctxTokens)) : ctx.moveTo(X(i), Y(p.ctxTokens))));
    ctx.strokeStyle = heat; ctx.lineWidth = 1.5; ctx.stroke();
    ctx.strokeStyle = css("--obs-muted") || "#888"; ctx.setLineDash([3, 3]);
    ctx.beginPath(); ctx.moveTo(pad, Y(cap)); ctx.lineTo(w - pad, Y(cap)); ctx.stroke(); ctx.setLineDash([]);
  }, [curve, cap]);
  return <canvas ref={ref} width={320} height={90} className="hyg-canvas" role="img" aria-label="Context size per turn" />;
}
```

In `packages/console/src/panels/Observe/TranscriptViewer.tsx`, add the import at the top and render the section beside `DistillSection`. Change line 66 from:

```tsx
      {view && <DistillSection apiBase={apiBase} agent={agent} sessionId={view.sessionId} turns={view.turns} />}
```

to (adding the import `import { HygieneReport } from "./HygieneReport.js";` near the other panel imports, and the component right after):

```tsx
      {view && <HygieneReport apiBase={apiBase} agent={agent} sessionId={view.sessionId} />}
      {view && <DistillSection apiBase={apiBase} agent={agent} sessionId={view.sessionId} turns={view.turns} />}
```

> Styling: add minimal rules for `.hyg`, `.hyg-verdict.is-bounded/.is-mixed/.is-bloated`, `.hyg-canvas`, `.hyg-factors` to the Observe panel's stylesheet (find it via `grep -rln "obs tv\|\.obs " packages/console/src/panels/Observe`), reusing the existing `--obs-accent`/`--obs-muted` tokens and the mockup's teal/amber/red for the three verdicts. Keep it consistent with the surrounding `DistillSection` styling.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd packages/console && npx vitest run src/panels/Observe/HygieneReport.test.tsx`
Expected: PASS (3 tests). Then typecheck the console: `cd packages/console && npx tsc -b`
Expected: no errors.

- [ ] **Step 5: Commit**

```bash
git add packages/console/src/api/routes.ts packages/console/src/panels/Observe/HygieneReport.tsx packages/console/src/panels/Observe/TranscriptViewer.tsx packages/console/src/panels/Observe/HygieneReport.test.tsx
# plus the Observe stylesheet you edited
git -c user.name="Raymond Feng" -c user.email="raymond@ninemind.ai" commit -m "feat(console): auto-loading context-hygiene report in Inspect → Session

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Final verification

- [ ] Server suite green: `npm test` (includes `sessionHygiene.test.js` + unaffected PR #153 + rubric suites).
- [ ] Console tests + typecheck green (local): `cd packages/console && npx vitest run src/panels/Observe/HygieneReport.test.tsx && npx tsc -b`.
- [ ] Manual smoke (optional): open the console, navigate `#/inspect/claude/<a real session id>`, confirm the Context hygiene section auto-renders a curve + verdict; open a Codex session and confirm the section is absent.

## Out of scope (later follow-ups)

- Built-in `context-hygiene` rubric + Rubrics-panel trigger (cross-session view).
- Live Watch-SSE break nudge + EMBER game.
- Tier-2 `session-boundary-judge`.
- Codex support.
