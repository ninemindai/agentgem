# Watch Attention Alert Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Alert the user (toast / OS notification + Watch-tab badge) when a watched coding session stalls on a pending tool call — likely a permission prompt waiting for their input.

**Architecture:** A new server module folds each active session's transcript through its source's existing `detectEvents` and classifies it `pending | busy | idle` (pending = unmatched `toolId`-bearing tool_call + transcript unwritten ≥ 25s). One new poll endpoint `GET /api/watch/attention` exposes this. The console's existing `NotificationsProvider` polls it on its 5s cadence and routes transitions through the existing `dispatch` (toast focused / OS notification hidden), filtered by a localStorage enrollment pref. The Watch tab shows per-session badges and bell toggles.

**Tech Stack:** TypeScript ESM, Express (raw routes in `src/appCommon.ts`), React console (`packages/console`), vitest. No new dependencies.

**Spec:** `docs/superpowers/specs/2026-07-16-watch-attention-alert-design.md`

## Global Constraints

- Work in worktree `../agentgem-worktrees/watch-attention` (branch `watch-attention`).
- Root tests run **compiled dist**: always `pnpm build` before `pnpm test` at repo root (full build = `tsc -b && node scripts/build-console.mjs`; plain `tsc -b` leaves the console bundle stale).
- Console tests are NOT in CI — run `pnpm -C packages/console test` locally.
- No module-scoped mutable state/caches — the fold cache lives in a closure created per app instance (`createAttentionLister`).
- Stall threshold is exactly `25_000` ms, named `STALL_MS`.
- All user-facing copy hedges: "waiting on approval … (or a long tool run)" — the transcript cannot distinguish the two.
- Every new className added in a `.tsx` gets a matching rule in `packages/console/src/shell/theme.css` in the same commit.
- Notification title: `Session needs your input`. Event key: `attention-<sessionId>-<pendingKey>`.
- `tool_call` events with `toolId: null` are **excluded** from pending detection (unpairable — permanent false positive otherwise).
- Commits end with `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`.

---

### Task 1: Server detector + lister (`src/watchAttention.ts`)

**Files:**
- Create: `src/watchAttention.ts`
- Test: `src/__tests__/watchAttention.test.ts`

**Interfaces:**
- Consumes: `listActiveSessions(opts: ListOpts)`, `sourceForFile(file, baseDir)` from `./watchSessions.js`; `SessionEvent` from `@agentgem/insight`.
- Produces (Task 2 wires the route; Task 3 mirrors the wire shape client-side):

```ts
export type AttentionState = "pending" | "busy" | "idle";
export interface AttentionInfo {
  state: AttentionState;
  pendingKey: number | null;       // event index of FIRST unmatched toolId-bearing tool_call
  pendingToolName: string | null;
  stalledMs: number;               // max(0, now - mtimeMs)
}
export const STALL_MS = 25_000;
export function computeAttention(events: SessionEvent[], mtimeMs: number, now: number): AttentionInfo;

export interface AttentionSession {
  id: string; file: string; agent: string; project: string | null;
  state: AttentionState; pendingKey: number | null;
  pendingToolName: string | null; stalledMs: number;
}
export function createAttentionLister(): (opts?: ListOpts) => AttentionSession[];
```

- [ ] **Step 1: Write the failing tests**

Create `src/__tests__/watchAttention.test.ts`. Fixture idiom copied from `watchSessions.test.ts` (temp `.claude/projects` dir, `utimesSync`-pinned mtimes, injected `now`). Claude record shapes match `claudeSessionEvents`: `tool_use` items carry `id`/`name`/`input`; `tool_result` items carry `tool_use_id`.

```ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, appendFileSync, rmSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { computeAttention, createAttentionLister, STALL_MS } from "../watchAttention.js";
import type { SessionEvent } from "@agentgem/insight";

const NOW = Date.parse("2026-07-16T12:00:00.000Z");
const ev = (span: SessionEvent["span"]): SessionEvent => ({ tsMs: NOW - 60_000, span });
const msg = (text: string): SessionEvent => ev({ kind: "message", role: "assistant", text });
const call = (toolId: string | null, name = "Bash"): SessionEvent => ev({ kind: "tool_call", toolId, name, input: "{}" });
const result = (toolId: string | null): SessionEvent => ev({ kind: "tool_result", toolId, output: "ok", error: false });

describe("computeAttention", () => {
  it("is idle when every tool_call has a result", () => {
    const a = computeAttention([msg("hi"), call("t1"), result("t1")], NOW - 60_000, NOW);
    expect(a.state).toBe("idle");
    expect(a.pendingKey).toBeNull();
    expect(a.pendingToolName).toBeNull();
  });

  it("is idle when the transcript ends on a plain message", () => {
    expect(computeAttention([msg("done")], NOW - 60_000, NOW).state).toBe("idle");
  });

  it("is busy when a call is unmatched but the file is fresh (< STALL_MS)", () => {
    const a = computeAttention([call("t1")], NOW - (STALL_MS - 1), NOW);
    expect(a.state).toBe("busy");
    expect(a.pendingKey).toBeNull(); // key only surfaces once pending
  });

  it("is pending when a call is unmatched and the file stalled >= STALL_MS", () => {
    const a = computeAttention([msg("hi"), call("t1", "Write")], NOW - STALL_MS, NOW);
    expect(a).toEqual({ state: "pending", pendingKey: 1, pendingToolName: "Write", stalledMs: STALL_MS });
  });

  it("keys on the FIRST unmatched call when several are open", () => {
    const a = computeAttention([call("t1", "Read"), call("t2", "Bash")], NOW - STALL_MS, NOW);
    expect(a.pendingKey).toBe(0);
    expect(a.pendingToolName).toBe("Read");
  });

  it("ignores null-toolId calls entirely (unpairable — would be a permanent false pending)", () => {
    const a = computeAttention([call(null), msg("done")], NOW - STALL_MS, NOW);
    expect(a.state).toBe("idle");
  });

  it("a result clears its call even with events after it", () => {
    const a = computeAttention([call("t1"), result("t1"), msg("done")], NOW - STALL_MS, NOW);
    expect(a.state).toBe("idle");
  });
});

describe("createAttentionLister", () => {
  let home: string, claudeDir: string, file: string;
  const rec = (o: unknown) => JSON.stringify(o);
  const userRec = rec({ type: "user", cwd: "/work/site", timestamp: "2026-07-16T11:58:00.000Z", message: { role: "user", content: "go" } });
  const pendingRec = rec({ type: "assistant", cwd: "/work/site", timestamp: "2026-07-16T11:59:00.000Z", message: { role: "assistant", model: "claude-opus-4-8", content: [{ type: "tool_use", id: "t1", name: "Bash", input: { command: "ls" } }], usage: { input_tokens: 5, output_tokens: 3 } } });
  const resultRec = rec({ type: "user", cwd: "/work/site", timestamp: "2026-07-16T11:59:30.000Z", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "ok" }] } });

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "attn-"));
    claudeDir = join(home, ".claude");
    const proj = join(claudeDir, "projects", "proj-a");
    mkdirSync(proj, { recursive: true });
    file = join(proj, "sess-uuid.jsonl");
  });
  afterEach(() => rmSync(home, { recursive: true, force: true }));

  const pin = (agoMs: number) => utimesSync(file, (NOW - agoMs) / 1000, (NOW - agoMs) / 1000);

  it("flags a stalled unmatched tool_use as pending, then idle once its result lands", () => {
    const list = createAttentionLister();
    writeFileSync(file, userRec + "\n" + pendingRec + "\n");
    pin(STALL_MS + 5_000);
    const a = list({ baseDir: claudeDir, now: NOW });
    expect(a).toHaveLength(1);
    expect(a[0]).toMatchObject({ file, agent: "claude", state: "pending", pendingToolName: "Bash" });

    appendFileSync(file, resultRec + "\n");
    pin(1_000);
    const b = list({ baseDir: claudeDir, now: NOW });
    expect(b[0].state).toBe("idle");
  });

  it("caches the fold by mtime — a content change without an mtime change is not re-read", () => {
    const list = createAttentionLister();
    writeFileSync(file, userRec + "\n" + pendingRec + "\n");
    pin(STALL_MS + 5_000);
    expect(list({ baseDir: claudeDir, now: NOW })[0].state).toBe("pending");

    appendFileSync(file, resultRec + "\n"); // result lands…
    pin(STALL_MS + 5_000);                  // …but mtime pinned back to the same value
    expect(list({ baseDir: claudeDir, now: NOW })[0].state).toBe("pending"); // cached fold still used
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
cd ../agentgem-worktrees/watch-attention && pnpm build && pnpm vitest run dist/__tests__/watchAttention.test.js
```

Expected: build FAILS (or vitest FAILS) with `watchAttention` module not found. (Root vitest runs the compiled `dist/__tests__` — see Global Constraints.)

- [ ] **Step 3: Implement `src/watchAttention.ts`**

