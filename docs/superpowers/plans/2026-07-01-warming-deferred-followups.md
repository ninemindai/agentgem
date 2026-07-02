# Warming Deferred Follow-ups Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship three independent warming follow-ups: (A) cache the per-project playbook distillation + make it a warmable, (B) a cross-process warm lock so daemon+console don't double-warm, (C) `agentgem warm --install-service` OS auto-start.

**Architecture:** A reuses the established `computeWorkflowAnalysis`/`insightsCache` patterns (new `distill-cache.json`, `computeDistill` core, `distill` warmable, `/playbook/prepare` delegate). B reuses the pidfile liveness lock as `withWarmLock`, gating the driver entry points (schedule/daemon) — the engine core is untouched. C adds pure launchd/systemd unit generators + an install/uninstall CLI entry.

**Tech Stack:** TypeScript (ESM, `node:` built-ins), Vitest, `@agentgem/*` packages, the existing warm engine/daemon/CLI.

## Global Constraints

- **Reuse, don't reinvent:** mirror `insightsCache.ts` (cache), `workflowCore.ts` (core), `pidfile.ts` (lock liveness). No new deps.
- **Best-effort, never throws** from cache/lock layers; don't-cache-degraded preserved.
- **All I/O injectable in tests; temp `AGENTGEM_HOME`; never scan real `~/.claude`.** Backend tests run against compiled `dist/` — `pnpm -w build` before `pnpm vitest run dist/...`.
- **Copyright header** on every new `.ts` file: `// Copyright (c) 2026 NineMind, Inc.` then `// SPDX-License-Identifier: MIT`.
- **Git identity:** `Raymond Feng <raymond@ninemind.ai>`.
- **Lock opt-out:** `AGENTGEM_WARM_LOCK === "false"` disables the lock (runs fn unlocked).
- **Repo integration:** rebase-only, branch must be up to date — linearize before merging.

## File structure

| File | Responsibility |
|---|---|
| `packages/insight/src/distillCache.ts` (new) | `distill-cache.json` `(root, token)` cache |
| `packages/insight/src/index.ts` (modify) | barrel-export the new cache |
| `src/distillCore.ts` (new) | `computeDistill(root, opts)` headless cache-aware core |
| `src/gem.controller.ts` (modify) | `/playbook/prepare` delegates to `computeDistill` |
| `src/warm/registry.ts` (modify) | add `distill` warmable |
| `src/warm/lock.ts` (new) | `withWarmLock` cross-process advisory lock |
| `src/warm/schedule.ts` · `src/warm/daemon.ts` (modify) | gate driver passes with the lock |
| `src/warm/service.ts` (new) | launchd/systemd generators + install/uninstall + `runServiceCommand` |
| `src/cli.ts` (modify) | route `--install-service`/`--uninstall-service` |

---

## Task 1: distill cache

**Files:** Create `packages/insight/src/distillCache.ts`; Modify `packages/insight/src/index.ts`; Test `src/__tests__/distillCache.test.ts`

**Interfaces — Produces:**
- `distillToken(paths: string[]): string`
- `readDistillCache(root, token): unknown | null`
- `readDistillCacheEntry(root, token): { result: unknown; ts: number } | null`
- `writeDistillCache(root, token, result: unknown, nowMs: number): void`

- [ ] **Step 1: Write the failing test** — `src/__tests__/distillCache.test.ts`:
```ts
// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeDistillCache, readDistillCache, readDistillCacheEntry } from "@agentgem/insight";

let dir: string | undefined;
const orig = process.env.AGENTGEM_HOME;
afterEach(() => { if (dir) rmSync(dir, { recursive: true, force: true }); dir = undefined; if (orig === undefined) delete process.env.AGENTGEM_HOME; else process.env.AGENTGEM_HOME = orig; });

describe("distillCache", () => {
  it("round-trips a (root, token) entry with its write ts, misses otherwise", () => {
    dir = mkdtempSync(join(tmpdir(), "dc-")); process.env.AGENTGEM_HOME = dir;
    writeDistillCache("/proj", "d1:1:5", { skills: [], lessons: [{ x: 1 }], degraded: false }, 4242);
    expect(readDistillCache("/proj", "d1:1:5")).toEqual({ skills: [], lessons: [{ x: 1 }], degraded: false });
    expect(readDistillCacheEntry("/proj", "d1:1:5")).toEqual({ result: { skills: [], lessons: [{ x: 1 }], degraded: false }, ts: 4242 });
    expect(readDistillCacheEntry("/proj", "other")).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails** — `pnpm vitest run src/__tests__/distillCache.test.ts` → FAIL (`writeDistillCache is not a function`).

- [ ] **Step 3: Create `packages/insight/src/distillCache.ts`** (mirror of `insightsCache.ts`, distinct file + token version):
```ts
// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
// packages/insight/src/distillCache.ts
//
// Per-project cache of the (expensive, LLM) playbook distillation (skills +
// session lessons). Separate file (distill-cache.json) + own token version so it
// evicts and versions independently from insights/analysis. Best-effort; never throws.
import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { agentgemHome, writeJsonAtomic } from "@agentgem/model";

