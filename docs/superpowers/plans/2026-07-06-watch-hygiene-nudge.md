# Live Context-Hygiene Nudge Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** In the console Watch tab, nudge the user with a quiet dismissible banner (+ live bloat-curve sparkline) when the active Claude session's context hygiene escalates to `mixed`/`bloated`, reusing PR #161's engine and firing only on a climb.

**Architecture:** A pure `nudgeTransition` + `buildTickEvents` module holds all the new logic; a new `/api/watch/hygiene` SSE endpoint clones `watchEvents.ts`'s file-tail scaffold and, on each mtime change, runs a new `hygieneReportForFile` (thin reuse of #161's `buildHygieneReport`) and sends the pure module's assembled events; a `HygieneNudge` component subscribes and shows the banner. The #161 `BloatCurve` canvas is extracted to a shared module and reused.

**Tech Stack:** TypeScript ESM (`.js` specifiers), Server-Sent Events (native `EventSource` client / Express `text/event-stream` server), React (console), Vitest (server: `tsc -b && vitest run` over `dist/**/__tests__/**/*.test.js`; console: its own jsdom vitest).

## Global Constraints

- **Depends on PR #161 (merged):** `buildHygieneReport`, the `HygieneReport` type, and `scanWorkflow`/`ScanInventory` are exported from `src/sessionHygieneCore.ts` and `@agentgem/insight`. The `BloatCurve` component exists (module-private) in `packages/console/src/panels/Observe/HygieneReport.tsx`.
- **Copyright header** on every new `.ts`/`.tsx` file: `// Copyright (c) 2026 NineMind, Inc.` / `// SPDX-License-Identifier: MIT` / `// <repo-relative path>`.
- **ESM import specifiers end in `.js`** even for `.ts`/`.tsx` sources.
- **Claude-only:** the endpoint gates on `sourceForFile(file)?.id === "claude"`; a non-Claude file gets `send("phase", { phase: "unsupported" })` and no hygiene/nudge events. The UI renders nothing for `unsupported`.
- **Nudge semantics:** fire ONLY on escalation to a heavier verdict (`bounded→mixed`, `bounded→bloated`, `mixed→bloated`); `prev === null` fires if the session opens already past `bounded`; every other transition (staying, or dropping) is silent. Verdict rank: `bounded`=0, `mixed`=1, `bloated`=2.
- **Privacy:** streamed events carry `verdict`/`score` + integer `TurnUsage` curve points + `cap` + `DetectorSummary` (counts/advice) only — never an `arg`/path.
- **SSE robustness:** the endpoint mirrors `watchEvents.ts` exactly for headers, `POLL_MS=1000`, `HEARTBEAT_MS=15000`, `req.on("close")` cleanup, and never-throw-on-bad-tick.
- **Server tests** live in `src/gem/__tests__/` (IN CI). **Console tests** are NOT in root CI — run via the console's own vitest.
- **`grep -a`** when searching `packages/insight/src/workflowScan.ts` (binary-classified).
- **Commit identity** Raymond Feng <raymond@ninemind.ai>, with the `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>` trailer.

---

## File Structure

- **Create** `src/watchHygieneNudge.ts` — `Verdict`, pure `nudgeTransition`, pure `buildTickEvents` (all new logic; CI-tested). (Task 1)
- **Modify** `src/sessionHygieneCore.ts` — add `hygieneReportForFile(path)` + `MINIMAL_INV`. (Task 2)
- **Create** `src/watchHygiene.ts` — the SSE tail endpoint (thin I/O shell). (Task 3)
- **Modify** `src/index.ts` — register `GET /api/watch/hygiene`. (Task 3)
- **Create** `packages/console/src/panels/_shared/BloatCurve.tsx` — the extracted curve canvas. (Task 4)
- **Modify** `packages/console/src/panels/Observe/HygieneReport.tsx` — import `BloatCurve` from `_shared` instead of the local copy. (Task 4)
- **Create** `packages/console/src/panels/Watch/hygieneStream.ts` — client SSE subscriber. (Task 4)
- **Create** `packages/console/src/panels/Watch/HygieneNudge.tsx` — the banner + sparkline. (Task 4)
- **Modify** `packages/console/src/panels/Watch/SessionFeed.tsx` — render `<HygieneNudge>` at the top. (Task 4)
- **Create** `src/gem/__tests__/watchHygieneNudge.test.ts` — pure-logic + `hygieneReportForFile` tests (CI). (Tasks 1, 2)
- **Create** `packages/console/src/panels/Watch/__tests__/HygieneNudge.test.tsx` — component test (local). (Task 4)

**Run commands** (repo root `/Users/rfeng/Projects/ninemind/agentgem`):
- Server single test: `tsc -b && npx vitest run dist/gem/__tests__/watchHygieneNudge.test.js`
- Full server suite: `npm test`
- Console tests (local): `cd packages/console && npx vitest run src/panels/Watch/__tests__/HygieneNudge.test.tsx` ; typecheck `cd packages/console && npx tsc -b`

