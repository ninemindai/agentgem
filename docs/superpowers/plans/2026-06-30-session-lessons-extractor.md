# Session Lessons Extractor (Gem Contributions #2) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make "✦ Distill this session" yield wins + lessons — add an LLM `distillSessionLessons` pass that distills `DistilledLesson[]` from one session, wire it into `POST /api/inspect/distill`, and render + save lessons in the viewer.

**Architecture:** A new `distillSessionLessons` mirrors `distillWorkflow` exactly (ACP Claude, plan-mode, shared-deadline timeout, degrade-to-empty, never-throws). A friction-seeded `SESSION_LESSONS` prompt returns `{lessons:[{body,importance}]}`; `validateSessionLessons` parses/scrubs and server-attaches coordinates-only provenance from the single session. The controller runs it in parallel with the skills distill. The console mirrors the schema + adds a lessons list with a "Save lesson" CTA to the shipped `POST /api/workflow/lesson`.

**Tech Stack:** TypeScript ESM (`.js` relative imports), Zod, @agentback REST + `@agentback/client`, React, vitest. Spec: `docs/superpowers/specs/2026-06-30-session-lessons-extractor-design.md`.

## Global Constraints

- **Base branch:** `feat/session-extractor`, already cut from `origin/main` (`7011fda`). Do not re-cut.
- **Git identity:** commits authored `Raymond Feng <raymond@ninemind.ai>`; end every commit message with `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`. Stage explicitly (`git add`), verify `git show --stat HEAD`.
- **ESM:** relative imports use `.js`; package imports extensionless. New `@agentgem/insight` exports flow through the existing barrel `packages/insight/src/index.ts` (it `export *`s every module incl. `acpRecommender.js`) — add `export * from "./sessionLessons.js";` (the one barrel edit, in Task 1).
- **Server tests run from compiled `dist/`:** `pnpm exec tsc -b` before `pnpm exec vitest run dist/...`. New server/insight tests live in `src/gem/__tests__/` (compile to `dist/gem/__tests__/`), import package barrels.
- **Console tests:** `pnpm --filter @agentgem/console test` (vitest+jsdom, no prior build needed); typecheck `pnpm --filter @agentgem/console typecheck`. Console regressions are NOT in root CI — run locally.
- **Privacy (hard):** the prompt receives only the scrubbed mission hint (`task`,`outcome`) + the scrubbed verb spine (`step.verb`) — never raw transcript text. The LLM-returned lesson `body` is re-scrubbed via `sanitizeShareText` before becoming a `DistilledLesson`. Provenance is **server-attached** (sessionId/transcript/msgIndex from the one session) — never taken from the LLM.
- **Degrade, never throw:** agent error/timeout/junk → `{ lessons: [], degraded: true }`. No mission hint → `{ lessons: [], degraded: false }` (agent not invoked). Malformed JSON → `[]`.
- **Surgical:** `src/gem.controller.ts` + `TranscriptViewer.tsx` are actively moved by a concurrent Inspect effort — minimal diffs, no reformatting.

---

### Task 1: `distillSessionLessons` + prompt + validation (insight)

**Files:**
- Create: `packages/insight/src/sessionLessons.ts`
- Modify: `packages/insight/src/index.ts` (add `export * from "./sessionLessons.js";`)
- Test: `src/gem/__tests__/sessionLessons.test.ts` (create)

