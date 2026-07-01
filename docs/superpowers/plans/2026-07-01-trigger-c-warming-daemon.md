# Trigger C — Standalone Warming Daemon Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A standalone `agentgem warm --watch` daemon that watches `~/.claude/projects`, debounces changes, and drives the existing `runWarmPass` targeted at the changed project — keeping caches warm even when the console is closed.

**Architecture:** A driver, not new warming logic. `fs.watch` (recursive, debounced) → map changed transcripts to project roots → `runWarmPass({ roots:[root], topN:1 })`. Cache writes are hardened to atomic temp+rename so the daemon and a running console never corrupt a cache file. Wired as a CLI subcommand with a pidfile singleton.

**Tech Stack:** TypeScript (ESM, `node:` built-ins: `fs.watch`, `renameSync`, `process.kill`), Vitest, the `@agentgem/*` packages, the existing `runWarmPass` engine.

## Global Constraints

- **Driver only:** no new cache/compute logic; reuse `runWarmPass` and existing transcript helpers.
- **Best-effort, never throws / never crashes the daemon:** every fs op, path parse, and warm is wrapped; a failure logs and the loop continues. Matches the cache-layer ethos.
- **No new dependencies:** native `fs.watch`, no `chokidar`.
- **All I/O injectable in tests; use a temp `AGENTGEM_HOME`; never scan the real `~/.claude`.** Backend tests run against compiled `dist/` — run `pnpm -w build` before `pnpm vitest run dist/...`.
- **Copyright header** on every new `.ts` file: `// Copyright (c) 2026 NineMind, Inc.` then `// SPDX-License-Identifier: MIT`.
- **Git identity:** `Raymond Feng <raymond@ninemind.ai>` (use `git -c user.name=... -c user.email=...`).
- **Debounce default 2500ms; targeted warm uses `topN:1`; one full `runWarmPass()` on startup.**

## File structure

| File | Responsibility |
|---|---|
| `packages/model/src/atomicWrite.ts` (new) | `writeJsonAtomic(path, data)` — temp+rename atomic write |
| `packages/insight/src/insightsCache.ts` · `analysisCache.ts`, `packages/capture/src/usageCache.ts` (modify) | use `writeJsonAtomic` |
| `src/warm/pidfile.ts` (new) | `acquirePidfile` / `releasePidfile` (liveness via `process.kill(pid,0)`) |
| `src/warm/watch.ts` (new) | debounced fs.watch → changed roots → runner |
| `src/warm/daemon.ts` (new) | pidfile + initial pass + watcher; `runWarmCommand` CLI entry |
| `src/cli.ts` (modify) | `agentgem warm --watch` subcommand + HELP |

---

## Task 1: Atomic JSON writes

**Files:**
- Create: `packages/model/src/atomicWrite.ts`
- Modify: `packages/model/src/index.ts` (barrel already uses `export *`; add the new file)
- Modify: `packages/insight/src/insightsCache.ts`, `packages/insight/src/analysisCache.ts`, `packages/capture/src/usageCache.ts`
- Test: `src/__tests__/atomicWrite.test.ts`

**Interfaces:**
- Produces: `writeJsonAtomic(path: string, data: unknown): void` — best-effort, never throws; leaves no `.tmp` file on success.

- [ ] **Step 1: Write the failing test**

Create `src/__tests__/atomicWrite.test.ts`:
```ts
// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeJsonAtomic } from "@agentgem/model";

let dir: string | undefined;
afterEach(() => { if (dir) rmSync(dir, { recursive: true, force: true }); dir = undefined; });

describe("writeJsonAtomic", () => {
  it("writes valid JSON, overwrites, and leaves no temp file", () => {
    dir = mkdtempSync(join(tmpdir(), "aw-"));
    const p = join(dir, "sub", "cache.json");   // parent dir does not exist yet
    writeJsonAtomic(p, { a: 1 });
    expect(JSON.parse(readFileSync(p, "utf8"))).toEqual({ a: 1 });
    writeJsonAtomic(p, { a: 2, b: [3] });
    expect(JSON.parse(readFileSync(p, "utf8"))).toEqual({ a: 2, b: [3] });
    // no leftover *.tmp in the directory
    expect(readdirSync(join(dir, "sub")).filter((f) => f.includes(".tmp"))).toEqual([]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run src/__tests__/atomicWrite.test.ts`
