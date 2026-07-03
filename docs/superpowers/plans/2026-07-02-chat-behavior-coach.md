# Chat Behavior Coach Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Surface detector findings (session-behavior patterns + advice) through the goldmine chat: a one-line brief teaser when findings exist, plus a `get_behavior_findings` MCP tool for detail.

**Architecture:** A new pure-policy helper `collectBehaviorFindings` (src/goldmine/behaviorFindings.ts) runs the deterministic detector pipeline (scanWorkflow → runDetectors → summarizeFindings) over a capped window of recent transcripts. The chat's `buildBrief` (src/index.ts) appends a teaser line via a new optional `behavior` field on `GoldmineBriefInput`; the existing `GoldmineTools` MCP server gains a third read-only tool delegating to the helper.

**Tech Stack:** TypeScript (ESM, strict), vitest (compiled dist), pnpm workspace, AgentBack `@tool` + zod. No new dependencies.

**Spec:** docs/superpowers/specs/2026-07-02-chat-behavior-coach-design.md (in the MAIN checkout at /Users/rfeng/Projects/ninemind/agentgem — copy it into the worktree and commit it in Task 2).

## Global Constraints

- Node >= 24; ESM only; local imports use `.js` extensions.
- **Tests run from compiled `dist/`**: `pnpm build` first, then `npx vitest run dist/...`. Test sources compile from `src/**/__tests__/*.test.ts`.
- New source files start with `// Copyright (c) 2026 NineMind, Inc.` / `// SPDX-License-Identifier: MIT` + a `// <path>` line + short module comment.
- **Never-throw contract**: `collectBehaviorFindings` degrades to the empty result with `console.error`; never throws to callers (chat open path + MCP tool).
- **No raw user text policy is inherited**: findings/summaries come from the detector layer unchanged; this feature adds no new text derived from args/file contents.
- Caps (spec §Components): `days` default 14 clamp 1..90; `maxTranscripts` default 30 clamp 1..100; findings list capped at 50 (summary counts computed from UNCAPPED findings).
- Work in a dedicated worktree off freshly fetched `origin/main` (must include detectors commit e2cac2d). Rebase-only integration.
- Commits authored as Raymond Feng <raymond@ninemind.ai>.

## Reference: existing pieces this plan builds on (do not redefine)

```ts
// @agentgem/insight (all already exported):
allClaudeTranscripts(claudeDir: string): string[]
safeMtime(file: string): number
scanWorkflow(paths: string[], inv: ScanInventory, opts: { retainSequences?: boolean }): WorkflowSignal
runDetectors(signal: WorkflowSignal, extra?: DetectorSpec[]): DetectorFinding[]
loadRuleDetectors(dir?: string): DetectorSpec[]          // default = ~/.agentgem/detectors (AGENTGEM_HOME honored)
summarizeFindings(findings: DetectorFinding[], specs?: DetectorSpec[]): DetectorSummary[]
DETECTORS: DetectorSpec[]
buildGoldmineBrief(input: GoldmineBriefInput): string     // packages/insight/src/goldmineContext.ts
// @agentgem/model:
resolveDirs(dir?: string): { claudeDir: string; ... }
```

Transcript JSONL shape `scanWorkflow` parses (for fixtures): one JSON object per line; assistant tool_use lines look like
`{"sessionId":"s-fix","message":{"role":"assistant","content":[{"type":"tool_use","name":"Bash","input":{"command":"npm run deploy"}}]}}`
— a session is retained in `signal.sequences.sessions` when it has ≥1 captured builtin step (no mission hint required).

---

### Task 1: Workspace setup

**Files:** none — worktree + baseline only.

**Interfaces:**
- Consumes: nothing.
- Produces: clean worktree `../agentgem-coach` on branch `feat/chat-behavior-coach` (base = origin/main including e2cac2d), green build. All later tasks run there.

- [ ] **Step 1: Create worktree**