**Interfaces:**
- Consumes: `WorkflowSignal`, `SessionSequence` (`./workflowScan.js`); `DistilledLesson`, `lessonSlug` (`./distillTypes.js`); `sanitizeShareText` (`./scrub.js`); ACP seam `AcpConnectFn`, `CLAUDE_AGENT`, `analysisWorkspace`, `currentTestConnectFn`, `defaultConnectFn` (`./acpRecommender.js`); `ScanInventory` (the type `distillWorkflow` uses — import from `./extract.js` or wherever `distill.ts` imports it; match `distill.ts`'s import).
- Produces:
  - `distillSessionLessons(signal: WorkflowSignal, inv: ScanInventory, opts?: { connectFn?: AcpConnectFn; timeoutMs?: number }): Promise<{ lessons: DistilledLesson[]; degraded: boolean }>`
  - `validateSessionLessons(raw: unknown, session: SessionSequence, root: string): DistilledLesson[]`
  - `SESSION_LESSONS(missionJson: string, spineJson: string): string`

- [ ] **Step 1: Write the failing test**

Create `src/gem/__tests__/sessionLessons.test.ts`:

```ts
// src/gem/__tests__/sessionLessons.test.ts
import { describe, it, expect } from "vitest";
import { distillSessionLessons, validateSessionLessons } from "@agentgem/insight";
import type { WorkflowSignal, SessionSequence, AcpConnectFn } from "@agentgem/insight";

function sess(id: string, task: string | null): SessionSequence {
  const base: SessionSequence = {
    steps: [{ tool: "Bash", verb: "Bash:git commit", arg: "git commit", msgIndex: 4 }],
    sessionId: id, transcript: `${id}.jsonl`, atMs: 100,
  };
  return task === null ? base : { ...base, missionHint: { task, outcome: "fixed the flaky CI after 3 tries" } };
}
function signalWith(s: SessionSequence[]): WorkflowSignal {
  return { root: "/r", flavor: "claude", sessions: { scanned: s.length, firstMs: 0, lastMs: 0, spanDays: 0 },
    models: [], artifacts: [], unresolved: [], coOccurrence: [], shapes: [], notes: [], sequences: { root: "/r", sessions: s } };
}
// Fake agent: asserts plan mode before prompting, returns canned text.
function fakeConnect(canned: string): AcpConnectFn {
  return async () => ({ ctx: { async open(_cwd: string) { let mode = "default";
    return { async setMode(m: string) { mode = m; },
      async promptText(_t: string) { if (mode !== "plan") throw new Error(`expected plan, got ${mode}`); return canned; },
      dispose() {} }; } }, close() {} });
}
const inv = { project: { root: "/r", name: "app", skills: [], mcpServers: [], instructions: [], hooks: [] },
  global: { skills: [], mcpServers: [], hooks: [] } } as never;

describe("distillSessionLessons", () => {
  it("distills lessons from the agent response with server-attached provenance", async () => {
    const canned = JSON.stringify({ lessons: [
      { body: "Pin the flaky test's seed before debugging — randomness hid the real failure.", importance: "high" },
    ] });
    const { lessons, degraded } = await distillSessionLessons(signalWith([sess("a", "Fix flaky CI")]), inv, { connectFn: fakeConnect(canned) });
    expect(degraded).toBe(false);
    expect(lessons).toHaveLength(1);
    expect(lessons[0].status).toBe("draft");
    expect(lessons[0].importance).toBe("high");
    expect(lessons[0].name).toBe("pin-the-flaky-tests-seed-before-debugging");
    expect(lessons[0].evidence.sessions).toBe(1);
    expect(lessons[0].evidence.root).toBe("/r");
    expect(lessons[0].evidence.provenance.occurrences[0].sessionId).toBe("a");
    expect(lessons[0].evidence.provenance.occurrences[0].messageIndices).toEqual([4]);
    expect(JSON.stringify(lessons[0].evidence.provenance)).not.toContain("Pin the flaky"); // provenance carries no body text
  });
  it("re-scrubs a body the agent returns (no secret leaks into the lesson)", async () => {
    const canned = JSON.stringify({ lessons: [{ body: "Rotate the token sk-abcdefghijklmnop after the leak.", importance: "medium" }] });
    const { lessons } = await distillSessionLessons(signalWith([sess("a", "x")]), inv, { connectFn: fakeConnect(canned) });
    expect(lessons[0].body).not.toContain("sk-abcdefghijklmnop");
  });
  it("returns empty non-degraded when the session has no mission hint (agent not invoked)", async () => {
    const r = await distillSessionLessons(signalWith([sess("a", null)]), inv, {
      connectFn: async () => { throw new Error("should not be called"); } });
    expect(r).toEqual({ lessons: [], degraded: false });
  });
  it("degrades to empty on agent error", async () => {
    const r = await distillSessionLessons(signalWith([sess("a", "x")]), inv, { connectFn: async () => { throw new Error("no binary"); } });
    expect(r).toEqual({ lessons: [], degraded: true });
  });
  it("returns [] on malformed JSON (degraded — agent ran but produced junk)", async () => {
    const r = await distillSessionLessons(signalWith([sess("a", "x")]), inv, { connectFn: fakeConnect("not json") });
    expect(r).toEqual({ lessons: [], degraded: true });
  });
});

describe("validateSessionLessons", () => {
  const s = sess("a", "x");
  it("de-duplicates colliding lesson names", () => {
    const raw = { lessons: [{ body: "Same lesson text.", importance: "high" }, { body: "Same lesson text.", importance: "medium" }] };
    const out = validateSessionLessons(raw, s, "/r");
    expect(out.map((l) => l.name)).toEqual(["same-lesson-text", "same-lesson-text-2"]);
  });
  it("defaults a missing/invalid importance to medium and drops empty bodies", () => {
    const raw = { lessons: [{ body: "Keep it.", importance: "bogus" }, { body: "   " }] };
    const out = validateSessionLessons(raw, s, "/r");
    expect(out).toHaveLength(1);
    expect(out[0].importance).toBe("medium");
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm exec tsc -b && pnpm exec vitest run dist/gem/__tests__/sessionLessons.test.js`
Expected: FAIL — `distillSessionLessons`/`validateSessionLessons` not exported.

- [ ] **Step 3: Implement `sessionLessons.ts`**

Create `packages/insight/src/sessionLessons.ts`. Mirror `distill.ts`'s `distillWorkflow` structure (shared-deadline timeout, plan mode, degrade). Use the SAME `ScanInventory` import source as `distill.ts` (open `distill.ts` and copy its `ScanInventory` import line verbatim).

```ts
// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
// packages/insight/src/sessionLessons.ts
//
// LLM distillation of LESSONS from ONE session (the "✦ Distill this session"
// companion to distillWorkflow's skills). Single sessions can't yield lessons via
// the recurrence reflection path (needs ≥3 sessions), so a meaningful session's
// lessons come from the agent reading it. Friction-seeded: the prompt first names
// what was hard, then distills the durable lesson. Mirrors distillWorkflow:
// ACP Claude / plan mode / shared deadline / degrade-to-empty / never throws.
// Provenance is server-attached (coordinates only); the agent supplies only text.
import type { WorkflowSignal, SessionSequence, ScanInventory } from "./workflowScan.js"; // same source distill.ts uses
import type { DistilledLesson, Occurrence, Provenance } from "./distillTypes.js";
import { lessonSlug } from "./distillTypes.js";
import { sanitizeShareText } from "./scrub.js";
import {
  type AcpConnectFn, CLAUDE_AGENT, analysisWorkspace, currentTestConnectFn, defaultConnectFn,
} from "./acpRecommender.js";

// Friction-seeded lessons prompt. One session's mission + redacted verb spine in;
// durable lessons out. Counts/coordinates are facts; never ask for provenance.
export const SESSION_LESSONS = (missionJson: string, spineJson: string): string =>
  `You are reviewing ONE coding-agent session to extract the durable LESSONS a ` +
  `developer should remember — the non-obvious gotchas, the things that went wrong ` +
  `and how they were resolved, what to do differently next time.\n` +
  `First identify the FRICTION (what was hard or surprising in this session), then ` +
  `distill each into a reusable lesson. Skip the routine; a lesson must be worth ` +
  `telling a teammate. Each lesson: one or two sentences, imperative, self-contained.\n` +
  `SESSION (mission = the user's goal + the final outcome; spine = the redacted ` +
  `ordered tool verbs):\nmission: ${missionJson}\nspine: ${spineJson}\n\n` +
  `Return ONLY JSON: {"lessons":[{"body":"...","importance":"high"|"medium"}]}. ` +
  `Return {"lessons":[]} if the session has no lesson worth sharing.`;

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return Promise.race([p, new Promise<T>((_, rej) => setTimeout(() => rej(new Error(`session-lessons agent timeout after ${ms}ms`)), ms))]);
}

// Locate a JSON object in possibly-fenced agent text (local copy — the established
// per-module pattern in distill.ts / facets.ts / acpRecommender.ts).
function extractJson(text: string): string {
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fence) return fence[1].trim();
  const a = text.indexOf("{"), b = text.lastIndexOf("}");
  return a >= 0 && b > a ? text.slice(a, b + 1) : text;
}

