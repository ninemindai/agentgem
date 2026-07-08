# Ambient Context-Hygiene Nudge Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Opt-in `agentgem warm --watch --nudge` — the warm daemon fires a native OS notification when a watched session's context escalates, even with no app open.

**Architecture:** A node OS-notify helper (`nodeNotify`, osascript/notify-send, injectable exec) + a thin per-session `createHygieneNudger` that reuses #176's `buildTickEvents` for all escalation/advice logic + wiring (`startWarmWatch` gains an optional `nudge` hook; the daemon parses `--nudge`). Reuses `hygieneReportForFile`, `buildTickEvents`, the watch loop, and the daemon untouched.

**Tech Stack:** TypeScript ESM (`.js` specifiers), Node `child_process`, Vitest (`tsc -b && vitest run` over `dist/**/__tests__/**/*.test.js`).

## Global Constraints

- **Depends on (all on `origin/main`):** `hygieneReportForFile` (`src/sessionHygieneCore.ts`), `buildTickEvents` + `type Verdict` (`src/watchHygieneNudge.ts` — `buildTickEvents(prev, report): { nudge?: {verdict,advice}, nextVerdict }`), and the warm daemon (`src/warm/watch.ts` `startWarmWatch`, `src/warm/daemon.ts` `startWarmDaemon`/`runWarmCommand`).
- **Opt-in, off by default:** no `--nudge` ⇒ no nudger built, no notifications, existing daemon behavior byte-identical.
- **No new npm dependencies** — shell out to `osascript` (macOS) / `notify-send` (Linux) via `node:child_process`; other platforms no-op. Matches the daemon's `--install-service` platforms.
- **Never throw / never die:** a bad transcript, a missing notify binary, or a spawn failure degrades to a `createLogger("warm")` warning; the daemon keeps running.
- **Privacy:** the notification body is a scrubbed transcript **basename** + agent-authored advice — never a path/arg.
- **Copyright header** on new files: `// Copyright (c) 2026 NineMind, Inc.` / `// SPDX-License-Identifier: MIT` / `// <repo-relative path>`.
- **ESM import specifiers end in `.js`**; from `src/warm/*`, reuse imports are `../watchHygieneNudge.js` / `../sessionHygieneCore.js`.
- **Injectable exec + platform** on `nodeNotify` so all branches run on one CI host without firing a real notification.
- **Tests in `src/warm/__tests__/`** (CI). Work in the worktree `/Users/rfeng/Projects/ninemind/agentgem-ambient` (branch `feat/hygiene-ambient-nudge`), NOT the main checkout.
- **Commit identity** Raymond Feng <raymond@ninemind.ai>, with the `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>` trailer.

---

## File Structure

- **Create** `src/warm/nodeNotify.ts` — the OS-notification helper. (Task 1)
- **Create** `src/warm/hygieneNudger.ts` — the escalation glue. (Task 2)
- **Modify** `src/warm/watch.ts` — optional `nudge` param on `startWarmWatch`, called in `flush()`. (Task 3)
- **Modify** `src/warm/daemon.ts` — `nudge?` on `startWarmDaemon`; wire the nudger when set; parse `--nudge` in `runWarmCommand`. (Task 3)
- **Modify** `src/cli.ts` — the `--nudge` help line. (Task 3)
- **Create** `src/warm/__tests__/nodeNotify.test.ts`, `src/warm/__tests__/hygieneNudger.test.ts` — CI. (Tasks 1, 2)
- **Modify** `src/warm/__tests__/watch.test.ts` + `src/warm/__tests__/daemon.test.ts` — wiring cases. (Task 3)

**Run commands** (from the worktree root):
- Single test: `tsc -b && npx vitest run dist/warm/__tests__/nodeNotify.test.js`
- Full server suite: `npm test`

---

## Task 1: `nodeNotify` — node OS-notification helper

**Files:**
- Create: `src/warm/nodeNotify.ts`
- Test: `src/warm/__tests__/nodeNotify.test.ts`

**Interfaces:**
- Produces:
  - `export type NotifyExec = (cmd: string, args: string[]) => void`
  - `export function nodeNotify(title: string, body: string, exec?: NotifyExec, platform?: NodeJS.Platform): void`

- [ ] **Step 1: Write the failing test**

Create `src/warm/__tests__/nodeNotify.test.ts`:

