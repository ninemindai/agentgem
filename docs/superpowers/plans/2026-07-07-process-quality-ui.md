# Process-Quality UI Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Surface per-session process quality (score, label, stage profile, detector findings — computed by `summarizeSession`, already on `main`) as a card in the console's session drill-down.

**Architecture:** A thin REST route `GET /api/inspect/session/process` wraps the existing `summarizeSession` (verbatim clone of the `/inspect/session/hygiene` handler). A React card `ProcessQualityReport.tsx`, cloned from the sibling `HygieneReport.tsx`, auto-fetches that route and renders a score+label badge, a stage bar, and a findings list — mounted next to `HygieneReport` in `TranscriptViewer`.

**Tech Stack:** TypeScript ESM, `@agentback/openapi` (`@get`/zod) for the route, `@agentback/client` (`defineRoute`) for the client mirror, React 19 + `@testing-library/react` + Vitest (jsdom) for the card, Vitest for the controller.

## Global Constraints

- **Reuse `summarizeSession` as-is** — no new computation, no projection. The route returns the full `SessionSummary`; the card renders `process` + `findings`.
- **Claude-only** — the route guards `agent !== "claude"` → `InvalidInputError`; the card early-returns (`if (agent !== "claude") return null`) like `HygieneReport`. `summarizeSession`'s own deep analysis is Claude-spine only.
- **Secret-safe inherited** — `SessionSummary` carries only aggregates (score/label/counts/low-cardinality names); the route/card add no content. No extra assertion needed beyond what #139/#167 already test on `summarizeSession`.
- **Match the sibling patterns verbatim** — the route mirrors `inspectSessionHygiene` (`src/gem.controller.ts:445`); the client route mirrors `hygieneRoute` (`packages/console/src/api/routes.ts:503`); the card mirrors `HygieneReport.tsx` (auto-fetch, `alive` guard, Claude early-return).
- **File headers:** `// Copyright (c) 2026 NineMind, Inc.` + `// SPDX-License-Identifier: MIT` on new files (copy from any sibling).
- **App/controller tests** run via `pnpm exec tsc -b && pnpm exec vitest run <dist path>` (TS compiled to `dist/**/__tests__/**/*.test.js`). **Console tests** run via the console package's own jsdom Vitest: `pnpm --filter @agentgem/console exec vitest run src/panels/Observe/ProcessQualityReport.test.tsx`. Known baseline: the app suite has exactly ONE pre-existing failure (`consoleMount.test.js`) — unrelated; any OTHER failure is yours.
- **Worktree:** `/Users/rfeng/Projects/ninemind/agentgem.worktrees/feat-process-quality-ui` (branch `feat/process-quality-ui`, off `main`).

---

### Task 1: `GET /api/inspect/session/process` route

**Files:**
- Modify: `src/gem.controller.ts` (add schemas + route; import `summarizeSession`)
- Test: `src/__tests__/processRoute.controller.test.ts` (new)

**Interfaces:**
- Consumes (from `@agentgem/insight`): `summarizeSession(sessionId: string, agent: string, dirs?): Promise<SessionSummary | null>` where `SessionSummary` = `{ sessionId; agent; project: string|null; model: string|null; gitBranch: string|null; startMs; endMs; durationMs; msgs; tokensIn; tokensOut; tokensCache; process: { score: number; label: "disciplined"|"loose"|"chaotic"; stages: { exploration; implementation; verification; orchestration; other: number } } | null; findings: { id; title; advice; severity: "info"|"warn"; count; sessions: number }[]; events: {...} | null }`. Existing in-file: `InspectSessionQuerySchema` (`z.object({ id: z.string(), agent: z.string() })`, `gem.controller.ts:52`), `InvalidInputError`.
- Produces: the route method `inspectSessionProcess`, and `SessionSummarySchema` — Task 2's client route mirrors this schema exactly.

- [ ] **Step 1: Write the failing test**

