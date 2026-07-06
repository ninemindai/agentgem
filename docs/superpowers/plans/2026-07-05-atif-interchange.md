# ATIF Interchange (Import + Export) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** AgentGem reads and writes ATIF (Agent Trajectory Interchange Format, Harbor RFC 0001, v1.7) — an `atif` SourceSpec ingests dropped trajectory files into Observe/Watch/Inspect, and any Claude/Codex session exports as a scrubbed ATIF document over REST.

**Architecture:** A new `packages/insight/src/atif/` module holds pure types + import parsers + export builder, mirroring the observeScan/inspectSession split (metadata parser never keeps text; content paths scrub every string). A new `sources/atif.ts` SourceSpec registers in `BUILTIN_SOURCES` so Observe/Watch pick it up with zero app-layer changes; `loadSessionTranscript` gains an `atif` branch so Inspect drill-down works; one new `@get` route on `GemController` serves the export.

**Tech Stack:** TypeScript ESM (Node ≥24), Vitest, zod (AgentBack controller schemas). No new dependencies.

## Global Constraints

- Every content string that leaves a parser passes through `scrubText` (the secret-safe boundary — see `inspectSession.ts` header comment). Export reuses `TranscriptView`, which is already scrubbed.
- Total functions: malformed/missing input degrades to `null`/`[]`/skip — never throw (house contract of `observeScan.ts`).
- File headers: `// Copyright (c) 2026 NineMind, Inc.` + `// SPDX-License-Identifier: MIT` (copy from any existing source file).
- Tests live in `src/__tests__/` at the repo root and import the built package (`@agentgem/insight`), so every test run is `pnpm exec tsc -b && pnpm exec vitest run <file>` from the repo root.
- The ATIF drop directory is `join(agentgemHome(), "atif")` (`agentgemHome` from `@agentgem/model`); tests override via `SourceEnv.baseDir` pointing at a temp dir, following the gemini/continue pattern in `sources.ts`.

---

### Task 1: ATIF types + tolerant document parser

**Files:**
- Create: `packages/insight/src/atif/atifTypes.ts`
- Test: `src/__tests__/atif.test.ts` (new file, grows across tasks)

**Interfaces:**
- Consumes: nothing (pure types).
- Produces: `AtifTrajectory`, `AtifStep`, `AtifToolCall`, `AtifObservationResult`, `AtifContentPart`, `parseAtifDocument(text: string): AtifTrajectory | null`, `flattenAtifContent(m: string | AtifContentPart[] | undefined): string`. Later tasks import all of these from `./atifTypes.js`.

- [ ] **Step 1: Write the failing test**

```ts
// src/__tests__/atif.test.ts
// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
import { describe, it, expect } from "vitest";
import { parseAtifDocument, flattenAtifContent } from "@agentgem/insight";

const MIN_DOC = JSON.stringify({
  schema_version: "ATIF-v1.7",
  session_id: "sess-1",
  agent: { name: "harbor-agent", version: "1.0.0", model_name: "gemini-2.5-flash" },
  steps: [
    { step_id: 1, source: "user", message: "What is the price of GOOGL?", timestamp: "2026-07-01T10:00:00Z" },
    {
      step_id: 2, source: "agent", message: "Searching.", timestamp: "2026-07-01T10:00:05Z",
      tool_calls: [{ tool_call_id: "call_1", function_name: "financial_search", arguments: { ticker: "GOOGL" } }],
      observation: { results: [{ source_call_id: "call_1", content: "GOOGL is at $185.35" }] },
      metrics: { prompt_tokens: 1000, completion_tokens: 100, cached_tokens: 400 },
    },
  ],
  final_metrics: { total_prompt_tokens: 1120, total_completion_tokens: 124 },
});

describe("parseAtifDocument", () => {
  it("parses a minimal v1.x trajectory", () => {
    const doc = parseAtifDocument(MIN_DOC);
    expect(doc).not.toBeNull();
    expect(doc!.schema_version).toBe("ATIF-v1.7");
    expect(doc!.steps).toHaveLength(2);
    expect(doc!.steps[1].tool_calls?.[0].function_name).toBe("financial_search");
  });

  it("degrades to null on junk, wrong schema_version, or missing steps", () => {
    expect(parseAtifDocument("not json")).toBeNull();
    expect(parseAtifDocument(JSON.stringify({ schema_version: "OTHER-v1", agent: { name: "x", version: "1" }, steps: [] }))).toBeNull();
    expect(parseAtifDocument(JSON.stringify({ schema_version: "ATIF-v1.7", agent: { name: "x", version: "1" } }))).toBeNull();
  });

  it("flattens string and multimodal message content", () => {
    expect(flattenAtifContent("hello")).toBe("hello");
    expect(flattenAtifContent([{ type: "text", text: "a" }, { type: "image", source: { media_type: "image/png", path: "x.png" } }, { type: "text", text: "b" }])).toBe("a\nb");
    expect(flattenAtifContent(undefined)).toBe("");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /Users/rfeng/Projects/ninemind/agentgem && pnpm exec tsc -b 2>&1 | head -5`