function provenanceOf(session: SessionSequence): Provenance {
  const occ: Occurrence = {
    sessionId: session.sessionId,
    transcript: session.transcript,
    messageIndices: session.steps.map((s) => s.msgIndex),
    atMs: session.atMs,
  };
  return { occurrences: [occ] };
}

export function validateSessionLessons(raw: unknown, session: SessionSequence, root: string): DistilledLesson[] {
  let obj: unknown = raw;
  if (typeof raw === "string") { try { obj = JSON.parse(extractJson(raw)); } catch { return []; } }
  const arr = (obj as { lessons?: unknown })?.lessons;
  if (!Array.isArray(arr)) return [];
  const provenance = provenanceOf(session);
  const out: DistilledLesson[] = [];
  const seen = new Map<string, number>();
  for (const item of arr) {
    const body0 = (item as { body?: unknown })?.body;
    if (typeof body0 !== "string" || !body0.trim()) continue;
    const body = sanitizeShareText(body0, 400);
    const imp = (item as { importance?: unknown })?.importance;
    const importance: DistilledLesson["importance"] = imp === "high" ? "high" : "medium";
    const base = lessonSlug(body);
    const n = seen.get(base) ?? 0; seen.set(base, n + 1);
    const name = n === 0 ? base : `${base}-${n + 1}`;
    out.push({ name, body, importance, status: "draft", evidence: { sessions: 1, root, provenance } });
  }
  return out;
}