```ts
// src/__tests__/processRoute.controller.test.ts
// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GemController } from "../gem.controller.js";
import { InvalidInputError } from "@agentgem/model";   // same class the controller throws — required for toBeInstanceOf

// summarizeSession scans the DEFAULT store: resolveDirs() reads $HOME, agentgemHome()
// reads AGENTGEM_HOME. Set BOTH to a fresh empty home and write a Claude session under it.
const saved = { home: process.env.HOME, agem: process.env.AGENTGEM_HOME };
const homes: string[] = [];
function newHome(): string {
  const h = mkdtempSync(join(tmpdir(), "agentgem-test-home-"));
  homes.push(h);
  process.env.HOME = h; process.env.AGENTGEM_HOME = h;
  return h;
}
function writeClaudeSession(home: string, sessionId: string): void {
  const projDir = join(home, ".claude", "projects", "proj"); mkdirSync(projDir, { recursive: true });
  const t = "2026-07-01T10:00:0";
  const lines = [
    { type: "user", cwd: "/repo", gitBranch: "main", timestamp: `${t}0Z`, message: { role: "user", content: "fix the bug" } },
    { type: "assistant", cwd: "/repo", timestamp: `${t}1Z`, message: { role: "assistant", model: "claude-opus-4-8",
      usage: { input_tokens: 100, output_tokens: 40 },
      content: [{ type: "tool_use", id: "u1", name: "Edit", input: { file_path: "/repo/a.ts", old_string: "x", new_string: "y" } }] } },
    { type: "user", cwd: "/repo", timestamp: `${t}2Z`, message: { role: "user", content: [{ type: "tool_result", tool_use_id: "u1", content: "ok" }] } },
    { type: "assistant", cwd: "/repo", timestamp: `${t}3Z`, message: { role: "assistant", model: "claude-opus-4-8",
      content: [{ type: "tool_use", id: "u2", name: "Bash", input: { command: "pnpm test" } }] } },
    { type: "user", cwd: "/repo", timestamp: `${t}4Z`, message: { role: "user", content: [{ type: "tool_result", tool_use_id: "u2", content: "1 passed" }] } },
  ];
  writeFileSync(join(projDir, `${sessionId}.jsonl`), lines.map((l) => JSON.stringify(l)).join("\n"));
}
afterEach(async () => {
  const { clearScanCache } = await import("@agentgem/insight");
  clearScanCache();
  if (saved.home === undefined) delete process.env.HOME; else process.env.HOME = saved.home;
  if (saved.agem === undefined) delete process.env.AGENTGEM_HOME; else process.env.AGENTGEM_HOME = saved.agem;
  for (const h of homes.splice(0)) rmSync(h, { recursive: true, force: true });
});

describe("GemController.inspectSessionProcess", () => {
  it("returns a SessionSummary with a populated process block for a Claude session", async () => {
    const home = newHome(); writeClaudeSession(home, "sess-1");
    const { clearScanCache } = await import("@agentgem/insight"); clearScanCache();
    const out = await new GemController().inspectSessionProcess({ query: { id: "sess-1", agent: "claude" } });
    expect(out.sessionId).toBe("sess-1");
    expect(out.process).not.toBeNull();
    expect(typeof out.process!.score).toBe("number");
    expect(["disciplined", "loose", "chaotic"]).toContain(out.process!.label);
    expect(out.process!.stages).toMatchObject({ implementation: expect.any(Number), verification: expect.any(Number) });
    expect(Array.isArray(out.findings)).toBe(true);
  });

  it("rejects a non-Claude agent with InvalidInputError", async () => {
    newHome();
    await expect(new GemController().inspectSessionProcess({ query: { id: "x", agent: "codex" } }))
      .rejects.toBeInstanceOf(InvalidInputError);
  });

  it("rejects an unknown session id with InvalidInputError", async () => {
    newHome();
    const { clearScanCache } = await import("@agentgem/insight"); clearScanCache();
    await expect(new GemController().inspectSessionProcess({ query: { id: "nope", agent: "claude" } }))
      .rejects.toBeInstanceOf(InvalidInputError);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `cd /Users/rfeng/Projects/ninemind/agentgem.worktrees/feat-process-quality-ui && pnpm exec tsc -b 2>&1 | head -5`
Expected: FAIL — `GemController` has no method `inspectSessionProcess`.

- [ ] **Step 3: Edit `src/gem.controller.ts`**

Add `summarizeSession` to the existing `@agentgem/insight` import on `src/gem.controller.ts:8` (currently `import { scanSessionsCached, aggregateObserve, loadSessionTranscript, resolveClaudeSession, dehomeDistilled, scrubText, sessionToAtif } from "@agentgem/insight";` — append `summarizeSession` to that list).

Add these schemas next to the other Inspect response schemas (near `HygieneReportSchema` at `gem.controller.ts:57`):
```ts
const StageProfileSchema = z.object({
  exploration: z.number(), implementation: z.number(), verification: z.number(),
  orchestration: z.number(), other: z.number(),
});
const DetectorSummarySchema = z.object({
  id: z.string(), title: z.string(), advice: z.string(),
  severity: z.enum(["info", "warn"]), count: z.number(), sessions: z.number(),
});
const SessionSummarySchema = z.object({
  sessionId: z.string(), agent: z.string(),
  project: z.string().nullable(), model: z.string().nullable(), gitBranch: z.string().nullable(),
  startMs: z.number(), endMs: z.number(), durationMs: z.number(),
  msgs: z.number(), tokensIn: z.number(), tokensOut: z.number(), tokensCache: z.number(),
  process: z.object({ score: z.number(), label: z.enum(["disciplined", "loose", "chaotic"]), stages: StageProfileSchema }).nullable(),
  findings: z.array(DetectorSummarySchema),
  events: z.object({
    toolCalls: z.array(z.object({ name: z.string(), count: z.number() })),
    filesTouched: z.number(), edits: z.number(), verifications: z.number(),
  }).nullable(),
});
```

Add the route method immediately after `inspectSessionHygiene` (`gem.controller.ts:445-454`):
```ts
  @get("/inspect/session/process", { query: InspectSessionQuerySchema, response: SessionSummarySchema })
  async inspectSessionProcess(input: { query: z.infer<typeof InspectSessionQuerySchema> }): Promise<z.infer<typeof SessionSummarySchema>> {
    if (input.query.agent !== "claude") throw new InvalidInputError("Process quality is available for Claude sessions only.");
    const summary = await summarizeSession(input.query.id, input.query.agent);
    if (!summary) throw new InvalidInputError(`No Claude session '${input.query.id}' found.`);
    return summary;
  }