Expected: compile FAILS — `@agentgem/insight` has no export `parseAtifDocument`.

- [ ] **Step 3: Write the implementation**

```ts
// packages/insight/src/atif/atifTypes.ts
// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
//
// ATIF (Agent Trajectory Interchange Format, Harbor RFC 0001) — the subset of
// the v1.x schema AgentGem consumes and emits. Import is tolerant: unknown
// fields ride along untyped, structural violations degrade to null (total-
// function contract, same as observeScan). Spec:
// https://github.com/harbor-framework/harbor/blob/main/rfcs/0001-trajectory-format.md

export interface AtifContentPart {
  type: "text" | "image";
  text?: string;
  source?: { media_type: string; path: string };
}

export interface AtifToolCall {
  tool_call_id: string;
  function_name: string;
  arguments: Record<string, unknown>;
  extra?: Record<string, unknown>;
}

export interface AtifObservationResult {
  source_call_id?: string;
  content?: string | AtifContentPart[];
  extra?: Record<string, unknown>;
}

export interface AtifStepMetrics {
  prompt_tokens?: number;
  completion_tokens?: number;
  cached_tokens?: number;
  cost_usd?: number;
  extra?: Record<string, unknown>;
}

export interface AtifStep {
  step_id: number;
  timestamp?: string;                 // ISO 8601
  source: "system" | "user" | "agent";
  model_name?: string;
  message: string | AtifContentPart[];
  reasoning_content?: string;
  tool_calls?: AtifToolCall[];
  observation?: { results: AtifObservationResult[] };
  metrics?: AtifStepMetrics;
  extra?: Record<string, unknown>;
}

export interface AtifTrajectory {
  schema_version: string;             // "ATIF-v1.7"
  session_id?: string;
  trajectory_id?: string;
  agent: { name: string; version: string; model_name?: string; extra?: Record<string, unknown> };
  steps: AtifStep[];
  notes?: string;
  final_metrics?: {
    total_prompt_tokens?: number;
    total_completion_tokens?: number;
    total_cached_tokens?: number;
    total_cost_usd?: number;
    total_steps?: number;
  };
  extra?: Record<string, unknown>;
}

/** Tolerant parse: null unless it is a JSON object with an ATIF schema_version,
 *  an agent block, and a steps array. Never throws. */
export function parseAtifDocument(text: string): AtifTrajectory | null {
  let doc: unknown;
  try { doc = JSON.parse(text); } catch { return null; }
  if (!doc || typeof doc !== "object" || Array.isArray(doc)) return null;
  const d = doc as Record<string, unknown>;
  if (typeof d.schema_version !== "string" || !d.schema_version.startsWith("ATIF-v")) return null;
  const agent = d.agent as Record<string, unknown> | undefined;
  if (!agent || typeof agent.name !== "string") return null;
  if (!Array.isArray(d.steps) || d.steps.length === 0) return null;
  return d as unknown as AtifTrajectory;
}

/** Flatten a message value (string | ContentPart[]) to one text string; image
 *  parts contribute nothing (paths may be sensitive and are not transcript text). */
export function flattenAtifContent(m: string | AtifContentPart[] | undefined): string {
  if (typeof m === "string") return m;
  if (Array.isArray(m)) {
    return m.map((p) => (p && p.type === "text" && typeof p.text === "string" ? p.text : "")).filter(Boolean).join("\n");
  }
  return "";
}
```

Then add to `packages/insight/src/index.ts` (after the `./sources/*` export block):

```ts
export * from "./atif/atifTypes.js";
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm exec tsc -b && pnpm exec vitest run src/__tests__/atif.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/insight/src/atif/atifTypes.ts packages/insight/src/index.ts src/__tests__/atif.test.ts
git commit -m "feat(insight): ATIF v1.7 types + tolerant document parser"
```

---

### Task 2: ATIF import — SessionStat metadata + live SessionEvents

**Files:**
- Create: `packages/insight/src/atif/atifImport.ts`
- Modify: `packages/insight/src/index.ts` (one export line)
- Test: `src/__tests__/atif.test.ts` (append)

**Interfaces:**
- Consumes: `parseAtifDocument`, `flattenAtifContent` (Task 1); `scrubText` from `../scrub.js`; `SessionStat` from `../observeAggregate.js`; `SessionEvent` from `../inspectSession.js`.
- Produces: `parseAtifMeta(text: string, path: string): SessionStat | null` (agent = `"atif"`; `startMs`/`endMs` are `0` when the trajectory has no timestamps — the SourceSpec backfills file mtime) and `atifSessionEvents(text: string, path: string): SessionEvent[]`.

- [ ] **Step 1: Write the failing tests (append to `src/__tests__/atif.test.ts`)**