```ts
// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
// src/watchAttention.ts
//
// "Needs your input" detection for the Watch tab: classify each active session as
// pending (an unmatched tool_call with a stalled transcript — likely a permission
// prompt blocking on the user), busy (unmatched call, file still fresh: the tool is
// presumably running), or idle (no unmatched call). The transcript genuinely cannot
// distinguish a permission prompt from a long-running tool, so `pending` is a hedge
// the UI copy carries ("waiting on approval — or a long tool run"), never a claim.
// tool_calls with toolId:null are excluded outright: they are unpairable (see
// SessionFeed.toItems) and counting them would flag a permanent false pending.
import { statSync, readFileSync } from "node:fs";
import type { SessionEvent } from "@agentgem/insight";
import { listActiveSessions, sourceForFile, type ListOpts } from "./watchSessions.js";

export type AttentionState = "pending" | "busy" | "idle";

export interface AttentionInfo {
  state: AttentionState;
  /** Event index of the FIRST unmatched toolId-bearing tool_call (pending only). */
  pendingKey: number | null;
  pendingToolName: string | null;
  stalledMs: number;
}

/** A transcript unwritten for this long with an open tool_call counts as pending. */
export const STALL_MS = 25_000;

export function computeAttention(events: SessionEvent[], mtimeMs: number, now: number): AttentionInfo {
  const open = new Map<string, { index: number; name: string }>();
  for (let i = 0; i < events.length; i++) {
    const span = events[i].span;
    if (span.kind === "tool_call" && span.toolId) open.set(span.toolId, { index: i, name: span.name });
    else if (span.kind === "tool_result" && span.toolId) open.delete(span.toolId);
  }
  const stalledMs = Math.max(0, now - mtimeMs);
  if (open.size === 0) return { state: "idle", pendingKey: null, pendingToolName: null, stalledMs };
  if (stalledMs < STALL_MS) return { state: "busy", pendingKey: null, pendingToolName: null, stalledMs };
  const first = [...open.values()].reduce((a, b) => (a.index <= b.index ? a : b));
  return { state: "pending", pendingKey: first.index, pendingToolName: first.name, stalledMs };
}

export interface AttentionSession {
  id: string;
  file: string;
  agent: string;
  project: string | null;
  state: AttentionState;
  pendingKey: number | null;
  pendingToolName: string | null;
  stalledMs: number;
}

interface FoldCacheEntry { mtimeMs: number; events: SessionEvent[] }

/**
 * Per-instance lister (cache lives in the closure — no module-scoped state).
 * Steady state is cheap: a stalled file's mtime doesn't change, so each poll costs
 * one statSync per session; only a changed file re-folds through detectEvents.
 */
export function createAttentionLister(): (opts?: ListOpts) => AttentionSession[] {
  const cache = new Map<string, FoldCacheEntry>();

  return (opts: ListOpts = {}) => {
    const now = opts.now ?? Date.now();
    const out: AttentionSession[] = [];
    const seen = new Set<string>();

    for (const s of listActiveSessions(opts)) {
      seen.add(s.file);
      const spec = sourceForFile(s.file, opts.baseDir);
      if (!spec?.detectEvents) continue;

      let mtimeMs: number;
      try { mtimeMs = statSync(s.file).mtimeMs; } catch { continue; }

      let entry = cache.get(s.file);
      if (!entry || entry.mtimeMs !== mtimeMs) {
        let text: string;
        try { text = readFileSync(s.file, "utf8"); } catch { continue; }
        entry = { mtimeMs, events: spec.detectEvents(text, s.file) };
        cache.set(s.file, entry);
      }

      const info = computeAttention(entry.events, mtimeMs, now);
      out.push({ id: s.id, file: s.file, agent: s.agent, project: s.project, ...info });
    }

    for (const key of cache.keys()) if (!seen.has(key)) cache.delete(key); // aged-out sessions
    return out;
  };
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
cd ../agentgem-worktrees/watch-attention && pnpm build && pnpm vitest run dist/__tests__/watchAttention.test.js
```

Expected: PASS (all `computeAttention` + `createAttentionLister` tests green).

- [ ] **Step 5: Commit**