```

- [ ] **Step 4: Run to verify pass, then the app-suite regression**

Run: `pnpm exec tsc -b && pnpm exec vitest run dist/__tests__/processRoute.controller.test.js`
Expected: PASS (3 tests).
Run: `pnpm exec vitest run dist/__tests__/gem.controller.test.js dist/__tests__/observe.controller.test.js`
Expected: PASS (the neighboring controller suites are unaffected by an added route).

- [ ] **Step 5: Commit**

```bash
git add src/gem.controller.ts src/__tests__/processRoute.controller.test.ts
git commit -m "feat(api): GET /inspect/session/process wraps summarizeSession"
```

---

### Task 2: Client route + ProcessQualityReport card

**Files:**
- Modify: `packages/console/src/api/routes.ts` (client route mirror)
- Create: `packages/console/src/panels/Observe/ProcessQualityReport.tsx`
- Create: `packages/console/src/panels/Observe/ProcessQualityReport.test.tsx`
- Modify: `packages/console/src/panels/Observe/TranscriptViewer.tsx` (mount the card)
- Modify: `packages/console/src/shell/theme.css` (`pq-*` classes)
- Modify: `docs/analyze.md` (mark the console-UI follow-up as built)

**Interfaces:**
- Consumes: Task 1's `SessionSummarySchema` shape (mirror it in the client); `defineRoute`/`makeClient` from `../../api/routes.js` (existing); the `HygieneReport` component pattern.
- Produces: `processRoute`, `SessionSummary` (client type), and the `ProcessQualityReport` component.

- [ ] **Step 1: Write the failing card test**

```tsx
// packages/console/src/panels/Observe/ProcessQualityReport.test.tsx
// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen } from "@testing-library/react";
import { ProcessQualityReport } from "./ProcessQualityReport.js";
import * as routes from "../../api/routes.js";