```ts
import { parseAtifMeta, atifSessionEvents } from "@agentgem/insight";

describe("parseAtifMeta", () => {
  it("folds a trajectory into a SessionStat", () => {
    const s = parseAtifMeta(MIN_DOC, "/tmp/atif/sess-1.json");
    expect(s).toMatchObject({
      agent: "atif", sessionId: "sess-1", model: "gemini-2.5-flash",
      msgs: 2, tokensIn: 720, tokensOut: 124, tokensCache: 400,
    });
    expect(s!.startMs).toBe(Date.parse("2026-07-01T10:00:00Z"));
    expect(s!.endMs).toBe(Date.parse("2026-07-01T10:00:05Z"));
  });

  it("prefers trajectory_id over session_id, falls back to filename; 0-timestamps when absent", () => {
    const doc = JSON.parse(MIN_DOC);
    doc.trajectory_id = "traj-9";
    delete doc.steps[0].timestamp; delete doc.steps[1].timestamp;
    const s = parseAtifMeta(JSON.stringify(doc), "/tmp/atif/whatever.json");
    expect(s!.sessionId).toBe("traj-9");
    expect(s!.startMs).toBe(0);
    delete doc.trajectory_id; delete doc.session_id;
    expect(parseAtifMeta(JSON.stringify(doc), "/tmp/atif/fallback-name.json")!.sessionId).toBe("fallback-name");
  });

  it("sums per-step metrics when final_metrics is absent", () => {
    const doc = JSON.parse(MIN_DOC);
    delete doc.final_metrics;
    const s = parseAtifMeta(JSON.stringify(doc), "/tmp/x.json");
    expect(s).toMatchObject({ tokensIn: 600, tokensOut: 100, tokensCache: 400 }); // 1000-400, 100, 400
  });

  it("returns null for non-ATIF text", () => {
    expect(parseAtifMeta("{}", "/tmp/x.json")).toBeNull();
  });
});

describe("atifSessionEvents", () => {
  it("emits ordered message / tool_call / tool_result events", () => {
    const events = atifSessionEvents(MIN_DOC, "/tmp/atif/sess-1.json");
    const kinds = events.map((e) => e.span.kind);
    expect(kinds).toEqual(["message", "message", "tool_call", "tool_result"]);
    const call = events[2].span as { kind: "tool_call"; toolId: string | null; name: string; input: string };
    expect(call.name).toBe("financial_search");
    expect(call.toolId).toBe("call_1");
    const result = events[3].span as { kind: "tool_result"; toolId: string | null; output: string };
    expect(result.toolId).toBe("call_1");
    expect(result.output).toContain("185.35");
  });

  it("skips system steps and emits reasoning as an assistant message", () => {
    const doc = JSON.parse(MIN_DOC);
    doc.steps.unshift({ step_id: 0, source: "system", message: "sys prompt" });
    doc.steps[2].reasoning_content = "thinking about it";
    const events = atifSessionEvents(JSON.stringify(doc), "/tmp/x.json");
    expect(events.some((e) => e.span.kind === "message" && (e.span as { text: string }).text === "sys prompt")).toBe(false);
    expect(events.some((e) => e.span.kind === "message" && (e.span as { text: string }).text.includes("thinking about it"))).toBe(true);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm exec tsc -b 2>&1 | head -5`
Expected: FAIL — no export `parseAtifMeta`.

- [ ] **Step 3: Write the implementation**