```bash
cd /Users/rfeng/Projects/ninemind/agentgem
git fetch origin
git worktree add ../agentgem-coach -b feat/chat-behavior-coach origin/main
cd ../agentgem-coach
git log --oneline -1 origin/main   # sanity: at or after e2cac2d
```

- [ ] **Step 2: Install, build (delete stale tsbuildinfo first — clean-dist-without-tsbuildinfo causes phantom missing-module failures)**

```bash
pnpm install
find . -maxdepth 3 -name "*.tsbuildinfo" -not -path "*/node_modules/*" -delete
pnpm build
```
Expected: tsc completes with no errors.

- [ ] **Step 3: Baseline sanity (focused, not the full suite)**

```bash
npx vitest run dist/goldmine/__tests__ dist/gem/__tests__/goldmineContext.test.js dist/gem/__tests__/detectors.test.js
```
Expected: all pass.

---

### Task 2: `collectBehaviorFindings` helper

**Files:**
- Create: `src/goldmine/behaviorFindings.ts`
- Create: `docs/superpowers/specs/2026-07-02-chat-behavior-coach-design.md` (copy from the main checkout: `cp /Users/rfeng/Projects/ninemind/agentgem/docs/superpowers/specs/2026-07-02-chat-behavior-coach-design.md docs/superpowers/specs/`)
- Test: `src/goldmine/__tests__/behaviorFindings.test.ts`

**Interfaces:**
- Consumes: `@agentgem/insight` exports listed in the Reference block; `resolveDirs` from `@agentgem/model`.
- Produces (Tasks 3–4 rely on these exact names):
  - `interface BehaviorFindingsOptions { days?: number; maxTranscripts?: number; dir?: string; rulesDir?: string; now?: () => number }`
  - `interface BehaviorFindings { summary: DetectorSummary[]; findings: DetectorFinding[]; scanned: { transcripts: number; sessions: number; days: number } }`
  - `function collectBehaviorFindings(opts?: BehaviorFindingsOptions): BehaviorFindings`

- [ ] **Step 1: Write the failing tests**

Create `src/goldmine/__tests__/behaviorFindings.test.ts`:

```ts
// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
// src/goldmine/__tests__/behaviorFindings.test.ts
import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { collectBehaviorFindings } from "../behaviorFindings.js";

const NOW = 1_750_000_000_000; // fixed clock for window tests
const DAY = 86_400_000;

let tmp: string | undefined;
afterEach(() => { if (tmp) { rmSync(tmp, { recursive: true, force: true }); tmp = undefined; } });

// A claudeDir with one project folder; returns the projects subdir to drop transcripts into.
function makeClaudeDir(): { claudeDir: string; projDir: string } {
  tmp = mkdtempSync(join(tmpdir(), "coach-"));
  const claudeDir = join(tmp, ".claude");
  const projDir = join(claudeDir, "projects", "-proj");
  mkdirSync(projDir, { recursive: true });
  return { claudeDir, projDir };
}

const bashLine = (cmd: string) => ({
  sessionId: "s-fix",
  message: { role: "assistant", content: [{ type: "tool_use", name: "Bash", input: { command: cmd } }] },
});

function writeTranscript(dir: string, name: string, lines: unknown[], mtimeMs = NOW): string {
  const p = join(dir, name);
  writeFileSync(p, lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
  utimesSync(p, new Date(mtimeMs), new Date(mtimeMs));
  return p;
}

describe("collectBehaviorFindings", () => {
  it("detects a retry-storm in a fixture transcript and summarizes it", () => {
    const { claudeDir, projDir } = makeClaudeDir();
    writeTranscript(projDir, "storm.jsonl", [
      bashLine("npm run deploy"), bashLine("npm run deploy"), bashLine("npm run deploy"),
    ]);
    const r = collectBehaviorFindings({ dir: claudeDir, rulesDir: join(claudeDir, "no-rules"), now: () => NOW });
    expect(r.scanned.transcripts).toBe(1);
    expect(r.findings.some((f) => f.detectorId === "retry-storm")).toBe(true);
    const storm = r.summary.find((s) => s.id === "retry-storm");
    expect(storm?.count).toBe(1);
    expect(storm?.advice.length).toBeGreaterThan(0);
  });

  it("excludes transcripts older than the days window", () => {
    const { claudeDir, projDir } = makeClaudeDir();
    writeTranscript(projDir, "old.jsonl",
      [bashLine("npm run deploy"), bashLine("npm run deploy"), bashLine("npm run deploy")],
      NOW - 30 * DAY);
    const r = collectBehaviorFindings({ days: 14, dir: claudeDir, rulesDir: join(claudeDir, "no-rules"), now: () => NOW });
    expect(r.scanned.transcripts).toBe(0);
    expect(r.summary).toEqual([]);
    expect(r.findings).toEqual([]);
  });

  it("caps the number of transcripts scanned (newest first)", () => {
    const { claudeDir, projDir } = makeClaudeDir();
    writeTranscript(projDir, "a.jsonl", [bashLine("git status")], NOW - 2 * DAY);
    writeTranscript(projDir, "b.jsonl", [bashLine("git status")], NOW - DAY);
    const r = collectBehaviorFindings({ maxTranscripts: 1, dir: claudeDir, rulesDir: join(claudeDir, "no-rules"), now: () => NOW });
    expect(r.scanned.transcripts).toBe(1);
  });

  it("picks up user-defined rules from rulesDir", () => {
    const { claudeDir, projDir } = makeClaudeDir();
    writeTranscript(projDir, "s.jsonl", [
      bashLine("npm run deploy"), bashLine("npm run deploy"), bashLine("npm run deploy"),
    ]);
    const rulesDir = join(claudeDir, "detector-rules");
    mkdirSync(rulesDir, { recursive: true });
    writeFileSync(join(rulesDir, "r.json"), JSON.stringify({
      id: "npm-heavy", title: "Heavy npm use", advice: "Batch npm invocations.",
      // bashVerb("npm run deploy") = "Bash:npm run" — argv0 + first lowercase subcommand
      pattern: ["Bash:npm run"], minRepeats: 3,
    }));
    const r = collectBehaviorFindings({ dir: claudeDir, rulesDir, now: () => NOW });
    expect(r.summary.map((s) => s.id)).toContain("npm-heavy");
  });

  it("returns the empty result (never throws) when the claudeDir does not exist", () => {
    const r = collectBehaviorFindings({ dir: "/nonexistent/claude", rulesDir: "/nonexistent/rules", now: () => NOW });
    expect(r).toEqual({ summary: [], findings: [], scanned: { transcripts: 0, sessions: 0, days: 14 } });
  });

  it("clamps out-of-range options", () => {
    const r = collectBehaviorFindings({ days: 9999, maxTranscripts: -5, dir: "/nonexistent/claude", rulesDir: "/nonexistent/rules", now: () => NOW });
    expect(r.scanned.days).toBe(90);   // days clamped to 90
    // maxTranscripts clamp to 1 is exercised implicitly (no throw, empty dir)
  });
});
```

- [ ] **Step 2: Run to verify failure**

```bash
pnpm build 2>&1 | head -20
```
Expected: tsc FAILS — cannot find module `../behaviorFindings.js`.

- [ ] **Step 3: Implement `src/goldmine/behaviorFindings.ts`**