/**
 * Distil durable lessons from ONE session via the agent. Never throws.
 * No mission hint → empty, non-degraded (agent not invoked). Agent error/junk →
 * empty, degraded:true (no single-session heuristic fallback exists).
 */
export async function distillSessionLessons(
  signal: WorkflowSignal,
  _inv: ScanInventory,
  opts: { connectFn?: AcpConnectFn; timeoutMs?: number } = {},
): Promise<{ lessons: DistilledLesson[]; degraded: boolean }> {
  const session = signal.sequences?.sessions?.[0];
  if (!session?.missionHint) return { lessons: [], degraded: false };
  const root = signal.sequences!.root;

  const connectFn = opts.connectFn ?? currentTestConnectFn() ?? defaultConnectFn;
  const timeoutMs = opts.timeoutMs ?? 60_000;
  let conn: { ctx: { open(cwd: string): Promise<{ setMode(m: string): Promise<void>; promptText(t: string): Promise<string>; dispose(): void }> }; close: () => void } | null = null;
  let handle: { setMode(m: string): Promise<void>; promptText(t: string): Promise<string>; dispose(): void } | null = null;
  try {
    const spine = session.steps.map((s) => s.verb);
    const prompt = SESSION_LESSONS(JSON.stringify(session.missionHint), JSON.stringify(spine));
    const deadline = Date.now() + timeoutMs;
    const left = () => Math.max(0, deadline - Date.now());
    conn = await withTimeout(connectFn(CLAUDE_AGENT, null), left());
    handle = await withTimeout(conn.ctx.open(analysisWorkspace()), left());
    await withTimeout(handle.setMode("plan"), left());
    const text = await withTimeout(handle.promptText(prompt), left());
    const lessons = validateSessionLessons(text, session, root);
    if (!lessons.length) return { lessons: [], degraded: true }; // agent ran, nothing usable
    return { lessons, degraded: false };
  } catch (err) {
    console.error("session-lessons: agent unavailable, no lessons:", (err as Error).message);
    return { lessons: [], degraded: true };
  } finally {
    try { handle?.dispose(); } catch { /* ignore */ }
    try { conn?.close(); } catch { /* ignore */ }
  }
}
```

Add to `packages/insight/src/index.ts` (with the other `export *` lines):

```ts
export * from "./sessionLessons.js";
```

**Grounded:** `ScanInventory` is exported from `./workflowScan.js` (confirmed — `distill.ts:8` imports it there); `Occurrence`/`Provenance` are exported from `./distillTypes.js` (lines 15/21).

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm exec tsc -b && pnpm exec vitest run dist/gem/__tests__/sessionLessons.test.js`
Expected: PASS (all cases).

- [ ] **Step 5: Commit**