```ts
// packages/insight/src/atif/atifImport.ts
// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
//
// ATIF trajectory → AgentGem session model. parseAtifMeta mirrors
// parseClaudeTranscript (metadata only, never keeps text); atifSessionEvents
// mirrors claudeSessionEvents (ordered, unfolded, every string scrubbed).
// Timestamps are optional in ATIF: absent → startMs/endMs are 0 and the
// SourceSpec scanner backfills file mtime (parsers are fs-free).
import { basename } from "node:path";
import { scrubText } from "../scrub.js";
import type { SessionStat } from "../observeAggregate.js";
import type { SessionEvent, SessionEventSpan } from "../inspectSession.js";
import { parseAtifDocument, flattenAtifContent, type AtifTrajectory, type AtifStep } from "./atifTypes.js";

const MAX_STR = 50_000; // same visible-truncation valve as inspectSession

function scrub(s: string): string {
  const out = scrubText(s);
  return out.length > MAX_STR ? out.slice(0, MAX_STR) + "\n…(truncated)" : out;
}

export function atifSessionId(doc: AtifTrajectory, path: string): string {
  return doc.trajectory_id ?? doc.session_id ?? basename(path).replace(/\.json$/, "");
}

function stepMs(step: AtifStep): number {
  const ts = typeof step.timestamp === "string" ? Date.parse(step.timestamp) : NaN;
  return Number.isNaN(ts) ? 0 : ts;
}

export function parseAtifMeta(text: string, path: string): SessionStat | null {
  const doc = parseAtifDocument(text);
  if (!doc) return null;
  let startMs = Infinity, endMs = -Infinity, msgs = 0;
  let sumIn = 0, sumOut = 0, sumCache = 0;
  for (const step of doc.steps) {
    const ms = stepMs(step);
    if (ms > 0) { startMs = Math.min(startMs, ms); endMs = Math.max(endMs, ms); }
    if (step.source !== "system") msgs++;
    const m = step.metrics;
    if (m) {
      const cached = m.cached_tokens ?? 0;
      sumIn += Math.max(0, (m.prompt_tokens ?? 0) - cached);
      sumOut += m.completion_tokens ?? 0;
      sumCache += cached;
    }
  }
  const fm = doc.final_metrics;
  // Cache falls back to the per-step sum even when final_metrics exists but
  // omits total_cached_tokens, and tokensIn is always net of that same cache
  // value — so "fresh input" means the same thing on both paths.
  const cache = fm?.total_cached_tokens ?? sumCache;
  const tokensIn = fm ? Math.max(0, (fm.total_prompt_tokens ?? 0) - cache) : sumIn;
  const tokensOut = fm?.total_completion_tokens ?? sumOut;
  const cwd = (doc.extra as Record<string, unknown> | undefined)?.cwd;
  return {
    agent: "atif",
    sessionId: atifSessionId(doc, path),
    project: typeof cwd === "string" ? basename(cwd) : null,
    cwd: typeof cwd === "string" ? cwd : null,   // SessionStat.cwd (repo-owner attribution parity)
    model: doc.agent.model_name ?? null,
    gitBranch: null,
    startMs: startMs === Infinity ? 0 : startMs,
    endMs: endMs === -Infinity ? 0 : endMs,
    msgs, tokensIn, tokensOut, tokensCache: cache,
  };
}

export function atifSessionEvents(text: string, path: string): SessionEvent[] {
  const doc = parseAtifDocument(text);
  if (!doc) return [];
  void path;
  const out: SessionEvent[] = [];
  let lastMs = 0;
  for (const step of doc.steps) {
    if (step.source === "system") continue;
    const ms = stepMs(step) || lastMs;
    lastMs = ms;
    const push = (span: SessionEventSpan) => out.push({ tsMs: ms, span });
    const role = step.source === "user" ? "user" as const : "assistant" as const;
    const txt = flattenAtifContent(step.message);
    if (txt.trim()) push({ kind: "message", role, text: scrub(txt) });
    if (typeof step.reasoning_content === "string" && step.reasoning_content.trim()) {
      push({ kind: "message", role: "assistant", text: scrub(step.reasoning_content) });
    }
    for (const call of step.tool_calls ?? []) {
      let input: string; try { input = JSON.stringify(call.arguments); } catch { input = String(call.arguments); }
      push({ kind: "tool_call", toolId: call.tool_call_id ?? null, name: call.function_name, input: scrub(input) });
    }
    for (const res of step.observation?.results ?? []) {
      push({ kind: "tool_result", toolId: res.source_call_id ?? null, output: scrub(flattenAtifContent(res.content)), error: false });
    }
  }
  return out;
}
```

Then add to `packages/insight/src/index.ts`:

```ts
export * from "./atif/atifImport.js";
```

- [ ] **Step 4: Run to verify pass**

Run: `pnpm exec tsc -b && pnpm exec vitest run src/__tests__/atif.test.ts`
Expected: PASS (all tests so far).

- [ ] **Step 5: Commit**

```bash
git add packages/insight/src/atif/atifImport.ts packages/insight/src/index.ts src/__tests__/atif.test.ts
git commit -m "feat(insight): ATIF import — SessionStat metadata + live SessionEvents"
```

---

### Task 3: ATIF TranscriptView + Inspect drill-down branch

**Files:**
- Create: `packages/insight/src/atif/atifView.ts`
- Modify: `packages/insight/src/inspectSession.ts` (extend `loadSessionTranscript`)
- Modify: `packages/insight/src/index.ts` (one export line)
- Test: `src/__tests__/atif.test.ts` (append)

**Interfaces:**
- Consumes: Task 1–2 exports; `TranscriptView`, `TranscriptTurn`, `TranscriptSpan`, `TokenBreakdown` from `../inspectSession.js`; `agentgemHome` from `@agentgem/model`; `listFiles` from `../observeScan.js`.
- Produces: `parseAtifTranscriptView(text: string, path: string): TranscriptView | null`; `atifDropDir(baseDir?: string): string`; `loadSessionTranscript(sessionId, agent, dirs?)` now also accepts `agent === "atif"` with new optional `dirs.atifDir`.

- [ ] **Step 1: Write the failing tests (append)**