```ts
// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
// src/goldmine/behaviorFindings.ts
//
// Chat-facing policy over the detector engine: run the deterministic pipeline
// (scanWorkflow → runDetectors → summarizeFindings) over a capped window of
// recent transcripts. Pure policy lives here (window, caps); the engine is
// untouched. Never throws — the chat-open path and the MCP tool both call this
// best-effort. LLM-free by construction (detectors are cost:"cheap").
import { resolveDirs } from "@agentgem/model";
import {
  allClaudeTranscripts, safeMtime, scanWorkflow,
  runDetectors, loadRuleDetectors, summarizeFindings, DETECTORS,
} from "@agentgem/insight";
import type { DetectorFinding, DetectorSummary } from "@agentgem/insight";

const DAY = 86_400_000;
const MAX_FINDINGS = 50;

export interface BehaviorFindingsOptions {
  days?: number;           // look-back window, default 14, clamp 1..90
  maxTranscripts?: number; // newest-first cap, default 30, clamp 1..100
  dir?: string;            // claudeDir override (tests)
  rulesDir?: string;       // detector-rules dir override (tests)
  now?: () => number;      // clock seam (tests)
}

export interface BehaviorFindings {
  summary: DetectorSummary[];   // counts from ALL findings (uncapped)
  findings: DetectorFinding[];  // newest sessions first, capped at MAX_FINDINGS
  scanned: { transcripts: number; sessions: number; days: number };
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, Math.floor(v)));
}

function empty(days: number): BehaviorFindings {
  return { summary: [], findings: [], scanned: { transcripts: 0, sessions: 0, days } };
}

export function collectBehaviorFindings(opts: BehaviorFindingsOptions = {}): BehaviorFindings {
  const days = clamp(opts.days ?? 14, 1, 90);
  const maxTranscripts = clamp(opts.maxTranscripts ?? 30, 1, 100);
  try {
    const now = (opts.now ?? Date.now)();
    const dirs = resolveDirs(opts.dir);
    const cutoff = now - days * DAY;
    const paths = allClaudeTranscripts(dirs.claudeDir)
      .map((p) => ({ p, ms: safeMtime(p) }))
      .filter((e) => e.ms >= cutoff)
      .sort((a, b) => b.ms - a.ms)
      .slice(0, maxTranscripts)
      .map((e) => e.p);
    if (paths.length === 0) return empty(days);

    // All-projects inventory stub — same shape computeInsights uses for root "*".
    const inv = { project: { root: "*", name: "All projects", skills: [], mcpServers: [], hooks: [], instructions: [] } };
    const signal = scanWorkflow(paths, inv, { retainSequences: true });
    const ruleSpecs = loadRuleDetectors(opts.rulesDir);
    const findings = runDetectors(signal, ruleSpecs);
    return {
      summary: summarizeFindings(findings, [...DETECTORS, ...ruleSpecs]),
      findings: [...findings].sort((a, b) => b.atMs - a.atMs).slice(0, MAX_FINDINGS),
      // sessions = sessions that retained ≥1 step (signal.sessions.scanned is just the transcript count)
      scanned: { transcripts: paths.length, sessions: signal.sequences?.sessions.length ?? 0, days },
    };
  } catch (err) {
    console.error("[behavior] collectBehaviorFindings degraded:", (err as Error).message);
    return empty(days);
  }
}
```

Note: if `loadRuleDetectors(undefined)` and `loadRuleDetectors()` behave differently in your checkout, verify — the shipped signature is `loadRuleDetectors(dir = defaultDetectorRulesDir())`, so passing `opts.rulesDir` (possibly undefined) uses the default correctly.

- [ ] **Step 4: Copy the spec into the worktree, build, run the tests**

```bash
cp /Users/rfeng/Projects/ninemind/agentgem/docs/superpowers/specs/2026-07-02-chat-behavior-coach-design.md docs/superpowers/specs/
pnpm build && npx vitest run dist/goldmine/__tests__/behaviorFindings.test.js
```
Expected: PASS (6 tests).

- [ ] **Step 5: Commit**

```bash
git add src/goldmine/behaviorFindings.ts src/goldmine/__tests__/behaviorFindings.test.ts docs/superpowers/specs/2026-07-02-chat-behavior-coach-design.md
git commit -m "feat(goldmine): collectBehaviorFindings — capped detector scan for the chat coach"
```

---

### Task 3: Brief teaser (`GoldmineBriefInput.behavior` + `buildBrief` wiring)

**Files:**
- Modify: `packages/insight/src/goldmineContext.ts`
- Modify: `src/index.ts` (the `buildBrief` closure inside `createApp`, around line 227)
- Test: `src/gem/__tests__/goldmineContext.test.ts` (append)