```ts
// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
// src/warm/__tests__/nodeNotify.test.ts
import { describe, it, expect } from "vitest";
import { nodeNotify } from "../nodeNotify.js";

function rec() { const calls: { cmd: string; args: string[] }[] = []; return { exec: (cmd: string, args: string[]) => calls.push({ cmd, args }), calls }; }

describe("nodeNotify", () => {
  it("uses osascript with an AppleScript display-notification on darwin", () => {
    const r = rec();
    nodeNotify("Heads up", "context is heavy", r.exec, "darwin");
    expect(r.calls).toHaveLength(1);
    expect(r.calls[0].cmd).toBe("osascript");
    expect(r.calls[0].args[0]).toBe("-e");
    expect(r.calls[0].args[1]).toContain("display notification");
    expect(r.calls[0].args[1]).toContain('"context is heavy"');
    expect(r.calls[0].args[1]).toContain('with title "Heads up"');
  });
  it("uses notify-send with argv (no shell) on linux", () => {
    const r = rec();
    nodeNotify("T", "B", r.exec, "linux");
    expect(r.calls[0]).toEqual({ cmd: "notify-send", args: ["T", "B"] });
  });
  it("is a no-op on other platforms", () => {
    const r = rec();
    nodeNotify("T", "B", r.exec, "win32");
    expect(r.calls).toHaveLength(0);
  });
  it("escapes quotes for AppleScript and strips newlines/control chars", () => {
    const r = rec();
    nodeNotify('a"b', "line1\nline2", r.exec, "darwin");
    expect(r.calls[0].args[1]).toContain('with title "a\\"b"');   // quote escaped
    expect(r.calls[0].args[1]).not.toContain("\n");                // newline stripped
  });
  it("passes shell metacharacters literally to notify-send argv (no injection)", () => {
    const r = rec();
    nodeNotify("T", "$(rm -rf ~); `whoami`", r.exec, "linux");
    expect(r.calls[0].args[1]).toBe("$(rm -rf ~); `whoami`");      // literal, argv not a shell string
  });
  it("never throws when exec throws", () => {
    const bomb = () => { throw new Error("no binary"); };
    expect(() => nodeNotify("T", "B", bomb, "linux")).not.toThrow();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `tsc -b && npx vitest run dist/warm/__tests__/nodeNotify.test.js`
Expected: FAIL — `../nodeNotify.js` does not exist.

- [ ] **Step 3: Write minimal implementation**

Create `src/warm/nodeNotify.ts`:

```ts
// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
// src/warm/nodeNotify.ts
//
// Node-side OS notification for the warm daemon (the browser osNotify in
// packages/console is unreachable from this plain-node process). Shells out to
// osascript (macOS) / notify-send (Linux) via argv arrays — no shell, so no
// injection. Other platforms no-op. Never throws: a missing binary or spawn
// error is logged and swallowed, matching the daemon's best-effort paths.
import { execFile } from "node:child_process";
import { createLogger } from "@agentgem/base";

const log = createLogger("warm");

export type NotifyExec = (cmd: string, args: string[]) => void;

const defaultExec: NotifyExec = (cmd, args) => {
  try { execFile(cmd, args, () => { /* fire-and-forget; ignore result/err */ }); }
  catch (err) { log.warn("nodeNotify exec failed: %s", (err as Error)?.message ?? err); }
};

// Strip control chars + newlines and cap length — the strings are agent-authored
// advice + a scrubbed basename, but sanitize defensively.
const clean = (s: string) => (s ?? "").replace(/[\u0000-\u001f\u007f]/g, " ").slice(0, 200);
// AppleScript double-quoted string literal.
const asStr = (s: string) => `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;

export function nodeNotify(title: string, body: string, exec: NotifyExec = defaultExec, platform: NodeJS.Platform = process.platform): void {
  const t = clean(title), b = clean(body);
  try {
    if (platform === "darwin") exec("osascript", ["-e", `display notification ${asStr(b)} with title ${asStr(t)}`]);
    else if (platform === "linux") exec("notify-send", [t, b]);
    // other platforms: no-op
  } catch (err) {
    log.warn("nodeNotify failed: %s", (err as Error)?.message ?? err);
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `tsc -b && npx vitest run dist/warm/__tests__/nodeNotify.test.js`
Expected: PASS (6 tests).

- [ ] **Step 5: Commit**

```bash
git add src/warm/nodeNotify.ts src/warm/__tests__/nodeNotify.test.ts
git -c user.name="Raymond Feng" -c user.email="raymond@ninemind.ai" commit -m "feat(warm): nodeNotify — node OS notification (osascript/notify-send)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 2: `createHygieneNudger` — per-session escalation glue