Expected: FAIL — `writeJsonAtomic is not a function` (not exported yet).

- [ ] **Step 3: Create `packages/model/src/atomicWrite.ts`**
```ts
// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
// packages/model/src/atomicWrite.ts
//
// Atomic JSON write: serialize to a per-process temp file in the same directory,
// then rename() over the target (atomic on one filesystem). Two processes writing
// the same cache never corrupt it — each uses a distinct temp path and the final
// rename is atomic; last writer wins. Best-effort: failures never throw.
import { writeFileSync, renameSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

export function writeJsonAtomic(path: string, data: unknown): void {
  try {
    mkdirSync(dirname(path), { recursive: true });
    const tmp = `${path}.${process.pid}.tmp`;   // per-process temp avoids cross-process collision
    writeFileSync(tmp, JSON.stringify(data), "utf8");
    renameSync(tmp, path);
  } catch { /* best-effort */ }
}
```

- [ ] **Step 4: Export from the model barrel**

In `packages/model/src/index.ts`, add next to the other `export *` lines:
```ts
export * from "./atomicWrite.js";
```

- [ ] **Step 5: Adopt in the three cache writers**

In `packages/insight/src/insightsCache.ts` — replace the body of `writeInsightsCache` so the final persist uses the atomic helper. The current tail is:
```ts
    const path = cachePath();
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify(all.slice(0, MAX_ENTRIES)), "utf8");
```
Replace those three lines with:
```ts
    writeJsonAtomic(cachePath(), all.slice(0, MAX_ENTRIES));
```
Add the import `import { agentgemHome, writeJsonAtomic } from "@agentgem/model";` (extend the existing `@agentgem/model` import). Remove now-unused `writeFileSync`/`mkdirSync`/`dirname` imports **only if** nothing else in the file uses them (check — `statSync` stays for the token; `readFileSync` stays for `readAll`).

Apply the identical change to `packages/insight/src/analysisCache.ts` (`writeAnalysisCache`).

In `packages/capture/src/usageCache.ts` — `writeGlobalUsageCache` currently:
```ts
    const path = cachePath();
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify({ token, result, claudeDir }), "utf8");
```
Replace with:
```ts
    writeJsonAtomic(cachePath(), { token, result, claudeDir });
```
Extend its `@agentgem/model` import with `writeJsonAtomic`; drop now-unused fs imports if orphaned.

- [ ] **Step 6: Rebuild and run tests (atomic + existing cache round-trips)**

Run: `pnpm -w build && pnpm vitest run src/__tests__/atomicWrite.test.js src/gem/__tests__/insightsCache.test.js src/gem/__tests__/analysisCache.test.js src/gem/__tests__/usageCache.test.js`
Expected: PASS (atomic test + the existing cache round-trip tests still green — proving the swap preserved behavior). Note the compiled `.js` paths.

- [ ] **Step 7: Commit**
```bash
git add packages/model/src/atomicWrite.ts packages/model/src/index.ts packages/insight/src/insightsCache.ts packages/insight/src/analysisCache.ts packages/capture/src/usageCache.ts src/__tests__/atomicWrite.test.ts
git -c user.name="Raymond Feng" -c user.email="raymond@ninemind.ai" commit -m "feat(warm): atomic (temp+rename) cache writes for multi-process safety"
```

---

## Task 2: Pidfile singleton

**Files:**
- Create: `src/warm/pidfile.ts`
- Test: `src/warm/__tests__/pidfile.test.ts`

**Interfaces:**
- Produces:
  - `acquirePidfile(path: string): boolean` — `true` if acquired (writes own pid); `false` if a live pid already holds it. Stale (dead) pid is overwritten.
  - `releasePidfile(path: string): void` — best-effort unlink.

- [ ] **Step 1: Write the failing test**