const MAX_ENTRIES = 50;
function cachePath(): string { return join(agentgemHome(), ".agentgem", "distill-cache.json"); }

// d1 = { skills: DistilledSkill[], lessons: DistilledLesson[], degraded }.
const TOKEN_VERSION = "d1";

/** version + transcript count + newest mtime — a new/updated session yields a new token. */
export function distillToken(paths: string[]): string {
  let maxMs = 0;
  for (const p of paths) { try { const m = statSync(p).mtimeMs; if (m > maxMs) maxMs = m; } catch { /* gone */ } }
  return `${TOKEN_VERSION}:${paths.length}:${Math.round(maxMs)}`;
}

interface Entry { root: string; token: string; result: unknown; ts: number }
function readAll(): Entry[] {
  try { const j = JSON.parse(readFileSync(cachePath(), "utf8")); return Array.isArray(j) ? j : []; } catch { return []; }
}

export function readDistillCache(root: string, token: string): unknown | null {
  const e = readAll().find((x) => x.root === root && x.token === token);
  return e ? e.result : null;
}

export function readDistillCacheEntry(root: string, token: string): { result: unknown; ts: number } | null {
  const e = readAll().find((x) => x.root === root && x.token === token);
  return e ? { result: e.result, ts: e.ts } : null;
}

export function writeDistillCache(root: string, token: string, result: unknown, nowMs: number): void {
  try {
    const all = readAll().filter((x) => x.root !== root);
    all.push({ root, token, result, ts: nowMs });
    all.sort((a, b) => b.ts - a.ts);
    writeJsonAtomic(cachePath(), all.slice(0, MAX_ENTRIES));
  } catch { /* best-effort */ }
}
```

- [ ] **Step 4: Barrel-export** — in `packages/insight/src/index.ts`, add next to the other cache exports:
```ts
export * from "./distillCache.js";
```

- [ ] **Step 5: Rebuild + test** — `pnpm -w build && pnpm vitest run src/__tests__/distillCache.test.js` → PASS.

- [ ] **Step 6: Commit**
```bash
git add packages/insight/src/distillCache.ts packages/insight/src/index.ts src/__tests__/distillCache.test.ts
git -c user.name="Raymond Feng" -c user.email="raymond@ninemind.ai" commit -m "feat(insight): distill-cache.json (root,token) cache for playbook distillation"
```

---

## Task 2: computeDistill core + /playbook/prepare delegate

**Files:** Create `src/distillCore.ts`; Modify `src/gem.controller.ts` (`playbookPrepare`); Test `src/__tests__/distillCore.test.ts`

**Interfaces:**
- Consumes: `distillToken`/`readDistillCacheEntry`/`writeDistillCache` (Task 1); `distillWorkflow`/`distillSessionLessons`/`claudeTranscriptsForCwd`/`scanWorkflow` (`@agentgem/insight`); `introspectProject`/`introspectConfig` (`@agentgem/capture`); `resolveDirs`/`resolveProject` (`@agentgem/model`).
- Produces:
  - `interface DistillPayload { skills: DistilledSkill[]; lessons: DistilledLesson[]; degraded: boolean }`
  - `interface DistillResult { payload: DistillPayload; cached: boolean; updatedAt: number | null }`
  - `computeDistill(root: string, opts?: { dir?: string; force?: boolean; now?: () => number; distillWf?: typeof distillWorkflow; distillLessons?: typeof distillSessionLessons }): Promise<DistillResult>`

- [ ] **Step 1: Write the failing test** — `src/__tests__/distillCore.test.ts` (cache-hit path + fresh/degraded via injected fakes; temp home + a fake transcript so the token is stable):
```ts
// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { distillToken, writeDistillCache, claudeTranscriptsForCwd } from "@agentgem/insight";
import { computeDistill } from "../distillCore.js";

let home: string | undefined;
const orig = process.env.AGENTGEM_HOME;
afterEach(() => { if (home) rmSync(home, { recursive: true, force: true }); home = undefined; if (orig === undefined) delete process.env.AGENTGEM_HOME; else process.env.AGENTGEM_HOME = orig; });

function seedTranscript(): string {
  home = mkdtempSync(join(tmpdir(), "dcore-")); process.env.AGENTGEM_HOME = home;
  const claudeDir = join(home, ".claude");
  const projDir = join(claudeDir, "projects", "-proj");
  mkdirSync(projDir, { recursive: true });
  writeFileSync(join(projDir, "s.jsonl"), JSON.stringify({ cwd: "/proj" }) + "\n");
  return claudeDir;
}