```bash
git add packages/insight/src/sessionLessons.ts packages/insight/src/index.ts src/gem/__tests__/sessionLessons.test.ts
git commit -m "feat(insight): distillSessionLessons — LLM lesson distillation for one session

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 2: wire lessons into `POST /api/inspect/distill` (server)

**Files:**
- Modify: `src/gem.controller.ts` (extend `InspectDistillResponseSchema`; run `distillSessionLessons` in parallel; import it)
- Test: `src/gem/__tests__/inspectDistillLessons.test.ts` (create)

**Interfaces:**
- Consumes: `distillSessionLessons` (Task 1); `setConnectFnForTests` (`@agentgem/insight`, for the test); existing `DistilledLessonSchema` (already imported in the controller), `distillWorkflow`, `resolveClaudeSession`, `scanWorkflow`, `introspectAll`, `resolveProject`.
- Produces: `InspectDistillResponseSchema` gains `lessons: z.array(DistilledLessonSchema)`; `inspectDistill` returns `{ distilled, lessons, degraded }`.

- [ ] **Step 1: Write the failing test**

Create `src/gem/__tests__/inspectDistillLessons.test.ts`. The handler calls `distillSessionLessons` with no opts → it falls to `currentTestConnectFn()`, so install a stub via `setConnectFnForTests`. Build a real Claude transcript in a hermetic home (mirror `inspectSession.test.ts`'s fixture) so `resolveClaudeSession` + `scanWorkflow` find a missioned session.

```ts
// src/gem/__tests__/inspectDistillLessons.test.ts
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setConnectFnForTests, type AcpConnectFn } from "@agentgem/insight";
import { GemController } from "../../gem.controller.js";

let home: string, prevHome: string | undefined, prevAg: string | undefined;
const fakeConnect = (canned: string): AcpConnectFn => async () => ({
  ctx: { async open(_c: string) { let m = "default";
    return { async setMode(x: string) { m = x; }, async promptText(_t: string) { if (m !== "plan") throw new Error("mode"); return canned; }, dispose() {} }; } }, close() {} });

beforeAll(() => {
  home = mkdtempSync(join(tmpdir(), "idl-"));
  prevHome = process.env.HOME; prevAg = process.env.AGENTGEM_HOME;
  process.env.HOME = home; process.env.AGENTGEM_HOME = home;
  const proj = join(home, ".claude", "projects", "p"); mkdirSync(proj, { recursive: true });
  // A missioned Claude session: a user task + an assistant edit + a git commit (so the scan yields a mission hint + steps).
  writeFileSync(join(proj, "sess1.jsonl"), [
    JSON.stringify({ type: "user", uuid: "u1", cwd: home + "/work", timestamp: "2026-06-29T10:00:00.000Z", message: { role: "user", content: "fix the flaky CI test" } }),
    JSON.stringify({ type: "assistant", uuid: "a1", cwd: home + "/work", timestamp: "2026-06-29T10:00:05.000Z", message: { role: "assistant", content: [
      { type: "tool_use", id: "t1", name: "Edit", input: { file_path: "x.ts" } },
      { type: "tool_use", id: "t2", name: "Bash", input: { command: "git commit -m fix" } } ] } }),
    JSON.stringify({ type: "assistant", uuid: "a2", cwd: home + "/work", timestamp: "2026-06-29T10:01:00.000Z", message: { role: "assistant", content: "Fixed — pinned the seed." } }),
  ].join("\n") + "\n");
  mkdirSync(join(home, "work"), { recursive: true });
});
afterAll(() => { if (prevHome === undefined) delete process.env.HOME; else process.env.HOME = prevHome;
  if (prevAg === undefined) delete process.env.AGENTGEM_HOME; else process.env.AGENTGEM_HOME = prevAg;
  rmSync(home, { recursive: true, force: true }); });
beforeEach(() => setConnectFnForTests(fakeConnect(JSON.stringify({ lessons: [{ body: "Pin the flaky test seed first.", importance: "high" }] }))));
afterEach(() => setConnectFnForTests(null));

