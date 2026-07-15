# Agent/model defaults for background agent tasks — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Background agent tasks (report render, distill, recommender, judge & friends) default to a fast model (`claude-haiku-4-5`) via a per-task-family `ANTHROPIC_MODEL` env overlay on the spawned ACP adapter, configurable per family in Settings (issue #430).

**Architecture:** A new `packages/base/src/agentTasks.ts` owns task-family prefs (persisted at `~/.agentgem/agent-tasks.json`) and resolves a family → `AgentDescriptor` with an `env: { ANTHROPIC_MODEL }` overlay. The nine insight modules swap their literal `CLAUDE_AGENT` for `taskAgent("<family>")`; the descriptor flows through the existing `connectFn` seam and `spawnEnv` overlay unchanged. A decorator controller (`/api/agent-tasks`) + a new Settings section expose the prefs.

**Tech Stack:** TypeScript ESM, vitest, `@agentback/openapi` decorator controllers, `@agentback/client` typed routes, React console.

**Spec:** `docs/superpowers/specs/2026-07-14-agent-task-model-defaults-design.md`

## Global Constraints

- Fast default model string: `claude-haiku-4-5`. Inherit sentinel: `"default"`.
- Model overlay applies ONLY when the resolved agent is `claude-code` (codex has no verified model env).
- `AGENT_CREDENTIAL_VARS` stripping must remain intact — no overlay may reintroduce `ANTHROPIC_API_KEY`/`ANTHROPIC_AUTH_TOKEN`/`OPENAI_API_KEY`.
- Loading prefs never throws (corrupt/missing → defaults). Agent tasks keep degrade-don't-throw semantics.
- Root test command: `pnpm test` (= `tsc -b && vitest run`) — vitest runs compiled `dist/`, so always `tsc -b` first. Per-package: `cd packages/<p> && pnpm test`.
- `packages/console` tests/typecheck are NOT in CI — run locally.
- Match file style; no reformatting; keep diffs surgical.
- Work in worktree `/Users/rfeng/Projects/ninemind/agentgem-worktrees/agent-model-picker` (branch `agent-model-picker` off origin/main).

---

### Task 1: `packages/base/src/agentTasks.ts` — prefs + descriptor resolution

**Files:**
- Create: `packages/base/src/agentTasks.ts`
- Modify: `packages/base/src/index.ts` (add `export * from "./agentTasks.js";` after the `./agents.js` export line)
- Test: `packages/base/src/__tests__/agentTasks.test.ts`