```bash
cd ../agentgem-worktrees/watch-attention
git add src/watchAttention.ts src/__tests__/watchAttention.test.ts
git commit -m "feat(watch): attention detector — pending/busy/idle over folded session events

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 2: Register `GET /api/watch/attention`

**Files:**
- Modify: `src/appCommon.ts` (imports ~line 35; route block ~line 279 beside the other `/api/watch/*` routes)

**Interfaces:**
- Consumes: `createAttentionLister` from Task 1.
- Produces: `GET /api/watch/attention` → `{ sessions: AttentionSession[] }` (originGuard-protected, same as siblings). Task 5's client fetch relies on this exact shape.

- [ ] **Step 1: Add the import and route**

Next to the existing import (line ~35):

```ts
import { createAttentionLister } from "./watchAttention.js";
```

In the watch-route block, directly after the `/api/watch/sessions` registration:

```ts
  // Watch attention: which active sessions look blocked on the user — an unmatched
  // tool_call with a stalled transcript (permission prompt, or a long tool run; the
  // transcript can't tell). Polled by the console's NotificationsProvider.
  const listAttention = createAttentionLister();
  server.expressApp.get("/api/watch/attention", originGuard, (_req, res) =>
    res.json({ sessions: listAttention() } as never));
```

(Endpoint behavior is covered by Task 1's `createAttentionLister` tests; the route body is a one-line delegation, same pattern as `/api/watch/sessions` which also has no route-level test.)

- [ ] **Step 2: Build + full root test run to catch regressions**

```bash
cd ../agentgem-worktrees/watch-attention && pnpm build && pnpm test
```

Expected: PASS (pre-existing suites unaffected; note `realfs` scan tests can flake under concurrency — re-run in isolation before blaming this change).

- [ ] **Step 3: Commit**

```bash
cd ../agentgem-worktrees/watch-attention
git add src/appCommon.ts
git commit -m "feat(watch): GET /api/watch/attention — per-session needs-input state

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 3: Console `detectAttention` (notify/events.ts)

**Files:**
- Modify: `packages/console/src/notify/events.ts`
- Test: `packages/console/src/notify/events.test.ts` (append)

**Interfaces:**
- Consumes: existing `NotifyEvent` shape in the same file.
- Produces (Task 5 calls this; Task 4's `enrolledFiles` feeds the `enrolled` arg):

```ts
export interface AttentionSessionSnap {
  id: string; file: string; project: string | null;
  state: "pending" | "busy" | "idle";
  pendingKey: number | null; pendingToolName: string | null;
}
export interface AttentionSnapshot { sessions: AttentionSessionSnap[] }
export function detectAttention(
  prev: AttentionSnapshot | null,
  next: AttentionSnapshot,
  enrolled: Set<string>,
): NotifyEvent[];
```

- [ ] **Step 1: Write the failing tests** (append to `events.test.ts`)

```ts
import { detectAttention, type AttentionSnapshot } from "./events.js";

const snap = (sessions: AttentionSnapshot["sessions"]): AttentionSnapshot => ({ sessions });
const pending = (over: Partial<AttentionSnapshot["sessions"][0]> = {}) => ({
  id: "s1", file: "/t/s1.jsonl", project: "site",
  state: "pending" as const, pendingKey: 4, pendingToolName: "Bash", ...over,
});

describe("detectAttention", () => {
  it("is silent on the first snapshot (baseline)", () => {
    expect(detectAttention(null, snap([pending()]), new Set(["/t/s1.jsonl"]))).toEqual([]);
  });

  it("fires once when an enrolled session transitions into pending", () => {
    const events = detectAttention(snap([{ ...pending(), state: "busy", pendingKey: null, pendingToolName: null }]), snap([pending()]), new Set(["/t/s1.jsonl"]));
    expect(events).toHaveLength(1);
    expect(events[0].key).toBe("attention-s1-4");
    expect(events[0].title).toBe("Session needs your input");
    expect(events[0].message).toBe("site — waiting on approval for Bash (or a long tool run).");
  });

  it("does not re-fire while the same stall persists", () => {
    expect(detectAttention(snap([pending()]), snap([pending()]), new Set(["/t/s1.jsonl"]))).toEqual([]);
  });

  it("fires again for a later, different stall (new pendingKey)", () => {
    const events = detectAttention(snap([pending()]), snap([pending({ pendingKey: 9, pendingToolName: "Write" })]), new Set(["/t/s1.jsonl"]));
    expect(events).toHaveLength(1);
    expect(events[0].key).toBe("attention-s1-9");
  });

  it("ignores sessions that are not enrolled", () => {
    expect(detectAttention(snap([]), snap([pending()]), new Set())).toEqual([]);
  });

  it("falls back to the id prefix when project is null", () => {
    const events = detectAttention(snap([]), snap([pending({ project: null, id: "abcdef1234" })]), new Set(["/t/s1.jsonl"]));
    expect(events[0].message).toBe("abcdef12 — waiting on approval for Bash (or a long tool run).");
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
cd ../agentgem-worktrees/watch-attention && pnpm -C packages/console vitest run src/notify/events.test.ts
```

Expected: FAIL — `detectAttention` is not exported.

- [ ] **Step 3: Implement** (append to `events.ts`)

```ts
export interface AttentionSessionSnap {
  id: string;
  file: string;
  project: string | null;
  state: "pending" | "busy" | "idle";
  pendingKey: number | null;
  pendingToolName: string | null;
}
export interface AttentionSnapshot { sessions: AttentionSessionSnap[] }

// One NotifyEvent per ENROLLED session that transitioned into pending (or into a
// NEW stall — the pendingKey changed). First snapshot is a silent baseline, like
// detectWarm. Copy hedges "(or a long tool run)": the transcript can't distinguish
// a permission prompt from a slow tool.
export function detectAttention(
  prev: AttentionSnapshot | null,
  next: AttentionSnapshot,
  enrolled: Set<string>,
): NotifyEvent[] {
  if (!prev) return [];
  const prevKey = new Map(prev.sessions.map((s) => [s.id, s.state === "pending" ? s.pendingKey : null]));
  const out: NotifyEvent[] = [];
  for (const s of next.sessions) {
    if (s.state !== "pending" || s.pendingKey === null || !enrolled.has(s.file)) continue;
    if (prevKey.get(s.id) === s.pendingKey) continue;
    const who = s.project ?? s.id.slice(0, 8);
    out.push({
      key: `attention-${s.id}-${s.pendingKey}`,
      title: "Session needs your input",
      message: `${who} — waiting on approval for ${s.pendingToolName ?? "a tool"} (or a long tool run).`,
    });
  }
  return out;
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
cd ../agentgem-worktrees/watch-attention && pnpm -C packages/console vitest run src/notify/events.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
cd ../agentgem-worktrees/watch-attention
git add packages/console/src/notify/events.ts packages/console/src/notify/events.test.ts
git commit -m "feat(console): detectAttention — transition detector for needs-input sessions

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 4: Enrollment prefs (`notify/watchAlertPrefs.ts`)

**Files:**
- Create: `packages/console/src/notify/watchAlertPrefs.ts`
- Test: `packages/console/src/notify/watchAlertPrefs.test.ts`

**Interfaces:**
- Produces (Task 5 reads prefs + resolves enrollment; Task 6 reads/writes prefs from the UI):

```ts
export const LS_WATCH_ALERTS = "agentgem.watchAlerts";
export interface WatchAlertPrefs { mode: "all" | "selected"; files: string[] }
export function readWatchAlertPrefs(): WatchAlertPrefs;   // default { mode: "all", files: [] }
export function writeWatchAlertPrefs(p: WatchAlertPrefs): void;
export function enrolledFiles(prefs: WatchAlertPrefs, allFiles: string[]): Set<string>;
```

- [ ] **Step 1: Write the failing tests**

```ts
import { describe, it, expect, afterEach } from "vitest";
import { readWatchAlertPrefs, writeWatchAlertPrefs, enrolledFiles, LS_WATCH_ALERTS } from "./watchAlertPrefs.js";

afterEach(() => localStorage.clear());

describe("watchAlertPrefs", () => {
  it("defaults to alerting on all sessions", () => {
    expect(readWatchAlertPrefs()).toEqual({ mode: "all", files: [] });
  });

  it("round-trips a selected-mode pref", () => {
    writeWatchAlertPrefs({ mode: "selected", files: ["/t/a.jsonl"] });
    expect(readWatchAlertPrefs()).toEqual({ mode: "selected", files: ["/t/a.jsonl"] });
  });

  it("falls back to the default on malformed storage", () => {
    localStorage.setItem(LS_WATCH_ALERTS, "{nope");
    expect(readWatchAlertPrefs()).toEqual({ mode: "all", files: [] });
  });

  it("enrolledFiles: mode=all enrolls every session", () => {
    expect(enrolledFiles({ mode: "all", files: [] }, ["/a", "/b"])).toEqual(new Set(["/a", "/b"]));
  });

  it("enrolledFiles: mode=selected enrolls only the listed files", () => {
    expect(enrolledFiles({ mode: "selected", files: ["/a"] }, ["/a", "/b"])).toEqual(new Set(["/a"]));
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
cd ../agentgem-worktrees/watch-attention && pnpm -C packages/console vitest run src/notify/watchAlertPrefs.test.ts
```

Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

```ts
export const LS_WATCH_ALERTS = "agentgem.watchAlerts";

export interface WatchAlertPrefs {
  mode: "all" | "selected";
  files: string[];
}

const DEFAULT: WatchAlertPrefs = { mode: "all", files: [] };

// The user asked for these alerts, so the default is on-for-everything; the Watch
// tab's bell toggles narrow it down (mode "selected") per session.
export function readWatchAlertPrefs(): WatchAlertPrefs {
  try {
    const raw = localStorage.getItem(LS_WATCH_ALERTS);
    if (!raw) return DEFAULT;
    const p = JSON.parse(raw) as Partial<WatchAlertPrefs>;
    if ((p.mode === "all" || p.mode === "selected") && Array.isArray(p.files) && p.files.every((f) => typeof f === "string")) {
      return { mode: p.mode, files: p.files };
    }
    return DEFAULT;
  } catch {
    return DEFAULT;
  }
}

export function writeWatchAlertPrefs(p: WatchAlertPrefs): void {
  try {
    localStorage.setItem(LS_WATCH_ALERTS, JSON.stringify(p));
  } catch {
    /* storage unavailable — preference just won't persist */
  }
}