```ts
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseAtifTranscriptView, loadSessionTranscript } from "@agentgem/insight";

describe("parseAtifTranscriptView", () => {
  it("builds turns with tool outputs paired onto tool_call spans", () => {
    const view = parseAtifTranscriptView(MIN_DOC, "/tmp/atif/sess-1.json");
    expect(view).not.toBeNull();
    expect(view!.agent).toBe("atif");
    expect(view!.sessionId).toBe("sess-1");
    expect(view!.turns).toHaveLength(2);
    const agentTurn = view!.turns[1];
    expect(agentTurn.role).toBe("assistant");
    const call = agentTurn.spans.find((s) => s.kind === "tool_call") as { kind: "tool_call"; name: string; output?: string };
    expect(call.name).toBe("financial_search");
    expect(call.output).toContain("185.35");
    expect(agentTurn.tokens).toEqual({ in: 600, out: 100, cache: 400 });
  });
});

describe("loadSessionTranscript (atif)", () => {
  it("resolves a dropped trajectory by sessionId", async () => {
    const dir = mkdtempSync(join(tmpdir(), "agentgem-atif-"));
    try {
      writeFileSync(join(dir, "sess-1.json"), MIN_DOC);
      const view = await loadSessionTranscript("sess-1", "atif", { atifDir: dir });
      expect(view?.sessionId).toBe("sess-1");
      expect(await loadSessionTranscript("nope", "atif", { atifDir: dir })).toBeNull();
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm exec tsc -b 2>&1 | head -5`
Expected: FAIL — no export `parseAtifTranscriptView`; `atifDir` not in `dirs` type.

- [ ] **Step 3: Write the implementation**

```ts
// packages/insight/src/atif/atifView.ts
// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
//
// ATIF trajectory → TranscriptView (the Inspect drill-down shape). One turn per
// non-system step; observation results pair onto tool_call spans by
// source_call_id (mirror of parseClaudeTranscriptView pass 1). Scrub boundary
// identical to atifImport.
import { join } from "node:path";
import { agentgemHome } from "@agentgem/model";
import { scrubText } from "../scrub.js";
import type { TranscriptSpan, TranscriptTurn, TranscriptView, TokenBreakdown } from "../inspectSession.js";
import { parseAtifDocument, flattenAtifContent, type AtifStep } from "./atifTypes.js";
import { parseAtifMeta } from "./atifImport.js";

const MAX_STR = 50_000;
function scrub(s: string): string {
  const out = scrubText(s);
  return out.length > MAX_STR ? out.slice(0, MAX_STR) + "\n…(truncated)" : out;
}

/** The drop directory the atif source scans: <agentgemHome>/atif (baseDir = test
 *  override pointing at an alternative drop dir directly). */
export function atifDropDir(baseDir?: string): string {
  return baseDir ?? join(agentgemHome(), "atif");
}

function stepTokens(step: AtifStep): TokenBreakdown {
  const m = step.metrics;
  if (!m) return { in: 0, out: 0, cache: 0 };
  const cache = m.cached_tokens ?? 0;
  return { in: Math.max(0, (m.prompt_tokens ?? 0) - cache), out: m.completion_tokens ?? 0, cache };
}

export function parseAtifTranscriptView(text: string, path: string): TranscriptView | null {
  const doc = parseAtifDocument(text);
  const meta = parseAtifMeta(text, path);
  if (!doc || !meta) return null;
  const turns: TranscriptTurn[] = [];
  let lastMs = meta.startMs;
  for (const step of doc.steps) {
    if (step.source === "system") continue;
    const role = step.source === "user" ? "user" as const : "assistant" as const;
    const ts = typeof step.timestamp === "string" ? Date.parse(step.timestamp) : NaN;
    const tsMs = Number.isNaN(ts) ? lastMs : ts;
    lastMs = tsMs;
    const spans: TranscriptSpan[] = [];
    const txt = flattenAtifContent(step.message);
    if (txt.trim()) spans.push({ kind: "message", role, text: scrub(txt) });
    if (typeof step.reasoning_content === "string" && step.reasoning_content.trim()) {
      spans.push({ kind: "message", role: "assistant", text: scrub(step.reasoning_content) });
    }
    const outputs = new Map<string, string>();
    for (const res of step.observation?.results ?? []) {
      if (typeof res.source_call_id === "string") outputs.set(res.source_call_id, flattenAtifContent(res.content));
    }
    for (const call of step.tool_calls ?? []) {
      let input: string; try { input = JSON.stringify(call.arguments); } catch { input = String(call.arguments); }
      const out = outputs.get(call.tool_call_id);
      spans.push({
        kind: "tool_call", name: call.function_name, input: scrub(input),
        ...(out !== undefined ? { output: scrub(out) } : {}),
      });
    }
    if (!spans.length) continue;
    turns.push({ id: `${meta.sessionId}-${step.step_id}`, role, tsMs, spans, tokens: stepTokens(step) });
  }
  return { sessionId: meta.sessionId, agent: "atif", meta, turns };
}
```

In `packages/insight/src/inspectSession.ts`, extend `loadSessionTranscript`. Change its signature line to:

```ts
export async function loadSessionTranscript(
  sessionId: string,
  agent: AgentId,
  dirs?: { claudeDir?: string; codexDir?: string; atifDir?: string },
): Promise<TranscriptView | null> {
```