---

## Task 1: Pure nudge logic — `nudgeTransition` + `buildTickEvents`

**Files:**
- Create: `src/watchHygieneNudge.ts`
- Test: `src/gem/__tests__/watchHygieneNudge.test.ts`

**Interfaces:**
- Consumes: the existing `HygieneReport` type from `./sessionHygieneCore.js` (from #161: `{ meta:{sessionId,transcript,model,cap}, curve:TurnUsage[], factors:DetectorSummary[], hygiene:{score,verdict} }`).
- Produces:
  - `export type Verdict = "bounded" | "mixed" | "bloated"`
  - `export function nudgeTransition(prev: Verdict | null, next: Verdict): "fire" | "silent"`
  - `export interface TickEvents { hygiene: { verdict: Verdict; score: number; cap: number; curveTail: HygieneReport["curve"]; factors: HygieneReport["factors"] }; nudge?: { verdict: Verdict; advice: string }; nextVerdict: Verdict }`
  - `export function buildTickEvents(prev: Verdict | null, report: HygieneReport): TickEvents` — assembles the per-tick events: always a `hygiene` snapshot (curve downsampled to the last `CURVE_TAIL_MAX = 120` points), and a `nudge` (with the highest-severity fired factor's advice, fallback generic) when `nudgeTransition` says `fire`.
  - `export const CURVE_TAIL_MAX = 120`

- [ ] **Step 1: Write the failing test**

Create `src/gem/__tests__/watchHygieneNudge.test.ts`:

```ts
// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
// src/gem/__tests__/watchHygieneNudge.test.ts
import { describe, it, expect } from "vitest";
import { nudgeTransition, buildTickEvents, CURVE_TAIL_MAX, type Verdict } from "../../watchHygieneNudge.js";
import type { HygieneReport } from "../../sessionHygieneCore.js";

describe("nudgeTransition", () => {
  const cases: Array<[Verdict | null, Verdict, "fire" | "silent"]> = [
    [null, "bounded", "silent"],
    [null, "mixed", "fire"],          // opens already heavy
    [null, "bloated", "fire"],
    ["bounded", "bounded", "silent"],
    ["bounded", "mixed", "fire"],
    ["bounded", "bloated", "fire"],
    ["mixed", "mixed", "silent"],     // no re-nag while heavy
    ["mixed", "bloated", "fire"],     // escalation
    ["mixed", "bounded", "silent"],   // dropped (a /clear)
    ["bloated", "bloated", "silent"],
    ["bloated", "mixed", "silent"],   // improving
    ["bloated", "bounded", "silent"], // re-armed, but the drop itself is silent
  ];
  it.each(cases)("prev=%s next=%s -> %s", (prev, next, want) => {
    expect(nudgeTransition(prev, next)).toBe(want);
  });
  it("re-arms: bloated -> bounded -> mixed fires again on the climb", () => {
    expect(nudgeTransition("bloated", "bounded")).toBe("silent");
    expect(nudgeTransition("bounded", "mixed")).toBe("fire");
  });
});

function report(verdict: Verdict, curveLen: number, firedAdvice?: string): HygieneReport {
  const curve = Array.from({ length: curveLen }, (_, i) => ({ turn: i, msgIndex: i, ctxTokens: 500_000, cacheCreation: 0, outTokens: 1 }));
  const factors = [
    { id: "context-pinned", title: "Window pinned at the context cap", advice: firedAdvice ?? "Cut earlier.", severity: "warn" as const, count: firedAdvice ? 1 : 0, sessions: firedAdvice ? 1 : 0 },
    { id: "task-sprawl", title: "Many tasks", advice: "Split them.", severity: "warn" as const, count: 0, sessions: 0 },
  ];
  return { meta: { sessionId: "s", transcript: "s.jsonl", model: "claude-opus-4-8[1m]", cap: 1_000_000 }, curve, factors, hygiene: { score: 40, verdict } };
}

describe("buildTickEvents", () => {
  it("always emits a hygiene snapshot with a downsampled curve tail and the cap", () => {
    const t = buildTickEvents("bounded", report("bounded", 300));
    expect(t.hygiene.verdict).toBe("bounded");
    expect(t.hygiene.cap).toBe(1_000_000);
    expect(t.hygiene.curveTail.length).toBe(CURVE_TAIL_MAX);     // 300 -> last 120
    expect(t.hygiene.curveTail.at(-1)!.turn).toBe(299);          // it's the TAIL
    expect(t.nudge).toBeUndefined();                             // no escalation
    expect(t.nextVerdict).toBe("bounded");
  });
  it("emits a nudge with the fired factor's advice on escalation", () => {
    const t = buildTickEvents("bounded", report("bloated", 10, "This session is heavy — take a clean break."));
    expect(t.nudge?.verdict).toBe("bloated");
    expect(t.nudge?.advice).toBe("This session is heavy — take a clean break.");
  });
  it("nudge falls back to a generic advice when no factor carries one", () => {
    const t = buildTickEvents(null, report("mixed", 5));   // no fired factor (all count 0)
    expect(t.nudge).toBeDefined();
    expect(t.nudge!.advice.length).toBeGreaterThan(0);
  });
  it("keeps the whole curve when shorter than the tail cap", () => {
    const t = buildTickEvents("bounded", report("bounded", 12));
    expect(t.hygiene.curveTail.length).toBe(12);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `tsc -b && npx vitest run dist/gem/__tests__/watchHygieneNudge.test.js`
Expected: FAIL — `../../watchHygieneNudge.js` does not exist.

- [ ] **Step 3: Write minimal implementation**

Create `src/watchHygieneNudge.ts`:

```ts
// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
// src/watchHygieneNudge.ts
//
// Pure logic for the live Watch hygiene nudge. nudgeTransition fires ONLY when a
// session's verdict climbs to a heavier level — the anti-doomscroll core: it can
// never nag a bounded session, and re-arms naturally after a drop. buildTickEvents
// assembles the per-mtime-tick SSE payloads (a live snapshot always; a nudge on a
// climb) from a #161 HygieneReport. No I/O.
import type { HygieneReport } from "./sessionHygieneCore.js";

export type Verdict = "bounded" | "mixed" | "bloated";
const RANK: Record<Verdict, number> = { bounded: 0, mixed: 1, bloated: 2 };

export function nudgeTransition(prev: Verdict | null, next: Verdict): "fire" | "silent" {
  if (next === "bounded") return "silent";
  if (prev === null) return "fire";
  return RANK[next] > RANK[prev] ? "fire" : "silent";
}

export const CURVE_TAIL_MAX = 120;

const GENERIC_ADVICE = "This session's context is heavy — a clean break keeps it sharp.";

export interface TickEvents {
  hygiene: { verdict: Verdict; score: number; cap: number; curveTail: HygieneReport["curve"]; factors: HygieneReport["factors"] };
  nudge?: { verdict: Verdict; advice: string };
  nextVerdict: Verdict;
}

export function buildTickEvents(prev: Verdict | null, report: HygieneReport): TickEvents {
  const verdict = report.hygiene.verdict as Verdict;
  const curveTail = report.curve.slice(-CURVE_TAIL_MAX);
  const out: TickEvents = {
    hygiene: { verdict, score: report.hygiene.score, cap: report.meta.cap, curveTail, factors: report.factors },
    nextVerdict: verdict,
  };
  if (nudgeTransition(prev, verdict) === "fire") {
    const fired = report.factors.filter((f) => f.count > 0);
    const advice = fired[0]?.advice || GENERIC_ADVICE;
    out.nudge = { verdict, advice };
  }
  return out;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `tsc -b && npx vitest run dist/gem/__tests__/watchHygieneNudge.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/watchHygieneNudge.ts src/gem/__tests__/watchHygieneNudge.test.ts
git -c user.name="Raymond Feng" -c user.email="raymond@ninemind.ai" commit -m "feat(watch): pure nudge trigger + tick-event assembly

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 2: `hygieneReportForFile` reuse helper

**Files:**
- Modify: `src/sessionHygieneCore.ts`
- Test: `src/gem/__tests__/watchHygieneNudge.test.ts` (append)

**Interfaces:**
- Consumes: `buildHygieneReport`, `scanWorkflow`, `ScanInventory` (already imported in `sessionHygieneCore.ts` from #161 / `@agentgem/insight`).
- Produces: `export function hygieneReportForFile(path: string): HygieneReport` — scans one transcript file with a minimal empty inventory and returns the #161 report. Pure of resolution (the hygiene detectors need only `contextSeries` + the scrubbed spine, not resolved artifacts).

- [ ] **Step 1: Write the failing test** (append to `watchHygieneNudge.test.ts`)

```ts
import { mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { hygieneReportForFile } from "../../sessionHygieneCore.js";

function writeClaudeTranscript(dir: string, turns: number): string {
  const lines: string[] = [JSON.stringify({ sessionId: "live1", type: "user", message: { role: "user", content: "go" } })];
  for (let i = 0; i < turns; i++) lines.push(JSON.stringify({
    type: "assistant",
    message: {
      role: "assistant", model: "claude-opus-4-8[1m]",
      content: [{ type: "tool_use", name: "Read", input: { file_path: `packages/p${i}/f.ts` } }],
      usage: { input_tokens: 100, cache_read_input_tokens: 400_000 + i * 1000, cache_creation_input_tokens: 2000, output_tokens: 10 },
    },
  }));
  const p = join(dir, "live1.jsonl");
  writeFileSync(p, lines.join("\n"));
  return p;
}

describe("hygieneReportForFile", () => {
  it("produces a populated curve + verdict from a real transcript file", () => {
    const dir = mkdtempSync(join(tmpdir(), "watchhyg-"));
    const path = writeClaudeTranscript(dir, 3);
    const rep = hygieneReportForFile(path);
    expect(rep.curve).toHaveLength(3);
    expect(rep.curve[0].ctxTokens).toBe(402_100);      // 100 + 400000 + 2000
    expect(rep.meta.cap).toBe(1_000_000);
    expect(["bounded", "mixed", "bloated"]).toContain(rep.hygiene.verdict);
  });
  it("returns an empty curve (no throw) for a file with no assistant turns", () => {
    const dir = mkdtempSync(join(tmpdir(), "watchhyg2-"));
    const p = join(dir, "empty.jsonl");
    writeFileSync(p, JSON.stringify({ sessionId: "e", type: "user", message: { role: "user", content: "hi" } }));
    const rep = hygieneReportForFile(p);
    expect(rep.curve).toEqual([]);
    expect(rep.hygiene.verdict).toBe("bounded");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `tsc -b && npx vitest run dist/gem/__tests__/watchHygieneNudge.test.js`
Expected: FAIL — `hygieneReportForFile` not exported.

- [ ] **Step 3: Write minimal implementation**

In `src/sessionHygieneCore.ts`, confirm the existing imports include `scanWorkflow`, `buildHygieneReport` (local), and the `ScanInventory` type (with `grep -an "scanWorkflow\|ScanInventory\|buildHygieneReport" src/sessionHygieneCore.ts`). If `ScanInventory` isn't already imported, add it to the `@agentgem/insight` import. Then add, after `buildHygieneReport`:

```ts
// A watched live transcript is a bare file path, not a resolvable session id, and
// the hygiene detectors need only contextSeries + the scrubbed step spine — never
// resolved artifacts. So scan the one file with an empty inventory (the shape the
// unit tests use) and reuse buildHygieneReport. Sibling of sessionHygiene, without
// the resolveClaudeSession / project-inventory step.
const MINIMAL_INV = {
  project: { root: "", skills: [], mcpServers: [], hooks: [], instructions: [] },
  global: { skills: [], mcpServers: [], hooks: [] },
} as unknown as ScanInventory;

export function hygieneReportForFile(path: string): HygieneReport {
  return buildHygieneReport(scanWorkflow([path], MINIMAL_INV, { retainSequences: true }));
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `tsc -b && npx vitest run dist/gem/__tests__/watchHygieneNudge.test.js`
Then confirm no regression in the #161 hygiene tests: `npx vitest run dist/gem/__tests__/sessionHygiene.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/sessionHygieneCore.ts src/gem/__tests__/watchHygieneNudge.test.ts
git -c user.name="Raymond Feng" -c user.email="raymond@ninemind.ai" commit -m "feat(watch): hygieneReportForFile — scan one live file with a minimal inventory

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 3: SSE endpoint `GET /api/watch/hygiene`

**Files:**
- Create: `src/watchHygiene.ts`
- Modify: `src/index.ts` (register the route beside the other `watch*` streams ~line 298)

**Interfaces:**
- Consumes: `hygieneReportForFile` (Task 2), `buildTickEvents` + `Verdict` (Task 1); `resolveTranscriptFile`, `sourceForFile` (from `./watchSessions.js`).
- Produces: `export function streamWatchHygiene(req: SseReq, res: SseRes): void` — the SSE handler; and a registered `GET /api/watch/hygiene` route.

- [ ] **Step 1: Write the failing test**

This is a thin I/O shell over already-tested pure logic (Task 1) and a tested helper (Task 2), mirroring `watchEvents.ts` which has no direct unit test. Verify it via a fake req/res that captures `send`s, driving one tick over a fixture file. Append to `watchHygieneNudge.test.ts`:

```ts
import { streamWatchHygiene } from "../../watchHygiene.js";

// Minimal fake SSE res/req: capture (event, data) pairs; no real sockets/timers asserted.
function fakeSse() {
  const sent: Array<{ event: string; data: any }> = [];
  let buf = "";
  const res = {
    writeHead() {}, end() {},
    write(chunk: string) {
      buf += chunk;
      const m = /event: (\w+)\ndata: (.*)\n\n/s.exec(buf);
      if (m) { sent.push({ event: m[1], data: JSON.parse(m[2]) }); buf = ""; }
    },
  };
  const closers: Array<() => void> = [];
  const req = { query: {} as Record<string, unknown>, on(ev: string, cb: () => void) { if (ev === "close") closers.push(cb); } };
  return { req, res, sent, close: () => closers.forEach((c) => c()) };
}

describe("streamWatchHygiene", () => {
  it("emits a watching phase then a hygiene snapshot for a Claude file", async () => {
    const dir = mkdtempSync(join(tmpdir(), "watchhyg3-"));
    const path = writeClaudeTranscript(dir, 2);
    const f = fakeSse();
    f.req.query.file = path;
    streamWatchHygiene(f.req as any, f.res as any);
    // the endpoint flushes an immediate tick synchronously (like watchEvents' tick())
    const phases = f.sent.filter((s) => s.event === "phase");
    const snaps = f.sent.filter((s) => s.event === "hygiene");
    expect(phases[0].data.phase).toBe("watching");
    expect(snaps.length).toBeGreaterThanOrEqual(1);
    expect(snaps[0].data.curveTail.length).toBe(2);
    f.close();
  });
  it("emits an unsupported phase and no hygiene for a non-registered/non-claude file", () => {
    const f = fakeSse();
    f.req.query.file = "/nope/not-a-watch-root.jsonl";
    streamWatchHygiene(f.req as any, f.res as any);
    expect(f.sent.some((s) => s.event === "hygiene")).toBe(false);
    f.close();
  });
});
```

> Note: the fake `res.write` regex assumes one event per flush; `send` writes `event:`+`data:` in a single logical unit, so pair them by resetting the buffer after each full match. If the endpoint writes a heartbeat comment (`: ping`), the regex simply won't match it (no `event:`), which is correct.

- [ ] **Step 2: Run test to verify it fails**

Run: `tsc -b && npx vitest run dist/gem/__tests__/watchHygieneNudge.test.js`
Expected: FAIL — `../../watchHygiene.js` does not exist.

- [ ] **Step 3: Write minimal implementation**

Create `src/watchHygiene.ts` (clone `watchEvents.ts`'s scaffold — read it first with `sed -n '1,90p' src/watchEvents.ts` to match headers/poll/heartbeat/cleanup exactly):

```ts
// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
// src/watchHygiene.ts
//
// SSE endpoint for the Watch tab's live context-hygiene nudge. Tails ONE Claude
// session transcript (same mtime-poll scaffold as watchEvents.ts) and, on each
// change, re-runs the #161 hygiene scan (hygieneReportForFile) and sends the
// per-tick events assembled by buildTickEvents — a live `hygiene` snapshot every
// tick, and a `nudge` only when the verdict CLIMBS. Claude-only (the bloat curve
// needs per-turn usage). Never throws on a bad tick; robustness mirrors watchEvents.
import { statSync } from "node:fs";
import { resolveTranscriptFile, sourceForFile } from "./watchSessions.js";
import { hygieneReportForFile } from "./sessionHygieneCore.js";
import { buildTickEvents, type Verdict } from "./watchHygieneNudge.js";

interface SseReq { query: Record<string, unknown>; on?(event: string, cb: () => void): void }
interface SseRes { writeHead(status: number, headers: Record<string, string>): void; write(chunk: string): void; end(): void }

const POLL_MS = 1000;
const HEARTBEAT_MS = 15000;

export function streamWatchHygiene(req: SseReq, res: SseRes): void {
  const fileParam = typeof req.query.file === "string" ? req.query.file : "";
  const resolved = resolveTranscriptFile(fileParam);
  const source = resolved ? sourceForFile(resolved) : null;

  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });
  const send = (event: string, data: unknown) => {
    res.write(`event: ${event}\n`);
    res.write(`data: ${JSON.stringify(data)}\n\n`);
  };

  if (!resolved || source?.id !== "claude") {
    send("phase", { phase: "unsupported" });
    // keep the connection open with heartbeats but stream nothing else
    const beatOnly = setInterval(() => { try { res.write(": ping\n\n"); } catch { /* closed */ } }, HEARTBEAT_MS);
    req.on?.("close", () => { clearInterval(beatOnly); try { res.end(); } catch { /* ended */ } });
    return;
  }

  let prev: Verdict | null = null;
  let lastMtime = -1;
  const tick = () => {
    let mtimeMs: number;
    try { mtimeMs = statSync(resolved).mtimeMs; } catch { return; }
    if (mtimeMs === lastMtime) return;
    lastMtime = mtimeMs;
    let events;
    try { events = buildTickEvents(prev, hygieneReportForFile(resolved)); }
    catch { return; }   // never crash the stream on a bad tick
    send("hygiene", events.hygiene);
    if (events.nudge) send("nudge", events.nudge);
    prev = events.nextVerdict;
  };

  send("phase", { phase: "watching", agent: source.id });
  tick(); // flush immediately

  const poll = setInterval(tick, POLL_MS);
  const beat = setInterval(() => { try { res.write(": ping\n\n"); } catch { /* closed */ } }, HEARTBEAT_MS);
  req.on?.("close", () => { clearInterval(poll); clearInterval(beat); try { res.end(); } catch { /* ended */ } });
}
```

In `src/index.ts`: add the import beside the sibling watch imports (~line 33) and register the route beside `/api/watch/events` (~line 298). Confirm exact anchors with `grep -an "streamWatchEvents\|/api/watch/events" src/index.ts`.

```ts
import { streamWatchHygiene } from "./watchHygiene.js";
```
```ts
  server.expressApp.get("/api/watch/hygiene", originGuard, (req, res) => streamWatchHygiene(req as never, res as never));
```

- [ ] **Step 4: Run test to verify it passes**

Run: `tsc -b && npx vitest run dist/gem/__tests__/watchHygieneNudge.test.js`
Then the full server suite (proves route wiring + no regression): `npm test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/watchHygiene.ts src/index.ts src/gem/__tests__/watchHygieneNudge.test.ts
git -c user.name="Raymond Feng" -c user.email="raymond@ninemind.ai" commit -m "feat(watch): /api/watch/hygiene SSE endpoint (tail + rescan + nudge)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 4: Client — shared BloatCurve, hygiene stream, nudge banner, SessionFeed wiring

**Files:**
- Create: `packages/console/src/panels/_shared/BloatCurve.tsx`
- Modify: `packages/console/src/panels/Observe/HygieneReport.tsx` (import the shared `BloatCurve`, drop the local copy)
- Create: `packages/console/src/panels/Watch/hygieneStream.ts`
- Create: `packages/console/src/panels/Watch/HygieneNudge.tsx`
- Modify: `packages/console/src/panels/Watch/SessionFeed.tsx` (render `<HygieneNudge>` at the top)
- Test: `packages/console/src/panels/Watch/__tests__/HygieneNudge.test.tsx`

**Interfaces:**
- Consumes: `/api/watch/hygiene` (Task 3).
- Produces: shared `BloatCurve` component; `openHygieneStream(apiBase, file, onEvent)`; `HygieneNudge` component.

- [ ] **Step 1: Write the failing test**

Create `packages/console/src/panels/Watch/__tests__/HygieneNudge.test.tsx`:

```tsx
// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
// packages/console/src/panels/Watch/__tests__/HygieneNudge.test.tsx
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import { HygieneNudge } from "../HygieneNudge.js";
import * as stream from "../hygieneStream.js";

afterEach(cleanup);

// Drive the component by capturing the onEvent callback the component passes to
// openHygieneStream, so the test can push snapshot/nudge events synchronously.
function mockStream() {
  let cb: (e: stream.HygieneMsg) => void = () => {};
  vi.spyOn(stream, "openHygieneStream").mockImplementation((_a, _f, onEvent) => { cb = onEvent; return () => {}; });
  return { push: (e: stream.HygieneMsg) => cb(e) };
}

const snap = (verdict: "bounded" | "mixed" | "bloated") => ({
  type: "hygiene" as const, verdict, score: 40, cap: 1_000_000,
  curveTail: [{ turn: 0, msgIndex: 0, ctxTokens: 500_000, cacheCreation: 0, outTokens: 1 }], factors: [],
});

describe("HygieneNudge", () => {
  it("renders nothing while bounded", () => {
    const m = mockStream();
    const { container } = render(<HygieneNudge apiBase="/" file="s.jsonl" />);
    m.push(snap("bounded"));
    expect(container.querySelector(".hyg-nudge")).toBeNull();
  });
  it("shows a dismissible banner with advice on a nudge event", () => {
    const m = mockStream();
    render(<HygieneNudge apiBase="/" file="s.jsonl" />);
    m.push(snap("bloated"));
    m.push({ type: "nudge", verdict: "bloated", advice: "Take a clean break." });
    expect(screen.getByText(/Take a clean break/i)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /dismiss/i }));
    expect(screen.queryByText(/Take a clean break/i)).toBeNull();
  });
  it("re-shows after dismiss when a higher-verdict nudge arrives", () => {
    const m = mockStream();
    render(<HygieneNudge apiBase="/" file="s.jsonl" />);
    m.push({ type: "nudge", verdict: "mixed", advice: "Getting heavy." });
    fireEvent.click(screen.getByRole("button", { name: /dismiss/i }));
    expect(screen.queryByText(/Getting heavy/i)).toBeNull();
    m.push({ type: "nudge", verdict: "bloated", advice: "Now bloated." });
    expect(screen.getByText(/Now bloated/i)).toBeTruthy();
  });
  it("renders nothing for an unsupported (Codex) phase", () => {
    const m = mockStream();
    const { container } = render(<HygieneNudge apiBase="/" file="s.jsonl" />);
    m.push({ type: "phase", phase: "unsupported" });
    expect(container.querySelector(".hyg-nudge")).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/console && npx vitest run src/panels/Watch/__tests__/HygieneNudge.test.tsx`
Expected: FAIL — `../HygieneNudge.js` / `../hygieneStream.js` do not exist.

- [ ] **Step 3: Write minimal implementation**

First extract the shared curve. Read the current `BloatCurve` from `packages/console/src/panels/Observe/HygieneReport.tsx` (the `function BloatCurve({ curve, cap })` block) and move it verbatim into a new `packages/console/src/panels/_shared/BloatCurve.tsx`, exported, with the copyright header:

```tsx
// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
// packages/console/src/panels/_shared/BloatCurve.tsx
import { useEffect, useRef } from "react";

export interface CurvePoint { turn: number; msgIndex: number; ctxTokens: number; cacheCreation: number; outTokens: number }

export function BloatCurve({ curve, cap, width = 320, height = 90 }: { curve: CurvePoint[]; cap: number; width?: number; height?: number }) {
  const ref = useRef<HTMLCanvasElement | null>(null);
  useEffect(() => {
    const cv = ref.current; if (!cv) return;
    const ctx = cv.getContext("2d"); if (!ctx) return;
    const w = cv.width, h = cv.height, pad = 4;
    const cssVar = (k: string, fallback: string) => getComputedStyle(document.documentElement).getPropertyValue(k).trim() || fallback;
    const heat = cssVar("--accent", "#9a3324");
    const grid = cssVar("--muted", "#8a7f69");
    ctx.clearRect(0, 0, w, h);
    const N = curve.length; if (N === 0) return;
    const X = (i: number) => pad + (w - 2 * pad) * (N > 1 ? i / (N - 1) : 0);
    const Y = (v: number) => h - pad - (h - 2 * pad) * Math.min(1, v / cap);
    ctx.beginPath(); ctx.moveTo(X(0), h - pad);
    curve.forEach((p, i) => ctx.lineTo(X(i), Y(p.ctxTokens)));
    ctx.lineTo(X(N - 1), h - pad); ctx.closePath();
    ctx.fillStyle = heat + "22"; ctx.fill();
    ctx.beginPath(); curve.forEach((p, i) => (i ? ctx.lineTo(X(i), Y(p.ctxTokens)) : ctx.moveTo(X(i), Y(p.ctxTokens))));
    ctx.strokeStyle = heat; ctx.lineWidth = 1.5; ctx.stroke();
    ctx.strokeStyle = grid; ctx.setLineDash([3, 3]);
    ctx.beginPath(); ctx.moveTo(pad, Y(cap)); ctx.lineTo(w - pad, Y(cap)); ctx.stroke(); ctx.setLineDash([]);
  }, [curve, cap]);
  return <canvas ref={ref} width={width} height={height} className="hyg-canvas" role="img" aria-label="Context size per turn" />;
}
```

In `packages/console/src/panels/Observe/HygieneReport.tsx`: delete the local `function BloatCurve(...)` definition and add `import { BloatCurve } from "../_shared/BloatCurve.js";` near its other imports. The existing call `<BloatCurve curve={rep.curve} cap={rep.meta.cap} />` stays. (Confirm the local component's prop names match the shared one; they do — `curve`, `cap`.)

Create `packages/console/src/panels/Watch/hygieneStream.ts` (mirror `eventStream.ts`):

```ts
// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
// packages/console/src/panels/Watch/hygieneStream.ts
//
// Watch tab live context-hygiene data layer: subscribe to one session's hygiene
// stream via native EventSource — named events phase/hygiene/nudge/failed, same
// scaffold as eventStream.ts. The server has already scrubbed everything; the
// panel renders counts/advice + an integer curve, never markup.
import type { CurvePoint } from "../_shared/BloatCurve.js";

export type Verdict = "bounded" | "mixed" | "bloated";
export interface FactorRow { id: string; title: string; advice: string; severity: "info" | "warn"; count: number; sessions: number }

export type HygieneMsg =
  | { type: "phase"; phase: string }
  | { type: "hygiene"; verdict: Verdict; score: number; cap: number; curveTail: CurvePoint[]; factors: FactorRow[] }
  | { type: "nudge"; verdict: Verdict; advice: string }
  | { type: "failed"; message: string };

export function openHygieneStream(apiBase: string, file: string, onEvent: (e: HygieneMsg) => void): () => void {
  const es = new EventSource(`${apiBase}/api/watch/hygiene?${new URLSearchParams({ file }).toString()}`);
  const data = (m: Event) => JSON.parse((m as MessageEvent).data);
  es.addEventListener("phase", (m) => { const d = data(m); onEvent({ type: "phase", phase: d.phase }); });
  es.addEventListener("hygiene", (m) => { const d = data(m); onEvent({ type: "hygiene", ...d }); });
  es.addEventListener("nudge", (m) => { const d = data(m); onEvent({ type: "nudge", verdict: d.verdict, advice: d.advice }); });
  es.addEventListener("failed", (m) => { onEvent({ type: "failed", message: data(m).message }); es.close(); });
  es.addEventListener("error", () => onEvent({ type: "failed", message: "connection lost" }));
  return () => es.close();
}
```

Create `packages/console/src/panels/Watch/HygieneNudge.tsx`:

```tsx
// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
// packages/console/src/panels/Watch/HygieneNudge.tsx
import { useEffect, useRef, useState } from "react";
import { openHygieneStream, type HygieneMsg, type Verdict } from "./hygieneStream.js";
import { BloatCurve, type CurvePoint } from "../_shared/BloatCurve.js";

const RANK: Record<Verdict, number> = { bounded: 0, mixed: 1, bloated: 2 };

export function HygieneNudge({ apiBase, file }: { apiBase: string; file: string }) {
  const [snap, setSnap] = useState<{ verdict: Verdict; score: number; cap: number; curve: CurvePoint[] } | null>(null);
  const [nudge, setNudge] = useState<{ verdict: Verdict; advice: string } | null>(null);
  const dismissedAt = useRef<number>(-1);   // rank of the last dismissed verdict

  useEffect(() => {
    setSnap(null); setNudge(null); dismissedAt.current = -1;
    return openHygieneStream(apiBase, file, (m: HygieneMsg) => {
      if (m.type === "hygiene") setSnap({ verdict: m.verdict, score: m.score, cap: m.cap, curve: m.curveTail });
      else if (m.type === "nudge") {
        // re-show only if this escalation is heavier than what was last dismissed
        if (RANK[m.verdict] > dismissedAt.current) setNudge({ verdict: m.verdict, advice: m.advice });
      }
    });
  }, [apiBase, file]);

  if (!nudge) return null;

  return (
    <div className={"hyg-nudge is-" + nudge.verdict} role="status">
      <div className="hyg-nudge-body">
        <span className={"hyg-verdict is-" + nudge.verdict}>{nudge.verdict}</span>
        <span className="hyg-nudge-advice">{nudge.advice}</span>
        <button type="button" className="hyg-nudge-x" aria-label="Dismiss"
          onClick={() => { dismissedAt.current = RANK[nudge.verdict]; setNudge(null); }}>×</button>
      </div>
      {snap && snap.curve.length > 0 && <BloatCurve curve={snap.curve} cap={snap.cap} width={280} height={64} />}
    </div>
  );
}
```

In `packages/console/src/panels/Watch/SessionFeed.tsx`: add `import { HygieneNudge } from "./HygieneNudge.js";` near the top, and render it as the FIRST child of the returned `<div>` (before the `run-status` div):

```tsx
  return (
    <div>
      <HygieneNudge apiBase={apiBase} file={file} />
      <div className="run-status" style={{ gap: 8, marginBottom: 6, flexWrap: "wrap" }}>
```

Add minimal CSS for `.hyg-nudge`, `.hyg-nudge.is-mixed`/`.is-bloated`, `.hyg-nudge-body`, `.hyg-nudge-advice`, `.hyg-nudge-x` to `packages/console/src/shell/theme.css` (where `.hyg-*` from #161 already live) — a bordered banner using the existing verdict colors (`--gold` for mixed, `--accent` for bloated), reusing the `.hyg-verdict.is-*` classes #161 already defines. Keep it minimal.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd packages/console && npx vitest run src/panels/Watch/__tests__/HygieneNudge.test.tsx`
Then confirm the #161 report still renders after the BloatCurve extraction: `cd packages/console && npx vitest run src/panels/Observe/HygieneReport.test.tsx`
Then typecheck the whole console: `cd packages/console && npx tsc -b`
Expected: all PASS / clean.

- [ ] **Step 5: Commit**

```bash
git add packages/console/src/panels/_shared/BloatCurve.tsx packages/console/src/panels/Observe/HygieneReport.tsx packages/console/src/panels/Watch/hygieneStream.ts packages/console/src/panels/Watch/HygieneNudge.tsx packages/console/src/panels/Watch/SessionFeed.tsx packages/console/src/shell/theme.css packages/console/src/panels/Watch/__tests__/HygieneNudge.test.tsx
git -c user.name="Raymond Feng" -c user.email="raymond@ninemind.ai" commit -m "feat(watch): live context-hygiene nudge banner in SessionFeed

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Final verification

- [ ] Server suite: `npm test` (includes `watchHygieneNudge.test.js` + unaffected #161/detector suites).
- [ ] Console: `cd packages/console && npx vitest run src/panels/Watch/__tests__/HygieneNudge.test.tsx src/panels/Observe/HygieneReport.test.tsx && npx tsc -b`.
- [ ] Manual smoke (optional): open the Watch tab on a live Claude session, let it grow; confirm the banner appears once when it crosses into mixed/bloated, the sparkline tracks, dismiss hides it, and a bounded session shows nothing.

## Out of scope (later follow-ups)

- Ambient nudging when not watching (warm-daemon watcher + OS notification).
- The full interactive EMBER game widget.
- Tier-2 LLM boundary-judge on the live stream.
- User-configurable threshold.