const sample = {
  sessionId: "sess-1", agent: "claude", project: "repo", model: "claude-opus-4-8", gitBranch: "main",
  startMs: 0, endMs: 1000, durationMs: 1000, msgs: 4, tokensIn: 100, tokensOut: 40, tokensCache: 0,
  process: { score: 70, label: "loose" as const, stages: { exploration: 1, implementation: 2, verification: 1, orchestration: 0, other: 0 } },
  findings: [{ id: "retry-storm", title: "Same command repeated back-to-back", advice: "Read output before re-running.", severity: "warn" as const, count: 1, sessions: 1 }],
  events: null,
};

afterEach(() => vi.restoreAllMocks());

describe("ProcessQualityReport", () => {
  it("renders the score, label, and a finding for a Claude session", async () => {
    vi.spyOn(routes.processRoute, "call").mockResolvedValue(sample as never);
    render(<ProcessQualityReport apiBase="/api" agent="claude" sessionId="sess-1" />);
    expect(await screen.findByText("70")).toBeInTheDocument();
    expect(await screen.findByText(/loose/i)).toBeInTheDocument();
    expect(await screen.findByText(/repeated back-to-back/i)).toBeInTheDocument();
  });

  it("shows a muted note when process is null", async () => {
    vi.spyOn(routes.processRoute, "call").mockResolvedValue({ ...sample, process: null, findings: [] } as never);
    render(<ProcessQualityReport apiBase="/api" agent="claude" sessionId="sess-1" />);
    expect(await screen.findByText(/no process data/i)).toBeInTheDocument();
  });

  it("renders nothing and does not fetch for a Codex session", () => {
    const spy = vi.spyOn(routes.processRoute, "call");
    const { container } = render(<ProcessQualityReport apiBase="/api" agent="codex" sessionId="sess-1" />);
    expect(container).toBeEmptyDOMElement();
    expect(spy).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `cd /Users/rfeng/Projects/ninemind/agentgem.worktrees/feat-process-quality-ui && pnpm --filter @agentgem/console exec vitest run src/panels/Observe/ProcessQualityReport.test.tsx 2>&1 | tail -8`
Expected: FAIL — cannot resolve `./ProcessQualityReport.js` / `routes.processRoute` undefined.

- [ ] **Step 3: Add the client route to `packages/console/src/api/routes.ts`**

Add immediately after the `hygieneRoute` block (`routes.ts:503-507`):
```ts
// Mirrors the server SessionSummarySchema (src/gem.controller.ts) exactly.
export const SessionSummarySchema = z.object({
  sessionId: z.string(), agent: z.string(),
  project: z.string().nullable(), model: z.string().nullable(), gitBranch: z.string().nullable(),
  startMs: z.number(), endMs: z.number(), durationMs: z.number(),
  msgs: z.number(), tokensIn: z.number(), tokensOut: z.number(), tokensCache: z.number(),
  process: z.object({ score: z.number(), label: z.enum(["disciplined", "loose", "chaotic"]),
    stages: z.object({ exploration: z.number(), implementation: z.number(), verification: z.number(), orchestration: z.number(), other: z.number() }) }).nullable(),
  findings: z.array(z.object({ id: z.string(), title: z.string(), advice: z.string(), severity: z.enum(["info", "warn"]), count: z.number(), sessions: z.number() })),
  events: z.object({ toolCalls: z.array(z.object({ name: z.string(), count: z.number() })), filesTouched: z.number(), edits: z.number(), verifications: z.number() }).nullable(),
});
export const processRoute = defineRoute("GET", "/api/inspect/session/process", {
  query: z.object({ id: z.string(), agent: z.enum(["claude", "codex"]) }),
  response: SessionSummarySchema,
});
export type SessionSummary = z.infer<typeof SessionSummarySchema>;
```

- [ ] **Step 4: Create `packages/console/src/panels/Observe/ProcessQualityReport.tsx`**

```tsx
// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
// packages/console/src/panels/Observe/ProcessQualityReport.tsx
//
// Per-session process-quality report (Inspect → Session): auto-fetches on
// session open and renders the AgentLens-style score/label, an intent-stage
// bar, and the fired detector findings. Claude-only, like HygieneReport — the
// underlying analysis reads the Claude tool-verb spine.
import { useEffect, useState } from "react";
import { processRoute, makeClient, type SessionSummary } from "../../api/routes.js";

const STAGE_KEYS = ["exploration", "implementation", "verification", "orchestration"] as const;

export function ProcessQualityReport({ apiBase, agent, sessionId }: { apiBase: string; agent: "claude" | "codex"; sessionId: string }) {
  const [sum, setSum] = useState<SessionSummary | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (agent !== "claude") return;
    let alive = true;
    setLoading(true); setError(null); setSum(null);
    processRoute.call(makeClient(apiBase), { query: { id: sessionId, agent } })
      .then((r) => { if (alive) setSum(r); })
      .catch((e) => { if (alive) setError(String(e?.message ?? e)); })
      .finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, [apiBase, agent, sessionId]);

  if (agent !== "claude") return null;

  return (
    <div className="obs pq">
      <div className="pq-head">Process quality</div>
      {loading && <div className="obs-muted">Analyzing…</div>}
      {error && <div className="obs-error">{error}</div>}
      {sum && !sum.process && <div className="obs-muted">No process data for this session.</div>}
      {sum && sum.process && (
        <>
          <div className={"pq-verdict is-" + sum.process.label}>
            <span className="pq-score">{sum.process.score}</span>
            <span className="pq-word">{sum.process.label}</span>
          </div>
          <StageBar stages={sum.process.stages} />
          {sum.findings.length > 0 ? (
            <ul className="pq-factors">
              {sum.findings.map((f) => (
                <li key={f.id}><b>{f.title}</b> <span className="obs-muted">×{f.count}</span><div className="obs-muted">{f.advice}</div></li>
              ))}
            </ul>
          ) : <div className="obs-muted">No process issues detected.</div>}
        </>
      )}
    </div>
  );
}

function StageBar({ stages }: { stages: NonNullable<SessionSummary["process"]>["stages"] }) {
  const total = STAGE_KEYS.reduce((n, k) => n + stages[k], 0);
  if (total === 0) return null;
  return (
    <div className="pq-stagebar" role="img" aria-label="Intent-stage mix">
      {STAGE_KEYS.map((k) => {
        const pct = (stages[k] / total) * 100;
        return pct > 0 ? <div key={k} className={"pq-stage is-" + k} style={{ width: `${pct}%` }} title={`${k}: ${stages[k]}`} /> : null;
      })}
    </div>
  );
}
```

- [ ] **Step 5: Mount the card in `TranscriptViewer.tsx`**

Add the import near the `HygieneReport` import:
```ts
import { ProcessQualityReport } from "./ProcessQualityReport.js";
```
In the render, add the card immediately after the `<HygieneReport … />` line (`TranscriptViewer.tsx:67`), before `<DistillSection>`:
```tsx
      <ProcessQualityReport apiBase={apiBase} agent={agent} sessionId={sessionId} />
```
(Use the same `apiBase`/`agent`/`sessionId` props already passed to `<HygieneReport>` on the line above — copy them verbatim.)

- [ ] **Step 6: Add `pq-*` styles to `packages/console/src/shell/theme.css`**

Append (mirrors the hygiene/scorecard visual language; label colors reuse the existing severity palette via `--accent`/`--muted`):
```css
.pq { margin-top: 12px; }
.pq-head { font-weight: 600; margin-bottom: 8px; }
.pq-verdict { display: inline-flex; align-items: baseline; gap: 8px; padding: 4px 10px; border-radius: 6px; border: 1px solid var(--line-2, #ddd); }
.pq-verdict .pq-score { font-size: 20px; font-weight: 700; }
.pq-verdict .pq-word { text-transform: capitalize; color: var(--muted); }
.pq-verdict.is-disciplined { border-color: #2e7d32; }
.pq-verdict.is-loose { border-color: #b8860b; }
.pq-verdict.is-chaotic { border-color: var(--accent, #9a3324); }
.pq-stagebar { display: flex; height: 8px; border-radius: 4px; overflow: hidden; margin: 10px 0; background: var(--line-2, #eee); }
.pq-stage { height: 100%; }
.pq-stage.is-exploration { background: #5b8def; }
.pq-stage.is-implementation { background: #2e7d32; }
.pq-stage.is-verification { background: #b8860b; }
.pq-stage.is-orchestration { background: #8a7f69; }
.pq-factors { list-style: none; padding: 0; margin: 8px 0 0; }
.pq-factors li { margin-bottom: 8px; }
```
(If any of `--line-2`/`--accent`/`--muted` isn't defined in `theme.css`, the CSS fallbacks in the values cover it — verify with `grep -n '\-\-accent\|\-\-muted\|\-\-line-2' packages/console/src/shell/theme.css`.)

- [ ] **Step 7: Run the card test + console suite**

Run: `pnpm --filter @agentgem/console exec vitest run src/panels/Observe/ProcessQualityReport.test.tsx`
Expected: PASS (3 tests).
Run: `pnpm --filter @agentgem/console exec vitest run src/panels/Observe/TranscriptViewer.test.tsx src/panels/Observe/HygieneReport.test.tsx`
Expected: PASS (mounting the card doesn't disturb the viewer or the sibling card).

- [ ] **Step 8: Update the docs follow-up note**

In `docs/analyze.md`, find the process-quality note that says surfacing the score in the console UI is a follow-up (search: `grep -n "follow-up proposal, not yet built" docs/analyze.md`). Update that sentence to state it is now shown as a **Process quality** card in the session drill-down (Inspect → Session), alongside the context-hygiene card. Keep it one sentence, matching the file's voice.

- [ ] **Step 9: Commit**

```bash
git add packages/console/src/api/routes.ts packages/console/src/panels/Observe/ProcessQualityReport.tsx packages/console/src/panels/Observe/ProcessQualityReport.test.tsx packages/console/src/panels/Observe/TranscriptViewer.tsx packages/console/src/shell/theme.css docs/analyze.md
git commit -m "feat(console): process-quality card in the session drill-down"
```

- [ ] **Step 10: Full-suite regression gate**

Run: `pnpm test`
Expected: the only failure is the known pre-existing `consoleMount.test.js`. Every other test — including the console jsdom suite — passes.

---

## Self-review notes

- **Spec coverage:** route + schema (Task 1) ✔; client route mirror, card, card test, TranscriptViewer mount, CSS, docs (Task 2) ✔. Testing per spec: controller test (Claude → process populated, non-Claude → 400, unknown id → 400) ✔; card test (score/label/finding render, `process:null` note, Codex no-fetch) ✔.
- **Type consistency:** `SessionSummarySchema` fields are identical between Task 1 (server) and Task 2 (client mirror); the card reads `process.score`/`process.label`/`process.stages` and `findings[].title`/`.count`/`.advice`, all present in the schema; `processRoute`/`inspectSessionProcess` names consistent across tasks and tests.
- **Known judgment calls for the implementer:** the exact current `@agentgem/insight` import line in `gem.controller.ts` (Task 1 Step 3 — grep first); whether `--line-2`/`--accent`/`--muted` exist in `theme.css` (Task 2 Step 6 — CSS fallbacks cover either way); the exact `HygieneReport` import line to place the new import beside (Task 2 Step 5).
- **Deliberately out of scope** (ratified in the spec): Sessions-list per-row score pills; project `atRiskRate` rollup.