and insert this branch immediately after the `const resolved = resolveDirs();` line (before the `if (agent === "claude")` block), with the imports `import { parseAtifTranscriptView, atifDropDir } from "./atif/atifView.js";` added at the top of the file:

```ts
  if (agent === "atif") {
    // Dropped trajectories: match by parsed id (trajectory_id ?? session_id ?? filename).
    for (const f of listFiles(dirs?.atifDir ?? atifDropDir(), ".json")) {
      let raw: string; try { raw = await readFile(f, "utf8"); } catch { continue; }
      const view = parseAtifTranscriptView(raw, f);
      if (view && view.sessionId === sessionId) return view;
    }
    return null;
  }
```

Then add to `packages/insight/src/index.ts`:

```ts
export * from "./atif/atifView.js";
```

- [ ] **Step 4: Run to verify pass**

Run: `pnpm exec tsc -b && pnpm exec vitest run src/__tests__/atif.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/insight/src/atif/atifView.ts packages/insight/src/inspectSession.ts packages/insight/src/index.ts src/__tests__/atif.test.ts
git commit -m "feat(insight): ATIF TranscriptView + Inspect drill-down branch"
```

---

### Task 4: `atif` SourceSpec registered in BUILTIN_SOURCES

**Files:**
- Create: `packages/insight/src/sources/atif.ts`
- Modify: `packages/insight/src/sources.ts` (import + add to `BUILTIN_SOURCES`)
- Modify: `packages/insight/src/index.ts` (one export line)
- Test: `src/__tests__/atif.test.ts` (append)

**Interfaces:**
- Consumes: `SourceSpec`, `SourceEnv` from `../sources.js`; `parseAtifMeta`, `atifSessionEvents` (Task 2); `atifDropDir` (Task 3); `listFiles` from `../observeScan.js`; `SessionStat` from `../observeAggregate.js`.
- Produces: `atifSource: SourceSpec` (`id: "atif"`) and `scanAtifSessions(files: string[]): Promise<SessionStat[]>`. `BUILTIN_SOURCES` now includes it — Observe/Watch/scanSessions pick it up with zero app changes (the `AgentSourcesComponent` in `src/gem/sourceRegistry.ts` maps over `BUILTIN_SOURCES`).

- [ ] **Step 1: Write the failing test (append)**

```ts
import { statSync } from "node:fs";
import { atifSource, BUILTIN_SOURCES, watchableSources } from "@agentgem/insight";

describe("atifSource", () => {
  it("is registered and watchable", () => {
    expect(BUILTIN_SOURCES.some((s) => s.id === "atif")).toBe(true);
    expect(watchableSources().some((s) => s.id === "atif")).toBe(true);
  });

  it("scans a drop dir and backfills mtime when the trajectory has no timestamps", async () => {
    const dir = mkdtempSync(join(tmpdir(), "agentgem-atif-src-"));
    try {
      const noTs = JSON.parse(MIN_DOC);
      delete noTs.steps[0].timestamp; delete noTs.steps[1].timestamp;
      writeFileSync(join(dir, "sess-1.json"), JSON.stringify(noTs));
      writeFileSync(join(dir, "junk.json"), "not a trajectory");
      const stats = await atifSource.scanSessions!(atifSource.roots({ baseDir: dir }));
      expect(stats).toHaveLength(1);
      const mtime = statSync(join(dir, "sess-1.json")).mtimeMs;
      expect(stats[0].startMs).toBeCloseTo(mtime, -2);
      expect(stats[0].endMs).toBeCloseTo(mtime, -2);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm exec tsc -b 2>&1 | head -5`
Expected: FAIL — no export `atifSource`.

- [ ] **Step 3: Write the implementation**

```ts
// packages/insight/src/sources/atif.ts
// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
//
// The ATIF drop-dir source: any *.json trajectory under ~/.agentgem/atif is a
// session. This is the interchange on-ramp — Harbor ships ATIF converters for
// Terminus-2, OpenHands, Mini-SWE-Agent, Gemini CLI, Claude Code, and Codex, so
// agents without a native SourceSpec arrive through this one. baseDir is the
// test override for the drop dir itself (gemini/continue pattern).
import { readFile } from "node:fs/promises";
import { statSync } from "node:fs";
import type { SourceSpec } from "../sources.js";
import type { SessionStat } from "../observeAggregate.js";
import { listFiles } from "../observeScan.js";
import { parseAtifMeta, atifSessionEvents } from "../atif/atifImport.js";
import { atifDropDir } from "../atif/atifView.js";

export async function scanAtifSessions(files: string[]): Promise<SessionStat[]> {
  const out: SessionStat[] = [];
  for (const f of files) {
    let text: string; try { text = await readFile(f, "utf8"); } catch { continue; }
    const s = parseAtifMeta(text, f);
    if (!s) continue;
    if (s.startMs === 0) {
      // Timestamps are optional in ATIF; the file's mtime is the honest fallback.
      let mtime = 0; try { mtime = statSync(f).mtimeMs; } catch { /* keep 0 */ }
      out.push({ ...s, startMs: mtime, endMs: mtime });
    } else out.push(s);
  }
  return out;
}

export const atifSource: SourceSpec = {
  id: "atif", label: "ATIF import", traits: { storage: "json" },
  roots: (env) => [atifDropDir(env.baseDir)],
  scanSessions: (roots) => scanAtifSessions(roots.flatMap((r) => listFiles(r, ".json"))),
  watchFiles: (roots) => roots.flatMap((r) => listFiles(r, ".json")),
  parseMeta: parseAtifMeta,
  // Trajectories carry no reconstructable HTML documents; events feed the live view.
  resolveArtifactPaths: () => [],
  detectEvents: atifSessionEvents,
};
```