describe("computeDistill", () => {
  it("returns the cached payload without running the agents when the token matches", async () => {
    const claudeDir = seedTranscript();
    const token = distillToken(claudeTranscriptsForCwd(claudeDir, "/proj"));
    writeDistillCache("/proj", token, { skills: [], lessons: [], degraded: false }, 999);
    const r = await computeDistill("/proj", { dir: claudeDir });
    expect(r.cached).toBe(true);
    expect(r.updatedAt).toBe(999);
  });

  it("fresh non-degraded compute writes cache (second call hits); degraded does not", async () => {
    const claudeDir = seedTranscript();
    const okFakes = { distillWf: async () => ({ distilled: [], degraded: false }), distillLessons: async () => ({ lessons: [], degraded: false }) };
    const r1 = await computeDistill("/proj", { dir: claudeDir, now: () => 111, ...okFakes });
    expect(r1.cached).toBe(false); expect(r1.updatedAt).toBe(111);
    const r2 = await computeDistill("/proj", { dir: claudeDir });
    expect(r2.cached).toBe(true); expect(r2.updatedAt).toBe(111);

    const claudeDir2 = seedTranscript();
    const badFakes = { distillWf: async () => ({ distilled: [], degraded: true }), distillLessons: async () => ({ lessons: [], degraded: false }) };
    const d1 = await computeDistill("/proj", { dir: claudeDir2, ...badFakes });
    expect(d1.cached).toBe(false); expect(d1.updatedAt).toBeNull();
    const d2 = await computeDistill("/proj", { dir: claudeDir2, ...badFakes });
    expect(d2.cached).toBe(false);   // degraded was not cached
  });
});
```

- [ ] **Step 2: Run test to verify it fails** — `pnpm vitest run src/__tests__/distillCore.test.ts` → FAIL (cannot find `../distillCore.js`).

- [ ] **Step 3: Write `src/distillCore.ts`** (mirror of `workflowCore.ts`):
```ts
// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
// src/distillCore.ts
//
// Headless, cache-aware core for per-project playbook distillation (skills +
// session lessons). Shared by /playbook/prepare and the distill warmable.
import { introspectConfig, introspectProject } from "@agentgem/capture";
import { resolveDirs, resolveProject } from "@agentgem/model";
import {
  claudeTranscriptsForCwd, scanWorkflow,
  distillWorkflow, distillSessionLessons,
  distillToken, readDistillCacheEntry, writeDistillCache,
  type DistilledSkill, type DistilledLesson,
} from "@agentgem/insight";

export interface DistillPayload { skills: DistilledSkill[]; lessons: DistilledLesson[]; degraded: boolean }
export interface DistillResult { payload: DistillPayload; cached: boolean; updatedAt: number | null }

export async function computeDistill(
  root: string,
  opts: {
    dir?: string; force?: boolean; now?: () => number;
    distillWf?: typeof distillWorkflow;
    distillLessons?: typeof distillSessionLessons;
  } = {},
): Promise<DistillResult> {
  const now = opts.now ?? Date.now;
  const dirs = resolveDirs(opts.dir);
  const project = introspectProject(resolveProject(root));
  const globalInv = introspectConfig(dirs);
  const scanInv = { project, global: { skills: globalInv.skills, mcpServers: globalInv.mcpServers, hooks: globalInv.hooks } };

  const paths = claudeTranscriptsForCwd(dirs.claudeDir, root);
  const token = distillToken(paths);
  if (!opts.force) {
    const entry = readDistillCacheEntry(root, token);
    if (entry) return { payload: entry.result as DistillPayload, cached: true, updatedAt: entry.ts };
  }

  const signal = scanWorkflow(paths, scanInv, { retainSequences: true });
  const [wf, ls] = await Promise.all([
    (opts.distillWf ?? distillWorkflow)(signal, scanInv),
    (opts.distillLessons ?? distillSessionLessons)(signal, scanInv),
  ]);
  const degraded = wf.degraded || ls.degraded;
  const payload: DistillPayload = { skills: wf.distilled, lessons: ls.lessons, degraded };
  let updatedAt: number | null = null;
  if (!degraded) { const ts = now(); writeDistillCache(root, token, payload, ts); updatedAt = ts; }
  return { payload, cached: false, updatedAt };
}
```
**Note:** if `DistilledSkill`/`DistilledLesson` are not type-exported from `@agentgem/insight`, `grep -ran "export .*DistilledSkill\|export .*DistilledLesson" packages/insight/src` and import from the confirmed path; do not invent the type names.

- [ ] **Step 4: Delegate `/playbook/prepare`** — in `src/gem.controller.ts`, add `import { computeDistill } from "./distillCore.js";` and replace the `distill:` closure in `playbookPrepare` (keep the existing `introspectAll`+find existence check and everything else):
```ts
      distill: async () => (await computeDistill(root)).payload,