**Files:**
- Create: `src/warm/hygieneNudger.ts`
- Test: `src/warm/__tests__/hygieneNudger.test.ts`

**Interfaces:**
- Consumes: `buildTickEvents`, `type Verdict` from `../watchHygieneNudge.js`; `type HygieneReport` from `../sessionHygieneCore.js`.
- Produces: `export function createHygieneNudger(deps: { notify: (title: string, body: string) => void; reportForFile: (path: string) => HygieneReport }): { nudge(files: string[]): void }`

- [ ] **Step 1: Write the failing test**

Create `src/warm/__tests__/hygieneNudger.test.ts`:

```ts
// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
// src/warm/__tests__/hygieneNudger.test.ts
import { describe, it, expect } from "vitest";
import { createHygieneNudger } from "../hygieneNudger.js";
import type { HygieneReport } from "../../sessionHygieneCore.js";

// Minimal report with a chosen verdict + a fired factor (so buildTickEvents has advice).
function report(sessionId: string, verdict: "bounded" | "mixed" | "bloated"): HygieneReport {
  return {
    meta: { sessionId, transcript: `${sessionId}.jsonl`, model: "m", cap: 1_000_000 },
    curve: [{ turn: 0, msgIndex: 0, ctxTokens: 900_000, cacheCreation: 0, outTokens: 1 }],
    events: [],
    factors: [{ id: "context-pinned", title: "Window pinned", advice: "Take a clean break.", severity: "warn", count: verdict === "bounded" ? 0 : 1, sessions: 1 }],
    hygiene: { score: verdict === "bounded" ? 90 : 20, verdict },
  } as HygieneReport;
}

describe("createHygieneNudger", () => {
  // reportForFile returns the CURRENT report for the session, mutated between
  // nudge() calls, so the nudger's internal `last` map sees a real verdict climb.
  function run(steps: ("bounded" | "mixed" | "bloated")[], sessionId = "s1", file = "/x/s1.jsonl") {
    const notes: { title: string; body: string }[] = [];
    let current = report(sessionId, steps[0]);
    const nudger = createHygieneNudger({ notify: (title, body) => notes.push({ title, body }), reportForFile: () => current });
    for (const v of steps) { current = report(sessionId, v); nudger.nudge([file]); }
    return notes;
  }

  it("fires exactly once on a bounded→mixed climb, carrying the advice", () => {
    const notes = run(["bounded", "mixed"]);
    expect(notes).toHaveLength(1);
    expect(notes[0].title).toMatch(/context is heavy/i);
    expect(notes[0].body).toContain("Take a clean break.");
    expect(notes[0].body).toContain("s1.jsonl");   // basename, not a path
    expect(notes[0].body).not.toContain("/x/");
  });
  it("stays silent while a session holds at mixed", () => {
    expect(run(["bounded", "mixed", "mixed", "mixed"])).toHaveLength(1);   // only the initial climb
  });
  it("re-arms: bloated→bounded→bloated fires twice", () => {
    expect(run(["bounded", "bloated", "bounded", "bloated"])).toHaveLength(2);
  });
  it("skips a file whose report throws, without throwing, and processes the rest", () => {
    const notes: { title: string; body: string }[] = [];
    const good = report("g", "bloated");
    const nudger = createHygieneNudger({
      notify: (t, b) => notes.push({ title: t, body: b }),
      reportForFile: (p) => { if (p.includes("bad")) throw new Error("half-written"); return good; },
    });
    expect(() => nudger.nudge(["/x/bad.jsonl", "/x/g.jsonl"])).not.toThrow();
    expect(notes).toHaveLength(1);                  // the good one still fired
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `tsc -b && npx vitest run dist/warm/__tests__/hygieneNudger.test.js`
Expected: FAIL — `../hygieneNudger.js` does not exist.

- [ ] **Step 3: Write minimal implementation**

Create `src/warm/hygieneNudger.ts`:

```ts
// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
// src/warm/hygieneNudger.ts
//
// Per-session escalation glue for the ambient nudge. Reuses #176's buildTickEvents
// for the entire fire-on-climb + advice-pick logic; this only holds the per-session
// last-verdict state and calls notify on a fire. A per-file try/catch keeps a
// half-written transcript from killing the daemon or skipping the other files.
import { basename } from "node:path";
import { buildTickEvents, type Verdict } from "../watchHygieneNudge.js";
import type { HygieneReport } from "../sessionHygieneCore.js";
import { createLogger } from "@agentgem/base";