In `packages/insight/src/sources.ts`: add the import after the cursor import (line ~21) and register it:

```ts
import { atifSource } from "./sources/atif.js";
```

and change the last line to:

```ts
export const BUILTIN_SOURCES: SourceSpec[] = [claudeSource, codexSource, clineSource, geminiSource, continueSource, cursorSource, atifSource];
```

Then add to `packages/insight/src/index.ts`:

```ts
export * from "./sources/atif.js";
```

- [ ] **Step 4: Run to verify pass, then run the whole suite for regressions**

Run: `pnpm exec tsc -b && pnpm exec vitest run src/__tests__/atif.test.ts`
Expected: PASS.
Run: `pnpm test`
Expected: PASS (existing `sources*`/`observe*` tests must not regress; `scanSessions` tolerates the new source because a missing drop dir yields an empty root via `listFiles`'s catch).

- [ ] **Step 5: Commit**

```bash
git add packages/insight/src/sources/atif.ts packages/insight/src/sources.ts packages/insight/src/index.ts src/__tests__/atif.test.ts
git commit -m "feat(insight): atif SourceSpec — drop-dir ingestion into Observe/Watch"
```

---

### Task 5: ATIF export — `sessionToAtif` + REST route

**Files:**
- Create: `packages/insight/src/atif/atifExport.ts`
- Modify: `packages/insight/src/index.ts` (one export line)
- Modify: `src/gem.controller.ts` (one schema + one route; schemas cluster near line 49, routes near line 387)
- Test: `src/__tests__/atif.test.ts` (append)

**Interfaces:**
- Consumes: `TranscriptView` from `../inspectSession.js`; `AtifTrajectory` types (Task 1); in the controller: `loadSessionTranscript` (already imported there) and `sessionToAtif` added to the existing `@agentgem/insight` import.
- Produces: `sessionToAtif(view: TranscriptView): AtifTrajectory`; route `GET /inspect/session/atif?id=<sessionId>&agent=<agentId>` returning the trajectory document.

- [ ] **Step 1: Write the failing tests (append)**

```ts
import { sessionToAtif, parseAtifTranscriptView as reparse } from "@agentgem/insight";

describe("sessionToAtif", () => {
  it("round-trips: view → ATIF → parseable trajectory with same session id and step count", () => {
    const view = parseAtifTranscriptView(MIN_DOC, "/tmp/atif/sess-1.json")!;
    const doc = sessionToAtif(view);
    expect(doc.schema_version).toBe("ATIF-v1.7");
    expect(doc.session_id).toBe("sess-1");
    expect(doc.steps.map((s) => s.step_id)).toEqual([1, 2]);       // sequential from 1
    expect(doc.steps[0].source).toBe("user");
    expect(doc.steps[1].tool_calls![0].function_name).toBe("financial_search");
    expect(doc.steps[1].observation!.results[0].content).toContain("185.35");
    expect(doc.final_metrics!.total_completion_tokens).toBe(124);  // from view.meta (parseAtifMeta of MIN_DOC)
    const rt = reparse(JSON.stringify(doc), "/tmp/rt.json");
    expect(rt!.turns).toHaveLength(view.turns.length);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm exec tsc -b 2>&1 | head -5`
Expected: FAIL — no export `sessionToAtif`.

- [ ] **Step 3: Write the implementation**

```ts
// packages/insight/src/atif/atifExport.ts
// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
//
// TranscriptView → ATIF v1.7 document. Built from the SCRUBBED view on purpose:
// the export inherits the secret-safe boundary, so a shared .atif.json never
// carries what the Inspect UI wouldn't show. One step per turn; tool outputs
// become observation.results correlated by synthesized call ids.
import type { TranscriptView } from "../inspectSession.js";
import type { AtifTrajectory, AtifStep, AtifToolCall, AtifObservationResult } from "./atifTypes.js";

export function sessionToAtif(view: TranscriptView): AtifTrajectory {
  const steps: AtifStep[] = [];
  let stepId = 0;
  for (const turn of view.turns) {
    stepId++;
    const texts: string[] = [];
    const toolCalls: AtifToolCall[] = [];
    const results: AtifObservationResult[] = [];
    let callSeq = 0;
    for (const span of turn.spans) {
      if (span.kind === "message") texts.push(span.text);
      else {
        const id = `call_${stepId}_${++callSeq}`;
        toolCalls.push({ tool_call_id: id, function_name: span.name, arguments: { input: span.input } });
        if (span.output !== undefined) {
          results.push({ source_call_id: id, content: span.output, ...(span.error ? { extra: { error: true } } : {}) });
        }
      }
    }
    const tokens = turn.tokens;
    steps.push({
      step_id: stepId,
      timestamp: new Date(turn.tsMs).toISOString(),
      source: turn.role === "user" ? "user" : "agent",
      message: texts.join("\n\n"),
      ...(toolCalls.length ? { tool_calls: toolCalls } : {}),
      ...(results.length ? { observation: { results } } : {}),
      ...(tokens.in + tokens.out + tokens.cache > 0
        ? { metrics: { prompt_tokens: tokens.in + tokens.cache, completion_tokens: tokens.out, cached_tokens: tokens.cache } }
        : {}),
    });
  }
  const m = view.meta;
  return {
    schema_version: "ATIF-v1.7",
    session_id: view.sessionId,
    agent: { name: view.agent, version: "0", ...(m.model ? { model_name: m.model } : {}) },
    steps,
    final_metrics: {
      total_prompt_tokens: m.tokensIn + m.tokensCache,
      total_completion_tokens: m.tokensOut,
      total_cached_tokens: m.tokensCache,
      total_steps: steps.length,
    },
  };
}
```

Then add to `packages/insight/src/index.ts`:

```ts
export * from "./atif/atifExport.js";
```

In `src/gem.controller.ts`: add `sessionToAtif` to the existing `@agentgem/insight` import list; add near the other Inspect schemas (line ~49):

```ts
const AtifTrajectorySchema = z.looseObject({
  schema_version: z.string(),
  session_id: z.string().optional(),
  agent: z.looseObject({ name: z.string(), version: z.string() }),
  steps: z.array(z.record(z.string(), z.unknown())),
});
```

(If the repo's zod version predates `z.looseObject`, use `z.object({...}).passthrough()` — match whichever appears elsewhere in this file.)

And add the route directly under the existing `inspectSession` handler (line ~392):

```ts
  @get("/inspect/session/atif", { query: InspectSessionQuerySchema, response: AtifTrajectorySchema })
  async inspectSessionAtif(input: { query: z.infer<typeof InspectSessionQuerySchema> }): Promise<z.infer<typeof AtifTrajectorySchema>> {
    const view = await loadSessionTranscript(input.query.id, input.query.agent);
    if (!view) throw new InvalidInputError(`No ${input.query.agent} session '${input.query.id}' found.`);
    return sessionToAtif(view) as z.infer<typeof AtifTrajectorySchema>;
  }
```

- [ ] **Step 4: Run to verify pass, then the full suite**

Run: `pnpm exec tsc -b && pnpm exec vitest run src/__tests__/atif.test.ts`
Expected: PASS.
Run: `pnpm test`
Expected: PASS (controller tests in `src/__tests__/*.controller.test.ts` unaffected — new route only).

- [ ] **Step 5: Commit**

```bash
git add packages/insight/src/atif/atifExport.ts packages/insight/src/index.ts src/gem.controller.ts src/__tests__/atif.test.ts
git commit -m "feat: ATIF export — sessionToAtif + GET /inspect/session/atif"
```

---

### Task 6: Docs

**Files:**
- Modify: `docs/concepts.md` (or `docs/architecture.md` — whichever documents sources; check both and pick the one listing inbound agents)

- [ ] **Step 1: Add a short "ATIF interchange" subsection** to the doc that lists inbound sources, stating: (a) drop `*.json` ATIF v1.x trajectories into `~/.agentgem/atif/` and they appear in Observe/Watch/Inspect as agent `atif`; (b) any session exports via `GET /api/inspect/session/atif?id=…&agent=…`; (c) exports are scrubbed (secret-safe) and carry `schema_version: ATIF-v1.7`; (d) link the spec: `https://github.com/harbor-framework/harbor/blob/main/rfcs/0001-trajectory-format.md`.

- [ ] **Step 2: Commit**

```bash
git add docs/
git commit -m "docs: ATIF interchange (drop-dir import + session export)"
```

---

## Self-review notes

- Spec coverage: import (SessionStat, events, TranscriptView, SourceSpec registration, Inspect branch), export (builder + route), docs — all tasked.
- Type consistency: `parseAtifMeta`/`atifSessionEvents` (Task 2) are consumed by Tasks 3–5 under those exact names; `atifDropDir` defined in Task 3 and consumed in Task 4; `SessionStat.agent` is the open `AgentId = string`, so `"atif"` needs no union change (verified in `observeAggregate.ts`).
- Known judgment calls an implementer may revisit: `z.looseObject` vs `.passthrough()` per the repo's zod version (noted inline in Task 5); the `docs/` target file in Task 6 is chosen at execution time.