**Interfaces:**
- Consumes: `collectBehaviorFindings` from Task 2 (`../goldmine/behaviorFindings.js` relative to src/index.ts: `./goldmine/behaviorFindings.js`).
- Produces: `GoldmineBriefInput` gains optional `behavior?: { patterns: number; topTitle: string }`; brief renders one extra line when present.

- [ ] **Step 1: Write the failing test** (append to `src/gem/__tests__/goldmineContext.test.ts`)

```ts
  it("renders the behavior teaser only when provided", () => {
    const base = { scorecard: { breadth: 0, battleTested: 0, portable: 0, gaps: [] }, topArtifacts: [], skillCount: 0 };
    expect(buildGoldmineBrief(base)).not.toContain("Behavior:");
    const brief = buildGoldmineBrief({ ...base, behavior: { patterns: 2, topTitle: "Same command repeated back-to-back" } });
    expect(brief).toContain(`Behavior: 2 recurring pattern(s)`);
    expect(brief).toContain("Same command repeated back-to-back");
    expect(brief).toContain("get_behavior_findings");
  });
```

- [ ] **Step 2: Run to verify failure**

```bash
pnpm build && npx vitest run dist/gem/__tests__/goldmineContext.test.js
```
Expected: FAIL — `behavior` is not a known property (tsc error) OR the teaser assertions fail. Either failure mode is the valid RED.

- [ ] **Step 3: Implement**

In `packages/insight/src/goldmineContext.ts`, extend the interface:

```ts
export interface GoldmineBriefInput {
  scorecard: { breadth: number; battleTested: number; portable: number; gaps: string[] };
  topArtifacts: { type: string; name: string; invocations: number }[];
  skillCount: number;
  behavior?: { patterns: number; topTitle: string };   // detector teaser — omitted when nothing flagged
}
```

Update the intro line's tool list and append the teaser line to `lines` (after the gaps line):

```ts
    `You are grounded in the user's local "goldmine" of coding sessions and installed artifacts. Use it to answer questions and, when asked, help distill a reusable Gem. You have read tools (search_sessions, get_artifact_detail, get_behavior_findings) — call them for detail beyond this summary.`,
```

```ts
    ...(input.behavior
      ? [`- Behavior: ${input.behavior.patterns} recurring pattern(s) detected in recent sessions — top: "${input.behavior.topTitle}". The user can ask you for coaching on these; call get_behavior_findings for detail.`]
      : []),
```

(Note: `lines` currently destructures `input`; the spread element needs `input.behavior` — either stop destructuring or destructure `behavior` too. Keep the existing destructuring and add `behavior` to it: `const { scorecard: s, topArtifacts, skillCount, behavior } = input;` then use `behavior` in the spread.)

In `src/index.ts`, inside the existing `buildBrief` try block (after `topArtifacts` is built, before the `return buildGoldmineBrief({...})`), add:

```ts
          const behavior = collectBehaviorFindings();
```

and extend the `buildGoldmineBrief` call:

```ts
          return buildGoldmineBrief({
            scorecard: { breadth: sc.breadth, battleTested: sc.battleTested, portable: sc.portable, gaps: sc.gaps },
            topArtifacts: topArtifacts.slice(0, 10),
            skillCount: sc.projects.reduce((n, p) => n + p.workflows.length, 0),
            ...(behavior.summary.length > 0
              ? { behavior: { patterns: behavior.summary.length, topTitle: behavior.summary[0].title } }
              : {}),
          });
```

Add the import near the other local imports in `src/index.ts`:

```ts
import { collectBehaviorFindings } from "./goldmine/behaviorFindings.js";
```

The catch fallback branch stays unchanged (no behavior field = no teaser). ⚠ The `buildBrief` closure in src/index.ts has no direct unit test today (pre-existing); the teaser rendering is covered by the goldmineContext test and `collectBehaviorFindings` by Task 2's tests.

- [ ] **Step 4: Build and run the tests**

```bash
pnpm build && npx vitest run dist/gem/__tests__/goldmineContext.test.js dist/goldmine/__tests__/behaviorFindings.test.js
```
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/insight/src/goldmineContext.ts src/index.ts src/gem/__tests__/goldmineContext.test.ts
git commit -m "feat(chat): behavior teaser line in the goldmine brief"
```