**Interfaces:**
- Consumes: `AGENTS` from `./agents.js`, `AgentDescriptor` from `./acpSession.js`, `agentgemHome` from `@agentgem/model`.
- Produces (used by Tasks 4–6):
  - `type AgentTaskFamily = "report" | "distill" | "recommend" | "judge"`
  - `const AGENT_TASK_FAMILIES: readonly ["report","distill","recommend","judge"]`
  - `interface AgentTaskPref { agent?: string; model?: string }`
  - `type AgentTaskPrefs = Partial<Record<AgentTaskFamily, AgentTaskPref>>`
  - `const FAST_MODEL = "claude-haiku-4-5"`, `const INHERIT_MODEL = "default"`
  - `agentTasksPath(base?: string): string`
  - `loadAgentTaskPrefs(base?: string): AgentTaskPrefs` (never throws)
  - `saveAgentTaskPref(family: AgentTaskFamily, pref: AgentTaskPref, base?: string): void` (throws on fs failure, like memory's `saveProviderConfig`)
  - `effectiveAgentTaskPrefs(prefs?: AgentTaskPrefs): Record<AgentTaskFamily, Required<AgentTaskPref>>`
  - `taskAgent(family: AgentTaskFamily, prefs?: AgentTaskPrefs): AgentDescriptor`

- [ ] **Step 1: Write the failing test**

`packages/base/src/__tests__/agentTasks.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  loadAgentTaskPrefs, saveAgentTaskPref, effectiveAgentTaskPrefs, taskAgent,
  agentTasksPath, FAST_MODEL, INHERIT_MODEL,
} from "../agentTasks.js";

const tmpHome = () => mkdtempSync(join(tmpdir(), "agentgem-tasks-"));

describe("agent task prefs", () => {
  it("returns {} when no prefs file exists", () => {
    expect(loadAgentTaskPrefs(tmpHome())).toEqual({});
  });

  it("returns {} on a corrupt prefs file", () => {
    const home = tmpHome();
    mkdirSync(join(home, ".agentgem"), { recursive: true });
    writeFileSync(agentTasksPath(home), "{not json");
    expect(loadAgentTaskPrefs(home)).toEqual({});
  });

  it("round-trips a saved pref and merges per family", () => {
    const home = tmpHome();
    saveAgentTaskPref("report", { agent: "claude-code", model: INHERIT_MODEL }, home);
    saveAgentTaskPref("judge", { agent: "codex", model: FAST_MODEL }, home);
    expect(loadAgentTaskPrefs(home)).toEqual({
      report: { agent: "claude-code", model: INHERIT_MODEL },
      judge: { agent: "codex", model: FAST_MODEL },
    });
    // file is plain pretty-printed JSON
    expect(JSON.parse(readFileSync(agentTasksPath(home), "utf8"))).toHaveProperty("report");
  });

  it("effectiveAgentTaskPrefs fills defaults for every family", () => {
    const eff = effectiveAgentTaskPrefs({ distill: { model: INHERIT_MODEL } });
    expect(eff.report).toEqual({ agent: "claude-code", model: FAST_MODEL });
    expect(eff.distill).toEqual({ agent: "claude-code", model: INHERIT_MODEL });
    expect(eff.recommend).toEqual({ agent: "claude-code", model: FAST_MODEL });
    expect(eff.judge).toEqual({ agent: "claude-code", model: FAST_MODEL });
  });
});

describe("taskAgent", () => {
  it("defaults to claude-code with the fast-model env overlay", () => {
    const d = taskAgent("report", {});
    expect(d.id).toBe("claude-code");
    expect(d.env).toEqual({ ANTHROPIC_MODEL: FAST_MODEL });
  });

  it("uses the configured model for the overlay", () => {
    const d = taskAgent("report", { report: { model: "claude-sonnet-5" } });
    expect(d.env).toEqual({ ANTHROPIC_MODEL: "claude-sonnet-5" });
  });

  it("applies no overlay for the inherit sentinel", () => {
    const d = taskAgent("distill", { distill: { model: INHERIT_MODEL } });
    expect(d.env).toBeUndefined();
  });

  it("applies no model overlay for codex", () => {
    const d = taskAgent("judge", { judge: { agent: "codex", model: FAST_MODEL } });
    expect(d.id).toBe("codex");
    expect(d.env).toBeUndefined();
  });

  it("falls back to claude-code for an unknown agent id", () => {
    const d = taskAgent("recommend", { recommend: { agent: "no-such-agent" } });
    expect(d.id).toBe("claude-code");
    expect(d.env).toEqual({ ANTHROPIC_MODEL: FAST_MODEL });
  });

  it("never puts a credential var in the overlay", () => {
    const d = taskAgent("report", {});
    expect(Object.keys(d.env ?? {})).toEqual(["ANTHROPIC_MODEL"]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /Users/rfeng/Projects/ninemind/agentgem-worktrees/agent-model-picker/packages/base && pnpm test -- agentTasks`
Expected: FAIL — cannot find module `../agentTasks.js`.

- [ ] **Step 3: Write the implementation**

`packages/base/src/agentTasks.ts`:

```ts
// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
// packages/base/src/agentTasks.ts
//
// Per-task-family agent/model defaults for BACKGROUND agent tasks (report render,
// distill, workflow recommender, session judge). These are formatting/summarization
// jobs, not deep reasoning, so they default to a fast model instead of inheriting
// the user's heavy interactive default (issue #430). The model rides on the
// descriptor's env overlay as ANTHROPIC_MODEL — claude-agent-acp treats that env
// var as its highest-priority model preference, and spawnEnv (acpSession.ts)
// already applies descriptor.env while re-stripping credential vars.
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { agentgemHome } from "@agentgem/model";
import { AGENTS } from "./agents.js";
import type { AgentDescriptor } from "./acpSession.js";

export const AGENT_TASK_FAMILIES = ["report", "distill", "recommend", "judge"] as const;
export type AgentTaskFamily = (typeof AGENT_TASK_FAMILIES)[number];

export interface AgentTaskPref { agent?: string; model?: string }
export type AgentTaskPrefs = Partial<Record<AgentTaskFamily, AgentTaskPref>>;

// Fast default: measured ~2.3× faster than a large interactive default on the
// report-render path (#430). Any model string the adapter can resolve is valid here.
export const FAST_MODEL = "claude-haiku-4-5";
// Sentinel: no ANTHROPIC_MODEL overlay — the task inherits the user's interactive default.
export const INHERIT_MODEL = "default";

export function agentTasksPath(base = agentgemHome()): string {
  return join(base, ".agentgem", "agent-tasks.json");
}

export function loadAgentTaskPrefs(base = agentgemHome()): AgentTaskPrefs {
  const p = agentTasksPath(base);
  if (!existsSync(p)) return {};
  try {
    const v = JSON.parse(readFileSync(p, "utf8"));
    return v && typeof v === "object" && !Array.isArray(v) ? (v as AgentTaskPrefs) : {};
  } catch {
    return {};
  }
}

export function saveAgentTaskPref(family: AgentTaskFamily, pref: AgentTaskPref, base = agentgemHome()): void {
  const p = agentTasksPath(base);
  mkdirSync(dirname(p), { recursive: true });
  const all = loadAgentTaskPrefs(base);
  all[family] = pref;
  writeFileSync(p, JSON.stringify(all, null, 2), { mode: 0o600 });
}

/** Prefs with defaults filled in for every family — what the Settings UI renders. */
export function effectiveAgentTaskPrefs(prefs: AgentTaskPrefs = loadAgentTaskPrefs()): Record<AgentTaskFamily, Required<AgentTaskPref>> {
  const out = {} as Record<AgentTaskFamily, Required<AgentTaskPref>>;
  for (const f of AGENT_TASK_FAMILIES) {
    out[f] = { agent: prefs[f]?.agent ?? "claude-code", model: prefs[f]?.model ?? FAST_MODEL };
  }
  return out;
}

/**
 * Resolve the descriptor a background task family should spawn. Unknown agent ids
 * fall back to claude-code; the model overlay applies only to claude-code (codex-acp
 * has no verified model env) and is skipped for the INHERIT_MODEL sentinel.
 */
export function taskAgent(family: AgentTaskFamily, prefs: AgentTaskPrefs = loadAgentTaskPrefs()): AgentDescriptor {
  const pref = prefs[family] ?? {};
  const base = AGENTS.find((a) => a.id === pref.agent) ?? AGENTS.find((a) => a.id === "claude-code")!;
  const model = pref.model ?? FAST_MODEL;
  if (base.id !== "claude-code" || model === INHERIT_MODEL) return { ...base };
  return { ...base, env: { ...base.env, ANTHROPIC_MODEL: model } };
}
```

`packages/base/src/index.ts` — after the line `export * from "./agents.js";` add:

```ts
export * from "./agentTasks.js";
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd packages/base && pnpm test -- agentTasks`
Expected: PASS (all 10 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/base/src/agentTasks.ts packages/base/src/index.ts packages/base/src/__tests__/agentTasks.test.ts
git commit -m "feat(base): per-task-family agent/model prefs with fast-model default (#430)"
```

---

### Task 2: `resolveLaunch` must preserve `descriptor.env`

**Files:**
- Modify: `packages/base/src/adapters.ts:111-113` (the managed/bundled branch of `resolveLaunch`)
- Test: `packages/base/src/__tests__/adapters.launch.test.ts` (append cases)

**Interfaces:**
- Consumes: existing `resolveLaunch(descriptor, ctx)`.
- Produces: `resolveLaunch` keeps `descriptor.env` on every source; desktop merges `ELECTRON_RUN_AS_NODE: "1"` ON TOP of it.

- [ ] **Step 1: Write the failing tests** — append to `describe("resolveLaunch", ...)` in `packages/base/src/__tests__/adapters.launch.test.ts`:

```ts
  it("preserves a descriptor env overlay for a managed adapter (cli)", () => {
    const entry = entryOf(managedAdapterDir("/home/u", "codex"));
    const d = resolveLaunch({ ...codex, env: { ANTHROPIC_MODEL: "claude-haiku-4-5" } }, ctx({ present: new Set([entry]) }));
    expect(d?.env).toEqual({ ANTHROPIC_MODEL: "claude-haiku-4-5" });
  });

  it("merges ELECTRON_RUN_AS_NODE onto a descriptor env overlay (desktop)", () => {
    const entry = entryOf(`/Res/adapters/codex`);
    const d = resolveLaunch(
      { ...codex, env: { ANTHROPIC_MODEL: "claude-haiku-4-5" } },
      ctx({ runtime: "desktop", execPath: "/App/Electron", resourcesPath: "/Res", present: new Set([entry]) }),
    );
    expect(d?.env).toEqual({ ANTHROPIC_MODEL: "claude-haiku-4-5", ELECTRON_RUN_AS_NODE: "1" });
  });
```

- [ ] **Step 2: Run to verify failure**

Run: `cd packages/base && pnpm test -- adapters.launch`
Expected: the two new tests FAIL (env is `undefined` / only `ELECTRON_RUN_AS_NODE`).

- [ ] **Step 3: Fix `resolveLaunch`** — in `packages/base/src/adapters.ts`, replace:

```ts
  const command = [ctx.execPath, r.entry!, ...descriptor.command.slice(1)];
  const env = ctx.runtime === "desktop" ? { ELECTRON_RUN_AS_NODE: "1" } : undefined;
  return env ? { ...descriptor, command, env } : { ...descriptor, command };
```

with:

```ts
  const command = [ctx.execPath, r.entry!, ...descriptor.command.slice(1)];
  // Merge (not replace) onto the descriptor's own overlay — e.g. a per-task
  // ANTHROPIC_MODEL from agentTasks must survive the desktop launch rewrite.
  const env = ctx.runtime === "desktop" ? { ...descriptor.env, ELECTRON_RUN_AS_NODE: "1" } : descriptor.env;
  return env ? { ...descriptor, command, env } : { ...descriptor, command };
```

- [ ] **Step 4: Run to verify pass**

Run: `cd packages/base && pnpm test -- adapters`
Expected: PASS, including all pre-existing adapter tests.

- [ ] **Step 5: Commit**

```bash
git add packages/base/src/adapters.ts packages/base/src/__tests__/adapters.launch.test.ts
git commit -m "fix(base): resolveLaunch preserves descriptor env overlay on managed/bundled launches"
```

---

### Task 3: spawnEnv regression tests for the model overlay

**Files:**
- Test: `packages/base/src/__tests__/acpSession.env.test.ts` (append; no production change — `spawnEnv` already overlays `descriptor.env` and re-strips credentials)

- [ ] **Step 1: Append tests**

```ts
  it("passes an ANTHROPIC_MODEL overlay through to the spawned env", () => {
    const out = spawnEnv({ id: "x", name: "X", command: ["x"], env: { ANTHROPIC_MODEL: "claude-haiku-4-5" } }, { PATH: "/bin" });
    expect(out.ANTHROPIC_MODEL).toBe("claude-haiku-4-5");
    expect(out.PATH).toBe("/bin");
  });
  it("strips credentials even when a model overlay is present", () => {
    const out = spawnEnv(
      { id: "x", name: "X", command: ["x"], env: { ANTHROPIC_MODEL: "claude-haiku-4-5", ANTHROPIC_API_KEY: "leaked" } },
      { PATH: "/bin" },
    );
    expect(out.ANTHROPIC_MODEL).toBe("claude-haiku-4-5");
    expect(out.ANTHROPIC_API_KEY).toBeUndefined();
  });
```

- [ ] **Step 2: Run**

Run: `cd packages/base && pnpm test -- acpSession.env`
Expected: PASS immediately (documents existing behavior the feature relies on).

- [ ] **Step 3: Commit**

```bash
git add packages/base/src/__tests__/acpSession.env.test.ts
git commit -m "test(base): spawnEnv carries ANTHROPIC_MODEL overlay and still strips credentials"
```

---

### Task 4: Insight call sites use `taskAgent(family)`

**Files:**
- Modify (family in parens):
  - `packages/insight/src/reportRender.ts:61` (report)
  - `packages/insight/src/dashboardRender.ts:99` (report)
  - `packages/insight/src/narrateInsights.ts:69` (report)
  - `packages/insight/src/distill.ts:200` (distill)
  - `packages/insight/src/acpRecommender.ts:278` (recommend)
  - `packages/insight/src/discoverRerank.ts:95` (recommend)
  - `packages/insight/src/judgeSession.ts:63` (judge)
  - `packages/insight/src/criterionJudge.ts:116` (judge)
  - `packages/insight/src/sessionLessons.ts:108` (judge)
- Test: `packages/insight/src/__tests__/taskAgent.wiring.test.ts` (new)

**Interfaces:**
- Consumes: `taskAgent` from `@agentgem/base` (Task 1).
- Produces: no signature changes; `CLAUDE_AGENT` stays exported from acpRecommender.

Line numbers are pre-edit references — locate by the quoted content, not the number.

- [ ] **Step 1: Write the failing wiring test**

`packages/insight/src/__tests__/taskAgent.wiring.test.ts`:

```ts
import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { FAST_MODEL, agentTasksPath, type AgentDescriptor } from "@agentgem/base";
import type { AcpConnectFn } from "../acpRecommender.js";
import { renderReport } from "../reportRender.js";

const origHome = process.env.AGENTGEM_HOME;
afterEach(() => {
  if (origHome === undefined) delete process.env.AGENTGEM_HOME;
  else process.env.AGENTGEM_HOME = origHome;
});

// A connectFn that records the descriptor it was handed and returns a stub session.
function capturing(seen: AgentDescriptor[]): AcpConnectFn {
  return async (descriptor) => {
    seen.push(descriptor as AgentDescriptor);
    return {
      ctx: {
        open: async () => ({
          setMode: async () => {},
          promptText: async () => "<!doctype html><html><body>r</body></html>",
          dispose: () => {},
        }),
      },
      close: () => {},
    };
  };
}

describe("background tasks resolve their agent from task prefs", () => {
  it("renderReport requests the fast model by default", async () => {
    process.env.AGENTGEM_HOME = mkdtempSync(join(tmpdir(), "agentgem-wiring-"));
    const seen: AgentDescriptor[] = [];
    await renderReport({ facts: {}, meta: { rubricId: "r", title: "T", scope: "s" }, connectFn: capturing(seen) });
    expect(seen[0]?.id).toBe("claude-code");
    expect(seen[0]?.env?.ANTHROPIC_MODEL).toBe(FAST_MODEL);
  });

  it("renderReport honors a persisted per-family model pref", async () => {
    const home = mkdtempSync(join(tmpdir(), "agentgem-wiring-"));
    process.env.AGENTGEM_HOME = home;
    mkdirSync(join(home, ".agentgem"), { recursive: true });
    writeFileSync(agentTasksPath(home), JSON.stringify({ report: { model: "claude-sonnet-5" } }));
    const seen: AgentDescriptor[] = [];
    await renderReport({ facts: {}, meta: { rubricId: "r", title: "T", scope: "s" }, connectFn: capturing(seen) });
    expect(seen[0]?.env?.ANTHROPIC_MODEL).toBe("claude-sonnet-5");
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `cd packages/insight && pnpm test -- taskAgent.wiring`
Expected: FAIL — `seen[0].env` is undefined (descriptor is still the bare `CLAUDE_AGENT`).

- [ ] **Step 3: Swap the nine call sites**

Every call site has the identical shape `connectFn(CLAUDE_AGENT, null)`. For each file below: change the call, add/extend the `@agentgem/base` import with `taskAgent`, and drop `CLAUDE_AGENT` from the acpRecommender import when it becomes unused.

1. `reportRender.ts` — import block (line 11-14) becomes:
```ts
import {
  type AcpConnectFn, type AcpCtx, type AcpSessionHandle,
  analysisWorkspace, currentTestConnectFn, defaultConnectFn,
} from "./acpRecommender.js";
```
line 17: `import { createLogger, taskAgent } from "@agentgem/base";`
line 61: `conn = await withTimeout(connectFn(taskAgent("report"), null), left());`

2. `dashboardRender.ts` — same import treatment (remove `CLAUDE_AGENT`, add `taskAgent` to the `@agentgem/base` import at line 15);
line 99: `conn = await withTimeout(connectFn(taskAgent("report"), null), left());`

3. `narrateInsights.ts` — same import treatment (base import at line 16);
line 69: `conn = await withTimeout(connectFn(taskAgent("report"), null), left());`

4. `distill.ts` — line 9 becomes:
```ts
import { analysisWorkspace, defaultConnectFn, currentTestConnectFn, type AcpConnectFn } from "./acpRecommender.js";
```
line 13: `import { createLogger, taskAgent } from "@agentgem/base";`
line 194 (log): `log.debug("distill: requesting %s for %d candidate(s)", agent.name, candidates.length);`
line 200: `conn = await withTimeout(connectFn(agent, null), left());`
and immediately before the log line insert: `const agent = taskAgent("distill");`

5. `acpRecommender.ts` — keep `CLAUDE_AGENT` defined/exported. In `recommendWorkflow`, before the `log.debug("workflow-recommender: requesting %s ..."` line (271) insert `const agent = taskAgent("recommend");`, change the log to use `agent.name`, and line 278: `conn = await withTimeout(connectFn(agent, null), left());`. Import: `createLogger` import at top already pulls from `@agentgem/base` (line 13-15 block) — add `taskAgent` to that import list.

6. `discoverRerank.ts` — line 9 becomes:
```ts
import { analysisWorkspace, defaultConnectFn, currentTestConnectFn, type AcpConnectFn, type AcpCtx, type AcpSessionHandle } from "./acpRecommender.js";
```
line 12: `import { createLogger, taskAgent } from "@agentgem/base";`
line 95: `conn = await withTimeout(connectFn(taskAgent("recommend"), null), left());`

7. `judgeSession.ts` — import block (lines 16-18): remove `CLAUDE_AGENT`; line 19: `import { createLogger, taskAgent } from "@agentgem/base";`
line 62 (log): use `agent.name`; line 63: `conn = await withTimeout(connectFn(agent, null), left());` with `const agent = taskAgent("judge");` inserted just above the log line.

8. `criterionJudge.ts` — same as judgeSession: remove `CLAUDE_AGENT` from the acpRecommender import (lines 25-27), add `taskAgent` to the base import (line 28), insert `const agent = taskAgent("judge");` above the log at line 115, use `agent.name` in the log, and `connectFn(agent, null)` at line 116.

9. `sessionLessons.ts` — import block (line 17-18): remove `CLAUDE_AGENT`; line 19: `import { createLogger, taskAgent } from "@agentgem/base";`
line 108: `conn = await withTimeout(connectFn(taskAgent("judge"), null), left());`

Check `packages/insight/src/__tests__/acpRecommender.launch.test.ts` still compiles (it imports `CLAUDE_AGENT`, which stays exported).

- [ ] **Step 4: Run to verify pass**

Run: `cd packages/insight && pnpm test`
Expected: PASS, including the two new wiring tests and all existing insight tests.

- [ ] **Step 5: Root build + root tests (call sites are exercised by root `src/__tests__` too)**

Run: `pnpm test` from the worktree root (runs `tsc -b && vitest run`).
Expected: PASS. (Real-FS scan tests can flake under full-suite concurrency — re-run a failing scan test in isolation before treating it as a regression.)

- [ ] **Step 6: Commit**

```bash
git add packages/insight/src
git commit -m "feat(insight): background agent tasks resolve agent/model from per-family prefs (#430)"
```

---

### Task 5: `/api/agent-tasks` settings controller

**Files:**
- Create: `src/agentTasks.controller.ts`
- Modify: `src/index.ts` (import + `app.restController(AgentTasksController);` beside the BenchmarkProxyController registration at line 44)
- Modify: `src/client.ts` (same, beside line 25)
- Test: `src/__tests__/agentTasksController.test.ts`

**Interfaces:**
- Consumes: `AGENT_TASK_FAMILIES`, `effectiveAgentTaskPrefs`, `saveAgentTaskPref`, `type AgentTaskFamily` from `@agentgem/base` (Task 1).
- Produces: `GET /api/agent-tasks/settings` → `{ families: { report|distill|recommend|judge: { agent, model } } }`; `POST /api/agent-tasks/settings` body `{ family, agent, model }` → same response shape.

- [ ] **Step 1: Write the failing test**

`src/__tests__/agentTasksController.test.ts`:

```ts
// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { AgentTasksController } from "../agentTasks.controller.js";

const orig = process.env.AGENTGEM_HOME;
beforeEach(() => { process.env.AGENTGEM_HOME = mkdtempSync(join(tmpdir(), "agentgem-tasks-ctrl-")); });
afterEach(() => { if (orig === undefined) delete process.env.AGENTGEM_HOME; else process.env.AGENTGEM_HOME = orig; });

describe("AgentTasksController", () => {
  it("returns effective defaults when nothing is persisted", async () => {
    const r = await new AgentTasksController().getSettings();
    expect(r.families.report).toEqual({ agent: "claude-code", model: "claude-haiku-4-5" });
    expect(Object.keys(r.families).sort()).toEqual(["distill", "judge", "recommend", "report"]);
  });

  it("persists a per-family update and returns the merged map", async () => {
    const c = new AgentTasksController();
    const r = await c.setSetting({ body: { family: "report", agent: "claude-code", model: "default" } });
    expect(r.families.report).toEqual({ agent: "claude-code", model: "default" });
    expect(r.families.judge).toEqual({ agent: "claude-code", model: "claude-haiku-4-5" });
    // survives a fresh read
    expect((await c.getSettings()).families.report.model).toBe("default");
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm exec tsc -b && pnpm exec vitest run agentTasksController` (from worktree root)
Expected: FAIL — module `../agentTasks.controller.js` not found. (If `tsc -b` itself fails on the missing file, that is the failure signal for this step.)

- [ ] **Step 3: Implement controller + registration**

`src/agentTasks.controller.ts`:

```ts
// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
// Settings surface for background agent tasks (report render, distill, recommender,
// judge): which local agent runs each family and which model it requests. Backed by
// ~/.agentgem/agent-tasks.json via @agentgem/base agentTasks. Mirrors
// BenchmarkProxyController's contribute-setting shape.
import { z } from "zod";
import { api, get, post } from "@agentback/openapi";
import { AGENT_TASK_FAMILIES, effectiveAgentTaskPrefs, saveAgentTaskPref } from "@agentgem/base";

const Family = z.enum(AGENT_TASK_FAMILIES);
const TaskPref = z.object({ agent: z.string(), model: z.string() });
const Settings = z.object({
  families: z.object({ report: TaskPref, distill: TaskPref, recommend: TaskPref, judge: TaskPref }),
});
const UpdateBody = z.object({ family: Family, agent: z.string().min(1), model: z.string().min(1) });

@api({ basePath: "/api/agent-tasks" })
export class AgentTasksController {
  @get("/settings", { response: Settings })
  async getSettings(): Promise<z.infer<typeof Settings>> {
    return { families: effectiveAgentTaskPrefs() };
  }

  @post("/settings", { body: UpdateBody, response: Settings })
  async setSetting(input: { body: z.infer<typeof UpdateBody> }): Promise<z.infer<typeof Settings>> {
    const { family, agent, model } = input.body;
    saveAgentTaskPref(family, { agent, model });
    return { families: effectiveAgentTaskPrefs() };
  }
}
```

`src/index.ts` — next to the BenchmarkProxyController lines:
```ts
import { AgentTasksController } from "./agentTasks.controller.js";
// … in the setup function, beside app.restController(BenchmarkProxyController);
app.restController(AgentTasksController);
```

`src/client.ts` — same two additions beside its BenchmarkProxyController lines.

- [ ] **Step 4: Run to verify pass**

Run: `pnpm exec tsc -b && pnpm exec vitest run agentTasksController`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add src/agentTasks.controller.ts src/index.ts src/client.ts src/__tests__/agentTasksController.test.ts
git commit -m "feat(server): /api/agent-tasks settings for background agent model/agent defaults (#430)"
```

---

### Task 6: Console Settings section

**Files:**
- Modify: `packages/console/src/api/routes.ts` (typed routes, near the benchmark contribute routes)
- Create: `packages/console/src/panels/Settings/AgentTasks.tsx`
- Modify: `packages/console/src/panels/Settings/index.tsx` (new section)

**Interfaces:**
- Consumes: `GET/POST /api/agent-tasks/settings` (Task 5), `GET /api/agents` → `{ agents: { id, name, available }[] }`.
- Produces: `agentTaskSettingsRoute`, `setAgentTaskSettingRoute`, `AgentTaskSettingsSchema`, `type AgentTaskSettings` in routes.ts; `<AgentTasks apiBase={...} />` component.

- [ ] **Step 1: Add typed routes** — in `packages/console/src/api/routes.ts`, after the benchmark `contributeRoute` block:

```ts
// Background agent task defaults: which local agent runs each background task family
// (report render, distill, recommender, judge) and which model it requests. Mirrors
// the server's AgentTasksController schemas exactly (src/agentTasks.controller.ts).
export const AGENT_TASK_FAMILIES = ["report", "distill", "recommend", "judge"] as const;
export type AgentTaskFamily = (typeof AGENT_TASK_FAMILIES)[number];
const AgentTaskPrefSchema = z.object({ agent: z.string(), model: z.string() });
export const AgentTaskSettingsSchema = z.object({
  families: z.object({
    report: AgentTaskPrefSchema, distill: AgentTaskPrefSchema,
    recommend: AgentTaskPrefSchema, judge: AgentTaskPrefSchema,
  }),
});
export type AgentTaskSettings = z.infer<typeof AgentTaskSettingsSchema>;
export const agentTaskSettingsRoute = defineRoute("GET", "/api/agent-tasks/settings", {
  response: AgentTaskSettingsSchema,
});
export const setAgentTaskSettingRoute = defineRoute("POST", "/api/agent-tasks/settings", {
  body: z.object({ family: z.enum(AGENT_TASK_FAMILIES), agent: z.string(), model: z.string() }),
  response: AgentTaskSettingsSchema,
});
```

- [ ] **Step 2: Create the component**

`packages/console/src/panels/Settings/AgentTasks.tsx`:

```tsx
import { useEffect, useState } from "react";
import {
  AGENT_TASK_FAMILIES, agentTaskSettingsRoute, setAgentTaskSettingRoute, makeClient,
  type AgentTaskFamily, type AgentTaskSettings,
} from "../../api/routes.js";
import { Loading } from "../../shell/Loading.js";

type AgentInfo = { id: string; name: string; available: boolean };

const FAMILY_LABEL: Record<AgentTaskFamily, string> = {
  report: "Report rendering",
  distill: "Skill distillation",
  recommend: "Workflow recommendations",
  judge: "Session judging",
};
const MODEL_OPTIONS = [
  { value: "claude-haiku-4-5", label: "Fast — Haiku 4.5 (default)" },
  { value: "claude-sonnet-5", label: "Balanced — Sonnet" },
  { value: "default", label: "Interactive default" },
];

/** Per-task-family agent + model defaults for background agent tasks. Each change
 *  round-trips through the server (Contribute.tsx pattern); the model select is
 *  disabled for non-Claude agents (no model override mechanism there yet). */
export function AgentTasks({ apiBase }: { apiBase: string }) {
  const [settings, setSettings] = useState<AgentTaskSettings | null>(null);
  const [agents, setAgents] = useState<AgentInfo[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    agentTaskSettingsRoute.call(makeClient(apiBase))
      .then((r) => { if (alive) setSettings(r); })
      .catch((e) => { if (alive) setError(e instanceof Error ? e.message : String(e)); });
    fetch(`${apiBase}/api/agents`)
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then((d: { agents: AgentInfo[] }) => { if (alive) setAgents(d.agents); })
      .catch(() => { /* agent list is cosmetic — selects still render the stored value */ });
    return () => { alive = false; };
  }, [apiBase]);

  const update = async (family: AgentTaskFamily, agent: string, model: string) => {
    setError(null);
    try {
      const r = await setAgentTaskSettingRoute.call(makeClient(apiBase), { body: { family, agent, model } });
      setSettings(r);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  if (error && !settings) return <p className="ledger-error" role="alert">{error}</p>;
  if (!settings) return <Loading />;

  return (
    <>
      {AGENT_TASK_FAMILIES.map((family) => {
        const pref = settings.families[family];
        const agentKnown = agents.some((a) => a.id === pref.agent);
        const modelKnown = MODEL_OPTIONS.some((o) => o.value === pref.model);
        return (
          <div className="ledger-bar" key={family}>
            <span className="targets-label">{FAMILY_LABEL[family]}</span>
            <select
              className="targets-select"
              aria-label={`${FAMILY_LABEL[family]} agent`}
              value={pref.agent}
              onChange={(e) => void update(family, e.target.value, pref.model)}
            >
              {!agentKnown && <option value={pref.agent}>{pref.agent}</option>}
              {agents.map((a) => (
                <option key={a.id} value={a.id} disabled={!a.available}>
                  {a.name}{a.available ? "" : " (not installed)"}
                </option>
              ))}
            </select>
            <select
              className="targets-select"
              aria-label={`${FAMILY_LABEL[family]} model`}
              value={pref.model}
              disabled={pref.agent !== "claude-code"}
              onChange={(e) => void update(family, pref.agent, e.target.value)}
            >
              {!modelKnown && <option value={pref.model}>{pref.model}</option>}
              {MODEL_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
            </select>
            {pref.agent !== "claude-code" && <span className="ws-note">model follows that agent's own default</span>}
          </div>
        );
      })}
      {error && settings && <p className="ledger-error" role="alert">{error}</p>}
    </>
  );
}
```

- [ ] **Step 3: Mount in Settings** — in `packages/console/src/panels/Settings/index.tsx`, add the import
`import { AgentTasks } from "./AgentTasks.js";` and, between the "Verify identity" and "Deploy backends" sections, insert:

```tsx
      <section className="ledger-group">
        <h2 className="ledger-group-label">Background agent tasks</h2>
        <p className="deploy-hint">
          Reports, distillation, recommendations and judging run a local coding agent in the
          background. They default to a fast model — pick a different agent or model per task.
        </p>
        <AgentTasks apiBase={apiBase} />
      </section>
```

- [ ] **Step 4: Typecheck + console tests (NOT in CI — run locally)**

Run: `cd packages/console && pnpm exec tsc --noEmit -p tsconfig.json && pnpm test`
Expected: clean typecheck; existing console tests PASS.

- [ ] **Step 5: Verify every className used has a CSS rule** (project rule for hand-authored stylesheets):

Run: `for c in ledger-bar targets-select targets-label ws-note ledger-error ledger-group deploy-hint; do printf "%s %s\n" "$c" "$(grep -c "\.$c" packages/console/src/*.css packages/console/src/**/*.css 2>/dev/null | awk -F: '{s+=$2} END {print s}')"; done`
Expected: every count > 0 (all classes pre-exist; no new CSS needed).

- [ ] **Step 6: Commit**

```bash
git add packages/console/src/api/routes.ts packages/console/src/panels/Settings
git commit -m "feat(console): Background agent tasks settings — per-family agent/model picker (#430)"
```

---

### Task 7: Full verification

- [ ] **Step 1: Full root suite**

Run (worktree root): `pnpm test`
Expected: `tsc -b` clean, vitest PASS. Re-run any real-FS scan test that times out in isolation before diagnosing.

- [ ] **Step 2: Per-package suites**

Run: `cd packages/base && pnpm test && cd ../insight && pnpm test && cd ../console && pnpm test`
Expected: PASS.

- [ ] **Step 3: Live browser verification** (jsdom asserts behavior, never appearance)

Start the console against a temp home (never the real one — a stale build once wiped a key):
`AGENTGEM_HOME=$(mktemp -d) node dist/index.js` (or the repo's dev server script), open `#/settings`, confirm the "Background agent tasks" section renders four styled rows, flip Report rendering to "Interactive default", reload, confirm persistence, and confirm `$AGENTGEM_HOME/.agentgem/agent-tasks.json` contains `{ "report": { "agent": "claude-code", "model": "default" } }`.

- [ ] **Step 4: Commit any fixups; then code review + PR** (outside this plan: requesting-code-review, PR per repo CLAUDE.md — push branch, `gh pr create`, watch `test (24)`, `gh pr merge --rebase` only when instructed).
```