describe("POST /api/inspect/distill — lessons", () => {
  it("returns lessons alongside skills for a Claude session", async () => {
    const res = await new GemController().inspectDistill({ body: { id: "sess1", agent: "claude" } });
    expect(Array.isArray(res.distilled)).toBe(true);          // skills field intact
    expect(Array.isArray(res.lessons)).toBe(true);            // new lessons field
    expect(res.lessons.some((l) => l.name === "pin-the-flaky-test-seed-first")).toBe(true);
  });
});
```

*Note:* if the scan does not produce a mission hint from this fixture (mission needs the first user text + a last assistant text), adjust the transcript to match `inspectSession.test.ts`'s working shape. The assertion that matters: `res.lessons` exists and carries the canned lesson.

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm exec tsc -b && pnpm exec vitest run dist/gem/__tests__/inspectDistillLessons.test.js`
Expected: FAIL — `res.lessons` is `undefined` (schema/handler don't return it).

- [ ] **Step 3: Implement**

In `src/gem.controller.ts`:

Extend the response schema (line ~67):
```ts
const InspectDistillResponseSchema = z.object({ distilled: z.array(DistilledSkillSchema), lessons: z.array(DistilledLessonSchema), degraded: z.boolean() });
```

Add `distillSessionLessons` to the `@agentgem/insight` import that already brings in `distillWorkflow` (line ~188):
```ts
import { distillWorkflow, distillSessionLessons, type DistilledSkill } from "@agentgem/insight";
```

In the `inspectDistill` handler (line ~311-313), run both passes in parallel and merge degraded:
```ts
    const signal = scanWorkflow([found.path], scanInv, { retainSequences: true });
    const [distill, lessonsRes] = await Promise.all([
      distillWorkflow(signal, scanInv),
      distillSessionLessons(signal, scanInv),
    ]);
    return { distilled: distill.distilled, lessons: lessonsRes.lessons, degraded: distill.degraded || lessonsRes.degraded };
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm exec tsc -b && pnpm exec vitest run dist/gem/__tests__/inspectDistillLessons.test.js dist/gem/__tests__/inspectSession.test.js`
Expected: PASS (new lessons test + the existing inspectSession suite unregressed).

- [ ] **Step 5: Commit**

```bash
git add src/gem.controller.ts src/gem/__tests__/inspectDistillLessons.test.ts
git commit -m "feat(api): return distilled lessons from POST /api/inspect/distill

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 3: render + save lessons in the TranscriptViewer (console)

**Files:**
- Modify: `packages/console/src/api/routes.ts` (mirror `DistilledLessonSchema`; add `lessons` to `inspectDistillRoute` response; add `workflowLessonRoute`)
- Modify: `packages/console/src/panels/Observe/TranscriptViewer.tsx` (a `LessonCard` + render lessons in `DistillSection`)
- Test: `packages/console/src/panels/Observe/TranscriptViewer.test.tsx` (extend the existing distill test)

**Interfaces:**
- Consumes (server contract from Task 2): the distill response now has `lessons: DistilledLesson[]`; `POST /api/workflow/lesson` takes a `DistilledLesson`, returns `{ path }`.
- Produces (console): `DistilledLessonSchema` + `type DistilledLesson`; `inspectDistillRoute` response includes `lessons`; `workflowLessonRoute`.

- [ ] **Step 1: Write the failing test**

Extend `packages/console/src/panels/Observe/TranscriptViewer.test.tsx` — update the distill mock to include `lessons` and add a save assertion. Add inside the existing distill `describe` (mirror the skills test at lines ~60-79):

```ts
  it("renders distilled lessons and saves one via /api/workflow/lesson", async () => {
    const lesson = { name: "pin-the-seed", body: "Pin the flaky test seed first.", importance: "high", status: "draft",
      evidence: { sessions: 1, root: "/work/app", provenance: { occurrences: [] } } };
    vi.spyOn(routes.inspectSessionRoute, "call").mockResolvedValue(view); // `view` = the existing fixture sibling tests use
    vi.spyOn(routes.inspectDistillRoute, "call").mockResolvedValue({ distilled: [], lessons: [lesson], degraded: false });
    const saveSpy = vi.spyOn(routes.workflowLessonRoute, "call").mockResolvedValue({ path: "/work/app/.agentgem/distilled/lessons/pin-the-seed.md" });
    render(<TranscriptViewer apiBase="" agent="claude" sessionId="s1" onBack={vi.fn()} />);
    fireEvent.click(await screen.findByText(/Distill this session/));
    fireEvent.click(await screen.findByText("Save lesson"));
    await waitFor(() => expect(saveSpy).toHaveBeenCalledWith({ body: lesson }));
    await screen.findByText(/saved →/);
  });
```

*Note:* reuse whatever fixture/imports the existing distill test already sets up (e.g. `VIEW`, `routes`, `waitFor`); if the sibling test stubs `inspectSessionRoute` differently, match it. The point: the lessons list renders and "Save lesson" calls `workflowLessonRoute`.

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter @agentgem/console test -- TranscriptViewer`
Expected: FAIL — `workflowLessonRoute` undefined / no "Save lesson" element.

- [ ] **Step 3: Implement**

In `packages/console/src/api/routes.ts`, after `DistilledSkillSchema` (line ~430) add the lesson schema (mirror the server `DistilledLessonSchema`):
```ts
export const DistilledLessonSchema = z.object({
  name: z.string(), body: z.string(), importance: z.enum(["high", "medium"]), status: z.literal("draft"),
  evidence: z.object({ sessions: z.number(), root: z.string(), provenance: z.object({ occurrences: z.array(z.unknown()) }) }),
});
export type DistilledLesson = z.infer<typeof DistilledLessonSchema>;
```
Extend the `inspectDistillRoute` response (line ~433):
```ts
  response: z.object({ distilled: z.array(DistilledSkillSchema), lessons: z.array(DistilledLessonSchema), degraded: z.boolean() }),
```
Add the lesson save route (after `workflowDraftRoute`):
```ts
export const workflowLessonRoute = defineRoute("POST", "/api/workflow/lesson", {
  body: DistilledLessonSchema,
  response: z.object({ path: z.string() }),
});
```

In `TranscriptViewer.tsx`, extend the imports (add `workflowLessonRoute`, `type DistilledLesson`), add a `LessonCard` (mirror `DraftCard`), and render lessons in `DistillSection`:

```tsx
function LessonCard({ apiBase, lesson }: { apiBase: string; lesson: DistilledLesson }) {
  const [saved, setSaved] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const save = () => {
    setSaving(true); setErr(null);
    workflowLessonRoute.call(makeClient(apiBase), { body: lesson })
      .then((r) => setSaved(r.path)).catch((e) => setErr(String(e?.message ?? e))).finally(() => setSaving(false));
  };
  return (
    <div className="tv-draft">
      <div className="tv-draft-head">
        <span className="tv-draft-name">{lesson.name}</span>
        <span className="obs-chip">{lesson.importance}</span>
        {saved
          ? <span className="obs-muted tv-draft-saved">saved → {saved}</span>
          : <button type="button" className="obs-open-transcript" onClick={save} disabled={saving}>{saving ? "Saving…" : "Save lesson"}</button>}
      </div>
      <p className="tv-draft-desc">{lesson.body}</p>
      {err && <span className="obs-error tv-distill-note">{err}</span>}
    </div>
  );
}
```

Add lessons state + render in `DistillSection`: add `const [lessons, setLessons] = useState<DistilledLesson[]>([]);`, set it in the `.then` (`setLessons(r.lessons);`), and render after the drafts map:
```tsx
      {lessons.map((l) => <LessonCard key={l.name} apiBase={apiBase} lesson={l} />)}
      {state === "done" && drafts.length === 0 && lessons.length === 0 && (
        <span className="obs-muted tv-distill-note">No distillable procedure or lesson found in this session.</span>
      )}
```
(Replace the existing `drafts.length === 0` empty-state line with the combined one above so it doesn't show when only lessons exist.)

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm --filter @agentgem/console test -- TranscriptViewer && pnpm --filter @agentgem/console typecheck`
Expected: PASS + typecheck clean.

- [ ] **Step 5: Commit**

```bash
git add packages/console/src/api/routes.ts packages/console/src/panels/Observe/TranscriptViewer.tsx packages/console/src/panels/Observe/TranscriptViewer.test.tsx
git commit -m "feat(console): render + save distilled session lessons in the viewer

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Final verification (after all tasks)

- `pnpm exec tsc -b` clean; the feature tests pass:
  `pnpm exec vitest run dist/gem/__tests__/sessionLessons.test.js dist/gem/__tests__/inspectDistillLessons.test.js`
- Console: `pnpm --filter @agentgem/console test` + `typecheck` green.
- Full root suite (`pnpm build` first, then `pnpm test`) — green except the known real-FS scan flakes and the console-must-be-built consoleMount test (build the console first).

## The loop this delivers

"✦ Distill this session" on a meaningful Claude session → `POST /api/inspect/distill` runs the skills distill AND `distillSessionLessons` in parallel → the viewer lists draft **skills** (Save draft → `/workflow/draft`) **and** draft **lessons** (Save lesson → `/workflow/lesson`). A meaningful session now yields **wins + lessons** — Playbook content, distilled by the LLM, friction-seeded, privacy-bounded.