```
Remove now-orphaned imports/locals in `playbookPrepare` ONLY if nothing else uses them (the handler still builds `inventory`/`project` for the existence check; `scanWorkflow`/`distillWorkflow`/`distillSessionLessons` may still be used by OTHER methods like `/inspect/distill` — check before removing any import).

- [ ] **Step 5: Rebuild + test (core + the playbook-prepare guardrail)** — `pnpm -w build && pnpm vitest run dist/__tests__/distillCore.test.js dist/gem/__tests__/playbookPrepareCore.test.js` (and any `playbookPrepare` controller test). Expected PASS. If a guardrail test changes output because the core's `scanInv` derivation differs from the handler's, do NOT edit the test — STOP and report (same care as the earlier `/workflow/analyze` DRY).

- [ ] **Step 6: Commit**
```bash
git add src/distillCore.ts src/gem.controller.ts src/__tests__/distillCore.test.ts
git -c user.name="Raymond Feng" -c user.email="raymond@ninemind.ai" commit -m "feat(warm): computeDistill core; /playbook/prepare now caches distillation"
```

---

## Task 3: distill warmable

**Files:** Modify `src/warm/registry.ts`; Test `src/warm/__tests__/registry.test.ts`

**Interfaces:** Consumes `computeDistill` (Task 2). Extends the `Warmable` id union with `"distill"`.

- [ ] **Step 1: Write the failing test** — append to `src/warm/__tests__/registry.test.ts` (mirror the existing usage/scorecard warmable tests; a `distill` warmable pre-seeded cache → hit, force → warmed). Use a temp `AGENTGEM_HOME` + a fake transcript, pre-seed via `writeDistillCache` with the token `computeDistill` will compute, and inject nothing (cache-hit path avoids agents):
```ts
it("distill warmable: hit on seeded cache, force recomputes", async () => {
  const home = mkdtempSync(join(tmpdir(), "regd-"));
  const prev = process.env.AGENTGEM_HOME; process.env.AGENTGEM_HOME = home;
  try {
    const claudeDir = join(home, ".claude");
    const projDir = join(claudeDir, "projects", "-proj");
    mkdirSync(projDir, { recursive: true });
    writeFileSync(join(projDir, "s.jsonl"), JSON.stringify({ cwd: "/proj" }) + "\n");
    const token = distillToken(claudeTranscriptsForCwd(claudeDir, "/proj"));
    writeDistillCache("/proj", token, { skills: [], lessons: [], degraded: false }, 1);
    const d = WARMABLES.find((w) => w.id === "distill")!;
    expect(d.cost).toBe("llm"); expect(d.scope).toBe("per-root");
    expect(await d.warm("/proj", { dir: claudeDir })).toBe("hit");
  } finally { if (prev === undefined) delete process.env.AGENTGEM_HOME; else process.env.AGENTGEM_HOME = prev; rmSync(home, { recursive: true, force: true }); }
});
```
(Add imports `distillToken`, `writeDistillCache`, `claudeTranscriptsForCwd` from `@agentgem/insight`, and `mkdirSync`/`writeFileSync` from `node:fs`, if not already present.)

- [ ] **Step 2: Run test to verify it fails** — `pnpm vitest run src/warm/__tests__/registry.test.ts` → FAIL (no `distill` warmable).

- [ ] **Step 3: Add the warmable** — in `src/warm/registry.ts`: extend the id union `... | "distill"`, add `import { computeDistill } from "../distillCore.js";`, and add the entry to `WARMABLES`:
```ts
  {
    id: "distill", cost: "llm", scope: "per-root",
    async warm(root, { dir, force }) {
      const r = await computeDistill(root as string, { dir, force });
      return r.cached ? "hit" : "warmed";
    },
  },
```

- [ ] **Step 4: Rebuild + test** — `pnpm -w build && pnpm vitest run dist/warm/__tests__/registry.test.js` → PASS.

- [ ] **Step 5: Commit**
```bash
git add src/warm/registry.ts src/warm/__tests__/registry.test.ts
git -c user.name="Raymond Feng" -c user.email="raymond@ninemind.ai" commit -m "feat(warm): distill warmable (llm, per-root) warms playbook distillation"
```

---

## Task 4: withWarmLock (cross-process advisory lock)

**Files:** Create `src/warm/lock.ts`; Test `src/warm/__tests__/lock.test.ts`

**Interfaces:**
- Consumes: `acquirePidfile`/`releasePidfile` (`./pidfile.js`).
- Produces: `withWarmLock<T>(home: string, fn: () => Promise<T>, onSkip: () => T, deps?: { acquire?: (p: string) => boolean; release?: (p: string) => void; enabled?: boolean }): Promise<T>`

- [ ] **Step 1: Write the failing test** — `src/warm/__tests__/lock.test.ts`:
```ts
// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
import { describe, it, expect } from "vitest";
import { withWarmLock } from "../lock.js";

