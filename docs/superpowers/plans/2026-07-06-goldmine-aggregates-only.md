# Goldmine Aggregates-Only Chat Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the one seam where raw transcript content enters the goldmine chat agent's context — replace the `get_session_transcript` raw-dump tool with a deterministic `summarize_session` aggregate and an `ask_session` tool that interrogates the raw transcript inside an ephemeral ACP subprocess (the session's own agent family), returning only the answer.

**Architecture:** Two new pure-testable `@agentgem/insight` modules — `sessionSummary.ts` (deterministic aggregate, reuses the PR #139 ProcessQuality/stage/detector primitives) and `sessionAsk.ts` (raw interrogation via the existing ACP façade, with an injectable connect-fn test seam). Two thin MCP tool adapters in `src/goldmine/mcpServer.ts`, the raw-dump tool removed, and a brief update in `goldmineContext.ts`.

**Tech Stack:** TypeScript ESM (Node ≥24), Vitest (app-level, compiled to `dist/**/__tests__/**/*.test.js`), zod (MCP tool input schemas via `@agentback/mcp`), the ACP client plumbing in `@agentgem/base`.

## Global Constraints

- **Secret-safe boundary:** `summarizeSession`'s output carries ONLY numbers, low-cardinality names (tool name, model, project basename, detector id/title/advice), and scores — never message text, thinking, tool input/output, or file paths (files are counted, not listed). Raw transcript content in `askSession` goes ONLY to the ACP subprocess prompt, never into the returned result beyond the subprocess's own answer.
- **Total functions:** every new function degrades to `null`/`[]`/`answered:false` and never throws (matches `behaviorFindings`/`acpRecommender` house contract).
- **Claude-only deep analysis:** process-quality/stage/detector analysis runs on the Claude tool-verb spine (as `behaviorFindings` does). Session *metrics* are multi-agent (from `SessionStat`). For non-Claude sessions, `summarizeSession` returns metrics with `process: null`, `events: null`, `findings: []`.
- **ACP routing:** session `agent` `"claude"` → `CLAUDE_AGENT` descriptor (`claude-code`); `"codex"` → the `codex` entry of `AGENTS`; any other source with no native ACP agent → `answered:false`. Runs on the user's own login (the ACP plumbing already strips API keys via `localAgentEnv`).
- **File headers:** `// Copyright (c) 2026 NineMind, Inc.` + `// SPDX-License-Identifier: MIT` (copy from any existing `packages/insight/src/*.ts`).
- **Tests** live in `src/__tests__/` (app level), import from `@agentgem/insight` / `@agentgem/base` by package specifier, and run via `pnpm exec tsc -b && pnpm exec vitest run <dist path>`. Known baseline: exactly ONE pre-existing failure (`dist/__tests__/consoleMount.test.js` boot-splash) — unrelated; any OTHER failure is yours.
- **Branch:** `feat/goldmine-aggregates-only`, stacked on `feat/atif-process-quality` (PR #139). Work in the worktree `/Users/rfeng/Projects/ninemind/agentgem.worktrees/feat-goldmine-aggregates-only`.

---

### Task 1: `summarizeSession` — deterministic per-session aggregate

**Files:**
- Create: `packages/insight/src/sessionSummary.ts`
- Modify: `packages/insight/src/index.ts` (one export line)
- Test: `src/__tests__/sessionSummary.test.ts`

**Interfaces:**
- Consumes (all from `@agentgem/insight`, exact signatures): `scanSessionsCached(nowMs, dirs?, refresh?) → Promise<SessionStat[]>`; `resolveClaudeSession(sessionId, dirs?) → Promise<{path,cwd}|null>`; `scanWorkflow(paths: string[], inv: ScanInventory, opts) → WorkflowSignal` with `signal.sequences?.sessions: SessionSequence[]`; `runDetectors(signal, extra?) → DetectorFinding[]`; `loadRuleDetectors(dir?) → DetectorSpec[]`; `DETECTORS`; `summarizeFindings(findings, specs?) → DetectorSummary[]`; `sessionProcessQuality(session, findings) → ProcessQuality` (`{sessionId,transcript,score,label,stages}`); `stageProfile(steps) → StageProfile`; `isEdit(s)/isVerify(s) → boolean`. Types: `SessionStat` (has `agent,sessionId,project,model,gitBranch,startMs,endMs,msgs,tokensIn,tokensOut,tokensCache`), `SessionSequence` (`{steps,sessionId,transcript,atMs,model?}`), `ProcedureStep extends {verb,arg}` (`{tool,msgIndex,verb,arg}`), `DetectorSummary`, `StageProfile` (`{exploration,implementation,verification,orchestration,other}`).
- Produces: `interface SessionSummary` and `summarizeSession(sessionId: string, agent: string, dirs?: { claudeDir?: string; codexDir?: string }): Promise<SessionSummary | null>`. Task 3 imports both.

- [ ] **Step 1: Write the failing tests**

Tests use `AGENTGEM_HOME` isolation (the house convention — `resolveDirs()`, the atif drop dir, and the default scan all derive from it), and call `summarizeSession` on the **production no-dirs path**. `clearScanCache` is essential in `afterEach` because the no-dirs scan is cached in a module singleton.

```ts
// src/__tests__/sessionSummary.test.ts
// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { summarizeSession, clearScanCache } from "@agentgem/insight";

// A Claude transcript is JSONL; filename (minus .jsonl) IS the sessionId. Minimal
// session: user msg, an Edit tool_use, a Bash "pnpm test" tool_use (verification),
// with tool_results. Written under <home>/.claude/projects/proj/.
function writeClaudeSession(home: string, sessionId: string): void {
  const projDir = join(home, ".claude", "projects", "proj");
  mkdirSync(projDir, { recursive: true });
  const t = "2026-07-01T10:00:0";
  const lines = [
    { type: "user", cwd: "/repo", gitBranch: "main", timestamp: `${t}0Z`, message: { role: "user", content: "fix the bug" } },
    { type: "assistant", cwd: "/repo", timestamp: `${t}1Z`, message: { role: "assistant", model: "claude-opus-4-8",
      usage: { input_tokens: 100, output_tokens: 40, cache_read_input_tokens: 10 },
      content: [{ type: "tool_use", id: "u1", name: "Edit", input: { file_path: "/repo/src/a.ts", old_string: "x", new_string: "y" } }] } },
    { type: "user", cwd: "/repo", timestamp: `${t}2Z`, message: { role: "user", content: [{ type: "tool_result", tool_use_id: "u1", content: "ok" }] } },
    { type: "assistant", cwd: "/repo", timestamp: `${t}3Z`, message: { role: "assistant", model: "claude-opus-4-8",
      content: [{ type: "tool_use", id: "u2", name: "Bash", input: { command: "pnpm test" } }] } },
    { type: "user", cwd: "/repo", timestamp: `${t}4Z`, message: { role: "user", content: [{ type: "tool_result", tool_use_id: "u2", content: "1 passed" }] } },
  ];
  writeFileSync(join(projDir, `${sessionId}.jsonl`), lines.map((l) => JSON.stringify(l)).join("\n"));
}

// An ATIF trajectory (non-Claude source, already on this branch) under <home>/atif/.
function writeAtifSession(home: string, sessionId: string): void {
  const atifDir = join(home, "atif"); mkdirSync(atifDir, { recursive: true });
  writeFileSync(join(atifDir, `${sessionId}.json`), JSON.stringify({
    schema_version: "ATIF-v1.7", session_id: sessionId,
    agent: { name: "harbor-agent", version: "1.0.0", model_name: "gemini-2.5-flash" },
    steps: [
      { step_id: 1, source: "user", message: "hello", timestamp: "2026-07-01T10:00:00Z", metrics: { prompt_tokens: 50, completion_tokens: 10 } },
      { step_id: 2, source: "agent", message: "hi", timestamp: "2026-07-01T10:00:05Z" },
    ],
  }));
}

const saved = process.env.AGENTGEM_HOME;
const homes: string[] = [];
function newHome(): string { const h = mkdtempSync(join(tmpdir(), "agentgem-home-")); homes.push(h); process.env.AGENTGEM_HOME = h; return h; }
afterEach(() => {
  if (saved === undefined) delete process.env.AGENTGEM_HOME; else process.env.AGENTGEM_HOME = saved;
  clearScanCache();
  for (const h of homes.splice(0)) rmSync(h, { recursive: true, force: true });
});

describe("summarizeSession", () => {
  it("computes a full Claude aggregate: metrics, process quality, stages, findings, events", async () => {
    const home = newHome(); writeClaudeSession(home, "sess-1"); clearScanCache();
    const s = await summarizeSession("sess-1", "claude");
    expect(s).not.toBeNull();
    expect(s!).toMatchObject({ sessionId: "sess-1", agent: "claude", project: "repo", model: "claude-opus-4-8", gitBranch: "main" });
    expect(s!.msgs).toBeGreaterThan(0);
    expect(s!.durationMs).toBe(s!.endMs - s!.startMs);
    expect(s!.process).not.toBeNull();
    expect(typeof s!.process!.score).toBe("number");
    expect(["disciplined", "loose", "chaotic"]).toContain(s!.process!.label);
    expect(s!.process!.stages).toMatchObject({ implementation: expect.any(Number), verification: expect.any(Number) });
    expect(s!.events).not.toBeNull();
    expect(s!.events!.edits).toBeGreaterThanOrEqual(1);
    expect(s!.events!.verifications).toBeGreaterThanOrEqual(1);
    expect(s!.events!.toolCalls.some((tc) => tc.name === "Edit")).toBe(true);
    expect(Array.isArray(s!.findings)).toBe(true);
  });

  it("SECRET-SAFE: the summary contains no message/tool content or file paths", async () => {
    const home = newHome(); writeClaudeSession(home, "sess-2"); clearScanCache();
    const s = await summarizeSession("sess-2", "claude");
    const blob = JSON.stringify(s);
    for (const secret of ["fix the bug", "old_string", "new_string", "/repo/src/a.ts", "1 passed", "pnpm test"]) {
      expect(blob).not.toContain(secret);
    }
    expect(blob).toContain("Edit");   // tool NAMES are allowed (low-cardinality); file paths are not
  });

  it("non-Claude (ATIF) session returns metrics-only: process/events null, findings empty", async () => {
    const home = newHome(); writeAtifSession(home, "atif-1"); clearScanCache();
    const s = await summarizeSession("atif-1", "atif");
    expect(s).not.toBeNull();
    expect(s!.agent).toBe("atif");
    expect(s!.process).toBeNull();
    expect(s!.events).toBeNull();
    expect(s!.findings).toEqual([]);
  });

  it("returns null for a session id that does not exist", async () => {
    newHome(); clearScanCache();
    expect(await summarizeSession("nope", "claude")).toBeNull();
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `cd /Users/rfeng/Projects/ninemind/agentgem.worktrees/feat-goldmine-aggregates-only && pnpm exec tsc -b 2>&1 | head -5`
Expected: FAIL — `@agentgem/insight` has no export `summarizeSession`.

- [ ] **Step 3: Write the implementation**

```ts
// packages/insight/src/sessionSummary.ts
// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
//
// Deterministic per-session aggregate for the goldmine chat: process-quality
// score, stage profile, that session's detector findings, metrics, and a
// counts-only event skeleton. NO message/tool content and NO file paths ever
// leave here — every field is a number, a score, or a low-cardinality name.
// Deep analysis (process/stages/findings/events) runs on the Claude tool-verb
// spine, mirroring behaviorFindings; metrics are multi-agent. Never throws.
import { resolveDirs } from "@agentgem/model";
import { scanSessionsCached } from "./observeScan.js";
import { resolveClaudeSession } from "./inspectSession.js";
import { scanWorkflow } from "./workflowScan.js";
import type { SessionSequence, ProcedureStep } from "./workflowScan.js";
import { runDetectors, summarizeFindings, DETECTORS } from "./detectors.js";
import type { DetectorSummary } from "./detectors.js";
import { loadRuleDetectors } from "./detectorRules.js";
import { sessionProcessQuality } from "./processQuality.js";
import { stageProfile, isEdit, isVerify } from "./stageLabels.js";
import type { StageProfile } from "./stageLabels.js";

export interface SessionSummary {
  sessionId: string;
  agent: string;
  project: string | null;
  model: string | null;
  gitBranch: string | null;
  startMs: number; endMs: number; durationMs: number;
  msgs: number; tokensIn: number; tokensOut: number; tokensCache: number;
  process: { score: number; label: "disciplined" | "loose" | "chaotic"; stages: StageProfile } | null;
  findings: DetectorSummary[];
  events: { toolCalls: { name: string; count: number }[]; filesTouched: number; edits: number; verifications: number } | null;
}

// Counts-only event skeleton from a scrubbed verb spine. `s.verb` is the tool
// verb (e.g. "Edit", "Bash:pnpm"); `s.tool` is the raw tool name. We count tool
// names and edit/verify steps, and the number of DISTINCT edited/read file args
// (count only — the arg strings themselves never leave this function).
function eventSkeleton(steps: ProcedureStep[]): NonNullable<SessionSummary["events"]> {
  const byTool = new Map<string, number>();
  const files = new Set<string>();
  let edits = 0, verifications = 0;
  for (const s of steps) {
    byTool.set(s.tool, (byTool.get(s.tool) ?? 0) + 1);
    if (isEdit(s)) { edits++; if (s.arg) files.add(s.arg); }
    if (isVerify(s)) verifications++;
  }
  const toolCalls = [...byTool.entries()].map(([name, count]) => ({ name, count })).sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
  return { toolCalls, filesTouched: files.size, edits, verifications };
}

export async function summarizeSession(
  sessionId: string,
  agent: string,
  dirs?: { claudeDir?: string; codexDir?: string },
): Promise<SessionSummary | null> {
  try {
    // 1. Metrics from the metadata scan (multi-agent, no content).
    const stats = await scanSessionsCached(Date.now(), dirs);
    const meta = stats.find((s) => s.sessionId === sessionId && s.agent === agent)
      ?? stats.find((s) => s.sessionId === sessionId);
    if (!meta) return null;

    const base: SessionSummary = {
      sessionId, agent: meta.agent, project: meta.project, model: meta.model, gitBranch: meta.gitBranch,
      startMs: meta.startMs, endMs: meta.endMs, durationMs: Math.max(0, meta.endMs - meta.startMs),
      msgs: meta.msgs, tokensIn: meta.tokensIn, tokensOut: meta.tokensOut, tokensCache: meta.tokensCache,
      process: null, findings: [], events: null,
    };

    // 2. Deep analysis is Claude-spine only — gate on the session's ACTUAL agent
    //    (meta.agent), not the caller's hint, so a correctly-identified Claude
    //    session is always analyzable.
    if (meta.agent !== "claude") return base;
    const resolved = await resolveClaudeSession(sessionId, { claudeDir: resolveDirs(dirs?.claudeDir).claudeDir });
    if (!resolved) return base;

    const inv = { project: { root: "*", name: "All projects", skills: [], mcpServers: [], hooks: [], instructions: [] } };
    const signal = scanWorkflow([resolved.path], inv, { retainSequences: true });
    const seq: SessionSequence | undefined = signal.sequences?.sessions.find((s) => s.sessionId === sessionId)
      ?? signal.sequences?.sessions[0];
    if (!seq) return base;

    const findings = runDetectors(signal, loadRuleDetectors());
    const pq = sessionProcessQuality(seq, findings);
    return {
      ...base,
      process: { score: pq.score, label: pq.label, stages: stageProfile(seq.steps) },
      findings: summarizeFindings(findings.filter((f) => f.sessionId === sessionId)),
      events: eventSkeleton(seq.steps),
    };
  } catch { return null; }
}
```

Add to `packages/insight/src/index.ts` (near the other analysis exports):

```ts
export * from "./sessionSummary.js";
```

- [ ] **Step 4: Run to verify pass**

Run: `pnpm exec tsc -b && pnpm exec vitest run dist/__tests__/sessionSummary.test.js`
Expected: PASS (4 tests). Note: the tests set `AGENTGEM_HOME` and call `summarizeSession` with no `dirs`, so the module's no-dirs scan cache must be cleared between fixtures — the tests do this via `clearScanCache()`; the implementation needs no change for it.

- [ ] **Step 5: Commit**

```bash
git add packages/insight/src/sessionSummary.ts packages/insight/src/index.ts src/__tests__/sessionSummary.test.ts
git commit -m "feat(insight): summarizeSession — deterministic per-session aggregate"
```

---

### Task 2: `askSession` — raw interrogation via ACP subprocess

**Files:**
- Create: `packages/insight/src/sessionAsk.ts`
- Modify: `packages/insight/src/index.ts` (one export line)
- Test: `src/__tests__/sessionAsk.test.ts`

**Interfaces:**
- Consumes: `loadSessionTranscript(sessionId, agent, dirs?) → Promise<TranscriptView|null>` with `TranscriptView.turns: TranscriptTurn[]`, `TranscriptTurn.spans: TranscriptSpan[]`, `TranscriptSpan = {kind:"message",role,text} | {kind:"tool_call",name,input,output?,error?}` (from `./inspectSession.js`); the ACP façade `AcpConnectFn`, `AcpCtx`, `AcpSessionHandle`, `CLAUDE_AGENT` (from `./acpRecommender.js`); `AGENTS`, `AgentDescriptor` (from `@agentgem/base`); `connectAcpAdapter` (from `@agentgem/base`) for the real default.
- Produces: `interface AskSessionResult { answered: boolean; answer: string; agentUsed: string | null }`, `askSession(sessionId, agent, question, opts?) → Promise<AskSessionResult>` where `opts?: { connectFn?: AcpConnectFn; timeoutMs?: number; maxChars?: number }`, plus `setAskConnectFnForTests(fn: AcpConnectFn | null): void`. Task 3 imports the type and the function.

- [ ] **Step 1: Write the failing tests**

```ts
// src/__tests__/sessionAsk.test.ts
// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { askSession, setAskConnectFnForTests, clearScanCache } from "@agentgem/insight";
import type { AcpConnectFn } from "@agentgem/insight";

// Fixture under <home>/.claude/projects/proj/ — askSession has no `dirs` param, so
// it resolves the transcript via AGENTGEM_HOME (same isolation as Task 1).
function writeClaudeSession(home: string, sessionId: string): void {
  const projDir = join(home, ".claude", "projects", "proj"); mkdirSync(projDir, { recursive: true });
  const lines = [
    { type: "user", cwd: "/repo", timestamp: "2026-07-01T10:00:00Z", message: { role: "user", content: "add retry logic to the fetch helper" } },
    { type: "assistant", cwd: "/repo", timestamp: "2026-07-01T10:00:01Z", message: { role: "assistant", model: "claude-opus-4-8",
      content: [{ type: "text", text: "Added exponential backoff to fetchWithRetry." }] } },
  ];
  writeFileSync(join(projDir, `${sessionId}.jsonl`), lines.map((l) => JSON.stringify(l)).join("\n"));
}

// A fake ACP connection that records the prompt it was given and returns a canned answer.
let lastPrompt = "";
const fakeConnect: AcpConnectFn = async () => ({
  ctx: { async open() { return {
    async setMode() {},
    async promptText(text: string) { lastPrompt = text; return "The retry logic uses exponential backoff, 3 attempts."; },
    dispose() {},
  }; } },
  close() {},
});

const saved = process.env.AGENTGEM_HOME;
const homes: string[] = [];
function newHome(): string { const h = mkdtempSync(join(tmpdir(), "agentgem-home-")); homes.push(h); process.env.AGENTGEM_HOME = h; return h; }
afterEach(() => {
  if (saved === undefined) delete process.env.AGENTGEM_HOME; else process.env.AGENTGEM_HOME = saved;
  setAskConnectFnForTests(null); clearScanCache(); lastPrompt = "";
  for (const h of homes.splice(0)) rmSync(h, { recursive: true, force: true });
});

describe("askSession", () => {
  it("feeds the raw scrubbed transcript to the ACP subprocess and returns only its answer", async () => {
    const home = newHome(); writeClaudeSession(home, "sess-1");
    setAskConnectFnForTests(fakeConnect);
    const r = await askSession("sess-1", "claude", "what retry strategy was used?");
    expect(r.answered).toBe(true);
    expect(r.agentUsed).toBe("claude-code");
    expect(r.answer).toBe("The retry logic uses exponential backoff, 3 attempts.");
    // the raw transcript content reached the SUBPROCESS prompt (not the result)
    expect(lastPrompt).toContain("add retry logic to the fetch helper");
    expect(lastPrompt).toContain("what retry strategy was used?");
  });

  it("returns answered:false without connecting for a source with no native ACP agent", async () => {
    newHome();
    let connected = false;
    setAskConnectFnForTests(async () => { connected = true; return { ctx: { async open() { return { async setMode() {}, async promptText() { return ""; }, dispose() {} }; } }, close() {} }; });
    const r = await askSession("whatever", "atif", "q?");     // atif has no ACP agent family
    expect(r.answered).toBe(false);
    expect(r.agentUsed).toBeNull();
    expect(connected).toBe(false);
    expect(r.answer).toMatch(/summarize_session/);
  });

  it("returns answered:false when the session is not found", async () => {
    newHome();
    setAskConnectFnForTests(fakeConnect);
    const r = await askSession("nope", "claude", "q?");
    expect(r.answered).toBe(false);
    expect(r.answer).toMatch(/not found/i);
  });

  it("windows an over-cap transcript instead of dropping it", async () => {
    const home = newHome(); writeClaudeSession(home, "sess-big");
    setAskConnectFnForTests(fakeConnect);
    const r = await askSession("sess-big", "claude", "q?", { maxChars: 50 });
    expect(r.answered).toBe(true);
    expect(lastPrompt.length).toBeLessThan(2000);      // capped, not the full render
    expect(lastPrompt).toMatch(/elided|truncated/i);   // windowing marker present
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm exec tsc -b 2>&1 | head -5`
Expected: FAIL — no export `askSession` / `setAskConnectFnForTests`.

- [ ] **Step 3: Write the implementation**

```ts
// packages/insight/src/sessionAsk.ts
// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
//
// Raw-trace interrogation for the goldmine chat WITHOUT putting raw content in
// the chat agent's context. The scrubbed transcript is handed to an ephemeral
// ACP subprocess running the session's own agent family (claude→claude-code,
// codex→codex); only the subprocess's text answer is returned. Mirrors the
// acpRecommender façade (AcpConnectFn seam + deny permission + neutral cwd).
// Never throws — connection/timeout/unknown-source all degrade to answered:false.
import { AGENTS } from "@agentgem/base";
import type { AgentDescriptor } from "@agentgem/base";
import { connectAcpAdapter } from "@agentgem/base";
import { createLogger } from "@agentgem/base";
import { loadSessionTranscript } from "./inspectSession.js";
import type { TranscriptView } from "./inspectSession.js";
import { analysisWorkspace } from "./acpRecommender.js";
import type { AcpConnectFn, AcpCtx } from "./acpRecommender.js";

const log = createLogger("insight");
const DEFAULT_MAX_CHARS = 60_000;
const DEFAULT_TIMEOUT_MS = 120_000;

export interface AskSessionResult { answered: boolean; answer: string; agentUsed: string | null }

let testConnectFn: AcpConnectFn | null = null;
export function setAskConnectFnForTests(fn: AcpConnectFn | null): void { testConnectFn = fn; }

// The session's source → its ACP agent family. Only claude/codex have adapters.
function agentDescriptorFor(agent: string): AgentDescriptor | null {
  if (agent === "claude" || agent === "claude-code") return AGENTS.find((a) => a.id === "claude-code") ?? null;
  if (agent === "codex") return AGENTS.find((a) => a.id === "codex") ?? null;
  return null;
}

// Render the scrubbed transcript to a bounded text block. Content is already
// secret-scrubbed by loadSessionTranscript; we only bound its size (head+tail
// window with an elision marker) so a long session doesn't blow the prompt.
function renderTranscript(view: TranscriptView, maxChars: number): string {
  const parts: string[] = [];
  for (const turn of view.turns) {
    for (const span of turn.spans) {
      if (span.kind === "message") parts.push(`${span.role}: ${span.text}`);
      else parts.push(`tool ${span.name}(${span.input})${span.output !== undefined ? ` -> ${span.output}` : ""}`);
    }
  }
  const full = parts.join("\n");
  if (full.length <= maxChars) return full;
  const half = Math.floor(maxChars / 2);
  return `${full.slice(0, half)}\n… [${full.length - maxChars} chars elided] …\n${full.slice(-half)}`;
}

const INSTRUCTION =
  "You are analyzing a past coding-agent session transcript to answer one question about it. " +
  "Use only the transcript below. Answer concisely and quote specific moments when relevant.\n\n";

export async function askSession(
  sessionId: string,
  agent: string,
  question: string,
  opts: { connectFn?: AcpConnectFn; timeoutMs?: number; maxChars?: number } = {},
): Promise<AskSessionResult> {
  const descriptor = agentDescriptorFor(agent);
  if (!descriptor) {
    return { answered: false, agentUsed: null,
      answer: `raw interrogation isn't available for ${agent} sessions — use summarize_session for their metrics and quality signal.` };
  }
  let view: TranscriptView | null;
  try { view = await loadSessionTranscript(sessionId, agent as never); } catch { view = null; }
  if (!view) return { answered: false, agentUsed: null, answer: `session '${sessionId}' not found.` };

  const connectFn = opts.connectFn ?? testConnectFn ?? defaultAskConnectFn;
  const prompt = INSTRUCTION + renderTranscript(view, opts.maxChars ?? DEFAULT_MAX_CHARS) + `\n\nQuestion: ${question}`;
  const deadline = Date.now() + (opts.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  const left = () => Math.max(0, deadline - Date.now());
  let conn: { ctx: AcpCtx; close: () => void } | null = null;
  try {
    conn = await withTimeout(connectFn(descriptor, null), left());
    const handle = await withTimeout(conn.ctx.open(analysisWorkspace()), left());
    try {
      await withTimeout(handle.setMode("plan"), left());          // never edits files
      const answer = await withTimeout(handle.promptText(prompt), left());
      return { answered: true, agentUsed: descriptor.id, answer };
    } finally { try { handle.dispose(); } catch { /* ignore */ } }
  } catch (err) {
    log.warn("askSession degraded: %s", (err as Error)?.message ?? err);
    return { answered: false, agentUsed: descriptor.id, answer: `raw interrogation failed: ${(err as Error)?.message ?? "unknown error"}` };
  } finally { try { conn?.close(); } catch { /* ignore */ } }
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return Promise.race([p, new Promise<T>((_, rej) => setTimeout(() => rej(new Error(`timed out after ${ms}ms`)), ms))]);
}

// Real connect: same plumbing as acpRecommender.defaultConnectFn, deny perms,
// aggregate only agent_message_chunk text.
export const defaultAskConnectFn: AcpConnectFn = async (descriptor) => {
  const raw = await connectAcpAdapter(descriptor as AgentDescriptor, { clientName: "agentgem-goldmine-ask", permission: "deny" });
  const ctx: AcpCtx = {
    async open(cwd: string) {
      const session = await raw.open(cwd);
      return {
        setMode: (mode: string) => session.setMode(mode),
        async promptText(text: string, onDelta?: (chunk: string) => void) {
          let out = "";
          await session.prompt(text, (u) => {
            const update = u as { sessionUpdate?: string; content?: { type?: string; text?: string } };
            if (update?.sessionUpdate === "agent_message_chunk" && update.content?.type === "text" && typeof update.content.text === "string") {
              out += update.content.text; onDelta?.(update.content.text);
            }
          });
          return out;
        },
        dispose: () => session.dispose(),
      };
    },
  };
  return { ctx, close: raw.close };
};
```

Add to `packages/insight/src/index.ts`:

```ts
export * from "./sessionAsk.js";
```

- [ ] **Step 4: Run to verify pass**

Run: `pnpm exec tsc -b && pnpm exec vitest run dist/__tests__/sessionAsk.test.js`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/insight/src/sessionAsk.ts packages/insight/src/index.ts src/__tests__/sessionAsk.test.ts
git commit -m "feat(insight): askSession — raw interrogation via session-family ACP subprocess"
```

---

### Task 3: Goldmine MCP tools — add summarize/ask, remove raw dump

**Files:**
- Modify: `src/goldmine/mcpServer.ts`
- Modify (if `windowTranscript` becomes unused): `src/goldmine/tools.ts`
- Test: `src/goldmine/__tests__/mcpServerTools.test.ts` (new) — the MCP methods are thin, so test the tool methods directly by instantiating `GoldmineTools`.

**Interfaces:**
- Consumes: `summarizeSession` (Task 1), `askSession`, `AskSessionResult` (Task 2).
- Produces: the goldmine MCP server now exposes `summarize_session` and `ask_session`, and no longer exposes `get_session_transcript`.

- [ ] **Step 1: Write the failing tests**

```ts
// src/goldmine/__tests__/mcpServerTools.test.ts
// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setAskConnectFnForTests, clearScanCache } from "@agentgem/insight";
import type { AcpConnectFn } from "@agentgem/insight";
import { GoldmineTools } from "../mcpServer.js";

// AGENTGEM_HOME isolation drives resolveDirs → the claude dir the tools scan.
const saved = process.env.AGENTGEM_HOME;
const cleanup: string[] = [];
afterEach(() => { if (saved === undefined) delete process.env.AGENTGEM_HOME; else process.env.AGENTGEM_HOME = saved; setAskConnectFnForTests(null); clearScanCache(); for (const d of cleanup.splice(0)) rmSync(d, { recursive: true, force: true }); });

function home(): string {
  const h = mkdtempSync(join(tmpdir(), "agentgem-home-")); cleanup.push(h);
  process.env.AGENTGEM_HOME = h;
  const projDir = join(h, ".claude", "projects", "proj"); mkdirSync(projDir, { recursive: true });
  writeFileSync(join(projDir, "sess-1.jsonl"), [
    JSON.stringify({ type: "user", cwd: "/repo", gitBranch: "main", timestamp: "2026-07-01T10:00:00Z", message: { role: "user", content: "hi" } }),
    JSON.stringify({ type: "assistant", cwd: "/repo", timestamp: "2026-07-01T10:00:01Z", message: { role: "assistant", model: "claude-opus-4-8", content: [{ type: "tool_use", id: "u1", name: "Edit", input: { file_path: "/repo/a.ts" } }] } }),
  ].join("\n"));
  return h;
}

describe("GoldmineTools", () => {
  it("summarize_session returns a deterministic aggregate", async () => {
    home();
    const tools = new GoldmineTools();
    const r = await tools.summarizeSessionTool({ sessionId: "sess-1", agent: "claude" });
    expect(r.summary).not.toBeNull();
    expect(r.summary!.sessionId).toBe("sess-1");
    expect(JSON.stringify(r.summary)).not.toContain("/repo/a.ts"); // secret-safe
  });

  it("ask_session routes through the injected ACP fake and returns its answer", async () => {
    home();
    const fake: AcpConnectFn = async () => ({ ctx: { async open() { return { async setMode() {}, async promptText() { return "it edited a.ts once."; }, dispose() {} }; } }, close() {} });
    setAskConnectFnForTests(fake);
    const tools = new GoldmineTools();
    const r = await tools.askSessionTool({ sessionId: "sess-1", agent: "claude", question: "what happened?" });
    expect(r.result.answered).toBe(true);
    expect(r.result.answer).toBe("it edited a.ts once.");
  });

  it("no longer exposes a get_session_transcript method", () => {
    const tools = new GoldmineTools() as unknown as Record<string, unknown>;
    expect(typeof tools.getSessionTranscriptTool).toBe("undefined");
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm exec tsc -b 2>&1 | head -5`
Expected: FAIL — `summarizeSessionTool`/`askSessionTool` don't exist.

- [ ] **Step 3: Edit `src/goldmine/mcpServer.ts`**

Change the import line
```ts
import { scanSessionsCached, loadSessionTranscript } from "@agentgem/insight";
```
to
```ts
import { scanSessionsCached, summarizeSession, askSession } from "@agentgem/insight";
```
Change the tools import
```ts
import { searchSessions, getArtifactDetail, windowTranscript } from "./tools.js";
```
to
```ts
import { searchSessions, getArtifactDetail } from "./tools.js";
```
Replace the `TranscriptInput` schema block with two new schemas:
```ts
const SummarizeInput = z.object({
  sessionId: z.string(),
  agent: z.string().default("claude"),
});

const AskInput = z.object({
  sessionId: z.string(),
  agent: z.string().default("claude"),
  question: z.string().min(1),
});
```
Delete the entire `getSessionTranscriptTool` method and its `@tool("get_session_transcript", …)` decorator. Add these two methods in its place:
```ts
  @tool("summarize_session", {
    input: SummarizeInput,
    description: "Aggregate view of one past session — process-quality score, stage mix (exploration/implementation/verification/orchestration), detector findings, metrics, and tool/edit/verify counts. NO raw content. Call this FIRST for any 'how did session X go' question (use sessionId + agent from search_sessions).",
  })
  async summarizeSessionTool({ sessionId, agent }: z.infer<typeof SummarizeInput>) {
    return { summary: await summarizeSession(sessionId, agent) };
  }

  @tool("ask_session", {
    input: AskInput,
    description: "Ask a specific question about what actually happened in one past session. The raw transcript is read by a separate agent (the session's own model) which returns only the answer — the transcript itself never enters this conversation. Use for 'find where X', 'why did it Y', or to quote a specific exchange, when summarize_session isn't enough.",
  })
  async askSessionTool({ sessionId, agent, question }: z.infer<typeof AskInput>) {
    return { result: await askSession(sessionId, agent, question) };
  }
```

- [ ] **Step 4: Handle `windowTranscript` if now unused**

Run: `grep -rn "windowTranscript" src packages --include=*.ts | grep -v dist`
- If the only remaining references are its definition in `src/goldmine/tools.ts` and its own test, delete the `windowTranscript` function from `tools.ts` and its test case (it was the pagination helper for the removed tool).
- If other code still imports it (e.g. a human-facing path), leave it untouched.
Record which branch you took in the report.

- [ ] **Step 5: Run to verify pass + regression**

Run: `pnpm exec tsc -b && pnpm exec vitest run dist/goldmine/__tests__/mcpServerTools.test.js`
Expected: PASS (3 tests).
Run: `pnpm exec vitest run dist/goldmine/__tests__/behaviorFindings.test.js dist/goldmine/__tests__/tools.test.js`
Expected: PASS (the other goldmine tools + helpers still behave; if `tools.test.js` had a `windowTranscript` case you removed in Step 4, that file's remaining cases pass).

- [ ] **Step 6: Commit**

```bash
git add src/goldmine/mcpServer.ts src/goldmine/tools.ts src/goldmine/__tests__/
git commit -m "feat(goldmine): summarize_session + ask_session tools; remove raw get_session_transcript"
```

---

### Task 4: Brief update — steer to the aggregate tools

**Files:**
- Modify: `packages/insight/src/goldmineContext.ts`
- Test: `src/__tests__/goldmineContext.test.ts` (new, or extend an existing `goldmineContext` test if one exists — check first with `ls src/**/__tests__ | grep -i goldmine`)

**Interfaces:**
- Consumes: nothing new.
- Produces: `buildGoldmineBrief` output mentions `summarize_session` and `ask_session`, not `get_session_transcript`.

- [ ] **Step 1: Read the current brief and its tool guidance**

Run: `grep -n "get_session_transcript\|search_sessions\|tool" packages/insight/src/goldmineContext.ts`
Identify the sentence(s) listing the read tools.

- [ ] **Step 2: Write the failing test**

```ts
// src/__tests__/goldmineContext.test.ts
// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
import { describe, it, expect } from "vitest";
import { buildGoldmineBrief } from "@agentgem/insight";

describe("buildGoldmineBrief tool guidance", () => {
  it("steers to summarize_session and ask_session, not the removed raw-dump tool", () => {
    // Minimal brief input — shape per GoldmineBriefInput; use empty/zero aggregates.
    const brief = buildGoldmineBrief({
      scorecard: { breadth: 0, battleTested: 0, portable: 0, gaps: [] },
      workflows: [],
      behavior: { summary: [], findings: [], scanned: { transcripts: 0, sessions: 0, days: 14 } },
    } as Parameters<typeof buildGoldmineBrief>[0]);
    expect(brief).toContain("summarize_session");
    expect(brief).toContain("ask_session");
    expect(brief).not.toContain("get_session_transcript");
  });
});
```
(If `buildGoldmineBrief`'s input type differs, read `GoldmineBriefInput` in `goldmineContext.ts` and match the minimal shape exactly; the assertion set stays the same.)

- [ ] **Step 3: Run to verify failure**

Run: `pnpm exec tsc -b && pnpm exec vitest run dist/__tests__/goldmineContext.test.js`
Expected: FAIL — brief still says `get_session_transcript` / lacks the new names.

- [ ] **Step 4: Update the tool-guidance sentence in `goldmineContext.ts`**

Replace the read-tools guidance with wording that names `summarize_session` (call first, aggregate) and `ask_session` (raw-backed, subprocess), and drops `get_session_transcript`. Match the file's existing voice. Concretely, the tool list should read like:
> "You have read tools: `search_sessions` (find sessions), `summarize_session` (aggregate view of one session — quality, stages, findings, metrics; call this first), `ask_session` (ask a specific question about what happened in a session — a separate agent reads the raw transcript and returns only the answer), `get_artifact_detail`, and `get_behavior_findings`. Prefer `summarize_session` over `ask_session`; reach for `ask_session` only when you need specifics the summary doesn't carry."

- [ ] **Step 5: Run to verify pass**

Run: `pnpm exec tsc -b && pnpm exec vitest run dist/__tests__/goldmineContext.test.js`
Expected: PASS.

- [ ] **Step 6: Full-suite regression gate**

Run: `pnpm test`
Expected: the only failure is the known pre-existing `consoleMount.test.js`. Every other test passes.

- [ ] **Step 7: Commit**

```bash
git add packages/insight/src/goldmineContext.ts src/__tests__/goldmineContext.test.ts
git commit -m "feat(goldmine): brief steers to summarize_session/ask_session"
```

---

### Task 5: Docs

**Files:**
- Modify: `docs/concepts.md` or `docs/architecture.md` (whichever documents the goldmine chat / MCP tools — check both)

- [ ] **Step 1: Add a short note** on the goldmine chat's aggregates-only design: the chat agent inspects sessions through `summarize_session` (deterministic aggregate) and `ask_session` (a separate agent — the session's own model family — reads the raw scrubbed transcript in a subprocess and returns only the answer, so raw content never enters the chat context). Cite the motivation in one line (Insights Generator pattern — aggregates into context, raw handled by a processing layer). Match the file's voice.

- [ ] **Step 2: Commit**

```bash
git add docs/
git commit -m "docs: goldmine aggregates-only chat (summarize_session / ask_session)"
```

---

## Self-review notes

- **Spec coverage:** `summarizeSession` (Task 1) ✔, `ask_session` ACP-subprocess (Task 2) ✔, MCP tools + raw-dump removal (Task 3) ✔, brief (Task 4) ✔, docs (Task 5) ✔. The spec's secret-safe assertion is an explicit test in Task 1; the "only the answer returns" property is an explicit test in Task 2.
- **Type consistency:** `SessionSummary` fields (Task 1) match the spec; `AskSessionResult { answered, answer, agentUsed }` used identically in Tasks 2–3; `summarizeSessionTool`/`askSessionTool` method names consistent between Task 3's implementation and its test.
- **Scoping decision (documented, deviates from spec's claude/codex phrasing):** deep analysis is Claude-spine only; non-Claude sessions get metrics with `process: null` / `events: null` / `findings: []`. This matches `behaviorFindings` being Claude-only and avoids depending on unverified Codex spine semantics. Flagged here so review treats it as intended, not a gap.
- **Known judgment calls for the implementer:** the exact `GoldmineBriefInput` shape in Task 4's test (read the real type), and the `windowTranscript` keep-or-delete branch in Task 3 Step 4 (decided by grep).