---

### Task 4: `get_behavior_findings` MCP tool

**Files:**
- Modify: `src/goldmine/mcpServer.ts`
- Test: `src/goldmine/__tests__/mcpServer.wiring.test.ts` (update expected tool list)

**Interfaces:**
- Consumes: `collectBehaviorFindings` from Task 2 (`./behaviorFindings.js`).
- Produces: MCP tool `get_behavior_findings` with input `{ days?: number (int, 1..90, default 14) }` returning `BehaviorFindings` verbatim.

- [ ] **Step 1: Write the failing test** — in `src/goldmine/__tests__/mcpServer.wiring.test.ts`, update the wiring test:

Change the test name to `"registers search_sessions, get_artifact_detail, and get_behavior_findings"` and the assertion to:

```ts
    expect(names).toEqual(["get_artifact_detail", "get_behavior_findings", "search_sessions"]);
```

- [ ] **Step 2: Run to verify failure**

```bash
pnpm build && npx vitest run dist/goldmine/__tests__/mcpServer.wiring.test.js
```
Expected: FAIL — expected array has 3 names, received 2.

- [ ] **Step 3: Implement** — in `src/goldmine/mcpServer.ts`:

Add next to the other input schemas:

```ts
const BehaviorInput = z.object({
  days: z.number().int().min(1).max(90).default(14),
});
```

Add the import:

```ts
import { collectBehaviorFindings } from "./behaviorFindings.js";
```

Add the tool method to `GoldmineTools` (thin delegation — all behavior is covered by Task 2's tests):

```ts
  @tool("get_behavior_findings", {
    input: BehaviorInput,
    description: "Recurring problematic behaviors detected in the user's recent coding sessions (retry storms, thrash loops, unverified finishes, user-defined rules), with per-pattern advice. Use when the user asks how to improve, what went wrong, or about their habits.",
  })
  async getBehaviorFindingsTool({ days }: z.infer<typeof BehaviorInput>) {
    return collectBehaviorFindings({ days });
  }
```

- [ ] **Step 4: Build and run the tests**

```bash
pnpm build && npx vitest run dist/goldmine/__tests__
```
Expected: PASS (wiring test now sees 3 tools; behaviorFindings + chatRoutes + draftGem + tools tests unaffected).

- [ ] **Step 5: Commit**

```bash
git add src/goldmine/mcpServer.ts src/goldmine/__tests__/mcpServer.wiring.test.ts
git commit -m "feat(goldmine): get_behavior_findings MCP tool for the chat coach"
```

---

### Task 5: Full-suite verification and branch finish

**Files:** none.

**Interfaces:**
- Consumes: everything above.
- Produces: green branch ready for rebase integration.

- [ ] **Step 1: Full build + suite**

```bash
pnpm build && pnpm test
```
Expected: green. KNOWN FLAKE: observeScan/scorecard/observe.controller tests can time out at 15s under full-suite concurrency (they scan the real ~/.claude) — re-run the timed-out file in isolation to confirm before treating as regression.

- [ ] **Step 2: Confirm branch is ahead of origin/main only**

```bash
git fetch origin && git log --oneline origin/main..HEAD && git log --oneline HEAD..origin/main | head -3
```
Expected: 4 commits listed; if origin/main moved, `git rebase origin/main`, delete `*.tsbuildinfo`, rebuild, re-run the suite.

- [ ] **Step 3: Finish** — use superpowers:finishing-a-development-branch (repo policy: local ff merge is the default; rebase-only; never `gh pr update-branch`).

---

## Out of scope (from the spec — do not build)

- UI chips / console panel rendering of detectorSummary.
- Scheduled proactive digests (timed coach on the warm daemon).
- Cross-session trend history.
- LLM-cost detectors.