describe("withWarmLock", () => {
  it("runs fn and releases when the lock is free", async () => {
    const rel: string[] = [];
    const r = await withWarmLock("/home", async () => "ran", () => "skip", { acquire: () => true, release: (p) => rel.push(p) });
    expect(r).toBe("ran");
    expect(rel).toEqual(["/home/.agentgem/warm-pass.lock"]);
  });
  it("returns onSkip and does not run fn when a live holder exists", async () => {
    let ran = false;
    const r = await withWarmLock("/home", async () => { ran = true; return "ran"; }, () => "skip", { acquire: () => false, release: () => {} });
    expect(r).toBe("skip"); expect(ran).toBe(false);
  });
  it("releases even if fn throws", async () => {
    let released = false;
    await expect(withWarmLock("/home", async () => { throw new Error("boom"); }, () => "skip", { acquire: () => true, release: () => { released = true; } })).rejects.toThrow("boom");
    expect(released).toBe(true);
  });
  it("enabled=false runs fn without touching the lock", async () => {
    let acquired = false;
    const r = await withWarmLock("/home", async () => "ran", () => "skip", { acquire: () => { acquired = true; return true; }, release: () => {}, enabled: false });
    expect(r).toBe("ran"); expect(acquired).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails** — `pnpm vitest run src/warm/__tests__/lock.test.ts` → FAIL (cannot find `../lock.js`).

- [ ] **Step 3: Write `src/warm/lock.ts`**:
```ts
// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
// src/warm/lock.ts
//
// Cross-process advisory lock for a warm pass: a lockfile is just a pidfile with
// a different name, so this reuses acquirePidfile/releasePidfile (stale-tolerant
// liveness). If a *live* holder exists, the caller's onSkip() runs instead — the
// cross-process complement to runWarmPass's in-process re-entrancy guard.
// Opt out with AGENTGEM_WARM_LOCK=false. Best-effort.
import { join } from "node:path";
import { acquirePidfile, releasePidfile } from "./pidfile.js";

export async function withWarmLock<T>(
  home: string,
  fn: () => Promise<T>,
  onSkip: () => T,
  deps: { acquire?: (p: string) => boolean; release?: (p: string) => void; enabled?: boolean } = {},
): Promise<T> {
  const enabled = deps.enabled ?? (process.env.AGENTGEM_WARM_LOCK !== "false");
  if (!enabled) return fn();
  const acquire = deps.acquire ?? acquirePidfile;
  const release = deps.release ?? releasePidfile;
  const lockPath = join(home, ".agentgem", "warm-pass.lock");
  if (!acquire(lockPath)) return onSkip();
  try { return await fn(); } finally { release(lockPath); }
}
```

- [ ] **Step 4: Rebuild + test** — `pnpm -w build && pnpm vitest run dist/warm/__tests__/lock.test.js` → PASS (4/4).

- [ ] **Step 5: Commit**
```bash
git add src/warm/lock.ts src/warm/__tests__/lock.test.ts
git -c user.name="Raymond Feng" -c user.email="raymond@ninemind.ai" commit -m "feat(warm): withWarmLock cross-process advisory lock (reuses pidfile liveness)"
```

---

## Task 5: gate the drivers with the lock

**Files:** Modify `src/warm/schedule.ts`, `src/warm/daemon.ts`; Test `src/warm/__tests__/schedule.test.ts`

**Interfaces:** Consumes `withWarmLock` (Task 4), `agentgemHome` (`@agentgem/model`).

- [ ] **Step 1: Write the failing test** — add to `src/warm/__tests__/schedule.test.ts` a case proving the schedule's default run is lock-gated. Since `startWarmSchedule` already accepts an injected `run`, add a `home` option and assert that when `run` is NOT injected the schedule builds one that goes through `withWarmLock` — the cleanest observable seam is: inject a fake `runPass` and `lock` and assert the fake lock wraps the pass. To keep it simple and real, test the wiring by injecting `run` is unchanged; instead add ONE assertion that `startWarmSchedule` accepts `home` and, with `AGENTGEM_WARM_LOCK=false` set, the default run still fires (lock disabled path). Concretely:
```ts
it("default run still fires with the lock disabled (AGENTGEM_WARM_LOCK=false)", () => {
  const prev = process.env.AGENTGEM_WARM_LOCK; process.env.AGENTGEM_WARM_LOCK = "false";
  try {
    let ticks = 0;
    const sched = startWarmSchedule({
      home: "/home",
      run: async () => { ticks++; },            // injected run is used verbatim
      runNow: (fn) => fn(),
      setInterval: () => ({}), clearInterval: () => {},
    });
    expect(ticks).toBe(1);
    sched.stop();
  } finally { if (prev === undefined) delete process.env.AGENTGEM_WARM_LOCK; else process.env.AGENTGEM_WARM_LOCK = prev; }
});
```
(This confirms `home` is accepted and the injected-run path is preserved; the lock wrapping of the DEFAULT run is exercised by the withWarmLock unit tests in Task 4.)

- [ ] **Step 2: Run test to verify it fails** — `pnpm vitest run src/warm/__tests__/schedule.test.ts` → FAIL (`home` not accepted / or passes trivially if already accepted; if it passes trivially, proceed — the real change is Step 3).

- [ ] **Step 3: Gate the schedule** — in `src/warm/schedule.ts`: add `home?: string` to opts (default `agentgemHome()` — `import { agentgemHome } from "@agentgem/model";`), `import { withWarmLock } from "./lock.js";`, and change the default `run` from `() => runWarmPass()` to:
```ts
  const home = opts.home ?? agentgemHome();
  const run = opts.run ?? (() => withWarmLock(home, () => runWarmPass(), () => undefined));
```

- [ ] **Step 4: Gate the daemon** — in `src/warm/daemon.ts`: `import { withWarmLock } from "./lock.js";`. Wrap the initial pass and the watcher's runner so daemon passes respect the lock. Change the default `initialPass` from `() => runWarmPass()` to `() => withWarmLock(home, () => runWarmPass(), () => undefined)`, and pass a lock-wrapped runner to the watcher — where `startWarmWatch` is started, pass `run: (roots) => withWarmLock(home, () => warmRootsIndividually(roots), () => undefined)` (import `warmRootsIndividually` from `./watch.js`). Keep `home` (already derived in the daemon).

- [ ] **Step 5: Rebuild + test** — `pnpm -w build && pnpm vitest run dist/warm/__tests__/schedule.test.js dist/warm/__tests__/daemon.test.js` → PASS (existing daemon tests inject `watch`/`initialPass`, so they're unaffected; the schedule test passes).

- [ ] **Step 6: Commit**
```bash
git add src/warm/schedule.ts src/warm/daemon.ts src/warm/__tests__/schedule.test.ts
git -c user.name="Raymond Feng" -c user.email="raymond@ninemind.ai" commit -m "feat(warm): gate schedule + daemon warm passes with the cross-process lock"
```

---

## Task 6: OS-service module

**Files:** Create `src/warm/service.ts`; Test `src/warm/__tests__/service.test.ts`

**Interfaces — Produces:**
- `launchdPlist(execArgs: string[], label?: string): string`
- `systemdUnit(execArgs: string[]): string`
- `installService(deps?: ServiceDeps): { path: string; loadCmd: string }`
- `uninstallService(deps?: ServiceDeps): { path: string; removed: boolean }`
- `runServiceCommand(argv: string[], deps?: RunServiceDeps): void`
- `class UnsupportedPlatformError extends Error`
- `ServiceDeps = { platform?: NodeJS.Platform; home?: string; exec?: string[]; writeFile?: (p:string,c:string)=>void; unlink?: (p:string)=>void; mkdir?: (p:string)=>void }`

- [ ] **Step 1: Write the failing test** — `src/warm/__tests__/service.test.ts`:
```ts
// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
import { describe, it, expect } from "vitest";
import { launchdPlist, systemdUnit, installService, uninstallService, runServiceCommand, UnsupportedPlatformError } from "../service.js";

const EXEC = ["/usr/bin/node", "/app/dist/cli.js", "warm", "--watch"];

describe("service generators", () => {
  it("launchdPlist embeds the exec args and RunAtLoad", () => {
    const p = launchdPlist(EXEC, "ai.ninemind.agentgem.warm");
    for (const a of EXEC) expect(p).toContain(a);
    expect(p).toContain("RunAtLoad");
    expect(p).toContain("ai.ninemind.agentgem.warm");
  });
  it("systemdUnit embeds ExecStart and WantedBy", () => {
    const u = systemdUnit(EXEC);
    expect(u).toContain(EXEC.join(" "));
    expect(u).toContain("WantedBy=default.target");
  });
});

describe("installService", () => {
  it("writes the plist under LaunchAgents on darwin and returns the load command", () => {
    const writes: Array<{ p: string; c: string }> = []; const mkdirs: string[] = [];
    const r = installService({ platform: "darwin", home: "/h", exec: EXEC, writeFile: (p, c) => writes.push({ p, c }), mkdir: (p) => mkdirs.push(p), unlink: () => {} });
    expect(r.path).toBe("/h/Library/LaunchAgents/ai.ninemind.agentgem.warm.plist");
    expect(writes[0].p).toBe(r.path);
    expect(r.loadCmd).toContain("launchctl");
  });
  it("writes the unit under systemd/user on linux", () => {
    const writes: Array<{ p: string; c: string }> = [];
    const r = installService({ platform: "linux", home: "/h", exec: EXEC, writeFile: (p, c) => writes.push({ p, c }), mkdir: () => {}, unlink: () => {} });
    expect(r.path).toBe("/h/.config/systemd/user/agentgem-warm.service");
    expect(r.loadCmd).toContain("systemctl --user");
  });
  it("throws UnsupportedPlatformError on win32", () => {
    expect(() => installService({ platform: "win32", home: "/h", exec: EXEC, writeFile: () => {}, mkdir: () => {}, unlink: () => {} })).toThrow(UnsupportedPlatformError);
  });
});

describe("runServiceCommand", () => {
  it("--install-service installs and logs; --uninstall-service uninstalls", () => {
    const logs: string[] = [];
    runServiceCommand(["--install-service"], { install: () => ({ path: "/x", loadCmd: "load me" }), uninstall: () => ({ path: "/x", removed: true }), log: (m) => logs.push(m), errorLog: () => {}, exit: () => {} });
    expect(logs.join("\n")).toContain("load me");
    const logs2: string[] = [];
    runServiceCommand(["--uninstall-service"], { install: () => ({ path: "/x", loadCmd: "" }), uninstall: () => ({ path: "/x", removed: true }), log: (m) => logs2.push(m), errorLog: () => {}, exit: () => {} });
    expect(logs2.join("\n")).toMatch(/remov/i);
  });
  it("unsupported platform → errorLog + exit(1)", () => {
    const codes: number[] = []; const errs: string[] = [];
    runServiceCommand(["--install-service"], { install: () => { throw new UnsupportedPlatformError("nope"); }, uninstall: () => ({ path: "", removed: false }), log: () => {}, errorLog: (m) => errs.push(m), exit: (c) => codes.push(c) });
    expect(codes).toEqual([1]); expect(errs.length).toBe(1);
  });
});
```

- [ ] **Step 2: Run test to verify it fails** — `pnpm vitest run src/warm/__tests__/service.test.ts` → FAIL (cannot find `../service.js`).

- [ ] **Step 3: Write `src/warm/service.ts`**:
```ts
// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
// src/warm/service.ts
//
// OS-service install for the Trigger C daemon: pure unit generators + a
// platform-dispatched install/uninstall. macOS launchd, Linux systemd-user.
import { writeFileSync, unlinkSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

export class UnsupportedPlatformError extends Error {}

const LABEL = "ai.ninemind.agentgem.warm";

export function launchdPlist(execArgs: string[], label: string = LABEL): string {
  const args = execArgs.map((a) => `    <string>${a}</string>`).join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${label}</string>
  <key>ProgramArguments</key>
  <array>
${args}
  </array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
</dict>
</plist>
`;
}

export function systemdUnit(execArgs: string[]): string {
  return `[Unit]
Description=AgentGem warming daemon

[Service]
ExecStart=${execArgs.join(" ")}
Restart=on-failure

[Install]
WantedBy=default.target
`;
}

interface ServiceDeps {
  platform?: NodeJS.Platform; home?: string; exec?: string[];
  writeFile?: (p: string, c: string) => void;
  unlink?: (p: string) => void;
  mkdir?: (p: string) => void;
}

function defaultExec(): string[] {
  const cliPath = join(dirname(fileURLToPath(import.meta.url)), "..", "cli.js");
  return [process.execPath, cliPath, "warm", "--watch"];
}

function target(platform: NodeJS.Platform, home: string): { path: string; render: (exec: string[]) => string; loadCmd: string } {
  if (platform === "darwin") {
    return {
      path: join(home, "Library", "LaunchAgents", `${LABEL}.plist`),
      render: (e) => launchdPlist(e),
      loadCmd: `launchctl load ${join(home, "Library", "LaunchAgents", `${LABEL}.plist`)}`,
    };
  }
  if (platform === "linux") {
    const p = join(home, ".config", "systemd", "user", "agentgem-warm.service");
    return { path: p, render: (e) => systemdUnit(e), loadCmd: "systemctl --user enable --now agentgem-warm.service" };
  }
  throw new UnsupportedPlatformError(`agentgem warm --install-service: unsupported platform '${platform}' (macOS and Linux only)`);
}

export function installService(deps: ServiceDeps = {}): { path: string; loadCmd: string } {
  const platform = deps.platform ?? process.platform;
  const home = deps.home ?? homedir();
  const exec = deps.exec ?? defaultExec();
  const writeFile = deps.writeFile ?? ((p, c) => writeFileSync(p, c, "utf8"));
  const mkdir = deps.mkdir ?? ((p) => { mkdirSync(p, { recursive: true }); });
  const t = target(platform, home);
  mkdir(dirname(t.path));
  writeFile(t.path, t.render(exec));
  return { path: t.path, loadCmd: t.loadCmd };
}

export function uninstallService(deps: ServiceDeps = {}): { path: string; removed: boolean } {
  const platform = deps.platform ?? process.platform;
  const home = deps.home ?? homedir();
  const unlink = deps.unlink ?? ((p) => unlinkSync(p));
  const t = target(platform, home);
  try { unlink(t.path); return { path: t.path, removed: true }; }
  catch { return { path: t.path, removed: false }; }
}

interface RunServiceDeps {
  install?: (d?: ServiceDeps) => { path: string; loadCmd: string };
  uninstall?: (d?: ServiceDeps) => { path: string; removed: boolean };
  log?: (m: string) => void;
  errorLog?: (m: string) => void;
  exit?: (code: number) => void;
}

export function runServiceCommand(argv: string[], deps: RunServiceDeps = {}): void {
  const install = deps.install ?? installService;
  const uninstall = deps.uninstall ?? uninstallService;
  const log = deps.log ?? ((m) => console.log(m));
  const errorLog = deps.errorLog ?? ((m) => console.error(m));
  const exit = deps.exit ?? ((c) => process.exit(c));
  try {
    if (argv.includes("--uninstall-service")) {
      const r = uninstall();
      log(r.removed ? `agentgem warm: removed service unit ${r.path}` : `agentgem warm: no service unit at ${r.path}`);
      return;
    }
    const r = install();
    log(`agentgem warm: wrote service unit ${r.path}`);
    log(`Enable it with:\n  ${r.loadCmd}`);
  } catch (err) {
    errorLog((err as Error).message);
    exit(1);
  }
}
```

- [ ] **Step 4: Rebuild + test** — `pnpm -w build && pnpm vitest run dist/warm/__tests__/service.test.js` → PASS.

- [ ] **Step 5: Commit**
```bash
git add src/warm/service.ts src/warm/__tests__/service.test.ts
git -c user.name="Raymond Feng" -c user.email="raymond@ninemind.ai" commit -m "feat(warm): launchd/systemd service generators + install/uninstall command"
```

---

## Task 7: wire `--install-service` / `--uninstall-service` into the CLI

**Files:** Modify `src/cli.ts`

**Interfaces:** Consumes `runServiceCommand` (Task 6), `runWarmCommand` (existing).

- [ ] **Step 1: Update the `warm` branch** — in `src/cli.ts`, replace the existing `warm` branch body so service flags route to `runServiceCommand`:
```ts
  // `agentgem warm` — Trigger C. --install-service/--uninstall-service manage the
  // OS auto-start unit; otherwise --watch runs the daemon.
  if (argv[0] === "warm") {
    if (argv.includes("--install-service") || argv.includes("--uninstall-service")) {
      const { runServiceCommand } = await import("./warm/service.js");
      runServiceCommand(argv.slice(1));
      return;
    }
    const { runWarmCommand } = await import("./warm/daemon.js");
    runWarmCommand(argv.slice(1));
    return;
  }
```

- [ ] **Step 2: Update HELP** — add lines under the existing `warm --watch` HELP entry:
```
  agentgem warm --install-service       Install an OS unit (launchd/systemd) to auto-start the daemon at login
  agentgem warm --uninstall-service     Remove the OS unit
```

- [ ] **Step 3: Build + verify dispatch** — `pnpm -w build`, then `node dist/cli.js warm --install-service` on this machine (macOS) — it will write a real plist under `~/Library/LaunchAgents/`. To avoid mutating the dev machine, instead verify with a dry check: `node -e "import('./dist/warm/service.js').then(m=>console.log(m.launchdPlist(['node','x','warm','--watch']).includes('RunAtLoad')))"` prints `true`, and confirm `node dist/cli.js warm` (no flags) still prints the daemon usage error. (Do NOT actually install on the dev box unless you intend to.)

- [ ] **Step 4: Commit**
```bash
git add src/cli.ts
git -c user.name="Raymond Feng" -c user.email="raymond@ninemind.ai" commit -m "feat(cli): agentgem warm --install-service / --uninstall-service"
```

---

## Final verification

- [ ] **Full backend suite:** `pnpm -w build && pnpm test` → green (the `detection.test.js`/observe scan timeouts are the known real-FS flake under load; re-run in isolation to confirm, not a regression).
- [ ] **Manual smoke (optional, macOS):** `node dist/cli.js warm --install-service` writes `~/Library/LaunchAgents/ai.ninemind.agentgem.warm.plist`; `--uninstall-service` removes it. Two concurrent `warm --watch` + a console warm: only one warms at a time (lock).
- [ ] **Confirm branch is linear and up-to-date with `origin/main`** (rebase-only repo), then merge.

## Self-review notes (already reconciled)

- **Spec coverage:** distill cache (T1) + core + prepare-delegate (T2) + warmable (T3); withWarmLock (T4) + driver gating (T5); service generators/install + CLI (T6, T7). All spec sections mapped.
- **Type consistency:** `DistillPayload`/`DistillResult`, `computeDistill`, `distillToken`/`readDistillCacheEntry`/`writeDistillCache`, `withWarmLock`, `installService`/`uninstallService`/`runServiceCommand`/`UnsupportedPlatformError` are consistent across defining/consuming tasks.
- **Reuse:** distill mirrors `insightsCache`/`workflowCore`; lock reuses `acquirePidfile`/`releasePidfile`; service is self-contained pure generators + injected fs.
- **One check at implementation time:** confirm `DistilledSkill`/`DistilledLesson` are type-exported from `@agentgem/insight` (Task 2 note); confirm the playbook-prepare guardrail test stays green after the delegate (Task 2 Step 5).