export function enrolledFiles(prefs: WatchAlertPrefs, allFiles: string[]): Set<string> {
  return prefs.mode === "all" ? new Set(allFiles) : new Set(prefs.files.filter((f) => allFiles.includes(f)));
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
cd ../agentgem-worktrees/watch-attention && pnpm -C packages/console vitest run src/notify/watchAlertPrefs.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
cd ../agentgem-worktrees/watch-attention
git add packages/console/src/notify/watchAlertPrefs.ts packages/console/src/notify/watchAlertPrefs.test.ts
git commit -m "feat(console): watch-alert enrollment prefs (all/selected, default all)

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 5: Wire attention into `NotificationsProvider`

**Files:**
- Modify: `packages/console/src/notify/NotificationsProvider.tsx`
- Test: `packages/console/src/notify/NotificationsProvider.test.tsx` (extend)

**Interfaces:**
- Consumes: `detectAttention`/`AttentionSnapshot` (Task 3), `readWatchAlertPrefs`/`enrolledFiles` (Task 4), `GET /api/watch/attention` (Task 2).
- Produces: attention alerts flow through the existing `dispatch` — nothing new exported.

- [ ] **Step 1: Extend the fetch script + write failing tests**

In `NotificationsProvider.test.tsx`, extend `fetchScript` rounds to include `attention`, and advance the round counter on the LAST endpoint of a round (attention) instead of dream:

```ts
// Sequences the three status endpoints across successive poll rounds.
function fetchScript(rounds: Array<{ warm: unknown; dream: unknown; attention?: unknown }>) {
  let round = 0;
  return vi.fn(async (url: string) => {
    const r = rounds[Math.min(round, rounds.length - 1)];
    const body = url.includes("/warm/") ? r.warm : url.includes("/dream/") ? r.dream : (r.attention ?? { sessions: [] });
    if (url.includes("/attention")) round++; // advance after ALL endpoints of a round are read
    return { ok: true, status: 200, json: async () => body } as unknown as Response;
  });
}
```

Add tests:

```ts
const pendingSession = {
  id: "s1", file: "/t/s1.jsonl", project: "site",
  state: "pending", pendingKey: 4, pendingToolName: "Bash",
};

it("toasts when an enrolled session transitions into pending", async () => {
  writeNotifyPref(true);
  vi.useFakeTimers();
  vi.stubGlobal("fetch", fetchScript([
    { warm: { running: false }, dream: { queued: 0 }, attention: { sessions: [{ ...pendingSession, state: "busy", pendingKey: null, pendingToolName: null }] } },
    { warm: { running: false }, dream: { queued: 0 }, attention: { sessions: [pendingSession] } },
  ]));
  render(<ToastProvider><NotificationsProvider apiBase="" /></ToastProvider>);
  await act(async () => { await Promise.resolve(); });
  await act(async () => { await vi.advanceTimersByTimeAsync(5000); });
  expect(screen.getByText(/waiting on approval for Bash/i)).toBeTruthy();
});

it("stays silent for a pending session that is not enrolled", async () => {
  writeNotifyPref(true);
  writeWatchAlertPrefs({ mode: "selected", files: [] }); // nothing enrolled
  vi.useFakeTimers();
  vi.stubGlobal("fetch", fetchScript([
    { warm: { running: false }, dream: { queued: 0 }, attention: { sessions: [{ ...pendingSession, state: "busy", pendingKey: null, pendingToolName: null }] } },
    { warm: { running: false }, dream: { queued: 0 }, attention: { sessions: [pendingSession] } },
  ]));
  render(<ToastProvider><NotificationsProvider apiBase="" /></ToastProvider>);
  await act(async () => { await Promise.resolve(); });
  await act(async () => { await vi.advanceTimersByTimeAsync(5000); });
  expect(screen.queryByText(/waiting on approval/i)).toBeNull();
});
```

Also add to the test file's imports: `import { writeWatchAlertPrefs } from "./watchAlertPrefs.js";`

- [ ] **Step 2: Run tests to verify the new ones fail**

```bash
cd ../agentgem-worktrees/watch-attention && pnpm -C packages/console vitest run src/notify/NotificationsProvider.test.tsx
```

Expected: the two new tests FAIL (no attention fetch yet); the three pre-existing tests still PASS (the reshaped fetchScript defaults `attention` to `{sessions: []}` and the provider simply won't call it yet — the round counter now advances on `/attention`, which is never fetched, so rounds stay pinned at 0 for the old tests; verify the two old *transition* tests still pass by updating them to include an `attention` field per round if the counter change breaks them — the expected end state is ALL tests passing after Step 3).

- [ ] **Step 3: Implement the provider change**

In `NotificationsProvider.tsx`:

```tsx
import { useEffect, useRef } from "react";
import { useToast } from "../shell/Toast.js";
import { detectWarm, detectDream, detectAttention, type WarmSnapshot, type DreamSnapshot, type AttentionSnapshot, type NotifyEvent } from "./events.js";
import { dispatch } from "./dispatch.js";
import { osNotify } from "./osNotify.js";
import { readNotifyPref } from "./prefs.js";
import { readWatchAlertPrefs, enrolledFiles } from "./watchAlertPrefs.js";

const POLL_MS = 5000;

// Mounted once in Shell. Polls warm + dream + watch-attention status, detects
// transitions, and routes events through dispatch. Renders nothing. Independent of
// WarmingPill's own poll (kept separate so the pill stays untouched).
export function NotificationsProvider({ apiBase }: { apiBase: string }): null {
  const { push } = useToast();
  const warmPrev = useRef<WarmSnapshot | null>(null);
  const dreamPrev = useRef<DreamSnapshot | null>(null);
  const attnPrev = useRef<AttentionSnapshot | null>(null);

  useEffect(() => {
    let alive = true;

    const fire = (event: NotifyEvent | null) => {
      if (!event || !alive) return;
      dispatch(event, {
        enabled: readNotifyPref(),
        hidden: document.visibilityState === "hidden" || !document.hasFocus(),
        toast: push,
        notify: osNotify,
      });
    };

    const poll = async () => {
      try {
        const [wr, dr, ar] = await Promise.all([
          fetch(`${apiBase}/api/warm/status`),
          fetch(`${apiBase}/api/dream/status`),
          fetch(`${apiBase}/api/watch/attention`),
        ]);
        if (!alive) return;
        if (wr.ok) {
          const w = (await wr.json()) as { running: boolean };
          const next: WarmSnapshot = { running: w.running };
          fire(detectWarm(warmPrev.current, next));
          warmPrev.current = next;
        }
        if (dr.ok) {
          const d = (await dr.json()) as { queued: number };
          const next: DreamSnapshot = { queued: d.queued };
          fire(detectDream(dreamPrev.current, next));
          dreamPrev.current = next;
        }
        if (ar.ok) {
          const next = (await ar.json()) as AttentionSnapshot;
          const enrolled = enrolledFiles(readWatchAlertPrefs(), next.sessions.map((s) => s.file));
          for (const e of detectAttention(attnPrev.current, next, enrolled)) fire(e);
          attnPrev.current = next;
        }
      } catch {
        /* best-effort — a failed poll leaves the baseline untouched */
      }
    };

    void poll();
    const h = setInterval(poll, POLL_MS);
    return () => { alive = false; clearInterval(h); };
  }, [apiBase, push]);

  return null;
}
```

- [ ] **Step 4: Run the full notify test directory**

```bash
cd ../agentgem-worktrees/watch-attention && pnpm -C packages/console vitest run src/notify
```

Expected: PASS — the two new tests AND all pre-existing notify tests. If the old warm/dream transition tests fail on round sequencing, update their `fetchScript` rounds to the new three-endpoint shape (add `attention: { sessions: [] }` per round) — do not change the provider to accommodate the tests.

- [ ] **Step 5: Commit**

```bash
cd ../agentgem-worktrees/watch-attention
git add packages/console/src/notify/NotificationsProvider.tsx packages/console/src/notify/NotificationsProvider.test.tsx
git commit -m "feat(console): poll watch attention — toast/OS-notify when a session needs input

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 6: Watch tab — badges, bell toggles, master switch (+ CSS)

**Files:**
- Modify: `packages/console/src/panels/Watch/index.tsx`
- Modify: `packages/console/src/shell/theme.css`
- Test: `packages/console/src/panels/Watch/__tests__/Watch.test.tsx` (extend)

**Interfaces:**
- Consumes: `GET /api/watch/attention` (Task 2 shape), `readWatchAlertPrefs`/`writeWatchAlertPrefs`/`enrolledFiles` (Task 4), `AttentionSessionSnap` (Task 3).
- Produces: UI only — nothing exported.

- [ ] **Step 1: Write failing tests** (extend `Watch.test.tsx`)

The file's existing idiom stubs `fetch` with a URL-agnostic `vi.fn` returning `{ sessions: [SESSION] }` (the existing `SESSION` const at the top of the file). The new tests need a URL-branching stub so `/api/watch/attention` and `/api/watch/sessions` return different payloads. Note the existing tests keep passing untouched: their agnostic stub answers the new attention fetch with plain sessions (no `state` field), which simply renders no badge. Append inside `describe("Watch panel")`:

```tsx
const SESSION2 = { ...SESSION, id: "sess-2", file: "/w/.claude/projects/p/sess-2.jsonl", project: "shop" };
const PENDING_ATTN = {
  id: "sess-1", file: SESSION.file, agent: "claude", project: "site",
  state: "pending", pendingKey: 4, pendingToolName: "Bash", stalledMs: 30000,
};

// fetch stub answering both endpoints; localStorage cleared for pref isolation
function stubWatchFetch(sessions: unknown[], attention: unknown[]) {
  vi.stubGlobal("fetch", vi.fn(async (url: string) => ({
    ok: true,
    json: async () => (String(url).includes("/attention") ? { sessions: attention } : { sessions }),
  })) as unknown as typeof fetch);
}

it("shows a needs-input badge on a pending session row", async () => {
  localStorage.clear();
  stubWatchFetch([SESSION], [PENDING_ATTN]);
  render(<Watch apiBase="" />);
  expect(await screen.findByText(/needs input/i)).toBeTruthy();
});

it("bell toggle moves prefs to selected mode excluding the muted session", async () => {
  localStorage.clear();
  stubWatchFetch([SESSION, SESSION2], []);
  render(<Watch apiBase="" />);
  await screen.findByText("site");
  const bells = screen.getAllByRole("button", { name: "Toggle alerts for this session" });
  fireEvent.click(bells[0]); // mute sess-1
  expect(readWatchAlertPrefs()).toEqual({ mode: "selected", files: [SESSION2.file] });
});

it("master switch re-enables alerts for all sessions", async () => {
  localStorage.clear();
  writeWatchAlertPrefs({ mode: "selected", files: [] });
  stubWatchFetch([SESSION], []);
  render(<Watch apiBase="" />);
  await screen.findByText("site");
  fireEvent.click(screen.getByRole("checkbox", { name: /alert on all sessions/i }));
  expect(readWatchAlertPrefs().mode).toBe("all");
});
```

Add to the test file's imports:

```tsx
import { readWatchAlertPrefs, writeWatchAlertPrefs } from "../../../notify/watchAlertPrefs.js";
```

- [ ] **Step 2: Run to verify they fail**

```bash
cd ../agentgem-worktrees/watch-attention && pnpm -C packages/console vitest run src/panels/Watch/__tests__/Watch.test.tsx
```

Expected: new tests FAIL (badge/toggles don't exist).

- [ ] **Step 3: Implement the UI**

In `packages/console/src/panels/Watch/index.tsx`:

1. Imports:

```tsx
import { readWatchAlertPrefs, writeWatchAlertPrefs, enrolledFiles, type WatchAlertPrefs } from "../../notify/watchAlertPrefs.js";
import type { AttentionSessionSnap } from "../../notify/events.js";
```

2. Inside `Watch()`, add attention polling + prefs state:

```tsx
const [attention, setAttention] = useState<Map<string, AttentionSessionSnap>>(new Map());
const [alertPrefs, setAlertPrefs] = useState<WatchAlertPrefs>(readWatchAlertPrefs);

useEffect(() => {
  let alive = true;
  const load = () =>
    fetch(`${apiBase}/api/watch/attention`)
      .then((r) => (r.ok ? r.json() : { sessions: [] }))
      .then((d: { sessions: AttentionSessionSnap[] }) => {
        if (alive) setAttention(new Map(d.sessions.map((s) => [s.file, s])));
      })
      .catch(() => { /* best-effort */ });
  void load();
  const h = setInterval(load, 5000);
  return () => { alive = false; clearInterval(h); };
}, [apiBase]);

const allFiles = (sessions ?? []).map((s) => s.file);
const enrolled = enrolledFiles(alertPrefs, allFiles);
const setPrefs = (p: WatchAlertPrefs) => { writeWatchAlertPrefs(p); setAlertPrefs(p); };
const toggleBell = (file: string) => {
  const next = new Set(enrolled);
  if (next.has(file)) next.delete(file); else next.add(file);
  setPrefs(next.size === allFiles.length ? { mode: "all", files: [] } : { mode: "selected", files: [...next] });
};
```

3. Master switch — in the "Active sessions" header row, after the Refresh button:

```tsx
<label className="watch-all-alerts">
  <input
    type="checkbox"
    checked={alertPrefs.mode === "all"}
    onChange={(e) => setPrefs(e.target.checked ? { mode: "all", files: [] } : { mode: "selected", files: [...enrolled] })}
  />
  Alert on all sessions
</label>
```

4. Per-row bell + badge — inside the session `<li>`, the bell is a SIBLING of the existing row button (nested interactive elements are invalid HTML and break a11y), so wrap them:

```tsx
<li key={s.file} className="watch-session-row">
  <button type="button" className={"analyze-row" + (selected === s.file ? " is-active" : "")}
    style={{ display: "block", width: "100%", textAlign: "left", cursor: "pointer" }}
    onClick={() => setSelected(s.file)}>
    <div className="analyze-row-head">
      <span className="analyze-name">{s.project ?? s.id.slice(0, 8)}</span>
      <span className="ws-chip">{s.agent}</span>
      {attention.get(s.file)?.state === "pending" && (
        <span className="run-badge run-running watch-attn" title="An approval prompt (or a long tool run) is blocking this session">⏸ needs input</span>
      )}
    </div>
    <div style={{ fontSize: 12, opacity: 0.7 }}>
      {s.msgs} msgs · {ageLabel(s.ageMs)}{s.model ? ` · ${s.model}` : ""}
    </div>
  </button>
  <button type="button" className={"watch-bell" + (enrolled.has(s.file) ? " is-on" : "")}
    aria-label="Toggle alerts for this session" aria-pressed={enrolled.has(s.file)}
    title={enrolled.has(s.file) ? "Alerts on — click to mute this session" : "Alerts off — click to enable"}
    onClick={() => toggleBell(s.file)}>
    {enrolled.has(s.file) ? "🔔" : "🔕"}
  </button>
</li>
```

5. Feed-header badge — in the right pane, above the view toggle, when the open session is pending:

```tsx
{selected && attention.get(selected)?.state === "pending" && (
  <p className="watch-attn-banner" role="status">
    ⏸ Waiting on approval for {attention.get(selected)?.pendingToolName ?? "a tool"} (or a long tool run) — this session needs your input.
  </p>
)}
```

- [ ] **Step 4: Add the CSS rules** (same commit — every new className must be enforced)

Append to `packages/console/src/shell/theme.css`, matching the existing token language (`.run-badge` styling already covers `.watch-attn`'s chip look; the three genuinely new classes get rules):

```css
/* Watch: needs-input alerts */
.watch-session-row { position: relative; }
.watch-session-row .watch-bell {
  position: absolute; right: 8px; bottom: 8px;
  border: none; background: none; cursor: pointer;
  font-size: 14px; opacity: .45; padding: 2px;
}
.watch-session-row .watch-bell.is-on { opacity: 1; }
.watch-all-alerts { display: inline-flex; align-items: center; gap: 6px; font-size: 12px; opacity: .85; }
.watch-attn-banner {
  margin: 0 0 8px; padding: 8px 12px; border-radius: 8px; font-size: 13px;
  color: var(--accent); border: 1px solid rgba(154,51,36,.4); background: #fbeee9;
}
```

Verify enforcement:

```bash
cd ../agentgem-worktrees/watch-attention
for c in watch-session-row watch-bell watch-all-alerts watch-attn-banner; do
  echo "$c: $(grep -c "$c" packages/console/src/shell/theme.css)"; done
```

Expected: every count ≥ 1.

- [ ] **Step 5: Run the Watch tests + full console suite**

```bash
cd ../agentgem-worktrees/watch-attention && pnpm -C packages/console vitest run src/panels/Watch && pnpm -C packages/console test
```

Expected: PASS (console vitest is capped at 4 workers by config; `build.test.ts` is the known slow one).

- [ ] **Step 6: Commit**

```bash
cd ../agentgem-worktrees/watch-attention
git add packages/console/src/panels/Watch/index.tsx packages/console/src/shell/theme.css packages/console/src/panels/Watch/__tests__/Watch.test.tsx
git commit -m "feat(console): Watch needs-input badges + per-session alert bells

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 7: Full verification + real-browser check + PR

**Files:** none new.

- [ ] **Step 1: Full build + full test run**

```bash
cd ../agentgem-worktrees/watch-attention && pnpm build && pnpm test && pnpm -C packages/console test
```

Expected: all PASS. (Root `pnpm build` = `tsc -b && node scripts/build-console.mjs` — required so the console bundle isn't stale; known flaky suites: real-FS scan tests under concurrency — verify in isolation before blaming the change.)

- [ ] **Step 2: Verify in a real browser** (jsdom asserts behavior, never appearance)

Start the server from the worktree against a throwaway home (the server caches the SPA at boot — always restart after rebuild):

```bash
cd ../agentgem-worktrees/watch-attention && AGENTGEM_HOME=$(mktemp -d) node dist/cli.js serve
```

Then in the browser (`#/watch`): with a live Claude Code session running, confirm (1) the session row renders with a bell, (2) trigger a permission prompt in that session and within ~30s the row shows "⏸ needs input", a toast fires (window focused) or an OS notification (window backgrounded), (3) the banner shows in the feed header, (4) muting the bell stops subsequent alerts. Screenshot the badge + banner states.

- [ ] **Step 3: Push and open the PR**

```bash
cd ../agentgem-worktrees/watch-attention
git push -u origin watch-attention
gh pr create --title "feat(watch): alert when a session is waiting for your input" --body "$(cat <<'EOF'
## Summary
- New `GET /api/watch/attention`: classifies each active session pending/busy/idle — pending = an unmatched tool_call with a transcript stalled ≥ 25s (likely a permission prompt; copy hedges for long tool runs)
- NotificationsProvider polls it (5s) and routes transitions through the existing toast/OS-notification dispatch, gated by new per-session enrollment prefs (default: all sessions)
- Watch tab: "⏸ needs input" badges, per-session alert bells, master switch, feed-header banner

Spec: docs/superpowers/specs/2026-07-16-watch-attention-alert-design.md

## Test plan
- [ ] `pnpm build && pnpm test` (root, compiled dist)
- [ ] `pnpm -C packages/console test` (not in CI — run locally)
- [ ] Real-browser check with a live session hitting a permission prompt

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

Then watch CI and merge per repo rules (`gh run watch <run-id> --exit-status`, then `gh pr merge --rebase --delete-branch`; the local branch-delete error is expected — verify the remote merge landed by grepping `origin/main` for a marker from EVERY commit).