Create `src/warm/__tests__/pidfile.test.ts`:
```ts
// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { acquirePidfile, releasePidfile } from "../pidfile.js";

let dir: string | undefined;
afterEach(() => { if (dir) rmSync(dir, { recursive: true, force: true }); dir = undefined; });

describe("pidfile", () => {
  it("acquires a free path, then blocks a second acquire (own live pid), and release frees it", () => {
    dir = mkdtempSync(join(tmpdir(), "pid-"));
    const p = join(dir, ".agentgem", "warm.pid");
    expect(acquirePidfile(p)).toBe(true);      // free → acquired (writes process.pid)
    expect(acquirePidfile(p)).toBe(false);     // our own pid is alive → blocked
    releasePidfile(p);
    expect(existsSync(p)).toBe(false);
    expect(acquirePidfile(p)).toBe(true);      // free again
  });

  it("overwrites a stale (dead) pid", () => {
    dir = mkdtempSync(join(tmpdir(), "pid2-"));
    const p = join(dir, "warm.pid");
    writeFileSync(p, "999999999");             // a pid that is not alive
    expect(acquirePidfile(p)).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run src/warm/__tests__/pidfile.test.ts`
Expected: FAIL — cannot find module `../pidfile.js`.

- [ ] **Step 3: Write `src/warm/pidfile.ts`**
```ts
// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
// src/warm/pidfile.ts
//
// Best-effort singleton lock for the warm daemon. acquirePidfile writes the
// current pid unless a *live* pid already holds the file; a stale pid (dead
// process) is overwritten. Never throws.
import { readFileSync, writeFileSync, unlinkSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

function isAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

export function acquirePidfile(path: string): boolean {
  try {
    const pid = Number(readFileSync(path, "utf8").trim());
    if (Number.isInteger(pid) && pid > 0 && isAlive(pid)) return false;   // live holder
  } catch { /* no/unreadable file → treat as free */ }
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, String(process.pid), "utf8");
    return true;
  } catch { return false; }
}

export function releasePidfile(path: string): void {
  try { unlinkSync(path); } catch { /* ignore */ }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm -w build && pnpm vitest run dist/warm/__tests__/pidfile.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**
```bash
git add src/warm/pidfile.ts src/warm/__tests__/pidfile.test.ts
git -c user.name="Raymond Feng" -c user.email="raymond@ninemind.ai" commit -m "feat(warm): pidfile singleton for the warm daemon"
```

---

## Task 3: Watcher (debounce → roots → run)

**Files:**
- Create: `src/warm/watch.ts`
- Test: `src/warm/__tests__/watch.test.ts`

**Interfaces:**
- Consumes: `runWarmPass` (`./orchestrator.js`), `bucketTranscriptsByCwd` (`@agentgem/insight`), `resolveDirs` (`@agentgem/model`).
- Produces:
  - `interface WarmWatch { stop(): void }`
  - `startWarmWatch(opts?: { claudeDir?: string; debounceMs?: number; watch?: WatchFn; setTimer?: (fn:()=>void, ms:number)=>unknown; clearTimer?: (h:unknown)=>void; run?: (roots:string[])=>Promise<unknown>; toRoots?: (claudeDir:string, files:string[])=>string[] }): WarmWatch`
    where `type WatchFn = (dir: string, cb: (evt: string, file: string | null) => void) => { close(): void }`
  - `mapFilesToRoots(claudeDir: string, changed: string[]): string[]` (exported for its own test)

- [ ] **Step 1: Write the failing tests**

Create `src/warm/__tests__/watch.test.ts`:
```ts
// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startWarmWatch, mapFilesToRoots } from "../watch.js";

let dir: string | undefined;
afterEach(() => { if (dir) rmSync(dir, { recursive: true, force: true }); dir = undefined; });