const log = createLogger("warm");

export function createHygieneNudger(deps: {
  notify: (title: string, body: string) => void;
  reportForFile: (path: string) => HygieneReport;
}): { nudge(files: string[]): void } {
  const last = new Map<string, Verdict>();
  return {
    nudge(files: string[]): void {
      for (const file of files) {
        try {
          const report = deps.reportForFile(file);
          const id = report.meta.sessionId || file;
          const t = buildTickEvents(last.get(id) ?? null, report);
          if (t.nudge) deps.notify("AgentGem — context is heavy", `${basename(file)}: ${t.nudge.advice}`);
          last.set(id, t.nextVerdict);
        } catch (err) {
          log.warn("hygiene nudge skipped %s: %s", basename(file), (err as Error)?.message ?? err);
        }
      }
    },
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `tsc -b && npx vitest run dist/warm/__tests__/hygieneNudger.test.js`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add src/warm/hygieneNudger.ts src/warm/__tests__/hygieneNudger.test.ts
git -c user.name="Raymond Feng" -c user.email="raymond@ninemind.ai" commit -m "feat(warm): createHygieneNudger — per-session escalation glue (reuses buildTickEvents)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 3: Wiring — `startWarmWatch` hook + `--nudge` flag

**Files:**
- Modify: `src/warm/watch.ts` (`startWarmWatch` opts + `flush`)
- Modify: `src/warm/daemon.ts` (`startWarmDaemon` opt + `runWarmCommand` parse)
- Modify: `src/cli.ts` (help line)
- Test: `src/warm/__tests__/watch.test.ts` (append), `src/warm/__tests__/daemon.test.ts` (append)

**Interfaces:**
- Consumes: `createHygieneNudger` (Task 2), `nodeNotify` (Task 1), `hygieneReportForFile` (`../sessionHygieneCore.js`).
- Produces: `startWarmWatch` accepts `nudge?: (files: string[]) => void`; `startWarmDaemon` accepts `nudge?: boolean`; `runWarmCommand` parses `--nudge`.

- [ ] **Step 1: Write the failing tests**

Append to `src/warm/__tests__/watch.test.ts` (reuse the file's existing injection style — it injects `watch`/`setTimer`/`clearTimer`/`run`/`toRoots`):

```ts
it("calls the nudge hook with the debounced changed files on flush", () => {
  let fire: (evt: string, file: string | null) => void = () => {};
  const nudged: string[][] = [];
  const timers: (() => void)[] = [];
  const w = startWarmWatch({
    claudeDir: "/c",
    watch: (_dir, cb) => { fire = cb; return { close() {} }; },
    setTimer: (fn) => { timers.push(fn); return 1; },
    clearTimer: () => {},
    run: async () => {},
    toRoots: () => ["/root"],
    nudge: (files) => nudged.push(files),
  });
  fire("change", "sess.jsonl");
  timers[timers.length - 1]();   // fire the debounce flush
  expect(nudged).toHaveLength(1);
  expect(nudged[0][0]).toContain("sess.jsonl");
  w.stop();
});
```

Append to `src/warm/__tests__/daemon.test.ts` (it injects `watch` into `startWarmDaemon`; reuse that):

```ts
it("wires a nudge hook into the watch when nudge is true, and not when false", () => {
  const seen: Array<((files: string[]) => void) | undefined> = [];
  const fakeWatch = ((opts: any) => { seen.push(opts?.nudge); return { stop() {} }; }) as any;
  // startWarmDaemon needs its pidfile to acquire; reuse the test file's existing home/tmp setup + initialPass stub.
  const base = { home: <the test's tmp home>, initialPass: async () => {}, usageReporter: (() => ({ stop() {} })) as any, watch: fakeWatch };
  startWarmDaemon({ ...base, nudge: true })?.stop();
  startWarmDaemon({ ...base, nudge: false })?.stop();
  expect(typeof seen[0]).toBe("function");   // nudge wired
  expect(seen[1]).toBeUndefined();           // not wired
});
```

> Read `src/warm/__tests__/daemon.test.ts` first to reuse its exact tmp-home + pidfile setup (`<the test's tmp home>` above is a placeholder for whatever `home` the existing tests pass; two `startWarmDaemon` calls in one test need distinct pidfile state or a `.stop()`/`releasePidfile` between them — follow the existing tests' teardown pattern so the second `startWarmDaemon` can acquire the pidfile).

- [ ] **Step 2: Run tests to verify they fail**

Run: `tsc -b && npx vitest run dist/warm/__tests__/watch.test.js dist/warm/__tests__/daemon.test.js`
Expected: FAIL — `nudge` not accepted by `startWarmWatch`/`startWarmDaemon`.

- [ ] **Step 3: Write minimal implementation**

In `src/warm/watch.ts`, add `nudge?: (files: string[]) => void` to the `startWarmWatch` opts object type (alongside `run`/`toRoots`), and in `flush()` call it after the run. Confirm the exact `flush` with `grep -an "const flush" src/warm/watch.ts`; change:
```ts
  const flush = () => {
    timer = null;
    const files = [...pending]; pending.clear();
    if (!files.length) return;
    const roots = toRoots(claudeDir, files);
    if (roots.length) void run(roots);
  };
```
to add one line before the closing brace:
```ts
    if (roots.length) void run(roots);
    opts.nudge?.(files);
  };
```

In `src/warm/daemon.ts`:
1. Import at the top: `import { createHygieneNudger } from "./hygieneNudger.js";`, `import { nodeNotify } from "./nodeNotify.js";`, `import { hygieneReportForFile } from "../sessionHygieneCore.js";`.
2. Add `nudge?: boolean;` to the `startWarmDaemon` opts type.
3. Build the nudger when enabled and pass the hook into `startWatch`. Change:
   ```ts
   const w = startWatch({ run: (roots) => withWarmLock(home, () => warmRootsIndividually(roots), () => undefined) });
   ```
   to:
   ```ts
   const nudger = opts.nudge ? createHygieneNudger({ notify: nodeNotify, reportForFile: hygieneReportForFile }) : null;
   const w = startWatch({
     run: (roots) => withWarmLock(home, () => warmRootsIndividually(roots), () => undefined),
     ...(nudger ? { nudge: (files: string[]) => nudger.nudge(files) } : {}),
   });
   ```
4. In `runWarmCommand`, parse `--nudge` and thread it into `start(...)`. Find the `start(...)` call (`grep -an "start(" src/warm/daemon.ts`) and add `nudge: argv.includes("--nudge")` to the options object it passes to `startWarmDaemon`.

In `src/cli.ts`, add a help line under the `warm --watch` entry:
```
  agentgem warm --watch --nudge         Also send an OS notification when a session's context gets heavy
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `tsc -b && npx vitest run dist/warm/__tests__/watch.test.js dist/warm/__tests__/daemon.test.js`
Then the full warm suite to confirm no regression: `npx vitest run dist/warm/__tests__/`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/warm/watch.ts src/warm/daemon.ts src/cli.ts src/warm/__tests__/watch.test.ts src/warm/__tests__/daemon.test.ts
git -c user.name="Raymond Feng" -c user.email="raymond@ninemind.ai" commit -m "feat(warm): --nudge opt-in wires ambient hygiene notifications into the daemon

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Final verification

- [ ] Full server suite: `npm test` (includes the new warm tests + unaffected warm/daemon suites; note a pre-existing `consoleMount.test` needs the console SPA built — `node scripts/build-console.mjs` — to pass in a fresh worktree, unrelated to this change).
- [ ] Confirm the daemon is byte-identical without `--nudge`: the `startWarmDaemon`/`startWarmWatch` existing tests pass unchanged (no `nudge` ⇒ no nudger, no hook call).
- [ ] Manual smoke (optional, macOS): `node dist/cli.js warm --watch --nudge`, append to a real bloated Claude transcript, confirm a notification appears; run without `--nudge` and confirm none.

## Out of scope (later)

- A desktop-app native path / a console toggle for `--nudge`.
- Per-session/project selection; Windows notifications; click-to-open actions.
- The interactive EMBER widget (the last shelf item).