describe("startWarmWatch", () => {
  it("coalesces a burst of .jsonl events into one run and maps to roots", () => {
    let fire!: (evt: string, file: string | null) => void;
    let pendingTimer: (() => void) | null = null;
    const runs: string[][] = [];
    const w = startWarmWatch({
      claudeDir: "/x",
      watch: (_dir, cb) => { fire = cb; return { close() {} }; },
      setTimer: (fn) => { pendingTimer = fn; return 1; },
      clearTimer: () => { pendingTimer = null; },
      toRoots: (_cd, files) => files.map((f) => f.replace(/\/[^/]+\.jsonl$/, "")), // dir as "root"
      run: async (roots) => { runs.push(roots); },
    });
    fire("change", "-proj-a/s1.jsonl");
    fire("change", "-proj-a/s2.jsonl");     // same project, still within debounce
    fire("change", "-proj-b/s1.jsonl");
    fire("change", null);                    // ignored
    fire("change", "notes.txt");             // non-jsonl ignored
    expect(runs).toEqual([]);                // nothing ran yet (debounced)
    pendingTimer!();                          // fire the debounce
    expect(runs.length).toBe(1);
    expect(new Set(runs[0])).toEqual(new Set(["/x/projects/-proj-a", "/x/projects/-proj-b"]));
    w.stop();
  });

  it("stop() clears a pending timer so no run fires after stop", () => {
    let pendingTimer: (() => void) | null = null;
    let cleared = false;
    const runs: string[][] = [];
    let fire!: (evt: string, file: string | null) => void;
    const w = startWarmWatch({
      claudeDir: "/x",
      watch: (_dir, cb) => { fire = cb; return { close() {} }; },
      setTimer: (fn) => { pendingTimer = fn; return 1; },
      clearTimer: () => { cleared = true; pendingTimer = null; },
      toRoots: (_cd, files) => files,
      run: async (roots) => { runs.push(roots); },
    });
    fire("change", "-proj-a/s1.jsonl");
    w.stop();
    expect(cleared).toBe(true);
    expect(runs).toEqual([]);
  });

  it("mapFilesToRoots resolves a transcript's project root via its cwd", () => {
    dir = mkdtempSync(join(tmpdir(), "watch-"));
    const claudeDir = join(dir, ".claude");
    const projDir = join(claudeDir, "projects", "-proj");
    mkdirSync(projDir, { recursive: true });
    const f = join(projDir, "s.jsonl");
    writeFileSync(f, JSON.stringify({ cwd: "/proj" }) + "\n");
    expect(mapFilesToRoots(claudeDir, [f])).toEqual(["/proj"]);
    expect(mapFilesToRoots(claudeDir, [join(projDir, "gone.jsonl")])).toEqual([]); // unknown → skipped
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm vitest run src/warm/__tests__/watch.test.ts`
Expected: FAIL — cannot find module `../watch.js`.

- [ ] **Step 3: Write `src/warm/watch.ts`**
```ts
// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
// src/warm/watch.ts
//
// Trigger C's watch loop: recursively watch ~/.claude/projects, debounce a
// session's rapid appends, map changed transcripts to their project roots, and
// drive a targeted runWarmPass per changed root. Every external (fs.watch,
// timers, runner, root-mapping) is injectable so tests use zero real I/O.
import { watch as fsWatch } from "node:fs";
import { join, resolve } from "node:path";
import { resolveDirs } from "@agentgem/model";
import { bucketTranscriptsByCwd } from "@agentgem/insight";
import { runWarmPass } from "./orchestrator.js";

export interface WarmWatch { stop(): void }
type WatchFn = (dir: string, cb: (evt: string, file: string | null) => void) => { close(): void };

/** Map changed transcript file paths to their project roots (cwd), deduped.
 *  Reuses bucketTranscriptsByCwd (cwd read from each transcript); unknown → skipped. */
export function mapFilesToRoots(claudeDir: string, changed: string[]): string[] {
  let bucket: Map<string, string[]>;
  try { bucket = bucketTranscriptsByCwd(claudeDir); } catch { return []; }
  const fileToRoot = new Map<string, string>();
  for (const [root, paths] of bucket) for (const p of paths) fileToRoot.set(resolve(p), root);
  const roots = new Set<string>();
  for (const f of changed) { const r = fileToRoot.get(resolve(f)); if (r) roots.add(r); }
  return [...roots];
}

export function startWarmWatch(opts: {
  claudeDir?: string;
  debounceMs?: number;
  watch?: WatchFn;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (h: unknown) => void;
  run?: (roots: string[]) => Promise<unknown>;
  toRoots?: (claudeDir: string, files: string[]) => string[];
} = {}): WarmWatch {
  const claudeDir = opts.claudeDir ?? resolveDirs().claudeDir;
  const projectsDir = join(claudeDir, "projects");
  const debounceMs = opts.debounceMs ?? 2500;
  const watchFn: WatchFn = opts.watch ?? ((dir, cb) => fsWatch(dir, { recursive: true }, (evt, f) => cb(evt, f as string | null)));
  const setTimer = opts.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
  const clearTimer = opts.clearTimer ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>));
  const run = opts.run ?? ((roots) => runWarmPass({ roots, topN: 1 }));
  const toRoots = opts.toRoots ?? mapFilesToRoots;

  const pending = new Set<string>();
  let timer: unknown = null;

  const flush = () => {
    timer = null;
    const files = [...pending]; pending.clear();
    if (!files.length) return;
    const roots = toRoots(claudeDir, files);
    if (roots.length) void run(roots);
  };

  let sub: { close(): void };
  try {
    sub = watchFn(projectsDir, (_evt, file) => {
      if (!file || !file.endsWith(".jsonl")) return;
      pending.add(join(projectsDir, file));
      if (timer !== null) clearTimer(timer);
      timer = setTimer(flush, debounceMs);
    });
  } catch {
    sub = { close() {} };   // best-effort: if the dir can't be watched, stay a no-op
  }

  return { stop() { try { sub.close(); } catch { /* ignore */ } if (timer !== null) { clearTimer(timer); timer = null; } } };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm -w build && pnpm vitest run dist/warm/__tests__/watch.test.js`
Expected: PASS (all three cases).

- [ ] **Step 5: Commit**
```bash
git add src/warm/watch.ts src/warm/__tests__/watch.test.ts
git -c user.name="Raymond Feng" -c user.email="raymond@ninemind.ai" commit -m "feat(warm): debounced fs.watch watcher mapping changes to targeted warm passes"
```

---

## Task 4: Daemon (pidfile + initial pass + watcher) and CLI entry

**Files:**
- Create: `src/warm/daemon.ts`
- Test: `src/warm/__tests__/daemon.test.ts`

**Interfaces:**
- Consumes: `acquirePidfile`/`releasePidfile` (Task 2), `startWarmWatch` (Task 3), `runWarmPass`, `agentgemHome`.
- Produces:
  - `interface WarmDaemon { stop(): Promise<void> }`
  - `startWarmDaemon(opts?: { home?: string; onLog?: (m:string)=>void; watch?: typeof startWarmWatch; initialPass?: ()=>Promise<unknown> }): WarmDaemon | null` — `null` if a live daemon already holds the pidfile.
  - `runWarmCommand(argv: string[], deps?: { start?: typeof startWarmDaemon; log?: (m:string)=>void; errorLog?: (m:string)=>void; exit?: (code:number)=>void; on?: (sig:"SIGINT"|"SIGTERM", cb:()=>void)=>void }): WarmDaemon | null` — the testable CLI entry.

- [ ] **Step 1: Write the failing tests**

Create `src/warm/__tests__/daemon.test.ts`:
```ts
// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startWarmDaemon, runWarmCommand } from "../daemon.js";

let dir: string | undefined;
afterEach(() => { if (dir) rmSync(dir, { recursive: true, force: true }); dir = undefined; });

function fakeWatch() { let stopped = false; return Object.assign(() => ({ stop() { stopped = true; } }), { wasStopped: () => stopped }); }

describe("startWarmDaemon", () => {
  it("runs the initial pass once, starts the watcher, and blocks a second daemon via the pidfile", async () => {
    dir = mkdtempSync(join(tmpdir(), "dmn-"));
    let passes = 0;
    const first = startWarmDaemon({ home: dir, onLog: () => {}, watch: () => ({ stop() {} }), initialPass: async () => { passes++; } });
    expect(first).not.toBeNull();
    expect(passes).toBe(1);
    const second = startWarmDaemon({ home: dir, onLog: () => {}, watch: () => ({ stop() {} }), initialPass: async () => { passes++; } });
    expect(second).toBeNull();               // pidfile held by first (our own live pid)
    await first!.stop();                      // releases pidfile
    const third = startWarmDaemon({ home: dir, onLog: () => {}, watch: () => ({ stop() {} }), initialPass: async () => { passes++; } });
    expect(third).not.toBeNull();             // free again
    await third!.stop();
  });
});

describe("runWarmCommand", () => {
  it("errors + exits(1) without --watch", () => {
    const codes: number[] = []; const errs: string[] = [];
    const d = runWarmCommand([], { exit: (c) => codes.push(c), errorLog: (m) => errs.push(m), start: () => { throw new Error("should not start"); }, log: () => {}, on: () => {} });
    expect(d).toBeNull();
    expect(codes).toEqual([1]);
    expect(errs[0]).toMatch(/--watch/);
  });
  it("with --watch: starts, logs, registers signal handlers", () => {
    const sigs: string[] = []; const logs: string[] = [];
    const handle = { stop: async () => {} };
    const d = runWarmCommand(["--watch"], { start: () => handle, log: (m) => logs.push(m), errorLog: () => {}, exit: () => {}, on: (s) => sigs.push(s) });
    expect(d).toBe(handle);
    expect(logs.some((l) => /watching/i.test(l))).toBe(true);
    expect(new Set(sigs)).toEqual(new Set(["SIGINT", "SIGTERM"]));
  });
  it("with --watch but another daemon live: exits(0)", () => {
    const codes: number[] = [];
    const d = runWarmCommand(["--watch"], { start: () => null, exit: (c) => codes.push(c), log: () => {}, errorLog: () => {}, on: () => {} });
    expect(d).toBeNull();
    expect(codes).toEqual([0]);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm vitest run src/warm/__tests__/daemon.test.ts`
Expected: FAIL — cannot find module `../daemon.js`.

- [ ] **Step 3: Write `src/warm/daemon.ts`**
```ts
// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
// src/warm/daemon.ts
//
// Trigger C daemon: acquire a pidfile singleton, warm current state once, then
// watch for changes. runWarmCommand is the testable CLI entry (all process
// interaction injected). Best-effort; never throws out of the happy path.
import { join } from "node:path";
import { agentgemHome } from "@agentgem/model";
import { runWarmPass } from "./orchestrator.js";
import { startWarmWatch } from "./watch.js";
import { acquirePidfile, releasePidfile } from "./pidfile.js";

export interface WarmDaemon { stop(): Promise<void> }

export function startWarmDaemon(opts: {
  home?: string;
  onLog?: (m: string) => void;
  watch?: typeof startWarmWatch;
  initialPass?: () => Promise<unknown>;
} = {}): WarmDaemon | null {
  const home = opts.home ?? agentgemHome();
  const log = opts.onLog ?? ((m) => console.log(m));
  const startWatch = opts.watch ?? startWarmWatch;
  const initialPass = opts.initialPass ?? (() => runWarmPass());
  const pidPath = join(home, ".agentgem", "warm.pid");

  if (!acquirePidfile(pidPath)) { log("agentgem warm: another daemon is already running; exiting."); return null; }
  void initialPass();                        // fire-and-forget: warm current state
  const w = startWatch({});
  return { async stop() { try { w.stop(); } finally { releasePidfile(pidPath); } } };
}

export function runWarmCommand(argv: string[], deps: {
  start?: typeof startWarmDaemon;
  log?: (m: string) => void;
  errorLog?: (m: string) => void;
  exit?: (code: number) => void;
  on?: (sig: "SIGINT" | "SIGTERM", cb: () => void) => void;
} = {}): WarmDaemon | null {
  const start = deps.start ?? startWarmDaemon;
  const log = deps.log ?? ((m) => console.log(m));
  const errorLog = deps.errorLog ?? ((m) => console.error(m));
  const exit = deps.exit ?? ((c) => process.exit(c));
  const on = deps.on ?? ((s, cb) => { process.once(s, cb); });

  if (!argv.includes("--watch")) {
    errorLog("agentgem warm: use --watch to run the background warming daemon");
    exit(1); return null;
  }
  const d = start();
  if (!d) { exit(0); return null; }
  log("agentgem warm: watching ~/.claude/projects — Ctrl-C to stop");
  const shutdown = () => { void d.stop().then(() => exit(0)); };
  on("SIGINT", shutdown);
  on("SIGTERM", shutdown);
  return d;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm -w build && pnpm vitest run dist/warm/__tests__/daemon.test.js`
Expected: PASS (all four cases).

- [ ] **Step 5: Commit**
```bash
git add src/warm/daemon.ts src/warm/__tests__/daemon.test.ts
git -c user.name="Raymond Feng" -c user.email="raymond@ninemind.ai" commit -m "feat(warm): warm daemon (pidfile + initial pass + watcher) and runWarmCommand CLI entry"
```

---

## Task 5: Wire the `agentgem warm` CLI subcommand

**Files:**
- Modify: `src/cli.ts`

**Interfaces:**
- Consumes: `runWarmCommand` (Task 4).

- [ ] **Step 1: Add the subcommand dispatch**

In `src/cli.ts`, inside `main`, add this branch alongside the other subcommands (after the `bind` branch, before the port parsing):
```ts
  // `agentgem warm --watch` — Trigger C: the background warming daemon.
  if (argv[0] === "warm") {
    const { runWarmCommand } = await import("./warm/daemon.js");
    runWarmCommand(argv.slice(1));
    return;
  }
```

- [ ] **Step 2: Update the HELP text**

In the `HELP` template string in `src/cli.ts`, add a line under the usage/subcommands area:
```
  agentgem warm --watch                 Background daemon: keep insights/scorecard caches warm on change
```

- [ ] **Step 3: Build + typecheck + verify dispatch**

Run: `pnpm -w build`
Expected: builds clean.

Run: `node dist/cli.js warm` (no `--watch`)
Expected: prints `agentgem warm: use --watch to run the background warming daemon` and exits non-zero.

(Do NOT run `node dist/cli.js warm --watch` in CI/non-interactive — it starts a long-lived watcher. Manual smoke only; see Final verification.)

- [ ] **Step 4: Commit**
```bash
git add src/cli.ts
git -c user.name="Raymond Feng" -c user.email="raymond@ninemind.ai" commit -m "feat(cli): agentgem warm --watch subcommand for the Trigger C daemon"
```

---

## Final verification

- [ ] **Full backend suite:** `pnpm -w build && pnpm test` → green (note the known real-FS scan flake is non-deterministic under load; re-run in isolation if a scan test times out — it is not a regression).
- [ ] **Manual smoke (interactive, not CI):**
  - `node dist/cli.js warm --watch` → prints the "watching …" banner; `~/.agentgem/warm.pid` appears.
  - In another shell, append a line to a transcript under `~/.claude/projects/<a project>/…jsonl` (or finish a real session); within ~3s the daemon runs a targeted pass (observe via added logging or by checking the cache mtime for that project).
  - Start a **second** `node dist/cli.js warm --watch` → it prints "another daemon is already running" and exits.
  - `Ctrl-C` the first → exits cleanly and removes `warm.pid`.
- [ ] **Confirm branch is ahead of `origin/main` only**, then integrate (this repo requires a **rebase merge** — keep history linear; if you merged `origin/main` in, `git rebase origin/main` to flatten before opening/merging the PR).

## Self-review notes (already reconciled)

- **Spec coverage:** standalone CLI daemon (Task 4/5) ✓; native fs.watch + debounce (Task 3) ✓; targeted per-root warm + startup pass (Task 3/4) ✓; atomic-write coexistence (Task 1) ✓; pidfile singleton (Task 2) ✓; injectable/best-effort/never-crash + temp-HOME tests (all tasks) ✓; deferred OS-service/lock/Windows (not built) ✓.
- **Type consistency:** `WarmWatch`/`WarmDaemon` interfaces and `startWarmWatch`/`startWarmDaemon`/`runWarmCommand`/`mapFilesToRoots`/`writeJsonAtomic`/`acquirePidfile`/`releasePidfile` signatures are identical across the tasks that define and consume them.
- **Reuse:** the daemon adds no warming logic — it calls the existing `runWarmPass`; path→root reuses `bucketTranscriptsByCwd`; atomic write is one shared `@agentgem/model` helper adopted by all three writers.
- **Repo merge caveat:** linear history required (rebase merge only) — flatten before merging, as learned on PR #55.
